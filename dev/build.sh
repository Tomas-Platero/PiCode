#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# PiCode's source-build entry point (VSCodium's model: patch the source, not the
# binary).
#
#   ./dev/build.sh        fetch, prepare, install, compile, stage
#   ./dev/build.sh -o     stop after the preparation (no npm install, no compile)
#   ./dev/build.sh -s     reuse the existing ./vscode instead of fetching it
#
# Adapted from VSCodium's `dev/build.sh` at the revision pinned in
# `upstream/vscodium.json`. Where it differs:
#
#   * PiCode sets its own identity here (APP_NAME, BINARY_NAME, ORG_NAME, the
#     asset and GitHub paths, GLOBAL_DIRNAME, TUNNEL_APP_NAME). VSCodium derives
#     the same variables from an `-i` insider flag and its own constants.
#   * Only `-o` and `-s` exist. The `-i` (insider), `-l` (latest) and `-p`
#     (assets) flags of VSCodium build what PiCode does not publish; the
#     prebuilt-ZIP release path is `distribution/apply-picode.ps1` and is
#     untouched.
#   * An unknown OSTYPE is a hard error. In the vendored script an unset OSTYPE
#     falls through to `linux`, which here would silently glob
#     `patches/vscodium//*.patch` and apply the whole top-level set twice.
#   * The phases are PiCode's: fetch, brand, VSCodium patches, PiCode patches,
#     package metadata, product delta, built-in extension + npm ci, compile+pack,
#     stage. VSCodium folds preparation into `prepare_vscode.sh` and stops there.
#   * `-o` stops after phase 5 and does not compile, so the preparation can be
#     verified without a 20-minute build.
#
# `-s` reuses `./vscode` as it is:
#   * a clean tree (freshly fetched, never prepared) goes through phases 2-5;
#   * a dirty tree is a *prepared* tree, so phases 1-5 are skipped and the build
#     resumes at phase 6, which is what VSCodium's SKIP_SOURCE does.
#
# Nothing in this pipeline writes to `patches/**`, `distribution/**`,
# `extensions/**` or `.git/**`: the patch templates are expanded into a temporary
# copy (`dev/utils.sh`).

set -eo pipefail

# ---------------------------------------------------------------------------
# PiCode identity
# ---------------------------------------------------------------------------
export APP_NAME="PiCode"
export APP_NAME_LC="picode"
export BINARY_NAME="picode"
export ORG_NAME="TomasPlatero"
export ASSETS_REPOSITORY="TomasPlatero/PiCode"
export GH_REPO_PATH="TomasPlatero/PiCode"
export GLOBAL_DIRNAME="picode"
export TUNNEL_APP_NAME="picode-tunnel"
export VSCODE_QUALITY="stable"
export CI_BUILD="no"
export SKIP_ASSETS="yes"
export VSCODE_SKIP_NODE_VERSION_CHECK="yes"
export NODE_OPTIONS="--max-old-space-size=8192"

REUSE_TREE="no"
SKIP_COMPILE="no"

usage() {
  cat <<'EOF' >&2
usage: ./dev/build.sh [-s] [-o]

  (no flag)  fetch the pinned VS Code source, prepare it, install, compile, stage
  -s         reuse the existing ./vscode instead of fetching it
  -o         stop after the preparation (phase 5); no npm install, no compile
EOF
}

while getopts ":soh" opt; do
  case "$opt" in
    s)
      REUSE_TREE="yes"
      ;;
    o)
      SKIP_COMPILE="yes"
      ;;
    h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option -${OPTARG}" >&2
      usage
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# OS_NAME. Mandatory: `patches/vscodium/${OS_NAME}/` and
# `patches/picode/${OS_NAME}/` are selected with it.
# ---------------------------------------------------------------------------
case "${OSTYPE}" in
  msys* | cygwin*)
    export OS_NAME="windows"
    ;;
  darwin*)
    export OS_NAME="osx"
    ;;
  linux*)
    export OS_NAME="linux"
    ;;
  *)
    echo "error: OSTYPE is '${OSTYPE}', and no OS_NAME can be derived from it." >&2
    echo "       The patch stage needs it to pick patches/<set>/\${OS_NAME}/*.patch." >&2
    exit 2
    ;;
