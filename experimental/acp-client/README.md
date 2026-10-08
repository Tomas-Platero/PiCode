# acp-client — the proof client for the durable agent's ACP endpoint

A deliberately small ACP **client** that proves `experimental/durable` speaks the Agent
Client Protocol (v1) over stdio (`node cli.js acp`). It speaks **raw JSON-RPC** on the wire
— it does not import `@agentclientprotocol/sdk` — so an SDK-to-SDK match proves nothing:
this is an independent check against the same wire protocol Zed speaks.

Start the daemon first (the ACP endpoint is a daemon client, never a second owner of the
storage), then run one of the three proofs:

```bash
cd experimental/durable
node cli.js serve          # terminal 1 (or: bash proof-acp.sh does all of this itself)

node ../acp-client/client.js flow          # 1. handshake → session/new → streamed prompt → final answer
node ../acp-client/client.js cancel        # 2. a 20 s tool call, cancelled mid-flight → stopReason "cancelled"
node ../acp-client/client.js permission    # 3. the guard asks the client: reject blocks, allow executes
```

Or all three with their own daemon in one command:

```bash
cd experimental/durable && bash proof-acp.sh   # ends PROOF-ACP-OK
```

`flow` takes an optional prompt argument. Every proof spawns its own `node cli.js acp`
endpoint, prints the streamed updates and the protocol answers, and shuts the endpoint
down. Detailed protocol-level output goes to stderr; the streamed answer and the final
`[stopReason]` line go to stdout.
