#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Puts PiCode's own pi inside the editor that was just built.
#
# Why this step exists: the build compiles the **editor**, but pi is a separate package that
# has to be fetched. Until this script existed, nothing fetched it — it was the old
# extension that installed pi on demand, and taking that extension out left every freshly
# built editor without a pi to talk to. The connector could find it and could not say
# anything but "no encuentro el pi de este editor".
#
# The owner's rule is what shapes it: *"quiero que esté funcional, no quiero tener yo que
# configurar más cosas más allá del proveedor"*. So the runtime ships installed, at a pinned
# version, and no human step is involved.
#
# The version is pinned in `distribution/runtime.json` and not taken from `latest`: an editor
# built today must behave the same in six months.
#
# Run from the repository root, by `dev/build.sh` (phase 7), not by hand.

set -eo pipefail

PACK_DIR="${1:?usage: dev/pi-runtime.sh <pack dir>}"
PIN="./distribution/runtime.json"

if [[ ! -f "${PIN}" ]]; then
  echo "error: ${PIN} is missing; it carries the pinned pi version." >&2
  exit 2
fi

# Read with node rather than jq. This was the last place in the build that wanted jq, and the
# build should not ask a collaborator to install a tool for two lines of JSON.
PACKAGE=$( node -p "require('./distribution/runtime.json').package" )
VERSION=$( node -p "require('./distribution/runtime.json').version" )

if [[ -z "${PACKAGE}" || "${PACKAGE}" == "null" || "${PACKAGE}" == "undefined" || -z "${VERSION}" || "${VERSION}" == "null" || "${VERSION}" == "undefined" ]]; then
  echo "error: ${PIN} must declare a package and a version." >&2
  exit 2
fi

TARGET="${PACK_DIR}/resources/pi-runtime"
ENTRY="${TARGET}/node_modules/${PACKAGE}/dist/index.js"

# The pruning is idempotent and cheap, so it also runs on a tree that already has pi: a build that
# found pi installed would otherwise keep the other platforms' binaries for ever.
prune_platforms() {
  node dev/prune-platform-binaries.mjs "${TARGET}/node_modules" "${OS_NAME_PLATFORM:-}" "${VSCODE_ARCH:-}"
}

if [[ -f "${ENTRY}" ]]; then
	# The entry existing is NOT enough: an older pinned runtime must be refreshed when the
	# pin moves, or an editor built today would silently ship the version installed months
	# ago. Compare the installed version against the pin and reinstall when they differ.
	INSTALLED=$( node -p "try { require('./' + process.argv[1]).version } catch { '' }" "${TARGET}/node_modules/${PACKAGE}/package.json" 2>/dev/null || true )
	if [[ "${INSTALLED}" == "${VERSION}" ]]; then
		echo "pi ${VERSION} is already in ${TARGET}"
		prune_platforms
		exit 0
	fi
	echo "pi ${INSTALLED:-<none>} is in ${TARGET} but the pin says ${VERSION}; updating."
fi

# The package names its platform the way node does (`win32`), not the way the build script does
# (`windows`).
case "${OS_NAME:-windows}" in
  windows) OS_NAME_PLATFORM="win32" ;;
  osx) OS_NAME_PLATFORM="darwin" ;;
  *) OS_NAME_PLATFORM="linux" ;;
esac

echo "installing ${PACKAGE}@${VERSION} into ${TARGET}"
mkdir -p "${TARGET}"

# `--prefix` and not a `cd`: the install belongs to that directory and nothing about the
# caller's working directory should leak into it. npm's own cache means a second build does
# not download it again.
npm install --prefix "${TARGET}" --no-audit --no-fund --loglevel=error "${PACKAGE}@${VERSION}"

# The check that matters: the connector looks for this exact file, and a runtime that
# installed "successfully" without it would leave the editor saying it cannot find pi.
if [[ ! -f "${ENTRY}" ]]; then
  echo "error: ${ENTRY} is missing after installing; the editor would have no pi to run." >&2
  exit 1
fi

prune_platforms

echo "pi ${VERSION} in place: ${ENTRY}"