esac

UNAME_ARCH=$( uname -m )

if [[ "${UNAME_ARCH}" == "aarch64" || "${UNAME_ARCH}" == "arm64" ]]; then
  export VSCODE_ARCH="arm64"
else
  export VSCODE_ARCH="x64"
fi

# The pack directory, named for the product and for the system being packed. The task that writes it
# is `vscode-<platform>-<arch>-min-packing`, and the directory name is set in the gulpfiles
# (`patches/picode/16` and `17`), so the two have to agree: this is the same table.
case "${OS_NAME}" in
  windows)
    PACK_PLATFORM="win32"
    PACK_DIR="./PiCode-Win32-${VSCODE_ARCH}"
    ;;
  linux)
    PACK_PLATFORM="linux"
    PACK_DIR="./PiCode-linux-${VSCODE_ARCH}"
    ;;
  *)
    echo "error: packing for OS_NAME='${OS_NAME}' is not set up yet." >&2
    echo "       Windows and Linux are; macOS needs its own buildPath in build/gulpfile.vscode.ts" >&2
    echo "       (the same one-line rename) and then a case here." >&2
    exit 2
    ;;
esac

echo "OS_NAME=\"${OS_NAME}\""
echo "VSCODE_ARCH=\"${VSCODE_ARCH}\""
echo "VSCODE_QUALITY=\"${VSCODE_QUALITY}\""
echo "REUSE_TREE=\"${REUSE_TREE}\""
echo "SKIP_COMPILE=\"${SKIP_COMPILE}\""

require_tool() {
  if ! command -v "$1" > /dev/null 2>&1; then
    echo "error: $1 was not found on PATH." >&2
    echo "       $2" >&2
    exit 2
  fi
}

require_tool jq "The product branding stage rewrites vscode/product.json with jq (install jq)."
require_tool git "The source is fetched and patched with git."
require_tool node "The product delta is applied by node, and the build runs npm."

# ---------------------------------------------------------------------------
# Is ./vscode already a prepared tree?
# ---------------------------------------------------------------------------
TREE_PREPARED="no"

if [[ "${REUSE_TREE}" == "yes" && -d "./vscode/.git" ]]; then
  if [[ -n "$( git -C ./vscode status --porcelain )" ]]; then
    TREE_PREPARED="yes"
  fi
fi

# ---------------------------------------------------------------------------
# Phase 1 - fetch the source
# ---------------------------------------------------------------------------
echo ""
echo "== phase 1/8 - fetch the pinned VS Code source"

if [[ "${TREE_PREPARED}" == "yes" ]]; then
  echo "skipped: ./vscode is already prepared (reused by -s)"
elif [[ "${REUSE_TREE}" == "yes" ]]; then
  . ./dev/get_repo.sh --reuse
else
  for stale in ./vscode ./VSCode-* ./vscode-*; do
    if [[ -e "${stale}" ]]; then
      echo "removing ${stale}"
      rm -rf -- "${stale}"
    fi
  done

  . ./dev/get_repo.sh --fetch
fi

if [[ "${TREE_PREPARED}" != "yes" ]]; then
  . ./dev/version.sh
  echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""
  echo "BUILD_SOURCEVERSION=\"${BUILD_SOURCEVERSION}\""
else
  # The pins are still needed by the phases below; deriving them reads no network.
  . ./dev/get_repo.sh --reuse
  . ./dev/version.sh
fi

