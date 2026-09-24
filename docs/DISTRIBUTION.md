# PiCode distribution (Windows)

Status: **current**. This document describes how PiCode is distributed today. It
replaces an earlier version that described branding a *separately installed* VSCodium
through a user-level overlay; that approach is recorded as ADR-008, superseded in part
by ADR-011, and its full text remains in git history.

Conventions: **verified** means a repository file, an upstream file, or a read-only
probe; **measured** means executed on this machine and observed.

> **Note (2026-09-23) — the source path.** There is also a path that compiles PiCode from the
> VS Code source with VSCodium's model (`docs/howto-build.md`). It is **additive**: this
> document keeps describing the binary/ZIP path unchanged, which is the one that is
> published and the one someone uses when they only want to use PiCode. The source path does
> lift the "minified core" limit of section 3: there the product is applied *before*
> compiling.

## 1. What PiCode is on this path

PiCode **owns its editor tree**. The VSCodium archive is extracted at the repository
root, which is what makes the following true:

- `resources/app/product.json` is editable, so product keys can be **deleted**, not
  only overridden;
- `resources/app/extensions/` is the built-in extension scan path, so the panel ships
  as a built-in extension with no install step;
- a `data/` folder beside the executable switches the build to portable mode;
- the **file names** can be changed, so the visible identity is PiCode's: `PiCode.exe`,
  `bin/picode*`, and the Start Menu tile manifest.

No compiler, no fork, no patch rebasing against upstream. The 1 GB payload is
ingored by git — it cannot be committed: GitHub refuses a push carrying a file over
100 MB and the editor's executable alone is 212 MB, so versioning this tree would need
Git LFS (free quota 1 GB, smaller than the payload) or an archive published as a release
asset. The repository version tracks the modification layer.

### Why not the overlay

The overlay is merged as `merge(product, userProduct)`: it can override a key but
never delete one. Copilot could be restated there, not removed. The measured
consequence is the reason this path exists: `defaultChatAgent` is only removable from
the tree itself.

## 2. The layers

| # | Layer | Artifact | Applied by |
| --- | --- | --- | --- |
| 1 | Editor | the VSCodium archive, extracted at the root | the operator |
| 2 | Product delta | `distribution/product-delta.json` | `apply-product-delta.mjs`, orchestrated by `apply-picode.ps1` |
| 3 | Portable profile | `data/{user-data,extensions,tmp}` | `apply-picode.ps1` |
| 4 | Agent panel | `extensions/picode-pi-chat` staged into `resources/app/extensions/` | `apply-picode.ps1` |
| 5 | Defaults | `distribution/settings.json` → `data/user-data/User/settings.json` | `apply-picode.ps1`, only when absent |
| 6 | Agent runtime | a pi per `picode.pi.runtime`; PiCode's own installed on demand | the panel |

`powershell -File distribution/apply-picode.ps1` previews; `-Apply` writes. It is
idempotent, refuses to run outside a VSCodium root, and backs the product file up
before the first write.

## 3. The product delta

The delta is **data**, and the mechanism is a script. Four sections: `set`, `unset`,
`unsetNested`, `unsetArrayEntries`. It is applied by a Node program because Windows
PowerShell 5.1 caps `ConvertTo-Json` depth at 2 and escapes non-ASCII, which would
corrupt a 77-key product carrying an 8 KB nested object.

Current contents: 11 keys set, 12 removed, 14 entries pruned from
`extensionEnabledApiProposals`, 2 from `extensionsEnabledWithApiProposalVersion`.

**Two findings shaped it, and both came from running the build rather than reading the
diff.** They are the first thing to read before changing the delta:

1. **A key that is iterated must be empty, not absent.** The extension service calls
   `.some()` on `builtInExtensionsEnabledWithAutoUpdates` without a guard; deleting the
   key crashed `--list-extensions` with `is not iterable`.
