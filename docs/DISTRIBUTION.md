# 📦 PiCode distribution (Windows)

Status: **current**, revised 2026-10-09. This document describes how PiCode is built and
distributed **today**: a Windows installer and a portable zip, compiled from PiCode's own
source tree and offered on three release channels.

It replaces an earlier version that described branding a *separately installed* VSCodium
through a user-level overlay, and a second one that described an uncompiled tree branded
after extraction. Those paths are ADR-008 and ADR-011; both are superseded by
[ADR-013](DECISIONS.md), and their text stays in git history.

Conventions: **verified** means a repository file, an upstream file, or a read-only probe;
**measured** means executed on this machine and observed.

## 📦 1. What PiCode is on this path

PiCode is **an editor compiled from its own source tree**:

- `picode-source/` is the source, versioned in this repository — the VSCodium changes,
  PiCode's own work and the product identity already baked in. Nothing is fetched or patched
  on a build.
- `distribution/product-delta.json` is the product **as data**, applied to
  `picode-source/product.json` **before** packing, so the compiled editor and the released one
  cannot disagree.
- `dev/build.sh` is the five-phase build: prepare (source check, identity, dependencies),
  connector, compile, pack, stage.

Because the product is applied before compiling, keys can be **deleted**, not only overridden,
and the `checksums` map is computed over the finished product — the limit that made a minified
bundle untouchable on the old binary path no longer exists here. A behaviour change is
TypeScript in the tree, compiled.

## 🧱 2. The layers

| # | Layer | Artifact | Applied by |
| --- | --- | --- | --- |
| 1 | Editor | `picode-source/`, compiled by `dev/build.sh` | the build |
| 2 | Product delta | `distribution/product-delta.json` → `picode-source/product.json` | `distribution/apply-product-delta.mjs`, phase 1 |
| 3 | Portable profile | `data/{user-data,extensions,tmp}` | `dev/stage-distribution.sh` |
| 4 | Defaults | `distribution/settings.json` → `data/user-data/User/settings.json` | `dev/stage-distribution.sh`, only when absent |
| 5 | Agent runtime | pi, pinned in `distribution/runtime.json` | `dev/pi-runtime.sh` |
| 6 | Durable agent (experimental) | `experimental/durable` → `resources/pi-durable` | `dev/durable-runtime.sh` |

Staging is `dev/stage-distribution.sh [pack-dir]`, default `./PiCode-Win32-x64`. It is
idempotent — a second run reports every step as already current. The retired
`apply-picode.ps1` did the same against an owned VSCodium archive; it was removed on
2026-09-29 and remains in git history.

The extension-era agent panel is gone: the `extensions/` folder was deleted on 2026-09-27 by
the owner's decision ("pi lives in the core"), and the panel returns as core code.

## 🎛️ 3. The product delta

The delta is **data**, and the mechanism is a script. Four sections: `set`, `unset`,
`unsetNested`, `unsetArrayEntries`. It is applied by a Node program because Windows
PowerShell 5.1 caps `ConvertTo-Json` depth at 2 and escapes non-ASCII, which would corrupt a
77-key product carrying an 8 KB nested object.

It is the single home of the product identity and of **both version numbers** — the declared
editor version (`set.version`, the one extensions validate against) and PiCode's own
(`set.picodeVersion`, what the updater shows). See ADR-016 for why the declared version may
lead the tree's upstream base.

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
product key cannot remove it, because it lives in minified core. `chat.disableAIFeatures` is
the effective switch for the surface.

## 🗂️ 4. The portable profile

`data/` beside the executable. Measured: the GUI wrote its logs to
`data/user-data/logs/<stamp>` and nothing was written under `%APPDATA%`.

Two paths are easy to confuse, so both are stated: the **user data** directory is
`data/user-data`, and the **extensions** directory is `data/extensions`. Non-portable,
extensions live in `<userHome>/<dataFolderName>/extensions`.

The profile is disposable by design: deleting `data/` yields a clean PiCode. It is also the
unit the paid cloud sync is meant to move as one block (see `cloud/sync-api/`), never a
per-setting copy.

## 🤖 5. The agent runtime

pi is **pinned in one place**, `distribution/runtime.json` (pi **1.1.0** today), and
`dev/pi-runtime.sh` installs it into the pack during the build, so a freshly built editor is
born working and nobody has to install or configure it.

It is **used as an in-process SDK** by the connector (ADR-014: `createAgentSessionServices` /
`createAgentSessionFromServices`, loaded at runtime), not as a CLI or over RPC. The CLI of the
active runtime covers what the SDK does not expose — package management. The pin is not a
lock-in: `picode.pi.runtime` lets a user choose a different pi.

On the `experimental` branch, `dev/durable-runtime.sh` additionally stages the durable agent
(`experimental/durable`) and the chat's bridge into `resources/pi-durable`; its own
dependencies travel with it (~116 MB) and nothing else does — no proofs, no `.data/`, no
credentials. The proof log is `experimental/durable/README.md`.

## ⬆️ 6. Updating VS Code

A newer VS Code is a **merge against `picode-source/`**, not a download: see
[`howto-build.md`](howto-build.md). There is no archive to extract and no script to re-run —
the tree is the source, and the identity is applied by the build.

The pin `upstream/stable.json` records where the tree descends from (VS Code 1.135.0) and is
reviewed **by hand** — there is no automated pin watcher ([`CI.md`](CI.md) records that).

