#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Re-derives one PiCode patch from a working tree.
#
#   ./dev/patch.sh <name>          edits patches/picode/<name>.patch
#   ./dev/patch.sh <name>.patch    same thing
#
# Adapted from VSCodium's `dev/patch.sh` at the revision pinned in
# `upstream/vscodium.json`. It keeps the vendor's flow - reset, rebuild the
# baseline, apply the patch under edit with `--reject`, wait for the developer,
# write the patch back - and differs in three ways:
#
#   * The patches live in `patches/picode/`, never in `patches/vscodium/`.
#     `patches/vscodium/**` is vendored verbatim and is only read.
#   * The baseline is the real pipeline baseline (phases 2-5 through
#     `dev/build.sh -o -s`), not just VSCodium's `helper/settings.patch`. A
#     PiCode patch must compose with the whole inherited set, so that is what it
#     is authored against. `helper/settings.patch` is VSCodium's own normalizer
#     for `.vscode/settings.json` diffs and has no counterpart here.
#   * The regenerated patch comes from the index (`git diff`), so no throwaway
#     commit is created in the source clone.
#
# The placeholders (`!!APP_NAME!!`, `!!RELEASE_VERSION!!`, …) are only ever in
# added lines, so the patch is applied here as it is written; `dev/utils.sh`
# expands them when the pipeline applies it.

set -e

# include common functions
. ./dev/utils.sh

trap picode_cleanup_tmp EXIT

if [[ $# -ne 1 ]]; then
  echo "usage: dev/patch.sh <name>" >&2
  echo "       edits patches/picode/<name>.patch; <name> may include the .patch suffix" >&2
  exit 2
fi

if [[ ! -d "./vscode" ]]; then
  echo "error: ./vscode does not exist; run dev/build.sh once (or dev/build.sh -o) first." >&2
  exit 2
fi

TARGET="patches/picode/${1}"
if [[ "${TARGET}" != *.patch ]]; then
  TARGET="${TARGET}.patch"
fi

if [[ ! -f "${TARGET}" ]]; then
  echo "error: ${TARGET} does not exist." >&2
  echo "       A new patch starts from the file the pipeline should apply; create it with" >&2
  echo "       'git diff' inside ./vscode against the prepared tree, then edit it here." >&2
  exit 2
fi

echo "target patch: ${TARGET}"

picode_reset_tree
picode_prepare_baseline
picode_apply_for_edit "${TARGET}"
picode_regenerate_patch "${TARGET}"

echo ""
echo "${TARGET} has been regenerated."
echo "The tree in ./vscode still carries the patch; the next run of this script resets it."
