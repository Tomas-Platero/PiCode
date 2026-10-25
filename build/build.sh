#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# PiCode's build.
#
# The editor's source is PiCode's own and it is this repository: it already carries
# the vendored VSCodium patch set, PiCode's own changes and the PiCode product identity,
# recorded in its history.
#
#   ./build/build.sh        install what is missing, compile, pack, stage
#   ./build/build.sh -o     check the source and stop (seconds; nothing installed or compiled)
#   ./build/build.sh -i     install the dependencies even when the recorded state still matches
#   ./build/build.sh -h     this text
#
# What this script deliberately does NOT do any more, and why:
#
#   * It does not fetch VS Code. The tree is PiCode's own source, versioned in this
#     repository. Bringing in a newer VS Code is a merge (docs/howto-build.md), not a
#     download-and-repatch: the fetch and patch machinery (build/get_repo.sh,
#     build/prepare_vscode.sh, build/patch.sh, patches/**) was DELETED on 2026-09-27 by the
#     owner's decision.
#   * It does not apply patches. There are no patches any more: the changes they carried are
#     part of the source. Editing PiCode means editing the tree.
#   * It does not re-brand the Windows icons. They are in the tree, committed. To change an
#     icon, replace resources/win32/code.ico before the pack runs: rcedit
#     stamps the executable during phase 4, and phase 1 refuses a tree whose icon is missing
#     rather than shipping the previous one in silence.
#   * It does not use jq. The JSON this script touches is read and written by node.
#
# The phases are PiCode's: prepare (the source, the identity and the dependencies), the
# connector, compile, pack, stage, and - on Windows - the installer. `-o` stops inside the first
# one.

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
export VSCODE_QUALITY="${VSCODE_QUALITY:-stable}"
export CI_BUILD="no"
export SKIP_ASSETS="yes"
export VSCODE_SKIP_NODE_VERSION_CHECK="yes"

# Minification is on by default; `PICODE_MINIFY=0` skips it (~30 s off the bundle) for the
# edit-compile-look loop. The release always minifies.
export PICODE_MINIFY="${PICODE_MINIFY:-yes}"

# A fast build (build/build-fast.sh) asks for the same artifact without the whole-tree type check:
# esbuild never consumed the check's output, so what it leaves out is the report, not the compile.
# The release never sets this.
if [[ "${PICODE_FAST:-0}" == "1" ]]; then
  export PICODE_SKIP_TYPECHECK=1
fi

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
NODE_HEAP_MB="${NODE_HEAP_MB:-12288}"
export NODE_OPTIONS="--max-old-space-size=${NODE_HEAP_MB}"

CHECK_ONLY="no"
FORCE_INSTALL="no"

usage() {
  cat <<'EOF' >&2
usage: ./build/build.sh [-o] [-i]

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
      echo "      the tree that is here. Continuing."
      ;;
    *)
      if [[ "${OPTARG}" == "f" ]]; then
        echo "error: -f is gone, and for a good reason: it used to delete the source tree." >&2
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
  *)
    echo "error: OSTYPE is '${OSTYPE}'; PiCode only builds on Windows (Git Bash)." >&2
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
#
# `PICODE_PACK_SUFFIX` is appended by both sides. Empty in every ordinary build; set to something
# like " - experimental" to pack beside the tree a release was cut from instead of over it, which is
# what the gulpfiles' `buildPath` and `destinationFolderName` do with the same variable.
case "${OS_NAME}" in
  windows)
    PACK_PLATFORM="win32"
    PACK_DIR="./PiCode-Win32-${VSCODE_ARCH}${PICODE_PACK_SUFFIX:-}"
    ;;
  *)
    echo "error: packing for OS_NAME='${OS_NAME}' is not set up (Windows only)." >&2
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
# build/build-run.sh, which writes the same file - are the ones the window and the terminal viewer read.
# Without this, a successful command-line build was invisible to every front-end.
# The status file is anchored to the repository root on purpose: a phase that
# could change the working directory would otherwise make this trap
# try to write into .scratch, which does not exist ("No such file or directory")
# and the real exit code was lost with it.
ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
mkdir -p "${ROOT_DIR}/.scratch"

# ---------------------------------------------------------------------------
# The build's own record
# ---------------------------------------------------------------------------
# Two files, for a caller that wants the facts instead of the prose:
#
#   .scratch/build.jsonl    one JSON object per event, appended as it happens: the build starting,
#                           a phase starting, a phase ending, the build ending. Append-only, so a
#                           watcher can tail it and a crash keeps everything before the crash.
#   .scratch/build.status   one JSON object, written once, when the build ends: the verdict.
#
# Both are written by the build itself, so a build run by hand and one run through
# `build/build-run.sh` leave the same record. The runner adds only what the build cannot know
# about itself: its own pid, the flags it was given, the log it teed.
#
# `build.status` used to be a bare exit code, which said that the build had ended and nothing
# else: not the phase it died in, not how long it ran. It is JSON now, and its readers still
# accept a bare number, so a status left by an older build is not misread as a corrupt one.
PICODE_BUILD_STARTED_AT=$( date +%s )
EVENTS="${ROOT_DIR}/.scratch/build.jsonl"
STATUS="${ROOT_DIR}/.scratch/build.status"

# One event. The caller passes the object body; the timestamp is the record's to add.
picode_event() {  # picode_event <json body without the leading at field>
  printf '{"at":"%s",%s}\n' "$( date -u +%Y-%m-%dT%H:%M:%SZ )" "$1" >> "${EVENTS}" 2> /dev/null || true
}

# The phase in progress, so the status can name the one that failed.
PICODE_PHASE_NUMBER=0
PICODE_PHASE_NAME=""
PICODE_PHASE_AT=${PICODE_BUILD_STARTED_AT}

# The phase's end. The outcome is the build's to decide; the seconds are measured, not estimated.
picode_phase_end() {  # picode_phase_end <ok|stopped>
  local seconds=$(( $( date +%s ) - PICODE_PHASE_AT ))
  picode_event "\"event\":\"phase-end\",\"phase\":${PICODE_PHASE_NUMBER},\"name\":\"${PICODE_PHASE_NAME}\",\"outcome\":\"$1\",\"seconds\":${seconds}"
}