**Read the machine type of a reference archive before building on it.** The first archive here
was the Windows **ARM64** build on an x64 machine: every binary was `0xaa64` and the editor
failed at the OS loader before any PiCode code ran. Usefully, the x64 and ARM64 `product.json`
are byte-identical, so an architecture swap does not change the delta.

## 📡 7. The update feed

The editor's updater reads a **static JSON document** per platform from this repository's
channel branch, not the GitHub Releases API. `dev/build.sh` seals the channel into
`product.json` (`quality`) and rewrites the `updateUrl` branch; `dev/update-feed.mjs` writes
the document after a release. The layout, the URL template, the two Windows feeds (portable
zip vs installed setup) and the version-numbering rules live in
[`updates/README.md`](../updates/README.md); the channel policy is ADR-015.

There is no update server to run: `raw.githubusercontent.com` serves the files directly.

## ✅ 8. Verification

Machine-checkable, in the order that catches the most:

| What | How |
| --- | --- |
| Source and identity | `./dev/build.sh -o` — seconds, nothing installed or compiled |
| Branding | `bin/picode.cmd --help` prints `PiCode — Agentic Code Editor <version>` and a usage line reading `picode.exe` |
| Icons | the window and task bar show the PiCode mark, and the left bar shows `media/picode.svg` |
| Portable profile | the newest log directory is under `data/user-data/logs/`, and `%APPDATA%` is untouched |
| Extension activated | `_doActivateExtension picode.picode` in `window1/exthost/exthost.log` |
| Runtime in use | the PiCode output channel prints `[pi] starting from <mode> runtime: <path>` |
| No renderer errors | no `Uncaught` or `TypeError` with `ELECTRON_ENABLE_LOGGING=1` |
| Connector logic | `node --test picode-source/extensions/picode/test/*.test.ts` — the connector's hermetic suites, no editor needed |
| MCP entries pi accepts | `node dev/check-mcp-entries.mjs` — through pi's own validator |
| Update feed | the release workflow fetches it from `raw.githubusercontent.com` until it is live |
| Protocol and CLI | nothing automated: a login or an MCP sign-in is exercised by hand and recorded in `odd/tasks/` |

A view cannot be opened from the command line, and `onView:` activation is invisible until one
is shown, so an end-to-end check of a view needs a **temporary built-in extension** that focuses
it. That technique is recorded here because it is how the status view was verified.

## 🚦 9. The release channels

One branch per channel; the feed lives on the channel's own branch (ADR-015):

| Channel | Branch | Feed |
| --- | --- | --- |
| **Stable** | `master` | `updates/stable/win32/x64/<target>/latest.json` |
| **Beta** | `beta` | `updates/beta/win32/x64/<target>/latest.json` |
| **Experimental** | `experimental` | `updates/experimental/win32/x64/<target>/latest.json` |

Each channel installs **beside** the others: its own folder, its own profile and its own
AppId, so removing one leaves the rest untouched. The per-channel release notes are in
[`dev/release-notes/`](../dev/release-notes/).

## 🏷️ 10. What is PiCode's, and what is not

The **names** are PiCode's: `PiCode.exe`, the `bin/picode*` shims, the window title, the About
dialog, the CLI's own usage line and the release assets. The Windows installer also carries
PiCode's folder, Start Menu shortcut and Add/Remove Programs name.

What is still not PiCode's: the **VS Code lineage**, which stays visible in the licence files
and the `out/` bundle. Those are also where the names VSCodium and VS Code must keep appearing,
because they are the upstream base and pretending otherwise would be false.

### ⚖️ Attribution and licence

PiCode is an independent distribution of the MIT-licensed VS Code source, carrying the
VSCodium change set. Upstream licences and notices ship with the editor and must never be
removed; the repository's own licence is [`LICENSE`](../LICENSE). Microsoft's source is
published here under that licence, and it is the owner who decides where this repository is
published ([`CONTRIBUTING.md`](../CONTRIBUTING.md)).

### 🖼️ The icon in the executable

The Windows icon is decided **at pack time** — `build/lib/electron.ts` declares
`winIcon: 'resources/win32/code.ico'` and the Windows pack applies it with `rcedit`, so
replacing a copy afterwards changes nothing. The branded file is committed in the tree
(`picode-source/resources/win32/`); change it there and pack again. Verified by parsing the PE
resource directory: the seven frames of `distribution/picode.ico` (16–256) are present in
`PiCode.exe` byte for byte. Measure it that way: `System.Drawing.Icon` cannot read
`picode.ico` (its frames are PNG-compressed) and `ExtractAssociatedIcon` returns a rescaled
bitmap, so both compare "different" against a correct icon.

### ⚠️ Two traps in using a 1024 px mark in an editor

- VS Code **masks** an activity bar icon: it uses the shape as a stencil and paints it
  with the theme's colour. A mark whose background is an opaque square therefore renders
  as a solid square. The sidebar variant is the same mark with the background removed.
- A mark drawn for 1024 px does not survive 16-24 px: on this one the antenna and the
  eyes measure about half a pixel. The sidebar variant thickens the strokes and enlarges
  the dots, keeping the shape and changing only what had to change. The full-colour mark
  is kept beside it, untouched, for every use that has room for it.

## 🚫 11. Non-goals

- Patching a minified core: changes are made in the source tree and compiled.
- A custom language server for pi.
- Shipping weight without a user-facing reason: a folder under `picode-source/extensions/`
  needs a justification to exist (the lightweight cut is doctrine — see
  `odd/tasks/lightweight-picode-source.md`).
- Reimplementing what pi already brings: providers, OAuth, skills and the orchestrator are
  pi's, and PiCode teaches them to the editor.
