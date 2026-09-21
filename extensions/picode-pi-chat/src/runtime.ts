import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

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

  return {
    mode: resolved.mode,
    executable: resolved.executable,
    display: resolved.mode === "managed" ? root : target,
    available,
    ...(version ? { version } : {}),
    managedRoot: root,
    managedInstalled: installed,
    pin,
  };
}

export interface InstallResult {
  ok: boolean;
  message: string;
}

/**
 * Installs the pinned runtime into the distribution's own tree.
 *
 * `--ignore-scripts` is deliberate: the managed install only needs the published
 * bundle, and running arbitrary install scripts is a supply-chain surface this
 * product should not add on the user's behalf.
 */
export function installManagedRuntime(
  extensionUri: vscode.Uri,
  onOutput: (line: string) => void,
): Promise<InstallResult> {
  const pin = readPin(extensionUri);
  const root = managedRoot(extensionUri);
  const npm = resolveOnPath("npm");

  if (!npm) {
    return Promise.resolve({
      ok: false,
      message: "npm was not found on PATH, so the managed pi runtime cannot be installed.",
    });
  }

  const spec = `${pin.package}@${pin.version}`;
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
      resolve({ ok: false, message: `npm could not be started: ${error.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, message: `Installed ${spec}.` });
      } else {
        resolve({ ok: false, message: `npm exited with code ${code}.` });
      }
    });
  });
}
