#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Prepares the fetched VS Code source: brands `product.json`, then applies the
# inherited VSCodium patch set and PiCode's own patches.
#
# Adapted from VSCodium's `prepare_vscode.sh` at the revision pinned in
# `upstream/vscodium.json`. What changed, and why:
#
#   * VSCodium merges its repository-root `product.json` into `picode-source/product.json`
#     with `jq -s '.[0] * .[1]'`. PiCode has no such root file because the PiCode
#     identity is data (`distribution/product-delta.json`) applied later, in
#     `dev/build.sh` phase 5. The one thing that root file carries and no delta key
#     covers is VS Code's extension metadata tables (badge providers, API
#     proposals, extension kinds…), which the PiCode delta prunes but cannot
#     create. That file is vendored verbatim as `dev/vscodium-product.json` and
#     merged the same way.
#   * The `setpath` values keep VSCodium's *stable* identity, not PiCode's. The
#     delta is the single source of PiCode branding, and `patches/vscodium` is
#     authored against a VSCodium-branded product; branding as PiCode here and
#     then applying the delta would leave the VSCodium-only keys
#     (`darwinBundleIdentifier`, `linuxIconName`, `serverApplicationName`, the
#     `win32*` identifiers) in a half-renamed state that matches neither tree.
#   * VSCodium's `src/{stable,insider}/` asset layer is NOT copied: it holds
#     VSCodium's own icons, which PiCode replaces with its own marks after
#     packing (`dev/stage-distribution.sh`).
#   * What VSCodium's prepare does after its patch stage is split in two here. The
#     `package.json` version and the `Microsoft Corporation` branding
#     (`package.json`, `build/lib/electron.ts`, `resources/server/manifest.json`)
#     are DONE, by the `metadata` stage. Three things are NOT done, and this list is
#     the whole of it -- it is repeated in `dev/README.md`:
#       - `undo_telemetry.sh`: it rewrites `*.data.microsoft.com` hosts across the
#         tree with ripgrep, so it needs `node_modules` and belongs after phase 6.
#         PiCode reaches the same end by other means: `00-telemetry-disable.patch`
#         disables telemetry in the source, the product delta unsets the telemetry
#         product keys, and `distribution/settings.json` sets
#         `telemetry.telemetryLevel: "off"`.
#       - the announcement injection: VSCodium's welcome-page announcements are its
#         own content and PiCode ships none.
#       - `build_cli.sh`: it builds `bin/picode` and the tunnel CLI from assets the
#         project publishes. PiCode publishes none, so a source build has no CLI;
#         the `-insider` and installer-text branches are absent for the same
#         reason (PiCode builds `stable` and no installer).
#
# Usage (called by `dev/build.sh`; usable on its own from the repository root):
#
#   dev/prepare_vscode.sh                stage everything, in order
#   dev/prepare_vscode.sh brand          only the product.json branding
#   dev/prepare_vscode.sh patches-vscodium
#   dev/prepare_vscode.sh patches-picode
#
# It must be run with `./picode-source` already fetched.

set -e

STAGE="${1:-all}"
OS_NAME="${OS_NAME:-windows}"
VSCODE_QUALITY="${VSCODE_QUALITY:-stable}"

# include common functions
. ./dev/utils.sh

require_jq

trap picode_cleanup_tmp EXIT

if [[ ! -d "./picode-source" ]]; then
  echo "error: ./picode-source does not exist; run dev/get_repo.sh first." >&2
  exit 2
fi

if [[ ! -f "./dev/vscodium-product.json" ]]; then
  echo "error: ./dev/vscodium-product.json (the vendored VSCodium product overlay) is missing." >&2
  exit 2
fi

