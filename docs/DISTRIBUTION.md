# PiCode distribution strategy (Windows)

This document describes how PiCode is distributed on Windows. It records the
chosen strategy, the mechanism each layer relies on, the limits of that
mechanism, and how a human verifies that the branding actually applied.

Status: MVP strategy for the Windows-first foundation (ADR-004). Nothing here
requires compiling the editor. The branding layer was executed and observed
against a running VSCodium on 2026-09-20; sections 4.3, 4.4, 4.5 and 10 carry
that result.

Conventions used below:

- **Verified** — confirmed in this pass from a repository file, a fetched
  upstream file, or a read-only probe of this machine.
- **Inference** — a reasoned conclusion from verified evidence that was not
  directly exercised.
- **Measured** — confirmed by executing the operation on this machine and
  observing the result (runtime pass of 2026-09-20).

## 1. Goal and constraints

**Goal.** Ship a lightweight, rebranded VS Code distribution for Windows in which
the pi coding agent and gentle-pi (Gentle AI) are first-class, pre-integrated
experiences: opening PiCode means opening a working agentic development
environment, with no setup ceremony.

**Constraints.**

1. **Lightweight.** No multi-GB source tree, no yarn + native-modules + Electron
   build, no 30-90 minute rebuild per iteration. This is the constraint that
   rules out a fork build, and it is the single most load-bearing constraint in
   this document.
2. **Redistributable brand.** The product cannot be built on Microsoft-branded
   binaries and cannot use the Microsoft Marketplace (section 3, section 8).
3. **Windows first** (ADR-004).
4. **No invented integration surfaces.** PiCode integrates only through protocol
   surfaces that already exist (ADR-003, ADR-005, ADR-006).

## 2. Chosen strategy: layered on VSCodium, no compilation

PiCode is a **layered distribution**. It does not fork and does not compile the
editor. It applies five ordered layers on top of an existing VSCodium install.

| # | Layer | Artifact | Applied by |
| --- | --- | --- | --- |
| 1 | Editor | VSCodium (stock binary) | the user, or `winget install VSCodium.VSCodium` |
| 2 | Branding | `distribution/product.json` | copied into the VSCodium user data directory |
| 3 | Agent runtime | pinned `pi` + pinned `gentle-pi` | npm global install + `pi install` |
| 4 | Editor extension | `extensions/picode-pi-chat` | VSIX installed with `codium --install-extension` |
| 5 | Defaults | `distribution/settings.json` | copied only when the user has no settings file |

The layers are independent, each is idempotent, and each is separately
revertible. `distribution/bootstrap.ps1` applies them; `distribution/README.md`
is the operator runbook.

Upstream licensing is the reason VSCodium is the base rather than Microsoft's
build: the VS Code *source* is MIT, but Microsoft's released *binaries* are under
a proprietary license, its brand is Microsoft's, and the Marketplace Terms of Use
restrict Marketplace offerings to Visual Studio products (ADR-002). VSCodium is
the MIT-licensed community build of that source with Microsoft branding and
telemetry already removed, and it is redistributable.

## 3. Layer 1 — editor: VSCodium

The base is a stock VSCodium install. PiCode ships no editor binary, so there is
nothing to compile and nothing to keep in sync with upstream source.

- Install is the user's decision: `winget install VSCodium.VSCodium`.
  `bootstrap.ps1` detects an existing install and otherwise **prints** that
  command; it never installs the editor silently.
- VSCodium points its extension gallery at Open VSX
  (`https://open-vsx.org/vscode/gallery`), which is what makes a
  redistribution legal and functional (section 4.4).
- **Cost accepted:** VSCodium trails upstream by a few minor versions. At the time
  of writing, the newest VSCodium release tag was `1.135.06055` (published
  2026-09-09) while the newest VS Code stable was `1.138.0` — three minor
  versions behind. VSCodium also carries a patch series against upstream (the
  `patches/` directory) that its maintainers rebase for every upstream release.
  That rebase burden is real, and it is the burden PiCode would inherit or
  duplicate by moving to a fork build (section 9). The working figure used for
  this decision was on the order of 50 patches per upstream release; this pass
  did not independently count them.