# A phase, announced to a person and recorded for a machine at the same time: the human line is
# printed exactly as it always was, and the event is what a caller reads. Opening a phase closes
# the previous one as `ok`, because a phase that failed never reaches the next one.
picode_phase() {  # picode_phase <number> <machine-name> <what a person reads>
  if [[ "${PICODE_PHASE_NUMBER}" != "0" ]]; then
    picode_phase_end "ok"
  fi
  PICODE_PHASE_NUMBER="$1"
  PICODE_PHASE_NAME="$2"
  PICODE_PHASE_AT=$( date +%s )
  picode_event "\"event\":\"phase-start\",\"phase\":${1},\"name\":\"${2}\""
  echo ""
  echo "== phase $1/5 - $3"
}

# The verdict, as one object.
picode_write_status() {  # picode_write_status <exit code>
  local rc="$1"
  local outcome="ok"
  if [[ "${rc}" != "0" ]]; then outcome="failed"; fi
  local ended duration
  ended=$( date +%s )
  duration=$(( ended - PICODE_BUILD_STARTED_AT ))
  # `date -d @` is GNU; Git Bash has it, and the empty fallback keeps a build on a date without it
  # from going out with no status at all.
  printf '{"exitCode":%s,"outcome":"%s","channel":"%s","phase":%s,"phaseName":"%s","packDir":"%s","version":"%s","startedAt":"%s","endedAt":"%s","durationSeconds":%s}\n' \
    "${rc}" \
    "${outcome}" \
    "${PICODE_CHANNEL:-}" \
    "${PICODE_PHASE_NUMBER}" \
    "${PICODE_PHASE_NAME}" \
    "$( basename "${PACK_DIR:-}" )" \
    "${APP_VERSION:-}" \
    "$( date -u -d "@${PICODE_BUILD_STARTED_AT}" +%Y-%m-%dT%H:%M:%SZ 2> /dev/null || echo '' )" \
    "$( date -u -d "@${ended}" +%Y-%m-%dT%H:%M:%SZ 2> /dev/null || echo '' )" \
    "${duration}" > "${STATUS}" 2> /dev/null || true
}

# The build's last event. A function rather than an inline call so the exit trap can stay
# single-quoted and pass a plain argument, with no escaping to get wrong.
picode_end_event() {  # picode_end_event <exit code>
  picode_event "\"event\":\"end\",\"exitCode\":$1"
}

# A build's events are its own: the file is emptied at the start, so a watcher never reads the
# previous run's phases as this one's.
: > "${EVENTS}" 2> /dev/null || true
picode_event '"event":"start","pid":'"$$"

# ---------------------------------------------------------------------------
# The channel seal's undo
# ---------------------------------------------------------------------------
# A channel build rewrites the SOURCE product.json: `quality`, the feed URL, the install identity
# and the folder names are what the compiler and the packer read, so the seal lands on the file the
# tree carries. What the channel owns is the PACKED product; the source belongs to whoever wrote
# it, and a tree left sealed is no longer the tree that was built.
#
# So the source is copied aside before the seal writes and put back on the way out - after a good
# build, after a failure and after Ctrl-C alike, through the exit trap below. The copy lives in
# `.scratch` (ignored by git) instead of in a variable, because a run that is killed outright
# never reaches its trap: the copy is still there, and phase 1 puts it back before anything reads
# product.json. Without this, every channel build left the tree dirty and the next one had to be
# cleaned by hand.
PICODE_PRODUCT_SOURCE="${ROOT_DIR}/.scratch/product.json.source"

picode_product_hold_save() {
  cp -f "${ROOT_DIR}/product.json" "${PICODE_PRODUCT_SOURCE}" || {
    echo "error: product.json could not be saved to ${PICODE_PRODUCT_SOURCE}, so a seal would have nothing to put back." >&2
    return 1
  }
}

picode_product_hold_put_back() {
  # Nothing saved: this build never sealed the source, and there is nothing to undo. That is the
  # ordinary build, so it says nothing.
  [[ -f "${PICODE_PRODUCT_SOURCE}" ]] || return 0
  if cp -f "${PICODE_PRODUCT_SOURCE}" "${ROOT_DIR}/product.json"; then
    rm -f "${PICODE_PRODUCT_SOURCE}"
    echo "  -- the source product.json is back to what it was (the channel lives in the pack)"
    return 0
  fi
  echo "warning: product.json could not be put back; the original is saved in ${PICODE_PRODUCT_SOURCE} -- copy it over product.json by hand" >&2
  return 1
}

trap 'rc=$?; picode_write_status "${rc}"; picode_end_event "${rc}"; picode_product_hold_put_back || true; if [[ -n "${PICODE_DATA_HOLD_DIR:-}" && -d "${PICODE_DATA_HOLD_DIR}" ]]; then echo "  -- the build ended with the portable profile beside the folder: putting it back in ${PICODE_DATA_DIR}"; picode_data_hold_put_back "${PACK_DIR}" || echo "warning: the profile is still in ${PICODE_DATA_HOLD_DIR}; it is safe there -- move it back to ${PICODE_DATA_DIR} by hand" >&2; fi' EXIT

# The portable-profile hold, the mechanism that keeps data/ out of the pack's wholesale delete.
# The functions and their rationale live in build/data-hold.sh; build.sh calls recover + move-aside
# around phase 4 and put-back around phase 5. The trap above is the safety net: if the build
# dies anywhere between the move-aside and the put-back, the profile still goes home.
source "${ROOT_DIR}/build/data-hold.sh"
PICODE_DATA_DIR="$(picode_data_dir "${PACK_DIR}")"
PICODE_DATA_HOLD_DIR="$(picode_data_hold_dir "${PACK_DIR}")"

# ---------------------------------------------------------------------------
# Phase 1 - the source
# ---------------------------------------------------------------------------
# The three things that leave the tree ready to compile, in one phase because they are one job:
# confirm the tree is PiCode's, put the product identity on it, and install what it needs. Of the
# three, only the install can be long, and only the first time it runs.
picode_phase 1 "prepare" "prepare (the source, the identity, the dependencies)"

# A hold left by a build that was killed outright (its trap never ran): the source is sealed and the
# original is still beside the records. It goes back before anything reads product.json, so a crash
# cannot leave the next build building from a sealed tree.
picode_product_hold_put_back || exit 2