brand_product_json() {
  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  echo "--- branding picode-source/product.json"

  cp product.json{,.bak}

  setpath() {
    local jsonTmp
    jsonTmp=$( jq --arg 'value' "${3}" --argjson 'path' "${2}" 'setpath($path; $value)' "${1}.json" )
    echo "${jsonTmp}" > "${1}.json"
  }

  setpath_json() {
    local jsonTmp
    jsonTmp=$( jq --argjson 'value' "${3}" --argjson 'path' "${2}" 'setpath($path; $value)' "${1}.json" )
    echo "${jsonTmp}" > "${1}.json"
  }

  setpath "product" '["checksumFailMoreInfoUrl"]' "https://go.microsoft.com/fwlink/?LinkId=828886"
  setpath "product" '["documentationUrl"]' "https://go.microsoft.com/fwlink/?LinkID=533484#vscode"
  setpath_json "product" '["extensionsGallery"]' '{"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item", "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"}'

  setpath "product" '["introductoryVideosUrl"]' "https://go.microsoft.com/fwlink/?linkid=832146"
  setpath "product" '["keyboardShortcutsUrlLinux"]' "https://go.microsoft.com/fwlink/?linkid=832144"
  setpath "product" '["keyboardShortcutsUrlMac"]' "https://go.microsoft.com/fwlink/?linkid=832143"
  setpath "product" '["keyboardShortcutsUrlWin"]' "https://go.microsoft.com/fwlink/?linkid=832145"
  setpath "product" '["licenseUrl"]' "https://github.com/VSCodium/vscodium/blob/master/LICENSE"
  setpath_json "product" '["linkProtectionTrustedDomains"]' '["https://open-vsx.org"]'
  setpath "product" '["releaseNotesUrl"]' "https://go.microsoft.com/fwlink/?LinkID=533483#vscode"
  setpath "product" '["reportIssueUrl"]' "https://github.com/VSCodium/vscodium/issues/new"
  setpath "product" '["requestFeatureUrl"]' "https://go.microsoft.com/fwlink/?LinkID=533482"
  setpath "product" '["tipsAndTricksUrl"]' "https://go.microsoft.com/fwlink/?linkid=852118"
  setpath "product" '["twitterUrl"]' "https://go.microsoft.com/fwlink/?LinkID=533687"

  if [[ "${DISABLE_UPDATE}" != "yes" ]]; then
    setpath "product" '["updateUrl"]' "https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master"

    if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
      setpath "product" '["downloadUrl"]' "https://github.com/VSCodium/vscodium-insiders/releases"
    else
      setpath "product" '["downloadUrl"]' "https://github.com/VSCodium/vscodium/releases"
    fi
  fi

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    setpath "product" '["nameShort"]' "VSCodium - Insiders"
    setpath "product" '["nameLong"]' "VSCodium - Insiders"
    setpath "product" '["applicationName"]' "codium-insiders"
    setpath "product" '["dataFolderName"]' ".vscodium-insiders"
    setpath "product" '["linuxIconName"]' "vscodium-insiders"
    setpath "product" '["quality"]' "insider"
    setpath "product" '["urlProtocol"]' "vscodium-insiders"
    setpath "product" '["serverApplicationName"]' "codium-server-insiders"
    setpath "product" '["serverDataFolderName"]' ".vscodium-server-insiders"
    setpath "product" '["darwinBundleIdentifier"]' "com.vscodium.VSCodiumInsiders"
    setpath "product" '["win32AppUserModelId"]' "VSCodium.VSCodiumInsiders"
    setpath "product" '["win32DirName"]' "VSCodium Insiders"
    setpath "product" '["win32MutexName"]' "vscodiuminsiders"
    setpath "product" '["win32NameVersion"]' "VSCodium Insiders"
    setpath "product" '["win32RegValueName"]' "VSCodiumInsiders"
    setpath "product" '["win32ShellNameShort"]' "VSCodium Insiders"
    setpath "product" '["win32AppId"]' "{{EF35BB36-FA7E-4BB9-B7DA-D1E09F2DA9C9}"
    setpath "product" '["win32x64AppId"]' "{{B2E0DDB2-120E-4D34-9F7E-8C688FF839A2}"
    setpath "product" '["win32arm64AppId"]' "{{44721278-64C6-4513-BC45-D48E07830599}"
    setpath "product" '["win32UserAppId"]' "{{ED2E5618-3E7E-4888-BF3C-A6CCC84F586F}"
    setpath "product" '["win32x64UserAppId"]' "{{20F79D0D-A9AC-4220-9A81-CE675FFB6B41}"
    setpath "product" '["win32arm64UserAppId"]' "{{2E362F92-14EA-455A-9ABD-3E656BBBFE71}"
    setpath "product" '["tunnelApplicationName"]' "codium-insiders-tunnel"
    setpath "product" '["win32TunnelServiceMutex"]' "vscodiuminsiders-tunnelservice"
    setpath "product" '["win32TunnelMutex"]' "vscodiuminsiders-tunnel"
    setpath "product" '["win32ContextMenu","x64","clsid"]' "90AAD229-85FD-43A3-B82D-8598A88829CF"
    setpath "product" '["win32ContextMenu","arm64","clsid"]' "7544C31C-BDBF-4DDF-B15E-F73A46D6723D"
  else
    setpath "product" '["nameShort"]' "VSCodium"
    setpath "product" '["nameLong"]' "VSCodium"
    setpath "product" '["applicationName"]' "codium"
    setpath "product" '["linuxIconName"]' "vscodium"
    setpath "product" '["quality"]' "stable"
    setpath "product" '["urlProtocol"]' "vscodium"
    setpath "product" '["serverApplicationName"]' "codium-server"
    setpath "product" '["serverDataFolderName"]' ".vscodium-server"
    setpath "product" '["darwinBundleIdentifier"]' "com.vscodium"
    setpath "product" '["win32AppUserModelId"]' "VSCodium.VSCodium"
    setpath "product" '["win32DirName"]' "VSCodium"
    setpath "product" '["win32MutexName"]' "vscodium"
    setpath "product" '["win32NameVersion"]' "VSCodium"
    setpath "product" '["win32RegValueName"]' "VSCodium"
    setpath "product" '["win32ShellNameShort"]' "VSCodium"
    setpath "product" '["win32AppId"]' "{{763CBF88-25C6-4B10-952F-326AE657F16B}"
    setpath "product" '["win32x64AppId"]' "{{88DA3577-054F-4CA1-8122-7D820494CFFB}"
    setpath "product" '["win32arm64AppId"]' "{{67DEE444-3D04-4258-B92A-BC1F0FF2CAE4}"
    setpath "product" '["win32UserAppId"]' "{{0FD05EB4-651E-4E78-A062-515204B47A3A}"
    setpath "product" '["win32x64UserAppId"]' "{{2E1F05D1-C245-4562-81EE-28188DB6FD17}"
    setpath "product" '["win32arm64UserAppId"]' "{{57FD70A5-1B8D-4875-9F40-C5553F094828}"
    setpath "product" '["tunnelApplicationName"]' "codium-tunnel"
    setpath "product" '["win32TunnelServiceMutex"]' "vscodium-tunnelservice"
    setpath "product" '["win32TunnelMutex"]' "vscodium-tunnel"
    setpath "product" '["win32ContextMenu","x64","clsid"]' "D910D5E6-B277-4F4A-BDC5-759A34EEE25D"
    setpath "product" '["win32ContextMenu","arm64","clsid"]' "4852FC55-4A84-4EA1-9C86-D53BE3DF83C0"
  fi

  setpath_json "product" '["tunnelApplicationConfig"]' '{}'

  # The VSCodium repository-root product.json, vendored verbatim (see the header).
  local jsonTmp
  jsonTmp=$( jq -s '.[0] * .[1]' product.json ../dev/vscodium-product.json )
  echo "${jsonTmp}" > product.json && unset jsonTmp

  cd ..
}

