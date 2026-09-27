# Building PiCode

> **UPDATED 2026-09-27.** The chain below describes the old eight-phase build (fetch → patches
> → compile). That machinery is **deleted**: the build now has five phases — *prepare* (the tree,
> the identity and the dependencies, in one), *connector*, *compile*, *pack*, *stage* — because
> `picode-source/` is versioned in this repository and carries the patches' changes as code.
> A full build in steady state measures about **six minutes** locally. The current truth is
> `dev/README.md` and [`docs/howto-build.md`](../docs/howto-build.md); this page stays as the
> record of the old chain.

The source build is the canonical one: releases are produced by it, CI runs
it, and it is the only path that can change editor behaviour. The ZIP-over-
VSCodium path stays available for auditors of the *modification layer* only —
see [Distribution and Licensing](Distribution-and-Licensing.md).

## The chain, phase by phase

`dev/build.sh` runs eight phases; each layer adds something and none rewrites
the previous one. The order is not negotiable.

| Phase | Script | What happens |
| --- | --- | --- |
| 1 · Fetch | `dev/get_repo.sh` | clone/fetch the VS Code commit from `upstream/stable.json` into `picode-source/`, verify HEAD |
| 2 · Prepare | `dev/prepare_vscode.sh brand` | base VSCodium identity stamped into `product.json` |
| 3 · Inherited patches | `patches/vscodium/**` | the vendored VSCodium set, per-OS (`${OS_NAME}/`), erase-actions first, then `.patch` files |
| 4 · Own patches | `patches/picode/**` | PiCode's numbered source changes |
| 5 · Product delta | `distribution/product-delta.json` | brand, gallery, URL, key pruning — applied **before** compiling |
| 6 · Install | `npm ci` | dependencies, up to 5 retries (transient Windows failures recover) |
| 7 · Compile + pack | gulp `vscode-min-prepack`, per-OS packing tasks | produces `PiCode-Win32-x64/` or `PiCode-linux-x64/` |
| 8 · Stage | `dev/stage-distribution.sh` | portable `data/`, settings, renames to `PiCode.exe` / `bin/picode*`, icons, Pi runtime install |

```bash
./dev/build.sh          # whole chain (≈20–45 min, a few GB of node_modules)
./dev/build.sh -o       # phases 1–5 only — the fast correctness check, minutes
./dev/build.sh -s       # reuse ./picode-source (resume after a fixed failure)
./dev/build.sh -f       # force a fresh fetch
```

`-o` is what the CI pin-check runs: it proves the patch set composes without
paying for a compile. **Flagless invocation reuses** the prepared tree (an
earlier version deleted it — inherited VSCodium logic — and the docs had
claimed otherwise; the fix made reuse explicit and `-f` fresh).

## Dependencies (Windows)

Scripts are **Bash** — run them from **Git Bash**; PowerShell cannot execute
them. The authoritative check list is `dev/build-requirements.mjs`; run it and
it tells you what is missing and what is merely recommended (Rust is
recommended; its absence does not stop a build).

| Tool | Why | Install |
| --- | --- | --- |
| Git for Windows | Git **and** Git Bash | `winget install --id Git.Git -e` |
| Node (match `.nvmrc`) | `npm ci` + gulp | nvm-windows or winget |
| jq | phase 2 brands `product.json`; patch `.json` actions read it | `winget install --id jqlang.jq -e` |
| Python 3.11 | asked by VS Code's build system for node-gyp | `winget install --id Python.Python.3.11 -e` |
| Rustup | some native modules; **restart the shell after** (it rewrites PATH) | [rustup.rs](https://rustup.rs/) |
| VS 2022 C++ workload **+ Spectre-mitigated libs** | node-gyp via MSBuild — without Spectre the build stops with `error MSB8040` | VS Installer → Modify → Individual components |
| 7-Zip | only to produce release `.zip` | `winget install --id 7zip.7zip -e` |

Check Spectre without installing anything:

```bash
VSW="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
"$VSW" -latest -products '*' \
  -requires Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre \
  -property installationPath
# no output = missing, and phase 6 will stop
```

## Linux

End-to-end wired and compiled in CI nightly. Same scripts, OS derived from
`OSTYPE`, per-OS patch sets, output `PiCode-linux-x64/`. Native modules compile
for the host, so a Linux build needs a real Linux (or WSL) — and the clone
should live on the Linux disk (`~/PiCode`), not `/mnt/d/...`, which is many
times slower. **macOS is not wired**: the build refuses with a message saying
so.

## The graphical front-ends

- **`builder/`** (C# / WinUI 3) — the recommended way. A thin front-end over
  the same scripts; needs only the .NET SDK; drives Windows natively and Linux
  through WSL. `cd builder && ./build.cmd`.
- **`dev/build-window.cmd`** (PowerShell + WPF) — the older window: one row per
  requirement with an Install button, three-step build (source, deps, compile),
  lock against concurrent builds, honest progress labeled as estimate.

All entry points (terminal, window, builder, CI) run the same engine; the
engine in `dev/` stays executable on its own.

## If it fails

- `failed to apply patch <path>` → the pin moved under a patch. Repair process:
  [The Patch System](The-Patch-System.md#re-pinning-and-repairing).
- `MSB8040` → Spectre libs missing (check above).
- `npm ci` failing once then continuing → normal, the pipeline retries.
- Editor built but weird → see the verification checklist in
  [docs/DISTRIBUTION.md](https://github.com/Tomas-Platero/PiCode/blob/main/docs/DISTRIBUTION.md);
  note that `PiCode.exe` reading ARM64 binaries on x64 passes every
  file-level check: **verify the PE machine type of any archive you extract.**

---
Next: [The Patch System](The-Patch-System.md) · [CI and Releases](CI-and-Releases.md)
