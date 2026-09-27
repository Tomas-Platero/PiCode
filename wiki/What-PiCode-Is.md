# What PiCode Is

PiCode is a **distribution** of the editor, not a plugin for it. It takes the
MIT-licensed VS Code source, builds it the way VSCodium builds it (minus the
Microsoft branding and telemetry), and integrates an agent — [Pi](https://pi.dev)
— as the editor's own chat participant, with [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai)
as the workflow harness on top.

## The one-paragraph version

You download PiCode, open it, and the agentic environment is already there: the
chat in the editor says `@pi`, the model is connected from settings with your
subscription or an API key, your skills and memory live inside the editor's
own profile, and nothing you do touches a Microsoft service. It is portable —
the whole state lives in a `data/` folder beside the executable — and it is
free and complete: the paid part of the plan is cloud sync of that folder,
never a feature lock.

## What makes it different from "VS Code plus an extension"

| | Extension-based setups | PiCode |
| --- | --- | --- |
| The agent surface | a webview panel bolted on | the editor's own Chat, with `@pi` as the default participant |
| The runtime | whatever is on your `PATH`, unpinned | Pi pinned by the distribution, installed and updated from inside the editor |
| Configuration | spread across machine profiles | one PiCode profile (`data/`), self-contained, nothing written outside it |
| Copilot | disabled, still shipping in the bundle | product keys **deleted** from the build, and its strings patched out |
| Updates to the core | you cannot touch them | you compile the core yourself from the pinned source plus auditable patches |

## What it deliberately is not

- **Not a new editor.** Everything not related to the agent stays stock VS Code
  behaviour. PiCode changes identity, removes what it promises to remove, and
  adds the agent layer.
- **Not a fork to maintain.** The core is a pinned upstream commit plus two
  numbered patch sets. When the pin moves, the patches are re-applied — that is
  the whole merge story ([why](Decisions-Log.md#adr-001)).
- **Not a reimplementation of Pi or Gentle AI.** Provider OAuth, the model
  catalog, skills, memory — Pi and Gentle AI already ship them. The work is
  *showing* them inside the editor surfaces, and that rule is enforced
  ([why](Decisions-Log.md)).
- **Not a cloud product.** It works fully offline against your own provider
  keys. Cloud profile sync is a planned paid service; the local product will
  not be trimmed to sell it.

## Vocabulary you will meet

- **Host** — the agent that executes: Pi. PiCode has an internal one and can
  optionally connect to an external one.
- **Harness** — the layer that organizes work above the host: Gentle AI.
- **Pin** — the exact upstream commit/version PiCode is built and verified
  against.
- **Delta** — the JSON file that describes every change to the product
  (`distribution/product-delta.json`).

Full list: [Glossary](Glossary.md).

---
Next: [Getting PiCode](Getting-PiCode.md) · [Architecture](Architecture.md)
