#!/usr/bin/env bash
#
# The Windows installer, built from the tree dev/build.sh has just packed.
#
# The Inno Setup task is VS Code's own (build/gulpfile.vscode.win32.ts). It takes the packed
# `PiCode-Win32-<arch>` directory and writes `PiCodeSetup.exe` under
# `picode-source/.build/win32-<arch>/user-setup`. `user` is the per-user flavour
# (PrivilegesRequired=lowest in build/win32/code.iss): installing needs no administrator and
# nothing is written outside the user's own profile.
#
# Two things have to be true before ISCC is asked to run, and both are checked here so a missing
# one fails with a sentence instead of a path buried in the compiler output:
#
#   * the pack directory exists - this runs after the pack
#   * build/win32/inno_updater.exe is in its tools/ directory - build/win32/code.iss excludes
#     `tools` from the main copy and installs it on its own line, and the
#     `vscode-win32-<arch>-inno-updater` task is what puts it there. Compiling without it produces
#     an installer that looks complete and then fails the first time it tries to update.
#
# Only Windows has an installer. Anywhere else this says so and exits 0, so dev/build.sh keeps one
# entry point on every platform.
#
# A side-by-side install is `PICODE_INSTALLER_SUFFIX` (set by dev/build.sh from the pack's own
# suffix): the installer then lands in its own folder, shows its own name and carries its own AppId,
# so it sits beside the editor already on the machine instead of replacing it. See
# build/gulpfile.vscode.win32.ts for the three things it moves.
#
# Do NOT check which folder it installs into by installing it. Inno Setup compresses its own script
# data, so the value cannot be read out of the .exe -- but a silent install and its uninstaller are
# a real install and a real uninstall: they write the machine's registry, associations and PATH, and
# the uninstaller removes whatever is in that folder, *including an installation the owner just made
# from this same artifact* (measured on 2026-10-07, with the editor open from it: the running app
# lost its files mid-flight). Install it as a person would, or read the defines the task passes.
#
# Usage: dev/build-installer.sh [pack-dir]      (default: ./PiCode-Win32-x64)

set -eo pipefail

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
PACK_DIR="${1:-./PiCode-Win32-x64}"

case "${OSTYPE}" in
  msys* | cygwin*) ;;
  *)
    echo "installer: not built (Windows only; OSTYPE is '${OSTYPE}')."
    exit 0
    ;;
esac

case "$( uname -m )" in
  aarch64 | arm64) ARCH="arm64" ;;
  *)               ARCH="x64" ;;
esac

# The gulp task names the pack path itself (`path.dirname(repoPath)/PiCode-Win32-<arch>`), so the
# argument is what the check below reads, not something the installer is told.
if [[ ! -d "${ROOT_DIR}/${PACK_DIR}" ]]; then
  echo "error: the pack directory '${PACK_DIR}' was not found under the repository root." >&2
  echo "       The installer is built from the packed tree; run the pack first." >&2
  exit 2
fi

cd "${ROOT_DIR}" || exit 2

# PiCode's own version, not set.version: the editor's number tracks VS Code, and a release is
# named after this one. Both live in the same file, so it is read here rather than passed in.
PICODE_VERSION=$( node -p \
  "require('./distribution/product-delta.json').set.picodeVersion" 2> /dev/null ) || {
  echo "error: distribution/product-delta.json could not be read." >&2
  exit 1
}
if [[ -z "${PICODE_VERSION}" || "${PICODE_VERSION}" == "undefined" ]]; then
  echo "error: distribution/product-delta.json does not set a 'picodeVersion'." >&2
  exit 1
fi

EDITOR_VERSION=$( node -p \
  "require('./distribution/product-delta.json').set.version" 2> /dev/null ) || {
  echo "error: distribution/product-delta.json could not be read." >&2
  exit 1
}

# build/gulpfile.vscode.win32.ts asserts that every Inno define is a string, and its Commit comes
# from getVersion(): the environment, or the tree's own .git/HEAD - which picode-source does not
# have, because it is not a repository of its own. dev/build.sh exports the value, but a direct run
# of this script has neither, so it is derived here exactly the way dev/build.sh derives it: the
# sha1 of the version without its pre-release suffix, newline included. That is also the stamp the
# packer writes into product.json's `commit`, and the .iss records it in updating_version.
if [[ ! "${BUILD_SOURCEVERSION:-}" =~ ^[0-9a-f]{40}$ ]]; then
  if command -v sha1sum > /dev/null 2>&1; then
    BUILD_SOURCEVERSION=$( echo "${EDITOR_VERSION%%-*}" | sha1sum | cut -d' ' -f1 )
  elif command -v shasum > /dev/null 2>&1; then
    BUILD_SOURCEVERSION=$( echo "${EDITOR_VERSION%%-*}" | shasum -a 1 | cut -d' ' -f1 )
  else
    echo "error: neither sha1sum nor shasum was found, and the install stamp needs one." >&2
    exit 2
  fi
fi
export BUILD_SOURCEVERSION

# dev/build.sh exports NODE_OPTIONS but not the number; a direct run of this script has neither.
NODE_HEAP_MB="${NODE_HEAP_MB:-12288}"

echo "installer: Inno Setup, win32-${ARCH}, user install (no administrator needed)"

cd "${ROOT_DIR}/picode-source" || {
  echo "error: ./picode-source is missing." >&2
  exit 2
}

node --experimental-strip-types --max-old-space-size="${NODE_HEAP_MB}" \
  ./node_modules/gulp/bin/gulp.js \
  "vscode-win32-${ARCH}-inno-updater" \
  "vscode-win32-${ARCH}-user-setup"

SETUP=".build/win32-${ARCH}/user-setup/PiCodeSetup.exe"

if [[ ! -f "${SETUP}" ]]; then
  echo "error: Inno Setup finished but ${SETUP} is not there." >&2
  echo "       The name comes from OutputBaseFilename in build/win32/code.iss." >&2
  exit 1
fi

# The name of the artifact. A release says its version, marker and all (`-0.1.3-beta-setup.exe`),
# unchanged since the updater's own URLs are built from that. A side-by-side installer says which
# build it is *in the version's own place*: the pre-release marker gives way to the suffix, so the
# two installers sort together and neither is mistaken for the other
# (`-0.1.3-beta-setup.exe` for the release, `-0.1.3-experimental-setup.exe` for this one).
if [[ -n "${PICODE_INSTALLER_SUFFIX:-}" ]]; then
  OUT="${ROOT_DIR}/PiCode-win32-${ARCH}-${PICODE_VERSION%%-*}${PICODE_INSTALLER_SUFFIX}-setup.exe"
else
  OUT="${ROOT_DIR}/PiCode-win32-${ARCH}-${PICODE_VERSION}-setup.exe"
fi
cp -f "${SETUP}" "${OUT}"

echo "installer: ${OUT}"
if [[ -n "${PICODE_INSTALLER_SUFFIX:-}" ]]; then
  echo "           installs beside the editor already on the machine: a separate application to"
  echo "           Windows, in its own folder, sharing one profile and one mutex with it."
fi
