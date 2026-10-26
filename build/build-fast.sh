#!/usr/bin/env bash
#
# A build for when the point is to see a change, not to ship it.
#
# `build/build.sh` type-checks the whole source tree before it packs. That check is what the
# release relies on, and it is minutes the editor does not need in order to run: esbuild strips
# the types without checking them either way, so what a fast build leaves out is the report, not
# the compile. The optional Rust CLI is left alone for the same reason: the pack already carries
# a working shell shim, and cargo is another minute.
#
# Everything else is the ordinary build's, on purpose: the dependency check, the connector, the
# incremental compile, the profile hold, the pack, the staging and the verification. A fast build
# that skipped those would not be PiCode.
#
# Usage: build/build-fast.sh [build.sh flags...]
#
# This is not a shipping build. The release pipeline always runs `build/build.sh`.

set -eo pipefail

export PICODE_FAST=1

exec bash "$( dirname "$0" )/build-run.sh" "$@"