# ---------------------------------------------------------------------------
# PiCode's own product version
# ---------------------------------------------------------------------------
# The updater compares `product.json.version` — which the packer injects from
# `package.json.version` — against the feed's `productVersion`. Sealing the raw VS Code
# tag made every PiCode release report the same version, so a newer PiCode could never
# look newer than an older one.
#
# The version has ONE home: `set.version` in `distribution/product-delta.json`. Both paths
# already apply that file — this build in phase 5, and `distribution/apply-picode.ps1` onto
# the packaged tree — so the compiled editor and the released one cannot disagree. Bumping
# a release is editing that one value.
#
# The major.minor stay VS Code's on purpose: every extension's `engines.vscode`
# (e.g. `^1.90.0`) is matched against this version, so an independent numbering would make
# every extension look incompatible.
#
# `RELEASE_VERSION` is deliberately NOT changed: the vendored patches build asset URLs out
# of it, and the published assets are named after the VS Code tag.
if [[ ! -f ./distribution/product-delta.json ]]; then
  echo "error: ./distribution/product-delta.json is missing; it carries the product version." >&2
  exit 2
fi

APP_VERSION=$( jq -r '.set.version // empty' ./distribution/product-delta.json )
if [[ -z "${APP_VERSION}" ]]; then
  echo "error: distribution/product-delta.json does not set a 'version'." >&2
  exit 2
fi
export APP_VERSION

echo "APP_VERSION=\"${APP_VERSION}\""

if [[ "${TREE_PREPARED}" == "yes" ]]; then
  # -------------------------------------------------------------------------
  # Phases 2-5 are exactly what the tree already carries.
  # -------------------------------------------------------------------------
  echo ""
  echo "== phases 2-5/8 - skipped: ./vscode is the prepared tree (reused by -s)"
else
  # -------------------------------------------------------------------------
  # Phase 2 - brand product.json
  # -------------------------------------------------------------------------
  echo ""
  echo "== phase 2/8 - brand vscode/product.json (jq)"

  bash dev/prepare_vscode.sh brand

  # -------------------------------------------------------------------------
  # Phase 3 - the inherited VSCodium patch set
  # -------------------------------------------------------------------------
  echo ""
  echo "== phase 3/8 - apply patches/vscodium"

  bash dev/prepare_vscode.sh patches-vscodium

  # -------------------------------------------------------------------------
  # Phase 4 - PiCode's own patches, then the package metadata
  # -------------------------------------------------------------------------
  echo ""
  echo "== phase 4/8 - apply patches/picode"

  bash dev/prepare_vscode.sh patches-picode

  # The package.json version/author and the electron company name are not part of
  # any patch: VSCodium writes them with `replace`/`setpath` after its patch stage,
  # and so does this. Without it the compiled product reports the upstream version
  # while its asset URLs report PiCode's, and `Microsoft Corporation` survives into
  # the binary's properties.
  bash dev/prepare_vscode.sh metadata

  # -------------------------------------------------------------------------
  # Phase 5 - the frozen product delta
  # -------------------------------------------------------------------------
  echo ""
  echo "== phase 5/8 - apply distribution/product-delta.json to vscode/product.json"

  set +e
  node distribution/apply-product-delta.mjs \
    --target vscode/product.json \
    --delta distribution/product-delta.json \
    --write
  DELTA_EXIT=$?
  set -e

  if [[ "${DELTA_EXIT}" -ne 0 ]]; then
    echo "error: the product delta failed with exit code ${DELTA_EXIT} (2 = error, 0 = applied or already current)." >&2
    exit "${DELTA_EXIT}"
  fi
fi

if [[ "${SKIP_COMPILE}" == "yes" ]]; then
  echo ""
  echo "== phase 5/8 reached. -o was given: nothing was compiled."
  echo "prepared tree:  ./vscode"
  echo "pack output:    ${PACK_DIR} (not created yet)"
  echo "next:           ./dev/build.sh -s   to install, compile and stage"
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase 6 - the source dependencies
# ---------------------------------------------------------------------------
# The step that staged `extensions/picode-pi-chat` as a built-in extension was **removed on
# 2026-09-24 by the owner's decision**: pi lives in the core, and the extension is being
# migrated into it (Chat and the agentic machinery the editor already ships). The extension
# directory is kept in the repository only as the source being migrated — nothing compiles
# it and nothing packages it, so a build no longer contains it.
#
# What that costs today, said plainly: the built editor has no chat until the core provider
# is finished. `dev/builtin-extension.sh` was deleted with this step; restoring it is how
# the old surface comes back if the migration has to be paused.
echo ""
echo "== phase 6/8 - npm ci"

