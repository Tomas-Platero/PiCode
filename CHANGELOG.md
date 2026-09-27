# Changelog

All notable changes to PiCode are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by pushing a `v*` tag, which triggers the full-build workflow to publish
portable archives and installers for Windows and Linux.

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
