#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Re-derives every PiCode patch, in the order the pipeline applies them.
#
#   ./dev/update_patches.sh
#
# Adapted from VSCodium's `dev/update_patches.sh` at the revision pinned in
# `upstream/vscodium.json`. The vendor script walks `patches/*.patch` plus the
# per-architecture directories and regenerates each one after an interactive
# conflict-resolution pass. This one walks `patches/picode/` (top level, then
# `patches/picode/${OS_NAME}/`, then `patches/picode/user/`) and keeps the same
# resolution pass.
#
# It differs from the vendor in two ways:
#
#   * The baseline is the real pipeline baseline (phases 2-5 through
#     `dev/build.sh -o -s`), so the patches are regenerated on top of the
#     inherited VSCodium set rather than on bare upstream.
#   * The reference state is the git index, not a stack of throwaway "VSCODIUM
#     HELPER" commits: each regenerated patch is `git diff` against the index,
#     and accepting it advances the index for the next patch. That is what makes
#     the pass cumulative.
#
# There is no `-i` (insider) flag: PiCode builds `stable` only.
#
# This rewrites `patches/picode/*.patch`. It never writes to
# `patches/vscodium/**`.

set -e

# include common functions
. ./dev/utils.sh

trap picode_cleanup_tmp EXIT

OS_NAME="${OS_NAME:-windows}"

if [[ ! -d "./vscode" ]]; then
  echo "error: ./vscode does not exist; run dev/build.sh once (or dev/build.sh -o) first." >&2
  exit 2
fi

# The list is an array, not a newline string, on purpose: the regeneration loop
# below runs an interactive `read` (dev/utils.sh, `picode_apply_for_edit`) while
# .rej files remain, and a `echo ... | while read` loop would feed that prompt from
# the pipe instead of the terminal. The prompt would then never wait for the
# developer and would eat the next line of the list, so patches would be
# regenerated against the wrong target. That was reproduced before this change.
PATCHES=()

add_patch_dir() {
  local dir="$1"
  local file

  while IFS= read -r file; do
    PATCHES+=("${file}")
  done < <( sorted_patch_files "${dir}" )
}

add_patch_dir "patches/picode"
add_patch_dir "patches/picode/${OS_NAME}"
add_patch_dir "patches/picode/user"

if (( ${#PATCHES[@]} == 0 )); then
  echo "No patches under patches/picode; nothing to regenerate."
  exit 0
fi

echo "patches to regenerate:"
for file in "${PATCHES[@]}"; do
  echo "  ${file}"
done

picode_reset_tree
picode_prepare_baseline

for file in "${PATCHES[@]}"; do
  echo ""
  echo "== ${file}"
  picode_apply_for_edit "${file}"
  picode_regenerate_patch "${file}"
  echo "${file} has been regenerated."
done

echo ""
echo "All PiCode patches were regenerated."
echo "The tree in ./vscode still carries them; the next run of this script resets it."