cd vscode || { echo "'vscode' dir not found"; exit 1; }

export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

node build/npm/preinstall.ts

for i in {1..5}; do # try 5 times
  if npm ci; then
    break
  fi

  if [[ $i == 5 ]]; then
    echo "Npm install failed too many times" >&2
    exit 1
  fi
  echo "Npm install failed $i, trying again..."

  sleep $(( 15 * (i + 1) ))
done

cd ..

# ---------------------------------------------------------------------------
# Phase 6b - the connector
# ---------------------------------------------------------------------------
# PiCode's connector (`vscode/extensions/picode`) is compiled **here and not by the packer**:
# the packing step collects every extension under `vscode/extensions/` — which is how the
# connector gets inside the binary — but it does not run `tsc` for it, and an extension
# packaged without its `out/` never activates. It runs after `npm ci` because it compiles with
# the tree's own typings, and before the pack because the pack is what collects it.
#
echo ""
echo "== phase 6b/8 - compile the connector"

bash dev/build-connector.sh

cd vscode || { echo "'vscode' dir not found"; exit 1; }

# ---------------------------------------------------------------------------
# Phase 7 - compile and pack
# ---------------------------------------------------------------------------
echo ""
echo "== phase 7/8 - compile and pack (vscode-${PACK_PLATFORM}-${VSCODE_ARCH}-min-packing)"

export VSCODE_PUBLISH_COUNTER=1

# VSCodium's windows sequence: the prepack task compiles, then the group-policy
# definitions the packer copies, then the packer. The packing task alone would
# pack a tree that was never compiled, which is why `vscode-min-prepack` is here
# even though the phase is named after the packer.
#
# VSCodium also runs `bash build/windows/rtf/make.sh` between those two. That step
# is deliberately absent here, and the reason is a defect that was found by
# running the phase: the file lives in the *VSCodium repository* (`build/windows/
# rtf/make.sh`, called by VSCodium as `. ../build/windows/rtf/make.sh`), not in
# VS Code and not in any patch, so `bash build/windows/rtf/make.sh` from inside
# `./vscode` aborted the phase with exit 127 -- `./vscode/build/windows/` does not
# exist. It is also not needed: its only product is `LICENSE.rtf`, which is read
# by `build/win32/code.iss`, the Inno installer, and PiCode builds no installer.
npm run gulp vscode-min-prepack

# The policy files are per system: the DTO copies are Windows' (read by Windows tooling), and the
# generator writes the data the editor itself carries, for the platform being packed.
if [[ "${PACK_PLATFORM}" == "win32" ]]; then
  npm run copy-policy-dto --prefix build
fi
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc "${PACK_PLATFORM}"

npm run gulp "vscode-${PACK_PLATFORM}-${VSCODE_ARCH}-min-packing"

cd ..

# ---------------------------------------------------------------------------
# Phase 8 - pi, and the distribution layer
# ---------------------------------------------------------------------------
echo ""
echo "== phase 8/8 - pi, and the distribution layer, onto ${PACK_DIR}"

# pi first: it is what the connector looks for, and an editor built without it can only
# answer "no encuentro el pi de este editor".
bash dev/pi-runtime.sh "${PACK_DIR}"

bash dev/stage-distribution.sh "${PACK_DIR}"

echo ""
echo "== done"
echo "source:    ./vscode (commit ${MS_COMMIT})"
# The product reports APP_VERSION (PiCode's own release), while RELEASE_VERSION is the
# VS Code tag the assets are named after. Printing the tag as "the product" would state a
# version the running editor does not report.
echo "product:   PiCode ${APP_VERSION}"
echo "vscode:    ${RELEASE_VERSION}"
echo "output:    ${PACK_DIR}"
echo "run it:    ${PACK_DIR}/PiCode.exe"
