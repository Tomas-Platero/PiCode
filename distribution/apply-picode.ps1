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

    It replaces an earlier approach that branded a separately installed VSCodium
    through a user-level overlay. That path could override product keys but never
    delete them, which is why Copilot could not be removed from it; ADR-011 records
    the change, and the retired script is in git history.

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
# Step 4 renames the executable, so a second run of this script has to accept either
# name as proof that this is a VSCodium root.
$RenamedExe     = Join-Path $RepoRoot "PiCode.exe"
$ProductJson    = Join-Path $RepoRoot "resources\app\product.json"
$DataRoot       = Join-Path $RepoRoot "data"
$UserDataDir    = Join-Path $DataRoot "user-data"
$ExtensionsDir  = Join-Path $DataRoot "extensions"
$TempDir        = Join-Path $DataRoot "tmp"
$SettingsTarget = Join-Path $UserDataDir "User\settings.json"

$DeltaPath      = Join-Path $PSScriptRoot "product-delta.json"
$ApplierPath    = Join-Path $PSScriptRoot "apply-product-delta.mjs"
$SettingsSource = Join-Path $PSScriptRoot "settings.json"

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

if (-not (Test-Path -LiteralPath $Executable) -and -not (Test-Path -LiteralPath $RenamedExe)) {
    throw "No editor executable was found at $Executable or $RenamedExe. PiCode expects the VSCodium archive extracted at the repository root; extract it there and re-run."
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

Write-Note "A data/ folder next to the executable switches the build to portable mode,"
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
# Step 4 - the names Windows shows
# ---------------------------------------------------------------------------
Write-Section "Step 4 - the visible name of the binary"

# The product keys handled in Step 1 cover the window title and the About dialog. What
# is left is the file names: the executable itself, the two CLI shims that name it in
# their own text, and the Start Menu tile manifest. The executable's name is what Task
# Manager, the process list and the file you double-click show.
#
# The icon inside the executable is deliberately left alone: replacing it means editing
# the PE resources, which is a build-time job rather than a file rename.
function Rename-IfNeeded([string]$From, [string]$To) {
    if (Test-Path -LiteralPath $From) {
        Write-Act "Rename $(Split-Path -Leaf $From) to $(Split-Path -Leaf $To)"
        if (-not $isPreview) {
            Move-Item -LiteralPath $From -Destination $To -Force
            $Done.Add("renamed $(Split-Path -Leaf $From) to $(Split-Path -Leaf $To)")
        }
        return
    }
    if (Test-Path -LiteralPath $To) {
        Write-Skip "already named $(Split-Path -Leaf $To)"
        return
    }
    Write-Warn "Neither $(Split-Path -Leaf $From) nor $(Split-Path -Leaf $To) exists"
}

[void](Rename-IfNeeded (Join-Path $RepoRoot "VSCodium.exe") (Join-Path $RepoRoot "PiCode.exe"))
[void](Rename-IfNeeded (Join-Path $RepoRoot "bin\codium.cmd") (Join-Path $RepoRoot "bin\picode.cmd"))
[void](Rename-IfNeeded (Join-Path $RepoRoot "bin\codium") (Join-Path $RepoRoot "bin\picode"))
[void](Rename-IfNeeded (Join-Path $RepoRoot "VSCodium.VisualElementsManifest.xml") (Join-Path $RepoRoot "PiCode.VisualElementsManifest.xml"))

# The shims name the executable inside their text, so a rename is not enough for them.
# Each entry carries both names: in preview mode the rename above did not happen, so the
# file to edit is still the old one, and a preview that silently skips this step would be
# reporting less than it does.
$nameFixes = @(
    @{ New = "bin\picode.cmd"; Old = "bin\codium.cmd"; Find = "VSCodium.exe"; Replace = "PiCode.exe" },
    @{ New = "bin\picode"; Old = "bin\codium"; Find = 'NAME="VSCodium"'; Replace = 'NAME="PiCode"' },
    @{ New = "PiCode.VisualElementsManifest.xml"; Old = "VSCodium.VisualElementsManifest.xml"; Find = 'ShortDisplayName="VSCodium"'; Replace = 'ShortDisplayName="PiCode"' }
)

foreach ($fix in $nameFixes) {
    $target = Join-Path $RepoRoot $fix.New
    $source = Join-Path $RepoRoot $fix.Old

    if (-not (Test-Path -LiteralPath $target)) {
        if ($isPreview -and (Test-Path -LiteralPath $source)) {
            Write-Act "Point $($fix.New) at $($fix.Replace)"
        } else {
            Write-Skip "$($fix.New) is not there"
        }
        continue
    }

    $text = Get-Content -LiteralPath $target -Raw
    if ($text -notlike "*$($fix.Find)*") {
        Write-Skip "$($fix.New) no longer names VSCodium"
        continue
    }
    Write-Act "Point $($fix.New) at $($fix.Replace)"
    if (-not $isPreview) {
        Set-Content -LiteralPath $target -Value ($text.Replace($fix.Find, $fix.Replace)) -NoNewline
        $Done.Add("updated $($fix.New)")
    }
}

# ---------------------------------------------------------------------------
# Step 5 - the icons inside the application
# ---------------------------------------------------------------------------
Write-Section "Step 5 - icons inside the application"

# The executable's own icon is set separately, because it needs a PE resource tool; see
# docs/DISTRIBUTION.md section 9. This step is the other half: VS Code ships its own logo
# files, and those are what the interface draws. They are deliberately not covered by the
# product checksums, which is what makes replacing them safe.
# The marks live in `distribution/` beside this script, where the owner put them; the chat
# extension they used to live in is gone. The tile PNG is not stored anywhere: it is pulled out
# of the .ico's own largest frame by the same tool the Linux icon uses, so there is one drawing
# and no second copy to keep in step.
$markSource  = Join-Path $PSScriptRoot "picode-icon.svg"
$icoForTiles = Join-Path $PSScriptRoot "picode.ico"
$markPng     = Join-Path ([System.IO.Path]::GetTempPath()) "picode-tiles.png"
if (Test-Path -LiteralPath $icoForTiles) {
    & node (Join-Path $RepoRoot "dev\ico-to-png.mjs") $icoForTiles $markPng | Out-Null
}

if (-not (Test-Path -LiteralPath $markSource)) {
    Write-Warn "No mark found at $markSource; the icons inside the application were left alone."
} else {
    # The owner's asset carries a C2PA provenance manifest: some 8 kB of base64 in the middle
    # of the SVG, describing which tool produced the file. That belongs in the repository
    # history, not inside every shipped copy of the icon.
    $mark = (Get-Content -LiteralPath $markSource -Raw) -replace '(?s)<metadata>.*?</metadata>', '' -replace '\s+xmlns:c2pa="[^"]*"', ''

    # The watermark is the line drawing, not the mark with its plate.
    #
    # `picode-icon.svg` opens with a full-canvas `rect`, which is right for an icon that has
    # to hold its own against a background and wrong for the mark an empty editor draws
    # behind its hints: there, the plate becomes a dark block sitting on the editor's own
    # surface. `picode.svg` is the same family drawn as strokes only, so it stays a mark at
    # any size instead of a rectangle.
    $watermarkSource = Join-Path $PSScriptRoot "picode.svg"
    $watermark = if (Test-Path -LiteralPath $watermarkSource) {
        Get-Content -LiteralPath $watermarkSource -Raw
    } else {
        Write-Warn "No line-drawing mark at $watermarkSource; the watermarks will use the icon mark."
        $mark
    }

    # Every asset in the tree that carries the upstream logo. The paths are relative to
    # `resources\app`, not bare names, because not all of them live in `out\media`.
    foreach ($relative in @(
        "out\media\code-icon.svg",
        "out\media\vscode-icon.svg",
        "out\media\sessions-icon.svg",
        "out\media\sessions-logo-dark.svg",
        "out\media\sessions-logo-light.svg"
    )) {
        $target = Join-Path $RepoRoot "resources\app\$relative"
        if (-not (Test-Path -LiteralPath $target)) {
            Write-Skip "$relative is not there"
            continue
        }
        Write-Act "Draw $relative with the PiCode mark"
        if (-not $isPreview) {
            Set-Content -LiteralPath $target -Value $mark -NoNewline
            $Done.Add("replaced $relative")
        }
    }

    # The watermarks: what an empty editor — and the agent sessions surface one view further
    # in — draws behind their hints ("Show All Commands", "Open Settings", "Toggle
    # Terminal"). They take the line drawing rather than the icon mark.
    foreach ($relative in @(
        "out\media\letterpress-dark.svg",
        "out\media\letterpress-light.svg",
        "out\media\letterpress-hcDark.svg",
        "out\media\letterpress-hcLight.svg",
        "out\vs\sessions\contrib\chat\browser\media\letterpress-sessions-dark.svg",
        "out\vs\sessions\contrib\chat\browser\media\letterpress-sessions-light.svg"
    )) {
        $target = Join-Path $RepoRoot "resources\app\$relative"
        if (-not (Test-Path -LiteralPath $target)) {
            Write-Skip "$relative is not there"
            continue
        }
        Write-Act "Draw $relative with the PiCode line mark"
        if (-not $isPreview) {
            Set-Content -LiteralPath $target -Value $watermark -NoNewline
            $Done.Add("replaced $relative")
        }
    }

    $icoTarget = Join-Path $RepoRoot "resources\app\resources\win32\code.ico"
    $icoSource = Join-Path $PSScriptRoot "picode.ico"
    if ((Test-Path -LiteralPath $icoTarget) -and (Test-Path -LiteralPath $icoSource)) {
        Write-Act "Replace resources\win32\code.ico"
        if (-not $isPreview) {
            Copy-Item -LiteralPath $icoSource -Destination $icoTarget -Force
            $Done.Add("replaced resources\\win32\\code.ico")
        }
    }

    if (-not (Test-Path -LiteralPath $markPng)) {
        Write-Skip "no PNG available to rebuild the Start Menu tiles"
    } else {
        foreach ($tile in @(@{ Name = "code_150x150.png"; Size = 150 }, @{ Name = "code_70x70.png"; Size = 70 })) {
            $target = Join-Path $RepoRoot "resources\app\resources\win32\$($tile.Name)"
            if (-not (Test-Path -LiteralPath $target)) {
                Write-Skip "$($tile.Name) is not there"
                continue
            }
            Write-Act "Redraw $($tile.Name) at $($tile.Size) px"
            if (-not $isPreview) {
                Add-Type -AssemblyName System.Drawing
                $image = [System.Drawing.Image]::FromFile($markPng)
                $bitmap = New-Object System.Drawing.Bitmap($tile.Size, $tile.Size)
                $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.DrawImage($image, 0, 0, $tile.Size, $tile.Size)
                $graphics.Dispose()
                $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
                $bitmap.Dispose()
                $image.Dispose()
                $Done.Add("redrew resources\\win32\\$($tile.Name)")
            }
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
