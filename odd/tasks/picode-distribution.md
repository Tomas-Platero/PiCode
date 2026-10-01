# Feature: PiCode distribution (owned VSCodium tree)

## Goal

Turn the VSCodium tree extracted at the repository root into the PiCode
distribution: a portable PiCode profile, a rebranded `product.json` with the
Microsoft Copilot and telemetry wiring **deleted** rather than overridden, the
`picode-pi-chat` panel shipped as a built-in extension, and a reproducible apply
script so the payload can be rebuilt from a stock VSCodium archive.

## Why this feature exists

The foundation feature (`odd/tasks/picode-foundation.md`) locked ADR-008: layer
branding on a *stock, separately installed* VSCodium through a user-level
`%APPDATA%\VSCodium\product.json` overlay. That path has a hard limit the
foundation documented itself: the overlay is merged over the built-in product
with `merge(product, userProduct)`, which can **override** keys but can never
**delete** them. Copilot therefore could not be removed, only restated.

The product owner has now extracted the VSCodium archive into this repository, so
PiCode owns the tree. That removes the limit and makes the following possible
without compiling anything:

- `resources/app/product.json` is editable, so keys can be removed;
- built-in extensions live in an editable directory, so the panel can ship as a
  built-in extension instead of a VSIX install step;
- a `data/` folder next to the executable switches the build to portable mode,
  giving PiCode an isolated profile.