# ---------------------------------------------------------------------------
# package metadata. VSCodium does these with `replace`/`setpath` *after* its patch
# stage (prepare_vscode.sh lines 231-247 and 254-255 at the pinned revision); they
# are not part of the patch set, so a pipeline that only applies patches leaves
# `Microsoft Corporation` and the upstream version in place. Measured before this
# existed: `picode-source/package.json` stayed at 1.135.0 and `build/lib/electron.ts`
# kept `companyName: 'Microsoft Corporation'`.
#
# It runs AFTER the patches, unlike the product.json branding: three vendored
# patches rewrite package.json (20-keymap, 21-policy, 53-ext-copilot-remove-it) and
# one rewrites the signature subject, so branding it first would move the context
# out from under them. VSCodium brands after its patches for the same reason.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# The Windows icon resources. The executable's icon is decided while the source tree is
# being PACKED: `build/lib/electron.ts` declares `winIcon: 'resources/win32/code.ico'`
# and the Windows pack applies it with `rcedit(executablePath, { icon })`
# (`build/gulpfile.vscode.win32.ts`). The Start Menu tiles `code_150x150.png` /
# `code_70x70.png` are copied into the package by the same pack. Replacing any of them
# afterwards cannot change what the executable already carries -- and that is exactly what
# used to happen: `dev/stage-distribution.sh` replaced only the copy inside
# `resources/app/`, so the packed `PiCode.exe` kept VS Code's icon.
#
# Measured before this existed: the 32x32 frame extracted from the packed `PiCode.exe`
# and the 32x32 frame of `distribution/picode.ico` produced different pixels
# (sha256 05408e91... against 9cd22a66...). Branding them HERE, in the preparation, is
# what makes the icon actually land in the executable; verified after the fix by parsing
# the PE resource directory, which found all 7 frames of picode.ico present byte for byte.
#
# Windows only: elsewhere the file does not exist and there is nothing to brand.
# ---------------------------------------------------------------------------
brand_windows_icons() {
  if [[ "${OS_NAME}" != "windows" ]]; then
    return
  fi

  local icon_source="./distribution/picode.ico"

  if [[ ! -f "${icon_source}" ]]; then
    echo "error: ${icon_source} is missing; the executable would keep VS Code's icon." >&2
    exit 2
  fi

  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  if [[ ! -f "resources/win32/code.ico" ]]; then
    echo "error: picode-source/resources/win32/code.ico is missing, so the executable's icon" >&2
    echo "       cannot be branded. Upstream may have moved it." >&2
    exit 2
  fi

  cp -f "../${icon_source#./}" resources/win32/code.ico
  echo "branded resources/win32/code.ico"

  if ! command -v powershell > /dev/null 2>&1; then
    echo "warning: powershell not found on PATH, so resources/win32/code_150x150.png and" >&2
    echo "         code_70x70.png still carry VS Code's logo (they are the Start Menu tiles)." >&2
    cd ..
    return
  fi

  # The tiles are 150 and 70 px; the largest frame in picode.ico is 256, so this is a
  # downscale. `System.Drawing` is used because no image resizer is assumed, which is
  # what `dev/README.md` used to record as a gap.
  #
  # The frame is extracted from the ICO container by hand. `System.Drawing.Icon`
  # cannot decode this file: all seven frames are PNG-compressed (a raw 32bpp 256x256
  # frame would be 256 KB; these are 626 bytes to 8 KB), and constructing an Icon from
  # it threw ArgumentOutOfRangeException on ToBitmap(). So: read the directory, keep
  # the largest frame that starts with the PNG signature, and decode that.
  if ! powershell -NoProfile -Command "
    \$ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Drawing

    \$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path '../distribution/picode.ico').Path)
    \$count = [BitConverter]::ToUInt16(\$bytes, 4)
    \$best = \$null
    \$bestArea = 0

    for (\$i = 0; \$i -lt \$count; \$i++) {
      \$entry = 6 + \$i * 16
      \$w = \$bytes[\$entry]; if (\$w -eq 0) { \$w = 256 }
      \$h = \$bytes[\$entry + 1]; if (\$h -eq 0) { \$h = 256 }
      \$size = [BitConverter]::ToUInt32(\$bytes, \$entry + 8)
      \$offset = [BitConverter]::ToUInt32(\$bytes, \$entry + 12)
      \$isPng = \$bytes[\$offset] -eq 0x89 -and \$bytes[\$offset + 1] -eq 0x50 -and \$bytes[\$offset + 2] -eq 0x4E -and \$bytes[\$offset + 3] -eq 0x47

      if (\$isPng -and (\$w * \$h) -gt \$bestArea) {
        \$bestArea = \$w * \$h
        \$best = @{ size = \$size; offset = \$offset }
      }
    }

    if (-not \$best) { throw 'picode.ico has no PNG frame to draw from' }

    \$frame = New-Object byte[] \$best.size
    [Array]::Copy(\$bytes, \$best.offset, \$frame, 0, \$best.size)
    \$stream = New-Object System.IO.MemoryStream(, \$frame)
    \$source = [System.Drawing.Image]::FromStream(\$stream)

    foreach (\$size in 150, 70) {
      \$bmp = New-Object System.Drawing.Bitmap(\$size, \$size)
      \$g = [System.Drawing.Graphics]::FromImage(\$bmp)
      \$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      \$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      \$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      \$g.DrawImage(\$source, 0, 0, \$size, \$size)
      \$g.Dispose()

      # The name is built by concatenation on purpose. This used to interpolate
      # "code_\${size}x\${size}.png" inside the bash double-quoted block, which bash
      # turned into a name PowerShell resolved to empty: both tiles were written to a
      # single file called code_x.png, the real tiles kept VS Code's logo, and the step
      # still reported success.
      \$target = 'resources/win32/code_' + \$size + 'x' + \$size + '.png'
      \$bmp.Save(\$target, [System.Drawing.Imaging.ImageFormat]::Png)
      \$bmp.Dispose()

      # The written file is read back, so a name that is not the one intended cannot
      # pass as success again.
      \$written = [System.Drawing.Image]::FromFile((Resolve-Path \$target).Path)
      if (\$written.Width -ne \$size -or \$written.Height -ne \$size) {
        throw ('the tile written to ' + \$target + ' is not ' + \$size + 'x' + \$size)
      }
      \$written.Dispose()
    }

    \$source.Dispose()
    \$stream.Dispose()
  "; then
    echo "error: the Start Menu tile bitmaps could not be redrawn from the PiCode icon." >&2
    echo "       Shipping VS Code's logo in them is not acceptable, so the build stops." >&2
    cd ..
    exit 1
  fi

  echo "redrew the Start Menu tiles from distribution/picode.ico"

  cd ..
}

