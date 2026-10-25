#!/usr/bin/env bash
#
# Puts the memory engine inside the editor that was just built.
#
# Why this step exists: PiCode's memory is not a service the owner installs, it is a program the
# product carries — the same rule pi already follows. The editor looks for it
# by walking a short list of folders, and the only candidate an *installed* PiCode has is the one
# this script writes: `<pack>/resources/memory/engram.exe`. Without it, an installation can only
# say "the memory engine was not found", which is exactly what the owner's rule is about:
# *"si un usuario escribe engram tiene que funcionar"*.
#
# What travels: one pinned release, verified by its published SHA-256. The version lives in
# `distribution/engram.json` and is never `latest` for a reason the memory makes sharper than
# usual: the store it opens (`~/.engram`) is shared with whatever other engram is on the machine.
# An engine that moves on its own could migrate somebody else's memories without asking.
#
# What does not travel: the `gentle-engram` pi package. PiCode removed gentle-ai and keeps its
# packages out of an import (`extensions/picode/src/left-behind-packages.ts`); the memory
# protocol is written here instead of inherited from it.
#
# Engram is MIT, and its name and logo belong to its author. Shipping the engine is allowed;
# dressing any surface as their product is not.
#
# Run from the repository root, by `build/build.sh` (phase 5), not by hand.
#
# Usage: build/engram-runtime.sh <pack dir>

set -eo pipefail

PACK_DIR="${1:?usage: build/engram-runtime.sh <pack dir>}"
PIN="./build/distribution/engram.json"
TARGET="${PACK_DIR}/resources/memory"

if [[ ! -f "${PIN}" ]]; then
  echo "error: ${PIN} is missing; it carries the pinned memory engine." >&2
  exit 2
fi

# Read with node, like the pi pin, so the build does not ask for jq.
VERSION=$( node -p "require('./build/distribution/engram.json').version" )
BINARY=$( node -p "require('./build/distribution/engram.json').binary" )

if [[ -z "${VERSION}" || "${VERSION}" == "null" || -z "${BINARY}" || "${BINARY}" == "null" ]]; then
  echo "error: ${PIN} must declare a version and a binary." >&2
  exit 2
fi

# Only Windows is built; the two Windows releases are the ones pinned.
case "${VSCODE_ARCH:-x64}" in
  x64)   ASSET_KEY="asset";    SHA_KEY="sha256" ;;
  arm64) ASSET_KEY="assetArm64"; SHA_KEY="sha256Arm64" ;;
  *) echo "error: no memory engine is pinned for arch '${VSCODE_ARCH}'." >&2; exit 2 ;;
esac

ASSET=$( node -p "require('./build/distribution/engram.json')['${ASSET_KEY}']" )
EXPECTED=$( node -p "require('./build/distribution/engram.json')['${SHA_KEY}']" )

if [[ -z "${ASSET}" || "${ASSET}" == "null" || -z "${EXPECTED}" || "${EXPECTED}" == "null" ]]; then
  echo "error: ${PIN} does not pin the ${VSCODE_ARCH} release." >&2
  exit 2
fi

URL="https://github.com/Gentleman-Programming/engram/releases/download/v${VERSION}/${ASSET}"
CACHE=".build/engram/${VERSION}"
ZIP="${CACHE}/${ASSET}"

# PowerShell for the three Windows-only steps: fetching, hashing and unzipping. The build already
# requires no tool beyond node and bash, and `curl`/`unzip` are not part of a Git for Windows
# install that somebody may have trimmed.
win_path() {
  if command -v cygpath > /dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

powershell() {
  powershell.exe -NoProfile -NonInteractive -Command "$1"
}

mkdir -p "${CACHE}" "${TARGET}"

if [[ ! -f "${ZIP}" ]]; then
  echo "downloading the memory engine ${VERSION} (${ASSET})"
  if ! powershell "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '${URL}' -OutFile '$(win_path "${ZIP}")'"; then
    echo "error: could not download ${URL}" >&2
    rm -f "${ZIP}"
    exit 1
  fi
fi

ACTUAL=$( powershell "(Get-FileHash -Algorithm SHA256 -LiteralPath '$(win_path "${ZIP}")').Hash" | tr -d '\r' | tr '[:upper:]' '[:lower:]' )
EXPECTED_LOWER=$( printf '%s' "${EXPECTED}" | tr '[:upper:]' '[:lower:]' )

if [[ "${ACTUAL}" != "${EXPECTED_LOWER}" ]]; then
  echo "error: the memory engine does not match its pin." >&2
  echo "       expected sha256 ${EXPECTED_LOWER}" >&2
  echo "       got      sha256 ${ACTUAL:-<nothing>}" >&2
  echo "       The cached download has been removed; the build never ships an unverified binary." >&2
  rm -f "${ZIP}"
  exit 1
fi

UNPACKED="${CACHE}/unpacked-${VSCODE_ARCH:-x64}"
rm -rf "${UNPACKED}"
mkdir -p "${UNPACKED}"
powershell "Expand-Archive -LiteralPath '$(win_path "${ZIP}")' -DestinationPath '$(win_path "${UNPACKED}")' -Force"

FOUND=$( find "${UNPACKED}" -type f -name "${BINARY}" | head -n 1 )
if [[ -z "${FOUND}" ]]; then
  echo "error: ${ASSET} does not contain ${BINARY}." >&2
  exit 1
fi

echo "copying the memory engine into ${TARGET}"
cp "${FOUND}" "${TARGET}/${BINARY}"

# The check that matters: the program is asked to start from where it now lives. A file that is
# present but cannot run would put the failure in the owner's editor instead of in this build.
INSTALLED=$( "${TARGET}/${BINARY}" version 2>&1 | tr -d '\r' | head -n 1 )
if [[ "${INSTALLED}" != *"${VERSION}"* ]]; then
  echo "error: the memory engine does not start from the pack." >&2
  echo "       \`${TARGET}/${BINARY} version\` said: ${INSTALLED:-<nothing>}" >&2
  exit 1
fi

if [[ ! -d "$HOME/.engram" ]]; then
  echo "  -- no existing memory on this machine yet: the engine creates one on first run"
fi

echo "memory engine in place: ${TARGET}/${BINARY} (${INSTALLED}, $( du -sh "${TARGET}" | cut -f1 ))"
