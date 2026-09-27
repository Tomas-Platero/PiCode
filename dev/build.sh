#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# PiCode's build.
#
# The editor's source is PiCode's own and it lives in ./picode-source: it already carries
# the vendored VSCodium patch set, PiCode's own changes and the PiCode product identity,
# recorded in that tree's history. See odd/tasks/picode-fuente-propia.md.
#
#   ./dev/build.sh        install what is missing, compile, pack, stage
#   ./dev/build.sh -o     check the source and stop (seconds; nothing installed or compiled)
#   ./dev/build.sh -i     install the dependencies even when the recorded state still matches
#   ./dev/build.sh -h     this text
#
# What this script deliberately does NOT do any more, and why:
#
#   * It does not fetch VS Code. ./picode-source is PiCode's own source, versioned in this
#     repository. Bringing in a newer VS Code is a merge (docs/howto-build.md), not a
#     download-and-repatch: the fetch and patch machinery (dev/get_repo.sh,
#     dev/prepare_vscode.sh, dev/patch.sh, patches/**) was DELETED on 2026-09-27 by the
#     owner's decision.
#   * It does not apply patches. There are no patches any more: the changes they carried are
#     part of the source. Editing PiCode means editing ./picode-source.
#   * It does not re-brand the Windows icons. They are in the tree, committed. To change an
#     icon, replace picode-source/resources/win32/code.ico before the pack runs: rcedit
#     stamps the executable during phase 4, and phase 1 refuses a tree whose icon is missing
#     rather than shipping the previous one in silence.
#   * It does not use jq. The JSON this script touches is read and written by node.
#
# The phases are PiCode's: prepare (the source, the identity and the dependencies), the
# connector, compile, pack, stage. `-o` stops inside the first one.

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

# The gulp tasks need a heap that fits the machine. Two measurements drove this:
# - Windows overflowed an 8192 MB heap with SIGABRT ("Ineffective mark-compacts
#   near heap limit") at ~7.4 GB, right after the TypeScript compile finished
#   with 0 errors; the Windows runner has 16 GB, so 12288 fits.
# - The Linux runner OOM-killed the bundler ("Killed", then a shutdown signal)
#   with 8192 free to grow, and later runs died with a bare "shutdown signal"
#   ~9 minutes into compile-src: `free -m` measured 7938 MB TOTAL on the runner,
#   so node's heap plus the runner agent plus the OS do not fit above ~6 GB.
# VS Code's own `npm run gulp` hardcodes --max-old-space-size=8192 in its
# package.json script and a CLI flag beats NODE_OPTIONS, so the compile and pack
# phases invoke gulp with node directly instead of through npm.
# An explicit NODE_HEAP_MB (a CI workflow sets it for a larger runner) wins;
# otherwise the per-OS default applies.
case "${OSTYPE}" in
  msys* | cygwin*)
    NODE_HEAP_MB="${NODE_HEAP_MB:-12288}"
    ;;
  *)
    NODE_HEAP_MB="${NODE_HEAP_MB:-5632}"
    ;;
esac
export NODE_OPTIONS="--max-old-space-size=${NODE_HEAP_MB}"

CHECK_ONLY="no"
FORCE_INSTALL="no"

usage() {
  cat <<'EOF' >&2
usage: ./dev/build.sh [-o] [-i]

  (no flag)  check the source, install what is missing, compile, pack and stage
  -o         check the source and the identity, then stop (nothing is installed
             or compiled; this is the seconds-long sanity check)
  -i         install the dependencies even when the recorded state still matches
EOF
}

while getopts ":oihs" opt; do
  case "$opt" in
    o)
      CHECK_ONLY="yes"
      ;;
    i)
      FORCE_INSTALL="yes"
      ;;
    h)
      usage
      exit 0
      ;;
    s)
      echo "note: -s is no longer needed. The source is never fetched, so it is always"
      echo "      the ./picode-source that is here. Continuing."
      ;;
    *)
      if [[ "${OPTARG}" == "f" ]]; then
        echo "error: -f is gone, and for a good reason: it used to delete ./picode-source." >&2
        echo "       That tree is PiCode's own source now, and this repository is the only" >&2
        echo "       place it exists. To bring in a newer VS Code, merge it into the tree" >&2
        echo "       (docs/howto-build.md) instead of throwing the tree away." >&2
        exit 2
      fi
      echo "error: unknown option -${OPTARG}" >&2
      usage
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# OS_NAME. Mandatory: it selects what is packed and what the output is called.
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
    echo "       Windows and Linux builds are set up; macOS is not (see docs/howto-build.md)." >&2
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
# (PiCode's own change, written into the tree), so the two have to agree: this is the same table.
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
echo "CHECK_ONLY=\"${CHECK_ONLY}\""
echo "FORCE_INSTALL=\"${FORCE_INSTALL}\""
echo "NODE_HEAP_MB=\"${NODE_HEAP_MB}\""

