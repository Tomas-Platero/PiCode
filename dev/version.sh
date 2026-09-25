#!/usr/bin/env bash
#
# Derives BUILD_SOURCEVERSION for the build.
#
# Vendored from VSCodium's `version.sh` at the revision pinned in
# `upstream/vscodium.json`. VSCodium computes it from RELEASE_VERSION with
# `sha1sum`, falling back to the npm `checksum` package. That value ends up in
# the built binary's version metadata, so the algorithm is kept as it was.
#
# PiCode addition: RELEASE_VERSION is required. VSCodium can reach here with it
# already set by get_repo.sh, and get_repo.sh is the only thing that sets it here
# too; the guard turns "ran the script out of order" into a clear error instead
# of a build stamped with an empty version.

if [[ -z "${RELEASE_VERSION}" ]]; then
  echo "error: RELEASE_VERSION is empty; run dev/get_repo.sh first (or dev/build.sh)." >&2
  exit 2
fi

if [[ -z "${BUILD_SOURCEVERSION}" ]]; then

    if type -t "sha1sum" &> /dev/null; then
      BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | sha1sum | cut -d' ' -f1 )
    else
      npm install -g checksum

      BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | checksum )
    fi

    echo "BUILD_SOURCEVERSION=\"${BUILD_SOURCEVERSION}\""

    # for GH actions
    if [[ "${GITHUB_ENV}" ]]; then
        echo "BUILD_SOURCEVERSION=${BUILD_SOURCEVERSION}" >> "${GITHUB_ENV}"
    fi
fi

export BUILD_SOURCEVERSION