brand_package_metadata() {
  # The icon files live in the source tree and are read by the PACKER, so they are
  # branded here rather than after packing.
  brand_windows_icons

  if [[ -z "${RELEASE_VERSION}" ]]; then
    if [[ -f ./upstream/stable.json ]]; then
      RELEASE_VERSION=$( jq -r '.tag' ./upstream/stable.json )
    fi
  fi

  if [[ -z "${RELEASE_VERSION}" || "${RELEASE_VERSION}" == "null" ]]; then
    echo "error: RELEASE_VERSION is empty; run dev/get_repo.sh first (or dev/build.sh)." >&2
    exit 2
  fi

  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  # The version the product REPORTS is PiCode's own, composed by dev/build.sh as
  # `<VS Code major.minor>.<PiCode release>`; the tag in RELEASE_VERSION is what the
  # vendored patches put into the asset download URLs. When prepare_vscode.sh is run on
  # its own (the documented way to edit a patch), APP_VERSION is absent and the tag is the
  # honest fallback: a lone tree is not a release.
  local product_version="${APP_VERSION:-${RELEASE_VERSION}}"

  echo "--- branding package.json and the electron metadata (version ${product_version})"

  local jsonTmp

  jsonTmp=$( jq --arg version "${product_version}" '.version = $version' package.json ) || {
    echo "error: jq could not rewrite package.json." >&2
    exit 2
  }
  echo "${jsonTmp}" > package.json

  # npm 11.17 gates dependency install scripts behind per-package approvals, keyed by
  # name@version COMPLETE - the VSCodium suffix included. Without the second key, phase 6's
  # npm install refuses @vscodium/native-keymap's install.js and dies in its retries.
  jsonTmp=$( jq '.allowScripts = ((.allowScripts // {}) + {
    "native-keymap@3.3.9": true,
    "@vscodium/native-keymap@3.3.9-260952": true
  })' package.json ) || {
    echo "error: jq could not write the allow-scripts approvals into package.json." >&2
    exit 2
  }
  echo "${jsonTmp}" > package.json

  replace 's|Microsoft Corporation|PiCode|' package.json

  # electron.ts carries both the company name and the copyright line, and they
  # need different patterns: the first is the bare name, the second is preceded by
  # a year.
  replace 's|Microsoft Corporation|PiCode|' build/lib/electron.ts
  replace 's|([0-9]) Microsoft|\1 PiCode|' build/lib/electron.ts

  jsonTmp=$( jq '.name = "PiCode" | .short_name = "PiCode"' resources/server/manifest.json ) || {
    echo "error: jq could not rewrite resources/server/manifest.json." >&2
    exit 2
  }
  echo "${jsonTmp}" > resources/server/manifest.json

  cd ..
}

