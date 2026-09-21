#Requires -Version 5.1
<#
.SYNOPSIS
    Turns the VSCodium tree in this repository into the PiCode distribution.

.DESCRIPTION
    PiCode owns its editor tree: the VSCodium archive is extracted at the
    repository root, so `resources/app/product.json` is editable and a `data/`
    folder next to the executable switches the build to portable mode.

    This script applies two things and nothing else:

      - the product delta, read from `distribution/product-delta.json` and
        applied by `distribution/apply-product-delta.mjs` (a small Node program,
        because Windows PowerShell 5.1 caps ConvertTo-Json depth at 2 and would
        corrupt this product);
      - the portable profile: `data/` plus first-run defaults copied into it
        only when the user has no settings file of their own.

    It supersedes `bootstrap.ps1`, which branded a separately installed VSCodium
    through a user-level overlay. That path could override product keys but never
    delete them, which is why Copilot could not be removed from it.

    This script is IDEMPOTENT and NON-DESTRUCTIVE:

      - Preview is the default; it runs the applier in check mode and creates
        nothing.
      - It backs up product.json with a timestamped name before the first write.
      - A second run reports the product as already current and writes nothing.
      - It never overwrites an existing settings.json.
      - It never requires administrator rights and never writes outside the
        repository root.

.PARAMETER Apply
    Perform the actions. Without this switch the script runs in preview mode.

.PARAMETER DryRun
    Force preview mode. Takes precedence over -Apply.

.NOTES
    Paths this script touches when -Apply is passed:

      - resources/app/product.json                 the product delta (backed up first)
      - resources/app/extensions/picode-pi-chat/    the agent panel, shipped as a built-in extension
      - data/user-data/                            portable user data
      - data/extensions/                           portable extension directory
      - data/tmp/                                  portable temp, used by the editor
      - data/user-data/User/settings.json          only created if it does not exist yet

    The backup is written next to the target as
    `product.json.picode-backup-<yyyyMMdd-HHmmss>`, so a revert is a file copy.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Apply,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Layout. The repository root doubles as the distribution root.
# ---------------------------------------------------------------------------
$RepoRoot       = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = (Get-Location).Path }

$Executable     = Join-Path $RepoRoot "VSCodium.exe"
$ProductJson    = Join-Path $RepoRoot "resources\app\product.json"
$DataRoot       = Join-Path $RepoRoot "data"
$UserDataDir    = Join-Path $DataRoot "user-data"
$ExtensionsDir  = Join-Path $DataRoot "extensions"
$TempDir        = Join-Path $DataRoot "tmp"
$SettingsTarget = Join-Path $UserDataDir "User\settings.json"

$DeltaPath      = Join-Path $PSScriptRoot "product-delta.json"
$ApplierPath    = Join-Path $PSScriptRoot "apply-product-delta.mjs"
$SettingsSource = Join-Path $PSScriptRoot "settings.json"

# The agent panel is delivered as a built-in extension: because PiCode owns the
# VSCodium tree, the editor scans resources/app/extensions at startup, so no
# install step and no compiled-in extension list are needed.
$ExtensionSource = Join-Path $RepoRoot "extensions\picode-pi-chat"
$ExtensionTarget = Join-Path $RepoRoot "resources\app\extensions\picode-pi-chat"

# Exit codes of apply-product-delta.mjs, mirrored here because Windows
# PowerShell 5.1 does not throw on a non-zero native exit code.
$ApplierUpToDate    = 0
$ApplierNeedsUpdate = 1
$ApplierError       = 2

# ---------------------------------------------------------------------------
# Reporting helpers. Write-Act records a mutating action; in preview mode that
# is the only thing that happens for the action.
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
    Write-Host "PiCode apply - PREVIEW MODE. No changes will be made." -ForegroundColor Yellow
    Write-Host "Re-run with -Apply to execute the actions below."
} else {
    Write-Host "PiCode apply - APPLY MODE. Changes will be made." -ForegroundColor Green
}
Write-Host "Distribution root: $RepoRoot"

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
Write-Section "Preconditions"

if (-not (Test-Path -LiteralPath $Executable)) {
    throw "VSCodium.exe was not found at $Executable. PiCode expects the VSCodium archive extracted at the repository root; extract it there and re-run."
}
if (-not (Test-Path -LiteralPath $ProductJson)) {
    throw "The product file was not found at $ProductJson. The tree does not look like a VSCodium install."
}
Write-Note "Editor and product file found."