- **Measured version lag (2026-09-20).** `winget install -e --id
  VSCodium.VSCodium --accept-package-agreements --accept-source-agreements
  --disable-interactivity` returned exit 0 and installed VSCodium **1.126.04524**
  at `C:\Users\tapla\AppData\Local\Programs\VSCodium` (CLI at `bin\codium.cmd`).
  That is well behind the `1.135.06055` release tag reported above, so the winget
  catalog lags the upstream release feed; `winget upgrade` may offer a newer
  build.

## 4. Layer 2 — branding via user-level `product.json`

This is the mechanism that makes the no-compile path possible, and it is also
the layer with the most sharp edges.

### 4.1 Mechanism

VSCodium applies a patch, `00-settings-user-product.patch`, that is **not present
in stock VS Code**. On startup it:

1. resolves the user data directory,
2. loads `product.json` from that directory if it exists,
3. stores it on `globalThis._VSCODE_USER_PRODUCT_JSON`,
4. deep-merges it over the built-in product configuration.

The relevant patch fragments:

```ts
// src/cli.ts
const userDataPath = getUserDataPath({_:[]}, product.nameShort ?? 'code-oss-dev');
const userProductPath = path.join(userDataPath, 'product.json');
// ...
const productJson = require(userProductPath);
globalThis._VSCODE_USER_PRODUCT_JSON = productJson;
```

```ts
// src/vs/platform/product/common/product.ts
const merge = (...objects: any[]) =>
    objects.reduce((result, current) => {
        Object.keys(current).forEach((key) => {
            if (Array.isArray(result[key]) && Array.isArray(current[key])) {
                result[key] = current[key];
            } else if (typeof result[key] === 'object' && typeof current[key] === 'object') {
                result[key] = merge(result[key], current[key]);
            } else {
                result[key] = current[key];
            }
        });
        return result;
    }, {}) as any;

const userProduct = globalThis._VSCODE_USER_PRODUCT_JSON || {};
product = merge(product, userProduct);
```

**Verified:** the patch content above was fetched from the VSCodium repository at
both `master` and the released tag `1.135.06055`.

**Verified:** because the file is loaded with `require()`, it is parsed as strict
JSON. Comments and trailing commas are **not** allowed. `distribution/product.json`
therefore carries no comments; this document is its comment.

### 4.2 Merge semantics, and the array-replacement trap

The merge is `merge(product, userProduct)`: the overlay always wins, and the
built-in product is the base.

| Both sides are | Result |
| --- | --- |
| arrays | **the overlay array replaces the base array** — it does not append |
| objects | recursive merge, key by key |
| anything else | overlay value overwrites the base value |

**The trap.** In a *compiled* build, `builtInExtensions` in `product.json` is the
list of extensions baked into the product, parsed by `build/lib/builtInExtensions.ts`.
It is an array. Under these merge semantics, an overlay that sets
`builtInExtensions` would **replace the entire built-in extension list** rather
than add to it. Two further consequences:

- `galaxyCollection` is not a Code-OSS build input; it is not a lever for our
  pre-installed extension set either.
- For the no-compile path this key is largely moot: `builtInExtensions` is a
  build-time input, not a runtime loader, so it cannot install `picode-pi-chat`
  into a stock VSCodium anyway. PiCode's overlay therefore contains **no arrays
  at all**, which structurally avoids the trap. Extension delivery happens in
  Layer 4 instead.

An overlay also cannot *delete* a built-in key: it can only override it. There is
no "unset" operation in this merge.

### 4.3 The overlay path, and how it is derived

The overlay path is derived from the patch and from VSCodium's build inputs:

