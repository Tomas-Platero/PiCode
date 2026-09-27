# The Patch System

> **RETIRED 2026-09-27.** The patch system described here has been **deleted** by the owner's
> decision: `patches/**`, `dev/get_repo.sh`, `dev/prepare_vscode.sh`, `dev/patch.sh`,
> `dev/update_patches.sh`, `dev/utils.sh` and `upstream/vscodium.json` no longer exist. The
> changes those patches carried are now ordinary code inside `picode-source/`, versioned in this
> repository. This page is kept as the history of how the tree was made. For how work happens
> now: `CONTRIBUTING.md` and `docs/howto-build.md`.

PiCode's changes to the editor live in two patch directories and one data
file. Knowing which one owns your change is the first skill of contributing.

```text
patches/
  vscodium/     75 files — VENDORED VERBATIM from the pinned VSCodium revision
  picode/       23+ numbered patches — PiCode's own source changes
distribution/
  product-delta.json   the product identity, as data (set / unset /
                       unsetNested / unsetArrayEntries)
```

## `patches/vscodium/**` — inherited, never hand-edited

Copied exactly from the revision recorded in `upstream/vscodium.json`
(currently `1.135.06055`). It removes Microsoft's identity: telemetry, cloud,
updater, signing, Copilot hooks, onboarding. Applied in order: `.json` erase
actions, then `*.patch`, then the per-OS set under `${OS_NAME}/`.

**Editing these files is a defect**, full stop: their value is that they are
provably upstream's, and `upstream/vscodium.json` documents that provenance.
Moving the VS Code pin without re-vendoring this set is also a defect — the
two pins move together.

## `patches/picode/**` — ours, numbered

One patch per change, named by number and subject
(`12-picode-connector.patch`, `16-picode-win32-folder-name.patch`,
`19-picode-welcome.patch`, `23-pi-profile-discovery.patch`…). These are real
TypeScript changes: the welcome page, the wizard, removal of the VS Code Agents
window, the output folder names, the connector extension itself
(`picode-source/extensions/picode/` **is created by** patch 12 — anything you
hand-write inside `picode-source/` without a patch to produce it is lost on the
next regeneration, as happened once).

### Rules of the set

- **Never overwrite**: the `vscode` extension API namespace, internal
  `out/vs/**` paths, real extension IDs, the Open VSX API URL, legal notices.
- **"VSCodium" stays** where it is legitimately upstream's binary identity
  (`@vscodium/native-keymap`, ripgrep). Saying otherwise would be false.
- Renaming the source tree is allowed where harmless (`picode-source/`), but
  `patches/vscodium/`, `dev/prepare_vscode.sh` and `src/vs/**` keep their
  names on purpose: provenance, not branding.
- `OS_NAME` is mandatory when applying: an empty glob re-applies every per-OS
  patch, corrupting the tree.
- Patches carry LF line endings enforced by `.gitattributes`; the vendored set
  arrived from git blobs, not from the working tree.

## The product delta — data, not code

`distribution/product-delta.json` is the **only source of PiCode's product
identity**: name, icons, gallery, URLs, pruned keys. It is applied by a Node
program (`apply-product-delta.mjs`) rather than PowerShell because Windows
PowerShell 5.1 caps JSON depth and escapes non-ASCII, which would corrupt a
77-key product file.

Two lessons, both discovered **by running the built tree**, not by review —
the delta is valid JSON either way:

1. A key core iterates without a guard must exist as `[]`, not be absent
   (`builtInExtensionsEnabledWithAutoUpdates` → crash: *is not iterable*).
2. A nested object core dereferences must be **pruned key by key**, not
   deleted (`defaultChatAgent` → grey blocked window; its 14 endpoint keys are
   removed individually instead).

## Re-pinning and repairing

When upstream moves and CI's pin-check goes red, the log names the failing
patch (`failed to apply patch <ruta>`). The repair flow in
`docs/howto-build.md` is:

1. Reproduce cheaply: `./dev/build.sh -o` (phases 1–5, no compile), or locally
   `dev/get_repo.sh --fetch` + `dev/ci/pin-check.sh`.
2. Fix the patch against the new tree — regenerate, do not hand-edit vendored
   files.
3. Verify against a **clean copy of the target file**: reverse-applying a patch
   successfully does *not* prove it applies forward.
4. Move both pins together in the same PR, or say in the PR why the VSCodium
   pin provably does not need to move.

There is no `--reject` mode: a half-applied set is worse than a stopped build,
so the pipeline stops at the first failure.

---
Related: [Building PiCode](Building-PiCode.md) · [CI and Releases](CI-and-Releases.md)
· [Decisions Log](Decisions-Log.md#adr-011)
