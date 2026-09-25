#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Stages the PiCode distribution layer onto a freshly packed editor tree.
#
# The binary release path does this with `distribution/apply-picode.ps1`, which
# runs against the VSCodium tree at the repository root. A source build produces
# `./PiCode-Win32-x64` instead, and the PowerShell script derives its root from
# its own location, so it cannot be pointed at it without moving the pack output
# onto the frozen release tree. This script performs the same actions on the pack
# output, in the same order and with the same idempotence.
#
# The Windows ICON inside the packed tree (`resources/app/resources/win32/code.ico`)
# is still replaced here, but that is now a belt-and-braces copy, not the fix.
#
# The icon the executable actually carries is decided by `rcedit` while the source
# tree is PACKED, from `vscode/resources/win32/code.ico`, and the Start Menu tiles
# are copied by the same pack. So the real branding happens in
# `dev/prepare_vscode.sh` (`brand_windows_icons`, in the `metadata` stage), before
# phase 7. Replacing anything here cannot change what the executable already has:
# measured, the packed `PiCode.exe` used to keep VS Code's icon while this script
# reported "replaced resources/win32/code.ico". This copy stays so that a tree
# packed elsewhere still ends up internally consistent, and it is idempotent.
#
# Usage: dev/stage-distribution.sh [pack-dir]   (default ./PiCode-Win32-x64)
#
# Idempotent: a second run reports every step as already current.

set -eo pipefail

# include common functions (`picode_tmp_dir` and its cleanup)
. ./dev/utils.sh

picode_tmp_dir
MARK_WORK="${PICODE_TMP_DIR}"

trap picode_cleanup_tmp EXIT

PACK_DIR="${1:-./PiCode-Win32-x64}"

if [[ ! -d "${PACK_DIR}" ]]; then
  echo "error: the pack output ${PACK_DIR} does not exist." >&2
  exit 2
fi

PACK_DIR="$( cd "${PACK_DIR}" && pwd )"

PRODUCT_JSON="${PACK_DIR}/resources/app/product.json"
DELTA="./distribution/product-delta.json"
APPLIER="./distribution/apply-product-delta.mjs"
SETTINGS_SOURCE="./distribution/settings.json"

EXTENSION_SOURCE="./extensions/picode-pi-chat"
EXTENSION_TARGET="${PACK_DIR}/resources/app/extensions/picode-pi-chat"

for required in "${PRODUCT_JSON}" "${DELTA}" "${APPLIER}" "${SETTINGS_SOURCE}"; do
  if [[ ! -e "${required}" ]]; then
    echo "error: a required file is missing: ${required}" >&2
    exit 2
  fi
done

if ! command -v node > /dev/null 2>&1; then
  echo "error: node was not found on PATH; the product delta is applied by a node program." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Step 1 - the product delta
# ---------------------------------------------------------------------------
echo "--- step 1/8 - product delta in resources/app/product.json"

set +e
node "${APPLIER}" --target "${PRODUCT_JSON}" --delta "${DELTA}" --check
DELTA_CHECK=$?
set -e

if [[ "${DELTA_CHECK}" -eq 2 ]]; then
  echo "error: the product delta could not be evaluated (applier exit code 2). Nothing was written." >&2
  exit 2
fi

if [[ "${DELTA_CHECK}" -eq 0 ]]; then
  echo "skipped: the product already matches the delta"
elif [[ "${DELTA_CHECK}" -eq 1 ]]; then
  BACKUP="${PRODUCT_JSON}.picode-backup-$( date +%Y%m%d-%H%M%S )"
  cp "${PRODUCT_JSON}" "${BACKUP}"
  echo "backup: ${BACKUP}"

  node "${APPLIER}" --target "${PRODUCT_JSON}" --delta "${DELTA}" --write
else
  echo "error: unexpected applier exit code: ${DELTA_CHECK}" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Step 2 - the portable profile
# ---------------------------------------------------------------------------
echo "--- step 2/8 - portable profile in data/"

