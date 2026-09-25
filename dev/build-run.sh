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
# Usage: dev/build-run.sh [build.sh flags...]        (default: -s)
#
# One at a time: a second runner refuses to start while the lock is alive, because two builds in one
# tree fight over `node_modules` and over the directory they pack into.

set -eo pipefail

FLAGS=("$@")
if (( ${#FLAGS[@]} == 0 )); then
  FLAGS=(-s)
fi

mkdir -p .scratch
LOCK=".scratch/build.lock"
LOG=".scratch/build-live.log"
STATUS=".scratch/build.status"
BACKUP=".scratch/payload-data-backup"

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

echo $$ > "${LOCK}"
rm -f "${STATUS}"
: > "${LOG}"

cleanup() {
  rm -f "${LOCK}"
}
trap cleanup EXIT

# The owner's profile, if there is one to keep.
if [[ -d "VSCode-win32-x64/data" ]]; then
  rm -rf "${BACKUP}"
  cp -r "VSCode-win32-x64/data" "${BACKUP}" 2> /dev/null || true
fi

set +e
if [[ "${FLAGS[0]}" == "-DepsOnly" ]]; then
  # The dependency install on its own: it is the longest phase, and when it fails there is no point
  # compiling anything. Its retries and its flags are the build's own, so both paths behave alike.
  (
    cd vscode || exit 2
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

node dev/restore-profile.mjs >> "${LOG}" 2>&1 || true

echo "${BUILD_STATUS}" > "${STATUS}"
exit "${BUILD_STATUS}"
