# The PiCode source build

`dev/` builds PiCode from the VS Code source instead of from a VSCodium archive,
the way VSCodium does it: clone the pinned commit, patch the source, apply the
PiCode product layer, compile, stage. The prebuilt-ZIP release path
(`distribution/apply-picode.ps1`) is untouched and remains the path for someone
who only wants to use PiCode.

```bash
./dev/build.sh          # fetch, prepare, npm ci, compile, pack, stage
./dev/build.sh -o       # stop after the preparation (no npm ci, no compile)
./dev/build.sh -s       # reuse ./vscode instead of fetching it
```

## Phases

| # | Phase | What runs |
| --- | --- | --- |
| 1 | fetch | `dev/get_repo.sh`: clone `upstream/stable.json` → `./vscode`, pinned by commit. `dev/version.sh` derives `BUILD_SOURCEVERSION`. |
| 2 | brand | `dev/prepare_vscode.sh brand`: `jq` rewrites `vscode/product.json`. |
| 3 | VSCodium patches | `dev/prepare_vscode.sh patches-vscodium`: `*.json` removal actions, then `*.patch`, then `insider/` (insider only), then `${OS_NAME}/`, then `user/`. |
| 4 | PiCode patches | `dev/prepare_vscode.sh patches-picode`: the same order, over `patches/picode/`. |
| 5 | product delta | `node distribution/apply-product-delta.mjs --target vscode/product.json --delta distribution/product-delta.json --write`. |
| 6 | dependencies | `npm ci` in `./vscode` (up to five attempts, as VSCodium does). |
| 7 | compile and pack | `npm run gulp vscode-min-prepack`, the RTF/EULA resource, the win32 group-policy definitions, `npm run gulp vscode-win32-x64-min-packing`. |
| 8 | stage | `dev/stage-distribution.sh`: the distribution layer onto `./PiCode-Win32-x64`. |

`-o` stops after phase 5 with exit code 0 and compiles nothing. It exists so the
preparation can be verified in a minute rather than after a full build.

`-s` reuses `./vscode`. A clean tree (fetched, never prepared) goes through
phases 2–5; a dirty tree is a prepared tree, so phases 1–5 are skipped and the
build resumes at phase 6. That is the split VSCodium's `SKIP_SOURCE` provides.

## Requirements