if [[ ! -f ./product.json ]]; then
  echo "error: product.json is missing." >&2
  echo "       It is PiCode's own source and it is versioned IN this repository: a clone has it." >&2
  echo "       A missing tree here means this checkout is damaged - restore it with git, do not" >&2
  echo "       re-run the build. docs/howto-build.md explains what the tree is." >&2
  exit 2
fi

if [[ ! -f ./product.json || ! -f ./package.json ]]; then
  echo "error: the tree is not a prepared tree (product.json or package.json is missing)." >&2
  exit 2
fi

if [[ ! -f ./product.json ]]; then
  echo "error: ./product.json is missing; it carries the product version." >&2
  exit 2
fi

APP_VERSION=$( node -p "require('./product.json').version" 2> /dev/null ) || {
  echo "error: product.json could not be read, or it does not set a 'version'." >&2
  exit 2
}

if [[ -z "${APP_VERSION}" || "${APP_VERSION}" == "undefined" ]]; then
  echo "error: product.json does not set a 'version'." >&2
  exit 2
fi

PICODE_VERSION=$( node -p "require('./product.json').picodeVersion" 2> /dev/null ) || {
  echo "error: product.json could not be read, or it does not set a 'picodeVersion'." >&2
  exit 2
}

if [[ -z "${PICODE_VERSION}" || "${PICODE_VERSION}" == "undefined" ]]; then
  echo "error: product.json does not set a 'picodeVersion'." >&2
  exit 2
fi


# Auto-detect the channel from the branch when the caller does not name one, so a build
# on master/beta/experimental seals the channel that branch owns instead of shipping an
# unsealed editor (one channel per branch, the owner's rule). An explicit PICODE_CHANNEL
# always wins, and CI's detached HEAD falls back to the env vars naming the branch.
if [[ -z "${PICODE_CHANNEL:-}" ]]; then
  _branch=""
  if [[ -n "${GITHUB_HEAD_REF:-}" ]]; then
    _branch="${GITHUB_HEAD_REF}"
  elif [[ -n "${GITHUB_REF_NAME:-}" ]]; then
    _branch="${GITHUB_REF_NAME}"
  else
    _branch="$( git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '' )"
  fi
  _branch="${_branch#refs/heads/}"
  case "${_branch}" in
    master)         PICODE_CHANNEL="stable" ;;
    beta)           PICODE_CHANNEL="beta" ;;
    experimental)   PICODE_CHANNEL="experimental" ;;
    *)              PICODE_CHANNEL="" ;;
  esac
  if [[ -n "${PICODE_CHANNEL}" ]]; then
    export PICODE_CHANNEL
    echo "  -- PICODE_CHANNEL not set; auto-detected '${PICODE_CHANNEL}' from branch '${_branch}'"
  else
    echo "  -- PICODE_CHANNEL not set and branch '${_branch}' is not a release branch; building unsealed"
  fi
fi

# Keep the packed icon in sync with the canonical one in build/distribution/: rcedit stamps the executable
# during the pack, so a stale code.ico would ship the wrong icon with no warning. The source check
# below still refuses a tree whose icon is missing.
if [[ -f build/distribution/picode.ico ]]; then
  if [[ ! -f resources/win32/code.ico ]] || ! cmp -s build/distribution/picode.ico resources/win32/code.ico; then
    mkdir -p resources/win32
    cp build/distribution/picode.ico resources/win32/code.ico
    echo "  -- synced resources/win32/code.ico from build/distribution/picode.ico"
  fi
fi
# something a phase further down depends on, and each of them failing quietly would ship a
# broken or mislabelled editor: a product that is not PiCode's, a company name left as
# Microsoft's, an icon the packer cannot find, or no connector to reach pi.
if ! node <<'NODE'
const fs = require('fs');
const fail = [];
const root = '.';
const product = JSON.parse(fs.readFileSync(`${root}/product.json`, 'utf8'));

if (!product.nameShort || !product.nameShort.startsWith('PiCode')) {
  fail.push(`product.json nameShort="${product.nameShort}" is not a PiCode name`);
}
if (fs.readFileSync(`${root}/build/lib/electron.ts`, 'utf8').indexOf("companyName: 'PiCode'") === -1) {
  fail.push('build/lib/electron.ts does not carry the PiCode company name');
}
if (!fs.existsSync(`${root}/resources/win32/code.ico`)) {
  fail.push('resources/win32/code.ico is missing, and the packer reads it');
}
if (!fs.existsSync(`${root}/resources/server/manifest.json`) || JSON.parse(fs.readFileSync(`${root}/resources/server/manifest.json`, 'utf8')).name !== 'PiCode') {
  fail.push('resources/server/manifest.json does not carry the PiCode name');
}
if (!fs.existsSync(`${root}/extensions/picode/package.json`)) {
  fail.push('extensions/picode/package.json is missing, and that is the connector');
}
// The updater's strings live inside this binary and nothing in the toolchain rewrites them:
// build/branding.mjs patch-inno-updater brands them in the file. Two shapes, so two checks - the progress
// window's caption is a UTF-16 dialog resource, and the failure box the owner can actually end
// up reading (plus the "... - Updater" title, the "... is updating..." line and the
// `vscode-inno-updater-<pid>.log` prefix) are the program's own single-byte literals. A binary
// that has not been through the script still says "Visual Studio Code" on an update that fails.
const updater = `${root}/build/win32/inno_updater.exe`;
if (!fs.existsSync(updater)) {
  fail.push('build/win32/inno_updater.exe is missing, and the installer packs it');
} else {
  const binary = fs.readFileSync(updater);
  const stale = ['Visual Studio Code', 'vscode-inno-updater-'].filter(term =>
    binary.indexOf(Buffer.from(term, 'utf16le')) !== -1 || binary.indexOf(Buffer.from(term, 'latin1')) !== -1);
  if (stale.length > 0) {
    fail.push(`build/win32/inno_updater.exe still says ${stale.map(term => `"${term}"`).join(' and ')}; run node build/branding.mjs patch-inno-updater`);
  }
}

