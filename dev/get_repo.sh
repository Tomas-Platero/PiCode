#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2129
#
# Fetches the VS Code source the build is pinned to.
#
# Adapted from VSCodium's `get_repo.sh` at the revision pinned in
# `upstream/vscodium.json`. The differences are deliberate:
#
#   * The pin is PiCode's `upstream/stable.json` (`tag`, `commit`,
#     `repository`) instead of VSCodium's `upstream/${VSCODE_QUALITY}.json`,
#     and the commit is always pinned. VSCodium can resolve a version from the
#     live update API because it tracks Microsoft's releases; a PiCode build
#     must be reproducible from the repository alone, so the API path is only
#     reachable through VSCODE_LATEST=yes, which is off by default.
#   * The clone lands in `./picode-source` (the directory VSCodium also uses).
#   * `--reuse` derives the same variables from the pin without touching the
#     network, for `dev/build.sh -s`.
#
# It prints MS_TAG, MS_COMMIT and RELEASE_VERSION and exports them, exactly as
# the vendored script does, so the patch templates see the same names.

set -e

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fetch)
      REUSE_TREE="no"
      ;;
    --reuse)
      REUSE_TREE="yes"
      ;;
    *)
      echo "usage: dev/get_repo.sh [--fetch|--reuse]" >&2
      exit 2
      ;;
  esac
  shift
done

REUSE_TREE="${REUSE_TREE:-no}"
VSCODE_QUALITY="${VSCODE_QUALITY:-stable}"
VSCODE_LATEST="${VSCODE_LATEST:-no}"

# git workaround (kept from VSCodium)
if [[ "${CI_BUILD}" != "no" ]]; then
  git config --global --add safe.directory "/__w/$( echo "${GITHUB_REPOSITORY}" | awk '{print tolower($0)}' )"
fi

# include common functions
. ./dev/utils.sh

require_jq

PIN="./upstream/${VSCODE_QUALITY}.json"

if [[ ! -f "${PIN}" ]]; then
  echo "error: the source pin ${PIN} is missing." >&2
  exit 2
fi

MS_TAG=$( jq -r '.tag' "${PIN}" )
MS_COMMIT=$( jq -r '.commit' "${PIN}" )
SOURCE_REPOSITORY=$( jq -r '.repository' "${PIN}" )

if [[ -z "${MS_TAG}" || "${MS_TAG}" == "null" ]]; then
  echo "error: ${PIN} has no tag." >&2
  exit 2
fi

if [[ -z "${SOURCE_REPOSITORY}" || "${SOURCE_REPOSITORY}" == "null" ]]; then
  echo "error: ${PIN} has no repository." >&2
  exit 2
fi

if [[ "${VSCODE_LATEST}" == "yes" ]]; then
  echo "Retrieving the latest ${VSCODE_QUALITY} version from the update API"
  UPDATE_INFO=$( curl --silent --fail "https://update.code.visualstudio.com/api/update/darwin/${VSCODE_QUALITY}/0000000000000000000000000000000000000000" ) || {
    echo "error: the update API could not be reached; the pin in ${PIN} stays authoritative." >&2
    exit 2
  }

  MS_COMMIT=$( echo "${UPDATE_INFO}" | jq -r '.version' )
  MS_TAG=$( echo "${UPDATE_INFO}" | jq -r '.name' )

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    MS_TAG="${MS_TAG/\-insider/}"
  fi
fi

if [[ "${RELEASE_VERSION}" == "" ]]; then
  RELEASE_VERSION="${MS_TAG}"
fi

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  if [[ "${RELEASE_VERSION}" =~ ^([0-9]+\.[0-9]+\.[0-5])[0-9]+-insider$ ]]; then
    MS_TAG="${BASH_REMATCH[1]}"
  else
    echo "Error: Bad RELEASE_VERSION: ${RELEASE_VERSION}" >&2
    exit 1
  fi
else
  if [[ "${RELEASE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    MS_TAG="${RELEASE_VERSION}"
  else
    echo "Error: Bad RELEASE_VERSION: ${RELEASE_VERSION}" >&2
    exit 1
  fi
fi

echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""
echo "MS_TAG=\"${MS_TAG}\""
echo "MS_COMMIT=\"${MS_COMMIT}\""

if [[ "${REUSE_TREE}" == "yes" ]]; then
  if [[ ! -d "./picode-source" ]]; then
    echo "error: ./picode-source does not exist, so it cannot be reused." >&2
    echo "       Run dev/build.sh without -s to fetch the source." >&2
    exit 2
  fi

  if [[ -d "./picode-source/.git" ]]; then
    HEAD_COMMIT=$( git -C ./picode-source rev-parse HEAD )
    if [[ "${HEAD_COMMIT}" != "${MS_COMMIT}" ]]; then
      echo "error: ./picode-source is at ${HEAD_COMMIT}, but the pin is ${MS_COMMIT}." >&2
      echo "       Run dev/build.sh without -s to fetch the pinned commit." >&2
      exit 2
    fi
    echo "./picode-source is at the pinned commit ${MS_COMMIT}"
  else
    echo "warning: ./picode-source is not a git repository; reusing it as it is." >&2
  fi
else
  mkdir -p picode-source
  cd picode-source || { echo "'picode-source' dir not found"; exit 1; }

  git init -q

  if git remote get-url origin > /dev/null 2>&1; then
    git remote set-url origin "${SOURCE_REPOSITORY}"
  else
    git remote add origin "${SOURCE_REPOSITORY}"
  fi

  # VSCodium resolves MS_COMMIT from the tag when the pin only carries a tag.
  if [[ -z "${MS_COMMIT}" || "${MS_COMMIT}" == "null" ]]; then
    REFERENCE=$( git ls-remote --tags origin | grep -x ".*refs\/tags\/${MS_TAG}" | head -1 )

    if [[ -z "${REFERENCE}" ]]; then
      echo "Error: The following tag can't be found: ${MS_TAG}" >&2
      exit 1
    elif [[ "${REFERENCE}" =~ ^([[:alnum:]]+)[[:space:]]+refs\/tags\/([0-9]+\.[0-9]+\.[0-5])$ ]]; then
      MS_COMMIT="${BASH_REMATCH[1]}"
      MS_TAG="${BASH_REMATCH[2]}"
    else
      echo "Error: The following reference can't be parsed: ${REFERENCE}" >&2
      exit 1
    fi
  fi

  echo "Fetching ${MS_COMMIT} from ${SOURCE_REPOSITORY}"
  git fetch --depth 1 origin "${MS_COMMIT}"
  git checkout -q --force FETCH_HEAD

  HEAD_COMMIT=$( git rev-parse HEAD )
  if [[ "${HEAD_COMMIT}" != "${MS_COMMIT}" ]]; then
    echo "error: ./picode-source ended up at ${HEAD_COMMIT}, not at the pinned ${MS_COMMIT}." >&2
    exit 2
  fi

  cd ..
fi

# for GH actions
if [[ "${GITHUB_ENV}" ]]; then
  echo "MS_TAG=${MS_TAG}" >> "${GITHUB_ENV}"
  echo "MS_COMMIT=${MS_COMMIT}" >> "${GITHUB_ENV}"
  echo "RELEASE_VERSION=${RELEASE_VERSION}" >> "${GITHUB_ENV}"
fi

export MS_TAG
export MS_COMMIT
export RELEASE_VERSION