- `git`, `node` (`.nvmrc`: 24.18.0 — `npm ci` and the gulp tasks need the
  repository's Node version), `npm`.
- `jq` **on `PATH`**. Phase 2 and the removal actions need it, and both fail with
  a clear message if it is missing. Nothing here hardcodes a path to a `jq`
  binary.
- Windows: Git Bash. `OS_NAME` comes from `OSTYPE`; an `OSTYPE` that yields
  neither `windows`, `osx` nor `linux` is a hard error, because the patch stage
  would otherwise glob `patches/vscodium//*.patch` and apply the top-level set
  twice.
- `python3`. It is **not** used by any `dev/*.sh`: the reject-file handling is
  `git apply --reject` plus the interactive loop in `dev/utils.sh`, with no Python
  pass. Python comes from the VS Code build itself (`node-gyp` compiles the native
  modules), which is why VSCodium lists it. VSCodium asks for 3.11; this machine has
  3.14, and whether that satisfies `node-gyp` is only settled by running phase 6. It
  has not been settled here.

## Pins

- `upstream/stable.json` — VS Code `tag`/`commit`/`repository`.
- `upstream/vscodium.json` — the VSCodium revision whose `patches/` tree is
  vendored under `patches/vscodium/`, and whose root `product.json` is vendored
  as `dev/vscodium-product.json`. Re-pinning VS Code without re-pinning this file
  is a defect: the inherited patches are written against one VS Code revision.

`RELEASE_VERSION` defaults to the `tag` of `upstream/stable.json` and is what the
`!!RELEASE_VERSION!!` placeholders expand to. A release build sets it in the
environment (it must be `X.Y.Z`); a build from a bare pin therefore stamps the VS
Code revision it was built from.

## Where PiCode's identity lives

There are two mechanisms, and they carry different things:

- `distribution/product-delta.json` owns the PiCode **product** (`nameShort`,
  `nameLong`, `applicationName`, `urlProtocol`, the gallery, the URLs, the
  removals). Phase 5 applies it to `vscode/product.json` *before* packing, which
  is why the built-in product is PiCode's and why nothing has to be rewritten
  inside `resources/app` afterwards.
- The `!!APP_NAME!!`-style placeholders own the PiCode **paths and URLs** that
  appear in patched source. `patches/vscodium/**` is vendored verbatim and is
  templated at apply time by `dev/utils.sh` (into a temporary copy, never in
  place).

Phase 2 therefore brands `product.json` with VSCodium's *stable* identity, not
PiCode's: `patches/vscodium/**` is authored against a VSCodium-branded product,
and the keys the delta does not own (`darwinBundleIdentifier`, `linuxIconName`,
`serverApplicationName`, the `win32*` identifiers) stay as VSCodium left them —
which is exactly what the shipped `resources/app/product.json` carries.

## Deliberate deviations from VSCodium

| VSCodium | Here | Why |
| --- | --- | --- |
| `-ilops` flags, insider and asset builds | `-o`, `-s` | PiCode publishes neither insiders nor installers. `-o` additionally skips the compile. |
| `prepare_vscode.sh` merges the repository-root `product.json` | merges the vendored `dev/vscodium-product.json` | PiCode has no root product file; the vendored one is the same file, at the same pinned revision. |
| `prepare_vscode.sh` copies `src/{stable,insider}/` | not copied | It holds VSCodium's icons. PiCode's marks are staged in phase 8. |
| `prepare_vscode.sh` installs dependencies and runs `undo_telemetry.sh` | dependency install moved to phase 6; `undo_telemetry` still unwired | See the gaps below. |
| `prepare_vscode.sh` writes the `package.json` version and the `Microsoft Corporation` replacements inside its patch stage | `dev/prepare_vscode.sh metadata`, a stage of its own after the patches | Three vendored patches rewrite `package.json` and one rewrites the signature subject, so branding before them would move their context out from under them. |
| `dev/patch.sh` and `dev/update_patches.sh` use throwaway commits | use the git index | Regenerating a patch needs a reference state, not a commit history; `git add -A` then `git diff` gives the same answer. |
| `dev/build.env` | not written | VSCodium persists the version because it can come from the update API. Here it is always derived from the pin. |

## Known gaps

- **`undo_telemetry.sh` is not wired.** VSCodium rewrites every
  `*.data.microsoft.com` URL in the source after `npm ci`. `patches/vscodium/00-telemetry-disable.patch`
  and the product delta already disable telemetry reporting, but the URL rewrite
  itself is not done. It is a `sed` pass over the tree and belongs between phases
  6 and 7.
- **The package metadata is branded by the `metadata` stage, not by the patch
  set.** `dev/prepare_vscode.sh metadata` writes `package.json`'s version and the
  `Microsoft Corporation` -> product-name replacements in `package.json`,
  `build/lib/electron.ts` and `resources/server/manifest.json`. The version it
  writes is `RELEASE_VERSION`, which `dev/get_repo.sh` derives from the
  `upstream/stable.json` tag (`1.135.0`) and **not** from VSCodium's
  `${tag}${day-of-year*24+hour}` date formula. Consequence to know about: a source
  build stamps `1.135.0`, while the prebuilt ZIP that ships today carries the
  VSCodium build tag `1.135.06055`. Both are deterministic, and the asset URLs
  always agree with whichever value is in force; unifying the two numbers is a
  versioning-policy decision that PiCode has not made yet.
- **`build_cli.sh` is not wired, so a source build ships no TUNNEL binary.**
  Measured on a full build: `bin/picode` and `bin/picode.cmd` DO exist (the CLI shim is
  produced by the pack with the renamed binary), but `picode-tunnel.exe` does not,
  because VSCodium builds the tunnel from release assets the project publishes and
  PiCode publishes none. The prebuilt ZIP carries it.
- **The announcement injection is not wired.** VSCodium splices its own
  `announcements-builtin.json` into the welcome page. PiCode ships no announcements,
  so there is nothing to splice.
- **The Start Menu tiles and the executable's icon are branded before the pack.**
  `dev/prepare_vscode.sh metadata` (function `brand_windows_icons`) writes
  `vscode/resources/win32/code.ico` from `distribution/picode.ico` and redraws the 70 px
  and 150 px tiles with `System.Drawing`. This is **not** an optional tidy-up and it is
  not a phase-8 job: `rcedit` stamps the executable from that file while the tree is
  being packed, so replacing it afterwards changes nothing. Measured: the first full
  build shipped `PiCode.exe` with VS Code's icon while phase 8 reported
  "replaced …/code.ico". Note also that `picode.ico` stores every frame PNG-compressed,
  which `System.Drawing.Icon` cannot read -- the frame is extracted from the container
  by hand.
- **What the packer bakes into the executables has to be right before phase 7; the
  product configuration does not.** Two different things, and getting them confused costs
  an hour. Measured on a full build:
  - `rcedit` runs during the pack and writes the version strings **and the icon** into
    the executables. Anything fixed after that needs `rcedit` again -- copying a file is
    not enough. This is what produced the icon defect above.
  - The product configuration is **read at runtime** from
    `resources/app/product.json`, which is why the delta applied by phase 8 takes effect.
    The `/*BUILD->INSERT_PRODUCT_CONFIGURATION*/` marker inside the compiled
    `product.js` is a *comment* in an object literal; the pack keeps it (only the web
    target substitutes it, see `build/gulpfile.vscode.web.ts`), so the app takes the
    `vscode.context.configuration()` path and gets the product from that file. Measured:
    the packaged bundle contains no `.picode` anywhere while the packaged
    `product.json` carries every branded key.
    An earlier revision of this list claimed the opposite -- that branding was inlined at
    compile time and so could not be corrected after packing. That was inferred from
    `build/next/index.ts` and never checked against the packed tree, and it is wrong.
- **The staging step duplicates logic from `distribution/apply-picode.ps1`.** The
  PowerShell script derives its root from its own location, so it can only run
  against the tree at the repository root; pointing it at `./PiCode-Win32-x64`
  would mean moving the pack output onto the frozen release tree. The bash
  version mirrors its steps 1–6 and both must be kept in sync.
- **No CI.** Declared out of scope.

## What the pipeline never writes

`patches/**` (the templates are expanded into a temporary copy),
`distribution/**`, `extensions/**` and `.git/**`. `./vscode` and `./VSCode-*` are
build outputs and are git-ignored.

## Building without a terminal

`dev/build-window.cmd` opens a small window (`dev/build-window.ps1`, PowerShell and WPF, nothing to
install) that a collaborator can use without knowing any of the above:

- **what the build needs**, one row each — node at the pinned version, git (its Bash is what runs
  the build), jq, python, the source tree, the dependencies, the editor — with a button that
  installs the missing one with `winget` (in its own terminal, so its own questions are seen) or a
  link to its download page when there is no package manager;
- **the build in three steps** — *source tree*, *dependencies*, *build* — so a failure in the middle
  does not force the whole thing again;
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

None of them needs flags. With none, the build fetches the source if it is missing, prepares it,
installs, compiles, packs and stages — and it is safe to repeat, because a tree that is already
prepared is reused. `-s` is the other thing: reuse the tree *as it is*, for when you know it is
prepared. It fails outright when the tree is not there, which is why it is not a default anywhere.

The editor's own task list carries the same four entry points (`.vscode/tasks.json`, which VS Code
reads with comments allowed — this explanation lives here so the file stays readable by every JSON
tool). The default task is the live build, the one with the bar. Two builds in one tree fight over
`node_modules` and over the directory they pack into — one of those left a half-installed tree
behind — so the lock is checked before starting, never after.
