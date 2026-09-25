#!/usr/bin/env bash
#
# Runs phases 1-5 of `dev/build.sh` (fetch + patch, no compile) and, when a
# patch stops applying, names it.
#
# Invoked by `.github/workflows/pin-check.yml`, which is the quick check that
# runs on every push. It is also invoked by `pin-watch.yml` through a
# `workflow_dispatch` on the branch of the pin-update pull request; in that case
# `REPORT_SHA` carries the commit to attach a pass/fail commit status to, so the
# pull request is red or green and its description says which patch broke.
#
# Local use: `bash dev/ci/pin-check.sh` from the repository root. It expects
# `./picode-source` to already hold the pinned source; `dev/get_repo.sh --fetch`
# creates it (and the CI workflows do that before calling this script).

set -uo pipefail

cd "$( dirname "${BASH_SOURCE[0]}" )/../.." || exit 2

log="$( mktemp "${TMPDIR:-/tmp}/picode-pin-check.XXXXXX" )" || exit 2
trap 'rm -f "${log}"' EXIT

# Deliberately not `set -e`: the failure is the thing being reported, and the
# script still has to name the patch and write the commit status afterwards.
./dev/build.sh -o 2>&1 | tee "${log}"
status="${PIPESTATUS[0]}"

# `dev/utils.sh` prints `failed to apply patch <path>` right before exiting.
failing_patch="$( grep -o 'failed to apply patch [^ ]*' "${log}" 2>/dev/null | tail -1 | awk '{ print $5 }' )"

if [[ "${status}" -eq 0 ]]; then
  echo "::notice title=Phases 1-5::every patch applies to the pinned VS Code commit"
elif [[ -n "${failing_patch}" ]]; then
  echo "::error title=Broken patch::${failing_patch} no longer applies to the pinned VS Code commit"
else
  echo "::error title=Phases 1-5 failed::the preparation stopped before compiling; see the log above"
fi

if [[ -n "${REPORT_SHA:-}" ]]; then
  if [[ "${status}" -eq 0 ]]; then
    state="success"
    description="phases 1-5 passed"
  else
    state="failure"
    description="${failing_patch:-phases 1-5 failed}"
  fi

  # A commit-status description is capped at 140 characters by the API.
  description="${description:0:140}"

  gh api \
    --method POST \
    "repos/${GITHUB_REPOSITORY}/statuses/${REPORT_SHA}" \
    -f state="${state}" \
    -f context="pin-check (phases 1-5)" \
    -f description="${description}" \
    -f target_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
fi

exit "${status}"