foreach ($required in @($DeltaPath, $ApplierPath, $SettingsSource)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "A required PiCode file is missing: $required"
    }
}
Write-Note "Delta, applier and default settings found."

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Node.js was not found on PATH. The product delta is applied by a Node program; pi requires Node 22.19.0 or newer anyway."
}
Write-Note "Node: $($nodeCommand.Source)"

# ---------------------------------------------------------------------------
# Step 1 - product delta
# ---------------------------------------------------------------------------
Write-Section "Step 1 - product delta in resources/app/product.json"

Write-Note "Applying $DeltaPath"
& node $ApplierPath --target $ProductJson --delta $DeltaPath --check
$checkExit = $LASTEXITCODE

if ($checkExit -eq $ApplierError) {
    throw "The product delta could not be evaluated (applier exit code $checkExit). Nothing was written."
}

if ($checkExit -eq $ApplierUpToDate) {
    Write-Skip "the product already matches the delta"
} elseif ($checkExit -eq $ApplierNeedsUpdate) {
    Write-Act "Back up product.json and write the delta"

    if ($isPreview) {
        Write-Note "Preview: the applier was run in check mode only."
    } else {
        $backup = "$ProductJson.picode-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss")
        Copy-Item -LiteralPath $ProductJson -Destination $backup -Force
        Write-Note "Backup: $backup"

        & node $ApplierPath --target $ProductJson --delta $DeltaPath --write
        $writeExit = $LASTEXITCODE
        if ($writeExit -ne $ApplierUpToDate) {
            throw "The applier failed while writing (exit code $writeExit). Restore the backup at $backup before retrying."
        }
        $Done.Add("product delta applied to $ProductJson (backup: $backup)")
    }
} else {
    throw "Unexpected applier exit code: $checkExit"
}

# ---------------------------------------------------------------------------
# Step 2 - portable profile
# ---------------------------------------------------------------------------
Write-Section "Step 2 - portable profile in data/"

Write-Note "A data/ folder next to VSCodium.exe switches the build to portable mode,"
Write-Note "so settings, extensions and session state stay inside this distribution."

foreach ($dir in @($UserDataDir, $ExtensionsDir, $TempDir)) {
    if (Test-Path -LiteralPath $dir) {
        Write-Skip "already exists: $dir"
    } else {
        Write-Act "Create $dir"
        if (-not $isPreview) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $Done.Add("created $dir")
        }
    }
}

# ---------------------------------------------------------------------------
# Step 3 - first-run defaults
# ---------------------------------------------------------------------------
Write-Section "Step 3 - first-run defaults"

if (Test-Path -LiteralPath $SettingsTarget) {
    $srcHash = (Get-FileHash -LiteralPath $SettingsSource -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $SettingsTarget -Algorithm SHA256).Hash

    if ($srcHash -eq $dstHash) {
        Write-Skip "settings.json is already the shipped default"
    } else {
        Write-Warn "The user already has settings at $SettingsTarget."
        Write-Note "A distribution must not clobber user settings. Merge the defaults manually:"
        Write-Note "  source: $SettingsSource"
        $Skipped.Add("settings.json left untouched (user file differs)")
        $Next.Add("Merge distribution/settings.json into $SettingsTarget by hand")
    }
} else {
    Write-Note "The user data directory does not exist yet; it will be created by Step 2."
    Write-Note "Expected settings target: $SettingsTarget"
    Write-Act "Copy the default settings to $SettingsTarget"
    if (-not $isPreview) {
        $parent = Split-Path -Parent $SettingsTarget
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Copy-Item -LiteralPath $SettingsSource -Destination $SettingsTarget -Force
        $Done.Add("wrote default settings to $SettingsTarget")
    }
}

# ---------------------------------------------------------------------------
# Step 4 - the agent panel as a built-in extension
# ---------------------------------------------------------------------------
Write-Section "Step 4 - built-in extension resources/app/extensions/picode-pi-chat"

# What ships is the built package, mirrored from .vscodeignore: sources, the
# toolchain, maps and packaging state never reach the editor tree.
$excludedPatterns = @(
    '^(src|node_modules|\.atl|\.vscode)[\\/]',
    '\.map$',
    '\.vsix$'
)
$excludedNames = @('.gitignore', '.vscodeignore', 'package-lock.json', 'tsconfig.json')