```text
patches/00-settings-user-product.patch
  getUserDataPath({_:[]}, product.nameShort ?? 'code-oss-dev')

src/vs/platform/environment/node/userDataPath.ts
  getDefaultUserDataPath(productName) -> win32: join(process.env['APPDATA'], productName)

prepare_vscode.sh (stable branch)
  setpath "product" "nameShort" "VSCodium"

therefore:
  %APPDATA% \ VSCodium \ product.json
  C:\Users\<user>\AppData\Roaming\VSCodium\product.json
```

**Correction to a working assumption.** The path is derived from the product's
**`nameShort`**, not from its `dataFolderName`. Evidence:

- VSCodium's repository `product.json` contains only extension-related keys
  (`extensionAllowedBadgeProviders`, `extensionEnabledApiProposals`, …). It has
  no `dataFolderName` key at all — verified by listing the file's top-level keys.
- `prepare_vscode.sh` sets `dataFolderName` only in the **Insider** branch
  (`.vscodium-insiders`). The stable branch does not set it, so the released
  stable build keeps upstream VS Code's `.vscode-oss`.
- `dataFolderName` drives the **extensions directory** and `argv.json`
  (`environmentService.ts`: `joinPath(userHome, dataFolderName, 'extensions')`),
  not the user data root.
- Corroboration: VSCodium's own migration documentation lists the Windows user
  settings folder as `%APPDATA%\VSCodium\User`.

**The subtle trap that follows from this.** PiCode's overlay sets
`nameShort` to `"PiCode"`. It is tempting to conclude that the overlay then
belongs in `%APPDATA%\PiCode`. It does not. `resolveUserProduct()` runs **before**
the merge and reads the *compiled-in* product, whose `nameShort` is `"VSCodium"`.
So, for as long as the base is VSCodium, the overlay must live at
`%APPDATA%\VSCodium\product.json`. This is stable across launches, because the
path is recomputed from the built-in product every time.

Environment overrides that change the destination, mirrored by `bootstrap.ps1`
because they are honored by `doGetUserDataPath()`:

| Condition | User data directory | Overlay path |
| --- | --- | --- |
| `VSCODE_PORTABLE` set | `<portable>\user-data` | `<portable>\user-data\product.json` |
| `VSCODE_APPDATA` set | `<vscode-appdata>\VSCodium` | `<vscode-appdata>\VSCodium\product.json` |
| `VSCODE_DEV` set | forces product name `code-oss-dev` | `<...>\code-oss-dev\product.json` |
| default (Windows) | `%APPDATA%\VSCodium` | `%APPDATA%\VSCodium\product.json` |

**Measured (2026-09-20).** The derivation was exercised against a real install.
`winget install -e --id VSCodium.VSCodium` installed VSCodium **1.126.04524**,
and `%APPDATA%\VSCodium` did not exist beforehand. Running
`distribution/bootstrap.ps1` in preview created nothing (exit 0); running it with
`-Apply` created that directory and wrote the overlay to exactly the derived
path, `%APPDATA%\VSCodium\product.json`. The observed location corroborates the
`nameShort` derivation: the overlay landed under `%APPDATA%\VSCodium`, not under
`%APPDATA%\PiCode`, even though the overlay sets `nameShort` to `"PiCode"`.
Section 10 carries the per-check result.

### 4.4 What this layer CAN rebrand

Runtime product configuration that the editor reads from `product.json`. PiCode's
overlay (`distribution/product.json`) is deliberately minimal:

| Key | Value | Effect |
| --- | --- | --- |
| `nameShort` | `"PiCode"` | short product name in the UI |
| `nameLong` | `"PiCode — Agentic Code Editor"` | long product name (About dialog, window metadata) |
| `urlProtocol` | `"picode"` | the protocol string the product recognises at runtime |
| `extensionsGallery` | Open VSX endpoints | the extension gallery the Extensions view queries |

`extensionsGallery` is an object, so the merge recurses into it and the overlay
values win per key. It is the same Open VSX configuration VSCodium already ships;
restating it makes PiCode's intent explicit and independent of VSCodium's build
defaults.

