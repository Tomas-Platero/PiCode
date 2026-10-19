# 📦 The distribution layer

Operator guide for `build/distribution/`. The strategy behind these files is in
[`docs/DISTRIBUTION.md`](../../docs/DISTRIBUTION.md); this file is the short runbook.

PiCode's source lives at the repository root and `build/build.sh` compiles it. This folder
holds what the product needs **as data** — the pinned runtime, the first-run defaults and the
brand art. The identity itself lives in `product.json` at the tree root, committed, and the
staging step lays the defaults and the marks onto the packed output.

## 🗂️ Files

| File | Purpose |
| --- | --- |
| `settings.json` | First-run defaults. Copied only when the user has no settings file of their own. |
| `runtime.json` | The pinned pi runtime version the editor ships (`build/pi-runtime.sh` reads it). |
| `picode.ico` | The Windows icon the packer reads; `build/build.sh` fails in phase 1 if it is missing. |
| `picode-icon.svg` / `picode.svg` | The brand marks the staging step lays onto the packed tree: the filled plate for icon surfaces, the strokes-only drawing for watermark surfaces. |

## 🔗 How the build uses it

- Phase 1 of `build/build.sh` checks the tree is PiCode's: the identity in `product.json`,
  the Windows icon here, the server manifest and the connector.
- Phase 5 (`build/stage-distribution.sh`) stages `settings.json`, the icons and the marks
  onto the pack output (`./PiCode-Win32-x64`).
- The release workflow reads the version from `product.json` before tagging.

## 📡 Publishing an update feed

The editor's updater reads a static JSON per platform, not the GitHub Releases API. After
`gh release create` uploads the asset, write that document and commit it:

```bash
node build/release.mjs update-feed --version <v> --commit <sha> --url <asset-url> \
  --sha256 <hex> --platform win32 --arch x64 --installed <previous-version>
```

The layout, the URL template and the version-numbering dependency are in
[`updates/README.md`](../../updates/README.md).

## 🎛️ Changing the product

Edit `product.json` at the tree root. Two rules that file has already learned
the hard way, both by running the build rather than by reading it:

1. **A key the editor iterates must be emptied, not removed.** An absent array where
   the code calls `.some()` crashes at runtime — `builtInExtensionsEnabledWithAutoUpdates`
   is carried as `[]` for exactly that reason.
2. **A nested object the editor dereferences must be pruned, not removed.** An absent
   object where the code reads a property produces a grey, blocked window — the
   `defaultChatAgent` endpoints are dropped key by key for exactly that reason.

[`docs/DISTRIBUTION.md`](../../docs/DISTRIBUTION.md) section 3 carries both cases with their
symptoms.

## 🗄️ Retired

- `bootstrap.ps1` branded a *separately installed* VSCodium through a
user-level overlay. That path could override product keys but never delete one, which is
why Copilot could not be removed through it. ADR-011 records the change, the owned-tree
path replaced it, and the retired script and its overlay remain in git history.
- `apply-picode.ps1` orchestrated the same owned-VSCodium-archive route: it derived its
root from its own location and could not be pointed at a source-build pack output. The
source build made it redundant — `build/build.sh` owns the identity and
`build/stage-distribution.sh` stages the layer onto the pack output. Removed 2026-09-29;
it remains in git history.