if (fail.length > 0) {
  console.error(fail.map(line => `  - ${line}`).join('\n'));
  process.exit(1);
}
console.log(`  the source carries the PiCode identity (editor ${product.version}, picode ${product.picodeVersion})`);
NODE
then
  echo "error: the tree is not the PiCode source this build expects (see above)." >&2
  echo "       If the tree was replaced wholesale, brand it in the tree: product.json," >&2
  echo "       build/lib/electron.ts, resources/win32/code.ico, resources/server/manifest.json." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# The identity
# ---------------------------------------------------------------------------
# The identity has ONE home: product.json. The build applies it to the source
# tree's product.json, so the compiled editor and the released one cannot disagree. Bumping a
# release is editing that one value.
#
# The delta sets product.json's version; the packer also reads package.json's, so the two are put
# in agreement here rather than maintained by hand. This is the one thing that changes release to
# release; the rest of the branding (the company name, the Windows icons, the server manifest)
# was applied once and is committed in the tree, which is what the source check above verified.


# The channel is sealed into the build here, as product.json's `quality`: it is what the
# updater uses to build its feed URL, so a beta build asks updates/beta/… and can never be
# offered another channel's release. One channel per branch, which is the owner's rule
# (2026-10-08) and the reason the four names below are the four that exist:
#
#   stable <-> master        beta <-> beta        experimental <-> experimental
#
# The channel is NOT a user setting and NOT the editor's version — the version the extensions
# match is untouched (see build/gulpfile.vscode.ts, where the upstream version-suffix by
# quality is scoped back to upstream's own 'insider', which is not a channel of ours).
if [[ -n "${PICODE_CHANNEL:-}" ]]; then
  case "${PICODE_CHANNEL}" in
    stable)       QUALITY_VALUE="stable";       FEED_BRANCH="master" ;;
    beta)         QUALITY_VALUE="beta";         FEED_BRANCH="beta" ;;
    experimental) QUALITY_VALUE="experimental"; FEED_BRANCH="experimental" ;;
    *) echo "error: PICODE_CHANNEL must be one of stable, beta, experimental (got '${PICODE_CHANNEL}')." >&2; exit 2 ;;
  esac
  # The channel names the PACK FOLDER: an experimental build lands beside the tree as
  # `PiCode-win32-x64-experimental` — never over a stable build's folder — and stable
  # keeps the plain name it has always had. The installer's suffix already defaults from
  # this one (see phase 5), so folder and installer carry the channel together. An
  # explicit PICODE_PACK_SUFFIX still wins, for a different side-by-side name.
  if [[ "${QUALITY_VALUE}" != "stable" && -z "${PICODE_PACK_SUFFIX:-}" ]]; then
    PICODE_PACK_SUFFIX="-${PICODE_CHANNEL}"
    export PICODE_PACK_SUFFIX
    echo "  -- the channel names the pack folder: .${PACK_DIR}${PICODE_PACK_SUFFIX}"
  fi
  # The folder was computed before the channel check; recompute it with the suffix.
  PACK_DIR="./PiCode-Win32-${VSCODE_ARCH}${PICODE_PACK_SUFFIX:-}"
  # The source is saved before the seal writes and put back by the exit trap; the mechanism and the
  # reason live with the seal's undo at the top of this script. The save is checked rather than
  # assumed: a build that cannot put the source back must not seal it in the first place.
  picode_product_hold_save || exit 2
  PICODE_CHANNEL="${PICODE_CHANNEL}" QUALITY_VALUE="${QUALITY_VALUE}" FEED_BRANCH="${FEED_BRANCH}" node <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const file = 'product.json';
const channel = process.env.PICODE_CHANNEL;
const quality = process.env.QUALITY_VALUE;
const branch = process.env.FEED_BRANCH;
const raw = fs.readFileSync(file, 'utf8');
const product = JSON.parse(raw);

// The feed lives with its own channel: the branch in the URL is the channel's
// branch, so a beta build reads the beta branch's feed and a stable build can
// never be handed a beta one, even if a pipeline gets the channel wrong. The
// URL is derived from the one the delta already carries, so the host and the
// path keep a single home and the branch is the only thing this adds. Failing
// loudly beats shipping a HEAD URL silently: HEAD follows whatever the default
// branch happens to be, and that moving target is what this removes.
if (typeof product.updateUrl !== 'string'
  || !/\/(HEAD|master|beta|experimental)\//.test(product.updateUrl)) {
  console.error('  updateUrl names no channel this build can seal (HEAD, master, beta, experimental):');
  console.error(`  ${product.updateUrl}`);
  process.exit(1);
}

// Everything a second install needs so it does not collide with the first one:
// its own folder, registry name, mutex, user model id and installer AppId.
// `stable` keeps exactly what the delta carries, so the stable build is the
// product as it has always been; the others are that plus the channel.
const CHANNEL = {
  stable: { label: '', reg: 'PiCode', slug: 'picode' },
  beta: { label: ' Beta', reg: 'PiCodeBeta', slug: 'picode-beta' },
  experimental: {
    label: ' Experimental',
    reg: 'PiCodeExperimental',
    slug: 'picode-experimental'
  }
}[channel];
if (CHANNEL === undefined) {
  console.error(`  no identity is defined for channel '${channel}'`);
  process.exit(1);
}