**Measured (2026-09-20).** With the overlay in place, `codium --help` prints
`PiCode — Agentic Code Editor 1.126.04524` as its first line. That first token is
the overlay's `nameLong`, so the deep-merge is confirmed inside a real VSCodium
process, not only in the patch source. The on-disk overlay contains exactly
`nameShort` = `"PiCode"`, `nameLong` = `"PiCode — Agentic Code Editor"`,
`urlProtocol` = `"picode"`, and the Open VSX `extensionsGallery` block (its
`serviceUrl`, `itemUrl`, `latestUrlTemplate` and `controlUrl`). Presence of
`urlProtocol` in the file is not the same as the OS handler being registered; see
section 4.5.

**Deliberately omitted keys, with reasons:**

- `applicationName`, `win32*` identifiers, `darwinBundleIdentifier` — not
  rebrandable at this layer in a way that produces a consistent system
  (section 4.5).
- `dataFolderName` — technically writable through this merge, but changing it
  would relocate the extensions directory and `argv.json`, orphaning the user's
  installed extensions. We leave it at the inherited `.vscode-oss`.
- `builtInExtensions` — an array; see the trap in section 4.2.

### 4.5 What this layer CANNOT rebrand

Stated plainly, because these are the limits the no-compile path accepts:

- **The executable and binary identity.** The process is still `VSCodium.exe` and
  the CLI is still `codium`. **Measured (2026-09-20):** the same `codium --help`
  invocation whose first line carries the overlay's `nameLong` still prints
  `Usage: codium.exe [options] [paths...]`, so the executable name did not change
  even though the product-long-name string did.
- **Windows OS-level identity as installed.** The installer is branded at build
  time: `prepare_vscode.sh` rewrites the Inno Setup script
  (`build/win32/code.iss`) with VSCodium's vendor name and URLs. A user-level
  overlay cannot retroactively change:
  - the Start Menu shortcut name,
  - the Add/Remove Programs entry and the installer identity (`win32AppId*` GUIDs),
  - the registered protocol handler (`vscodium://`),
  - File Explorer context-menu entries,
  - registry keys, including the policy key
    (`HKLM\SOFTWARE\Policies\VSCodium\VSCodium\<PolicyName>`, per VSCodium's
    policy-watcher patch),
  - the `AppUserModelId` value that the installer wrote.
- **`urlProtocol` caveat (inference).** The overlay changes the runtime value the
  editor uses, but on Windows the OS handler is registered by the installer. The
  editor's own startup code (`src/main.ts`) contains no
  `setAsDefaultProtocolClient` call or `urlProtocol` reference — verified by
  fetching the file. So `picode://` deep links from the OS are **not** guaranteed
  by this layer; the OS still opens `vscodium://`. This is listed in section 10
  as something a human should confirm on a real install. **Measured state
  (2026-09-20):** the overlay does carry `urlProtocol: "picode"`, but `reg query`
  for `HKCU\Software\Classes\picode`, `HKCU\Software\Classes\vscodium` and
  `HKCU\Software\Classes\codium` all return "not found", including for
  VSCodium's own scheme. This is **inconclusive**, not a confirmed failure:
  VSCodium has never been launched on this machine and protocol registration
  plausibly happens on first run. Re-check after the editor has been started once.
  Until then `picode://` must not be documented as working, nor as definitively
  absent.
- **Anything read before the merge.** Keys consumed before the overlay loads
  cannot be influenced, by definition.

This is exactly why `distribution/product.json` excludes `applicationName` and
the `win32*` keys: including them would make the *runtime* window identity say
PiCode while the *installed* system identity still says VSCodium, which is a
worse state than a consistent one.

## 5. Layer 3 — agent runtime: pinned pi and gentle-pi

PiCode pins and ships its own agent runtime rather than depending on whatever
happens to be on the user's `PATH` (ADR-010).

| Component | Pinned version | How it is installed |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `0.86.1` | `npm install -g @earendil-works/pi-coding-agent@0.86.1` |
| `gentle-pi` | `3.3.0` | `pi install npm:gentle-pi@3.3.0` |

