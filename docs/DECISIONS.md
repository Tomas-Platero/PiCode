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

## ADR-008 — Layer on VSCodium without compiling a fork

**Status:** accepted; **partially superseded by ADR-011** (the prohibition on
touching VSCodium's files no longer holds now that PiCode owns the tree).

**Context:** VSCodium's user-product patch makes product-level rebranding
possible without a build: it loads a user-level `product.json` and deep-merges it
into the product configuration at startup. The alternative, a fork build, was
costed and measured. VSCodium trails upstream — the newest release tag was
`1.135.06055` against VS Code `1.138.0`, three minor versions behind — and it
rebases a patch series against upstream for every release. The build
toolchain is also absent on this machine: Python 3.11 is missing (only 3.14.7 is
present), `rustup` and `jq` are missing, the local Node is `24.19.0` against
VSCodium's pinned `24.18.0`, and the MSVC build tools are effectively absent
despite empty installer directories. A fork build also needs tens of gigabytes
and a 30-90 minute cycle per iteration, which contradicts the lightweight
objective.

**Decision:** PiCode layers branding, configuration, the agent runtime and the
editor extension on top of a stock VSCodium install. It does not compile a fork
and it does not carry a copy of the editor core.

The fork path is **deferred, not rejected**. It becomes worth revisiting when any
of these trigger conditions holds:

- a required product key is read before the overlay merge, or otherwise lies
  outside `product.json`'s runtime reach;
- the product must ship with PiCode OS-level identity (installer, Start Menu,
  protocol handler, file associations);
- VSCodium drops or regresses the user-product patch the strategy depends on;
- the version lag against upstream becomes product-blocking.

**Consequences:** Iteration stays fast and needs no build toolchain, and upgrades
arrive as VSCodium releases instead of a merge of two diverging trees. The
trade-offs accepted: the binary and OS-level identity remain VSCodium's, so
PiCode is a configuration and integration brand rather than a binary brand; and
the strategy depends on a patch that exists in VSCodium but not in stock VS Code.
If that patch disappears, the branding layer disappears with it, and the fork
path stops being an escape hatch and becomes the only option.

## ADR-009 — The pi panel is opt-in, never auto-opened

**Status:** accepted.

**Context:** PiCode is agent-first, but it is still an editor, and an editor's
primary surface is the file being edited. A panel that opens itself on startup
steals focus, consumes layout, and makes the first interaction of every session
something the user did not ask for. It also makes launch behaviour unpredictable:
the editor would look different depending on whether the agent was reachable.

The extension already satisfies this. Its manifest declares
`activationEvents: []` and contributes commands, so nothing activates the
extension at startup; the panel is created only when the user runs an explicit
command, such as **PiCode: Open pi Chat**. This is a verified property of the
shipped manifest, not a plan.

**Decision:** The pi panel is opt-in. It opens only in response to an explicit
user command and is never auto-opened on startup.

**Consequences:** Startup is predictable and non-intrusive, and the agent cannot
hijack the editor's first moments. The trade-off accepted: the panel is less
discoverable, and a user who does not know the command exists may not find the
feature. A first-run invitation — a one-time, dismissible prompt that points at
the command without opening the panel — is recorded as future work; it is not
part of this decision and is not implemented.

## ADR-010 — Pin and ship pi and gentle-pi rather than using the user's PATH

**Status:** accepted.

**Context:** If PiCode ran whatever `pi` it found on `PATH`, every user would run
a different agent version, with a different RPC surface, a different model
catalog and different tool behaviour. That is not reproducible, and it makes
support and verification impossible: a bug report would describe PiCode plus an
unknown agent version. The project has already seen the RPC surface change
between pi releases (ADR-007 records a corrected assumption that came directly
from the agent's own schema). Reusing the user's installation also means PiCode
silently inherits whatever extensions and settings that user has accumulated.

PiCode therefore pins the runtime it is verified against: pi `0.86.1` and
gentle-pi `3.3.0`. Neither pin requires toolchains the user does not have — pi
requires Node `22.19.0` or newer, and the `gentle-ai` CLI is a Go binary bundled
inside the gentle-pi package, so no Go installation is needed.

**Decision:** PiCode pins and ships its own pi and gentle-pi, and installs them
through their own supported mechanisms (`npm install -g` for pi, `pi install` for
gentle-pi), instead of resolving them from the user's `PATH`.

The pin is not a lock-in: the extension setting `picode.pi.executablePath` lets a
user point PiCode at a different pi binary.

**Consequences:** Every PiCode install behaves the same way, verification is
meaningful because the agent version is known, and PiCode's extension and pi
cannot drift apart silently. The trade-off accepted: PiCode now owns pi's release
tracking. A new pi release can break the integration, so PiCode must test and
bump the pin deliberately rather than inheriting updates. On the other side, a
user who wants a newer pi is not blocked, because the executable path is a
setting.

## ADR-011 — Own the editor tree and remove product keys instead of overriding them

**Status:** accepted. Supersedes ADR-008 in part.

**Context:** ADR-008 chose the no-compile path: brand a separately installed
VSCodium through a user-level `%APPDATA%\VSCodium\product.json` overlay. That
path has a ceiling, and the foundation's own `DISTRIBUTION.md` documented it: the
overlay is merged as `merge(product, userProduct)`, which can overwrite a key but
never delete one. Copilot was therefore inextirpable by that route; it could only
be restated. The same document recorded the limitation in one line — "An overlay
also cannot *delete* a built-in key: it can only override it. There is no \"unset\"
operation in this merge."

The VSCodium archive is now extracted at the repository root, so PiCode owns the
tree: `resources/app/product.json` is editable, `resources/app/extensions` is the
built-in extension scan path, and a `data/` folder beside the executable switches
the build to portable mode.

**Decision:** PiCode owns its editor tree. The product is modified in place
through a data delta (`distribution/product-delta.json`) applied by a Node
program, and the agent panel ships as a built-in extension. The distribution
remains uncompiled: no fork, no yarn and Electron build, no patch rebasing
against upstream.

**Consequences:**

- Keys can be deleted, not merely overridden, which is what makes the Copilot
  removal real rather than cosmetic.
- The tree is a build artefact and is not versioned. What is versioned is the
  delta, the applier, the defaults and the extension; `.gitignore` fences the
  700 MB payload.
- Upgrading becomes "extract a new archive, re-run the apply script" rather than
  an in-place update. `updateUrl` is emptied for that reason: the in-product
  updater pointed at VSCodium releases and would have replaced the patched tree
  and silently dropped the brand. Observed in the running editor as
  `update#ctor - updates are disabled as there is no update URL`.
- The edit surface is product configuration and the shipped file set. Anything
  compiled into the bundle stays untouchable.

**Two limits are now explicit rather than assumed:**

1. **A residual Copilot default survives in minified core.** The bundle carries a
   hardcoded base product (the `code-oss` defaults) that still declares
   `defaultChatAgent: { extensionId: "GitHub.copilot", chatExtensionId:
   "GitHub.copilot-chat" }`. Deleting the product key removes the fourteen
   configured `api.github.com` and `aka.ms` endpoints, but not that fallback.
   `chat.disableAIFeatures` is the effective switch for the surface.
2. **Key shape is part of the contract.** `builtInExtensionsEnabledWithAutoUpdates`
   is iterated without a guard by the extension service, so it must be an empty
   array rather than absent. This was not visible in review: the delta was valid
   JSON, and only running the built tree produced
   `t.builtInExtensionsEnabledWithAutoUpdates is not iterable`.

**Rejected alternatives:**

- Replacing `defaultChatAgent` with a PiCode-shaped object — the entitlement,
  quota and provider machinery assumes Copilot's flow, so a substituted object
  would be invented wiring that never connects to anything.
- Patching the minified bundle to remove the chat contribution entirely — this is
  the fork path's cost arriving through the back door, and the foundation already
  costed it (missing Python 3.11, rustup and `jq`, plus an MSVC toolchain that is
  effectively absent).

**Reversal trigger:** this decision stops paying for itself if VSCodium's archive
layout moves the product file or the built-in extension scan path, or if a
required change falls inside minified core. At that point ADR-008's deferred fork
build becomes the only route, and its toolchain blockers must be revisited.
