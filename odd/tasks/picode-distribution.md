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

The product owner has now downloaded and extracted the VSCodium archive into this
repository, so PiCode owns the tree. That removes the limit and makes the
following possible without compiling anything:

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
| Where the distribution lives | This repository root **is** the PiCode distribution; the modification layer is versioned, the binary payload is ignored | The owner extracted the archive here. The repo keeps the delta and the scripts; the 707 MB payload is reproducible from a stock archive |
| User profile | Portable `data/` next to the executable | Isolated from the 1.126 install in `%APPDATA%\VSCodium`, reproducible, and disposable (delete `data/` for a clean editor) |
| Copilot and AI wiring | **Remove** | The product is pi-first; the Copilot wiring is dead weight and dead endpoints |
| Telemetry and Microsoft links | **Remove or repoint** | `agentsTelemetryAppName` and `voiceWsUrl` are live Microsoft endpoints; the `go.microsoft.com` fwlinks open Microsoft domains |
| Built-in extension set | **Keep all 95** | Owner's decision. The JS debugger trio and the Git/GitHub chain are functional, not Copilot |
| Locales | **Keep all 55** (48 MB) | Owner's decision |
| Agent surface | A new panel owned by PiCode, not a copy of the VS Code chat | Tracked as `odd/tasks/picode-agent-panel.md` |

## Verified facts that shaped this feature

Runtime and file evidence gathered on 2026-09-21 against this tree
(VSCodium `1.135.06055`, commit `1a46a584…`):

- **Portable mode is auto-detected.** `resources/app/out/cli.js` resolves
  `portableDataPath = join(<exeDir>, "data")` on `win32` and sets
  `isPortable = existsSync(portableDataPath)`, redirecting `TMP`/`TEMP` into
  `data/tmp`. No environment variable is required.
- **The user data path derives from the compiled-in `nameShort`**
  (`out/main.js`: `process.env.VSCODE_PORTABLE` → `join(i,"user-data")`,
  else `VSCODE_APPDATA`, else `user-data-dir`, else the platform default). The
  overlay path limitation in the foundation's `DISTRIBUTION.md` therefore
  disappears when the tree is owned: the compiled product is ours.
- **No Copilot extension is bundled.** The "Copilot" layer is entirely product
  configuration plus core `chat`/`sessions` contributions.
- **`chat.disableAIFeatures` exists in the bundle**
  (`out/vs/workbench/workbench.desktop.main.js`, `out/vs/sessions/…`), so the AI
  surface can be switched off by setting, with no minified-JS patch.
- **Microsoft endpoints still reachable from product configuration:**
  `voiceWsUrl` (`wss://falcon-caas.mai.microsoft.com/…`),
  `agentsTelemetryAppName`, `webviewContentExternalBaseUrlTemplate`
  (`vscode-cdn.net`), `checksumFailMoreInfoUrl`, `documentationUrl`,
  `introductoryVideosUrl`, `keyboardShortcutsUrl{Linux,Mac,Win}`,
  `releaseNotesUrl`, `requestFeatureUrl`, `tipsAndTricksUrl`, `twitterUrl`, and
  14 `api.github.com`/`aka.ms` endpoints under `defaultChatAgent`.
- **`updateUrl`/`downloadUrl` point at VSCodium releases.** Left as is, the
  product's own updater would offer a VSCodium archive that would replace the
  patched tree and silently drop the PiCode brand.

## Tasks

### 1. Restore the sources and fence the binary payload

- [ ] `.gitignore` fences the VSCodium payload and `data/`
- [ ] `git status` reports no tracked file deleted and no payload staged

Already done outside the task: `git checkout -- .` restored `docs/`,
`distribution/`, `extensions/` and `odd/`, which the archive extraction had
removed from the working tree.

Commit: pending

### 2. Establish the portable PiCode profile

- [ ] `data/` created by the apply script (`user-data`, `extensions`, `tmp`)
- [ ] Portable mode confirmed at runtime: the CLI resolved its extensions
      directory to `data/extensions`, and `data/tmp` was created
- [ ] Isolation from `%APPDATA%\VSCodium` (the 1.126 install) confirmed

Commit: pending

### 3. Rebrand the shipped `product.json`

- [ ] `nameShort`, `nameLong`, `urlProtocol`, `extensionsGallery` rewritten in
      `resources/app/product.json`
- [ ] `VSCodium.exe --help` prints the PiCode `nameLong` (runtime evidence)

Commit: pending

### 4. Delete the Copilot, telemetry and Microsoft-link wiring

- [ ] Removed: `defaultChatAgent`, `trustedExtensionAuthAccess`,
      `builtInExtensionsEnabledWithAutoUpdates`, `agentsTelemetryAppName`,
      `voiceWsUrl`, `webviewContentExternalBaseUrlTemplate`
- [ ] Pruned the Copilot/AI entries from `extensionEnabledApiProposals` and
      `extensionsEnabledWithApiProposalVersion`
- [ ] Repointed or removed the `go.microsoft.com` fwlinks
- [ ] Disabled the in-product updater so a VSCodium archive cannot silently
      replace the patched tree
- [ ] `chat.disableAIFeatures: true` in the default settings

Commit: pending

### 5. Ship the pi panel as a built-in extension

- [ ] The built extension is staged into
      `resources/app/extensions/picode-pi-chat`
- [ ] The editor loads it as a built-in extension (runtime evidence)

Commit: pending

### 6. Make the distribution reproducible: `distribution/apply-picode.ps1`

- [ ] The product delta is data (`distribution/product-delta.json`), not prose
- [ ] The script is idempotent, preview-by-default and backs up before writing
- [ ] A stock VSCodium archive plus this script reproduces the PiCode tree

Commit: pending

### 7. Documentation, decisions and verification

- [ ] ADR-011 records owning the distribution tree and supersedes ADR-008's
      file-touching prohibition, with its reversal trigger
- [ ] `docs/DISTRIBUTION.md` rewritten for the owned-tree path
- [ ] `docs/ARCHITECTURE.md` layer 1 updated
- [ ] End-to-end runtime verification, with the still-open checks listed

Commit: pending

## Open questions

- Which pi provider/model should PiCode ship as the first-run default? Still
  undecided; the bootstrap writes `picode.pi.defaultModel` empty.
- Whether to delete the 273 "Copilot" strings in `out/nls.messages.json`. They are
  inert UI strings with no endpoints; removing them means patching generated
  locale data for no functional gain.
- Whether PiCode should ship a PiCode-branded icon and welcome page, or keep
  VSCodium's. Not part of this feature.
