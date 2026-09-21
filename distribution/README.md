# PiCode distribution layer (Windows)

Operator guide for `distribution/`. The strategy behind these files is in
[`docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md); this file is the short runbook.

PiCode does not compile the editor. It **owns a VSCodium tree** — the archive extracted
at the repository root — and applies a product delta to it.

## Files

| File | Purpose |
| --- | --- |
| `product-delta.json` | The product change **as data**: `set`, `unset`, `unsetNested`, `unsetArrayEntries`. This is the file to edit when the product configuration must change. |
| `apply-product-delta.mjs` | Applies the delta to a target `product.json`. Node rather than PowerShell, because 5.1 caps `ConvertTo-Json` depth at 2 and escapes non-ASCII. Exit `0` already current, `1` needs update, `2` error. |
| `apply-picode.ps1` | The orchestrator: product delta, portable profile, first-run defaults, and staging the panel as a built-in extension. Preview by default; `-Apply` writes. |
| `settings.json` | First-run defaults. Copied only when the user has no settings file of their own. |

The pinned pi version lives in `extensions/picode-pi-chat/runtime.json` rather than
here, because it ships with the extension that uses it.

## Running it

```powershell
powershell -File distribution/apply-picode.ps1           # preview: prints what it would do
powershell -File distribution/apply-picode.ps1 -Apply    # write
```

It is idempotent, refuses to run outside a VSCodium root, and backs up
`resources/app/product.json` with a timestamped name before the first write.

## What it touches when `-Apply` is passed

- `resources/app/product.json` — the product delta, after a backup
- `resources/app/extensions/picode-pi-chat/` — the panel, staged as a built-in extension
- `data/user-data/`, `data/extensions/`, `data/tmp/` — the portable profile
- `data/user-data/User/settings.json` — only created if it does not exist

## Changing the product

Edit `product-delta.json` and run the script. Two rules this file has already learned
the hard way, both by running the build rather than by reading the diff:

1. **A key the editor iterates must be emptied, not removed.** An absent array where
   the code calls `.some()` crashes at runtime.
2. **A nested object the editor dereferences must be pruned, not removed.** An absent
   object where the code reads a property produces a grey, blocked window.

`docs/DISTRIBUTION.md` section 3 carries both cases with their symptoms.

## Retired

An earlier `bootstrap.ps1` branded a *separately installed* VSCodium through a
user-level overlay. That path could override product keys but never delete one, which is
why Copilot could not be removed through it. ADR-011 records the change, the owned-tree
path replaced it, and the retired script and its overlay remain in git history.