function Get-RelativePath([string]$Root, [string]$Full) {
    return $Full.Substring($Root.Length).TrimStart('\', '/')
}

function Get-StageableFiles([string]$Root) {
    $files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    if (-not (Test-Path -LiteralPath $Root)) { return $files }

    foreach ($file in (Get-ChildItem -LiteralPath $Root -Recurse -File)) {
        $relative = Get-RelativePath $Root $file.FullName
        if ($excludedNames -contains $file.Name) { continue }

        $skip = $false
        foreach ($pattern in $excludedPatterns) {
            if ($relative -match $pattern) { $skip = $true; break }
        }
        if (-not $skip) { $files.Add($file) }
    }
    return $files
}

$extensionReady = (Test-Path -LiteralPath (Join-Path $ExtensionSource "package.json")) -and
                  (Test-Path -LiteralPath (Join-Path $ExtensionSource "out\extension.js"))

if (-not $extensionReady) {
    Write-Warn "The panel is not built: expected package.json and out/extension.js under $ExtensionSource"
    Write-Note "Build it with:"
    Write-Note "  cd extensions/picode-pi-chat; npm install; npm run compile"
    $Skipped.Add("built-in extension not staged (build missing)")
    $Next.Add("Build the panel, then re-run this script to stage it as a built-in extension")
} else {
    $sourceFiles = Get-StageableFiles $ExtensionSource
    $changed = [System.Collections.Generic.List[string]]::new()
    $stale = [System.Collections.Generic.List[string]]::new()

    foreach ($file in $sourceFiles) {
        $relative = Get-RelativePath $ExtensionSource $file.FullName
        $destination = Join-Path $ExtensionTarget $relative

        if (-not (Test-Path -LiteralPath $destination)) {
            $changed.Add($relative)
            continue
        }
        $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        if ($sourceHash -ne $destinationHash) { $changed.Add($relative) }
    }

    # A renamed module would otherwise leave its old build output behind, and the
    # editor would keep loading it.
    if (Test-Path -LiteralPath $ExtensionTarget) {
        foreach ($file in (Get-ChildItem -LiteralPath $ExtensionTarget -Recurse -File)) {
            $relative = Get-RelativePath $ExtensionTarget $file.FullName
            $stillShipped = $false
            foreach ($source in $sourceFiles) {
                if ((Get-RelativePath $ExtensionSource $source.FullName) -eq $relative) {
                    $stillShipped = $true
                    break
                }
            }
            if (-not $stillShipped) { $stale.Add($relative) }
        }
    }

    if ($changed.Count -eq 0 -and $stale.Count -eq 0) {
        Write-Skip "the built-in extension is already current ($($sourceFiles.Count) files)"
    } else {
        Write-Note "$($sourceFiles.Count) files ship; $($changed.Count) need writing, $($stale.Count) are stale"
        Write-Act "Stage the agent panel into $ExtensionTarget"

        if ($isPreview) {
            Write-Note "Preview: nothing was copied."
        } else {
            foreach ($relative in $stale) {
                Remove-Item -LiteralPath (Join-Path $ExtensionTarget $relative) -Force
            }
            foreach ($file in $sourceFiles) {
                $relative = Get-RelativePath $ExtensionSource $file.FullName
                $destination = Join-Path $ExtensionTarget $relative
                $parent = Split-Path -Parent $destination
                if (-not (Test-Path -LiteralPath $parent)) {
                    New-Item -ItemType Directory -Path $parent -Force | Out-Null
                }
                Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
            }
            $Done.Add("staged the agent panel into $ExtensionTarget")
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Section "Summary"

Write-Note "Applied:"
if ($Done.Count -eq 0) { Write-Note "  (nothing)" } else { foreach ($item in $Done) { Write-Note "  - $item" } }

Write-Note "Planned:"
if ($Planned.Count -eq 0) { Write-Note "  (nothing)" } else { foreach ($item in $Planned) { Write-Note "  - $item" } }

Write-Note "Skipped:"
if ($Skipped.Count -eq 0) { Write-Note "  (nothing)" } else { foreach ($item in $Skipped) { Write-Note "  - $item" } }

if ($Next.Count -gt 0) {
    Write-Note "Next steps:"
    foreach ($item in $Next) { Write-Note "  - $item" }
}

Write-Host ""
if ($isPreview) {
    Write-Host "Preview complete. Nothing was changed." -ForegroundColor Yellow
} else {
    Write-Host "Apply complete." -ForegroundColor Green
}
