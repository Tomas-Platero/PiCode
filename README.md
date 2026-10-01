<!-- markdownlint-disable MD033 MD041 -->
<div align="center">

<img src="./assets/picode-banner.png" alt="PiCode — Agentic Code Editor" width="100%" />

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-3B9BFF?style=flat-square)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-1E1E1E?style=flat-square&logo=windows&logoColor=3B9BFF)](#download)
[![Built on VSCodium](https://img.shields.io/badge/Built%20on-VSCodium-1E1E1E?style=flat-square)](#credits)

</div>

<br />

> **An agentic code editor with its own AI inside — not an assistant you install afterwards.**
>
> Open it, sign in, and the agent already knows your providers, your memory and your skills. No setup ceremony, no Copilot.

<br />

**PiCode is free and complete.** No feature is held back. The editor is 100% open-source and works fully offline with your own provider keys.

| 👤 Just want to use it | 👨‍💻 Want to build or contribute |
| --- | --- |
| [Download a release](https://github.com/Tomas-Platero/PiCode/releases) · unzip · run `PiCode.exe` · [getpicode.app](https://www.getpicode.app) | [Source build guide](#building-from-source) · [Contributing docs](CONTRIBUTING.md) · [How to compile](docs/howto-build.md) |

<br />

## What you get

| | |
| --- | --- |
| **AI chat, built in** | An agentic assistant that lives in the editor: streaming answers, tools, reasoning, your project's context. It reads your code, edits files, runs commands — and asks before it does. |
| **Your AI providers** | Connect with an API key or an OAuth subscription (ChatGPT, Claude, Copilot, Grok, Kimi, Meta, OpenRouter…), or declare a compatible endpoint with your own base URL. Pick the model per conversation. |
| **Sessions** | Every conversation is kept per project. Search them, reopen them, read any transcript. |
| **Themes** | A gallery with live previews rendered from each theme's own colours — hover to try, click to keep. Install more from the gallery. |
| **PiCode Account** | Sign in and your settings, extensions, AI configuration and your agent's memory follow you to any machine — encrypted in transit and at rest. |
| **Gentle AI** | The workflow layer: persistent memory, curated skills and subagents, installed with one click. |

## PiCode Account

Create a free account and PiCode keeps your editor the same everywhere:

- **Settings, extensions and AI configuration** — synced and encrypted.
- **Your agent's memory and skills** — the setup that took hours, kept.
- **Last week of conversations** — always with you, a rolling window that cleans itself.
- **Three ways in** — email, Google or GitHub.

The free plan covers the essentials. **Pro** raises the ceiling for heavy use — see [plans](https://www.getpicode.app/pricing).

## Download

Grab the latest release from [GitHub Releases](https://github.com/Tomas-Platero/PiCode/releases), unzip, run `PiCode.exe`. Windows today; Linux follows the same path.

## Building from source

One clone has everything — the editor's source is versioned here, with the product identity already applied. The build is a five-phase chain that finishes in minutes on a steady state:

```text
prepare → connector → compile → pack → stage
```

```bash
./dev/build.sh          # full build, dependencies installed once
./dev/build.sh -o       # fast correctness check — nothing installed or compiled
```

Prefer buttons? The **builder** in [`builder/`](builder) is a small desktop app that drives the same pipeline. Full dependency list and troubleshooting in the [Contributing docs](CONTRIBUTING.md) and [howto-build](docs/howto-build.md).

## Credits

PiCode stands on open source: [VSCodium](https://github.com/VSCodium/vscodium) / [VS Code — MIT source](https://github.com/microsoft/vscode) for the editor, the [Pi](https://pi.dev) coding agent for the agentic loop, and [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) with [Engram](https://github.com/Gentleman-Programming/engram) for memory and workflow. Full attribution in [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md). PiCode is an independent project.

<br />
<div align="center">

Made by [Tomás Platero](https://tomasplatero.com)

</div>
