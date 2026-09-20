# Decisions

Architecture Decision Records for PiCode. Each entry records a decision that
constrains the shape of the distribution or the agent layer, the context that
forced it, and the consequences we accept.

Format: `## ADR-00N — Title`, followed by `Status`, `Context`, `Decision` and
`Consequences`. A `Rejected alternatives` subsection is included where the
alternatives were seriously considered.

## ADR-001 — Distribution layered on VS Code/VSCodium instead of a full fork

**Status:** accepted.

**Context:** The product goal is a lightweight, rebranded VS Code, not a new
editor. A full fork of `microsoft/vscode` requires the upstream build chain
(yarn, native modules, Electron), produces a multi-GB tree, and has a slow build
cycle. It would also be a permanent merge burden against upstream, because every
upstream change would have to be reconciled with our own copy of the core.

**Decision:** PiCode is built as a layered distribution on top of
VS Code/VSCodium. We add branding, configuration and an agent extension, and we
do not carry a fork of the editor core.

**Consequences:** The editor core stays upstream, so upgrades are pulls from
VSCodium rather than a merge of two diverging code bases, and the build is fast
enough to iterate on. The trade-off accepted: we cannot change editor-core
behaviour that upstream does not expose. A requirement that genuinely needs a
core change has to be handled as a patch, and each patch is a permanent
maintenance tax.

**Rejected alternatives:**

- A full `microsoft/vscode` fork — multi-GB tree, slow build cycle, permanent
  upstream reconciliation burden.
- A pure extension pack with no editor branding — no editor-level product
  identity, which is part of the goal.
- Building a new editor on Monaco or CodeMirror — that stops being VS Code and
  is a far larger effort.

## ADR-002 — Use VSCodium as the upstream base

**Status:** accepted.

**Context:** A rebranded distribution has to come from source or from a
source-derived build. The official Microsoft binaries may not be redistributed
with a modified brand, so they cannot be the base for PiCode.

VSCodium is the MIT-licensed community build of the VS Code source. It carries
no Microsoft branding and no telemetry, and it is redistributable under our own
PiCode brand.

**Decision:** VSCodium is the upstream base. PiCode is a rebranded distribution
built on it.

**Consequences:** We inherit a legally clean base that we are allowed to
redistribute under the PiCode brand, with branding and telemetry decisions
already resolved upstream. The trade-off accepted: we depend on VSCodium's
release cadence and build configuration, and we inherit its choices about what
is included in the build.

## ADR-003 — Integrate pi as a child process over `pi --mode rpc`, not via the in-process SDK

**Status:** accepted.

**Context:** pi can be driven two ways from the agent layer: in process through
the SDK (`createAgentSession`), or out of process through `pi --mode rpc`. The
SDK is the right choice for a Node application that owns pi's lifecycle. An
editor extension is a different constraint set: it runs inside an extension host
it does not control, and the agent it drives already owns cwd, file writes and
shell access.

**Decision:** The extension integrates pi as a child process over
`pi --mode rpc`.

Rationale in favour of the child process:

- **Process isolation**: an agent crash cannot take down the extension host.
- **Version independence**: the extension talks to whatever `pi` is on `PATH`
  or configured, not a version frozen at release.
- **Clean process boundary** for an agent that already owns cwd, file writes and
  shell access.
- **Protocol parity**: the same surface serves the CLI and future automation.

**Consequences:** The extension owns process spawn, framing, request/response
correlation and shutdown instead of calling an in-process API. It also needs a
usable `pi` binary at runtime rather than shipping one. The trade-off accepted:
more plumbing in the extension in exchange for isolation, version independence
and a stable boundary.

The in-process SDK remains a valid option for a future embedded mode and is
**not** ruled out permanently.

**Rejected alternatives:**

- In-process SDK — rejected for the current extension because it couples the
  agent's lifecycle and crash domain to the extension host, and freezes the pi
  version at release. See pi documentation `docs/sdk.md`.

## ADR-004 — Windows first, for the MVP

**Status:** accepted.

**Context:** The MVP has to be validated quickly, and the development machine is
Windows.

**Decision:** The MVP targets Windows first. Multi-OS support is a later
concern.

**Consequences:** The development loop can be validated locally before the cost
of multi-OS CI is taken on. The trade-off accepted: path handling, process
spawn behaviour and packaging are validated on one platform only, and macOS and
Linux remain unverified until they are added.

## ADR-005 — Strict LF-only framing in the RPC client (reject `readline`)

**Status:** accepted.

**Context:** The pi RPC protocol uses LF (`\n`) as the only record delimiter.
`U+2028` and `U+2029` are legal inside JSON strings. Node's `readline` also
splits on those code points, so it is not protocol compliant. See pi
documentation `docs/rpc.md`.

**Decision:** The RPC client does not use `readline`. It splits the buffer on
`\n` itself and strips a single trailing `\r`.

**Consequences:** A small amount of hand-written framing code in exchange for
correctness. The trade-off accepted: we own framing, buffering across chunks and
the split of partial records, instead of delegating them to a standard library
module that is wrong for this protocol.

## ADR-006 — The RPC client forwards protocol payloads without re-validating field types

**Status:** accepted.

**Context:** The authoritative schema for RPC payloads lives in pi. After the
discriminant (`type`) is checked, the payload is already declared to be of that
shape. Duplicating field-level validation in the extension would drift from pi
as the protocol evolves.

**Decision:** After checking the discriminant (`type`), the client treats the
payload as the declared protocol shape and forwards it without re-validating
field types.

**Consequences:** Less code, and no second schema to keep in sync with pi. The
trade-off accepted: the payload is untrusted JSON, so a malformed payload could
reach the UI. That risk is bounded at the rendering boundary: the webview
renders with `textContent` only and never uses `innerHTML` with untrusted
strings.

## ADR-007 — pi requires the model as two separate fields (`provider` + `modelId`), not a single `model` field

**Status:** accepted; **recorded as a corrected assumption**.

**Context:** The initial design assumed `{"type":"set_model","model":"<id>"}`.
The verified pi `0.86.1` schema is `{"provider":"...","modelId":"..."}`. See pi
documentation `docs/rpc.md`.

**Decision:** The client sends the model as the two-field form. It accepts a
convenience `provider/model-id` reference and splits it at the **first** slash,
or takes an explicit provider.

**Consequences:** Callers can pass either an explicit provider or a single
`provider/model-id` string. The trade-off accepted: a literal reading of
`provider/model-id` is unambiguous for every provider id observed, but splitting
is inherently ambiguous if a provider id itself contained a slash. Passing the
provider explicitly always avoids this.

This decision is important because it is a concrete case of a plan being
corrected by evidence rather than by assumption.