patch_stage_common() {
  echo "APP_NAME=\"${APP_NAME}\""
  echo "APP_NAME_LC=\"${APP_NAME_LC}\""
  echo "APP_VERSION=\"${APP_VERSION:-}\""
  echo "ASSETS_REPOSITORY=\"${ASSETS_REPOSITORY}\""
  echo "BINARY_NAME=\"${BINARY_NAME}\""
  echo "GH_REPO_PATH=\"${GH_REPO_PATH}\""
  echo "GLOBAL_DIRNAME=\"${GLOBAL_DIRNAME}\""
  echo "ORG_NAME=\"${ORG_NAME}\""
  echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""
  echo "TUNNEL_APP_NAME=\"${TUNNEL_APP_NAME}\""
}

patch_vscodium() {
  if [[ -z "${RELEASE_VERSION}" ]]; then
    echo "error: RELEASE_VERSION is empty; the patch templates need it (dev/get_repo.sh sets it)." >&2
    exit 2
  fi

  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  echo "--- applying patches/vscodium"

  patch_stage_common

  if [[ "${DISABLE_UPDATE}" == "yes" ]]; then
    apply_patch ../patches/vscodium/00-update-disable.patch.yet
  fi

  local file
  while IFS= read -r file; do
    if [[ -f "${file}" ]]; then
      apply_actions "${file}"
    fi
  done < <( sorted_action_files ../patches/vscodium )

  while IFS= read -r file; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done < <( sorted_patch_files ../patches/vscodium )

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    while IFS= read -r file; do
      if [[ -f "${file}" ]]; then
        apply_patch "${file}"
      fi
    done < <( sorted_patch_files ../patches/vscodium/insider )
  fi

  if [[ -d "../patches/vscodium/${OS_NAME}/" ]]; then
    while IFS= read -r file; do
      if [[ -f "${file}" ]]; then
        apply_patch "${file}"
      fi
    done < <( sorted_patch_files "../patches/vscodium/${OS_NAME}" )
  fi

  while IFS= read -r file; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done < <( sorted_patch_files ../patches/vscodium/user )

  cd ..
}