2. **A nested object that is dereferenced must be pruned, not deleted.**
   `defaultChatAgent` is read without a guard in a startup path; deleting it produced a
   grey, blocked window with `Cannot read properties of undefined (reading
   'chatExtensionId')`. Its fourteen endpoint keys are removed individually, which
   removes every `api.github.com` and `aka.ms` endpoint while keeping the shape.

Both states are valid JSON, which is why neither is visible in review.

**Residual, documented rather than hidden.** The bundle carries a hardcoded `code-oss`
default product that still declares `defaultChatAgent: GitHub.copilot`; deleting the
product key cannot remove it, because it lives in minified core.
`chat.disableAIFeatures` is the effective switch for the surface.

**Minified core is not patchable on this path.** `product.json` carries a `checksums`
map over ten bundle files, so editing the bundle would break the integrity check. A
change that must happen inside core is a fork, not a patch.

> **Note:** this holds for the binary path. On the **source path**
> (`docs/howto-build.md`) the limit does not exist: the TypeScript is patched before
> compiling and the `checksums` are computed over the finished product.

## 4. The portable profile

`data/` beside the executable. Measured: the GUI wrote its logs to
`data/user-data/logs/<stamp>` and nothing was written under `%APPDATA%`.

Two paths are easy to confuse, so both are stated: the **user data** directory is
`data/user-data`, and the **extensions** directory is `data/extensions`. Non-portable,
extensions live in `<userHome>/<dataFolderName>/extensions` — `.vscode-oss` — which is
not the user data directory and never was.

The profile is disposable by design: deleting `data/` yields a clean PiCode.

## 5. The panel as a built-in extension

Because the tree is owned, the panel needs no VSIX and no install step: the script
stages the built extension into `resources/app/extensions/picode-pi-chat`. What ships
mirrors `.vscodeignore` — no sources, toolchain, maps, tests or packaging state — and
files no longer in the build are removed, so a renamed module cannot leave its old
output behind for the editor to keep loading.

## 6. The agent runtime

`picode.pi.runtime` is `path` (default: the pi on PATH), `managed` (PiCode's own,
version pinned in `extensions/picode-pi-chat/runtime.json`), or `custom`.

The managed runtime is **installed on demand, never shipped in the archive**, and the
measured numbers are the reason: the package's `dist/` is 20 MB but is **not**
self-contained (running it without `node_modules` fails with `Cannot find package
'@earendil-works/chord'`), while a clean `--omit=dev` install is 410 MB, of which
284 MB is multi-platform `@esbuild`. It installs into `resources/pi-runtime` and is
invoked as `node <bundle>/cli.js` rather than through the npm `.cmd` shim, because Node
cannot execute a `.cmd` without a shell since the CVE-2024-27980 hardening, and a shell
would couple it to quoting rules for wherever the distribution was unpacked.

## 7. Updating VSCodium

1. Extract the new archive over the root, or into a staging directory and copy.
2. Run `apply-picode.ps1 -Apply`.
3. Re-run the checks in section 8.

The in-product updater is disabled (`updateUrl` is empty) so a VSCodium archive cannot
silently replace the patched tree. Measured in the running editor as
`updates are disabled as there is no update URL`.

**Read the machine type of an archive before building on it.** The first archive here
was the Windows **ARM64** build on an x64 machine: every binary was `0xaa64` and the
editor failed at the OS loader before any PiCode code ran, with nothing in the
repository to indicate why. Usefully, the x64 and ARM64 `product.json` are byte-identical,
so an architecture swap does not change the delta.

## 8. Verification

Machine-checkable, in the order that catches the most:

| What | How |
| --- | --- |
| Branding | `bin/picode.cmd --help` prints `PiCode — Agentic Code Editor <version>` and a usage line reading `picode.exe` |
| Icons | the window and task bar show the PiCode mark, and the left bar shows `media/picode.svg` |
| Portable profile | the newest log directory is under `data/user-data/logs/`, and `%APPDATA%` is untouched |
| Extension activated | `_doActivateExtension picode.picode-pi-chat` in `window1/exthost/exthost.log` |
| Runtime in use | the PiCode output channel prints `[pi] starting from <mode> runtime: <path>` |
| No renderer errors | no `Uncaught` or `TypeError` with `ELECTRON_ENABLE_LOGGING=1` |
| Panel logic | `npm test` in the extension: seven hermetic suites |
| Protocol and CLI | `npm run test:live`: needs a real `pi` on PATH, and a real `gentle-ai` for the gentle checks |