**Verified:**

- `pi` declares `engines.node >= 22.19.0` in its package manifest. That is pi's
  requirement, not a preference of ours, and PiCode's own minimum is the same.
- gentle-pi is a **pi package**, not an npm CLI. Its behaviour lives in its
  `extensions/*.ts`, loaded through the package's `pi` manifest, and it is
  installed with pi's own mechanism. pi's documentation (`docs/packages.md`)
  documents versioned npm specs (`pi install npm:@foo/bar@1.0.0`) as pinned and
  excluded from package updates, which is why the command above is the exact,
  non-invented invocation.
- The `gentle-ai` CLI is a **Go binary bundled inside the gentle-pi package** at
  `.gentle-ai/v3.4.0/gentle-ai.exe` (with an adjacent `integrity.json`). Because
  PiCode installs the package, **the user does not need a Go toolchain**.

**User override.** The extension setting `picode.pi.executablePath` lets a user
point PiCode at a different pi binary. PiCode's default is the pinned global
install; the setting exists so the pin never becomes a lock-in.

## 6. Layer 4 — the PiCode extension

The agent UI is the extension at `extensions/picode-pi-chat/` (publisher
`picode`, version `0.1.0`, `engines.vscode ^1.90.0`). It speaks to pi over
`pi --mode rpc` as a child process (ADR-003), with strict LF-only framing
(ADR-005).

**Delivery without a compiled-in extension list.** Because PiCode does not
compile the editor, it cannot use `builtInExtensions` (section 4.2). The
extension is delivered as a **VSIX installed into the user's extensions
directory**:

```powershell
cd extensions/picode-pi-chat
npx --yes @vscode/vsce package          # produce picode-pi-chat-0.1.0.vsix
codium --install-extension picode-pi-chat-0.1.0.vsix
```

`bootstrap.ps1` looks for the newest `.vsix` in the extension directory and
installs it. If no VSIX exists it **prints the packaging command instead of
failing**, because packaging is a release step, not a bootstrap step.

**Opt-in panel (ADR-009).** The manifest declares `activationEvents: []` and four
commands, including `picode.piChat.open`. Nothing activates or opens a panel at
startup: the panel is created only when the user runs an explicit command. This
is a verified property of the shipped manifest, so ADR-009 needs no new code.

**Measured (2026-09-20).** `extensions/picode-pi-chat/picode-pi-chat-0.1.0.vsix`
exists, `bootstrap.ps1 -Apply` installed it, and codium reported "Extension
'picode-pi-chat-0.1.0.vsix' was successfully installed." `codium
--list-extensions` then returned exactly `picode.picode-pi-chat`. The manifest's
declared `engines.vscode ^1.90.0` is satisfied by the installed 1.126.04524. The
`vsce package` invocation itself was not part of this measurement pass, and
activation inside the editor (the panel) remains unexercised — see section 10,
item 4. `bootstrap.ps1` still handles the absent-VSIX case by design.

## 7. Layer 5 — defaults without overwriting user choices

PiCode ships a small default `settings.json` (`distribution/settings.json`),
covering:

- the extension's `picode.pi.*` settings group, at the pinned bundled values
  (`picode.pi.executablePath: "pi"`, empty `defaultModel`, empty `extraArgs`),
- agent-editor defaults (`files.autoSave: "off"`, no minimap, no format-on-save,
  LF line endings, a monospace font baseline, PowerShell as the default Windows
  terminal profile),
- explicit `telemetry.telemetryLevel: "off"` and
  `security.workspace.trust.enabled: true`.

**Application rule.** The file is copied to
`%APPDATA%\VSCodium\User\settings.json` **only when that file does not already
exist**. If it exists, the bootstrap reports the conflict and instructs the
operator to merge manually. A distribution must never silently clobber the
user's own settings file; VS Code's user settings are user-owned state.

**Note.** VS Code accepts JSONC in user settings, but PiCode ships strict JSON so
the file is tool-parseable and diffable. That is a deliberate trade: the defaults
have no comments, and this document plus the operator guide carry the rationale.

## 8. What this path does NOT give you

Blunt version:

- **The binary is VSCodium.** `VSCodium.exe`, the `codium` CLI shim, the process
  name in Task Manager, the crash-reporter identity and the installed file names
  are all VSCodium's and stay VSCodium's.
- **The OS-level identity is VSCodium.** Start Menu entry, File Explorer context
  menu, Add/Remove Programs entry, protocol handler registration, registry keys
  and installer GUIDs were written at install time and are not reachable from a
  user-level `product.json`.
- **The built-in extension set is VSCodium's and cannot be replaced at runtime.**
  `builtInExtensions` is a build input, and the overlay merge would replace the
  whole array rather than extend it.
- **What you actually get** is a VSCodium install that *presents* as PiCode inside
  the editor: product names, gallery configuration, agent runtime, agent panel
  and defaults. That is the honest scope of "rebranded distribution" on this path.

The only way to change the binary and OS-level identity is the fork build.

## 9. Escape hatch: when a fork build becomes worth it

The fork path is **deferred, not rejected** (ADR-008). Trigger conditions:

1. **A required product key is unreachable.** PiCode needs to change something
   read before the overlay merge, or something outside `product.json`'s runtime
   reach.
2. **The distribution must have PiCode OS identity.** An installer that creates a
   PiCode Start Menu entry, registers `picode://`, appears as PiCode in
   Add/Remove Programs and owns its file associations.
