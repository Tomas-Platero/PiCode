#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Compiles PiCode's connector — `vscode/extensions/picode` — before the editor is packed.
#
# Why this step exists instead of leaving it to the editor's own extension build: the packing
# step COLLECTS the extensions under `vscode/extensions/` (that glob is how the connector ends
# up inside the binary at all) but it does not run `tsc` for every one of them. A connector
# packaged without its `out/` is an extension whose `main` points at a file that does not
# exist: it is inside the editor and it never activates, which is worse than not shipping it,
# because nothing says so.
#
# It compiles with **the tree's own compiler and typings** rather than installing a second
# toolchain per extension: `node_modules/@types/node` is already there for the workbench, and
# the connector's `tsconfig.json` points its `typeRoots` at it.
#
# Run from the repository root, by `dev/build.sh` (phase 6b), not by hand.

set -eo pipefail

CONNECTOR="vscode/extensions/picode"
TSC="vscode/node_modules/@typescript/native/lib/tsc.js"

if [[ ! -d "./${CONNECTOR}" ]]; then
  echo "error: ${CONNECTOR} does not exist; the connector lives inside the editor's source tree." >&2
  exit 2
fi
if [[ ! -f "./${TSC}" ]]; then
  echo "error: the editor's compiler is missing at ${TSC}; run ./dev/build.sh first." >&2
  exit 2
fi

echo "compiling ${CONNECTOR}"
node "./${TSC}" --project "${CONNECTOR}/tsconfig.json"

# The check that matters, and the reason this script exists: the editor loads
# `out/extension.js`. If it is not there, the connector shipped dead.
if [[ ! -f "./${CONNECTOR}/out/extension.js" ]]; then
  echo "error: ${CONNECTOR}/out/extension.js is missing after compiling." >&2
  echo "       The connector would be packaged without a main entry and would never activate." >&2
  exit 1
fi

echo "connector compiled: ${CONNECTOR}/out/extension.js"