require_tool() {
  if ! command -v "$1" > /dev/null 2>&1; then
    echo "error: $1 was not found on PATH." >&2
    echo "       $2" >&2
    exit 2
  fi
}

require_tool node "The build runs npm and the gulp tasks through node, and it reads and writes the product JSON with it."
require_tool npm "The dependencies are installed with npm."
require_tool git "The source tree is a git repository, and a newer VS Code is brought in as a merge."

# ---------------------------------------------------------------------------
# Whatever happens, this script leaves its verdict behind: builds started by hand - not through
# dev/build-run.sh, which writes the same file - are the ones the window and the terminal viewer read.
# Without this, a successful command-line build was invisible to every front-end.
# The status file is anchored to the repository root on purpose: the build `cd`s into
# picode-source for the dependency and compile phases, and a failure there used to make this trap
# try to write into picode-source/.scratch, which does not exist ("No such file or directory")
# and the real exit code was lost with it.
ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
mkdir -p "${ROOT_DIR}/.scratch"
trap 'printf "%s" "$?" > "${ROOT_DIR}/.scratch/build.status"' EXIT

# ---------------------------------------------------------------------------
# Phase 1 - the source
# ---------------------------------------------------------------------------
# The three things that leave the tree ready to compile, in one phase because they are one job:
# confirm the tree is PiCode's, put the product identity on it, and install what it needs. Of the
# three, only the install can be long, and only the first time it runs.
echo ""
echo "== phase 1/5 - prepare (the source, the identity, the dependencies)"

if [[ ! -d ./picode-source ]]; then
  echo "error: ./picode-source is missing." >&2
  echo "       It is PiCode's own source and it is versioned IN this repository: a clone has it." >&2
  echo "       A missing tree here means this checkout is damaged - restore it with git, do not" >&2
  echo "       re-run the build. docs/howto-build.md explains what the tree is." >&2
  exit 2
fi

if [[ ! -f ./picode-source/product.json || ! -f ./picode-source/package.json ]]; then
  echo "error: ./picode-source is not a prepared tree (product.json or package.json is missing)." >&2
  exit 2
fi

if [[ ! -f ./distribution/product-delta.json ]]; then
  echo "error: ./distribution/product-delta.json is missing; it carries the product version." >&2
  exit 2
fi

APP_VERSION=$( node -p "require('./distribution/product-delta.json').set.version" 2> /dev/null ) || {
  echo "error: distribution/product-delta.json could not be read, or it does not set a 'version'." >&2
  exit 2
}

if [[ -z "${APP_VERSION}" || "${APP_VERSION}" == "undefined" ]]; then
  echo "error: distribution/product-delta.json does not set a 'version'." >&2
  exit 2
fi

# The tree is PiCode's, and this is where that is checked instead of assumed. Each of these is
# something a phase further down depends on, and each of them failing quietly would ship a
# broken or mislabelled editor: a product that is not PiCode's, a company name left as
# Microsoft's, an icon the packer cannot find, or no connector to reach pi.
if ! node <<'NODE'
const fs = require('fs');
const fail = [];
const root = 'picode-source';
const product = JSON.parse(fs.readFileSync(`${root}/product.json`, 'utf8'));
const delta = JSON.parse(fs.readFileSync('distribution/product-delta.json', 'utf8'));

if (product.nameShort !== delta.set.nameShort) {
  fail.push(`product.json says nameShort="${product.nameShort}" where the delta says "${delta.set.nameShort}"`);
}
if (fs.readFileSync(`${root}/build/lib/electron.ts`, 'utf8').indexOf("companyName: 'PiCode'") === -1) {
  fail.push('build/lib/electron.ts does not carry the PiCode company name');
}
if (!fs.existsSync(`${root}/resources/win32/code.ico`)) {
  fail.push('resources/win32/code.ico is missing, and the packer reads it');
}
if (!fs.existsSync(`${root}/resources/server/manifest.json`) || JSON.parse(fs.readFileSync(`${root}/resources/server/manifest.json`, 'utf8')).name !== delta.set.nameShort) {
  fail.push('resources/server/manifest.json does not carry the PiCode name');
}
if (!fs.existsSync(`${root}/extensions/picode/package.json`)) {
  fail.push('extensions/picode/package.json is missing, and that is the connector');
}

