#!/usr/bin/env bash
#
# Runs a build, and leaves behind everything a watcher needs to follow it.
#
# `dev/build.sh` alone prints its phases and nothing else: a caller cannot tell whether a build is
# running, how far it got, or how it ended. This wraps it for the callers that need that — the
# terminal viewer and the little window — and writes three things:
#
#   .scratch/build.lock     the pid of the build in flight; its absence means nothing is running
#   .scratch/build-live.log  the build's own output, as it arrives
#   .scratch/build.status    the exit code, once it ends
#
# It also takes care of the owner's profile, which the pack deletes when it rewrites the platform
# directory: copied aside before the build, put back after. A collaborator with nothing there loses
# nothing; somebody building over the editor they use every day would lose everything.
#
# Usage: dev/build-run.sh [build.sh flags...]        (default: the whole build)
#
# With no flags it runs `dev/build.sh` with no flags: check the source, install what is missing,
# compile, pack and stage. That is what "build" means to a person, and it is safe to repeat —
# the source is never fetched and the dependencies are installed once, so a repeat build is
# compile and pack and nothing else.
#
# One at a time: a second runner refuses to start while the lock is alive, because two builds in one
# tree fight over `node_modules` and over the directory they pack into.

set -eo pipefail

# The one definition of "is an editor running?" lives beside the profile it protects
# (`dev/data-hold.sh`), because the build asks the same question again before the pack.
# shellcheck source=dev/data-hold.sh
source "$( dirname "$0" )/data-hold.sh"

FLAGS=("$@")

mkdir -p .scratch
LOCK=".scratch/build.lock"
LOG=".scratch/build-live.log"
STATUS=".scratch/build.status"

if [[ -f "${LOCK}" ]]; then
  RUNNING=$( cat "${LOCK}" )
  if kill -0 "${RUNNING}" 2> /dev/null; then
    echo "error: a build is already running (pid ${RUNNING})." >&2
    echo "       watch it with the window, or with: node dev/build-progress.mjs" >&2
    exit 3
  fi
  # A lock whose process is gone is a build that died: it is not a reason to refuse forever.
  rm -f "${LOCK}"
fi

# The pack deletes the platform directory before writing it, and Windows refuses to delete the
# files of a program that is running: an editor open from that folder turns a build into an EBUSY
# inside the pack, minutes after it started. Asked here, where it is one line and one second -- and
# again in `build.sh` before the pack, because this answer can go stale while a build runs.
if [[ "${FLAGS[0]}" != "-DepsOnly" ]] && picode_editor_running; then
  if [[ "${PICODE_BUILD_ANYWAY:-0}" != "1" ]]; then
    echo "error: PiCode is running, and the build has to replace PiCode-Win32-x64." >&2
    echo "       Close the editor first (the pack cannot delete a folder in use), or" >&2
    echo "       set PICODE_BUILD_ANYWAY=1 to try anyway." >&2
    exit 4
  fi
fi

echo $$ > "${LOCK}"
rm -f "${STATUS}"
: > "${LOG}"

cleanup() {
  rm -f "${LOCK}"
}
trap cleanup EXIT

# The owner's profile is **not** copied here. It lives at <pack>/data, and the pack's own delete would
# eat it -- which is what `dev/data-hold.sh` exists for: a rename aside (atomic, no 1+ GB duplicate) and
# back, done by `dev/build.sh` around the pack phase, with its own recovery at the start of the next
# run. The copy-and-restore that used to sit on these two lines was a second mechanism for the same
# folder, and it named it without the suffix this runner builds with (PiCode-Win32-x64 instead of
# "PiCode-win32-x64 - experimental"), so all it ever produced was an empty skeleton profile beside the
# real one. One mechanism, and it is the one that cannot get the folder wrong: it takes the pack
# directory it is given.

set +e
if [[ "${FLAGS[0]}" == "-DepsOnly" ]]; then
  # The dependency install on its own: it is the longest phase, and when it fails there is no point
  # compiling anything. Its retries and its flags are the build's own, so both paths behave alike.
  (
    cd picode-source || exit 2
    export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    node build/npm/preinstall.ts
    for attempt in {1..5}; do
      if npm ci; then exit 0; fi
      if [[ "${attempt}" == 5 ]]; then exit 1; fi
      echo "npm install failed ${attempt}, trying again..."
      sleep $(( 15 * (attempt + 1) ))
    done
  ) >> "${LOG}" 2>&1
  BUILD_STATUS=$?
else
  bash dev/build.sh "${FLAGS[@]}" >> "${LOG}" 2>&1
  BUILD_STATUS=$?
fi
set -e


echo "${BUILD_STATUS}" > "${STATUS}"
exit "${BUILD_STATUS}"
