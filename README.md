<!-- markdownlint-disable MD033 MD041 -->
<div align="center">

<img src="./assets/picode-banner.png" alt="PiCode — Agentic Code Editor" width="100%" />

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-3B9BFF?style=flat-square&logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![PiCode](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FTomas-Platero%2FPiCode%2Fmaster%2Fdistribution%2Fproduct-delta.json&query=%24.set.picodeVersion&label=PiCode&color=3B9BFF&style=flat-square)](./odd/tasks/picode-versionado.md)
[![Status: beta](https://img.shields.io/badge/status-beta-FFB000?style=flat-square)](./CHANGELOG.md)

[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-1E1E1E?style=flat-square&logo=windows&logoColor=3B9BFF)](#download)
[![Website](https://img.shields.io/badge/website-getpicode.app-3B9BFF?style=flat-square)](https://www.getpicode.app)
[![Node](https://img.shields.io/badge/node-24.19.0-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./.nvmrc)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](./picode-source/)

[![CI](https://github.com/Tomas-Platero/PiCode/actions/workflows/ci.yml/badge.svg?branch=master)](../../actions/workflows/ci.yml)
[![Last commit](https://img.shields.io/github/last-commit/Tomas-Platero/PiCode?style=flat-square&logo=github&logoColor=white)](../../commits/master)
[![Stars](https://img.shields.io/github/stars/Tomas-Platero/PiCode?style=flat-square&logo=github&logoColor=white)](../../stargazers)
[![Forks](https://img.shields.io/github/forks/Tomas-Platero/PiCode?style=flat-square&logo=github&logoColor=white)](../../forks)
[![Issues](https://img.shields.io/github/issues/Tomas-Platero/PiCode?style=flat-square&logo=github&logoColor=white)](../../issues)
[![Contributors](https://img.shields.io/github/contributors/Tomas-Platero/PiCode?style=flat-square&logo=github&logoColor=white)](../../graphs/contributors)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-3B9BFF?style=flat-square&logo=github&logoColor=white)](CONTRIBUTING.md)
[![Electron](https://img.shields.io/badge/Electron-1E1E1E?style=flat-square&logo=electron&logoColor=9FEAF9)](./picode-source/)

</div>

<br />

> **An agentic code editor with its own AI inside — not an assistant you install afterwards.**
>
> Open it, sign in, and the agent already knows your providers, your memory and your skills. No setup ceremony, no Copilot.

<br />

**PiCode is free and complete.** No feature is held back. The editor is 100% open-source and works fully offline with your own provider keys.

**Version.** PiCode carries its own version — `0.1.0-beta` today, with the minor moving in each release — and is built on a pinned VS Code base, `1.135.0`. The number the editor reports stays the base's, because that is the one extensions are validated against; the version you are offered is PiCode's. Both live in one file, [`distribution/product-delta.json`](./distribution/product-delta.json), and the reasoning is recorded in [`odd/tasks/picode-versionado.md`](./odd/tasks/picode-versionado.md).

| 👤 Just want to use it | 👨‍💻 Want to build or contribute |
| --- | --- |
| [Download a release](https://github.com/Tomas-Platero/PiCode/releases) · unzip · run `PiCode.exe` · [getpicode.app](https://www.getpicode.app) | [Source build guide](#building-from-source) · [Contributing docs](CONTRIBUTING.md) · [How to compile](docs/howto-build.md) |

<br />

## ✨ What you get

| | |
| --- | --- |
| 💬 **AI chat, built in** | An agentic assistant that lives in the editor: streaming answers, tools, reasoning, your project's context. It reads your code, edits files, runs commands — and asks before it does. |
| 🔌 **Your AI providers** | Connect with an API key or an OAuth subscription (ChatGPT, Claude, Copilot, Grok, Kimi, Meta, OpenRouter…), or declare a compatible endpoint with your own base URL. Pick the model per conversation. |
| 🚀 **First-run setup** | Six steps from a fresh install to a working agent: sign in, choose which pi answers (the built-in one or your own), connect a provider, pick the packages, choose a theme. Any of it can be changed later. |
| 🎨 **Themes** | A gallery that shows each theme's real colours, read from the theme itself: hover to try it on, click to keep it. Anything you install is picked from the same page. |
| 🧩 **MCP servers, in one place** | Your agent's external tools live in one screen: add a server, edit it, switch it off or remove it. pi calls them through the editor, so its confirmations and permissions apply — you are asked before one of their tools runs. |
| 📊 **A status panel that tells the truth** | Which pi is answering, its version, your providers, every MCP server and its state, the model and thinking level in use, what the session has cost, the tokens and cache it has used, the plan the agent is working through, your project's branch and changes. |
| 🗂️ **Sessions** | Every conversation is kept per project. Search them, reopen them, read any transcript. |
| ☁️ **PiCode Account** | Sign in and your settings, extensions, AI configuration and your agent's memory follow you to any machine — encrypted in transit and at rest. |
## ☁️ PiCode Account

Create a free account and PiCode keeps your editor the same everywhere:

- **Settings, extensions and AI configuration** — synced and encrypted.
- **Your agent's memory and skills** — the setup that took hours, kept.
- **Last week of conversations** — always with you, a rolling window that cleans itself.
- **Three ways in** — email, Google or GitHub.

The free plan syncs a small allowance — enough for your settings and extensions — and **Pro** is what covers the heavy things: your whole pi profile and its sessions. See [plans](https://www.getpicode.app/pricing).

<a id="download"></a>

## ⬇️ Download

Grab the latest release from [GitHub Releases](https://github.com/Tomas-Platero/PiCode/releases), unzip, run `PiCode.exe`. Windows today; Linux follows the same path.

<a id="building-from-source"></a>

## 🛠️ Building from source

One clone has everything — the editor's source is versioned here, with the product identity already applied. The build is a five-phase chain that finishes in minutes on a steady state:

```text
prepare → connector → compile → pack → stage
```

```bash
./dev/build.sh          # full build, dependencies installed once
./dev/build.sh -o       # fast correctness check — nothing installed or compiled
```

Prefer buttons? The **builder** in [`builder/`](builder) is a small desktop app that drives the same pipeline. Full dependency list and troubleshooting in the [Contributing docs](CONTRIBUTING.md) and [howto-build](docs/howto-build.md).

Releasing is by hand, and the version rule is the one above: a release bumps PiCode's own minor, and moves the editor version too (its patch, or the base when upstream moves) — because the updater compares the editor's number. The tag, the release title and the zip carry PiCode's version. Details in [docs/CI.md](docs/CI.md).

## 🙏 Credits

PiCode stands on open source: [VSCodium](https://github.com/VSCodium/vscodium) / [VS Code — MIT source](https://github.com/microsoft/vscode) for the editor, and the [Pi](https://pi.dev) coding agent for the agentic loop. Full attribution in [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md). PiCode is an independent project.

<br />
<div align="center">

Made by [Tomás Platero](https://tomasplatero.com)

</div>
