#Requires -Version 5.1
<#
.SYNOPSIS
    Applies the PiCode distribution layers to a Windows machine that has VSCodium.

.DESCRIPTION
    PiCode is a layered distribution. It does not compile the editor: it brands an
    existing VSCodium install, adds the pinned agent runtime and installs the
    PiCode editor extension. See docs/DISTRIBUTION.md for the full strategy.

    This script is IDEMPOTENT and NON-DESTRUCTIVE:

      - It never overwrites product.json without writing a timestamped backup first.
      - It skips work that is already done: an identical branding overlay, an
        already-installed matching pi version, and gentle-pi already present in
        `pi list` are all reported and skipped.
      - It never overwrites an existing user settings.json.
      - It never installs VSCodium silently. If VSCodium is missing it prints the
        winget command and continues with the layers it can still stage.
      - It never writes outside the current user profile and the PiCode checkout.
      - It never requires administrator rights. Every path it writes is under
        %APPDATA%, %USERPROFILE% or the current npm global prefix.

    PREVIEW IS THE DEFAULT. Without -Apply the script performs only read-only
    probes (`Get-Command`, `node --version`, `pi list`) and prints every action it
    would take. Pass -Apply to change the system. -DryRun, or the standard
    PowerShell -WhatIf switch, forces preview even when -Apply is present.

.PARAMETER Apply
    Perform the actions. Without this switch the script runs in preview mode.

.PARAMETER DryRun
    Force preview mode. Takes precedence over -Apply.

.NOTES
    Paths this script touches when -Apply is passed:

      - %APPDATA%\VSCodium\product.json         PiCode branding overlay (backed up first)
      - %APPDATA%\VSCodium\User\settings.json   only created if it does not exist yet
      - the npm global prefix                   npm install -g @earendil-works/pi-coding-agent@0.86.1
      - %USERPROFILE%\.pi\agent\settings.json   via `pi install npm:gentle-pi@3.3.0`
      - the VSCodium extensions directory       via `codium --install-extension <vsix>`

    Environment overrides honored, mirroring VSCodium's userDataPath resolution:
      - VSCODE_PORTABLE -> <portable>\user-data
      - VSCODE_APPDATA  -> <vscode-appdata>\VSCodium
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Apply,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Configuration: pinned versions. These are the versions PiCode ships.
# ---------------------------------------------------------------------------
$PinnedPiPackage       = "@earendil-works/pi-coding-agent"
$PinnedPiVersion       = "0.86.1"
$PinnedGentlePiPackage = "gentle-pi"
$PinnedGentlePiVersion = "3.3.0"
$MinNodeVersion        = [version]"22.19.0"

# VSCodium rebrands the compiled-in product through product.json's nameShort,
# which the user-product patch reads before the overlay is merged. For the stable
# VSCodium build nameShort is "VSCodium", so the user data folder is "VSCodium".
# Verified against VSCodium prepare_vscode.sh and microsoft/vscode userDataPath.ts;
# see docs/DISTRIBUTION.md, section "Layer 2".
$VSCodiumDataFolder = "VSCodium"

$RepoRoot        = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = (Get-Location).Path }
$OverlaySource   = Join-Path $PSScriptRoot "product.json"
$DefaultsSource  = Join-Path $PSScriptRoot "settings.json"
$ExtensionDir    = Join-Path $RepoRoot "extensions\picode-pi-chat"

# ---------------------------------------------------------------------------
# Reporting helpers. Write-Act records a mutating action; in preview mode this is
# the only thing that happens for that action.
# ---------------------------------------------------------------------------
$Planned = [System.Collections.Generic.List[string]]::new()
$Done    = [System.Collections.Generic.List[string]]::new()
$Skipped = [System.Collections.Generic.List[string]]::new()
$Next    = [System.Collections.Generic.List[string]]::new()

