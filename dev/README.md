# The PiCode build

`dev/` builds PiCode from its own source tree.

`./picode-source` is **not a download**. It is PiCode's copy of the editor's source: it carries
the vendored VSCodium patch set, PiCode's own changes and the PiCode product identity, and it is
committed **in its own git repository inside that folder**. The PiCode repository ignores it
(and must: `CONTRIBUTING.md` forbids uploading Microsoft's source here).

That is what the build is built around. There is no fetch step and no patch step, and the
dependencies are installed once instead of on every build. Editing PiCode means editing that
tree.

```bash
./dev/build.sh          # check the source, install what is missing, compile, pack, stage
./dev/build.sh -o       # check the source and the identity, then stop: seconds, nothing
                        # installed or compiled
./dev/build.sh -i       # install the dependencies even when the recorded state still matches
```

`-f` and `-s` are gone. `-f` used to delete `./picode-source`; the tree is the source now, so
destroying it is an error and the flag says so instead of doing it. `-s` used to mean "reuse the
tree instead of fetching it", which is now the only thing that can happen; it is accepted with a
note so that old commands keep working.

## Phases

| # | Phase | What runs |
| --- | --- | --- |
| 1 | prepare | The three things that leave the tree ready to compile, in one phase because they are one job. **The source**: verifies `./picode-source` is the PiCode source — the product name matches the delta, `build/lib/electron.ts` carries the PiCode company name, the Windows icon the packer reads is there, the server manifest is PiCode's, and the connector is present. Any of these failing quietly would ship a broken or mislabelled editor. **The identity**: `node distribution/apply-product-delta.mjs … --write` (idempotent, says "already current" when nothing moved) and the release version written into `picode-source/package.json`. **The dependencies**: `npm ci`, **only** when `dev/deps-current.mjs` says the state VS Code recorded does not match the tree; anything else — no record, a different node, an unreadable state — is a no, and the install runs. Only the install can be long, and only the first time. |
| 2 | connector | `dev/build-connector.sh`: `tsc` over `picode-source/extensions/picode`. The packer collects extensions but does not compile them, so this has to happen first. |
| 3 | compile | `gulp vscode-min-prepack`, then the group-policy DTO copy and the policy generator for the platform being packed. |
| 4 | pack | `gulp vscode-<platform>-<arch>-min-packing`. |
| 5 | stage | `dev/pi-runtime.sh` (installs the pinned pi into the pack) and `dev/stage-distribution.sh` (portable profile, settings, panel, icons, names). |

`-o` stops inside phase 1 with exit code 0: after the source and the identity are checked, before
anything is installed. It exists so the source can be checked in seconds rather than discovered to
be wrong after an hour of compiling.

## Requirements

- `git`, `node` (`.nvmrc`: 24.18.0 — `npm ci` and the gulp tasks need the repository's Node
  version), `npm`.
- Windows: **Git Bash**. `OS_NAME` comes from `OSTYPE`; an `OSTYPE` that yields neither
  `windows`, `osx` nor `linux` is a hard error.
- `python3`, `rustup` and Visual Studio 2022 with the Spectre libraries are needed for the
  **first** `npm ci` only (they build the native modules). Missing Spectre stops the install
  with `error MSB8040` in `@picode-source/deviceid` and `@picode-source/windows-registry`.
- **`jq` is no longer needed.** The build reads and writes the JSON it touches with node, and
  since 2026-09-27 `dev/pi-runtime.sh` does too — it was the last place that asked for it.
  `dev/utils.sh` still uses `jq` in the removal actions, but those belong to the retired patch
  path and the build never calls them.
- `shellcheck` is not installed here, so the scripts are validated with `bash -n`.

## The retired path, kept on purpose

`dev/get_repo.sh`, `dev/prepare_vscode.sh`, `dev/patch.sh`, `dev/update_patches.sh`,
`dev/version.sh`, `dev/utils.sh`, `patches/**` and `upstream/*.json` are **not called by the
build any more**. They are kept because they are:

1. the record of how the current source was made — which patch did what, and why;
2. the provenance of the tree (`upstream/stable.json` is the VS Code commit it descends from,
   `upstream/vscodium.json` the VSCodium revision the inherited patch set was vendored from);
3. the recovery path, if a PiCode tree ever has to be rebuilt from a fresh VS Code by replaying
   the patch series instead of merging.

**They are not usable as they were.** `dev/patch.sh` and `dev/update_patches.sh` treat the git
index as the reference state and reset to `HEAD`; with the prepared tree committed, `HEAD` *is*
the prepared state, so a reset lands on the patched tree rather than on pristine VS Code. Anyone
who needs them starts from the recorded pristine commit (`08d4889f` for VS Code 1.135.0) and
works from there.

A patch is only applied if its name ends in `.patch`. Files ending in `.patch.no` or `.patch.yet`
are inactive **by name** and the glob skips them: renaming is how one is enabled or disabled.
(One exception, inherited from VSCodium: `patches/vscodium/00-update-disable.patch.yet` is
applied explicitly only when `DISABLE_UPDATE=yes`, which the build does not set.)

## Where PiCode's identity lives

- `distribution/product-delta.json` owns the PiCode **product** (`nameShort`, `nameLong`,
  `applicationName`, `urlProtocol`, the gallery, the URLs, the removals). Phase 1 applies it to
  `picode-source/product.json` *before* packing, which is why the built-in product is PiCode's
  and why nothing has to be rewritten inside `resources/app` afterwards. It is the **only** home
  of the version, too.
- Everything the old `metadata` stage applied once — the PiCode company name in
  `build/lib/electron.ts`, the Windows icon the packer reads, the server manifest name, npm 11's
  script approvals — is **in the tree**, committed. Phase 1 verifies it rather than re-applying
  it, because a silent re-application is what let the first full build ship VS Code's icon.
- The `!!APP_NAME!!`-style placeholders belong to the retired patch path: `dev/utils.sh` expanded
  them into a temporary copy of a patch before applying it. Nothing expands them now.

## Known gaps

- **The Windows icon has to be right before phase 4.** `rcedit` stamps the executable during the
  pack, so replacing `code.ico` afterwards changes nothing. Phase 1 fails if the file is missing,
  but re-branding it from `distribution/picode.ico` is still `dev/prepare_vscode.sh metadata`,
  and that is not wired into the build.
- **`dev/build-requirements.mjs`** (the list the collaborator window reads) still names `jq`.
- **`undo_telemetry.sh` is not wired.** `patches/vscodium/00-telemetry-disable.patch` and the
  product delta already disable telemetry reporting; the URL rewrite itself is not done.
- **`build_cli.sh` is not wired, so a source build ships no TUNNEL binary.** `bin/picode` and
  `bin/picode.cmd` do exist (the pack produces the CLI shim with the renamed binary), but
  `picode-tunnel.exe` does not.
- **The announcement injection is not wired.** PiCode ships no announcements, so there is nothing
  to splice.
- **The staging step duplicates logic from `distribution/apply-picode.ps1`.** The PowerShell
  script derives its root from its own location, so it can only run against the tree at the
  repository root; the bash version mirrors its steps 1-6 and both must be kept in sync. It also
  adds two steps the PowerShell one does not have: `dev/brand-copy.mjs`, and deleting the
  `*.map` files and every `locales/*.pak` except `en-US` and `es`.
- **A version bump costs one dependency install.** `dev/deps-current.mjs` compares VS Code's
  recorded state by content hash over `package.json`, so writing a new version into it makes the
  install look stale. Installing once too often is preferred to trusting a tree that has not been
  checked.
- **The compile and the pack always run in full.** Neither reuses anything from the previous
  build: `compile-build-without-mangling` starts with `util.rimraf('out-build')`, and
  `bundle-vscode` and `minify-vscode` wipe `out-vscode` and `out-vscode-min`. This is the next
  thing to fix, and it is what makes a build cost hours.
- **No CI.** Declared out of scope.

## What the build never writes

`patches/**`, `distribution/**` (the delta is read, never rewritten), `extensions/**` and
`.git/**`. `picode-source` is written, and it is versioned — in its own repository, not this one.
`PiCode-*` is a build output and is ignored.

## Building without a terminal

`dev/build-window.cmd` opens a small window (`dev/build-window.ps1`, PowerShell and WPF, nothing to
install) that a collaborator can use without knowing any of the above:

- **what the build needs**, one row each — node at the pinned version, git (its Bash is what runs
  the build), python, the source tree, the dependencies, the editor — with a button that installs
  the missing one with `winget` (in its own terminal, so its own questions are seen) or a link to
  its download page when there is no package manager;
- **the build in three steps** — *source tree*, *dependencies*, *build* — so a failure in the
  middle does not force the whole thing again;
- **a bar with the stage and the percentage** while it runs, the tail of its own output, and a
  *Stop* for when it hangs (which has happened: one sat silent for seven hours);
- and whether a build **is already running** (the window's lock), because two at once in one tree
  fight over `node_modules` and over the directory they pack into.

The same progress is on the command line, for a terminal:

```bash
./dev/build-live.sh          # the build, with the bar and the percentage
node dev/build-progress.mjs  # the bar alone, watching a build already in flight
```

Both are the same machinery: `dev/build-run.sh` runs the build and leaves a lock, a log and an exit
code behind, `dev/build-progress.mjs` reads them (in text, or `--json` for the window), and
`dev/restore-profile.mjs` puts the owner's profile back afterwards, because the pack deletes the
directory it lives in.

None of them needs flags. With none, the build checks the source, installs what is missing,
compiles, packs and stages — and it is safe to repeat, because the source is never fetched and the
dependencies are installed once.

The editor's own task list carries the same entry points (`.vscode/tasks.json`, which VS Code
reads with comments allowed — this explanation lives here so the file stays readable by every JSON
tool). The default task is the live build, the one with the bar. Two builds in one tree fight over
`node_modules` and over the directory they pack into — one of those left a half-installed tree
behind — so the lock is checked before starting, never after.

## The window is also an application now

`dev/build-window.cmd` is the PowerShell window, and it works. There is also a C# application in
[`builder/`](../builder/README.md) with the same job - `cd builder && dotnet run` - which builds for
Windows natively and for Linux through WSL. It reads the same scripts this folder holds and the same
`dev/build-requirements.mjs` and `dev/build-progress.mjs`, so nothing about the pipeline lives in it.