3. **The user-product patch disappears or regresses upstream.** The entire
   strategy depends on VSCodium's `00-settings-user-product.patch`, which stock
   VS Code does not have. If VSCodium drops it, the no-compile branding path
   breaks.
4. **The version lag becomes product-blocking.** When three minor versions behind
   upstream blocks a feature PiCode depends on.

**Toolchain gaps measured on this machine (2026-09-20)** against VSCodium's
documented build prerequisites (`docs/howto-build.md`): Node from `.nvmrc`,
`jq`, `git`, `python3 3.11`, `rustup`, plus Git Bash, 7-Zip and the MSVC build
tools on Windows.

| Requirement | Status on this machine | Evidence |
| --- | --- | --- |
| Node.js per `.nvmrc` (VSCodium pins `24.18.0`) | **version mismatch** — `24.19.0` installed | `node --version` |
| `jq` | **missing** | `jq --version` not found |
| `git` / Git Bash | present — Git `2.55.0.windows.3` | `git --version` |
| Python 3.11 | **missing** — only `3.14.7` present (`C:\Python314`) | `python --version`; no 3.11 install directory |
| `rustup` / `cargo` | **missing** | `rustup --version` / `cargo --version` not found |
| 7-Zip | present — `C:\Program Files\7-Zip\7z.exe` | file probe (`7z` is not on `PATH`) |
| MSVC build tools 2022 | **effectively absent** | the 2022 install directories under both `Program Files` and `Program Files (x86)` are empty; there is no `vswhere.exe`, no `VC\Tools\MSVC`, no Windows SDK `Include` directory, and `cl` is not on `PATH`. **This corrects the working assumption that MSVC Build Tools 2022 were present.** |
| Disk space | D: has ~264 GB free of 466 GB | `df -h /d` |
| Build time | ~30-90 minutes per build | working estimate, not measured here |

`prepare_vscode.sh` uses `jq` for its `setpath`/`setpath_json` helpers — verified
by reading the script — so `jq` is a hard requirement, not a convenience.

The sequencing matters: every missing tool except the Node version is one
`winget install` away, but the Python 3.11 pin and the Node version pin mean the
fork path wants a toolchain *isolated* from the developer's daily Node and
Python. That is a half-day of environment work plus a first build, which is why
the no-compile path is the right default until a trigger above fires.

## 10. Verification plan

