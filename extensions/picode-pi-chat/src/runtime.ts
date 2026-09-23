import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveLatestVersions } from "./catalog";

/**
 * Which `pi` PiCode runs.
 *
 * - `path`    — whatever `pi` resolves to on PATH: the user's own installation.
 *               This is the default and the behaviour PiCode had before the
 *               choice existed.
 * - `managed` — a pinned pi that PiCode installs into its own tree, isolated
 *               from both `~/.pi` and the global npm prefix. The archive does
 *               not carry it: a clean production install of pi measures 410 MB,
 *               so it is fetched on demand instead.
 * - `custom`  — an explicit executable path from `picode.pi.executablePath`.
 */
export type RuntimeMode = "path" | "managed" | "custom";

/**
 * How PiCode talks to pi.
 *
 * - `rpc`      — spawn `pi --mode rpc` and speak JSON lines over stdio. The
 *                default, and the transport PiCode has always used.
 * - `embedded` — import the same pi inside the extension through its SDK. No child
 *                process, and pi's extensions get a UI context they can render.
 *
 * The transport is deliberately separate from the runtime: the embedded backend
 * has to load the *same* pi the owner already uses, so choosing a transport never
 * chooses an installation.
 */
export type PiTransport = "rpc" | "embedded";

/** The published package both backends are built on. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export interface RuntimePin {
  package: string;
  version: string;
}

export interface ResolvedRuntime {
  mode: RuntimeMode;
  /** Executable handed to the RPC client. */
  executable: string;
  /** Arguments that must precede the client's own, if any. */
  argsPrefix: string[];
  /** Human-readable path for display. */
  display: string;
}

export interface RuntimeDescriptor {
  mode: RuntimeMode;
  executable: string;
  display: string;
  /** False when the executable could not be located on disk. */
  available: boolean;
  /** First line of `pi --version`, when the probe succeeded. */
  version?: string;
  /** Absolute path of the managed runtime root. */
  managedRoot: string;
  managedInstalled: boolean;
  /** The pinned package and version PiCode would install. */
  pin: RuntimePin;
  /** The embedded backend's entry point, when the active pi publishes one. */
  sdkEntry?: string;
  /** True when the embedded transport can run against the active pi. */
  embeddedAvailable: boolean;
}

const PIN_FILE = "runtime.json";

/**
 * The pin is data, shipped with the extension, so the version PiCode installs is
 * reviewable in the repository rather than buried in code.
 */
export function readPin(extensionUri: vscode.Uri): RuntimePin {
  const file = vscode.Uri.joinPath(extensionUri, PIN_FILE).fsPath;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RuntimePin>;
  if (typeof parsed.package !== "string" || typeof parsed.version !== "string") {
    throw new Error(`${PIN_FILE} must declare a package and a version`);
  }
  return { package: parsed.package, version: parsed.version };
}

/** `<distribution root>/resources/pi-runtime`, derived from the extension location. */
export function managedRoot(extensionUri: vscode.Uri): string {
  // <root>/resources/app/extensions/<extension id> -> <root>
  const distributionRoot = path.resolve(extensionUri.fsPath, "..", "..", "..", "..");
  return path.join(distributionRoot, "resources", "pi-runtime");
}

export function managedBundle(root: string, pin: RuntimePin): string {
  return path.join(root, "node_modules", ...pin.package.split("/"), "dist", "bundle", "cli.js");
}

export function managedInstalled(extensionUri: vscode.Uri, pin: RuntimePin): boolean {
  return existsSync(managedBundle(managedRoot(extensionUri), pin));
}

export function readMode(): RuntimeMode {
  const configured = vscode.workspace
    .getConfiguration("picode.pi")
    .get<string>("runtime", "path");
  return configured === "managed" || configured === "custom" ? configured : "path";
}

/** Reads the configured transport. Anything unrecognised means RPC. */
export function readTransport(): PiTransport {
  const configured = vscode.workspace
    .getConfiguration("picode.pi")
    .get<string>("transport", "rpc");
  return configured === "embedded" ? "embedded" : "rpc";
}

