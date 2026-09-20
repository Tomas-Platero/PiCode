# PiCode

> A lightweight, rebranded VS Code distribution with the **pi** coding agent and
> **Gentle AI (gentle-pi)** integrated as first-class experiences.

PiCode is not a generic AI plugin for VS Code. It is a curated distribution:
the editor, the default settings, the extension gallery and the agent panel are
assembled together so that opening PiCode means opening a working agentic
development environment — no setup ceremony.

## Status

Early foundation. The repository currently contains:

- the architecture and decision records (`docs/`),
- the `picode-pi-chat` extension: a VS Code panel that drives the pi agent
  over its native RPC protocol,
- the ODD task record at `odd/tasks/picode-foundation.md`.

The VSCodium distribution layer (branding, built-in extensions, installer) is
specified in `docs/DISTRIBUTION.md` and is the next milestone.

## Repository layout

```text
PiCode/
├── docs/                 Architecture, decisions, distribution strategy
├── extensions/
│   └── picode-pi-chat/   VS Code extension: pi agent panel
├── odd/tasks/            Organic Driven Development task records
└── README.md
```

## The integration surface

PiCode integrates pi through the protocol pi already provides for exactly this
purpose. Verified against pi `0.86.1`:

| Mode | Command | Use in PiCode |
| --- | --- | --- |
| RPC | `pi --mode rpc` | The chat panel: bidirectional JSONL over stdin/stdout |
| JSON stream | `pi --mode json "<prompt>"` | One-shot automation, CI, task runner |
| Print | `pi -p "<prompt>"` | Non-interactive scripted runs |

The extension spawns `pi --mode rpc` inside the workspace folder and consumes
typed events (`message_update` deltas, `tool_execution_*`, `agent_settled`).
No protocol is invented here: see `docs/rpc.md` in the pi package.

## Requirements

- **Node.js** 22.19+ — this is pi's own requirement, not a preference
  (developed against 24.x)
- **pi** on `PATH` (`npm install -g @earendil-works/pi-coding-agent`)
- **VS Code** 1.90+ or VSCodium for development; PiCode itself will bundle the editor

## Developing the extension

```bash
cd extensions/picode-pi-chat
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host, and run
**PiCode: Open pi Chat** from the command palette.

## License

MIT — see [LICENSE](LICENSE).

PiCode is a distribution of VSCodium, which is a build of the MIT-licensed
VS Code source. Upstream licenses and attribution are preserved and documented
in `docs/DISTRIBUTION.md`.