product.quality = quality;
// The branch segment is replaced wherever it sits: a delta product.json carries /HEAD/, and
// one a previous build sealed carries the channel it was sealed for — re-sealing the same
// channel is a no-op (the `after === raw` short-circuit below says so), and re-pointing the
// identity at another channel is the seal doing its job, not an error.
product.updateUrl = product.updateUrl.replace(/\/(HEAD|master|beta|experimental)\//, `/${branch}/`);
product.nameShort = `PiCode${CHANNEL.label}`;
product.nameLong = product.nameLong.replace('PiCode', `PiCode${CHANNEL.label}`);
product.win32DirName = `PiCode${CHANNEL.label}`;
product.win32NameVersion = `PiCode${CHANNEL.label}`;
product.win32ShellNameShort = `PiCode${CHANNEL.label}`;
product.win32RegValueName = CHANNEL.reg;
product.win32AppUserModelId = `PiCode.${CHANNEL.reg}`;
product.win32MutexName = CHANNEL.slug;
product.win32TunnelMutex = `${CHANNEL.slug}-tunnel`;
product.win32TunnelServiceMutex = `${CHANNEL.slug}-tunnelservice`;
product.dataFolderName = `.${CHANNEL.slug}`;
product.sharedDataFolderName = `.${CHANNEL.slug}-shared`;
product.serverDataFolderName = `.${CHANNEL.slug}-server`;

// The AppIds are derived, not random: a channel always gets the same
// identifiers, so a rebuild is the same installer, and two channels can sit
// side by side. One hash per key, so x64 and arm64 never share an id.
//
// `stable` is left ALONE on purpose. Its AppId is the identity every install
// that already exists is registered under -- the installer and the uninstaller
// key off it -- so deriving a new one would orphan them. The stable build must
// be the product it has always been, down to the identifier.
if (channel !== 'stable') {
  for (const key of Object.keys(product)) {
    if (!/^win32.*AppId$/.test(key)) {
      continue;
    }
    const h = crypto.createHash('sha1')
      .update(`PiCode installer ${channel} ${key}`)
      .digest('hex').toUpperCase();
    product[key] = `{{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`
      + `-${h.slice(16, 20)}-${h.slice(20, 32)}}`;
  }
}

const after = JSON.stringify(product, null, '\t') + '\n';
if (after === raw) {
  console.log(`  channel already sealed: ${quality} (feed ${branch})`);
  process.exit(0);
}
fs.writeFileSync(file, after);
console.log(`  channel sealed: ${channel} -> quality "${quality}"`);
console.log(`  feed branch: ${branch}`);
console.log(`  profile: ${product.dataFolderName}`);
console.log(`  installs as: ${product.win32DirName}`);
console.log(`  mutex: ${product.win32MutexName}`);
NODE
fi


if ! APP_VERSION="${APP_VERSION}" node <<'NODE'
const fs = require('fs');
const file = 'package.json';
const version = process.env.APP_VERSION;
const raw = fs.readFileSync(file, 'utf8');
// The indentation is the file's to choose, and this tree indents package.json with four spaces. A
// pattern that only accepted a tab made the line unreachable: the build could say "already
// reports" but never move the number, which is how the tree stayed on one version.
const next = raw.replace(/^([ \t]+"version":\s*")[^"]*(")/m, `$1${version}$2`);

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
  echo "error: the version could not be written into package.json." >&2
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
  echo "source:  . (the PiCode source, identity checked)"
  echo "next:    ./build/build.sh    to install, compile and pack"
  picode_phase_end "ok"
  exit 0
fi

# The step that staged `extensions/picode-pi-chat` as a built-in extension was **removed on
# 2026-09-24 by the owner's decision**: pi lives in the core, and the extension is being
# migrated into it. Nothing compiled the directory, and on 2026-09-27 the owner deleted it
# («just delete it»): the panel's code remains in git history and in
# `.scratch/picode-pi-chat-ultima-copia.tar.gz`, and its two brand SVGs now live in
# `src/vs/workbench/contrib/picode/browser/media/`.
echo ""
echo "  -- dependencies"


export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# The install is the step this build exists to stop repeating. VS Code records the dependency
# state it installed in `node_modules/.postinstall-state`; build/build-helpers.mjs deps-current compares that
# against the tree as it is now, and the install is skipped ONLY when the two are identical.
# A partial or stale node_modules is never trusted: it is reinstalled, exactly as before.
reuse_node_modules="no"
if [[ "${FORCE_INSTALL}" != "yes" && -f node_modules/.postinstall-state ]]; then
  if node "${ROOT_DIR}/build/build-helpers.mjs" deps-current; then
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

# The packer strips the signatures of every Electron binary before it rewrites them, by spawning one
# `signtool remove` per file; those copies of signtool fail to launch on this machine and the pack
# died with 0xC0000142 minutes in. The fix is one line inside a package the dependency tree owns, so
# an install puts the original back and the build patches it again every time (idempotent).
node build/checks.mjs patch-gulp-electron

# ---------------------------------------------------------------------------
# What this build can reuse
# ---------------------------------------------------------------------------
# Three fingerprints, each covering the inputs of one step: the bundle reads src/, the extension
# build reads extensions/, and the pack reads both plus everything staged into it. A step whose
# inputs are byte-identical to the last successful build is skipped; its outputs are checked too, so
# a folder somebody deleted is rebuilt instead of trusted.
#
# `PICODE_FULL_BUILD=1` ignores all of it, for the day something looks stale and the answer needs to
# be "rebuild everything" without hunting for what to delete.
PICODE_CACHE_ENV=(
  "channel=${PICODE_CHANNEL:-}"
  "arch=${VSCODE_ARCH}"
  "pack=$( basename "${PACK_DIR}" )"
  "fast=${PICODE_FAST:-0}"
  "cli=${PICODE_REQUIRE_CLI:-0}"
)
KEY_APP=$( node build/build-helpers.mjs cache fingerprint app "${PICODE_CACHE_ENV[@]}" )
KEY_EXT=$( node build/build-helpers.mjs cache fingerprint extensions "${PICODE_CACHE_ENV[@]}" )
KEY_PACK=$( node build/build-helpers.mjs cache fingerprint pack "${PICODE_CACHE_ENV[@]}" )

# What the early exit trusts is exactly what the verification at the end trusts: an editor
# executable, the packaged out/, the durable agent and pi.
pack_intact() {
  [[ -d "${PACK_DIR}" ]] || return 1
  compgen -G "${PACK_DIR}/PiCode*.exe" > /dev/null || return 1
  [[ -f "${PACK_DIR}/resources/app/out/cli.js" ]] || return 1
  [[ -f "${PACK_DIR}/resources/durable/cli.js" ]] || return 1
  local pi_entry
  pi_entry="${PACK_DIR}/resources/pi-runtime/node_modules/$( node -p "require('./build/distribution/runtime.json').package" )/dist/index.js"
  [[ -f "${pi_entry}" ]] || return 1
}

if [[ "${PICODE_FULL_BUILD:-0}" != "1" ]] && pack_intact \
  && node build/build-helpers.mjs cache matches pack "${KEY_PACK}"; then
  echo ""
  echo "== nothing changed since the last successful build: $( basename "${PACK_DIR}" ) already is that build"
  echo "   PICODE_FULL_BUILD=1 rebuilds everything anyway."
  picode_phase_end "ok"
  exit 0
fi

export PICODE_SKIP_BUNDLE=0
export PICODE_SKIP_EXTENSIONS=0
if [[ "${PICODE_FULL_BUILD:-0}" != "1" ]]; then
  if node build/build-helpers.mjs cache matches app "${KEY_APP}" out-vscode-min/vs; then
    export PICODE_SKIP_BUNDLE=1
    echo "  -- src/ is unchanged: the last build's bundle is reused"
  fi
  if node build/build-helpers.mjs cache matches extensions "${KEY_EXT}" extensions/git/out extensions/markdown-language-features/out; then
    export PICODE_SKIP_EXTENSIONS=1
    echo "  -- extensions/ is unchanged: their compiled output is reused"
  fi
fi


# ---------------------------------------------------------------------------
# The connector
# ---------------------------------------------------------------------------
# PiCode's connector (`extensions/picode`) is compiled **here and not by the packer**:
# the packing step collects every extension under `extensions/` — which is how the
# connector gets inside the binary — but it does not run `tsc` for it, and an extension
# packaged without its `out/` never activates. It runs after the dependencies because it compiles
# with the tree's own typings, and before the pack because the pack is what collects it.
picode_phase 2 "connector" "compile the connector"

# The vscode-languageserver patch must land before the extensions compile: the markdown
# server's dist is regenerated from its node_modules here, and the patched uriToFilePath
# is what keeps the DEP0169 warning out of the extension host's console (see the script).
node build/checks.mjs patch-languageserver

bash build/build-connector.sh

# ---------------------------------------------------------------------------
# Compile
# ---------------------------------------------------------------------------
picode_phase 3 "compile" "compile the editor (vscode-min-prepack)"

export VSCODE_PUBLISH_COUNTER=1


# VSCodium's windows sequence: the prepack task compiles, then the group-policy
# definitions the packer copies, then the packer (phase 6 here). The packing task alone would
# pack a tree that was never compiled, which is why `vscode-min-prepack` is here even though
# the phase is named after the packer in the task name.
#
# VSCodium also runs `bash build/windows/rtf/make.sh` between those two. That step
# is deliberately absent here, and the reason is a defect that was found by
# running the phase: the file lives in the *VSCodium repository* (`build/windows/
# rtf/make.sh`, called by VSCodium as `. ../build/windows/rtf/make.sh`), not in
# VS Code and not in any patch, so `bash build/windows/rtf/make.sh` from the
# tree's root aborted the phase with exit 127 -- `./build/windows/` does not
# exist. It is also not needed: its only product is `LICENSE.rtf`, and the one reader of that
# file is `build/win32/code.iss`, which omits the licence page when the file is not there instead
# of aborting over it.
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


# ---------------------------------------------------------------------------
# Pack
# ---------------------------------------------------------------------------
picode_phase 4 "pack" "pack (vscode-${PACK_PLATFORM}-${VSCODE_ARCH}-min-packing)"

# The pack task deletes the whole pack folder before writing it (util.rimraf in
# build/gulpfile.vscode.ts), and data/ -- the portable profile -- lives inside it.
# So the profile is renamed aside first (build/data-hold.sh): a rename is atomic on the volume and
# costs nothing, where a copy would duplicate 1+ GB. If the rename is refused -- a running editor
# holds a log in data/ open, and Windows refuses to rename a directory with an open file inside
# -- the build stops HERE, with the folder and the profile untouched, instead of failing halfway
# through a delete that has already eaten PiCode.exe and resources/app.
# A hold left by an interrupted run is restored before anything else, so a build never packs on
# top of a profile that is sitting beside the folder.
#
# And the question the wrapper asked at the start is asked again here, where it still helps: the
# compile phases take minutes, and an editor opened during them is exactly how the build of
# 2026-10-06 00:19 died -- EBUSY inside the pack, with the profile already renamed aside. Answering
# it here stops the build while nothing has been moved and nothing deleted.
if [[ "${PICODE_BUILD_ANYWAY:-0}" != "1" ]] && picode_editor_running; then
  echo "error: PiCode is running, and the pack has to delete $( basename "${PACK_DIR}" )." >&2
  echo "       It was not running when this build started, so it was opened while the compile" >&2
  echo "       phases ran. Close it and build again: nothing has been moved or deleted yet." >&2
  echo "       PICODE_BUILD_ANYWAY=1 tries anyway (and will fail inside the pack if it is still open)." >&2
  exit 4
fi
# The profile goes aside **first**, and the order is the whole point of this phase: `data/` lives inside
# the folder that is about to be deleted, so a build that deletes without moving it aside first deletes
# the owner's profile with it. On 2026-10-07 that is exactly what happened: an edit to this file dropped
# these two lines, and the delete below took 56 861 files -- sessions, skills, providers -- with it. No
# other mechanism could have saved it: the profile is safe only because it is renamed out of reach
# *before* the delete runs.
picode_data_hold_recover "${PACK_DIR}" || exit 1
picode_data_hold_move_aside "${PACK_DIR}" || exit 1

# And the check that would have caught that edit, asked where it still helps: if `data/` is still inside
# the folder, then nothing was moved aside, and deleting now would take the profile. Refusing costs a
# build; deleting costs the owner his sessions, his skills and his providers. (The delete below is the
# only thing that can destroy them, and it is the one place a mistake is unrecoverable.)
if [[ -e "$( picode_data_dir "${PACK_DIR}" )" ]]; then
  echo "error: $( picode_data_dir "${PACK_DIR}" ) is still inside the pack folder, so the portable profile was NOT moved aside." >&2
  echo "       Refusing to delete '${PACK_DIR}': it is the step that would take the profile with it." >&2
  exit 1
fi

# The profile is beside the folder from here until the pack and the staging have finished, and it has
# to come back even when they fail: a build that dies in between used to leave it in the hold, so the
# next time the editor was opened it found no data at all. That is what happened on 2026-10-07 -- the
# pack refused with EBUSY (a handle Windows had not let go of), the build stopped, and the profile
# stayed aside until it was put back by hand. The restore lives in the trap above, which already runs
# on every exit: it used to skip when a `data/` existed, and a failed pack has usually seeded one, so
# the one case that needed it most was the one it did nothing for. It now calls
# `picode_data_hold_put_back`, which drops the seeded data/ and renames the hold back, and it says so
# on the way out. A second `trap ... EXIT` here would *replace* that one, taking the status file with
# it -- which is how this comment came to be written.

# The pack task deletes this folder with `util.rimraf` (see the note above), and that delete is the
# one that fails with EBUSY when anything still holds a file inside: gulp then kills the whole build
# minutes in, after everything else has been compiled. On 2026-10-07 that was a handle Windows had not
# released yet even though no editor was running -- the same teardown the profile's own rename waits
# 80 s for. So the delete is done here, where it can wait and say so, and only build output is at
# stake: `data/` was moved aside on the line above.
if [[ -d "${PACK_DIR}" ]]; then
  for attempt in $(seq 1 30); do
    rm -rf "${PACK_DIR}" 2>/dev/null && break
    if [[ "${attempt}" == "1" ]]; then
      echo "  -- something still holds $( basename "${PACK_DIR}" ) open: waiting up to 60 s for it to let go"
    fi
    sleep 2
  done
  if [[ -d "${PACK_DIR}" ]]; then
    echo "error: the pack folder '${PACK_DIR}' could not be deleted after 60 s: something still holds it open." >&2
    # Named, because "something holds it" is not something a person can act on. Measured on 2026-10-07:
    # the files that refused to open were inside it, and Windows' own Restart Manager reported **no**
    # process using the folder at all -- an antivirus or a search indexer holds it from a driver, which
    # no process list shows. Both answers are worth giving: the files when there are files, and the
    # scanner guess (with what to do about it) when there are none.
    locked="$( picode_data_locked_files "${PACK_DIR}" )"
    if [[ -n "${locked}" ]]; then
      echo "       These files inside it are held open right now:" >&2
      while IFS= read -r file; do
        echo "         ${file}" >&2
      done <<< "${locked}"
      echo "       Close whatever is using them (an editor open from this folder, or a tool watching it)." >&2
    else
      echo "       No file inside it refuses to open, so the folder itself is held -- a console whose current" >&2
      echo "       directory is inside it, or a scanner (antivirus, search indexer) holding it from a driver." >&2
      echo "       A scanner lets go on its own: build again in a few minutes." >&2
    fi
    echo "       Nothing but that folder's own build output was at stake, and the portable profile is safe in $( picode_data_hold_dir "${PACK_DIR}" )." >&2
    exit 1
  fi
fi


node --experimental-strip-types --max-old-space-size="${NODE_HEAP_MB}" ./node_modules/gulp/bin/gulp.js "vscode-${PACK_PLATFORM}-${VSCODE_ARCH}-min-packing"


# ---------------------------------------------------------------------------
# pi, the memory engine, and the distribution layer
# ---------------------------------------------------------------------------
# pi, the durable agent and the memory engine are independent: none reads another's output, and
# all three only write into the pack. Running them in parallel shaves the longest off the build
# instead of adding them.
picode_phase 5 "stage" "pi, the durable agent, the memory engine, and the distribution layer, onto ${PACK_DIR}"

bash build/pi-runtime.sh "${PACK_DIR}" &
PI_PID=$!
bash build/durable-runtime.sh "${PACK_DIR}" &
DURABLE_PID=$!
bash build/engram-runtime.sh "${PACK_DIR}" &
ENGRAM_PID=$!

PI_OK=0
DURABLE_OK=0
ENGRAM_OK=0
wait "${PI_PID}" && PI_OK=1 || PI_OK=0
wait "${DURABLE_PID}" && DURABLE_OK=1 || DURABLE_OK=0
wait "${ENGRAM_PID}" && ENGRAM_OK=1 || ENGRAM_OK=0

if [[ "${PI_OK}" -ne 1 || "${DURABLE_OK}" -ne 1 || "${ENGRAM_OK}" -ne 1 ]]; then
  echo "error: pi, durable or the memory engine failed to stage (pi=${PI_OK}, durable=${DURABLE_OK}, engram=${ENGRAM_OK})." >&2
  exit 1
fi

# And the distribution layer, which needs both of the above in place.
bash build/stage-distribution.sh "${PACK_DIR}"

# The Rust CLI (optional): gives the pack a real binary beside the shell shim. Never blocks the build.
# A fast build leaves it alone: the shell shim already runs the CLI, and cargo is another minute.
if [[ "${PICODE_FAST:-0}" == "1" ]]; then
  echo "  -- the Rust CLI: skipped in a fast build"
else
  bash build/build-cli.sh "${PACK_DIR}"
fi

# The pack and the staging seeded a fresh data/ inside the folder; the real profile -- held aside
# since before the pack -- goes back over it now, so everything after this point (the installer
# included) sees the owner's data, not a seed (build/data-hold.sh).
picode_data_hold_put_back "${PACK_DIR}" || exit 1

# ---------------------------------------------------------------------------
# Verify the pack before publishing it: a build that produced an editor without pi, or a
# product.json whose channel does not match, is worse than no build at all.
# ---------------------------------------------------------------------------
echo ""
echo "== verify - the pack is complete"
VERIFY_OK="yes"
# The editor's file name is the product's short name, and a channel build carries the channel in it:
# stable ships `PiCode.exe`, beta `PiCode Beta.exe`, experimental `PiCode Experimental.exe`. The seal
# sets `nameShort` to exactly that and the packer names the executable from it, so rather than repeat
# the mapping here (and risk it drifting from the seal), the name is read back from the packed
# product.json the packer itself wrote. A plain build with no channel still lands on `PiCode.exe`.
EDITOR_EXE="PiCode.exe"
PACKED_NAME=$( node -p "require(process.argv[1]).nameShort" "${PACK_DIR}/resources/app/product.json" 2> /dev/null || echo "" )
if [[ -n "${PACKED_NAME}" && "${PACKED_NAME}" != "undefined" ]]; then
  EDITOR_EXE="${PACKED_NAME}.exe"
fi
if [[ ! -f "${PACK_DIR}/${EDITOR_EXE}" ]]; then
  echo "  !! ${EDITOR_EXE} is missing" >&2; VERIFY_OK="no"
fi
PI_ENTRY="${PACK_DIR}/resources/pi-runtime/node_modules/$( node -p "require('./build/distribution/runtime.json').package" )/dist/index.js"
if [[ ! -f "${PI_ENTRY}" ]]; then
  echo "  !! pi runtime entry is missing: ${PI_ENTRY}" >&2; VERIFY_OK="no"
fi
# The memory engine travels with the product, so a pack without it is an editor that cannot
# remember — the reason the whole phase exists.
ENGRAM_BINARY="${PACK_DIR}/resources/memory/$( node -p "require('./build/distribution/engram.json').binary" )"
if [[ ! -f "${ENGRAM_BINARY}" ]]; then
  echo "  !! the memory engine is missing: ${ENGRAM_BINARY}" >&2; VERIFY_OK="no"
fi
# Where the binary is part of what is being published, the pack is not complete without it.
if [[ "${PICODE_REQUIRE_CLI:-0}" == "1" && ! -f "${PACK_DIR}/bin/picode-cli.exe" && ! -f "${PACK_DIR}/bin/picode-cli" ]]; then
  echo "  !! the Rust CLI is missing from ${PACK_DIR}/bin (PICODE_REQUIRE_CLI=1)" >&2; VERIFY_OK="no"
fi
if [[ -n "${PICODE_CHANNEL:-}" ]]; then
  BUILT_QUALITY=$( node -p "require(process.argv[1]).quality" "${PACK_DIR}/resources/app/product.json" 2> /dev/null || echo "" )
  if [[ "${BUILT_QUALITY}" != "${PICODE_CHANNEL}" ]]; then
    echo "  !! product.json quality is '${BUILT_QUALITY}', expected '${PICODE_CHANNEL}'" >&2; VERIFY_OK="no"
  fi
fi
if [[ "${VERIFY_OK}" == "yes" ]]; then
  # Smoke test: the editor must actually run. `--version` is a CLI query, not a GUI one -- the GUI
  # executable ignores it and opens a window, which stays open and hangs the build until the timeout
  # fires. The query goes through the CLI exactly the way `bin/picode.cmd` runs it: the exe as node
  # (ELECTRON_RUN_AS_NODE=1) over the packaged `out/cli.js`. A binary that crashes on launch would
  # otherwise be discovered only after publishing.
  CLI_ENTRY="${PACK_DIR}/resources/app/out/cli.js"
  if [[ "${OS_NAME}" == "windows" && -f "${PACK_DIR}/${EDITOR_EXE}" && -f "${CLI_ENTRY}" ]]; then
    if ELECTRON_RUN_AS_NODE=1 timeout 30 "${PACK_DIR}/${EDITOR_EXE}" "${CLI_ENTRY}" --version > "${ROOT_DIR}/.scratch/smoke.out" 2>&1; then
      echo "  ok: cli --version -> $( grep -v -i crashpad "${ROOT_DIR}/.scratch/smoke.out" | head -n1 )"
    else
      echo "  !! the editor's cli --version failed (see .scratch/smoke.out)" >&2
      VERIFY_OK="no"
    fi
  fi
  # product.json commit must be a full 40-hex sha (matches the release workflow's check).
  BUILT_COMMIT=$( node -p "require(process.argv[1]).commit" "${PACK_DIR}/resources/app/product.json" 2> /dev/null || echo "" )
  if [[ ! "${BUILT_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "  !! product.json commit is not a 40-hex sha: ${BUILT_COMMIT}" >&2
    VERIFY_OK="no"
  fi
  if [[ "${VERIFY_OK}" == "yes" ]]; then
    echo "  ok: ${EDITOR_EXE}, pi runtime and channel are in place"
  fi
else
  echo "error: the pack did not pass verification; see above." >&2
  exit 1
fi

# Phase 5 covers the staging and this verification; the installer below is an optional extra.
picode_phase_end "ok"

# These inputs produced this pack. The next build may reuse the parts it did not change.
node build/build-helpers.mjs cache record app "${KEY_APP}"
node build/build-helpers.mjs cache record extensions "${KEY_EXT}"
node build/build-helpers.mjs cache record pack "${KEY_PACK}"

# ---------------------------------------------------------------------------
# The Windows installer (off unless asked for)
# ---------------------------------------------------------------------------
# A local build leaves the portable pack only: running the installer would land on top of the PiCode
# already installed, which is the opposite of what building beside it is for. The release is the one
# place that wants both, and it says so with PICODE_SKIP_INSTALLER=no. On anything but Windows the
# installer script says so and stops, and the build carries on.
echo ""
if [[ "${PICODE_SKIP_INSTALLER:-yes}" == "yes" ]]; then
  echo "== the Windows installer: skipped (portable build; set PICODE_SKIP_INSTALLER=no to build it)"
else
  # A build that packs beside the tree installs beside the editor, unless it is told otherwise.
  # `PICODE_PACK_SUFFIX` already says "do not overwrite the release's folder"; the installer's
  # AppId is what decides whether it overwrites the release's *install*, so the same value is
  # taken for `PICODE_INSTALLER_SUFFIX` when nothing set it. Without this, the pack is new and the
  # installer quietly replaces the PiCode already on the machine. A release build sets neither.
  if [[ -z "${PICODE_INSTALLER_SUFFIX:-}" && -n "${PICODE_PACK_SUFFIX:-}" ]]; then
    export PICODE_INSTALLER_SUFFIX="${PICODE_PACK_SUFFIX}"
    echo "== the Windows installer installs beside the editor, as '${PICODE_INSTALLER_SUFFIX}'"
    echo "   (PICODE_INSTALLER_SUFFIX defaulted from PICODE_PACK_SUFFIX; set it to override)"
  fi
  echo "== the Windows installer (Inno Setup, user install)"

  bash build/build-installer.sh "${PACK_DIR}"
fi

echo ""
echo "== done"
printf '\a'
echo "Build finished: ${APP_VERSION:-?}"
# The product reports APP_VERSION (PiCode's own release). There is no VS Code tag to name any
# more: the tree IS the source, and which VS Code it descends from is recorded in
# upstream/stable.json and in the history of this repository.
echo "product:   PiCode ${APP_VERSION}"
echo "output:    ${PACK_DIR}"
echo "run it:    ${PACK_DIR}/${EDITOR_EXE}"
