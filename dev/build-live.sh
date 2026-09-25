#!/usr/bin/env bash
#
# The build, with a line that says how much is left.
#
# The plain build prints its phases, but the long ones go quiet for minutes and there is no way to
# tell "working" from "stuck". This runs it exactly as `dev/build.sh` does — same flags, same log
# file, same exit code — and puts `dev/build-progress.mjs` in front, drawing one line with the
# stage and the percentage while the build works.
#
# Usage: dev/build-live.sh [build.sh flags...]        (default: -s, the resume-a-prepared-tree build)
#
# The log is written to `.scratch/build-live.log` so the viewer can read it, and the build's own
# output is not lost: it is in that file.

set -eo pipefail

FLAGS=("$@")
if (( ${#FLAGS[@]} == 0 )); then
  FLAGS=(-s)
fi

LOG=".scratch/build-live.log"
mkdir -p .scratch
: > "${LOG}"

# The build in the background, its output going to the log the viewer reads.
bash dev/build.sh "${FLAGS[@]}" > "${LOG}" 2>&1 &
BUILD_PID=$!

# The viewer in the foreground, until the build ends. It redraws one line; when the build is
# finished it says so and returns.
node dev/build-progress.mjs "${LOG}"

wait "${BUILD_PID}"
STATUS=$?

echo ""
if [[ "${STATUS}" -eq 0 ]]; then
  echo "== build terminada bien"
  echo "   editor: ${PACK_DIR:-./VSCode-win32-x64}/PiCode.exe"
  echo "   registro: ${LOG}"
else
  echo "== la build falló (código ${STATUS})"
  echo "   mira ${LOG}, y sus últimas líneas:"
  tail -20 "${LOG}"
fi

exit "${STATUS}"