This is how a human confirms the branding actually applied after VSCodium is
installed. The plan was first executed on 2026-09-20 against VSCodium
**1.126.04524**; the per-step result is recorded inline. Steps that need the GUI
still remain open.

1. **Overlay present and valid. — DONE (2026-09-20).**
   ```powershell
   Get-Content "$env:APPDATA\VSCodium\product.json" | ConvertFrom-Json
   ```
   Result: the file exists at the derived path and contains exactly the PiCode
   keys — `nameShort` `"PiCode"`, `nameLong` `"PiCode — Agentic Code Editor"`,
   `urlProtocol` `"picode"`, and the Open VSX `extensionsGallery` block. That it
   parsed as strict JSON is proven by step 2: the file is loaded with `require()`,
   and the patch catches load errors and continues with the built-in product, so
   the PiCode `nameLong` could not have appeared if the file were malformed.
2. **Overlay actually merged. — DONE (2026-09-20).** The planned check was to
   launch VSCodium and open **Help > About**; the equivalent check used the CLI:
   `codium --help` prints `PiCode — Agentic Code Editor 1.126.04524` as its first
   line, which is the overlay's `nameLong`. The deep-merge is therefore confirmed
   in a real VSCodium process. If it had still shown VSCodium, check in this
   order: `VSCODE_PORTABLE`/`VSCODE_APPDATA` are diverting the path (both are
   printed by `bootstrap.ps1`); the file is under `%APPDATA%\VSCodium` and not
   under a `PiCode` folder; the JSON parses.
3. **Gallery. — OPEN.** Open the Extensions view and search a known Open VSX-only
   extension. Expected: results, which proves the `extensionsGallery` override is
   live. The overlay carries the Open VSX block, but the gallery was not queried
   in this pass; extension delivery used the VSIX route (step 4), which does not
   exercise the gallery.
4. **Extension. — PARTIAL.** `bootstrap.ps1 -Apply` installed
   `extensions/picode-pi-chat/picode-pi-chat-0.1.0.vsix` and codium reported
   "Extension 'picode-pi-chat-0.1.0.vsix' was successfully installed.";
   `codium --list-extensions` returns exactly `picode.picode-pi-chat`, and
   `engines.vscode ^1.90.0` is satisfied by 1.126.04524. **Still open:** the panel
   itself. Run **PiCode: Open pi Chat** from the Command Palette and confirm a
   panel appears, then confirm that no panel appears on a fresh startup with no
   command run (ADR-009). The webview layer remains unexercised.
5. **Agent runtime. — OPEN.** In a terminal inside the editor, run `pi --version`
   and `pi list`. Expected: `0.86.1`, and `gentle-pi` in the list. Confirm
   `gentle-ai --version`-style subcommands resolve through the bundled Go binary
   without a Go install. `bootstrap.ps1 -Apply` reported pi `0.86.1` and gentle-pi
   `3.3.0` as already installed and skipped them, which corroborates presence but
   is not the in-editor check.
6. **Expected limits (negative check).** Confirm the no-compile boundary honestly:
   - **DONE:** `codium --help` still prints `Usage: codium.exe [options]
     [paths...]`, so the executable name is unchanged, while `codium --version`
     reports `1.126.04524` / `4c0b0c6cc561d2d3636d1ec250935431876ce4dc` / `x64`.
   - **OPEN:** the Windows Start Menu entry and the Add/Remove Programs entry
     still say VSCodium (not inspected in this pass).
   - **INCONCLUSIVE:** `vscodium://` versus `picode://` as the registered
     protocol. `reg query` for `HKCU\Software\Classes\picode`,
     `HKCU\Software\Classes\vscodium` and `HKCU\Software\Classes\codium` all
     return "not found". VSCodium has never been launched, and registration
     plausibly happens on first run, so this must be re-checked after the first
     launch (section 4.5).
   These are not defects; they are the documented cost of the chosen path.
7. **Revert check. — OPEN.** Move `product.json` aside, restart, and confirm the
   editor returns to VSCodium branding without touching any other layer.

