# PiCode Wiki

**A VSCodium distribution built from source, with the Pi coding agent and Gentle
AI inside the editor core — not as something you install afterwards.**

PiCode is free and complete: no feature is held back, and nothing it does needs
a server. Opening it means opening a working agentic environment: `@pi` in the
editor's own chat, providers connected from settings, memory and skills
already there. No setup ceremony, no Copilot anywhere.

> This wiki is maintained in the repository under `wiki/`. It is the public
> synthesis; the internal papers under `docs/` and the feature records under
> `odd/tasks/` remain the sources it is written from.

## Where to go

| You are… | Read |
| --- | --- |
| evaluating whether to use it | [What PiCode Is](What-PiCode-Is.md) |
| installing it | [Getting PiCode](Getting-PiCode.md) |
| going from first launch to a working agent | [First Run and the Wizard](First-Run-and-the-Wizard.md) |
| connecting models or providers | [Pi Inside — Providers](Pi-Inside.md) |
| curious how it is assembled | [Architecture](Architecture.md) |
| contributing to the distribution | [Building PiCode](Building-PiCode.md) |
| touching editor behaviour | [The Patch System](The-Patch-System.md) |
| wondering why a decision looks odd | [Decisions Log](Decisions-Log.md) |
| hitting a build/CI failure | [CI and Releases](CI-and-Releases.md) |
| looking for a term (host, harness, pin, delta…) | [Glossary](Glossary.md) |
| wanting to know what is real today vs planned | [Roadmap and Known State](Roadmap-and-Known-State.md) |

## The three projects it stands on

| Project | What it brings |
| --- | --- |
| [VSCodium](https://github.com/VSCodium/vscodium) / [VS Code](https://github.com/microsoft/vscode) | The editor itself — MIT source, no Microsoft branding |
| [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`) | The coding agent: loop, tools, providers, models, packages, skills |
| [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) + [Engram](https://github.com/Gentleman-Programming/engram) | Persistent memory, curated skills, and the ODD/SDD workflow harness |

All three are MIT-licensed. See [Distribution and Licensing](Distribution-and-Licensing.md).

## Quick facts

- **Current release:** `v0.1.2` — Windows portable + installer, Linux portable +
  `.deb`/`.rpm`, all with `SHA256SUMS.txt`.
- **Built on:** VS Code `1.135.0` (pinned), VSCodium patches `1.135.06055`,
  Pi `0.87.1` (pinned).
- **Platforms:** Windows x64 (primary), Linux x64. macOS refuses with an
  explicit message.
- **License:** MIT. The product speaks English; other languages come through
  language packs.
