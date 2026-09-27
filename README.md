<!-- markdownlint-disable MD033 -->
<div align="center">

<img src="./assets/picode-banner.png" alt="PiCode — the best AI for coding, powered by Pi" width="100%" />

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-3B9BFF?style=flat-square)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-1E1E1E?style=flat-square&logo=windows&logoColor=3B9BFF)](#what-exists-today)
[![Built on VSCodium](https://img.shields.io/badge/Built%20on-VSCodium-1E1E1E?style=flat-square)](https://github.com/VSCodium/vscodium)
[![Powered by Pi](https://img.shields.io/badge/Powered%20by-Pi-3B9BFF?style=flat-square)](https://pi.dev)
[![Gentle AI](https://img.shields.io/badge/Memory%20%26%20Workflow-Gentle%20AI-3B9BFF?style=flat-square)](https://github.com/Gentleman-Programming/gentle-ai)
[![Pin check](https://github.com/TomasPlatero/PiCode/actions/workflows/pin-check.yml/badge.svg?style=flat-square)](https://github.com/TomasPlatero/PiCode/actions/workflows/pin-check.yml)
[![Full build](https://github.com/TomasPlatero/PiCode/actions/workflows/full-build.yml/badge.svg?style=flat-square)](https://github.com/TomasPlatero/PiCode/actions/workflows/full-build.yml)

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

A stock VSCodium tree branded and patched so that opening it means opening a working agentic environment:

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

## The two pins

Every build is reproducible from two pins:

| Pin | Points to | Why it matters |
| --- | --- | --- |
| **`upstream/stable.json`** | The exact VS Code commit (`1.135.0`) | The source that gets patched and compiled. |
| **`upstream/vscodium.json`** | The VSCodium revision whose patches are vendored verbatim (`1.135.06055`) | `patches/vscodium/` mirrors this exactly. Both pins move together. |

A weekly guardian workflow ([`pin-watch.yml`](.github/workflows/pin-watch.yml)) checks upstream and opens a labelled PR whenever a new version lands — security advisories are flagged with CVEs and severity.

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

The repo root is the distribution root (portable mode). The ~1 GB editor payload is **not in git** — GitHub rejects files over 100 MB and the executable alone is 212 MB. What is versioned is the layer that turns a stock archive into PiCode:

| Path | What it is |
| --- | --- |
| `patches/vscodium/` | 75 files verbatim from upstream VSCodium — telemetry removal, branding, Copilot hooks, cloud. |
| `patches/picode/` | 23+ numbered patches — the welcome page, wizard, connector, agent host, source changes. |
| `distribution/` | The modification layer as data: product delta, settings, icons, apply scripts. |
| `dev/` | The build engine — bash scripts, CI helpers, build window, progress viewer. |
| `builder/` | The C#/WinUI 3 front-end that drives the same pipeline with one button. |
| `upstream/` | The two pin files (`stable.json`, `vscodium.json`). |
| `wiki/` | The public wiki, page by page — import source for the GitHub Pages wiki. |
| `docs/` | Internal papers: architecture, decisions, distribution, how-to-build. Index: [`docs/README.md`](docs/README.md). |
| `odd/tasks/` | The ODD feature records — every non-trivial change left a record with decisions, checks and defects. |
| `AGENTS.md` | The owner's own words, verbatim. Read it before changing product behaviour. |

## The source build

The source path is the canonical build — releases and CI use it. It compiles a real `PiCode.exe` (or Linux equivalent) from the pinned VS Code source plus the patch set, with the product layer applied *before* compilation. That lifts the limit the binary path carries: the `checksums` map over the minified bundle makes core changes unavailable on the ZIP-over-archive route.

The chain, eight phases:

```text
VS Code (pinned) → patches/vscodium/ → patches/picode/ → product.json → npm ci → gulp → PiCode-Win32-x64/ → stage
```

A full build takes 20–45 minutes. For the fast correctness check (fetch, patches, product delta — no compile):

```bash
./dev/build.sh -o
```

The recommended way to build is through the **builder** — a C# desktop app in `builder/` that presses the same buttons as the manual chain. It needs only the .NET SDK.

Full dependency list, per-OS details, and troubleshooting in [Contributing docs](CONTRIBUTING.md) and [howto-build](docs/howto-build.md).

## Continuous integration

CI guards the source build. Three workflows, one guard each:

| Workflow | When | What |
| --- | --- | --- |
| **[Pin check](.github/workflows/pin-check.yml)** | Every push / PR | Phases 1–5 on Linux and Windows. Goes red if a patch stops applying. |
| **[Full build](.github/workflows/full-build.yml)** | Nightly, pin change, `v*` tag | Real compile on Linux and Windows. A tag produces a GitHub Release with portables and installers. |
| **[Pin watch](.github/workflows/pin-watch.yml)** | Weekly | Checks latest VS Code and its security advisories. Opens a labelled PR with the new pin. |

The two badges at the top of this file are live.

## Where the reasoning lives

Every non-trivial change is worked as an ODD feature and leaves a record in `odd/tasks/`: what was asked, what was verified, what was deliberately *not* built, the defects found (including the ones found by an independent verification pass) — and the commits that carry them. Start there when a decision looks arbitrary; it usually is not, and the reason is written down.

## License

MIT — see [LICENSE](LICENSE). See also [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) for full upstream attribution.

<br />
<div align="center">

Made by [Tomás Platero](https://tomasplatero.com) · built on [VSCodium](https://github.com/VSCodium/vscodium), [Pi](https://pi.dev) and [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai)

</div>