for dir in "user-data" "extensions" "tmp"; do
  if [[ -d "${PACK_DIR}/data/${dir}" ]]; then
    echo "skipped: data/${dir} already exists"
  else
    mkdir -p "${PACK_DIR}/data/${dir}"
    echo "created data/${dir}"
  fi
done

# ---------------------------------------------------------------------------
# Step 3 - first-run defaults
# ---------------------------------------------------------------------------
echo "--- step 3/8 - first-run defaults"

SETTINGS_TARGET="${PACK_DIR}/data/user-data/User/settings.json"

if [[ -e "${SETTINGS_TARGET}" ]]; then
  if cmp -s "${SETTINGS_SOURCE}" "${SETTINGS_TARGET}"; then
    echo "skipped: settings.json is already the shipped default"
  else
    echo "!! the user already has settings at ${SETTINGS_TARGET}"
    echo "   a distribution must not clobber user settings; merge by hand from ${SETTINGS_SOURCE}"
  fi
else
  mkdir -p "$( dirname "${SETTINGS_TARGET}" )"
  cp "${SETTINGS_SOURCE}" "${SETTINGS_TARGET}"
  echo "wrote ${SETTINGS_TARGET}"
fi

# ---------------------------------------------------------------------------
# Step 4 - the agent panel as a built-in extension
# ---------------------------------------------------------------------------
echo "--- step 4/8 - retired: PiCode's own panel is no longer shipped"

# The owner removed PiCode's own chat on 2026-09-24: the editor's chat is the surface, and
# the panel this step staged belongs to the extension being migrated into the core. The
# branch below is deliberately unreachable — `if true` and not a missing file, so that a
# half-built tree cannot fall into it — and it stays only until the migration deletes it
# along with the rest of the extension. Nothing here copies the panel any more.
if true; then
  echo "skipped: the panel was retired; the editor's own chat is the surface now"