No compiler, no fork, no merge burden against upstream. ADR-008's *decision*
(no compile) is preserved; its *letter* (never touch VSCodium's files) is
superseded and recorded as ADR-011.

## Decisions (locked by the product owner, 2026-09-21)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Where the distribution lives | This repository root **is** the PiCode distribution; the modification layer is versioned, the binary payload is ignored | The owner extracted the archive here. The repo keeps the delta and the scripts; the 700 MB payload is reproducible from a stock archive |
| User profile | Portable `data/` next to the executable | Isolated from the 1.126 install in `%APPDATA%\VSCodium`, reproducible, and disposable (delete `data/` for a clean editor) |
| Copilot and AI wiring | **Remove** | The product is pi-first; the Copilot wiring is dead weight and dead endpoints |
| Telemetry and Microsoft links | **Remove or repoint** | `agentsTelemetryAppName` and `voiceWsUrl` are live Microsoft endpoints; the `go.microsoft.com` fwlinks open Microsoft domains |
| Built-in extension set | **Keep all 95** | Owner's decision. The JS debugger trio and the Git/GitHub chain are functional, not Copilot |
| Locales | **Keep all 55** (48 MB) | Owner's decision |
| Agent surface | A new panel owned by PiCode, not a copy of the VS Code chat | Tracked as `odd/tasks/picode-agent-panel.md` |

## Verified facts that shaped this feature

Runtime and file evidence gathered on 2026-09-21 against this tree
(VSCodium `1.135.06055`, commit `1a46a584…`):

- **Portable mode is auto-detected in both entry points.** The same bundled
  function runs in `out/cli.js` and `out/main.js`: it returns
  `join(exeDir, "data")` on `win32`, sets `isPortable = existsSync(candidate)`,
  then assigns `process.env.VSCODE_PORTABLE = candidate`. That assignment is what
  makes `getUserDataPath` return `join(VSCODE_PORTABLE, "user-data")`. Portable
  mode is also disabled when a `target` option is present.
- **The user data path derives from the compiled-in `nameShort`**
  (`out/main.js`: `VSCODE_PORTABLE` → `join(i,"user-data")`, else `VSCODE_APPDATA`,
  else `user-data-dir`, else the platform default). Since the compiled product is
  now ours, patching `product.json` also moves the non-portable user data folder
  to `%APPDATA%\PiCode`.
- **The extensions directory is not the user data directory.** Non-portable, it
  is `<userHome>/<dataFolderName>/extensions`, and `dataFolderName` is
  `.vscode-oss`, so it is `%USERPROFILE%\.vscode-oss\extensions`. Portable, it is
  `data/extensions`. This is why `%APPDATA%\VSCodium\extensions` never existed.
- **No Copilot extension is bundled.** The "Copilot" layer is entirely product
  configuration plus core `chat`/`sessions` contributions.
- **`chat.disableAIFeatures` exists in the bundle**, so the AI surface can be
  switched off by setting, with no minified-JS patch.
- **Microsoft endpoints that were reachable from product configuration:**
  `voiceWsUrl` (`wss://falcon-caas.mai.microsoft.com/…`),
  `agentsTelemetryAppName`, `webviewContentExternalBaseUrlTemplate`
  (`vscode-cdn.net`), `checksumFailMoreInfoUrl`, `documentationUrl`,
  `introductoryVideosUrl`, `keyboardShortcutsUrl{Linux,Mac,Win}`,
  `releaseNotesUrl`, `requestFeatureUrl`, `tipsAndTricksUrl`, `twitterUrl`, and
  14 `api.github.com`/`aka.ms` endpoints under `defaultChatAgent`.
- **How the bundle consumes the keys being removed** (read from
  `out/vs/workbench/workbench.desktop.main.js` and `out/main.js`):
  - The Help-menu entries declare `AVAILABLE = !!product.<key>`, so **deleting**
    `tipsAndTricksUrl`, `introductoryVideosUrl`, `keyboardShortcutsUrl*`,
    `documentationUrl`, `requestFeatureUrl` or `checksumFailMoreInfoUrl` hides
    the entry instead of leaving it broken.
  - `releaseNotesUrl` is the exception: `showReleaseNotes` reads it and
    `throw`s when it is absent, so it is **repointed**, not deleted.
  - Empty `updateUrl` disables the updater permanently.
  - Voice resolves `agents.voice.backendUrl` first and falls back to
    `product.voiceWsUrl`, so deleting the key **and** clearing the setting fully
    removes the Microsoft WebSocket.
  - `trustedExtensionAuthAccess` is guarded with `?.` in all three consumers.
  - `webviewExternalEndpoint` is
    `options.webviewEndpoint || product.webviewContentExternalBaseUrlTemplate || <hardcoded vscode-cdn.net>`.
    The product key is only a fallback in front of a hardcoded CDN default, and
    the endpoint is the *external* one.

## Tasks

### 1. Fence the runtime tree from the versioned sources — DONE

- [x] `.gitignore` fences the VSCodium payload and `data/`
- [x] No tracked file is ignored, verified with `git ls-files | git check-ignore --stdin`

Commits: `a23e6ac` (fence), `ee78896` (feature records)

### 2. Write the PiCode delta and the apply script — DONE

- [x] `distribution/product-delta.json`: 11 keys set, 12 top-level keys removed,
      14 API-proposal entries and 2 version-gated entries pruned
- [x] `distribution/apply-product-delta.mjs`: applies the delta with Node, not
      with a PowerShell JSON round trip
- [x] `distribution/apply-picode.ps1`: preview by default, `-Apply`, timestamped
      backup, refuses to run outside a VSCodium root
- [x] `distribution/settings.json` extended with `chat.disableAIFeatures`,
      `agents.voice.enabled` and `agents.voice.backendUrl`

Commit: `06a1148`

### 3. Replace the ARM64 payload with an x64 build — DONE

The archive in the tree was the **Windows ARM64** build, on an **x64** machine
(Windows 11 Pro, build 26200). Every payload binary was `machine=0xaa64`, and
`VSCodium.exe --help` failed at the OS loader with "this version of … is not
compatible with the version of Windows you're running", before any PiCode code
ran. The mistake is worth recording: the archive was never checked for
architecture, and every file-level verification in task 2 passed on it anyway,
because none of that work depends on the target machine.

- [x] Read the PE machine type of the payload and of the system, and confirmed
      the mismatch instead of assuming a packaging failure
- [x] Downloaded `VSCodium-win32-x64-1.135.06055.zip` (250,898,961 bytes),
      extracted it outside the repository, and verified `VSCodium.exe`,
      `ffmpeg.dll` and `bin/codium-tunnel.exe` are `0x8664`
- [x] Confirmed the x64 `product.json` is byte-identical to the ARM64 one
      (`sha256 f60d692a…`), so the delta needed no change for the swap
- [x] Copied the staged tree over the payload root; `data/` survived

No commit: the payload is not versioned. The swapping is reproducible by
extracting an archive and running the apply script.

### 4. Apply, and verify branding and the portable profile — DONE

- [x] `bin/codium.cmd --help` prints `PiCode — Agentic Code Editor 1.135.06055`
- [x] `bin/codium.cmd --version` reports `1.135.06055`, the commit and `x64`
- [x] The applied `resources/app/product.json` is `sha256 d47983b5…`, identical
      to the file produced by the pre-verified copy
- [x] Portable mode is live: the GUI wrote its logs to
      `data/user-data/logs/20260921T161828`
- [x] Isolation: nothing was written under `%APPDATA%\PiCode` during this
      session (its newest entry is 2026-09-20 16:22, from the previous session),
      and `--list-extensions` reads `data/extensions`
- [x] The old overlay at `%APPDATA%\VSCodium\product.json` is out of play: the
      portable profile is resolved before it, and its `nameShort` no longer
      decides this tree's paths

### 5. Verify the removals at runtime — DONE, one defect found and fixed

- [x] **Defect found by running the build:** `--list-extensions` failed with
      `t.builtInExtensionsEnabledWithAutoUpdates is not iterable`. The extension
      service calls `.some()` on that product value without a guard, so the key
      must exist and be empty. Fixed by setting `[]` instead of deleting it.
- [x] `updateUrl: ""` observed in the running editor as
      `update#ctor - updates are disabled as there is no update URL`, which
      closes the hazard of the updater replacing the patched tree
- [x] `main.log` and `renderer.log` carry no errors or warnings
- [x] The residual is documented instead of hidden: the bundle keeps a hardcoded
      `code-oss` default that still names `GitHub.copilot`, so removing the
      product key removes the 14 endpoints but not that fallback. See ADR-011.
- [ ] **Not directly observed:** that the webview "pre" page is never requested
      from `vscode-cdn.net`. The product key is removed and the external endpoint
      needs an explicit payload flag, but the hardcoded fallback in minified core
      remains, and no network trace was captured.

Commit: `2779066`

### 6. Ship the pi panel as a built-in extension — DONE for the staging

- [x] `apply-picode.ps1` stages the built panel into
      `resources/app/extensions/picode-pi-chat`
- [x] What ships mirrors `.vscodeignore`: 9 files, no sources, toolchain, maps or
      packaging state
- [x] Stale files are removed, so a renamed module cannot leave old output behind
- [x] A second run reports the extension already current without writing
- [ ] **Human check required:** the Command Palette entry, and that no panel
      opens at startup (ADR-009). The CLI has no flag that lists built-in
      extensions, so this cannot be automated from here.

Commit: `daf2e83`

### 7. Record the decision — DONE

- [x] ADR-011 records owning the tree, and supersedes ADR-008 in part
- [x] ADR-008's status line annotated so the supersession is discoverable
- [x] `docs/DISTRIBUTION.md` carries a supersede banner naming which sections
      remain usable and which are historical

Commit: pending

### 8. Rewrite the operator documentation for the owned-tree path — DONE

- [x] `docs/DISTRIBUTION.md` rewritten end to end for the owned tree: the layers, the
      delta as data, the two findings that shaped it, the portable profile, the agent
      runtime, updating VSCodium, the verification checklist, the limits and the escape
      hatch
- [x] `docs/ARCHITECTURE.md` updated: layer 1 owns the tree, layer 3 documents the
      panel family and the module boundaries, the RPC contract carries what was verified
      this session, and the language policy is recorded
- [x] `README.md` first-run instructions reviewed against the new path

Commits: pending

## Open questions

- Which pi provider/model should PiCode ship as the first-run default? Still
  undecided; the bootstrap writes `picode.pi.defaultModel` empty.
- **Backups accumulate inside the editor tree.** Every apply writes
  `resources/app/product.json.picode-backup-<timestamp>` next to the target, and
  three now exist. A distribution should not ship its own backups. Either move
  them under `distribution/` or make the script keep only the newest.
- Whether to delete the 273 "Copilot" strings in `out/nls.messages.json`. They are
  inert UI strings with no endpoints; removing them means patching generated
  locale data for no functional gain.
- Whether PiCode should ship a PiCode-branded icon and welcome page, or keep
  VSCodium's.
- `data/` is correctly ignored, so a fresh clone has no profile until the apply
  script runs. Worth stating in the runbook rather than leaving as a surprise.
