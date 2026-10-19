#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Builds PiCode's Rust CLI (`picode-source/cli`) and drops the binary into the pack's `bin/`,
# so a source build ships the CLI instead of only the shell shim.
#
# Optional: if cargo is missing, OpenSSL is absent outside CI, or the build fails, this prints one
# clear line and exits 0, so the editor build is never blocked by it. Set PICODE_BUILD_CLI=no to skip
# it entirely, or =yes to force the native build even without a discoverable OpenSSL.
#
# Usage: build/build-cli.sh <pack dir>

set -uo pipefail

if [[ "${PICODE_BUILD_CLI:-yes}" == "no" ]]; then
  echo "cli: skipped (PICODE_BUILD_CLI=no)"
  exit 0
fi

PACK_DIR="${1:?usage: build/build-cli.sh <pack dir>}"

if ! command -v cargo > /build/null 2>&1; then
  echo "cli: cargo not found; skipping (install rustup to build it)."
  exit 0
fi

CLI_DIR="./picode-source/cli"
if [[ ! -f "${CLI_DIR}/Cargo.toml" ]]; then
  echo "cli: ${CLI_DIR}/Cargo.toml missing; skipping."
  exit 0
fi

# The CLI's dependency tree pulls `openssl-sys` on Windows (through the keyring/secret-service
# features), so cargo refuses to build it without an OpenSSL development install - and a source build
# should not demand one: the pack already carries `bin/picode.cmd`, which runs the same CLI through
# the editor. Outside CI, when no OpenSSL is discoverable, skip with one clear line instead of a
# failed compile and a cargo error dump. CI keeps trying (its runners have OpenSSL), and
# PICODE_BUILD_CLI=yes forces the attempt anywhere.
if [[ "${PICODE_BUILD_CLI:-auto}" != "yes" && "${CI:-}" != "true" && "${GITHUB_ACTIONS:-}" != "true" ]]; then
  if [[ -z "${OPENSSL_DIR:-}" && -z "${X86_64_PC_WINDOWS_MSVC_OPENSSL_DIR:-}" && -z "${VCPKG_ROOT:-}" ]]; then
    echo "cli: skipped (no OpenSSL development install; the pack keeps the shell shim, which runs the CLI)."
    echo "cli: set OPENSSL_DIR or PICODE_BUILD_CLI=yes to build the native binary anyway."
    exit 0
  fi
fi

echo "cli: building the Rust CLI (release)..."
if ! ( cd "${CLI_DIR}" && cargo build --release ); then
  echo "cli: cargo build failed; the pack keeps the shell shim only." >&2
  exit 0
fi

# The binary lands in target/release/code (or code.exe on Windows).
BINARY=""
for candidate in "${CLI_DIR}/target/release/code.exe" "${CLI_DIR}/target/release/code"; do
  if [[ -f "${candidate}" ]]; then
    BINARY="${candidate}"
    break
  fi
done

if [[ -z "${BINARY}" ]]; then
  echo "cli: build finished but no binary was found; skipping."
  exit 0
fi

mkdir -p "${PACK_DIR}/bin"
cp -f "${BINARY}" "${PACK_DIR}/bin/picode-cli"
if [[ "${BINARY}" == *.exe ]]; then
  cp -f "${BINARY}" "${PACK_DIR}/bin/picode-cli.exe"
fi
echo "cli: ${BINARY} -> ${PACK_DIR}/bin/picode-cli"
exit 0