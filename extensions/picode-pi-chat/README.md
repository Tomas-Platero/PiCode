# PiCode: pi Agent

The agent layer of PiCode. It spawns the [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding agent in RPC mode (`pi --mode rpc`) as a child process and renders a
streaming chat panel inside the editor.

The extension host owns the process; the webview is presentation only. stdout is
framed as strict LF-delimited JSONL (Unicode line separators are legal inside
JSON strings, so `readline` is not protocol compliant), commands are correlated
by id, and `message_update` deltas are accumulated by `contentIndex` with
`message_end` treated as the authoritative message.

## Requirements

- The `pi` CLI on `PATH` (`npm install -g @earendil-works/pi-coding-agent`),
  or an explicit path via `picode.pi.executablePath`.
- pi 0.86.1 or newer (the RPC protocol used here was verified against 0.86.1).

## Commands

| Command | Purpose |
| --- | --- |
| `PiCode: Open pi Chat` | Start the agent if needed and reveal the chat panel |
| `PiCode: New pi Session` | Start a fresh session in the running agent |
| `PiCode: Abort pi Run` | Stop the current run |
| `PiCode: Restart pi Process` | Kill and respawn the agent (also re-reads settings) |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `picode.pi.executablePath` | `pi` | Path to the pi CLI. On Windows a bare name resolves to the npm `.cmd` shim, which is launched through the system shell. |
| `picode.pi.extraArgs` | `[]` | Extra arguments appended to `pi --mode rpc`. |

Diagnostics are written to the **PiCode** output channel.

## Development

```bash
npm install
npm run compile
```

There are no runtime dependencies and no bundler: plain `tsc` emits `out/`, and
`media/main.js` + `media/main.css` are loaded directly by the webview.
