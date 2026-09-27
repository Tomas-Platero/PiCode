# Distribution and Licensing

## The two distribution paths, and their relation

| | Source path (canonical) | ZIP path (the modification layer) |
| --- | --- | --- |
| Input | VS Code at the pinned commit | a stock VSCodium release archive |
| Mechanism | patches + delta applied **before** compiling | `distribution/apply-picode.ps1` applies the delta to a pre-built `resources/app` |
| Can change behaviour | yes — TypeScript patches | no — compiled core is guarded by a `checksums` map |
| Needs toolchain | Node, jq, Python, Rust, MSVC+Spectre | PowerShell only |
| Used for | releases, CI, contributors | auditors of the branding layer; the prebuilt release ZIP is what users download (built via the source path) |

Both paths share the same product delta, so the identity is identical; the
difference is what each can reach. Version numbers on the two paths
(`1.135.0` vs `1.135.06055`-style) are not yet unified — open owner decision.

## The repository layout as distribution

The repo root **is** the distribution root (that is what enables portable
`data/` beside the executable). The ~1 GB payload is gitignored and cannot be
committed (GitHub's 100 MB file limit; the executable alone is 212 MB — Git LFS
free quota is smaller than the payload). What is versioned:

| Path | Role |
| --- | --- |
| `upstream/` | the two pins |
| `patches/` | inherited + own patch sets |
| `dev/` | the build engine (bash) + CI helpers |
| `distribution/` | product delta, settings, icons, apply scripts |
| `builder/` | the C# build front-end |
| `extensions/picode-pi-chat/`, `legacy/` | the retired panel, pending core migration |
| `docs/`, `odd/tasks/`, `AGENTS.md` | the reasoning, in precedence order |

`apply-picode.ps1` previews by default, writes only with `-Apply`, backs up
`product.json` before its first write, refuses to run outside a VSCodium root,
and is idempotent.

## What is PiCode's name and what stays upstream's

Renamed by the distribution: `PiCode.exe`, `bin/picode*`, window title, About
dialog, Start Menu tile manifest, the executable icon (via `rcedit` — safe
because the binary is unsigned).

Still legitimately upstream's, and staying so:
- **OS-level identity of an installed VSCodium** (registry, protocol handlers,
  installer GUIDs) — PiCode runs from a folder rather than being installed on
  the ZIP path; installers now exist on the source path and carry PiCode's
  name;
- **the lineage in licence files and the `out/` bundle**, where "VSCodium"
  must keep appearing because it *is* the upstream base.

## Licensing

- **PiCode itself: MIT** — Copyright (c) 2026 Tomás Platero ([LICENSE](https://github.com/Tomas-Platero/PiCode/blob/main/LICENSE)).
- Upstreams, all MIT, all preserved: **VS Code** (microsoft/vscode),
  **VSCodium**, **Pi** (earendil-works/pi), **Gentle AI** and **Engram**
  (Gentleman-Programming).
- PiCode is **not** an official distribution of VSCodium, Pi or Gentle AI.
- Microsoft's **source is never uploaded to this repository** — the tree is
  fetched at build time from the pin; binaries fetched from VSCodium releases
  are transformed, not mirrored.
- The editor installs extensions from **Open VSX**: the Microsoft Marketplace
  terms do not license third-party builds to use their gallery. Marketplace-
  only themes are therefore uninstallable here, and the UI says so.

## The business model, in one paragraph

The program stays **free and complete** — no trimmed features, no server
dependency. What is sold, later, is **cloud sync of the profile**: `data/`
(PiCode settings + Pi profile + Gentle AI state) uploaded and downloaded as one
unit. Credentials will require explicit consent and encryption before leaving
the machine. Nothing in the distribution strategy depends on withholding
functionality.

---
Related: [Getting PiCode](Getting-PiCode.md) · [CI and Releases](CI-and-Releases.md)
