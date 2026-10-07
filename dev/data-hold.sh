#!/usr/bin/env bash
# shellcheck shell=bash
#
# The portable profile (data/) and the pack's wholesale delete.
#
# `data/` inside the pack folder (PiCode-win32-x64*/data) is the app's portable profile: user
# data, providers, skills, sessions, logs. The pack task that produces the folder deletes it
# wholesale before writing (util.rimraf(path.join(buildRoot, destinationFolderName)) in
# picode-source/build/gulpfile.vscode.ts), so every build used to wipe the owner's profile, and
# a file locked inside data/ (a log held open by the running editor) used to fail that delete
# halfway through, leaving the folder with no PiCode.exe and no resources/app.
#
# The fix lives in dev/build.sh, which sources this file and calls these functions in order:
#
#   1. picode_data_hold_recover   - an earlier run may have died with the profile in the hold;
#                                   restore it before anything else runs.
#   2. picode_data_hold_move_aside - rename data/ out of the pack folder, to
#                                   <PACK_DIR>-data-hold, beside the folder rather than inside
#                                   it, so the pack's own delete can never reach it.
#   3. ... the pack and the staging steps run (they delete the folder and seed a fresh data/) ...
#   4. picode_data_hold_put_back  - drop the seeded data/ and rename the held profile back.
#
# A rename, not a copy: it is atomic on the volume and it does not duplicate 1+ GB.
#
# A Windows fact this rests on (measured, not assumed): renaming a directory while any file
# inside it is open fails -- mv says "Permission denied", node's renameSync says EPERM, and it
# fails even when the holder opened the file with FILE_SHARE_DELETE. That is why the move-aside
# REFUSES instead of improvising: if data/ cannot be moved, the pack has not started, nothing
# has been deleted, and the error names the folder that refused. A locked file can no longer
# half-delete the app folder; it can only stop the build cleanly, before any damage.

# The hold directory for a pack directory: beside it, named so a human recognises it.
picode_data_hold_dir() {
  printf '%s\n' "${1}-data-hold"
}

# picode_data_locked_files <dir>
#
# The files under a directory that **refuse to be opened right now**, up to a few, one per line.
#
# This is the answer to "who is holding it" when the profile's rename is refused. The message that
# says "close the PiCode running from this folder" is no help when none is running — measured twice
# on 2026-10-07, where the handles outlived the editor (a utility process that crashed on the way
# out, and children that inherited its log descriptors) for longer than the wait above, so the build
# refused with the reason still unknown. Naming the files turns that into something to act on.
#
# Windows only, and silent when it cannot answer: a guess here is worse than nothing.
picode_data_locked_files() {
  local dir="$1"
  command -v powershell.exe >/dev/null 2>&1 || return 0
  command -v cygpath >/dev/null 2>&1 || return 0
  powershell.exe -NoProfile -Command "
    \$n = 0
    Get-ChildItem '$( cygpath -w "${dir}" )' -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { \$_.FullName -notmatch 'node_modules' } |
      ForEach-Object {
        if (\$n -lt 5) {
          \$f = \$_.FullName
          try { \$s = [System.IO.File]::Open(\$f, 'Open', 'ReadWrite', 'None'); \$s.Close() }
          catch { Write-Output \$f; \$n++ }
        }
      }" 2>/dev/null | tr -d '\r'
}

