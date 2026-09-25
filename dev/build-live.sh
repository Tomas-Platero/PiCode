#!/usr/bin/env bash
#
# The build, with a line that says how much is left.
#
# The plain build prints its phases, but the long ones go quiet for minutes and there is no way to
# tell "working" from "stuck". This runs the same build — through `dev/build-run.sh`, so the lock,
# the log, the exit code and the owner's profile are all handled the same way the window handles
# them — and puts `dev/build-progress.mjs` in front, drawing one line with the stage, a bar and an
# estimate of what is left.
#
# Usage: dev/build-live.sh [build.sh flags...]        (default: -s, a rebuild of a prepared tree)
#
# The log is `.scratch/build-live.log`; the same file the window reads.

set -eo pipefail

FLAGS=("$@")
if (( ${#FLAGS[@]} == 0 )); then
  FLAGS=(-s)
fi

mkdir -p .scratch

bash dev/build-run.sh "${FLAGS[@]}" &
BUILD_PID=$!

# The viewer in the foreground, until the build ends and the log says so.
node dev/build-progress.mjs .scratch/build-live.log || true

wait "${BUILD_PID}"
STATUS=$?

echo ""
if [[ "${STATUS}" -eq 0 ]]; then
  echo "== build terminada bien"
  echo "   editor: ./VSCode-win32-x64/PiCode.exe"
  echo "   registro: .scratch/build-live.log"
else
  echo "== la build falló (código ${STATUS})"
  echo "   mira .scratch/build-live.log, y sus últimas líneas:"
  tail -20 .scratch/build-live.log
fi

exit "${STATUS}"
