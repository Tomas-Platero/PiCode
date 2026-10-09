#!/usr/bin/env bash
#
# Puts the durable agent inside the editor that was just built.
#
# Why this step exists: the agent is the repository's `picode-source/durable` program — a headless
# daemon that owns its conversations in SQLite and serves local clients over a named pipe — and the
# editor finds it by walking a short list of folders (`extensions/picode/src/durable-folder.ts`).
# Two of those folders are the source tree's. The third is this one, `<pack>/resources/durable`,
# and it is the only candidate an *installed* PiCode has: an installation has no repository above it
# and the folder that happens to be open is somebody else's project. Without this step an installed
# editor can only answer "the durable agent folder was not found" — which is exactly what the
# owner's rule ("it has to be wherever PiCode is installed") is about.
#
# What travels: the program, the chat's bridge, and the dependencies those two actually load.
#
#   * `.data/` is left behind **on purpose**. It holds the proofs' state, stale pid files, logs and
#     profiles with credentials in them (`bare-profile/auth.json`) — none of it is the product, and a
#     published installer must not carry any of it.
#   * the proofs are left behind too (`proof-*.sh`, `proof*.js`, `smoke.js`): they are how the
#     agent was measured, not what the editor runs.
#   * everything else goes, `node_modules` included: `cli.js` resolves its dependencies from this
#     folder's own `node_modules`, so a missing package is an agent that does not start. The build
#     also installs them here when a fresh clone has none (they are ignored by git), because a step
#     that silently shipped an agent with no dependencies would be worse than no step at all.
#
# Run from the repository root, by `dev/build.sh` (phase 5), not by hand.
#
# Usage: dev/durable-runtime.sh <pack dir>

set -eo pipefail

PACK_DIR="${1:?usage: dev/durable-runtime.sh <pack dir>}"

SOURCE="./picode-source/durable"
BRIDGE="./picode-source/durable-bridge"
TARGET="${PACK_DIR}/resources/durable"
BRIDGE_TARGET="${PACK_DIR}/resources/durable-bridge"

if [[ ! -f "${SOURCE}/cli.js" ]]; then
  echo "error: ${SOURCE}/cli.js is missing, so there is no durable agent to ship." >&2
  echo "       The editor looks for it at \"picode-source/durable\" and in resources/durable;" >&2
  echo "       without the file the installed editor can only say it was not found." >&2
  exit 2
fi

if [[ ! -d "${SOURCE}/node_modules" ]]; then
  echo "the durable agent's dependencies are not installed: npm ci in ${SOURCE}"
  ( cd "${SOURCE}" && npm ci --no-audit --no-fund --loglevel=error )
fi

echo "copying the durable agent into ${TARGET}"
mkdir -p "${TARGET}"
cp -r "${SOURCE}/." "${TARGET}/"
# State, credentials and the proofs' logs never leave this machine.
rm -rf "${TARGET}/.data" \
       "${TARGET}/proof-acp.sh" "${TARGET}/proof-daemon.sh" \
       "${TARGET}"/proof*.js "${TARGET}/smoke.js"

# The bridge, right where the agent expects its sibling: `durableBridgeExtensionPath()` reads
# `path.join(folder, '..', 'durable-bridge', 'extension.ts')`.
echo "copying the chat's bridge into ${BRIDGE_TARGET}"
mkdir -p "${BRIDGE_TARGET}"
cp -r "${BRIDGE}/." "${BRIDGE_TARGET}/"
rm -rf "${BRIDGE_TARGET}/.data" "${BRIDGE_TARGET}/.atl" "${BRIDGE_TARGET}/proof-kill-survive.mjs"

# The package names its platform the way node does (`win32`), not the way the build script does
# (`windows`). One platform's binary per dependency is the only one this pack will ever run.
case "${OS_NAME:-windows}" in
  windows) OS_NAME_PLATFORM="win32" ;;
  osx) OS_NAME_PLATFORM="darwin" ;;
  *) OS_NAME_PLATFORM="linux" ;;
esac

node dev/prune-platform-binaries.mjs "${TARGET}/node_modules" "${OS_NAME_PLATFORM}" "${VSCODE_ARCH:-}"

# The check that matters, and the reason this is not just a copy: `cli.js` loads its dependencies
# from the folder it sits in, so a package that did not travel is an agent that cannot start — and an
# installed editor would only discover it when the owner asked it to do something. The list is read
# from the agent's own package.json rather than written here, so adding a dependency upstream cannot
# quietly ship an incomplete agent.
MISSING=$( node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const root = process.argv[2];
const missing = Object.keys(pkg.dependencies ?? {}).filter(name => !fs.existsSync(`${root}/node_modules/${name}`));
if (missing.length > 0) { console.log(missing.join(", ")); }
' "${SOURCE}/package.json" "${TARGET}" )

if [[ -n "${MISSING}" ]]; then
  echo "error: these dependencies did not travel with the agent: ${MISSING}" >&2
  echo "       cli.js loads them from ${TARGET}/node_modules, so the agent would not start." >&2
  exit 1
fi

# And the agent is asked to start, once, from where it now lives: the dependencies being present is
# not the same as the program loading them. `--help` prints its usage and exits; it imports the same
# modules `serve` does, the SQLite storage among them.
if ! node "${TARGET}/cli.js" --help > /dev/null 2>&1; then
  echo "error: the agent does not start from the pack (node ${TARGET}/cli.js --help failed)." >&2
  echo "       Run it by hand for the reason; shipping it like this would put the failure in the" >&2
  echo "       owner's editor instead of in this build." >&2
  exit 1
fi

echo "durable agent in place: ${TARGET}/cli.js ($( du -sh "${TARGET}" | cut -f1 ))"
