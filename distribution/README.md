# PiCode distribution layer

Operator guide for `distribution/`. The strategy behind these files is in
[`docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md); this file is the short runbook.

PiCode's source lives in `picode-source/` and `dev/build.sh` compiles it. This folder
holds the **product identity as data**: the build (and CI, and the release workflow)
applies the delta to the source tree's `product.json`, and the staging step lays the
first-run defaults and the brand assets onto the packed output.

## Files

| File | Purpose |
| --- | --- |
| `product-delta.json` | The product change **as data**: `set`, `unset`, `unsetNested`, `unsetArrayEntries`. This is the file to edit when the product configuration must change. It also carries the release `version` — the one value that changes release to release. |
| `apply-product-delta.mjs` | Applies the delta to a target `product.json`. Node rather than PowerShell, because 5.1 caps `ConvertTo-Json` depth at 2 and escapes non-ASCII. Exit `0` already current, `1` needs update, `2` error. |
| `settings.json` | First-run defaults. Copied only when the user has no settings file of their own. |
| `runtime.json` | The pinned pi runtime version the editor ships (`dev/pi-runtime.sh` reads it). |
| `picode.ico` | The Windows icon; the Linux pack derives its PNG icons from it (`dev/ico-to-png.mjs`). The builder app reads it too. |
| `picode-icon.svg` / `picode.svg` | The brand marks the staging step lays onto the packed tree: the filled plate for icon surfaces, the strokes-only drawing for watermark surfaces. |

## How the build uses it

- Phase 1 of `dev/build.sh` applies `product-delta.json` to `picode-source/product.json`.
- Phase 5 (`dev/stage-distribution.sh`) stages `settings.json`, the icons and the marks
  onto the pack output (`./PiCode-Win32-x64`).
- The release workflow reads the version from `product-delta.json` before tagging.

## Publishing an update feed

The editor's updater reads a static JSON per platform, not the GitHub Releases API. After
`gh release create` uploads the asset, write that document and commit it:

```bash
node dev/update-feed.mjs --version <v> --commit <sha> --url <asset-url> \
  --sha256 <hex> --platform win32 --arch x64 --installed <previous-version>
```

The layout, the URL template and the version-numbering dependency are in
[`updates/README.md`](../updates/README.md).

## Changing the product

Edit `product-delta.json`; the build applies it. Two rules this file has already learned
the hard way, both by running the build rather than by reading the diff:

1. **A key the editor iterates must be emptied, not removed.** An absent array where
   the code calls `.some()` crashes at runtime.
2. **A nested object the editor dereferences must be pruned, not removed.** An absent
   object where the code reads a property produces a grey, blocked window.

`docs/DISTRIBUTION.md` section 3 carries both cases with their symptoms.

## Retired

- `bootstrap.ps1` branded a *separately installed* VSCodium through a
user-level overlay. That path could override product keys but never delete one, which is
why Copilot could not be removed through it. ADR-011 records the change, the owned-tree
path replaced it, and the retired script and its overlay remain in git history.
- `apply-picode.ps1` orchestrated the same owned-VSCodium-archive route: it derived its
root from its own location and could not be pointed at a source-build pack output. The
source build made it redundant — `dev/build.sh` applies the delta itself and
`dev/stage-distribution.sh` stages the layer onto the pack output. Removed 2026-09-29;
it remains in git history.