else
  # The same exclusion rules as `distribution/apply-picode.ps1` (and the
  # extension's .vscodeignore): sources, tests, the toolchain and packaging state
  # never reach the editor tree.
  ships() {
    local relative="$1"

    case "${relative}" in
      src/* | test/* | node_modules/* | .atl/* | .vscode/*) return 1 ;;
      .gitignore | .vscodeignore | package-lock.json | tsconfig.json) return 1 ;;
      *.map | *.vsix) return 1 ;;
    esac
    return 0
  }

  SHIPPED=0
  CHANGED=0
  STALE=0

  if [[ -d "${EXTENSION_TARGET}" ]]; then
    while IFS= read -r existing; do
      relative="${existing#"${EXTENSION_TARGET}/"}"
      if ! ships "${relative}" || [[ ! -f "${EXTENSION_SOURCE}/${relative}" ]]; then
        rm -f "${existing}"
        STALE=$(( STALE + 1 ))
      fi
    done < <( find "${EXTENSION_TARGET}" -type f )
  fi

  while IFS= read -r source; do
    relative="${source#"${EXTENSION_SOURCE}/"}"

    if ! ships "${relative}"; then
      continue
    fi

    SHIPPED=$(( SHIPPED + 1 ))

    if [[ ! -f "${EXTENSION_TARGET}/${relative}" ]] || ! cmp -s "${source}" "${EXTENSION_TARGET}/${relative}"; then
      mkdir -p "$( dirname "${EXTENSION_TARGET}/${relative}" )"
      cp -f "${source}" "${EXTENSION_TARGET}/${relative}"
      CHANGED=$(( CHANGED + 1 ))
    fi
  done < <( find "${EXTENSION_SOURCE}" -type f )

  if [[ "${CHANGED}" -eq 0 && "${STALE}" -eq 0 ]]; then
    echo "skipped: the built-in extension is already current (${SHIPPED} files)"
  else
    echo "staged ${CHANGED} file(s) of ${SHIPPED}; removed ${STALE} stale file(s)"
  fi

  # A built-in extension that still carries sources would be caught above by the
  # exclusion rules; this is the guard that they were not silently skipped.
  if [[ -d "${EXTENSION_TARGET}/src" || -d "${EXTENSION_TARGET}/node_modules" ]]; then
    echo "warning: sources or node_modules are still present in ${EXTENSION_TARGET}" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Step 5 - the names Windows shows
# ---------------------------------------------------------------------------
echo "--- step 5/8 - visible names"

# The pack output names the executable after `product.nameShort`, which the
# product delta makes "PiCode" *before* packing, so this normally finds the name
# already right. It stays tolerant for the other spellings because the packing
# task and a hand-rebuilt tree have produced VSCodium's and VS Code's names.
rename_if_needed() {
  local from="${1}"
  local to="${2}"

  if [[ -e "${from}" ]]; then
    mv -f "${from}" "${to}"
    echo "renamed $( basename "${from}" ) to $( basename "${to}" )"
  elif [[ -e "${to}" ]]; then
    echo "skipped: already named $( basename "${to}" )"
  else
    echo "warning: neither $( basename "${from}" ) nor $( basename "${to}" ) exists" >&2
  fi
}

for candidate in "VSCodium.exe" "VSCode.exe" "code.exe" "Code.exe"; do
  if [[ -e "${PACK_DIR}/${candidate}" ]]; then
    rename_if_needed "${PACK_DIR}/${candidate}" "${PACK_DIR}/PiCode.exe"
    break
  fi
done

if [[ ! -e "${PACK_DIR}/PiCode.exe" ]]; then
  echo "warning: no editor executable was renamed; expected one of VSCodium/VSCode/code.exe" >&2
fi

for candidate in "codium.cmd" "code.cmd"; do
  if [[ -e "${PACK_DIR}/bin/${candidate}" ]]; then
    rename_if_needed "${PACK_DIR}/bin/${candidate}" "${PACK_DIR}/bin/picode.cmd"
    break
  fi
done

for candidate in "codium" "code"; do
  if [[ -e "${PACK_DIR}/bin/${candidate}" ]]; then
    rename_if_needed "${PACK_DIR}/bin/${candidate}" "${PACK_DIR}/bin/picode"
    break
  fi
done

for candidate in "VSCodium.VisualElementsManifest.xml" "VSCode.VisualElementsManifest.xml" "code.VisualElementsManifest.xml"; do
  if [[ -e "${PACK_DIR}/${candidate}" ]]; then
    rename_if_needed "${PACK_DIR}/${candidate}" "${PACK_DIR}/PiCode.VisualElementsManifest.xml"
    break
  fi
done

# The shims and the manifest name the executable inside their own text, so a
# rename is not enough for them.
fix_text() {
  local file="${1}"
  local find="${2}"
  local replacement="${3}"

  if [[ ! -f "${file}" ]]; then
    echo "skipped: $( basename "${file}" ) is not there"
    return
  fi

  if ! grep -q -- "${find}" "${file}"; then
    echo "skipped: $( basename "${file}" ) no longer names ${find}"
    return
  fi

  replace "s|${find}|${replacement}|g" "${file}"
  echo "updated $( basename "${file}" )"
}

fix_text "${PACK_DIR}/bin/picode.cmd" "VSCodium.exe" "PiCode.exe"
fix_text "${PACK_DIR}/bin/picode" 'NAME="VSCodium"' 'NAME="PiCode"'
fix_text "${PACK_DIR}/PiCode.VisualElementsManifest.xml" 'ShortDisplayName="VSCodium"' 'ShortDisplayName="PiCode"'

# ---------------------------------------------------------------------------
# Step 6 - the icons inside the application
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Step 5b - the icon Linux uses
# ---------------------------------------------------------------------------
# Windows wants an `.ico` (step 6) and Linux wants a PNG, and Linux takes it from `resources/linux/`:
# with VS Code's logo there, the window and the launcher of a PiCode build wear somebody else's face.
# The drawing is the same one, and the `.ico` already carries PNG frames inside it, so nothing else
# is needed to produce it.
if [[ "${OS_NAME:-windows}" == "linux" ]]; then
  LINUX_ICONS_DIR="${PACK_DIR}/resources/app/resources/linux"
  if [[ -d "${LINUX_ICONS_DIR}" ]]; then
    for candidate in code.png code-oss.png; do
      if [[ -f "${LINUX_ICONS_DIR}/${candidate}" ]]; then
        if node dev/ico-to-png.mjs ./distribution/picode.ico "${LINUX_ICONS_DIR}/${candidate}"; then
          echo "drew ${candidate} with the PiCode mark"
        fi
      fi
    done
  else
    echo "skipped: there is no resources/linux in this pack"
  fi
fi

echo "--- step 6/8 - icons inside the application"

MARK_SOURCE="./distribution/picode-icon.svg"
WATERMARK_SOURCE="./distribution/picode.svg"

if [[ ! -f "${MARK_SOURCE}" ]]; then
  echo "warning: no mark at ${MARK_SOURCE}; the icons inside the application were left alone." >&2
else
  # The owner's asset carries a C2PA provenance manifest - some 8 kB of base64 in
  # the middle of the SVG - which belongs in the repository history, not in every
  # shipped copy of the icon. `sed -z` treats the file as one line, so the
  # multi-line element is removed in one pass.
  #
  # This FAILS LOUDLY instead of falling back to the untrimmed file. An earlier
  # version ended this command with `|| cp "${MARK_SOURCE}" ...`, which meant that
  # on any sed that does not take `-z` the build silently shipped the C2PA
  # metadata inside every icon -- the exact thing this step exists to prevent. A
  # fallback that produces the unwanted artefact is worse than no fallback.
  strip_svg_metadata() {
    local source="$1"
    local destination="$2"

    if ! sed -z -E \
      -e 's|<metadata>.*</metadata>||' \
      -e 's| xmlns:c2pa="[^"]*"||' \
      "${source}" > "${destination}"; then
      echo "error: sed -z could not strip the metadata from $( basename "${source}" )." >&2
      echo "       GNU sed is required for this step (Git Bash provides it). The build stops" >&2
      echo "       here because shipping the embedded C2PA provenance is not acceptable." >&2
      exit 1
    fi

    if [[ ! -s "${destination}" ]]; then
      echo "error: stripping the metadata from $( basename "${source}" ) produced an empty file." >&2
      exit 1
    fi
  }

  strip_svg_metadata "${MARK_SOURCE}" "${MARK_WORK}/mark.svg"

  if [[ -f "${WATERMARK_SOURCE}" ]]; then
    strip_svg_metadata "${WATERMARK_SOURCE}" "${MARK_WORK}/watermark.svg"
  else
    echo "warning: no line-drawing mark at ${WATERMARK_SOURCE}; the watermarks use the icon mark." >&2
    cp "${MARK_WORK}/mark.svg" "${MARK_WORK}/watermark.svg"
  fi

  # Every asset in the tree that carries the upstream logo, relative to
  # resources/app (they do not all live under out/media).
  for relative in \
    "out/media/code-icon.svg" \
    "out/media/vscode-icon.svg" \
    "out/media/sessions-icon.svg" \
    "out/media/sessions-logo-dark.svg" \
    "out/media/sessions-logo-light.svg"
  do
    target="${PACK_DIR}/resources/app/${relative}"
    if [[ ! -f "${target}" ]]; then
      echo "skipped: ${relative} is not there"
      continue
    fi
    if cmp -s "${MARK_WORK}/mark.svg" "${target}"; then
      echo "skipped: ${relative} already carries the PiCode mark"
      continue
    fi
    cp -f "${MARK_WORK}/mark.svg" "${target}"
    echo "drew ${relative} with the PiCode mark"
  done

  # The watermarks an empty editor draws behind its hints take the line drawing,
  # not the mark with its plate.
  for relative in \
    "out/media/letterpress-dark.svg" \
    "out/media/letterpress-light.svg" \
    "out/media/letterpress-hcDark.svg" \
    "out/media/letterpress-hcLight.svg" \
    "out/vs/sessions/contrib/chat/browser/media/letterpress-sessions-dark.svg" \
    "out/vs/sessions/contrib/chat/browser/media/letterpress-sessions-light.svg"
  do
    target="${PACK_DIR}/resources/app/${relative}"
    if [[ ! -f "${target}" ]]; then
      echo "skipped: ${relative} is not there"
      continue
    fi
    if cmp -s "${MARK_WORK}/watermark.svg" "${target}"; then
      echo "skipped: ${relative} already carries the PiCode line mark"
      continue
    fi
    cp -f "${MARK_WORK}/watermark.svg" "${target}"
    echo "drew ${relative} with the PiCode line mark"
  done

  ICO_TARGET="${PACK_DIR}/resources/app/resources/win32/code.ico"
  ICO_SOURCE="./distribution/picode.ico"
  if [[ -f "${ICO_TARGET}" && -f "${ICO_SOURCE}" ]]; then
    cp -f "${ICO_SOURCE}" "${ICO_TARGET}"
    echo "replaced resources/win32/code.ico (in-app copy)"
  else
    echo "skipped: resources/win32/code.ico is not there or ${ICO_SOURCE} is missing"
  fi

  # The icon inside the executable and the Start Menu tiles were branded before the
  # pack, by dev/prepare_vscode.sh (stage `metadata`). This only reports what the
  # packed tree carries, because the executable cannot be changed from here.
  if [[ -f "${PACK_DIR}/resources/app/resources/win32/code_150x150.png" ]]; then
    echo "note: the executable's icon and the Start Menu tiles come from the preparation"
    echo "      (dev/prepare_vscode.sh metadata), not from this script."
  fi
fi

# ---------------------------------------------------------------------------
# Step 7 - the editor's own copy says PiCode
# ---------------------------------------------------------------------------
echo "--- step 7/8 - PiCode, in the editor's own text"

# The editor is built from VS Code's source and its text says so: measured, 196 of its 24,697
# strings name VS Code or VSCodium, and those are the ones a person reads in the settings, in the
# panels and in the extension list. The rewrite keeps identifiers, URLs and the licence files.
node dev/brand-copy.mjs "${PACK_DIR}"

# ---------------------------------------------------------------------------
# Step 8 - the weight that is not the product
# ---------------------------------------------------------------------------
echo "--- step 8/8 - maps and locales"

# The editor's source maps are for debugging the code that ships already bundled: measured, 307 MB
# of the 366 MB the packed `out` weighs, in thirty files. This repository builds from the source, so
# the maps are always one command away and the distribution does not need to carry them. The patch
# that removes their URLs (`02-remove-inherited-sourcemap-url.patch`) is the same decision, taken
# earlier.
# `find -printf` and `awk`, not an unquoted `$(find …)` inside `du`: a path with a space in it would
# have been split into two arguments and the measurement would have been of something else.
MAPS_BEFORE=$( find "${PACK_DIR}/resources/app/out" -name '*.map' -printf '%s
' 2> /dev/null | awk '{ total += $1 } END { print int(total / 1048576) }' )
find "${PACK_DIR}/resources/app/out" -name '*.map' -delete 2> /dev/null || true
echo "removed the source maps: ${MAPS_BEFORE:-0} MB"

# Chromium's own interface translations, which the editor does not use (its text comes from its own
# tables, which is what a language pack replaces). English is the product's language and Spanish is
# the one a pack will switch it to, and the native shell needs its own file for each.
if [[ -d "${PACK_DIR}/locales" ]]; then
  LOCALES_BEFORE=$( du -sm "${PACK_DIR}/locales" 2> /dev/null | cut -f1 )
  for locale in "${PACK_DIR}/locales"/*.pak; do
    case "$( basename "${locale}" )" in
      en-US.pak | es.pak) continue ;;
    esac
    rm -f "${locale}"
  done
  LOCALES_AFTER=$( du -sm "${PACK_DIR}/locales" 2> /dev/null | cut -f1 )
  echo "kept en-US.pak and es.pak: ${LOCALES_BEFORE:-0} MB -> ${LOCALES_AFTER:-0} MB"
fi

echo "--- staging complete: ${PACK_DIR}"