function Write-Section([string]$Text) {
    Write-Host ""
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Write-Note([string]$Text) {
    Write-Host "   $Text"
}

function Write-Act([string]$Text) {
    Write-Host "  -> $Text" -ForegroundColor Yellow
    $script:Planned.Add($Text)
}

function Write-Warn([string]$Text) {
    Write-Host "  !! $Text" -ForegroundColor Magenta
}

function Write-Skip([string]$Text) {
    Write-Host "  -- skipped: $Text"
    $script:Skipped.Add($Text)
}

# ---------------------------------------------------------------------------
# Mode
# ---------------------------------------------------------------------------
$isPreview = (-not $Apply) -or $DryRun -or $WhatIfPreference

Write-Host ""
if ($isPreview) {
    Write-Host "PiCode bootstrap - PREVIEW MODE. No changes will be made." -ForegroundColor Yellow
    Write-Host "Re-run with -Apply to execute the actions below."
} else {
    Write-Host "PiCode bootstrap - APPLY MODE. Changes will be made." -ForegroundColor Green
}
Write-Host "Repository root: $RepoRoot"

# ---------------------------------------------------------------------------
# Layer 1 - editor: VSCodium
# ---------------------------------------------------------------------------
Write-Section "Layer 1 - editor (VSCodium)"

function Resolve-CodiumCli {
    $cmd = Get-Command codium -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $bases = @()
    if ($env:LOCALAPPDATA) { $bases += (Join-Path $env:LOCALAPPDATA "Programs\VSCodium\bin\codium.cmd") }
    if ($env:ProgramFiles) { $bases += (Join-Path $env:ProgramFiles "VSCodium\bin\codium.cmd") }
    $progX86 = ${env:ProgramFiles(x86)}
    if ($progX86) { $bases += (Join-Path $progX86 "VSCodium\bin\codium.cmd") }

    foreach ($candidate in $bases) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

$codiumCli = Resolve-CodiumCli
if ($codiumCli) {
    Write-Note "VSCodium CLI found: $codiumCli"
} else {
    Write-Warn "VSCodium was not detected on PATH or in the common install locations."
    Write-Note "Install it with:  winget install VSCodium.VSCodium"
    Write-Note "This script will not install VSCodium silently."
    $Next.Add("Install VSCodium: winget install VSCodium.VSCodium")
}

# ---------------------------------------------------------------------------
# Layer 2 - branding overlay (user-level product.json)
# ---------------------------------------------------------------------------
Write-Section "Layer 2 - branding overlay (user product.json)"

if (-not (Test-Path -LiteralPath $OverlaySource)) {
    throw "Branding overlay not found: $OverlaySource"
}

# Validate the overlay before touching anything. The overlay is loaded by the
# editor with require(), so it must be strict JSON: no comments, no trailing commas.
try {
    [void](Get-Content -LiteralPath $OverlaySource -Raw | ConvertFrom-Json)
} catch {
    throw "distribution/product.json is not valid JSON: $($_.Exception.Message)"
}
Write-Note "Overlay source validated as JSON: $OverlaySource"

function Resolve-VSCodiumUserDataDir {
    if ($env:VSCODE_PORTABLE) { return (Join-Path $env:VSCODE_PORTABLE "user-data") }
    if ($env:VSCODE_APPDATA)  { return (Join-Path $env:VSCODE_APPDATA $VSCodiumDataFolder) }
    if (-not $env:APPDATA) { throw "APPDATA is not set; cannot resolve the VSCodium user data directory." }
    return (Join-Path $env:APPDATA $VSCodiumDataFolder)
}

$userDataDir = Resolve-VSCodiumUserDataDir
$destProduct = Join-Path $userDataDir "product.json"
Write-Note "User data directory (derived): $userDataDir"
Write-Note "Overlay destination:          $destProduct"

if (Test-Path -LiteralPath $destProduct) {
    $srcHash = (Get-FileHash -LiteralPath $OverlaySource -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $destProduct -Algorithm SHA256).Hash

    if ($srcHash -eq $dstHash) {
        Write-Skip "branding overlay is already current (identical SHA256)"
    } else {
        $backup = "$destProduct.picode-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss")
        Write-Act "Back up the existing file to $backup"
        Write-Act "Copy the PiCode overlay to $destProduct"
        if (-not $isPreview) {
            Copy-Item -LiteralPath $destProduct -Destination $backup -Force
            Copy-Item -LiteralPath $OverlaySource -Destination $destProduct -Force
            $Done.Add("branding overlay applied to $destProduct (backup: $backup)")
        }
    }
} else {
    Write-Act "Create $userDataDir if needed and write the PiCode overlay to $destProduct"
    Write-Note "No existing product.json, so there is nothing to back up."
    if (-not $isPreview) {
        if (-not (Test-Path -LiteralPath $userDataDir)) {
            New-Item -ItemType Directory -Path $userDataDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $OverlaySource -Destination $destProduct -Force
        $Done.Add("branding overlay installed at $destProduct")
    }
}

# ---------------------------------------------------------------------------
# Layer 3 - agent runtime: pinned pi and gentle-pi
# ---------------------------------------------------------------------------
Write-Section "Layer 3 - agent runtime (pinned pi $PinnedPiVersion)"

$nodeOk = $false
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Warn "Node.js was not found on PATH. pi requires Node $MinNodeVersion or newer."
    Write-Note "Install it with:  winget install OpenJS.NodeJS.LTS"
    Write-Note "Or download from: https://nodejs.org/en/download"
    $Next.Add("Install Node.js >= $MinNodeVersion and re-run this script")
} else {
    $nodeRaw = (& node --version).Trim()
    $nodeVersion = $null
    if ($nodeRaw -match "v?(\d+\.\d+\.\d+)") { $nodeVersion = [version]$Matches[1] }

    if ($nodeVersion -and $nodeVersion -ge $MinNodeVersion) {
        Write-Note "node $nodeRaw satisfies the requirement (>= $MinNodeVersion)."
        $nodeOk = $true
    } else {
        Write-Warn "node $nodeRaw is older than the required $MinNodeVersion."
        Write-Note "Upgrade Node.js before installing pi, then re-run this script."
        $Next.Add("Upgrade Node.js to >= $MinNodeVersion")
    }
}

if (-not $nodeOk) {
    Write-Skip "pi installation (Node.js requirement not satisfied)"
} else {
    $currentPi = $null
    $piOnPath = Get-Command pi -ErrorAction SilentlyContinue
    if ($piOnPath) { $currentPi = (& pi --version).Trim() }

    if ($currentPi -eq $PinnedPiVersion) {
        Write-Skip "pi $PinnedPiVersion is already installed"
    } else {
        if ($currentPi) {
            Write-Note "Found pi $currentPi; PiCode pins $PinnedPiVersion."
        } else {
            Write-Note "pi is not installed."
        }
        Write-Act "npm install -g $PinnedPiPackage@$PinnedPiVersion"
        if (-not $isPreview) {
            & npm install -g "$PinnedPiPackage@$PinnedPiVersion"
            if ($LASTEXITCODE -ne 0) {
                throw "npm install -g $PinnedPiPackage@$PinnedPiVersion failed with exit code $LASTEXITCODE."
            }
            $Done.Add("pi $PinnedPiVersion installed globally with npm")
        }
    }
}

Write-Section "Layer 3 (cont.) - gentle-pi (pinned $PinnedGentlePiVersion)"

# How the install command was determined (read-only inspection):
#   - `pi --help` exposes `pi install <source>`, and `pi install --help` shows the
#     `npm:@scope/pkg` source form.
#   - pi's own docs (docs/packages.md, "Package Sources") document versioned specs:
#     `pi install npm:@foo/bar@1.0.0`, which are pinned and skipped by updates.
#   - This machine has gentle-pi installed as the settings entry `npm:gentle-pi`
#     (~/.pi/agent/settings.json "packages"), and `pi list` shows the same package.
# So the pinned, non-invented invocation is `pi install npm:gentle-pi@3.3.0`.
#
# Note: the `gentle-ai` Go binary ships inside the gentle-pi package at
# .gentle-ai/v3.4.0/gentle-ai.exe, so no Go toolchain is required.

$piAvailable = Get-Command pi -ErrorAction SilentlyContinue
if (-not $piAvailable) {
    Write-Skip "gentle-pi installation (pi is not available on PATH yet)"
    $Next.Add("Re-run this script after pi $PinnedPiVersion is installed to add gentle-pi")
} else {
    $installedPackages = @(& pi list 2>$null)
    $gentlePiLine = $installedPackages | Where-Object { $_ -match "gentle-pi" }

    if ($gentlePiLine) {
        Write-Skip "gentle-pi is already installed (pi list reports it)"
    } else {
        Write-Act "pi install npm:$PinnedGentlePiPackage@$PinnedGentlePiVersion"
        if (-not $isPreview) {
            & pi install "npm:$PinnedGentlePiPackage@$PinnedGentlePiVersion"
            if ($LASTEXITCODE -ne 0) {
                throw "pi install npm:$PinnedGentlePiPackage@$PinnedGentlePiVersion failed with exit code $LASTEXITCODE."
            }
            $Done.Add("gentle-pi $PinnedGentlePiVersion installed through pi")
        }
    }
}

# ---------------------------------------------------------------------------
# Layer 4 - the PiCode extension (picode-pi-chat)
# ---------------------------------------------------------------------------
Write-Section "Layer 4 - PiCode extension (picode-pi-chat)"

if (-not (Test-Path -LiteralPath $ExtensionDir)) {
    Write-Warn "Extension source not found at $ExtensionDir"
    $Next.Add("Check out the extension source at extensions/picode-pi-chat")
} else {
    $vsix = Get-ChildItem -LiteralPath $ExtensionDir -Filter "*.vsix" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1

    if (-not $vsix) {
        Write-Note "The extension is not compiled into the editor, so it must be installed as a VSIX."
        Write-Warn "No packaged VSIX was found in $ExtensionDir."
        Write-Note "Package it first:  cd `"$ExtensionDir`"; npx --yes @vscode/vsce package"
        Write-Note "Then run this script again, or install manually:"
        Write-Note "  codium --install-extension <path-to-vsix>"
        $Next.Add("Package extensions/picode-pi-chat as a VSIX, then re-run this script")
    } elseif (-not $codiumCli) {
        Write-Note "A VSIX exists but the VSCodium CLI was not found."
        Write-Note "Install it manually once VSCodium is available:"
        Write-Note "  codium --install-extension `"$($vsix.FullName)`""
        $Next.Add("Install $($vsix.Name) with codium --install-extension")
    } else {
        Write-Note "VSIX found: $($vsix.FullName)"
        Write-Act "$codiumCli --install-extension `"$($vsix.FullName)`""
        if (-not $isPreview) {
            & $codiumCli --install-extension $vsix.FullName
            if ($LASTEXITCODE -ne 0) {
                throw "codium --install-extension failed with exit code $LASTEXITCODE."
            }
            $Done.Add("extension installed from $($vsix.Name)")
        }
    }
}

# ---------------------------------------------------------------------------
# Layer 5 - default settings
# ---------------------------------------------------------------------------
Write-Section "Layer 5 - default editor settings"

if (-not (Test-Path -LiteralPath $DefaultsSource)) {
    Write-Skip "default settings (source not found: $DefaultsSource)"
} else {
    try {
        [void](Get-Content -LiteralPath $DefaultsSource -Raw | ConvertFrom-Json)
    } catch {
        throw "distribution/settings.json is not valid JSON: $($_.Exception.Message)"
    }

    $userSettingsDir = Join-Path $userDataDir "User"
    $userSettings    = Join-Path $userSettingsDir "settings.json"

    if (Test-Path -LiteralPath $userSettings) {
        Write-Skip "an existing settings.json was found at $userSettings"
        Write-Note "PiCode never overwrites user settings. Merge the defaults from"
        Write-Note "distribution/settings.json manually if you want them."
        $Next.Add("Optionally merge distribution/settings.json into $userSettings")
    } else {
        Write-Act "Create $userSettings from the PiCode defaults"
        if (-not $isPreview) {
            if (-not (Test-Path -LiteralPath $userSettingsDir)) {
                New-Item -ItemType Directory -Path $userSettingsDir -Force | Out-Null
            }
            Copy-Item -LiteralPath $DefaultsSource -Destination $userSettings -Force
            $Done.Add("default settings written to $userSettings")
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Section "Summary"

if ($isPreview) {
    Write-Host "Mode: PREVIEW (nothing was changed)"
    if ($Planned.Count -gt 0) {
        Write-Host "Would do:"
        $Planned | ForEach-Object { Write-Host "  [plan]    $_" }
    } else {
        Write-Host "Would do:  (nothing)"
    }
} else {
    Write-Host "Mode: APPLY"
    if ($Done.Count -gt 0) {
        Write-Host "Done:"
        $Done | ForEach-Object { Write-Host "  [done]    $_" }
    } else {
        Write-Host "Done:      (nothing)"
    }
}

if ($Skipped.Count -gt 0) {
    Write-Host "Skipped:"
    $Skipped | ForEach-Object { Write-Host "  [skipped] $_" }
}

Write-Host "Next manual steps:"
if ($Next.Count -gt 0) {
    $Next | ForEach-Object { Write-Host "  - $_" }
} else {
    Write-Host "  - None. Launch PiCode (VSCodium) and run 'PiCode: Open pi Chat' from the Command Palette."
}

if ($isPreview) {
    Write-Host ""
    Write-Host "Nothing above was executed. Re-run with -Apply to apply it." -ForegroundColor Yellow
}
