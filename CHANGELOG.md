# Changelog

All notable changes to PiCode are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are built locally with `dev/build.sh` and published by hand: there is no CI workflow
(the owner removed them; the process lives in `docs/CI.md`).

## [Unreleased] — 2026-09-27

### Changed
- **esbuild is back on — at upstream's factory value.** VSCodium had flipped
  `useEsbuildTranspile` to `false` without recording a reason anywhere; PiCode restored it to
  `true` (2026-09-27) and closed the one real gap the route has: the product chain no longer
  type-checks by itself, so a headless `tsgo --noEmit` step (`picode-typecheck`) now runs at
  the front of `vscode-min-prepack`, same as `core-ci` does. Measured steady-state: compile
  41s (was 5m05s), pack 2m23s including the bundle (was 36s), **full build 3m34s** (was
  about 6 min), editor starts. The development loop exists again: `npm run transpile-client`
  turns 7,559 source files into a runnable `out/` in 7s, and `npm run watch` is no longer a
  no-op.
- **`picode-source/` is the product source now, versioned in this repository.** One clone has
  everything: the editor's code, the PiCode changes and the identity. The tree that used to be
  rebuilt on every build by fetching VS Code and applying 92 patches was committed and
  imported (13,125 files; base recorded in `upstream/stable.json`, VS Code 1.135.0). Product
  work means editing code, not writing patches.
- **The patch machinery was deleted by the owner's decision**: `patches/**`,
  `dev/get_repo.sh`, `dev/prepare_vscode.sh`, `dev/patch.sh`, `dev/update_patches.sh`,
  `dev/version.sh`, `dev/utils.sh`, `dev/vscodium-product.json`, `upstream/vscodium.json`,
  `dev/ci/pin-check.sh`. Provenance lives in the pin, in the public VS Code commit it names,
  and (locally) in a git bundle of the pre-import history.
- **The build has five phases instead of eight**: prepare (tree + identity + dependencies in
  one), connector, compile, pack, stage. `npm ci` runs only when the recorded dependency state
  no longer matches the tree; `-f` refuses instead of deleting the source; `-o` checks the
  source and identity in seconds.
- **`jq` is gone as a dependency** — nothing needs it any more.

### Measured
- A full steady-state Windows build on a 16-core machine, with the esbuild route restored
  (2026-09-27): **3 min 34 s** — compile 41 s (the headless type check inside), pack 2 min
  23 s (bundling the 24 shipped outputs from source costs ~100 s of it), stage 17 s. The
  dev loop too: 7,559 files transpiled to a runnable `out/` in 6.8 s. The rebuilt editor
  starts (eight processes, window up) and restores the portable profile (138 files).
- The same tree on the classic gulp-tsb route, earlier the same day: about six minutes —
  compile 5m05s, pack 36s, stage 17s. The former up-to-210-minute cost belonged to the old
  chain (dependency reinstalls, native rebuilds, CI runners), not to compiling.

## [0.1.2] — 2026-09-27

### Added
- **Installers join the portables**: Windows setup (`Inno Setup`) plus `.deb` and `.rpm` for
  Linux, with `SHA256SUMS.txt` across every release asset.
- **First-run setup as a three-step wizard** you can watch: choose the Pi runtime, connect a
  provider, install Gentle AI — with the buttons that actually look like buttons.
- **A Gentle install you can watch**, and a chat that reloads it when it finishes.

### Fixed
- The chat follows the Pi instance that is in force, models included.
- The runtime choice writes the key it registered; Copilot leaves the status bar.
- Gentle AI installs one package at a time, with npm 11's script gate satisfied in the
  metadata stage.
- The npm project is created before npm runs against it (setup path).
- The Linux build heap comes down to 5632 MB; the minifier gets a bigger heap on Windows;
  the heap is sized per system and gulp runs without npm's hardcoded ceiling.
- Patches 19/20 restored after a pathspec slip during regeneration.

### CI
- Full builds run on **Windows and Linux** with tag-driven releases; hard time ceilings sized
  to a healthy build (Windows grows to 210 minutes); a new build cancels the one in progress;
  the nightly only runs when something relevant changed.
- No `node_modules` cache — the fast-install path trusted a half-built tree. The cache
  question stays open; tarball and git-object caches remain.
- GitHub assets are fetched authenticated; the `deb`/`rpm` pairs build sequentially; the
  collect steps read where each packager actually leaves its artifact; Linux compiles move to
  a larger runner and stop `systemd-oomd` first; the Windows build finds Visual Studio
  through `vswhere`.

## [0.1.1] — 2026-09-23

### Fixed
- Theme gallery: what independent verification found, including a panel that was never one.

### Changed
- Docs: the binary is a release, not a commit — the 1 GB payload is not versioned; the ZIP
  path and the source path are documented as separate routes with separate audiences.

## [0.1.0] — 2026-09-23

First tagged release. Distribution layer plus the agent panel, built on a VSCodium tree that
PiCode owns:

### Added
- **Source build**: clone the pinned VS Code, apply the vendored VSCodium patch set and
  PiCode's own patches, apply the product delta, compile `PiCode.exe` — reproducible by any
  collaborator (ADR-011 path, `dev/build.sh`).
- **Two pins** (`upstream/stable.json`, `upstream/vscodium.json`) and the CI guards around
  them: `pin-check` on every push/PR (Linux + Windows), weekly `pin-watch` that opens
  security-labelled update PRs, nightly full build.
- **Product delta as data** (`distribution/product-delta.json`): branding, Open VSX gallery,
  portable profile (`data/`), and real deletion of Copilot and telemetry keys — not cosmetic
  overrides.
- **Agent panel** (`extensions/picode-pi-chat`, since retired in favour of core integration):
  chat with streaming, tools, reasoning, sessions and slash commands; settings surface;
  provider connection (OAuth and key, via Pi's own login flows); package management;
  dual runtime (Pi on `PATH`, managed install, or custom) over RPC or embedded SDK.
- **Theme gallery** with a preview rendered from each theme's own colours, reachable from the
  palette, the panel and the first-run wizard.
- **First-run wizard**: runtime choice, Gentle AI switch, theme choice.
- Pi and Gentle AI pinned and installed through their own mechanisms (ADR-010), with
  `picode.pi.executablePath` as the escape hatch.

### Known at release
- Windows binaries unsigned (SmartScreen warning on first run).
- Interactive surfaces verified by hand; the decisions around them are covered by hermetic
  suites.
- macOS not wired (the build refuses with a message that says so).

## Unreleased

Nothing tagged since 0.1.2.