if (fail.length > 0) {
  console.error(fail.map(line => `  - ${line}`).join('\n'));
  process.exit(1);
}
console.log(`  the source carries the PiCode identity (version ${delta.set.version})`);
NODE
then
  echo "error: ./picode-source is not the PiCode source this build expects (see above)." >&2
  echo "       If the tree was replaced wholesale, brand it in the tree: product.json," >&2
  echo "       build/lib/electron.ts, resources/win32/code.ico, resources/server/manifest.json." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# The identity
# ---------------------------------------------------------------------------
# The identity has ONE home: distribution/product-delta.json. Both paths apply it - this build
# here, and distribution/apply-picode.ps1 onto the packaged tree - so the compiled editor and the
# released one cannot disagree. Bumping a release is editing that one value.
#
# The delta sets product.json's version; the packer also reads package.json's, so the two are put
# in agreement here rather than maintained by hand. This is the one thing that changes release to
# release; the rest of the branding (the company name, the Windows icons, the server manifest)
# was applied once and is committed in the tree, which is what the source check above verified.

set +e
node distribution/apply-product-delta.mjs \
  --target picode-source/product.json \
  --delta distribution/product-delta.json \
  --write
DELTA_EXIT=$?
set -e

if [[ "${DELTA_EXIT}" -ne 0 ]]; then
  echo "error: the product delta failed with exit code ${DELTA_EXIT} (2 = error, 0 = applied or already current)." >&2
  exit "${DELTA_EXIT}"
fi

if ! APP_VERSION="${APP_VERSION}" node <<'NODE'
const fs = require('fs');
const file = 'picode-source/package.json';
const version = process.env.APP_VERSION;
const raw = fs.readFileSync(file, 'utf8');
const next = raw.replace(/^(\t"version":\s*")[^"]*(")/m, `$1${version}$2`);

if (next === raw) {
  if (raw.indexOf(`"version": "${version}"`) === -1) {
    console.error('  package.json has no version line this script can rewrite');
    process.exit(1);
  }
  console.log(`  package.json already reports ${version}`);
  process.exit(0);
}
fs.writeFileSync(file, next);
console.log(`  package.json version set to ${version}`);
NODE
then
  echo "error: the version could not be written into picode-source/package.json." >&2
  exit 2
fi

# The value the packer stamps into product.json's `commit` and reads back for the versioned
# resources folder. VSCodium derives it from the release version with sha1sum; the algorithm is
# kept identical, newline included, so a PiCode built here is stamped the way it always was.
RELEASE_VERSION="${APP_VERSION}"
if [[ -z "${BUILD_SOURCEVERSION}" ]]; then
  if command -v sha1sum > /dev/null 2>&1; then
    BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | sha1sum | cut -d' ' -f1 )
  elif command -v shasum > /dev/null 2>&1; then
    BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | shasum -a 1 | cut -d' ' -f1 )
  else
    echo "error: neither sha1sum nor shasum was found, and the build stamp needs one of them." >&2
    exit 2
  fi
fi
export RELEASE_VERSION BUILD_SOURCEVERSION

echo "APP_VERSION=\"${APP_VERSION}\""
echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""
echo "BUILD_SOURCEVERSION=\"${BUILD_SOURCEVERSION}\""

if [[ "${CHECK_ONLY}" == "yes" ]]; then
  echo ""
  echo "== phase 1/5 reached. -o was given: nothing was installed or compiled."
  echo "source:  ./picode-source (the PiCode source, identity checked)"
  echo "next:    ./dev/build.sh    to install, compile and pack"
  exit 0
fi

# The step that staged `extensions/picode-pi-chat` as a built-in extension was **removed on
# 2026-09-24 by the owner's decision**: pi lives in the core, and the extension is being
# migrated into it. Nothing compiles or packages that directory.
echo ""
echo "  -- dependencies"

cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# The install is the step this build exists to stop repeating. VS Code records the dependency
# state it installed in `node_modules/.postinstall-state`; dev/deps-current.mjs compares that
# against the tree as it is now, and the install is skipped ONLY when the two are identical.
# A partial or stale node_modules is never trusted: it is reinstalled, exactly as before.
reuse_node_modules="no"
if [[ "${FORCE_INSTALL}" != "yes" && -f node_modules/.postinstall-state ]]; then
  if node "${ROOT_DIR}/dev/deps-current.mjs"; then
    reuse_node_modules="yes"
  fi
