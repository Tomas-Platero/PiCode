# 🛠️ The PiCode build

`build/` builds PiCode from its own source tree, and **the source tree is this
repository**. There is no `picode-source/` folder and no download: the editor's
source — VS Code with the VSCodium changes and PiCode's own already inside — is
versioned here, at the root, and the product identity is committed with it
(decided by the owner on 2026-09-27; one clone now has everything — see
`CONTRIBUTING.md` for the publishing rule this brought with it).

That is what the build is built around. There is no fetch step and no patch
step, and the dependencies are installed once instead of on every build. Editing
PiCode means editing the tree.

```bash
./build/build.sh          # check the source, install what is missing, compile, pack, stage
./build/build.sh -o       # check the source and the identity, then stop: seconds, nothing
                          # installed or compiled
./build/build.sh -i       # install the dependencies even when the recorded state still matches
```

`-f` and `-s` are gone. `-f` used to delete the source tree; the tree is the
source now, so destroying it is an error and the flag says so instead of doing
it. `-s` used to mean "reuse the tree instead of fetching it", which is now the
only thing that can happen; it is accepted with a note so that old commands keep
working.

## ⚡ A fast build

```bash
./build/build-fast.sh      # the whole build, without the whole-tree type check
```

The type check is what the release relies on, and it is the one step a change
under the cursor is least likely to break: esbuild never consumed its output, so
a fast build leaves out the report, not the compile. It also leaves the optional
Rust CLI alone (the pack already carries a working shell shim). Everything else
is the ordinary build's — dependency check, connector, compile, profile hold,
pack, staging, verification — because a fast build that skipped those would not
be PiCode.

It is not a shipping build: the release pipeline always runs `./build/build.sh`.
Both are also reachable as `npm run build:pack` and `npm run build:fast`.

## 🧱 Phases

