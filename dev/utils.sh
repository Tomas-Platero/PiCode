#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Shared helpers for the PiCode source-build pipeline.
#
# Adapted from VSCodium's `utils.sh` at the revision pinned in
# `upstream/vscodium.json`. The following functions are vendored essentially
# verbatim so a PiCode build behaves like the VSCodium one it inherits:
#
#   apply_actions   applies a `*.json` removal action (used by `52-*.json` etc.)
#   apply_patch     templates the `!!VAR!!` placeholders and runs `git apply`
#   replace         portable `sed -i -E`
#   is_gnu_sed      detects GNU sed versus BSD sed
#   gsed            BSD-compatible wrapper when GNU sed is absent
#
# Two deliberate PiCode deviations from the vendored file:
#
#   1. `apply_patch` never edits the patch file in place. The VSCodium version
#      runs `cp patch{,.bak}`, rewrites the copy, applies it and moves the backup
#      back. That leaves the vendored tree dirty if the run dies in between, and
#      `patches/**` is frozen here. The copy is made in a temporary directory
#      instead, and the vendored file is only ever read.
#   2. `require_jq` and `sorted_patch_files` are additions. `jq` is a hard
#      dependency of the branding stage, and the patch order must not depend on
#      the machine's locale.
#
# This file is meant to be sourced, not executed.

APP_NAME="${APP_NAME:-PiCode}"
APP_NAME_LC="${APP_NAME_LC:-$( echo "${APP_NAME}" | awk '{print tolower($0)}' )}"
ASSETS_REPOSITORY="${ASSETS_REPOSITORY:-TomasPlatero/PiCode}"
BINARY_NAME="${BINARY_NAME:-picode}"
GH_REPO_PATH="${GH_REPO_PATH:-TomasPlatero/PiCode}"
ORG_NAME="${ORG_NAME:-TomasPlatero}"
TUNNEL_APP_NAME="${TUNNEL_APP_NAME:-"${BINARY_NAME}-tunnel"}"

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  GLOBAL_DIRNAME="${GLOBAL_DIRNAME:-"${APP_NAME_LC}"}-insiders"
else
  GLOBAL_DIRNAME="${GLOBAL_DIRNAME:-"${APP_NAME_LC}"}"
fi

# ---------------------------------------------------------------------------
# jq is required by the product branding stage and by the removal actions.
# ---------------------------------------------------------------------------
require_jq() {
  if ! command -v jq > /dev/null 2>&1; then
    echo "error: jq was not found on PATH." >&2
    echo "       The product branding stage rewrites picode-source/product.json with jq," >&2
    echo "       and the patches/vscodium/*.json removal actions read it too." >&2
    echo "       Install jq (https://jqlang.github.io/jq/download/) and re-run." >&2
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# Temporary directory for templated patch copies.
# ---------------------------------------------------------------------------
PICODE_TMP_DIR=""

# Sets PICODE_TMP_DIR (it does not echo it, so callers keep the variable in the
# current shell and the exit trap can clean it up).
picode_tmp_dir() {
  if [[ -z "${PICODE_TMP_DIR}" || ! -d "${PICODE_TMP_DIR}" ]]; then
    PICODE_TMP_DIR="$( mktemp -d "${TMPDIR:-/tmp}/picode-patches-XXXXXX" )" || {
      echo "error: could not create a temporary directory." >&2
      exit 1
    }
  fi
}

picode_cleanup_tmp() {
  if [[ -n "${PICODE_TMP_DIR}" && -d "${PICODE_TMP_DIR}" ]]; then
    rm -rf -- "${PICODE_TMP_DIR}"
  fi
  PICODE_TMP_DIR=""
}

# ---------------------------------------------------------------------------
# Patch globbing. `sort` is forced to the C locale so the order is the same on
# every machine, whatever LC_COLLATE the caller has.
# ---------------------------------------------------------------------------
sorted_patch_files() {
  local dir="$1"

  if [[ ! -d "${dir}" ]]; then
    return 0
  fi

  find "${dir}" -maxdepth 1 -type f -name '*.patch' -print | LC_ALL=C sort
}

sorted_action_files() {
  local dir="$1"

  if [[ ! -d "${dir}" ]]; then
    return 0
  fi

  find "${dir}" -maxdepth 1 -type f -name '*.json' -print | LC_ALL=C sort
}

# ---------------------------------------------------------------------------
# Vendored from VSCodium utils.sh (apply_actions).
# ---------------------------------------------------------------------------
apply_actions() {
  jq -c '.[]' "$1" | while IFS= read -r ENTRY; do
    ENTRY_ACTION=$( jq -r '.action // empty' <<< "${ENTRY}" )

    case "${ENTRY_ACTION}" in
      remove)
        jq -r '.paths[]' <<< "${ENTRY}" | while IFS= read -r ENTRY_PATH; do
          ENTRY_PATH="${ENTRY_PATH%$'\r'}"

          if [[ -e "${ENTRY_PATH}" ]]; then
            if rm -rf -- "${ENTRY_PATH}"; then
              echo "Removed: ${ENTRY_PATH}"
            else
              echo "Failed to remove: ${ENTRY_PATH}" >&2
              exit 4
            fi
          else
            echo "Not found: ${ENTRY_PATH}" >&2
            exit 4
          fi
        done
      ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Adapted from VSCodium utils.sh (apply_patch). The placeholders and the
# `git apply` call are the vendored ones; only the working copy changed, so
# `patches/**` is never written to.
# ---------------------------------------------------------------------------
apply_patch() {
  if [[ -z "$2" ]]; then
    echo "applying patch: $1"
  fi

  local source="$1"
  local work

  picode_tmp_dir
  work="${PICODE_TMP_DIR}/$( echo "${source}" | tr '/' '_' )"

  cp "${source}" "${work}"

  replace "s|!!APP_NAME!!|${APP_NAME}|g" "${work}"
  replace "s|!!APP_NAME_LC!!|${APP_NAME_LC}|g" "${work}"
  replace "s|!!ASSETS_REPOSITORY!!|${ASSETS_REPOSITORY}|g" "${work}"
  replace "s|!!BINARY_NAME!!|${BINARY_NAME}|g" "${work}"
  replace "s|!!GH_REPO_PATH!!|${GH_REPO_PATH}|g" "${work}"
  replace "s|!!GLOBAL_DIRNAME!!|${GLOBAL_DIRNAME}|g" "${work}"
  replace "s|!!ORG_NAME!!|${ORG_NAME}|g" "${work}"
  replace "s|!!RELEASE_VERSION!!|${RELEASE_VERSION}|g" "${work}"
  replace "s|!!TUNNEL_APP_NAME!!|${TUNNEL_APP_NAME}|g" "${work}"

  if ! git apply --ignore-whitespace "${work}"; then
    echo "failed to apply patch ${source}" >&2
    echo "the templated copy is kept at ${work} until this script exits" >&2
    exit 1
  fi
}

exists() { type -t "$1" &> /dev/null; }

# ---------------------------------------------------------------------------
# Patch authoring helpers, used by dev/patch.sh and dev/update_patches.sh.
#
# VSCodium's two scripts build their reference state out of throwaway
# "VSCODIUM HELPER" commits. PiCode does the same thing with the index instead:
# `git add -A` right after the baseline makes the index the reference, `git diff`
# then reports exactly what the patch under edit changed, and the index is
# advanced to accept it. No commit is created in the source clone, and
# `patches/**` is only read, or replaced by the tool the developer asked for.
# ---------------------------------------------------------------------------

# Brings ./picode-source back to the pinned source, discarding the preparation and
# anything a previous patch attempt left behind.
picode_reset_tree() {
  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  git add .
  git reset -q --hard HEAD
  git clean -qfd

  cd ..
}

# Phases 2-5 of the pipeline on a clean tree: the state a PiCode patch applies
# to. The tree is dirty afterwards, which is what `-s` recognises as "prepared".
picode_prepare_baseline() {
  bash dev/build.sh -o -s

  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }
  git add -A
  cd ..
}