## Sources

Fetched and read during the research pass, plus runtime observations from the
2026-09-20 verification pass (final row).

| Claim | Source |
| --- | --- |
| User-level `product.json` load and merge | `https://github.com/VSCodium/vscodium/blob/master/patches/00-settings-user-product.patch` (also at tag `1.135.06055`) |
| User data path resolution | `https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/userDataPath.ts` |
| User data path call site | `https://github.com/microsoft/vscode/blob/main/src/main.ts` |
| Extensions path from `dataFolderName` | `https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/common/environmentService.ts` |
| Upstream `dataFolderName: .vscode-oss` | `https://github.com/microsoft/vscode/blob/main/product.json` |
| VSCodium branding values and Open VSX gallery | `https://github.com/VSCodium/vscodium/blob/master/prepare_vscode.sh` |
| VSCodium repository `product.json` (no `dataFolderName`) | `https://github.com/VSCodium/vscodium/blob/master/product.json` |
| Windows user settings folder `%APPDATA%\VSCodium\User` | `https://github.com/VSCodium/vscodium/blob/master/docs/migration.md` |
| Marketplace restriction and Open VSX rationale | `https://github.com/VSCodium/vscodium/blob/master/docs/extensions.md` and `https://github.com/microsoft/vscode/issues/31168` |
| `builtInExtensions` is a build input | `https://github.com/VSCodium/vscodium/blob/master/docs/howto-build.md`, `build/lib/builtInExtensions.ts` in the VS Code source |
| MIT license scope, installer branding at build time | `https://github.com/VSCodium/vscodium/blob/master/README.md`, `https://github.com/VSCodium/vscodium/blob/master/LICENSE`, `prepare_vscode.sh` |
| VSCodium build prerequisites and `.nvmrc` | `https://github.com/VSCodium/vscodium/blob/master/docs/howto-build.md`, `https://github.com/VSCodium/vscodium/blob/master/.nvmrc` |
| Policy registry key | `https://github.com/VSCodium/vscodium/blob/master/docs/patches.md` |
| Latest VSCodium release | `https://github.com/VSCodium/vscodium/releases` (tag `1.135.06055`) |
| Latest VS Code stable | `https://update.code.visualstudio.com/api/releases/stable` (`1.138.0`) |
| VS Code binary license | `https://code.visualstudio.com/license` |
| Marketplace Terms of Use | `https://aka.ms/vsmarketplace-ToU` |
| Open VSX registry | `https://open-vsx.org` |
| pi install commands and versioned npm specs | `@earendil-works/pi-coding-agent` `docs/packages.md` (local install) |
| Runtime branding, version, and installed extension | `codium --help`, `codium --version`, `codium --list-extensions`, and the overlay files on this machine (VSCodium `1.126.04524`, measured 2026-09-20) |

## Verified facts versus inferences

**Verified in this pass:** the patch contents and merge semantics; the user data
path call chain; VSCodium's `nameShort` value and absent stable `dataFolderName`;
the Open VSX gallery configuration; the extensions-path derivation from
`dataFolderName`; the marketplace restriction; VSCodium and VS Code version
numbers; pi's Node requirement; gentle-pi's install form; the bundled gentle-ai
Go binary and its version; the extension manifest's `activationEvents` and
commands; and every toolchain probe in section 9, including the MSVC correction.

**Measured at runtime (2026-09-20):** VSCodium `1.126.04524` installed through
winget; `bootstrap.ps1 -Apply` wrote the overlay to the derived path and installed
`picode-pi-chat` from the VSIX; and the overlay's `nameLong` appears as the first
line of `codium --help`. The overlay path and the deep-merge are no longer
inferences.

**Still inference, or open:** whether `picode://` replaces the
installer-registered `vscodium://` handler (the registry check was inconclusive
because VSCodium has never been launched); that the Open VSX gallery override is
live in the Extensions view; and that the extension activates and renders its
panel from the VSIX inside the editor. Section 10 records the remaining checks.