fi

if [[ "${reuse_node_modules}" == "yes" ]]; then
  echo "the dependencies are the ones this source needs: nothing to install"
else
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
fi

cd ..

# ---------------------------------------------------------------------------
# The connector
# ---------------------------------------------------------------------------
# PiCode's connector (`picode-source/extensions/picode`) is compiled **here and not by the packer**:
# the packing step collects every extension under `picode-source/extensions/` — which is how the
# connector gets inside the binary — but it does not run `tsc` for it, and an extension
# packaged without its `out/` never activates. It runs after the dependencies because it compiles
# with the tree's own typings, and before the pack because the pack is what collects it.
echo ""
echo "== phase 2/5 - compile the connector"

bash dev/build-connector.sh

# ---------------------------------------------------------------------------
# Compile
# ---------------------------------------------------------------------------
echo ""
echo "== phase 3/5 - compile the editor (vscode-min-prepack)"

export VSCODE_PUBLISH_COUNTER=1

cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

# VSCodium's windows sequence: the prepack task compiles, then the group-policy
# definitions the packer copies, then the packer (phase 6 here). The packing task alone would
# pack a tree that was never compiled, which is why `vscode-min-prepack` is here even though
# the phase is named after the packer in the task name.
#
# VSCodium also runs `bash build/windows/rtf/make.sh` between those two. That step
# is deliberately absent here, and the reason is a defect that was found by
# running the phase: the file lives in the *VSCodium repository* (`build/windows/
# rtf/make.sh`, called by VSCodium as `. ../build/windows/rtf/make.sh`), not in
# VS Code and not in any patch, so `bash build/windows/rtf/make.sh` from inside
# `./picode-source` aborted the phase with exit 127 -- `./picode-source/build/windows/` does not
# exist. It is also not needed: its only product is `LICENSE.rtf`, which is read
# by `build/win32/code.iss`, the Inno installer, and PiCode builds no installer.
node --experimental-strip-types --max-old-space-size="${NODE_HEAP_MB}" ./node_modules/gulp/bin/gulp.js vscode-min-prepack

# The policy files are per system: the DTO copies are Windows' (read by Windows tooling), and the
# generator writes the data the editor itself carries, for the platform being packed.
# The policy DTO is a build-time copy from src/vs/workbench/contrib/policyExport/
# (it is not in the VS Code source), and the generator below imports it on EVERY
# platform — so the copy cannot stay behind the win32 branch. Measured in CI: the
# linux build compiled for 33 minutes and died here with ERR_MODULE_NOT_FOUND for
# build/lib/policies/policyDto.ts. The generated data is still per-platform: that
# is what the PACK_PLATFORM argument selects.
node build/lib/policies/copyPolicyDto.ts
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc "${PACK_PLATFORM}"

cd ..

# ---------------------------------------------------------------------------
# Pack
# ---------------------------------------------------------------------------
echo ""
echo "== phase 4/5 - pack (vscode-${PACK_PLATFORM}-${VSCODE_ARCH}-min-packing)"

cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

node --experimental-strip-types --max-old-space-size="${NODE_HEAP_MB}" ./node_modules/gulp/bin/gulp.js "vscode-${PACK_PLATFORM}-${VSCODE_ARCH}-min-packing"

cd ..

# ---------------------------------------------------------------------------
# pi, and the distribution layer
# ---------------------------------------------------------------------------
echo ""
echo "== phase 5/5 - pi, and the distribution layer, onto ${PACK_DIR}"

# pi first: it is what the connector looks for, and an editor built without it can only
# answer "no encuentro el pi de este editor".
bash dev/pi-runtime.sh "${PACK_DIR}"

bash dev/stage-distribution.sh "${PACK_DIR}"

echo ""
echo "== done"
echo "source:    ./picode-source (PiCode's own tree, versioned in this repository)"
# The product reports APP_VERSION (PiCode's own release). There is no VS Code tag to name any
# more: the tree IS the source, and which VS Code it descends from is recorded in
# upstream/stable.json and in the history of this repository.
echo "product:   PiCode ${APP_VERSION}"
echo "output:    ${PACK_DIR}"
echo "run it:    ${PACK_DIR}/PiCode.exe"
