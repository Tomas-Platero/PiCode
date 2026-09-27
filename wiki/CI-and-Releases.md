# CI and Releases

Microsoft's source is never committed. CI's whole job is to keep the **pin**
honest and the build reproducible. Three workflows, one guard each.

## `pin-check.yml` — the fast guard

- **When:** every push and pull request, plus dispatch from the watchdog.
- **What:** `./dev/build.sh -o` — phases 1–5, fetch through product delta,
  **no compile**. Matrix: **Linux and Windows** (the patch set has a per-OS
  game; one runner would leave half unverified).
- **A red means:** one named patch stopped applying to the pinned commit. The
  log carries `failed to apply patch <path>`; the workflow summarizes it as an
  error naming the patch. No `--reject` mode: half-applied sets are worse than
  a stopped build.
- Reproduce locally: `./dev/get_repo.sh --fetch` then `bash dev/ci/pin-check.sh`.

## `pin-watch.yml` — the weekly watchdog

- **When:** Mondays 06:17 UTC, or manually.
- **What:** asks Microsoft for the latest stable VS Code; asks GitHub for
  `microsoft/vscode` **security advisories published after the pinned
  release**; if the pin lags, opens/refreshes a PR with the new pin, dispatches
  the fast check against the branch and posts a **commit status** (GitHub does
  not run `pull_request` workflows for PRs opened by `GITHUB_TOKEN`; a
  dispatched run writing a status is the documented workaround).
- **Security vs routine:** any advisory ⇒ PR titled `fix(security)`, labelled
  `security`, body lists advisories with CVE and severity. Otherwise
  `chore(pin)` with `pin-update`. Advisory with **no fixed release yet** ⇒ a
  tracked `security` issue instead of a PR.
- The watchdog moves **only `upstream/stable.json`** — `upstream/vscodium.json`
  is a VSCodium commit whose patch set is vendored verbatim, and moving it is
  re-vendoring work, not a version bump. The PR body reminds you to review the
  pair.

## `full-build.yml` — the compiles-for-real nightly

- **When:** nightly 03:41 UTC **only if something relevant changed**
  (`upstream/`, `patches/`, `dev/`, `distribution/`, `.nvmrc`) — compiling an
  unchanged tree discovers nothing; on pushes that move either pin; manually;
  and on `v*` tags. (GitHub cannot mix `paths` and `tags` filters on one push
  trigger, so a tiny `gate` job decides and the matrix starts only when
  warranted.)
- **What:** the whole chain on **Windows and Linux**; uploads both packed
  trees as artifacts (14 days, with `SHA256SUMS.txt`).
- **On a tag:** publishes a GitHub Release with portables **and installers**:

  | Asset | Notes |
  | --- | --- |
  | `PiCode-<ver>-win-x64-setup.exe` | Inno Setup, built in-tree |
  | `PiCode-<ver>-win-x64.zip` | portable |
  | `PiCode-<ver>-linux-x64.deb` / `.rpm` | run sequentially; per-arch collect globs |
  | `PiCode-<ver>-linux-x64.tar.gz` | portable |
  | `SHA256SUMS.txt` | merged at release time |

  Names come from the tag (minus `v`); non-tag builds use the product version
  from the delta.

## Caching policy (learned the hard way)

| Cached | Key | Why |
| --- | --- | --- |
| git objects of the source (~320 MB) | `vscode-git-<os>-<commit>` | never re-download the pinned commit |
| npm tarballs + node-gyp headers | `npm-cache-<os>-<commit>` | installs stay fast |
| **`node_modules`: deliberately NOT cached** | — | VS Code's postinstall writes node modules in ~50 workspace dirs; a root-only cache made the fast-install trust a half tree, and a tag build died in phase 7 on `Cannot find package 'gulp-merge-json'`. A full `npm ci` (~4–5 min with warm tarballs) is the correct price for builds that publish binaries. |

## Signing and runner notes

- **Windows binaries are unsigned** until a certificate exists. Adding the
  secrets `PICODE_CODESIGN_PFX` (base64) + `PICODE_CODESIGN_PASSWORD` is all
  it takes — the workflow then signs `PiCode.exe` and the installer with
  `signtool`. Until then: SmartScreen warning, and checksums to verify.
- Linux direct downloads need no signature; signing an APT/RPM repo is the
  follow-up if one is ever hosted.
- The Windows runner must carry the Spectre-mitigated VS libraries; the
  workflow verifies with `vswhere` and fails with a clear message if absent.
- Actions are pinned by major tag (`checkout@v7`, `setup-node@v7`, `cache@v6`,
  Node 24). Strict SHA pinning is a known, deliberately deferred tightening.
- **Pin policy once a PR lands:** security ⇒ merge within days; routine bump ⇒
  when convenient, the PR can wait. Before merging either: pin-check green on
  the PR, and a note on whether the VSCodium pair needed re-vendoring (or why
  provably not).

---
Related: [Building PiCode](Building-PiCode.md) · [The Patch System](The-Patch-System.md)
