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
# Usage: dev/build-live.sh [build.sh flags...]        (default: the whole build)
#
# The log is `.scratch/build-live.log`; the same file the window reads.

set -eo pipefail

FLAGS=("$@")

mkdir -p .scratch

bash build/build-run.sh "${FLAGS[@]}" &
BUILD_PID=$!

# The viewer in the foreground, until the build ends and the log says so.
node build/build-progress.mjs .scratch/build-live.log || true

wait "${BUILD_PID}"
STATUS=$?

echo ""
if [[ "${STATUS}" -eq 0 ]]; then
  echo "== build finished successfully"
  # The pack folder and the editor's name both carry the channel (dev/build.sh seals them). Reading
  # the packed product.json back, the way the verification does, keeps this line from naming a file
  # that is not there - `PiCode.exe` under a channel build does not exist.
  PACK_DIR="./PiCode-Win32-x64"
  case "${PICODE_CHANNEL:-}" in
    beta | experimental) PACK_DIR="./PiCode-Win32-x64-${PICODE_CHANNEL}" ;;
  esac
  EDITOR="PiCode.exe"
  NAME=$( node -p "require('${PACK_DIR}/resources/app/product.json').nameShort" 2> /dev/null || echo "" )
  if [[ -n "${NAME}" && "${NAME}" != "undefined" ]]; then
    EDITOR="${NAME}.exe"
  fi
  echo "   editor: ${PACK_DIR}/${EDITOR}"
  echo "   log: .scratch/build-live.log"
else
  echo "== build failed (exit code ${STATUS})"
  echo "   see .scratch/build-live.log, and its last lines:"
  tail -20 .scratch/build-live.log
fi

exit "${STATUS}"