A view cannot be opened from the command line, and `onView:` activation is invisible
until one is shown, so an end-to-end check of a view needs a **temporary built-in
extension** that focuses it. That technique is recorded here because it is how the
panel, the popup and the launcher were verified; it is also how the editor's saved
layout can be steered to leave the chat in front.

## 9. What this path does not give you

The **names** are PiCode's. The executable is `PiCode.exe`, the CLI shims are
`bin/picode*`, the window title, the About dialog and even the CLI's own usage line say
PiCode, and the Start Menu tile manifest was renamed with them. Renaming files is part of
Step 5 of the apply script, so extracting a newer VSCodium archive does not bring the old
name back.

What is still not PiCode's:

- **the OS-level identity of an installed VSCodium** — Start Menu entry, Add/Remove
  Programs entry, registered protocol handler, registry keys, installer GUIDs — because
  PiCode runs from a folder rather than being installed;
- **the VS Code lineage**, which stays visible in the licence files and the `out/`
  bundle. Those are also the places where the name VSCodium must keep appearing, because
  it is the upstream base and documentation saying otherwise would simply be false.

### The icon in the executable

The previous version of this document listed the executable's icon as out of reach. It is
not: the icon is a PE resource, and `rcedit` — the tool Electron itself uses when
packaging — rewrites it with one command. What made it safe here is that `PiCode.exe` is
**unsigned** (`Get-AuthenticodeSignature` reports `NotSigned`), so there is no signature
to invalidate. Had it been signed, a single changed byte would have broken it.

```powershell
rcedit PiCode.exe --set-icon distribution/picode.ico
```

The `.ico` is a repository artefact built from the 1024 px mark in seven sizes (16 to
256), so it reads in the task bar and in a large icon view alike. This step is documented
rather than automated because it needs a third-party binary that the distribution should
not start carrying; re-run it after extracting a newer VSCodium archive. Explorer caches
icons, so it may keep showing the old one until the cache refreshes — that is not a
failed change.

### Two traps in using a 1024 px mark in an editor

- VS Code **masks** an activity bar icon: it uses the shape as a stencil and paints it
  with the theme's colour. A mark whose background is an opaque square therefore renders
  as a solid square. The sidebar variant is the same mark with the background removed.
- A mark drawn for 1024 px does not survive 16-24 px: on this one the antenna and the
  eyes measure about half a pixel. The sidebar variant thickens the strokes and enlarges
  the dots, keeping the shape and changing only what had to change. The full-colour mark
  is kept beside it, untouched, for every use that has room for it.

## 10. The escape hatch

The fork path is **deferred, not rejected**. It becomes worth revisiting when any of
these holds:

1. a required product key is read before the overlay merge, or lies outside
   `product.json`'s reach;
2. the distribution must have PiCode OS-level identity (installer, Start Menu, protocol
   handler, file associations);
3. the VSCodium archive layout moves the product file or the built-in extension scan
   path;
4. a required change must happen **inside minified core**, which the `checksums` map
   makes unavailable on this path.

Toolchain gaps measured on this machine (2026-09-20) against VSCodium's documented
prerequisites: `jq` missing, Python 3.11 missing (3.14.7 present), `rustup`/`cargo`
missing, MSVC Build Tools effectively absent (the 2022 directories are empty, there is
no `vswhere.exe`, no `cl`, no Windows SDK), Node `24.19.0` against the pinned `24.18.0`,
and 7-Zip present but not on PATH. Every one is an install away except the version pins,
which want a toolchain isolated from the daily one. That is a half-day of environment
work plus a first build, against a 30-90 minute cycle per iteration.
