# Glossary

Words this project uses with a fixed meaning. When a term is overloaded
upstream, the PiCode sense is the one below.

| Term | Meaning in PiCode |
| --- | --- |
| **Host** | The agent that executes: **Pi**. PiCode ships an internal one; connecting to an external one is optional. Vocabulary fixed by the owner. |
| **Harness** | The layer organizing work above the host: **Gentle AI** (`gentle-pi` package + `gentle-ai` Go CLI). Also internal by default. |
| **Pin** | The exact upstream version a build is verified against. Two: `upstream/stable.json` (VS Code commit) and `upstream/vscodium.json` (whose patches are vendored). They move together. |
| **Product delta** | `distribution/product-delta.json` — the only source of PiCode's product identity: `set`, `unset`, `unsetNested`, `unsetArrayEntries`. Data, applied by a script. |
| **Patch set** | `patches/vscodium/**` (inherited, verbatim, never hand-edited) and `patches/picode/**` (ours, numbered, TypeScript-level changes). |
| **Portable profile** | The `data/` folder beside the executable: user data, extensions, tmp, and the Pi profile. Disposable; the future cloud-sync unit. |
| **Connector** | The built-in core extension `extensions/picode` (produced by patch 12): provider catalog, models, keys, profile plumbing. Draws no UI — that is the rule. |
| **Agent host** | The core process slot (`src/vs/platform/agentHost/`) where VS Code puts its agents; Pi enters it as an `IAgent` provider. |
| **RPC mode** | `pi --mode rpc`: JSONL over stdio, **LF-only framing**, delta events assembled client-side, usage per message not total. |
| **Managed runtime** | Pi installed by PiCode into `resources/pi-runtime`, pinned version, invoked as `node …/cli.js` (no `.cmd` shim — CVE-2024-27980 hardening). |
| **ODD** | Organic Driven Development — Gentle AI's default workflow: authorize, explore, resolve uncertainty, classify, track, implement task by task, close. **SDD is a branch inside ODD**, entered by explicit request. |
| **SDD / OpenSpec** | The spec-driven branch: proposal → spec → design → tasks → apply → verify → archive, with phase artifacts and agents. |
| **Engram** | Gentle's persistent-memory companion package (`gentle-engram`, `mem_*` tools). Not built into PiCode; a Pi package like any other. |
| **Skills / Subagents / Prompt templates** | Pi's extension formats: `SKILL.md` folders, `.md` agent files, `prompts/*.md` (filename becomes `/command`). Discovered from profile and package paths. |
| **Work unit** | One reviewable change: a commit or PR slice a human can hold in their head. The unit of both git and review discipline. |
| **RDD / receipt** | Receipt-Driven Development: Gentle AI's review lifecycle (frozen candidate, lineage, capture, acknowledgement). Its switch belongs to the user; PiCode exposes state, invents no policy. |
| **Open VSX** | The extension gallery this editor may install from; the Microsoft Marketplace is not licensed for third-party builds. |
| **Legacy panel** | `extensions/picode-pi-chat` — the retired webview surface, quarantined until its core migration finishes. |
| **`picode-source/`** | The fetched VS Code tree at the pin — a build output, gitignored; **never** committed. |

Related: [What PiCode Is](What-PiCode-Is.md) · [The Patch System](The-Patch-System.md)
· [Decisions Log](Decisions-Log.md)