# Writes the difference between the index (the baseline, plus every patch
# accepted so far) and the working tree to the patch file, then accepts it.
picode_regenerate_patch() {
  local target="$1"
  local tmp

  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  picode_tmp_dir
  tmp="${PICODE_TMP_DIR}/$( basename "${target}" )"

  # `-N` marks new files as tracked so they appear in the diff; `--binary` keeps
  # binary changes (icons, for instance) applicable.
  git add -N .

  # The patch is written to a temporary file first: a `git diff` that fails must
  # not leave a truncated patch behind, which is exactly what a redirect into the
  # target would do.
  if ! git diff --binary > "${tmp}"; then
    echo "error: git diff failed; ${target} was left untouched." >&2
    exit 1
  fi

  if [[ ! -s "${tmp}" ]]; then
    echo "error: the diff against the baseline is empty; ${target} was left untouched." >&2
    exit 1
  fi

  mv -f "${tmp}" "../${target}"
  git add -A

  cd ..
}

# Applies one patch the way the pipeline does (`--ignore-whitespace`), falls back
# to `--reject` and waits for the developer to resolve the leftovers.
picode_apply_for_edit() {
  local target="$1"

  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  if [[ ! -f "../${target}" ]]; then
    echo "error: ${target} does not exist." >&2
    exit 2
  fi

  echo "applying ${target} for editing"

  if ! git apply --ignore-whitespace --reject "../${target}"; then
    echo "${target} did not apply cleanly; resolve the .rej files, then continue."
  fi

  if [[ -n "$( find . -name '*.rej' -print -quit )" ]]; then
    echo "rejected hunks:"
    find . -name '*.rej' -print
    read -rp "Press any key when the conflicts have been resolved..." -n1 -s
    echo

    while [[ -n "$( find . -name '*.rej' -print -quit )" ]]; do
      echo "${target} still has .rej files; delete each one you have resolved."
      find . -name '*.rej' -print
      read -rp "Press any key when the conflicts have been resolved..." -n1 -s
      echo
    done
  fi

  cd ..
}

is_gnu_sed() {
  sed --version &> /dev/null
}

replace() {
  if is_gnu_sed; then
    sed -i -E "${1}" "${2}"
  else
    sed -i '' -E "${1}" "${2}"
  fi
}

if ! exists gsed; then
  if is_gnu_sed; then
    function gsed() {
      sed -i -E "$@"
    }
  else
    function gsed() {
      sed -i '' -E "$@"
    }
  fi
fi
