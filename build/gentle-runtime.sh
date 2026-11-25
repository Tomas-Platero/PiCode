#!/usr/bin/env bash
# Build the pinned, package-local Gentle AI runtime for the Windows distribution.
set -euo pipefail

PACK_DIR="${1:?usage: build/gentle-runtime.sh <pack dir>}"
PIN="$(pwd)/build/distribution/gentle-ai.json"
GENTLE_PI_VERSION=$(node -p "require(process.argv[1]).gentlePiVersion" "${PIN}")
GENTLE_AI_VERSION=$(node -p "require(process.argv[1]).gentleAiVersion" "${PIN}")
TEMP_ROOT=$(cd "${TMPDIR:-/tmp}" && pwd -P)
WORK=$(mktemp -d "${TEMP_ROOT}/picode-gentle-build.XXXXXXXX")
cleanup() {
  local resolved
  resolved=$(cd "${WORK}" && pwd -P)
  case "${resolved}" in
    "${TEMP_ROOT}"/picode-gentle-build.*) rm -rf -- "${resolved}" ;;
    *) echo "error: refusing to remove unexpected temporary directory" >&2; return 1 ;;
  esac
}
trap cleanup EXIT

win_path() {
  if command -v cygpath > /dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# Install only into the temporary directory; the upstream installer verifies its Go source pin.
npm install --prefix "$(win_path "${WORK}")" --ignore-scripts --no-audit --no-fund "gentle-pi@${GENTLE_PI_VERSION}"
node --input-type=module - "$(win_path "${WORK}/node_modules/gentle-pi")" "${GENTLE_AI_VERSION}" <<'NODE'
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageRoot, version] = process.argv.slice(2);
const { installGentleAi, INSTALLER_VERSION } = await import(pathToFileURL(join(packageRoot, 'scripts', 'gentle-ai-installer.mjs')).href);
if (INSTALLER_VERSION !== version) {
  throw new Error('gentle-pi requires a different version of Gentle AI');
}
await installGentleAi({ packageRoot });
NODE
SOURCE="${WORK}/node_modules/gentle-pi/.gentle-ai/v${GENTLE_AI_VERSION}"
TARGET="${PACK_DIR}/resources/gentle-ai/v${GENTLE_AI_VERSION}"

mkdir -p "${TARGET}"
cp "${SOURCE}/gentle-ai.exe" "${TARGET}/gentle-ai.exe"
cp "${SOURCE}/integrity.json" "${TARGET}/integrity.json"
cp "${PIN}" "${PACK_DIR}/resources/gentle-ai/pin.json"
node build/verify-gentle-runtime.mjs "$(win_path "${PACK_DIR}/resources/gentle-ai")" "${VSCODE_ARCH:-$(node -p 'process.arch')}"