/**
 * Finds the pi package's ESM entry by walking up from a directory.
 *
 * Probing is necessary rather than incidental: the package publishes `dist/index.js`
 * under an `import` condition only, so a CommonJS `require.resolve` rejects it, and
 * the module system has no supported way to ask where an ESM-only package lives.
 * Walking up covers both shapes PiCode meets — an npm global shim, which sits
 * beside `node_modules`, and a direct path into `dist/bundle/` — without knowing
 * anything about npm's layout beyond that.
 *
 * The depth bound is not arbitrary: from `dist/bundle/` inside the package, the
 * entry it is looking for is four levels up.
 */
export function findSdkEntry(start: string): string | undefined {
  const nested = path.join("node_modules", ...PI_PACKAGE.split("/"), "dist", "index.js");
  const inside = path.join(...PI_PACKAGE.split("/"), "dist", "index.js");

  let current = start;
  for (let depth = 0; depth < 10; depth += 1) {
    for (const candidate of [path.join(current, nested), path.join(current, inside)]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

/**
 * The ESM entry of the pi the active runtime points at, or undefined when it is
 * not on disk. The embedded transport imports exactly this file, which is what
 * makes it load the owner's own pi rather than a second copy.
 */
export function resolveSdkEntry(extensionUri: vscode.Uri): string | undefined {
  const resolved = resolveRuntime(extensionUri);

  if (resolved.mode === "managed") {
    const bundle = resolved.argsPrefix[0];
    return bundle === undefined ? undefined : findSdkEntry(path.dirname(bundle));
  }

  return findSdkEntry(path.dirname(resolveOnPath(resolved.executable) ?? resolved.executable));
}

/** Which backend runs, and why not the other one when it was asked for. */
export interface BackendChoice {
  transport: PiTransport;
  /** The SDK entry the embedded backend imports. Present only when it runs. */
  sdkEntry?: string;
  /** Why the configured transport cannot run, when it cannot. */
  unavailable?: string;
}

/**
 * Decides which backend runs.
 *
 * A missing SDK entry is the only case where the configured transport is
 * overridden: the owner asked for the embedded one, but the active pi publishes
 * nothing to import. Falling back to RPC keeps the panel working, and the reason
 * travels back in `unavailable` so the caller reports it rather than switching
 * in silence — a transport setting that appears to do nothing is worse than a
 * fallback that says so.
 */
export function chooseBackend(extensionUri: vscode.Uri): BackendChoice {
  if (readTransport() !== "embedded") {
    return { transport: "rpc" };
  }

  const sdkEntry = resolveSdkEntry(extensionUri);
  if (sdkEntry === undefined) {
    return {
      transport: "rpc",
      unavailable: `el pi activo (${resolveRuntime(extensionUri).display}) no publica una entrada que el transporte embebido pueda importar`,
    };
  }

  return { transport: "embedded", sdkEntry };
}

/**
 * Resolves the executable for the active mode.
 *
 * The managed runtime is invoked as `node <bundle>/cli.js` rather than through
 * the npm `.cmd` shim: Node cannot execute a `.cmd` without a shell (EINVAL
 * since the CVE-2024-27980 hardening), and going through the shell would make
 * the managed runtime depend on quoting rules for a path that contains the
 * distribution's location. The bundle is the same entry point the shim runs.
 */
export function resolveRuntime(extensionUri: vscode.Uri): ResolvedRuntime {
  const mode = readMode();
  const configured = vscode.workspace
    .getConfiguration("picode.pi")
    .get<string>("executablePath", "pi");

  if (mode === "managed") {
    const pin = readPin(extensionUri);
    const root = managedRoot(extensionUri);
    const bundle = managedBundle(root, pin);
    return {
      mode,
      executable: "node",
      argsPrefix: [bundle],
      display: bundle,
    };
  }

  return { mode, executable: configured, argsPrefix: [], display: configured };
}

/**
 * Finds an executable on PATH, applying PATHEXT on Windows.
 *
 * `spawn` does not resolve `pi` to `pi.cmd` by itself, and reaching for a shell
 * to do it would put the configured value through shell parsing. Resolving here
 * keeps both the probe and the reported path honest.
 */
export function resolveOnPath(name: string): string | undefined {
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : undefined;
  }

  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Resolves a runtime into something `spawn` can actually execute.
 *
 * The RPC client does the same resolution internally for the agent process; this
 * is the shared version for the other CLI work the panel does. Node cannot run a
 * `.cmd` without a shell since the CVE-2024-27980 hardening, and a bare name only
 * resolves through PATHEXT, so both cases are handled here rather than at each
 * call site.
 */
export function spawnTarget(runtime: ResolvedRuntime): {
  command: string;
  argsPrefix: string[];
  shell: boolean;
} {
  if (runtime.mode === "managed") {
    return { command: runtime.executable, argsPrefix: [...runtime.argsPrefix], shell: false };
  }

  const located = resolveOnPath(runtime.executable) ?? runtime.executable;
  return {
    command: located,
    argsPrefix: [...runtime.argsPrefix],
    shell: /\.(cmd|bat)$/i.test(located),
  };
}

/** Reads the version of a resolved executable, or undefined when it does not answer. */
export function probeVersion(executable: string, argsPrefix: string[] = []): Promise<string | undefined> {
  return new Promise((resolve) => {
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child;
    try {
      child = spawn(executable, [...argsPrefix, "--version"], {
        shell: needsShell,
        windowsHide: true,
      });
    } catch {
      finish(undefined);
      return;
    }

    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, 10_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const first = output.split(/\r?\n/).find((line) => line.trim().length > 0);
      finish(first?.trim());
    });
  });
}

/** Everything the panel needs to render the runtime control. */
export async function describeRuntime(extensionUri: vscode.Uri): Promise<RuntimeDescriptor> {
  const pin = readPin(extensionUri);
  const root = managedRoot(extensionUri);
  const installed = managedInstalled(extensionUri, pin);
  const resolved = resolveRuntime(extensionUri);

  // The client lets the OS resolve a bare name, but the descriptor has to answer
  // "is it there?" and read a version, and `spawn` does not apply PATHEXT. So the
  // path is resolved here first, and the resolved path is what gets probed and
  // reported rather than the bare name.
  const located = resolved.mode === "managed" ? undefined : resolveOnPath(resolved.executable);
  const target = located ?? resolved.executable;

  const available = resolved.mode === "managed" ? installed : located !== undefined;
  const version = available ? await probeVersion(target, resolved.argsPrefix) : undefined;
  const sdkEntry = resolveSdkEntry(extensionUri);

  return {
    mode: resolved.mode,
    executable: resolved.executable,
    display: resolved.mode === "managed" ? root : target,
    available,
    ...(version ? { version } : {}),
    managedRoot: root,
    managedInstalled: installed,
    pin,
    ...(sdkEntry ? { sdkEntry } : {}),
    embeddedAvailable: sdkEntry !== undefined,
  };
}

export interface InstallResult {
  ok: boolean;
  message: string;
  /** The version that ended up recorded, set only when the install succeeded. */
  version?: string;
}

/* ------------------------------------------------------------------ *
 * The managed pi's own version
 * ------------------------------------------------------------------ */

/**
 * What PiCode can say about its own pi's version, and what the settings row shows.
 *
 * The three states the owner acts on are `current` (nothing to do), `available` (the
 * registry publishes a different version than the record holds) and `unknown` (the check
 * did not answer, which is not the same as "no update"). `missing` is the fourth: the
 * record exists but nothing is installed at the managed root, so there is nothing to
 * update — there is something to install.
 */
export type PiUpdateState = "current" | "available" | "unknown" | "missing";

export interface PiUpdateReport {
  /** The version the record holds, which is what the editor reports. */
  installed: string;
  /** False when nothing is installed at the managed root, whatever the record says. */
  managedInstalled: boolean;
  /** The version the registry publishes as latest, when the check answered. */
  latest?: string;
  /** True when pressing the row would change what runs: updated, downgraded or installed. */
  updateAvailable: boolean;
  state: PiUpdateState;
  /** One Spanish line for the settings row. */
  message: string;
}

export interface PiUpdateInput {
  /** The version in `runtime.json`: the record of what PiCode installed. */
  installed: string;
  /** Whether the managed bundle is actually there. */
  managedInstalled: boolean;
  /** The registry's answer, or undefined when the check could not be made. */
  latest: string | undefined;
}

/**
 * Orders two published pi versions.
 *
 * pi publishes plain `major.minor.patch`, so the parts are compared as numbers — the
 * string comparison that puts `0.9.0` above `0.87.1` would decide an update wrongly — and
 * anything after `-` is ignored. `undefined` means the two cannot be ordered at all, which
 * the caller reads as "cannot tell" rather than as either of them being newer.
 */
export function compareVersions(left: string, right: string): number | undefined {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (leftParts === undefined || rightParts === undefined) {
    return undefined;
  }

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

function versionParts(version: string): number[] | undefined {
  const core = version.trim().split("-")[0] ?? "";
  if (core === "") {
    return undefined;
  }

  const parts: number[] = [];
  for (const part of core.split(".")) {
    if (!/^\d+$/.test(part)) {
      return undefined;
    }
    parts.push(Number(part));
  }
  return parts;
}

/**
 * The one line the settings row states before the owner decides anything.
 *
 * It always names the installed version (or says there is none) and always names what the
 * registry published (or says that could not be found out), because those are the two
 * facts the decision needs and neither can be guessed from the other.
 */
export function buildPiUpdateReport(input: PiUpdateInput): PiUpdateReport {
  const { installed, managedInstalled, latest } = input;
  const installedLabel = `Instalada la ${installed}`;

  if (latest === undefined) {
    return {
      installed,
      managedInstalled,
      updateAvailable: false,
      state: managedInstalled ? "unknown" : "missing",
      message: managedInstalled
        ? `${installedLabel} · no se pudo comprobar la última publicada.`
        : "Sin instalar · no se pudo comprobar la última publicada.",
    };
  }

  if (!managedInstalled) {
    return {
      installed,
      managedInstalled,
      latest,
      updateAvailable: true,
      state: "missing",
      message: `Sin instalar · publicada la ${latest}.`,
    };
  }

  if (latest === installed) {
    return {
      installed,
      managedInstalled,
      latest,
      updateAvailable: false,
      state: "current",
      message: `${installedLabel} · es la última publicada.`,
    };
  }

  const order = compareVersions(latest, installed);
  return {
    installed,
    managedInstalled,
    latest,
    updateAvailable: true,
    state: "available",
    // An older published version is named as older: the row must not read as an update
    // the owner is missing when pressing it would in fact go backwards.
    message:
      order !== undefined && order < 0
        ? `${installedLabel} · publicada la ${latest}, más antigua.`
        : `${installedLabel} · publicada la ${latest}.`,
  };
}

/**
 * Asks the package registry which version of the pinned package is published as latest.
 *
 * `undefined` is a check that could not be made, never "there is no newer version": the
 * row says which of the two happened. The registry client is the catalogue's own, so the
 * update check and the catalogue cannot end up asking two different questions of the same
 * endpoint.
 */
export async function latestPublishedVersion(pin: RuntimePin): Promise<string | undefined> {
  const versions = await resolveLatestVersions([pin.package]);
  return versions.get(pin.package);
}

/**
 * The manifest of the managed install, whose version is the one actually on disk.
 *
 * `runtime.json` records what PiCode installed, but a record is a claim; this is the
 * fact. It is read straight after npm reports success, so the record is written from the
 * package that landed rather than from the version that was asked for.
 */
export function readManagedVersion(root: string, pin: RuntimePin): string | undefined {
  const manifest = path.join(root, "node_modules", ...pin.package.split("/"), "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8")) as unknown;
  } catch {
    return undefined;
  }

  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { version?: unknown }).version
      : undefined;
  return typeof version === "string" && version !== "" ? version : undefined;
}

