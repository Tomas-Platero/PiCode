<!-- markdownlint-disable MD033 -->
<div align="center">

<img src="./assets/picode-banner.png" alt="PiCode — the best AI for coding, powered by Pi" width="100%" />

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-3B9BFF?style=flat-square)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-1E1E1E?style=flat-square&logo=windows&logoColor=3B9BFF)](#what-exists-today)
[![Built on VSCodium](https://img.shields.io/badge/Built%20on-VSCodium-1E1E1E?style=flat-square)](https://github.com/VSCodium/vscodium)
[![Powered by Pi](https://img.shields.io/badge/Powered%20by-Pi-3B9BFF?style=flat-square)](https://pi.dev)
[![Gentle AI](https://img.shields.io/badge/Memory%20%26%20Workflow-Gentle%20AI-3B9BFF?style=flat-square)](https://github.com/Gentleman-Programming/gentle-ai)

</div>

<br />

> **A VSCodium distribution with the [Pi](https://pi.dev) coding agent and [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) inside the editor core — not as something you install afterwards.**
>
> `@pi` in the chat, providers connected from settings, memory and skills already there. No setup ceremony, no Copilot.

<br />

**PiCode is free and complete.** No feature is held back. The editor itself is 100% open-source and works fully offline with your own provider keys.

| 👤 Just want to use it | 👨‍💻 Want to build or contribute |
| --- | --- |
| [Download a release](https://github.com/TomasPlatero/PiCode/releases) · unzip · run `PiCode.exe` · read the [wiki](https://github.com/TomasPlatero/PiCode/wiki) | [Source build guide](#the-source-build) · [Contributing docs](CONTRIBUTING.md) · [How to compile](docs/howto-build.md) |

<br />

## What it is

A VS Code-family editor we maintain **as our own source**: `picode-source/` is versioned here,
with the branding, the connector and the product identity already inside it. Opening PiCode
means opening a working agentic environment:

| | What you get |
| --- | --- |
| **Chat** | `@pi` as the default participant — streaming transcript, tools, reasoning, sessions (list/resume/fork), slash commands, attachments (images, files, video, audio). |
| **Settings** | Pi's settings (models, analytics, network, tools, packages, skills) in the editor's own tree, grouped in product nodes. No PiCode-owned settings page — the editor *is* the surface. |
| **Providers** | Connect with an API key or OAuth subscription (ChatGPT, Claude Pro/Max, Copilot, Grok, Kimi, Meta, OpenRouter, Radius…). Custom endpoints with your own base URL and dialect. 41 providers total. |
| **Themes** | A gallery with a live preview rendered from each theme's own colours, install-and-apply in one action. Open VSX gallery; marketplace-only themes are explained rather than failing silently. |
| **One profile** | Settings, credentials, models, packages, skills, MCPs, memory — all in PiCode's portable `data/` folder. Nothing is read from or written to a Pi already on your machine. |
| **Gentle AI** | The workflow harness on top: memory, skills, subagents, review discipline. Installed in the wizard or the settings. |

It speaks to Pi two ways: **RPC** (`pi --mode rpc`, JSONL over stdio) as a child process — or **embedded** through the SDK, loading Pi inside the editor. Both use the same installation.

## What it stands on

PiCode doesn't reinvent the editor, the agent or the memory layer. It unifies three open-source projects and wires them together:

| | Project | What it brings |
| --- | --- | --- |
| <img src="./assets/vscodium.svg" width="26" alt="VSCodium" /> | **[VSCodium](https://github.com/VSCodium/vscodium)** / [VS Code — MIT source](https://github.com/microsoft/vscode) | The editor — the base every surface is built on. |
| <img src="./assets/pi.svg" width="26" alt="Pi" /> | **[Pi](https://pi.dev)** by Mario Zechner | The coding agent: loop, tools, providers, models, packages, skills. |
| <img src="./assets/gentle-ai.png" width="22" alt="Gentle AI" /> | **[Gentle AI](https://github.com/Gentleman-Programming/gentle-ai)** & **[Engram](https://github.com/Gentleman-Programming/engram)** | Persistent memory, curated skills, and the ODD/SDD workflow harness. |

All three are MIT-licensed. Full attribution is preserved in [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md). PiCode is an independent project — it is not an official distribution of VSCodium, Pi or Gentle AI.

## The pin

The source tree descends from one recorded VS Code commit:

| Pin | Points to | Why it matters |
| --- | --- | --- |
| **`upstream/stable.json`** | The exact VS Code commit (`1.135.0`, `08d4889f`) | The base `picode-source/` was made from. A newer VS Code is brought in as a merge, not a re-download: `docs/howto-build.md` holds the plan. |

There is no CI watching upstream (the workflows were removed — see [Continuous
integration](#continuous-integration)); new VS Code versions are noticed and merged by hand.

## What exists today

- **Chat panel** — streaming with tools, reasoning blocks, session management, slash commands, and attachments (images, files, video frames, audio transcription).
- **Providers** — sign in with a key or OAuth subscription, or declare a compatible endpoint with its own models. Provider rows live under `Settings → PiCode → Providers`.
- **Themes** — gallery with real previews, install-and-apply from palette or settings.
- **First-run wizard** — choose the runtime, connect a provider, install Gentle AI, pick a theme. All inside the editor — no terminal step.
- **Pi inside PiCode** — the managed runtime installs on demand (~410 MB) and is updated from the editor. A Pi profile in PiCode's own `data/` folder, isolated from the machine.
- **Gentle AI** — memory, skills, subagents. Its agents appear in the editor because the host discovers them on disk.
- **MCP bridged into Pi** — editor MCP tools handed to Pi as custom tools, so editor permissions and confirmations apply. No second MCP UI.
- **Packages** — search and manage Pi packages (npm registry keyword `pi-package`) and editor extensions (Open VSX gallery).
- **Status & usage** — version, providers, sessions, tokens and cost.

## What is in this repository

One clone has everything. The editor's payload is still not in git — GitHub rejects files over
100 MB and the built executable alone is 212 MB — but that is only the *output*: the source that
produces it is versioned here.

| Path | What it is |
| --- | --- |
| **`picode-source/`** | **PiCode's own source** — the editor's code with the PiCode changes and identity applied (13,125 files; VS Code 1.135.0 descends recorded in `upstream/stable.json`). This is where product work happens. |
| `distribution/` | The product layer as data: product delta (the single home of the identity and version), settings, icons, and the apply script for the prebuilt-archive route. |
| `dev/` | The build engine — bash scripts, the build window, progress viewer. |
| `builder/` | The C#/WinUI 3 front-end that drives the same pipeline with one button. |
| `upstream/` | The pin file (`stable.json`) — the VS Code commit the tree descends from. |
| `wiki/` | The public wiki, page by page — import source for the GitHub Pages wiki. |
| `docs/` | Internal papers: architecture, decisions, distribution, how-to-build. Index: [`docs/README.md`](docs/README.md). |
| `odd/tasks/` | The ODD feature records — every non-trivial change left a record with decisions, checks and defects. |
| `AGENTS.md` | The owner's own words, verbatim. Read it before changing product behaviour. |

The old VSCodium-style machinery — `patches/**`, the fetch scripts, the VSCodium pin — was
**deleted on 2026-09-27** by the owner's decision. Its changes live in `picode-source/` as code.

## The source build

The source path is the canonical build. Releases are built with it: a real `PiCode.exe` (or
Linux equivalent) compiled from `picode-source/`, with the product delta applied to the tree
*before* compilation. That lifts the limit the binary path carries: the `checksums` map over the
minified bundle makes core changes unavailable on the ZIP-over-archive route.

The chain, five phases:

```text
prepare (tree + identity + deps) → connector → compile → pack → stage
```

A full build in steady state takes about **three and a half minutes** on a 16-core Windows
machine (the dependencies are installed once, not every build), and seeing a code change in
the running editor takes **seconds** without packaging anything — see
[dev/README.md](dev/README.md#development-loop). For the fast correctness check — the source
and the identity, nothing installed or compiled:

```bash
./dev/build.sh -o
```

The recommended way to build is through the **builder** — a C# desktop app in `builder/` that presses the same buttons as the manual chain. It needs only the .NET SDK.

Full dependency list, per-OS details, and troubleshooting in [Contributing docs](CONTRIBUTING.md) and [howto-build](docs/howto-build.md). (`jq` is not needed by anything any more.)

## Continuous integration

There is no CI: during the active development stage the Actions minutes bill
faster than they are worth, so the workflows were removed (they live in git
history if they ever come back). Releases are built locally and published by
hand — the process, the packaging tasks and the known build traps are
documented in [docs/CI.md](docs/CI.md).

## Where the reasoning lives

Every non-trivial change is worked as an ODD feature and leaves a record in `odd/tasks/`: what was asked, what was verified, what was deliberately *not* built, the defects found (including the ones found by an independent verification pass) — and the commits that carry them. Start there when a decision looks arbitrary; it usually is not, and the reason is written down.

## License

MIT — see [LICENSE](LICENSE). See also [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) for full upstream attribution.

<br />
<div align="center">

Made by [Tomás Platero](https://tomasplatero.com) · built on [VSCodium](https://github.com/VSCodium/vscodium), [Pi](https://pi.dev) and [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai)

</div>