patch_picode() {
  if [[ -z "${RELEASE_VERSION}" ]]; then
    echo "error: RELEASE_VERSION is empty; the patch templates need it (dev/get_repo.sh sets it)." >&2
    exit 2
  fi

  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  echo "--- applying patches/picode"

  patch_stage_common

  local file
  # Removal actions first, then patches: the order VSCodium uses for its own set,
  # so a PiCode patch that edits a path a PiCode action deletes keeps working.
  while IFS= read -r file; do
    if [[ -f "${file}" ]]; then
      apply_actions "${file}"
    fi
  done < <( sorted_action_files ../patches/picode )

  while IFS= read -r file; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done < <( sorted_patch_files ../patches/picode )

  if [[ -d "../patches/picode/${OS_NAME}/" ]]; then
    while IFS= read -r file; do
      if [[ -f "${file}" ]]; then
        apply_patch "${file}"
      fi
    done < <( sorted_patch_files "../patches/picode/${OS_NAME}" )
  fi

  while IFS= read -r file; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done < <( sorted_patch_files ../patches/picode/user )

  cd ..
}

case "${STAGE}" in
  brand)
    brand_product_json
    ;;
  patches-vscodium)
    patch_vscodium
    ;;
  patches-picode)
    patch_picode
    ;;
  metadata)
    brand_package_metadata
    ;;
  all)
    brand_product_json
    patch_vscodium
    patch_picode
    brand_package_metadata
    ;;
  *)
    echo "usage: dev/prepare_vscode.sh [brand|patches-vscodium|patches-picode|metadata]" >&2
    exit 2
    ;;
esac