/**
 * Records the version of the managed install that is on disk.
 *
 * `runtime.json` is data: the version in it is what the editor reports and what the next
 * update compares against, so it is written from the package npm just left behind and only
 * then. An install that produced no package records nothing, and says so, rather than
 * leaving the file claiming a version the disk does not have.
 */
export function writePin(extensionUri: vscode.Uri, version: string): void {
  const file = vscode.Uri.joinPath(extensionUri, PIN_FILE).fsPath;
  // The package stays whatever the file says: this records a version, it does not decide
  // which package PiCode installs.
  const pin = readPin(extensionUri);
  writeFileSync(file, `${JSON.stringify({ package: pin.package, version }, null, 2)}\n`, "utf8");
}

/**
 * The install's outcome, decided by what is on disk once npm is done.
 *
 * Separated from the npm run so the rule can be exercised without a registry: the record
 * follows the artifact, and an npm run that left no package is a failed install even when
 * npm exited zero.
 */
export function recordManagedInstall(
  extensionUri: vscode.Uri,
  root: string,
  pin: RuntimePin,
): InstallResult {
  const installed = readManagedVersion(root, pin);
  if (installed === undefined) {
    return {
      ok: false,
      message: `npm terminó sin error, pero ${pin.package} no quedó en la carpeta del runtime de PiCode.`,
    };
  }

  try {
    writePin(extensionUri, installed);
  } catch (error) {
    return {
      ok: false,
      message: `Se instaló ${pin.package}@${installed}, pero no se pudo anotar la versión instalada: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    ok: true,
    version: installed,
    message: `Instalado ${pin.package}@${installed}.`,
  };
}

/**
 * Installs the pinned runtime into the distribution's own tree.
 *
 * `--ignore-scripts` is deliberate: the managed install only needs the published
 * bundle, and running arbitrary install scripts is a supply-chain surface this
 * product should not add on the user's behalf.
 *
 * `version` installs a version other than the pinned one — the settings tab's update row
 * uses it to move the managed pi forward — and the record is written from whatever npm
 * leaves on disk, never from the version that was requested.
 */
export function installManagedRuntime(
  extensionUri: vscode.Uri,
  onOutput: (line: string) => void,
  version?: string,
): Promise<InstallResult> {
  const pin = readPin(extensionUri);
  const root = managedRoot(extensionUri);
  const npm = resolveOnPath("npm");
  const target = version ?? pin.version;

  if (!npm) {
    return Promise.resolve({
      ok: false,
      message: "No se encontró npm en el PATH, así que no se puede instalar el pi propio de PiCode.",
    });
  }

  const spec = `${pin.package}@${target}`;
  const args = [
    "install",
    "--prefix",
    root,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    spec,
  ];

  onOutput(`Running: npm ${args.join(" ")}`);

  return new Promise((resolve) => {
    // `spawn` with a shell concatenates arguments instead of escaping them, so a
    // path containing a space would split into two. Quote only what needs it.
    const usesShell = /\.(cmd|bat)$/i.test(npm);
    const spawnArgs = usesShell
      ? args.map((argument) => (/\s/.test(argument) ? `"${argument}"` : argument))
      : args;

    const child = spawn(npm, spawnArgs, {
      shell: usesShell,
      windowsHide: true,
    });

    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim().length > 0) {
          onOutput(line.trimEnd());
        }
      }
    };

    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("error", (error) => {
      resolve({ ok: false, message: `npm no se pudo iniciar: ${error.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) {
        // Only a finished npm run gets to touch the record, and only with the version it
        // actually left behind: a failure here must not leave `runtime.json` naming a
        // version that is not on disk.
        resolve(recordManagedInstall(extensionUri, root, pin));
      } else {
        resolve({ ok: false, message: `npm terminó con el código ${code}.` });
      }
    });
  });
}