| # | Phase | What runs |
| --- | --- | --- |
| 1 | prepare | The three things that leave the tree ready to compile, in one phase because they are one job. **The source**: verifies the tree is the PiCode source — `product.json`'s name is a PiCode name, `build/lib/electron.ts` carries the PiCode company name, the Windows icon the packer reads is there, the server manifest is PiCode's, and the connector is present. Any of these failing quietly would ship a broken or mislabelled editor. **The identity**: `product.json` is its single home; the build seals the channel into it for the pack (and puts it back afterwards) and writes `product.json`'s version into `package.json`, so the packer's two sources agree. **The dependencies**: `npm ci`, **only** when `build/build-helpers.mjs deps-current` says the state VS Code recorded does not match the tree; anything else — no record, a different node, an unreadable state — is a no, and the install runs. Only the install can be long, and only the first time. |
| 2 | connector | `build/build-connector.sh`: `tsc` over `extensions/picode`. The packer collects extensions but does not compile them, so this has to happen first. |
| 3 | compile | `gulp vscode-min-prepack`: the headless type check (`tsgo --noEmit`, ~14 s; skipped by `build-fast.sh`), codicons, and the built-in extensions. With esbuild restored to upstream's default this phase no longer transpiles — the bundler does that from source in phase 4, in one pass. Then the group-policy DTO copy and the policy generator for the platform being packed. |
| 4 | pack | `gulp vscode-<platform>-<arch>-min-packing`: esbuild bundles `src/` straight to `out-vscode-min` with NLS and minification (~100 s), builds the native extensions, and assembles the archive. |
| 5 | stage | `build/pi-runtime.sh` (installs the pinned pi into the pack), `build/durable-runtime.sh` (the durable agent, `durable/`, and the chat's bridge into `resources/durable` — its own dependencies travel with it, ~116 MB, and nothing else does: no proofs, no `.data/`, no credentials) and `build/stage-distribution.sh` (portable profile, settings, icons, names). |

`-o` stops inside phase 1 with exit code 0: after the source and the identity are
checked, before anything is installed. It exists so the source can be checked in
seconds rather than discovered to be wrong after an hour of compiling.

## 🧰 The five scripts

Everything that used to be a small `build/*.mjs` one-shot is now one of five
files, grouped by what it is for, each command keeping the name it always had:

| File | Commands |
| --- | --- |
| `build-helpers.mjs` | `deps-current`, `requirements`, `pack-dir`, `progress`, `restore-profile` |
| `docs.mjs` | `check`, `map` |
| `release.mjs` | `release-notes`, `update-feed` |
| `branding.mjs` | `brand-copy`, `ico-to-png`, `make-inno-images`, `patch-inno-updater` |
| `checks.mjs` | `check-mcp`, `patch-languageserver`, `prune-binaries` |

Run one with `node build/<file>.mjs <command>`; run the file with no command (or
an unknown one) and it prints the commands it accepts.

## 🧪 A build beside the editor

The ordinary build replaces what is here: the pack goes to `PiCode-Win32-x64`,
and the installer it produces carries the release's AppId, so running it
upgrades the PiCode already on the machine. A build that must not do that sets
one variable:

```bash
PICODE_PACK_SUFFIX="-experimental" ./build/build.sh
```

- **`PICODE_PACK_SUFFIX`** — the pack lands in `PiCode-win32-x64-experimental`.
  Both sides read it: `buildPath` in `build/gulpfile.vscode.win32.ts` and
  `destinationFolderName` in `build/gulpfile.vscode.ts`, so the tree a release
  was cut from is left where it is.
- **the installer follows it.** `build/build.sh` defaults
  `PICODE_INSTALLER_SUFFIX` to the pack's own suffix, and the Inno Setup task
  then moves the three things that make an install recognisable to Windows: the
  folder it lands in (`%LOCALAPPDATA%\Programs\PiCode-win32-x64-experimental`),
  the name a person reads (the wizard, the Start menu shortcut, "Apps &
  features" — `PiCode — Agentic Code Editor (Experimental)`), and its **AppId**.
  The AppId is the one that matters: with the release's, Inno Setup finds the
  existing install through the registry and writes over its folder, and one
  entry in "Apps & features" stands for two programs.
- **what does not move**: the executable, the profile (`%APPDATA%\.picode` — one
  profile for both, which is what keeps the sessions, the skills and the
  providers) and the mutex (`picode`, so one of the two runs at a time). The
  artifact is `PiCode-win32-x64-0.1.3-experimental-setup.exe`: in a side-by-side
  build the suffix takes the version's own place, where the release names its
  pre-release marker, so the two installers sort together and neither is
  mistaken for the other.
- `PICODE_INSTALLER_SUFFIX` on its own is the smaller move: pack in place,
  install beside.

The installer excludes `data/` on purpose, so an installed editor starts with a
profile of its own; the portable profile stays with the portable pack.

## 🧰 Requirements

- `git`, `node` (`.nvmrc`: 24.19.0 — `npm ci` and the gulp tasks need the
  repository's Node version), `npm`.
- Windows: **Git Bash**. `OS_NAME` comes from `OSTYPE`; an `OSTYPE` that yields
  neither `windows`, `osx` nor `linux` is a hard error.
- `python3`, `rustup` and Visual Studio 2022 with the Spectre libraries are
  needed for the **first** `npm ci` only (they build the native modules).
  Missing Spectre stops the install with `error MSB8040` in `@deviceid` and
  `@windows-registry`.
- **`jq` is not needed by anything any more.** The build reads and writes the
  JSON it touches with node; `build/pi-runtime.sh` joined on 2026-09-27, and the
  last script that used `jq` died with the patch machinery on the same day.
- `shellcheck` is not installed here, so the scripts are validated with `bash -n`.

## 📜 The deleted path

On 2026-09-27 the owner decided to stop keeping the VSCodium-style machinery.
**Deleted**: `patches/**`, `upstream/vscodium.json`, `build/get_repo.sh`,
`build/prepare_vscode.sh`, `build/patch.sh`, `build/update_patches.sh`,
`build/version.sh`, `build/utils.sh`, `build/vscodium-product.json` and
`build/ci/pin-check.sh`.

Nothing is lost that a repository should hold:

- **What the changes were** is the source itself — they are committed.
- **Which VS Code the tree descends from** is the one remaining pin,
  `upstream/stable.json`. Diffing against pristine VS Code means fetching that
  public commit, and `docs/howto-build.md` ("Traer una versión nueva de VS Code")
  is the plan.
- The full pristine-to-prepared history lived in a local git bundle that is **no
  longer in the repository** (it was never versioned): the permanent record is
  `upstream/stable.json` plus this repository's history, and
  `docs/howto-build.md` is the merge plan.

## 🏷️ Where PiCode's identity lives

- `product.json`, at the tree root, owns the PiCode **product** (`nameShort`,
  `nameLong`, `applicationName`, `urlProtocol`, the gallery, the URLs, the
  removals) and the version — a single home, committed. The build seals the
  channel into it (a copy for the pack, the source restored afterwards) and
  writes its `version` into `package.json`, which is why the built-in product is
  PiCode's and why nothing has to be rewritten inside `resources/app`
  afterwards.
- Everything the old `metadata` stage applied once — the PiCode company name in
  `build/lib/electron.ts`, the Windows icon the packer reads, the server
  manifest name, npm 11's script approvals — is **in the tree**, committed.
  Phase 1 verifies it rather than re-applying it, because a silent
  re-application is what let the first full build ship VS Code's icon.
- The files that are not identity but travel with it live in
  `build/distribution/`: `runtime.json` (the pinned pi), `settings.json`
  (first-run defaults) and the brand art (`picode.ico`, `picode.svg`,
  `picode-icon.svg`).

## 🚧 Known gaps

- **The Windows icon has to be right before the pack (phase 4).** `rcedit` stamps
  the executable during the pack, so replacing `code.ico` afterwards changes
  nothing. To re-brand it: replace `resources/win32/code.ico` (from
  `build/distribution/picode.ico` there is no automated conversion wired) and
  pack again. Phase 1 fails if the file is missing.
- **Telemetry URLs are not rewritten.** Reporting is already disabled in the tree
  and in the product, but the endpoint strings themselves still point at
  Microsoft's URLs. Nobody calls them; a future pass should clean them in the
  source.
- **The Rust CLI is optional, and blocked on OpenSSL.** `build/build-cli.sh` builds `cli/` into
  the pack, and skips with one clear line when cargo or an OpenSSL development install is
  missing, so a source build always produces an editor. The binary links OpenSSL through
  `russh` (pulled in by `tunnels`), and no machine or runner here has it yet;
  `PICODE_REQUIRE_CLI=1` turns every skip into an error for the day CI can carry it. Until then
  the pack keeps `bin/picode.cmd`, which runs the same CLI through the editor.
- **The announcement injection is not wired.** PiCode ships no announcements, so
  there is nothing to splice.
- **The staging step is the single implementation of the layer staging.** The
  retired `build/distribution/apply-picode.ps1` used to be the second
  implementation; it was removed on 2026-09-29. The staging step also adds two
  things the retired PowerShell one did not have:
  `build/branding.mjs brand-copy`, and deleting the `*.map` files and every
  `locales/*.pak` except `en-US` and `es`.
- **A version bump costs one dependency install.** `build/build-helpers.mjs
  deps-current` compares VS Code's recorded state by content hash over
  `package.json`, so writing a new version into it makes the install look stale.
  Installing once too often is preferred to trusting a tree that has not been
  checked.
- **The compile and the pack always run in full.** Neither reuses anything from
  the previous build: `compile-build-without-mangling` starts with
  `util.rimraf('out-build')`, and `bundle-vscode` and `minify-vscode` wipe
  `out-vscode` and `out-vscode-min`. This is the next thing to fix, and it is
  what makes a build cost hours.
- **CI is on.** Two workflows: `.github/workflows/ci.yml` (compile, connector
  tests, artifact, on pushes and PRs, doc-only changes ignored) and
  `.github/workflows/release.yml` (tag-driven release: build, publish, feed,
  verify). The long poles — `npm ci` and the electron download — are cached;
  `docs/CI.md` has the policy.

## 🔒 What the build never writes

The build writes only where a build belongs: `out-build/`, `out-vscode/`,
`out-vscode-min/`, the pack `PiCode-*/` and `node_modules/`. It never writes
`build/distribution/**`, and `extensions/**` is read, not rewritten. The
identity it does touch — `product.json` for the pack's copy, `package.json` for
the version — is put back the way it was.

## 🖱️ Building without a terminal

`build/build-window.cmd` opens a small window (`build/build-window.ps1`,
PowerShell and WPF, nothing to install) that a collaborator can use without
knowing any of the above:

- **what the build needs**, one row each — node at the pinned version, git (its
  Bash is what runs the build), python, the source tree, the dependencies, the
  editor — with a button that installs the missing one with `winget` (in its own
  terminal, so its own questions are seen) or a link to its download page when
  there is no package manager;
- **the build in three steps** — *source tree*, *dependencies*, *build* — so a
  failure in the middle does not force the whole thing again;
- **a bar with the stage and the percentage** while it runs, the tail of its own
  output, and a *Stop* for when it hangs (which has happened: one sat silent for
  seven hours);
- and whether a build **is already running** (the window's lock), because two at
  once in one tree fight over `node_modules` and over the directory they pack
  into.

The same progress is on the command line, for a terminal:

```bash
./build/build-live.sh                    # the build, with the bar and the percentage
node build/build-helpers.mjs progress    # the bar alone, watching a build already in flight
```

Both are the same machinery: `build/build-run.sh` runs the build and leaves a
lock, a log and an exit code behind, `build/build-helpers.mjs progress` reads
them (in text, or `--json` for the window), and `build/build-helpers.mjs
restore-profile` puts the owner's profile back afterwards, because the pack
deletes the directory it lives in.

None of them needs flags. With none, the build checks the source, installs what
is missing, compiles, packs and stages — and it is safe to repeat, because the
source is never fetched and the dependencies are installed once.

Two builds in one tree fight over `node_modules` and over the directory they pack
into — one of those left a half-installed tree behind — so the lock is checked
before starting, never after.