# picode_editor_running
#
# Whether a PiCode is running right now.
#
# This is asked twice, because the answer can change while a build runs. The pack deletes the
# platform directory before writing it, and Windows refuses to delete the files of a program that
# is running: an editor opened **while the compile phases run** turns the pack into an EBUSY
# minutes later, after the profile has already been renamed aside. That is not hypothetical -- it
# happened on 2026-10-06, at 00:19, and it cost the build and the run. One question, one answer,
# asked where the answer still helps: at the start (nothing to lose) and again at the pack
# (nothing lost yet).
picode_editor_running() {
  local count
  count=$( tasklist //FI "IMAGENAME eq PiCode.exe" 2>/dev/null | grep -c "PiCode.exe" || true )
  [[ "${count}" -gt 0 ]]
}

# The profile inside a pack directory.
picode_data_dir() {
  printf '%s\n' "${1}/data"
}

# picode_data_hold_recover <pack_dir>
#
# Restore a hold left behind by an interrupted run. This runs before anything else, so a build
# never packs on top of a profile that is sitting beside the folder. Absent hold is the normal
# case (first build, or the last run finished cleanly): silent, exit 0.
picode_data_hold_recover() {
  local pack_dir="$1"
  local data_dir hold_dir
  data_dir="$(picode_data_dir "${pack_dir}")"
  hold_dir="$(picode_data_hold_dir "${pack_dir}")"

  [[ -d "${hold_dir}" ]] || return 0

  echo "  -- a previous build stopped with the portable profile in ${hold_dir}: restoring it before anything else"
  if [[ -e "${data_dir}" ]]; then
    # Both present: the interrupted run had already re-packed (or re-staged) before dying, so
    # what sits in the pack folder is the seeded data/ from that run. It is build output, not
    # the profile -- the profile is the hold, which only exists because build.sh moved it aside.
    if ! rm -rf "${data_dir}"; then
      echo "error: the leftover data/ in '${data_dir}' could not be removed, so the held profile cannot go back. Close whatever holds it and build again." >&2
      return 1
    fi
  fi
  # The pack folder may not exist at all: a build into a name nothing has used yet (a different
  # suffix, or the first build on this machine). The rename below needs its parent, so it is made
  # here -- measured on 2026-10-07, where a new suffix failed with "No such file or directory" and
  # the profile stayed in the hold until this line existed.
  mkdir -p "${pack_dir}" || return 1
  if ! mv "${hold_dir}" "${data_dir}"; then
    echo "error: the held profile could not be moved from '${hold_dir}' back to '${data_dir}'. It is still safe in the hold." >&2
    return 1
  fi
  echo "  -- the portable profile is back in ${data_dir}"
  return 0
}

# picode_data_hold_move_aside <pack_dir>
#
# Rename data/ out of the pack folder before the pack deletes it. Absent data/ is normal (a
# first build): nothing to move, no noise. If the rename is refused, stop the build with a
# message naming the folder that refused; nothing has been deleted at this point.
picode_data_hold_move_aside() {
  local pack_dir="$1"
  local data_dir hold_dir mv_error
  data_dir="$(picode_data_dir "${pack_dir}")"
  hold_dir="$(picode_data_hold_dir "${pack_dir}")"

  [[ -d "${data_dir}" ]] || return 0

  echo "  -- moving the portable profile aside for the pack: ${data_dir} -> ${hold_dir}"
  # Tried more than once, and the reason is measured rather than imagined: an editor that was
  # **just closed** keeps its extension-host logs open while it tears down, and on 2026-10-07 it kept
  # them for **minutes** — its utility process crashed on the way out (`terminated unexpectedly with
  # code 3221225477` at 12:01:53, right after the extension host exited cleanly), and the handles were
  # still there when the build asked at 12:03 and at 12:07. Two builds were lost to a process that had
  # already exited; the wait is cheap and the refusal it replaces is not. A window that is **still
  # open** keeps refusing and gets the message below, which is the case this refusal exists for.
  for _ in $(seq 1 40); do
    mv_error="$(mv "${data_dir}" "${hold_dir}" 2>&1)" && return 0
    sleep 2
  done
  {
    echo "error: the pack did NOT run and NOTHING was deleted, but the portable profile could not be moved out of the way first." >&2
    echo "       The rename of '${data_dir}' to '${hold_dir}' was refused for 80 s -- a file inside it is held open." >&2
    echo "       mv said: ${mv_error}" >&2
    locked="$( picode_data_locked_files "${data_dir}" )"
    if [[ -n "${locked}" ]]; then
      echo "       These files are held open right now:" >&2
      while IFS= read -r file; do
        echo "         ${file}" >&2
      done <<< "${locked}"
    fi
    echo "       Close the PiCode running from this folder (its logs under data/user-data/logs are the usual holders) and build again." >&2
    return 1
  }
}

# picode_data_hold_put_back <pack_dir>
#
# After the pack and the staging steps: remove the seeded data/ the build created, then move
# the held profile into place. Absent hold (nothing was ever moved, or it is already back) is
# silent, exit 0.
picode_data_hold_put_back() {
  local pack_dir="$1"
  local data_dir hold_dir
  data_dir="$(picode_data_dir "${pack_dir}")"
  hold_dir="$(picode_data_hold_dir "${pack_dir}")"

  [[ -d "${hold_dir}" ]] || return 0

  if [[ -e "${data_dir}" ]]; then
    if ! rm -rf "${data_dir}"; then
      echo "error: the seeded data/ in '${data_dir}' could not be removed, so the held profile cannot be put back. It is safe in ${hold_dir}." >&2
      return 1
    fi
  fi
  mkdir -p "${pack_dir}" || return 1
  if ! mv "${hold_dir}" "${data_dir}"; then
    echo "error: the profile could not be moved from '${hold_dir}' back to '${data_dir}'. It is safe in the hold." >&2
    return 1
  fi
  echo "  -- the portable profile is back in ${data_dir}"
  return 0
}
