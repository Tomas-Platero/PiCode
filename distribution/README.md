# PiCode distribution layer (Windows)

Operator guide for `distribution/`. The strategy behind these files is in
[`docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md); this file is the short
runbook.

PiCode does not compile the editor. It layers branding, the agent runtime, the
extension and defaults on top of an existing VSCodium install.

## Files

| File | Purpose |
| --- | --- |
| `product.json` | User-level branding overlay, deep-merged into VSCodium's product configuration at startup. Strict JSON: no comments, no trailing commas. |
| `settings.json` | Default editor settings shipped by PiCode. Strict JSON. Applied only when the user has no settings file yet. |
| `bootstrap.ps1` | Applies the layers. Idempotent, preview-by-default, no admin required. |

## Layer order

| # | Layer | Applied by |
| --- | --- | --- |
| 1 | VSCodium (the editor) | the user, or `winget install VSCodium.VSCodium` (the script only prints this command) |
| 2 | Branding overlay | `bootstrap.ps1 -Apply` copies `product.json` into the VSCodium user data directory, backing up any existing file |
| 3 | Agent runtime | `bootstrap.ps1 -Apply` installs pinned `pi` (npm global) and pinned `gentle-pi` (`pi install`) |
| 4 | `picode-pi-chat` extension | `bootstrap.ps1 -Apply` installs the packaged VSIX with `codium --install-extension` |
| 5 | Default settings | `bootstrap.ps1 -Apply` writes `settings.json` only if the user has none |

## Preview versus apply

Preview is the default and performs only read-only probes. Nothing is written.

```powershell
# Preview: prints every action, changes nothing
powershell -NoProfile -File distribution/bootstrap.ps1

# Same preview, explicitly
powershell -NoProfile -File distribution/bootstrap.ps1 -DryRun

# Apply the changes
powershell -NoProfile -File distribution/bootstrap.ps1 -Apply
```

`-DryRun` and PowerShell's standard `-WhatIf` both force preview even when
`-Apply` is present. The script never requires administrator rights: every path
it writes is under `%APPDATA%`, `%USERPROFILE%` or the current npm global prefix.

## What `-Apply` touches

- `%APPDATA%\VSCodium\product.json` — the branding overlay, with a timestamped
  `product.json.picode-backup-<yyyyMMdd-HHmmss>` beside it.
- The npm global prefix — `npm install -g @earendil-works/pi-coding-agent@0.86.1`.
- `%USERPROFILE%\.pi\agent\settings.json` — through `pi install npm:gentle-pi@3.3.0`.
- The VSCodium extensions directory — through `codium --install-extension <vsix>`.
- `%APPDATA%\VSCodium\User\settings.json` — created only when it does not exist.

Environment overrides are honored the same way VSCodium resolves its user data
path: `VSCODE_PORTABLE` (portable mode) and `VSCODE_APPDATA` change the
destination, and the script prints the resolved path it will use.

## Verifying that branding applied

1. Launch VSCodium and open **Help > About**. `nameShort`/`nameLong` should read
   PiCode, not VSCodium.
2. Confirm the overlay is in place and valid:
   `Get-Content "$env:APPDATA\VSCodium\product.json" | ConvertFrom-Json`.
3. Open the Extensions view and confirm searches resolve against Open VSX.
4. Expect the limits: `codium --version` still reports VSCodium, and Windows
   still lists the application as VSCodium. That is the cost of the no-compile
   path; see `docs/DISTRIBUTION.md`, section 8.

If the branding does not appear, check in this order: the file is at
`%APPDATA%\VSCodium\product.json` (not under a `PiCode` folder — the path is
derived from VSCodium's own `nameShort`, not from this overlay); the file parses
as strict JSON; and neither `VSCODE_PORTABLE` nor `VSCODE_APPDATA` is set.

## Packaging the extension

The extension is not compiled into the editor, so it ships as a VSIX. From the
extension directory:

```powershell
cd extensions/picode-pi-chat
npx --yes @vscode/vsce package
```

Then either re-run `bootstrap.ps1 -Apply` (it picks up the newest `.vsix`) or
install it directly:

```powershell
codium --install-extension extensions/picode-pi-chat/picode-pi-chat-0.1.0.vsix
```

The bootstrap never packages the VSIX itself; it prints this command when no
VSIX is present.

## Reverting

Restore the backup that `bootstrap.ps1` wrote next to the overlay:

```powershell
$dest = "$env:APPDATA\VSCodium\product.json"
# Pick the backup you want to restore
Get-ChildItem "$env:APPDATA\VSCodium\product.json.picode-backup-*"
Copy-Item "$env:APPDATA\VSCodium\product.json.picode-backup-<stamp>" $dest -Force
```

To remove the branding entirely and return to a stock VSCodium profile, delete
`product.json` from that directory (VSCodium then falls back to its built-in
product configuration). The default `settings.json` and the extension are
uninstalled through the normal VSCodium UI.

## Known uncertainties

- The gentle-pi installation command is verified (`pi install npm:gentle-pi@3.3.0`),
  but `bootstrap.ps1` has not been run end to end on a machine with VSCodium
  installed; only preview mode and the read-only probes were exercised here.
- VSIX packaging was not executed during this pass.
- The OS-level protocol handler (`vscodium://`) is registered by the VSCodium
  installer and is not changed by the user-level overlay. See
  `docs/DISTRIBUTION.md`, section 4.5.
