#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Builds PiCode's Rust CLI (`cli/`) and drops the binary into the pack's `bin/`,
# so a source build ships the CLI instead of only the shell shim.
#
# Optional by default: if cargo is missing, or the build fails, this prints one clear line and
# exits 0, so the editor build is never blocked by it. Set PICODE_BUILD_CLI=no to skip it entirely,
# or PICODE_REQUIRE_CLI=1 to turn every skip and failure into an error. CI and the release set the
# last one: an editor published without the binary is a promise the product does not keep.
#
# OpenSSL is not something this script looks for. The CLI needs it (through `russh`, which
# `tunnels` pulls in), and `cli/Cargo.toml` asks for the vendored build, so openssl-sys compiles a
# private copy and links it statically. That costs a few minutes the first time and nothing after
# that, and it means the only external tool is Perl, which OpenSSL's own configure needs.
#
# Usage: build/build-cli.sh <pack dir>

set -uo pipefail

# How a build that cannot produce the binary ends: one line and success locally, an error where the
# binary is part of what is being published.
give_up() {
  if [[ "${PICODE_REQUIRE_CLI:-0}" == "1" ]]; then
    echo "error: the Rust CLI is required here and was not built: $1" >&2
    exit 1
  fi
  echo "cli: $1"
  exit 0
}

if [[ "${PICODE_BUILD_CLI:-yes}" == "no" ]]; then
  give_up "skipped (PICODE_BUILD_CLI=no)"
fi

# A pack directory is where the binary is dropped so a source build ships the CLI. When the script is
# run on its own (`npm run compile-cli`), there is no pack yet: it builds and reports the binary
# instead of failing on a missing destination.
COPY_TO_PACK="yes"
if [[ "${1:-}" == "" || "${1:-}" == "--build-only" ]]; then
  COPY_TO_PACK="no"
  PACK_DIR=""
else
  PACK_DIR="${1:?usage: build/build-cli.sh [<pack dir>|--build-only]}"
fi

if ! command -v cargo > /dev/null 2>&1; then
  give_up "cargo not found; skipping (install rustup to build it)."
fi

CLI_DIR="./cli"
if [[ ! -f "${CLI_DIR}/Cargo.toml" ]]; then
  give_up "${CLI_DIR}/Cargo.toml missing; skipping."
fi

# OpenSSL's configure script is Perl. The CLI needs OpenSSL (through `russh`, which `tunnels` pulls
# in) and `cli/Cargo.toml` asks for the vendored build, so openssl-sys compiles a private copy: no
# SDK to install, no version to match, and the binary carries it. The price is Perl, which OpenSSL's
# own configure needs and which a Windows machine does not usually have in PATH even when it is
# installed.
ensure_perl() {
  if command -v perl > /dev/null 2>&1 && perl -MLocale::Maketext::Simple -e '1' 2> /dev/null; then
    return 0
  fi
  local candidate
  for candidate in \
    "${PICODE_PERL:-}" \
    "${HOME:-}/perl/bin" \
    "/c/Strawberry/perl/bin" \
    "/c/Program Files/Git/usr/bin" \
    "/c/Program Files (x86)/Git/usr/bin" \
    "/c/Perl64/bin"; do
    [[ -n "${candidate}" && -d "${candidate}" ]] || continue
    if [[ -x "${candidate}/perl.exe" || -x "${candidate}/perl" ]]; then
      # Git's Perl is a stripped build that cannot load Locale::Maketext, and OpenSSL's configure
      # dies on exactly that; a full distribution such as Strawberry's is what the vendored build
      # expects. Saying so here beats a configure dump the reader has to decode.
      if PATH="${candidate}:${PATH}" perl -MLocale::Maketext::Simple -e '1' 2> /dev/null; then
        export PATH="${candidate}:${PATH}"
        echo "cli: Perl from ${candidate} (OpenSSL's configure needs it)"
        return 0
      fi
    fi
  done
  return 1
}

if ! ensure_perl; then
  give_up "no complete Perl found, and OpenSSL's configure needs one (install Strawberry Perl, or set PICODE_PERL to its bin directory)."
fi

# What the binary knows about itself. `--version` prints the commit, and the tunnel and
# serve-web commands read the quality to pick which build they are running; both are baked in at
# compile time and, unset, the binary answers "commit unknown" and self-updates against a quality
# it guessed. The editor's build knows both (`build.sh` stamps the version hash and seals the
# channel), so they are handed over; a standalone `npm run compile-cli` does not, and then the
# previous behaviour — unknown — is the honest answer.
if [[ -n "${BUILD_SOURCEVERSION:-}" ]]; then
  export VSCODE_CLI_COMMIT="${BUILD_SOURCEVERSION}"
fi
if [[ -n "${QUALITY_VALUE:-}" ]]; then
  export VSCODE_CLI_QUALITY="${QUALITY_VALUE}"
fi

echo "cli: building the Rust CLI (release)..."
if ! ( cd "${CLI_DIR}" && cargo build --release ); then
  give_up "cargo build failed; the pack keeps the shell shim only."
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
  give_up "build finished but no binary was found; skipping."
fi

if [[ "${COPY_TO_PACK}" == "yes" ]]; then
  mkdir -p "${PACK_DIR}/bin"
  cp -f "${BINARY}" "${PACK_DIR}/bin/picode-cli"
  if [[ "${BINARY}" == *.exe ]]; then
    cp -f "${BINARY}" "${PACK_DIR}/bin/picode-cli.exe"
  fi
  echo "cli: ${BINARY} -> ${PACK_DIR}/bin/picode-cli"
else
  echo "cli: built ${BINARY}"
  echo "    run it with: ${BINARY} --version"
fi
exit 0