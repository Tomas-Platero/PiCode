# Decisions

Architecture Decision Records for PiCode. Each entry records a decision that
constrains the shape of the distribution or the agent layer, the context that
forced it, and the consequences we accept.

Format: `## ADR-00N — Title`, followed by `Status`, `Context`, `Decision` and
`Consequences`. A `Rejected alternatives` subsection is included where the
alternatives were seriously considered.

## Status at a glance

| ADR | Title | Status |
| --- | --- | --- |
| 001 | Distribution layered on VS Code/VSCodium instead of a full fork | accepted |
| 002 | Use VSCodium as the upstream base | accepted |
| 003 | Integrate pi over `pi --mode rpc` | **superseded by ADR-014** |
| 004 | Windows first, for the MVP | accepted |
| 005 | Strict LF-only framing in the RPC client | **superseded by ADR-014** |
| 006 | RPC payloads forwarded without re-validation | **superseded by ADR-014** |
| 007 | `set_model` needs `provider` + `modelId` | accepted |
| 008 | Layer on VSCodium without compiling a fork | **superseded by ADR-011 and ADR-013** |
| 009 | The pi panel is opt-in, never auto-opened | **superseded** — the panel was retired; the principle lives on |
| 010 | Pin and ship pi rather than using the user's PATH | accepted (details updated) |
| 011 | Own the editor tree and remove product keys | accepted; mechanics **superseded by ADR-013** |
| 012 | The product's own copy is English | accepted |
| 013 | Own and compile the editor source in-repository | accepted |
| 014 | Integrate pi through its in-process SDK | accepted |
| 015 | Three release channels, one branch each | accepted |
| 016 | The declared product version may lead the tree's base | accepted |
| 017 | Cloud sync is a Pro feature; the free plan is an account, not storage | accepted |
| 018 | Durable is the chat; Local retires from the pickers (the harness reads "PiCode") | superseded by 020, 030 |
| 019 | The editor's context travels with every chat turn, durable included | accepted |
| 020 | The chat is pi; durable is the backend it reaches through tools | superseded by 030 |
| 021 | One orchestrator (pi), one list, sessions always durable | superseded by 030 |
| 030 | Durable leaves the product; pi's own transcripts are the conversations | accepted |
| 031 | gentle-pi and gentle-engram enter as pinned packages of the product | accepted |
| 032 | The Tasks block draws gentle-pi's subagents from the push it already makes | accepted |

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

**Status:** accepted; **superseded by ADR-014** — the connector now drives pi through its
in-process SDK. Kept because it is the record of why the boundary moved.

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

**Status:** accepted; **superseded by ADR-014** — there is no RPC client any more.

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

**Status:** accepted; **superseded by ADR-014** — there is no RPC client any more.

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

**Status:** accepted; **superseded** — the panel was retired on 2026-09-24 and the surface is
the native chat. The principle it recorded (nothing PiCode adds opens itself on startup) still
holds for whatever surface replaces it.

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

## ADR-010 — Pin and ship pi rather than using the user's PATH

**Status:** accepted.

**Context:** If PiCode ran whatever `pi` it found on `PATH`, every user would run
a different agent version, with a different RPC surface, a different model
catalog and different tool behaviour. That is not reproducible, and it makes
support and verification impossible: a bug report would describe PiCode plus an
unknown agent version. The project has already seen the RPC surface change
between pi releases (ADR-007 records a corrected assumption that came directly
from the agent's own schema). Reusing the user's installation also means PiCode
silently inherits whatever extensions and settings that user has accumulated.

PiCode therefore pins the runtime it is verified against. The pin lives in one place,
`build/distribution/runtime.json` — pi `1.4.0` today — and `build/pi-runtime.sh` installs it into the
pack during the build, so a freshly built editor is born working.

**Decision:** PiCode pins and ships its own pi inside the build, instead of resolving it from
the user's `PATH`.

The pin is not a lock-in: the `picode.pi.runtime` setting (and its executable-path variant)
lets a user point PiCode at a different pi.

**Consequences:** Every PiCode install behaves the same way, verification is
meaningful because the agent version is known, and PiCode's extension and pi
cannot drift apart silently. The trade-off accepted: PiCode now owns pi's release
tracking. A new pi release can break the integration, so PiCode must test and
bump the pin deliberately rather than inheriting updates. On the other side, a
user who wants a newer pi is not blocked, because the executable path is a
setting.

## ADR-011 — Own the editor tree and remove product keys instead of overriding them

**Status:** accepted. Supersedes ADR-008 in part; its *mechanics* are **superseded by
ADR-013** — the tree is now the versioned source and is compiled, not a build artefact branded
after extraction. What still stands from this ADR: PiCode owns the tree, and product keys are
**deleted**, not merely overridden.

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
through a data delta (`product.json`) applied by a Node
program, and the agent panel ships as a built-in extension. The distribution
remains uncompiled: no fork, no yarn and Electron build, no patch rebasing
against upstream.

**Consequences:**

- Keys can be deleted, not merely overridden, which is what makes the Copilot
  removal real rather than cosmetic.
- The tree was a build artefact and was not versioned; what was versioned was the
delta, the applier, the defaults and the extension, and `.gitignore` fenced the
700 MB payload. **Superseded by ADR-013**: the tree is now the repository root, versioned.
- Upgrading was "extract a new archive, re-run the apply script" rather than
  an in-place update, and `updateUrl` was emptied for that reason. **Superseded by
  ADR-013/ADR-015**: the build compiles the tree, and the updater reads the channel's own
  static feed (see ADR-015 and `updates/README.md`).
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

## ADR-012 — The product's own copy is English; other languages are language packs

**Status:** accepted.

**Context:** The product was written with all of its user-facing copy in Spanish — dialog
prompts, notifications, command titles, settings descriptions, and the labels the chat shows
for pi's tools. That made every piece of PiCode's own surface Spanish while the editor it
lives in stayed English, so a single dialog could come out half in each: the prompt in
Spanish with VS Code's own `(Press 'Enter' to confirm or 'Escape' to cancel)` appended by the
platform, untranslatable from the extension because it is not our string.

The owner's correction (2026-09-25): *"todo ha de estar en inglés, tú me hablas en español,
ya construiremos paquetes de lenguajes para todos los demás idiomas. Pero a priori en
inglés."*

**Decision:** Every string the product shows is English. Spanish stays where it is the
conversation rather than the product: what is said to the owner, and the records that are
his (`AGENTS.md` and the internal papers in `docs/`). Other languages are reached later by **language packs**,
which is the editor's own mechanism: a separate layer keyed by localize key over the English
source text, added without editing the sources.

**Consequences:** The product reads as one language, and a language pack can be added,
removed or turned off without touching a single source string. The cost accepted: the
existing Spanish copy had to be translated in the connector, in the settings contribution and
in the core patches that replace the editor's Copilot wording, and a language pack is now the
only supported way to get a different language on screen.

**Rejected alternatives:**

- **Shipping the Spanish language pack and setting `locale: es` by default** — measured
  working (the pack translates 22 052 of this editor's 24 625 messages, including the quick
  input suffix), and rejected: it makes the whole editor Spanish, which is not a decision
  this product gets to make for whoever uses it. The pack belongs in a later, opt-in step.
- **Leaving the copy in Spanish and accepting the mixed dialog** — the mix is not a cosmetic
  difference: the platform appends its own text to our prompts and no extension can translate
  or suppress it.

**Reversal trigger:** this decision stops paying for itself if a language pack cannot be
built or loaded for the platforms PiCode targets — at that point the sources would have to
carry translations again.

## ADR-013 — PiCode owns and compiles its editor source in-repository

**Status:** accepted. Supersedes ADR-008 in full and ADR-011 in its distribution mechanics.

**Context:** ADR-008 and ADR-011 kept the distribution **uncompiled**: a stock VSCodium archive
was extracted, branded after the fact with a data delta, and fenced out of git as a build
artefact. On 2026-09-27 the owner reversed the frame: *"lo que si OLVIDATE de una extensión,
todo ha de vivir en el núcleo"* and the prepared tree stopped being an artefact. It is now
PiCode's source.

**Decision:** the tree is PiCode's own, versioned source tree — the VSCodium changes,
PiCode's work and the product identity already baked in. Nothing is fetched or patched per
build; `build/build.sh` compiles it in five phases, and the product delta is applied to
`product.json` **before** packing.

**Consequences:** A core behaviour change is TypeScript in the tree, compiled, with the
checksums computed over the finished product — the `checksums` map that made the minified
bundle untouchable (ADR-011) no longer bounds us. A newer VS Code becomes a **merge against
the tree** instead of an archive swap. The trade-off accepted: the repository carries
Microsoft's MIT-licensed source and must keep its attribution, and the tree is large, so the
first build installs its dependencies once.

**Rejected alternatives:** keeping the delta-only path — it could not delete product keys from
minified core, which is exactly what the Copilot removal needs.

**Reversal trigger:** it stops paying if maintaining the merged tree against upstream costs
more than the layer-only path did and a genuine fork is unavoidable.

## ADR-014 — pi is integrated through its in-process SDK, not `pi --mode rpc`

**Status:** accepted. Supersedes ADR-003, ADR-005 and ADR-006.

**Context:** ADR-003 chose a child process over `pi --mode rpc` for process isolation and
version independence; ADR-005 and ADR-006 governed that RPC client's framing and payload
handling. The connector now loads pi's SDK at runtime (`piSdk.ts`) and opens the session with
`createAgentSessionServices` / `createAgentSessionFromServices` inside the extension host. There
is no RPC client, no hand-rolled framing and no payload forwarding left to govern.

**Decision:** The session runs through pi's in-process SDK. The runtime is still the pinned,
in-tree one (`build/distribution/runtime.json`), and the CLI is used only for what the SDK does not
expose (package management).

**Consequences:** Events arrive as typed SDK objects instead of JSONL, so ADR-005's framing
rule and ADR-006's forwarding rule no longer apply. The isolation and version-independence
benefits ADR-003 wanted are given up: a pi failure now runs in the extension host, and the pi
version is the one the build ships. That is accepted because the runtime is pinned and shipped
(ADR-010), so there is no unknown-version drift left to defend against.

**Rejected alternative:** keeping the RPC child process — rejected because the chat had to
carry typed model, thinking and queue operations that only the SDK exposes cleanly, and the
pinned runtime removes the version-independence argument.

## ADR-015 — Three release channels, one branch each, feed beside the channel

**Status:** accepted.

**Context:** The owner asked for three channels — stable, beta and experimental — each
installable beside the others, with no channel able to receive another's release.

**Decision:** `master` is **stable**, `beta` and **experimental** are the other two. Each
channel's update feed lives on **its own branch**, under
`updates/<channel>/win32/x64/<target>/`, and `build/build.sh` seals the channel into
`product.json` (`quality`) and rewrites the `updateUrl` branch from `/HEAD/` to the channel's
branch (`PICODE_CHANNEL=stable|beta|experimental`).

**Consequences:** A beta install cannot be handed a stable release even if a pipeline errs,
because it reads a different branch. Side-by-side installs use separate folders, profiles and
AppIds. The cost accepted: three branches to keep aligned, and a feed that must never be
copied across channels — a stray copy is exactly what a later merge would land in the wrong
place.

**Reversal trigger:** if keeping three branches aligned costs more than the separation is
worth, or if the updater stops being able to read a branch-scoped feed.

## ADR-016 — The declared product version may lead the tree's upstream base

**Status:** accepted; **recorded as a corrected assumption** — the first plan was a real rebase.

**Context:** A VS Code-derived extension validates against `engines.vscode`, which the editor
compares against its **product version**. A tree descending from VS Code 1.135.0 could not
install extensions that ask for `^1.141.0`, and the plan was to rebase the tree onto 1.141.0.
The owner refused: *"NO estamos trabajando en un fork ya, es nuestro código"* and *"QUIERO QUE
NUESTRO PRODUCTO NO CAMBIE SOLO QUERIA CAMBIAR UN NUMERO"*.

**Decision:** Keep the tree as it is and raise only `product.json`'s
`version` (1.135.0 → 1.141.1). The pin `upstream/stable.json` keeps telling the truth about
where the tree descends from; the declared number is free to lead it.

**Consequences:** Extensions install, and not a line of PiCode's product changes. The measured
risk — an extension calling a function added between 1.136 and 1.141 — is negligible: against a
clone, the stable API surface (`vscode.d.ts`) changed only in comments, and the new proposed
APIs are unreachable unless `product.json` enables them. The price is upstream behaviour and
fixes we do not inherit, not surface, and that price is knowingly accepted.

**Reversal trigger:** a required extension that genuinely needs 1.141 behaviour, or an upstream
security fix that only lands in the code, turns this back into a real merge.

## ADR-017 — Cloud sync is a Pro feature; the free plan is an account, not storage

**Status:** accepted.

**Context:** The first design gave every plan a storage quota and agreed it with the website:
`free` ≈ 1 MB, `pro` ≈ 50 MB, enforced in `host/cloud/sync-api` (`DEFAULT_PLAN_QUOTAS`). The editor
then became stricter than that: `picodeAccountProvider.createSession` refused to mint a sync
session for an account whose plan is not `pro`, and every API route called `requirePro`
(`402 PaymentRequired`) — so a Free owner could not even sign in for an account. Three layers
were saying three different things — the pricing card promised *«Cloud sync for your settings
(1 MB)»* on the free plan, the editor refused the sign-in, and the API refused the request.

**Decision (owner, 2026-10-09):** *«El free no sincroniza, no hay sync gratis. Puedes tener tu
cuenta, y vincularla, pero para usar la sync has de ser pro.»* The **account is free and the
sync is not**, and the two are separated on purpose:

- **Anyone can sign in and stay linked.** `picodeAccountProvider.createSession` no longer looks
  at the plan, so a Free owner keeps a real account in the editor.
- **The service is the gate.** Every sync route answers `402 PaymentRequired` to a plan that is
  not Pro — the authority is the server, not a plan snapshot stored on the client (which would go
  stale the moment someone subscribed after signing in).
- **The editor says it out loud.** The `402` is mapped to its own `UserDataSyncErrorCode`, and
  turning sync on answers with *«PiCode Sync requires a Pro account»* plus a **See plans** button
  (the URL comes from `product.picode.webOrigin`, not a second hardcoded string). Auto-sync turns
  itself off softly on that same code, so an account that loses the plan stops retrying instead of
  hammering the API.
- **Free's quota is 0** — a promise, not a small allowance — and `PICODE_QUOTA_FREE_BYTES` is
  ignored so no leftover variable can hand out storage the product does not sell. The website
  stops advertising a free tier for sync (web, pricing card, terms).

**Consequences:** One story across web, editor and API. The 1 MB free quota — dead code while the
gate existed, and broken anyway (the quota counts the 20 retained revisions per resource, so a
real PiCode profile at ~262 KB stored per revision would have allowed exactly three uploads before
a permanent `413`) — is gone rather than fixed. `PICODE_QUOTA_PRO_BYTES` is the only remaining
quota knob. The Welcome card no longer claims *«Everything is in sync»*: whether sync is even on
is not knowable from the service the card holds, and a Free account never turns it on. The
accepted cost: a free user who wants sync has to subscribe, and the `1 MB` the pricing page used
to advertise can never be turned back on without deciding, again, that free gets storage.

**Reversal trigger:** a product decision to give the free plan real (working) sync. If that
happens, the retention cap must become plan-aware first: the byte ceiling is compared against all
retained revisions, so a 1 MB free tier with a 20-revision retention cannot hold even one real
profile beyond the third upload.

## ADR-018 — Durable is the chat; Local retires from the pickers (the harness reads "PiCode")

**Status:** superseded by ADR-020, and ADR-020 by ADR-030.

**Context:** A chat could run in the editor's Local harness or in the durable agent's daemon.
The owner had already made durable the preferred default, but Local was still offered as a
destination and a window without a folder on disk fell straight back to it — so "always
durable" was not literal. And the durable harness presented itself as *"Durable"*, a name that
belongs to the feature, not to the product the owner sees in the chat. Owner, 2026-10-11:
*«En el chat no quiero usar el harness de local más, quiero usar el de durable como default,
siempre será durable. … Aunque no pongas durable ni nada así en el harness porque
estéticamente será PiCode.»*

**Decision:**

- **Durable is the chat, not the preferred default.** While its contribution is registered,
  every new-chat door resolves to it — `getComputedDefaultSessionType`,
  `getDefaultNewChatSessionType` and `resolveDefaultNewChatSessionType` — and a **virtual
  window** keeps durable too (its tools resolve the directory themselves: the first existing
  workspace folder, the home one otherwise). `isVisibleEditorChatSessionType(local)` retires
  Local from the pickers, and a remembered Local pick stops being usable. Local survives only
  as the fallback for a window where no non-local type exists, because something must answer.
- **The harness reads "PiCode".** The `chatSessions` contribution's `displayName` and
  `welcomeTitle` are `PiCode`; the internal `type`/`name` stay `durable`, because they are the
  registration key and the `@` participant.
- **The Sessions panel keeps its filters.** `durable`, `pi` and `local` remain as history,
  next to the conversations that already exist. Retiring the filter would erase the past, not
  change the future.
- **The feature is still the "Durable agent".** Settings and the Status page keep that name;
  what changed is the harness's presentation inside the chat, not the piece.

**Consequences:** One chat, durable, from the button and from every door. The fallback keeps an
editor with no connector working. The accepted cost: an owner who genuinely wants a local chat
in a window where durable is registered can no longer pick one.

**Reversal trigger:** durable stops being the product's chat — the connector is removed from
the shipped build, or the product decides again that Local is an offered destination.

## ADR-019 — The editor's context travels with every chat turn, durable included

**Status:** accepted.

**Context:** ADR-018 made durable the chat. Durable runs as a separate process in a working
directory, and its turn only carried `request.prompt` to the daemon — not the file the owner
had open, not the selection, not the Problems panel, not the references attached to the
message. The in-process chat did send that block (`context.ts`), so making durable the chat
silently removed a capability the owner had: asking "can you see the file I have open?" got a
folder-blind answer. Owner, 2026-10-11: *«¿no sería mejor que fuera pi el que gestione el
chat?»* — the question behind it was not *which engine* (pi answers in both cases: durable runs
`@earendil-works/pi-durable`), but that the chat no longer saw the editor.

**Decision:**

- **The editor's context is part of every prompt, whoever runs the turn.** `editor-context.ts`
  reads the folder (or the area), the open file, the selection, the file's errors and warnings,
  and the request's own references; `context.ts` writes them into the frame `withContext`
  prepends. Both the durable turn (`durable-sessions-register.ts`) and the in-process chat
  (`agent.ts`) go through it.
- **The frame is stripped on replay.** The daemon stores the framed prompt as the user entry,
  so `durable-sessions.ts` shows the owner's own words in the transcript and the session label
  (`ownerTextOf`), exactly as `sessions-provider.ts` already did for pi's transcripts.
- **The gate stays the owner's:** `picode.context.attach` (off means none of it travels).

**Consequences:** The durable agent answers about the screen the owner is looking at. The cost
is paid every turn: the context block is prepended again, capped on purpose (selection in lines
and characters, problems in count). Attachments whose editor gives no text still travel by name.

**Reversal trigger:** a context block that costs more than it explains — an owner turning
`picode.context.attach` off for good, or a model measurably worse with it than without.

## ADR-020 — The chat is pi; durable is the backend it reaches through tools

**Status:** superseded by ADR-030. Supersedes ADR-018.

**Context:** ADR-018 made durable the chat by declaring it the default `chatSessions` type and
retiring Local. In a real run, sending "Hola" answered **`No activated agent with id "durable"`**.
The cause is structural, not a missing handler: the CHAT panel executes **agents**
(`chatAgentService.invokeAgent(agent.id)`), and a `chatSessions` contribution is a session
**provider** — it registers agent *data* (`_registerAgent`) with no *implementation*, because
the implementation of a session type is expected to be an agent-host or a chat participant.
Durable has neither: its content provider exposes a `requestHandler`, and nothing in the CHAT
panel's send path turns a session content provider into an agent implementation. Selecting the
durable harness therefore prefixes the request with `@durable`, `invokeAgent('durable')` finds
no impl, and the turn dies. Owner, 2026-10-11: *«El chat habla con pi y pi lanza lo que
necesite de durable (tasks, sesiones, memoria, etc)»*.

**Decision:**

- **The chat's agent is pi, in process.** `agent.ts`'s `@pi` participant owns the model, the
  agent profile and the tools, and streams into the panel. Local is its session; the durable
  default and the Local retirement of ADR-018 are reverted in the core
  (`getComputedDefaultSessionType`, `getDefaultNewChatSessionType`,
  `resolveDefaultNewChatSessionType`, `isNewChatSessionTypeUsable`,
  `isVisibleEditorChatSessionType`, and the empty-Local switch in `chatViewPane.ts`).
- **durable is the backend, reached by pi's tools.** The `durable_send` / `durable_list` /
  `durable_read` bridge (`durable/bridge`) is loaded into the chat's pi session,
  and MCP stays pi's. A prompt pi delegates runs in the daemon and survives pi dying; memory
  and MCP are pi's own tools.
- **The durable `chatSessions` contribution stays declared but disabled** (`"when": "false"`,
  `canDelegate: false`): it is not a chat harness, and leaving it selectable is what produced
  the error. Re-enabling it requires giving the session type a real agent implementation, which
  is the separate work (below), not a flag.

**Consequences:** The chat answers again, about the file the owner has open (ADR-019), and the
panel harness is pi's. The accepted cost: a durable conversation is no longer a chat one can
open and continue in the panel — durable conversations are pi's to list and read through the
bridge tools, and appear in the panel only through pi's own transcript listing.

**Known follow-up (not this ADR):** if durable conversations must be *opened and continued*
in the panel, the session type needs an agent implementation that runs pi and writes into
durable; that is a project, and ADR-018's mechanism alone never provided it.

**Reversal trigger:** the CHAT panel gains a supported path that runs a `chatSessions` content
provider's `requestHandler` as the turn (then durable can be a harness again), or the product
decides conversations must live in durable and pays for the agent implementation.

## ADR-021 — One orchestrator (pi), one list, sessions always durable

**Status:** superseded by ADR-030. Refines ADR-020 and reverts the durable-as-chat-destination re-shipping
in 0.2.3-experimental.

**Context:** The 0.2.3 build shipped three coexisting engines (the in-window harness "Local",
the durable chat destination, the `pi` transcript reader) and a sessions panel that filtered
between them with a one-at-a-time toggle. The owner, 2026-10-13: *«Quiero que elijas al que sea
el mejor orquestador del chat, en este caso creo que es Pi. Siempre. Ni local, ni durable. Luego
que las sesiones las lleve siempre durable ¿No?, y que dejemos de filtrar por durable, pi o
local.»* — the shape his own pi lives by: one orchestrator, conversations that survive, one list.

**Decision:**

- **The chat's engine is pi, always.** The core blocks that made `durable` the default session
  type (`DURABLE_CHAT_SESSION_TYPE` in `constants.ts` and its readers) are removed; ADR-020's
  shape stands with nothing to re-ship. durable is the backend pi reaches through tools.
- **The sessions panel shows one list: pi's durable transcripts.** The provider filter menu
  loses its provider toggles (they remain as an opt-in for a consumer with genuinely several
  providers). `Local` — the editor's duplicate record — and `durable` — no longer an engine —
  are excluded unconditionally, normalized against any stored filter state
  (`normalizedExcludes`). The local harness's provider name reads **"Pi"**, not "Local": it
  names the engine, not the plumbing.
- **A listed conversation continues.** Opening a pi transcript binds it to an in-process pi
  session (`sessions-resume.ts`, `SessionManager.open`): the next prompt appends to the same
  file, with its own permission gate, editor MCP tools and turn queue per resumed session. This
  is ADR-020's known follow-up resolved for pi's own transcripts — the property durable had,
  without a second engine.

**Consequences:** New chats run pi; old chats are reachable, continuable and durable in one
list; the "engine question" disappears from both the chat and the panel. Old durable
conversations remain in the daemon's storage with no UI path — recovering them, if ever asked,
is a migration, never a filter.

### Corrección de ADR-021 (2026-10-13, noche): la sesión vive en durable, no en un fichero

El dueño revisó el reparto la misma tarde: *«las sesiones no deberían llevarla siempre durable?
O sea el chat habla con pi y pi crea una sesión durable»* — y es la forma exacta del propio pi
que él usa. El estado aceptado queda:

- **pi piensa, durable recuerda, el editor es la sala.** Cada turno lo ejecuta pi en la ventana
  (modelo, permisos, pantalla) y al terminar **apunta la ronda en durable** (`record`): la
  conversación vive en el almacén del daemon, sobrevive a todo y continúa desde cualquier
  ventana. La lista del panel es **durable**, no los transcríptos JSONL.
- **Los transcríptos de fichero quedan como registro de referencia** para lo que llega de
  fuera (importaciones, CLI) — y **una importación los convierte a durable al entrar**
  (`sessions-import.ts`), así que lo importado aparece y continúa como una conversación más.
- **Continuar = pi, nunca el daemon.** Abrir una conversación del panel siembra una sesión pi
  en proceso con su historia y graba de vuelta en la misma conversación (`sessions-resume.ts`,
  `piDurableResumeHandler`). El camino viejo de "mandar el turno al daemon" quedó eliminado.
- **Delegar a tiempo**: `durable_send` lleva la regla DELEGATE ON TIME — lo largo va a durable
  antes de empezar — y el panel marca "Input Needed" una conversación cortada a medias
  (`lastModelEntryIsUser`).

Piezas de la primera versión de ADR-021 que quedaron **reemplazadas**: la continuación por
fichero (`sessions-resume` sobre JSONL como lista principal) pasa a ser el lector de lo externo,
y la conversión durable→fichero se deshizo antes de llegar a construirse.

### Historia importada que no debe "deber" (2026-10-14): la cola del transcript viaja con la importación

El dueño lo señaló con la pantalla delante: *«Siguen al cargar las sesiones importadas algunas
como "input needed"?»*. Unos 80 tramos de historia llegaban al panel como si esperaran respuesta.

**La causa** no era el estado sino la pérdida: una sesión que se cerró con el agente trabajando
guarda su último turno de asistente como llamadas a herramientas **sin texto**. El parser de
turnos (solo texto visible) lo descartaba, y la copia importada terminaba en la pregunta del
dueño — la firma exacta de «te toca». La importación convertía trabajo a medias en deuda.

**La regla nueva** (tres piezas):

1. **La cola viaja.** La importación lee la cola del transcript (`sessionTail`,
   `sessions-provider.ts`): la última entrada `user`/`assistant` aunque no tenga texto, y la
   graba tal cual (llamadas a herramientas incluidas). La copia acaba donde acabó la sesión.
2. **El daemon acepta el turno interrumpido.** `record` (`durable/lib/daemon.js`) admite un
   mensaje de asistente sin partes — la forma real que pi escribe al cortar un turno. Un
   mensaje de usuario vacío sigue rechazándose.
3. **La reparación completa, no duplica.** Una re-importación ya no empareja por primera
   pregunta a secas: elige la copia cuyos turnos son **prefijo exacto** del fichero
   (`sessions-import-plan.ts`, puro y con tests) y le graba solo lo que le falta, contado
   por entradas de modelo (`pi.user` + `pi.assistant`), que es el único contador que ve el
   turno sin texto. Una copia que siguió adelante tras importarse recibe nada: su historia
   está por delante del fichero, nunca detrás.

Así, "Input Needed" queda reservado a lo que de verdad espera al dueño: una conversación viva
cortada antes de respuesta. Las ~80 filas históricas se sanan solas en la siguiente pasada de
importación (sin migración: la reparación añade, no reescribe). Verificado con un daemon
aislado y el transcript real de «Este pi tiene pi durable?»: antes `owes=true`, después
`owes=false`.

## ADR-022 — Engram is the product's memory; durable stays the record

**Status:** accepted (2026-10-20), except its durable half, which ADR-030 retires. Adds a layer to ADR-021; does not replace it.

**Context:** Durable answers *what happened*: every turn, verbatim, per conversation, and the
long work that outlives the window. It never answers *what we know*. A new conversation starts
empty, and nothing a previous one learned survives it — the gap the owner named when he asked
for memory as a separate thing: *«Pi es el agente | Durable las sesiones y el registro | Engram
la memoria»*.

Engram is a candidate that already exists, is local (Go binary, SQLite+FTS5), curated rather
than a transcript sink, and — decisively for this product — shared: other agents on the same
machine can read the same store. It is **not** gentle-ai: gentle-ai was the framework removed in
`2ac4e68d`, and `left-behind-packages.ts` keeps its packages out of an import. Engram is a
standalone engine that framework happened to use.

**Decision:**

- **Engram ships inside PiCode**, like durable: one pinned binary in the product's resources,
  not something the user installs. *«Yo quiero a engram en el producto… si un usuario escribe
  engram tiene que funcionar»* — including the integrated terminal.
- **One declaration serves both engines.** The profile's `mcp.json` already feeds the in-process
  chat (pi's built-in MCP) and durable (`lib/mcp.js`, deferred behind `mcp_tools`). No second
  integration path is written.
- **The `gentle-engram` pi package does not enter.** *(Superseded by ADR-031: it enters, pinned.)*
  Its hooks, status bar and session-identity machinery are the coupling that was removed with
  gentle-ai; the memory protocol is written here, in our words, in both system prompts.
- **The store is the user's, not the profile's:** `~/.engram`. It is reused **as it is** when it
  exists, created when it does not, and never moved, migrated or overwritten. If an engram
  server is already serving, PiCode **joins it**; it does not open a second one on the same
  store.
- **The split is one-directional:** pi writes to durable (the turn) and to engram (what is worth
  keeping). Durable never reads memory; engram never reads transcripts; both are called by
  whoever is running the turn.
- **The editor carries what engram's TUI shows** — list, search, detail, history, origin,
  relations, review, pin, delete, doctor — in **surfaces that already exist** (the container's
  view, an editor tab, Settings). Its TUI, keys and theme are not ported. Its registry
  "sessions" are never rendered as sessions: those are durable's.

**Consequences:** Memory survives sessions, windows and compactions, and crosses engines. The
accepted cost, recorded rather than hidden: **memory does not travel with the profile**, so the
cloud story (profile as one syncable unit) excludes it until its own work exists. A second
runtime joins durable in the distribution and the update surface. A memory failure never blocks
a turn: pi answers without it. This narrows DISENO's rule 2 — what lives outside the profile is
the *user's memory*, never the product's configuration.

**Reversal trigger:** the store outside the profile makes the cloud profile incoherent when it
ships; or, a week measured with the protocol injected, the agent still does not search before
repeating — then the layer is decoration and it comes out rather than stay as a drawer nobody
opens.

## ADR-023 — The setup is a window of its own, before the workbench exists

**Status:** accepted (2026-10-23)

**Context:** The first-run setup lived on the Welcome page, as cards inside a column. It competes
with everything the editor puts on screen before anybody has configured anything — a sidebar
inviting a folder, a chat inviting a word, a status bar reporting things nobody asked for — and
the step that matters most (which model answers) was the poorest one. *«Compite con el ruido del
editor… el paso Provider & model es el más importante y el más pobre»*. The tree is PiCode's own
source (ADR-011 / ADR-013), so there is no patch to write: the change is code in the tree.

**Decision:**

- **The setup runs before the editor.** The main process reads a flag, shows a dedicated
  `BrowserWindow` when it is missing, and opens the workbench only when the setup answers or is
  skipped. No window of the editor exists behind it, so nothing competes.
- **One page, three situations.** `first-run`, `update` and `PiCode: Setup` from the palette all
  load the same `resources/onboarding/index.html`; `mode` tells the page which it is and the
  state it is given is preselect, so nothing configured is asked again and nothing is overwritten
  without a click.
- **The window has no privilege.** It loads a local page with `contextIsolation`, no node, and a
  preload that exposes five named operations. Everything that touches disk happens in a child
  process (`resources/onboarding/host.cjs`) which loads the **connector's own**
  `onboarding-host` — the profile copy, the provider projection and the model list are the
  modules the editor already uses, not a second implementation.
- **The flag is per installation**, in `data/onboarding.json` next to the portable profile (or
  the user data directory outside a portable install), holding
  `{ completed, onboardingVersion, productVersion }`. It is re-read, never consulted live: a
  later start does nothing at all.
- **The editor always opens.** A closed window, a dead renderer, a page that failed to load and a
  backend that never answers are all "skip": the flag is recorded and the workbench opens. The
  setup can never cost somebody their editor.
- **It never leaves the editor at zero windows.** The setup window is hidden when the answer
  arrives and destroyed only once another window exists. Closing it first is not a detail of
  taste: VS Code quits on `window-all-closed`, so the setup — the only window there is at that
  moment — took the application down and the editor being opened right after died with
  *"Trying to add a disposable to a DisposableStore that has already been disposed of"*. Found on
  the packed build, on **Skip** and on the **X**, and fixed by not being, even for a millisecond,
  the last window.
- **Nothing of the machine's pi is written.** The external profile is read by the scan and by the
  import's source side and by nothing else; choosing the external pi writes one editor setting.

**Consequences:** The first thing a new install shows is the product's question, not the editor's
chrome. The welcome page's wizard was **removed** once the window was verified in a real run
(2026-10-23: the window appeared, its page reached the backend, and closing it recorded the flag
and opened the editor): `picodeSetup.ts` is gone, and the column now says what the setup covers
and offers the one button that reopens it. The connector's own commands for the old wizard
(`picode.setup.getState`, `…importFromExternal`, `…providerAddManual` and the rest) still exist
and are now unused by the core — they are the extension's API and keep working for anything that
speaks to them, but they are dead weight to remove deliberately, not in a hurry. A second language lives with
the page itself (English and Spanish in one table) until a language-pack layer exists. The
accepted cost: a `BrowserWindow` whose page is not part of the workbench bundle, so
`build/stage-distribution.sh` copies the folder into the pack and a missing copy degrades to
"open the editor" rather than to a crash.

**Rejected alternatives:** a webview panel inside the workbench (it cannot show before the
workbench, which is the whole point, and would need a second backend); cards on the Welcome page
(the noise this ADR removes); blocking the editor until the setup finishes (a setup that fails
would leave somebody with no editor).

## ADR-024 — The Activity Bar draws outline icons, not the editor's glyph font

**Status:** accepted (2026-10-24)

**Context:** Every item in the Activity Bar was a Codicon — the same drawings, at the same
weight, as any VS Code. The bar is the first thing the eye lands on and it read as "another
VS Code", which is precisely what the product is not. A request came to give it its own
language: clean outline strokes, a thinner weight, more air between items.

**Decision:**

- **The five built-in containers and Manage use drawings from the Tabler set (MIT).**
  Explorer `folders`, Search `search`, Source Control `git-branch`, Run and Debug `bug`,
  Extensions `puzzle`, Manage `settings`. They live in
  `src/vs/workbench/contrib/picode/browser/media/tabler/`, together with the licence and the
  geometry note. The PiCode mark stays as it is: it is the brand, not a borrowed icon.
- **They are URI icons, not theme icons.** The bar already paints URI icons as CSS masks, so
  the shape comes from the SVG and the colour from the theme. One asset serves every state and
  every theme; hover, selection and high contrast keep working with no second drawing.
- **Stroke weight is normalised at the bar's 24 px icon size.** Tabler's `stroke-width="2"` on a
  24 viewBox lands at exactly 2 px, and the PiCode mark was re-stroked (84 → 66 on its 788
  viewBox, the handle 60 → 48) so that its silhouette lands on the same 2 px instead of the
  2.56 px it used to draw. The mark used by the status view keeps its own weight: it is drawn
  larger there, so keeping the old value is what preserves the drawing.
- **The bar is airier, not tighter**: an 8 px gap between items at the default size (0 at the
  compact size, where a gap would eat the 28 px cell), published to CSS as
  `--activity-bar-action-gap` so the stylesheet and the overflow computation cannot drift. The
  item box stays 48 × 48 — with a 24 px icon that is 12 px of padding above and below, and the
  crowding came from the missing gap, not from the box — so nothing outside the bar has to be
  re-measured.
- **The default dark theme lifts the icons**: `activityBar.foreground` `#bfbfbf` → `#e2e8f0`,
  `activityBar.inactiveForeground` `#8C8C8C` → `#94a3b8`. Light themes are untouched: their
  icons must stay ink, and a hard-coded pale grey would vanish on them.
- **Hover and selection are transitions, not jumps** (120 ms on colour and background), so the
  brighter icon and the existing modern-UI pill arrive without a flash.
- **The bar is two flex blocks, not one stack.** The containers above take the free height and
  scroll inside themselves if they ever need more; Accounts and Manage sit in their own block
  pinned to the bottom. With every item content-sized, a taller bar (bigger icons, the gap, a
  larger activity bar font) pushed the bottom block past the window edge and the Settings gear
  was clipped — the taller the bar grew, the more certain the clip.

**Consequences:** The Activity Bar no longer matches upstream's silhouette, so a future upstream
redesign of the bar has to be reconciled by hand in six places plus the CSS metrics. Icons are
monochrome by construction: the blue accent inside the PiCode mark is not visible in the bar
(the mask paints the whole silhouette in the theme colour) — already true before this ADR, and
the reason the mark reads as one shape. The default-mode gap stops being 0, and that stride is
pinned by the activity bar unit tests, which is where a regression will show up first.

**Rejected alternatives:** a product icon theme (SVG is not supported there — it is a glyph
font swap, which is exactly the medium we wanted to leave); a custom icon font (new binary
asset, new licence surface, and strokes cannot be tuned per size); recolouring Codicons
(the shape is the problem, not the colour).

## ADR-025 — Installing from Open VSX never asks "do you trust this publisher?"

**Status:** accepted (2026-10-24)

**Context:** Before installing an extension from the gallery, the editor asked whether the user
trusts its publisher, once per publisher, and refused to install unless the answer was yes. That
prompt was built for the Microsoft Marketplace, where publishers can verify ownership of a domain
and the check has something to say. PiCode installs from **Open VSX**, which has no such
programme: nearly every publisher is "not verified" there, so the dialog fired on the first
install from each of them and turned a one-click install into a security quiz. *«Queremos eliminar
completamente este paso de confirmación»*.

**Decision:**

- **The prompt is gone.** `checkForTrustedPublishers` — the dialog, its publisher lookup and the
  "will also install extensions by…" walk over pack members — was deleted from
  `extensionManagementService.ts`, together with the three call sites that ran before an install
  (gallery batch, single gallery install, profile restore). `requestPublisherTrust` stays on the
  interface as a no-op because a profile restore asks for it; it never prompts.
- **Installing is the consent.** The Install button is the decision; the extension's own workspace
  trust declaration is still honoured (`checkForWorkspaceTrust` is untouched), so an extension that
  needs a trusted workspace still asks for one.
- **The "not verified" badge stays** on the extension page. It is information, not a gate, and
  removing the dialog does not mean pretending verification exists.
- **The badge-provider allow-list and the workspace-trust keys were not touched.** The brief
  suggested emptying `extensionAllowedBadgeProviders` and adding an
  `extensionUntrustedWorkspaceSupport` default: the first would strip README badges from every
  extension page, and the second is not a key the product reads (`ProductConfiguration` has no
  such field, and workspace trust support is declared per extension in its manifest). Neither has
  anything to do with this dialog, so neither was cargo-culted in.

**Consequences:** Any publisher can be installed without a prompt, including a copy-cat name —
that is the trade the brief asks for, taken because the alternative was a prompt with no signal.
The trust bookkeeping still exists (`trustPublishers`, the "Manage Trusted Extension Publishers"
command) and is now only ever fed by the post-install auto-trust, so the list stays a record of
what was installed rather than a gate.

**Rejected alternatives:** keeping the prompt behind a setting (the default would still be the
quiz); trusting every publisher up front by writing to storage (a hidden write the user cannot see
or undo); keeping the dialog only for extensions that *are* verified on Open VSX (none are, so it
would be dead code).

## ADR-026 — A PiCode colour family, and PiCode Dark as the default

**Status:** accepted (2026-10-24)

**Context:** The editor's default theme was *Dark 2026*, an upstream-flavoured palette with blue
accents that belong to no brand in particular. The brief named a palette taken from the PiCode
mark and asked for it to be the default, plus two companion themes and a light pair, with Abyss
no longer being what a new install lands on. *«sustituyendo Abyss»*. A second pass then pinned the
default's colours to the **landing page**: near-black surfaces (`#030712` … `#080C17`), the
`#111827` grid lines and the "Download for Windows" button blues (`#2563EB` / `#3B82F6`). A third
added a sixth theme for the retro crowd (*«PiCode Synthwave»*).

**Decision:**

- **Six themes ship in `extensions/theme-defaults`**, next to the upstream ones:
  **PiCode Dark**, **PiCode Light**, **PiCode Neon Minimal** (OLED black), **PiCode Slate**
  (neutral greys), **PiCode Sepia** (warm reading light) and **PiCode Synthwave** (magenta neon on
  violet-black, with its own syntax tokens so the code sample is 80s too). The three beyond the
  named pair are the "ecosistema visual" the brief describes — OLED, neutral, warm — because the
  brief asked for three extra themes and specified only the first.
- **Each file inherits `2026-dark.json` / `2026-light.json` and repaints the chrome.** The base
  brings a complete palette (syntax tokens, git decorations, chat and widget surfaces); the theme
  brings the brand surfaces — editor, side bar, activity and title bar, status bar, tabs, panels,
  widgets, lists, inputs, menus, terminal — plus the accents. One map generated all five, so they
  cannot drift apart in the keys they forget.
- **`activityBar.foreground` is the brand accent and `inactiveForeground` is muted slate**, so the
  outline icons carry colour only where they matter (the selected item and hover). In the default
  that accent is the web's `#3B82F6`; in Neon it is the cyan, and in Synthwave the magenta — each
  theme keeps its own signal colour, because a single hue for all of them would make the family
  pointless.
- **The default is PiCode Dark** (`ThemeSettingDefaults.COLOR_THEME_DARK`), and PiCode Light for the
  light preference, so a profile that never chose a theme — and the automatic dark/light switch —
  lands on the family. *Dark 2026* and *Light 2026* are still installed and still selectable; a
  user who already chose one keeps it.
- **The first-run setup offers the PiCode themes as its featured cards**, PiCode Dark first, and
  demotes Abyss to "see all themes". The cards' preview palettes were measured from the theme
  files, so the tint the setup window takes on hover is the theme it will apply.
- **A first run writes the default down.** When the setup finds no theme set, it stores
  `workbench.colorTheme: "PiCode Dark"` instead of leaving the setting empty: the card shows as
  chosen, the welcome step can name the theme, and the editor opens on the brand palette whatever
  the OS colour scheme is. A profile that already chose a theme is never touched.

**Consequences:** The product now has a colour identity of its own, and a future palette change is
one file per theme (or one palette entry in the generator, kept in the tree's history). Because the
themes inherit 2026, a change to that base moves all six — which is the intent, but it also means
they cannot diverge from the editor's component colours without an explicit override. Writing the
default during setup removes the OS-driven first impression for a fresh profile: a user whose
system is light still lands on PiCode Dark until they pick otherwise, which is what *«pon pi-dark
como default»* asks for and the reason the Light card sits right next to it.

**Rejected alternatives:** writing five complete themes from scratch (thousands of lines of
untouched widget colours, five times over); a product icon/theme extension of their own (a separate
extension for what `theme-defaults` already contributes); putting the palette in `settings.json`
(themes belong in a theme).

## ADR-027 — The command palette has no Copilot surfaces

**Status:** accepted (2026-10-24)

**Context:** The palette still carried *Extensions: Show Extensions using Copilot*
(`workbench.action.chat.showExtensionsUsingCopilot`), an upstream action that opens an extension
search filtered by an extension contribution point only Copilot uses. PiCode ships no Copilot
(ADR-001, and `docs/DISENO.md` says so plainly), so the entry was a dead end that named a product
this editor does not have.

**Decision:** The action is deleted, with the three imports that fed it (`IExtensionsWorkbenchService`,
`EXTENSIONS_CATEGORY`, `CopilotUsageExtensionFeatureId`). Nothing else in the chat or extensions
palette was touched: this is one command, not a sweep.

**Consequences:** The search it opened is still reachable by asking for `@contribute:…` by hand,
which is fine — this removes a misleading label, not a capability. Other Copilot-named strings
that remain (for example the quota error) belong to the chat service and are out of scope here.

## ADR-028 — The agent-host settings are findable in Settings

**Status:** accepted (2026-10-24)

**Context:** Searching the Settings UI for `agentHost` returned *No Settings Found*, and the chat
debug panel's own "open settings" link landed on the same empty page. The settings existed all
along, registered in code (`chat.shared.contribution.ts`) — not in a `package.json`, which is what
the brief assumed. The real cause was a tag: the editor hides settings tagged `advanced` unless the
query contains the setting's **full key** (`settingsEditor2.canShowAdvancedSettings`), so a
human search for "agentHost" or "agent debug" matched nothing. All four `chat.agentHost.*` settings
carried `experimental` **and** `advanced`.

**Decision:** Drop the `advanced` tag from the four agent-host settings (`agentDebugLog.enabled`,
`agentDebugLog.maxEventsInMemory`, `ahpJsonlLogging`, `allowSignedOutWhenUsable`). They keep
`experimental`, which is honest and does not hide anything, and they keep the `experiment`
metadata. The settings stay in the **Chat** group where they belong; no separate node was invented
for four entries whose siblings live there.

**Not done, deliberately:** the root `package.json` of the editor is not an extension manifest (it
has `name`, `version` and `main`), so a `contributes.configuration` block there is never read —
adding it would have looked like a fix and changed nothing. The brief's
`chat.agentHost.maxEventsInMemory` was not created as a second name for
`chat.agentHost.agentDebugLog.maxEventsInMemory`: two ids for one buffer is a bug, not an alias.
Its default stays at 10000; 100 would cut the debug buffer a hundredfold for a panel that already
drops older events.

**Consequences:** Typing `agentHost`, `agentDebugLog` or `debug` in Settings now lists them, and the
link from the chat debug panel works. A future agent-host setting must not be tagged `advanced`
unless it is genuinely meant to be found only by its exact id.

## ADR-029 — The profile's copy of pi's own family is pinned to the runtime, not removed

**Status:** accepted. Extends ADR-010 to the second copy of the family.

**Context:** The profile holds its own `@earendil-works/*` tree, and nothing in PiCode asks for it:
about a dozen ecosystem packages (subagents, image input, memory, intercom, btw, nan-provider,
deepseek-cache, codegraph-fix, specpi…) declare the family as a **non-optional** peer, and npm
installs every peer it must satisfy inside the profile — `data/pi-agent/npm/node_modules` — which
is nowhere near `resources/pi-runtime`. Removing it is not an option: npm puts it back on the next
install, and a profile whose packages cannot be resolved does not start.

That second copy is **not** the one that runs. pi's extension loader aliases every
`@earendil-works/*` specifier (and `typebox`) to the pi doing the loading
(`pi-coding-agent/dist/core/extensions/loader.js`, `getAliases`), which is always the runtime — so
what an extension imports is the runtime's code, at the runtime's version. What npm keeps in the
profile is therefore a *declaration*, not a second live instance.

Left alone it is still a hazard, because the version it lands on is the newest published one, not
the pinned one: `pi-durable` is declared without a version, so its exact family dependencies (and
the peers of everything else) float to `latest`. The moment npm publishes ahead of PiCode's pin,
the profile carries code the runtime does not have, and an extension compiled against it asks the
older runtime for an export that never existed. The build pin moving to 1.4.0 (and the profile
following it only by luck, because `latest` happened to be 1.4.0) is exactly the state this ADR
closes.

**Decision:** The profile keeps its copy of the family, and that copy is **declared at the exact
versions the runtime carries**. `packages-install.ts` derives both the package set and the versions
from `resources/pi-runtime` on disk (`runtimeFamilyPins` → `scanRuntimeFamily`) — never from a list
written by hand and never from `build/distribution/runtime.json` a second time — writes them into
`<profile>/npm/package.json` as exact dependencies, and runs one hidden `npm install --save-exact`
only when an installed version differs. A profile already on the runtime's versions costs no
process and no rewrite.

Rejected: **unifying resolution** so the profile reads the runtime's tree (symlinks, a shared
`node_modules`, a resolver hook). It would remove 42 MB of duplicated files and it is the only way
to get one single instance instead of one instance plus one declaration, but the price is that
every install in the profile has to be made to leave those links alone: npm prunes and reifies
`node_modules` on its own schedule, links need a privilege Windows does not always grant, and a
rebuilt distribution (`pi update`, a new build) would silently leave the profile pointing at
nothing. It would also fight the peer resolution npm performs for every declared package, which is
the mechanism that put the tree there. The alias in pi's loader already gives the *behaviour* of a
single instance; pinning gives the *version*; a filesystem trick would mainly save disk.

**Consequences:** The two trees can no longer disagree on a version: bumping the runtime moves the
profile with it on the next load, and a package that publishes a newer pi than the runtime is
inherited only when PiCode chooses to bump. The duplication (and npm's own nested `typebox` copies)
stays, and is now harmless rather than dangerous. The derivation lives in one place and reads the
truth on disk, so a dev tree that never ran the runtime step simply does no family work.

## ADR-030 — Durable leaves the product; pi's own transcripts are the conversations

**Status:** accepted. Supersedes ADR-018, ADR-020 and ADR-021, and the durable half of ADR-022.

**Context:** The owner decided that PiCode is **pi plus Gentle AI** (gentle-pi and gentle-engram):
"quiero quitar todo durable, ya que impacta con Gentle en ciertas cosas". The durable agent was a
second runtime beside pi — its own daemon, storage, subagent runner and memory protocol — and the
two overlap with what gentle-pi brings: its subagents already run as pi processes and its memory
protocol is its own. Keeping both meant two sources of subagents and two sources of memory rules.

**Decision:** The durable agent is removed from the product: `host/durable`, its chat bridge, the
connector files that spoke to it, its commands, its `picode.durable.*` settings, the first-run
"long jobs" switch, the Status card, the session type and the build step that packed it.

- The panel's **one list is pi's own transcripts** (`sessions-register.ts`, over the files pi writes
  under the profile's `sessions/` folder). Opening one continues it in place (`sessions-resume.ts`).
- The **Tasks** block shows the chat's background jobs. gentle-pi's subagents join it when gentle-pi
  enters the profile.
- Memory is Engram, served to pi by gentle-engram once it enters; the protocol file written for
  durable is gone.

**Consequences:** Work no longer outlives the window. Conversations that durable alone held
(`data/durable`) are not migrated and stop being listed; pi's transcripts, which the chat has always
written, are the record from here on. The pi-durable package leaves the product's dependencies.
ADR-022's rule that Engram is the product's memory stands; its "durable stays the record" half does not.

## ADR-031 — gentle-pi and gentle-engram enter as pinned packages of the product

**Status:** accepted. Supersedes the "gentle-engram does not enter" half of ADR-022 and the
left-behind list that enforced it.

**Context:** With durable gone (ADR-030) the product is pi plus Gentle AI. gentle-pi brings the
method, ten roles and the review tools; gentle-engram brings pi its memory tools. Both were
blocked: `left-behind-packages.ts` named them, and an import refused to copy them.

**Decision:**

- The block is lifted: `LEFT_BEHIND_PACKAGE_NAMES` is empty (the mechanism stays for a future
  refusal).
- `product-packages.ts` pins **gentle-pi 4.3.0** and **gentle-engram 0.4.2** at exact versions.
  Every run of the package installer declares them in the profile's `settings.json` as pinned, in
  place of whatever an import, an old profile or a hand edit left — ranged, unpinned or filtered
  differently.
- gentle-pi is **narrowed** through pi's own package filter: its terminal experience (banner,
  sounds, pretty printer, prompt history, Herdr, statistics, shell, usage metrics, resume hint) is
  excluded. Method, roles, tools and review stay.
- `product-env.ts` fixes the environment of pi and of every npm run: `GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1`
  (a package's install script fetches nothing; on Windows it would compile a helper with Go, so
  the review operations that need that helper stay off in this delivery), and `DO_NOT_TRACK=1` plus
  `GENTLE_AI_TELEMETRY=0` (gentle-pi reports usage by default; PiCode sends nothing).
- Memory is gentle-engram's. The `engram` MCP declaration this product wrote is removed (a
  second set of tools would offer the model the same memory twice), the `<memory>` prompt section
  and `memory-protocol.ts` are gone, and `ENGRAM_BIN` is set before pi loads to the engine the
  installation carries, so the chat and the Memory panel read the same store (`~/.engram`).

**Consequences:** The helper binary and its review operations are not part of this delivery; a
later decision may carry a pinned build in `resources/`. gentle-pi's subagents still run as pi
child processes and are not yet in the Tasks block; routing them there is the next step. The
engine stays at 3.5.1 (gentle-engram 0.4.2 accepts any stable core from 3.0.0).

## ADR-032 — The Tasks block draws gentle-pi's subagents from the push it already makes

**Status:** accepted. Completes ADR-030 (the Tasks block lost durable's work) and ADR-031.

**Context:** gentle-pi runs its subagents as child pi processes and publishes their live state to
an interactive host through pi's one structured push, `setWidget("gentle-agents", [json])`, shaped
`gentle-agents.activity/v1`. It does so only when pi runs with `GENTLE_SHELL_INTERACTIVE_HOST=1` in a
mode with a UI. The chat's bridge answered every `setWidget` with nothing.

**Decision:** The signal is set on this process (`product-env.ts`, `HOST_ENV`) and the bridge's
`setWidget` hands the push to `gentle-agents-store.ts`, which keeps only a whitelisted summary per
task — role, label, state, times, last step, turns, tool calls, error — and never the prompt, the
thread or a tool's output. The Tasks block shows the agents still going under *Running*, after the
background jobs, and the last five that ended under *Finished*; each opens to its facts. The store
is cleared whenever the session that published it is rebuilt or disposed. Nothing else reads the
push: any other widget is still the terminal's, and the chat owns that surface.

**Consequences:** The block shows what gentle-pi says and no more: nothing here starts, stops or
answers an agent. The signal also tells gentle-pi it has dialogs, so its questions arrive as chat
questions; the chat never asked before, and gentle-pi's own permission modes are now the ones in
play. Unverified in a running editor.

**Addendum (2026-10-25, found running pi with the two packages).**

- gentle-pi keeps its own files (settings, scratch folders, notes) in `~/.pi/gentle-ai` unless
  `GENTLE_PI_CONFIG_HOME` says otherwise — the machine's own pi. The product sets it to
  `<profile>/gentle-ai` (`product-env.ts`, `configHomeEnv`), so nothing of gentle-pi's lands outside
  PiCode's profile.
- `@earendil-works/pi-durable`, the durable agent's own package, is now the left-behind list
  (`left-behind-packages.ts`): an import does not bring it, nothing installs it, and the update check
  no longer offers to update it. The update notice that named it came from a stored snapshot of a
  profile that declared it.

**Addendum 2 (2026-10-25, found when the Tasks block stayed empty after an agent ran).**

- A profile imported from another pi can carry other subagents and another memory next to gentle's:
  `@tintinweb/pi-subagents` (an `Agent` tool), `pi-interactive-subagents` and `pi-memory`. The model
  picks whichever tool it likes, so work run by the other one never reached the Tasks block, which
  draws gentle-pi's agents. PiCode is pi plus Gentle AI, so there is **one** of each: gentle-pi's
  `subagent_run` and gentle-engram.
- Those three join the left-behind list (an import does not bring them, nothing installs them, the
  update check does not offer them) and, in a profile that already declares them as plain entries,
  are **switched off** by the package installer (`product-packages.ts`, `DISPLACED_PACKAGE_NAMES`):
  still declared, `extensions`/`skills`/`prompts`/`themes` empty, so nothing of theirs loads. An
  entry already written as an object is the owner's own choice of what to load and is left as it
  is, which is also how it is switched back on.

**Addendum 3 (2026-10-25, found when the first gentle-pi agent failed with `spawn pi ENOENT`).**

- gentle-pi starts each subagent as a child pi process. It reuses the pi entry the current process was
  launched with (`process.argv[1]`, when it is a `cli.js`) and otherwise runs `pi` from the PATH — which
  an editor does not have, so every agent failed at once and the Tasks block showed it: *failed · could not
  start pi*. The environment variable it offers for this (`GENTLE_PI_AGENTS_PI`) is split on spaces, so a
  path like `C:\Program Files\…` or `PiCode Experimental.exe` cannot go through it.
- `pointChildPiAtThisPi` (`product-env.ts`) sets `process.argv[1]` to the runtime's `cli.js` and
  `ELECTRON_RUN_AS_NODE=1`, so the editor's binary is started as Node over pi's script. It touches nothing
  when there is no runtime at that path (an external pi).
- gentle-pi's `review-*` agents are not general-purpose: they run only inside its native review, which
  needs the helper program the product does not install (addendum 1). Tasks is verified with
  `gentle-ai-explore`.

### Adenda 4 (2026-10-25) · Los modelos de los agentes de gentle se eligen desde el editor

> *"gentle-ai hay que configurar modelos… quiero que pueda usar /gentle models para configurarlo,
> como en el TUI, quiero poder los modelos que yo quiera a cada uno"*

- **Por qué hacía falta:** un agente de gentle sin modelo propio responde con el modelo por defecto del
  perfil, que no tiene por qué ser el del chat. Así falló el primer subagente de verdad: el modelo por
  defecto tenía la cuota mensual agotada (402) mientras el del chat respondía.
- **Dónde se guarda:** el mismo fichero que usa gentle, `<perfil>/gentle-ai/models.json`
  (`{agente: {model, thinking}}`). Gentle lo aplica a sus agentes **cada vez que arranca una sesión de
  chat**; por eso al guardar se reinicia la sesión del chat y el cambio vale desde el siguiente mensaje.
  Un agente devuelto a «el mismo modelo que el resto» se guarda como entrada vacía (así gentle borra el
  que escribió antes).
- **Dónde se elige:** `/gentle:models` en el chat y la fila *Choose models for agents* de la vista de
  estado (comando `picode.agents.chooseModels`). El panel de pantalla completa de gentle no se puede
  dibujar en el editor (`ui.custom` es nulo), así que el editor lo contesta con sus propios selectores:
  agente (o todos) → modelo (los que el editor alcanza, o uno escrito a mano) → esfuerzo. Los agentes
  `review-*` no salen: solo funcionan dentro de la revisión nativa.
- **Pendiente:** una opción en los ajustes del chat (hoy solo comando y fila de estado).
- **Onboarding (2026-10-25):** el paso del modelo dice que los agentes usan ese mismo modelo y que cada
  uno puede tener el suyo con `/gentle:models`. No se pregunta nada más ahí: la ventana de setup se abre
  sin el editor y los selectores viven en él.
- **Transcripción de un agente (2026-10-25):** cada fila de agente en Tasks tiene el icono *Open Transcript*
  (`picode.tasks.openTranscript`, también en el clic derecho). Abre un panel propio con la tarea, los pasos
  en una línea de tiempo (lo que dijo, pensó y llamó, con su salida plegada) y la respuesta. **Se actualiza
  solo** mientras el agente trabaja: gentle publica el estado de cada tarea con sus últimos pasos y el panel
  se redibuja en cuanto llega (sin perder dónde estabas; si estabas al final, sigue el último paso). Al
  terminar lee el registro completo que gentle guarda (`<perfil>/gentle-agents/tasks/<id>.json`). Solo
  muestra lo que el registro tiene. Un segundo clic sobre el mismo agente trae el panel que ya está abierto.
- **En Chat Settings (2026-10-25):** *Providers & Models* tiene una tercera pestaña, **Agents**: una fila por
  agente de gentle con dos listas (modelo y esfuerzo) y, arriba, «Every agent» para dar el mismo modelo a
  todos. Cada cambio se guarda al momento en el mismo fichero (`picode.agents.models` lee,
  `picode.agents.setModel` escribe; pide un agente, un modelo `proveedor/modelo` y un nivel válidos o lo
  rechaza) y reinicia la sesión del chat. Un agente en «Same model as the rest» usa el modelo con el que
  abren las conversaciones nuevas. El esfuerzo puede ir solo, sin modelo.
- **Persona y permisos (2026-10-25):** la pestaña se llama ahora **Gentle AI** y empieza por dos
  preferencias de gentle: *How it talks* (persona: Gentleman o Neutral, en `<perfil>/gentle-ai/persona.json`)
  y *Permissions for new conversations* (Normal, Auto o YOLO, en `permission-mode.json`, con la línea de
  esquema que gentle exige). Es el mismo valor que `/gentle:persona` y `/gentle:mode default …`, en el mismo
  formato, así que lo que cambia uno lo lee el otro. Un fichero de permisos que gentle no puede leer no se
  reemplaza: se avisa y el control queda apagado. Cada cambio reinicia la sesión del chat. Los permisos de
  *esta* conversación siguen cambiándose con `/gentle:mode`.

## ADR-033 — pi-intercom viene de serie: las sesiones de pi hablan entre sí

**Estado:** aceptada (2026-10-26).

> *"Haz que venga de serie"* (sobre pi-intercom, el paquete que deja hablar a las sesiones de pi)

**Contexto:** sin pi-intercom, dos sesiones de PiCode no pueden mandarse mensajes. Los subagentes de
gentle-pi hablan con quien los lanzó, dentro de la misma conversación, y engram solo deja notas para
después. El dueño lo usa en su pi del PATH y lo quiere en el producto.

**Decisión:**

- `pi-intercom@0.18.1` entra en `PRODUCT_PACKAGES` (`product-packages.ts`), fijado como gentle-pi y
  gentle-engram, entero (sin filtro): sus herramientas y su skill.
- **Sus datos se quedan en el perfil:** pi-intercom guarda su estado en `<carpeta de agente>/intercom`, y
  esa carpeta es la que PiCode fija con `PI_CODING_AGENT_DIR`. Nada va a `~/.pi`.
- **Su intermediario arranca sin Node instalado:** pi-intercom levanta un proceso intermediario con `node`
  cuando el proceso actual no es Node, y el editor no lo es. `intercom-config.ts` escribe en
  `<perfil>/intercom/config.json` solo `brokerCommand` (el ejecutable del editor) y `brokerArgs` (`--import`
  y el cargador de tsx del perfil). El editor arranca como Node porque `ELECTRON_RUN_AS_NODE` ya está puesto
  para los procesos hijos (ADR-031, adenda 3). El resto del fichero es del dueño y no se toca. Solo con el pi
  que lleva el editor: un pi externo tiene su propio Node y sus propios ficheros.
- El intermediario se cierra solo unos segundos después de que se desconecte la última sesión.

**Pendiente de verificar en la app:** que un mensaje entrante abra un turno visible en el chat. Los
comandos de pi-intercom que pintan paneles del terminal (`/intercom`, `/handover`) no se pueden dibujar en
el editor (`ui.custom` es nulo). Las herramientas, que son lo que usa el agente, no dependen de eso.

**Adenda 1 (2026-10-26) · Cada chat es su propia conversación de pi**

> *"si hazlo"* (a dar a cada chat del editor su propia conversación de pi)

- **El fallo:** el chat tenía una sola sesión de pi por ventana. Un chat nuevo del editor (el «+») seguía
  escribiendo en la conversación anterior: el agente recordaba lo que la pantalla no enseñaba, la lista
  Sessions mostraba una fila para dos chats y pi-intercom veía una sola sesión.
- **Ahora:** `agent.ts` guarda una conversación por chat, por el `sessionResource` de la petición: su sesión,
  su transcripción, sus servicios y lo que la construyó. El chat que habló el último es el que leen la vista
  de estado, la lista de comandos y la de MCP.
- **Al recargar la ventana,** un chat que el editor restaura sigue en su propio fichero: la relación chat →
  fichero se guarda en el estado del espacio de trabajo y se reabre con `SessionManager.open`, si el fichero
  sigue donde ese ámbito los guarda.
- **Nombre:** cada conversación se llama como la primera línea de su primer mensaje (`conversationName`). Es
  el nombre con el que otra sesión la encuentra en pi-intercom.
- **Tope:** como mucho seis chats con sesión viva. El que lleva más tiempo sin usarse suelta su sesión y
  conserva su fichero: con el siguiente mensaje se reabre.
- **Siguen de uno en uno:** los turnos de chats distintos esperan su vez, porque la puerta de permisos y el
  testigo de las herramientas MCP del editor son de la ventana.

### Adenda 2 (2026-10-27) · El chat puede leer las conversaciones anteriores

**Contexto.** pi-intercom solo llega a las conversaciones que están en marcha, y la memoria solo guarda lo que
se guardó a propósito. Una conversación de ayer, o de antes de cerrar PiCode, quedaba fuera de alcance: el dueño
preguntó «¿cómo me llamo en la otra sesión?» y el chat no tenía forma de mirarlo («sí, haz que pi pueda buscar y
leer mis conversaciones anteriores de la lista Sessions»).

**Decisión.** Cada sesión de pi del editor lleva dos herramientas propias, de solo lectura
(`extensions/picode/src/past-conversations.ts`):

- **`past_conversations`**: la lista de conversaciones de la ventana, la misma que enseña Sessions, de la más
  nueva a la más vieja; con `query`, solo las que contienen ese texto, con un trozo alrededor de cada acierto.
- **`read_past_conversation`**: los mensajes de una, por su id, a páginas de 24 000 caracteres.

- **La misma lista que Sessions:** se lee en cada llamada, así que una conversación acabada hace un minuto ya
  está. Los transcríptos de subagentes no entran, igual que en el panel.
- **Lo que se lee es lo que se dijo:** el texto del usuario sin el marco que el editor añade y las respuestas,
  sin pensamiento ni resultados de herramientas.
- **El id va entero:** los ids de pi empiezan por la hora, y dos conversaciones del mismo minuto comparten los
  primeros caracteres.
- **Solo el pi interno:** con el pi externo no se dan; su historia no es de PiCode.

## ADR-034 — Actualizaciones pequeñas: hotfix, minor update y release

**Estado:** aceptada (2026-10-27).

> *"Hay que pensar un sistema de hotfixes rápidos para esto que no sea rebuildeando todo."*
>
> *"No quiero subir una 0.3.2 a 0.3.3 y encontrarme problemas y errores."*
>
> *"y en vez de hablar de fixes solo añadimos también "minor update" en plan un pack de fixes + alguna mejora nueva"*

**Contexto:** cada arreglo obligaba a que todo el mundo bajase la app entera. Los `patches/` ya no existen
(se borraron el 2026-09-27) y no habrían servido: la app instalada es un árbol de ficheros, no un código que
se parchee por líneas.

**Decisión:**

- **Una sola numeración.** Cada hotfix es una versión de verdad; no hay contador de fixes. Lo que cambia es
  lo que se descarga: quien está en la versión anterior exacta (portable) recibe un zip con solo lo que
  cambió; todos los demás, la release completa. El resultado es el mismo.
- **Tres etiquetas** que pone el pipeline mirando los commits (`release.mjs kind`): *Hotfix* (solo arreglos),
  *Minor update* (hay alguna novedad) y *Release* (no cabe en un zip pequeño). Se puede cambiar con
  `UPDATE_KIND_OVERRIDE`. La etiqueta no decide la descarga.
- **Lista de lo permitido, no de prohibiciones:** el zip solo puede tocar `resources/app/out`, las
  extensiones integradas, los medios, el asistente de primer arranque y unos campos de `product.json` /
  `package.json`. Nunca binarios. Lo demás obliga a release completa, y lo comprueba la herramienta.
- **El paquete sale de las dos builds reales** y se **prueba antes de publicarse**: build vieja + paquete debe
  dar exactamente la build nueva, fichero a fichero. Si algo falla, no hay paquete y la release sale entera.
- **Se aplica sobre una copia**, firmado (Ed25519, clave pública en `product.json`), con hash de cada fichero
  antes y después, y sin tocar el perfil portable. Cualquier fallo vuelve a la descarga completa.
- **La versión nueva tiene que demostrar que arrancó** antes de borrar la anterior; si no, el script de cambio
  la quita y devuelve la anterior con el perfil. Esto vale también para las actualizaciones completas.
- **Un Hotfix espera 6 h** en vez de las 120 h de `update.minReleaseAge`; las otras etiquetas esperan lo de
  siempre. La fecha del feed no se toca («nunca se toca la fecha del feed para acelerarlo» sigue en pie).

**Fallo que ya existía y se arregló al probar el script de cambio:** el script de la actualización portable
vivía dentro de la carpeta que mueve. Al moverla, Windows no encontraba la línea siguiente y la actualización
se quedaba a medias (sin volver a poner el perfil ni arrancar el editor). Ahora vive fuera de las dos carpetas.
También llama a `tasklist`, `find` y `taskkill` por su ruta de Windows: con Git en el PATH, `find` era el de Unix.

**Consecuencias y límites:**

- No evita construir la release completa; evita que la gente la descargue entera.
- Solo la versión portable. Solo desde la versión anterior. Pi, engram y las dependencias no viajan en un
  zip pequeño (no se ha mirado qué hay dentro de `resources/pi-runtime`).
- La prueba de arranque no es una prueba funcional.
- Detalle y uso: [`HOTFIX.md`](HOTFIX.md).

### ADR-031, adenda 5 (2026-10-27): gentle-pi 4.4.0

- `product-packages.ts` pins **gentle-pi 4.4.0**. The release adds three extensions that have no place in the editor, excluded through the same package filter: `gentle-music` (hands the whole terminal to a player), `gentle-voice` (microphone dictation, downloads components on request) and `gentle-design` (a local canvas server that opens a browser tab). Its new `design` skill still loads; without the extension it has no tools behind it.
- It is a pin in `extensions/picode`, so it fits a hotfix or minor update (ADR-034); gentle-pi is installed in the profile from npm, not shipped in `resources/pi-runtime`.
- The package row no longer offers Update for a pinned package: the pin put the old version back, so the button only ended in a refusal.


### ADR-031, adenda 6 (2026-10-28): gentle-pi 4.5.0

- `product-packages.ts` pins **gentle-pi 4.5.0**. No new extension files: the same terminal-only filter from 4.4.0 still covers everything that has no place in the editor.
- What changes for the editor: the Jobs card now keeps finished jobs for a minute (terminal sidebar only); `/gentle:models` was renamed `/gentle:profiles` inside gentle-pi, but the editor answers the typed `/gentle:models` itself, so the chat keeps working; the models screen now offers only the effort levels each model supports; `gentle-shell update --latest` and an installer for the music player are terminal-only.
- Still a pin in `extensions/picode`, so it fits a hotfix (ADR-034).
- What the editor does with it: the agent model picker offers only the effort levels each model supports (a model that cannot think is not asked); the Tasks block lists the last five background jobs that ended, among the finished agents, newest first; and `/gentle:profiles` opens the same agent model picker as `/gentle:models` in the chat.

## ADR-035 — Las piezas de Gentle AI se actualizan solas, sin dejar de estar fijadas

**Estado:** aceptada (2026-10-29).

> *"habría tener un sistema para poder actualizar gentle-ai aunque sea casi automatizado o full automatizado, ya que tenemos pinneado esto. Imaginam que mañana y pasado y el dia siguiente salen versiones nuevas de gentle-pi o engram."*

**Contexto:** el producto fija cuatro piezas a versión exacta (ADR-031, ADR-033): los paquetes de pi
`gentle-pi`, `gentle-engram` y `pi-intercom` (`extensions/picode/src/product-packages.ts`) y el motor de
memoria (`build/distribution/engram.json`). Fijar es lo que impide que alguien reciba una versión que
nadie probó, pero cada subida se hacía a mano (adendas 5 y 6 de ADR-031). Al escribir esto ya había dos
pendientes: gentle-pi 4.5.1 y engram 3.6.0.

**Decisión:**

- **Siguen fijadas.** Lo que se automatiza es *mover* el pin, no soltarlo: el perfil nunca flota.
- **`build/pins.mjs`** busca la versión estable más nueva con **al menos 24 h** publicada (una versión
  rota o comprometida suele retirarse en horas) y, en npm, **nunca por encima de la etiqueta `latest`**
  (gentle-engram 0.5.1 está publicado como `candidate`, y no se coge). Lee lo que cambia entre los dos
  paquetes publicados y decide:
  - **Segura:** nada de lo de abajo. Se aplica sola.
  - **A revisar**, con el motivo escrito: salto mayor (o de menor en un 0.x); una extensión nueva que pi
    cargaría (el caso de gentle-pi 4.4.0, que trajo tres de terminal que hubo que filtrar); cambios en
    el manifiesto de pi, en los scripts de instalación o en los nombres de dependencias; un rango de pi
    que ya no incluye el pi que lleva el producto (`runtime.json`); y **siempre el motor de engram**,
    porque su almacén (`~/.engram`) es compartido y un motor nuevo puede migrarlo. Ese paso va en una
    release completa, nunca en un zip pequeño (ADR-034). Del motor se descargan los dos zip de Windows y
    se comprueban contra el `checksums.txt` de la release antes de escribir sus SHA-256.
- **`.github/workflows/pins.yml`**, una vez al día, una rama y un PR por pieza (`bot/pin-<nombre>`) contra
  `experimental`. Pasa las pruebas del conector allí mismo (un PR abierto con el token del flujo no
  arranca CI). Seguro y en verde → **se fusiona solo**. Si no → se queda abierto con los motivos. Una
  versión más nueva refresca el mismo PR.
- **Cerrar el PR sin fusionar = saltar esa versión.** El bot no la vuelve a proponer; propone la siguiente.
- **La release no se automatiza:** lo fusionado sale con la próxima release del canal, como cualquier
  otro cambio. Una subida de los paquetes de pi cabe en un hotfix; la del motor, no.

**El recorrido entero** (del autor al perfil de cada persona, con los tiempos): [`PINS.md`](PINS.md).

**Uso a mano:** `node build/pins.mjs check` (qué hay nuevo), `node build/pins.mjs audit gentle-pi 4.3.0 4.4.0`
(qué cambia entre dos versiones, sin escribir nada), `node build/pins.mjs bump <pieza>` (mueve el pin).

**Límites:**

- El flujo programado solo corre cuando el fichero está en la rama por defecto (`master`); hasta entonces
  se puede lanzar el script a mano.
- La auditoría lee el paquete, no lo ejecuta: una extensión que ya existía y cambia por dentro pasa como
  segura si lo demás encaja. Lo que la protege son las pruebas del conector y el canal experimental.
- Pi (`runtime.json`) no entra: sus subidas llevan una revisión escrita a mano y viajan en release completa.

### Adenda 1 (2026-10-29) · Todo se actualiza desde la app; el pin es el mínimo

> *"nono quiero que se pueda actualizar todo desde la app, desde pi, engram, gentle, etc. Si sacan actualizaciones como mucho sus features hasta que nosotros no la integremos 100% en el editor no funcionarán pero poco más. Pero pueden arreglar bugs y demás."*

**Contexto:** pi ya se actualizaba desde *Updates* y el motor de engram desde la vista Memory, pero los
paquetes de Gentle AI no: el pin volvía a poner su versión en cada arranque, y su fila no tenía botón
(ADR-031, adenda 5). Además, una actualización del motor bajada por el usuario tapaba para siempre al que
trajera una PiCode más nueva.

**Decisión:**

- **El pin es el mínimo.** `withProductPackages` (`product-packages.ts`) conserva una declaración a versión
  exacta **más nueva** que el pin; una más vieja, un rango o una prerelease vuelven al pin. Una
  actualización de PiCode solo sube un paquete, nunca lo baja.
- **Los paquetes de Gentle salen en *Updates*** con el resto (`gatherUpdateCandidates`, `extension.ts`), y
  su fila en la página de paquetes vuelve a tener **Update**. Actualizar escribe la versión nueva en la
  declaración del perfil (`withProductPackageVersion`) y la instala; si la instalación falla, la
  declaración vuelve a la anterior.
- **El motor de engram también sale en *Updates*** (tipo `engine`). El mismo **Update** lo baja a
  `~/.picode/memory` (`memory-update.ts`), como ya hacía la vista Memory.
- **El motor del usuario cede ante uno más nuevo de PiCode:** cada motor lleva al lado un `engram.version`
  (lo escriben la build y la actualización de la app) y `firstEngramBinary` usa el de PiCode cuando es más
  nuevo. Si alguno no dice su versión, gana el del usuario, como antes.
- **El bot de ADR-035 sigue:** sube el mínimo para todos y se queda con su auditoría. La app es para quien
  quiere la versión nueva ya.

**Consecuencias:**

- Una versión nueva puede traer funciones que el editor no enseña (comandos de terminal, paneles); sus
  arreglos llegan igual. Una extensión de terminal nueva **sí carga** hasta que el bot la añada al filtro.
- El motor nuevo arranca la próxima vez que se abre PiCode (el que está en marcha no se para), y puede
  migrar `~/.engram`, que es compartido.
- pi se actualiza dentro de la instalación: la siguiente actualización de PiCode vuelve a poner el suyo, y
  *Updates* lo vuelve a ofrecer si había uno más nuevo.
- Solo con el pi interno; con el externo (PATH), *Updates* sigue callado.

## ADR-036 — Los límites de ChatGPT y Claude, en la vista de estado

**Estado:** aceptada (2026-10-29).

> *"Sí, tráelo"* — a la propuesta de traer al editor el consumo de las cuentas que enseña Gentle Shell.

**Contexto:** Gentle Shell es el nombre nuevo de la parte de terminal de gentle-pi (la barra, el panel
lateral, el lanzador `gentle-shell`). El editor ya carga gentle-pi pero deja fuera esa parte
(`GENTLE_PI_TERMINAL_EXTENSIONS`), porque dibuja en la terminal. De todo lo que enseña, lo único que el
editor no tenía era su panel de consumo de suscripción: la tarjeta *Usage limits* solo sabía leer NaN.

**Decisión:**

- La tarjeta *Usage limits* enseña también **ChatGPT (Codex)** y **Claude Pro/Max**
  (`extensions/picode/src/subscription-usage.ts`), con los mismos datos que el terminal: cada ventana
  (5 horas, semanal…), el porcentaje usado, cuándo se reinicia y si se llegó al límite. El proveedor del
  chat va primero.
- **Dos vías, las del terminal.** Las cabeceras de cada respuesta del chat, que pi entrega a una extensión
  propia del chat (`usageHeadersExtension`, en `agent.ts` y en las conversaciones reabiertas); y, para
  ChatGPT, el endpoint de consumo que lee el propio Codex, con la sesión que pi ya tiene guardada, como
  mucho una vez por minuto. Claude no tiene endpoint: su tarjeta aparece con la primera respuesta.
- **No se escribe nada.** Un token caducado no se renueva desde aquí (renovarlo reescribe `auth.json`); se
  enseña lo último que dijo una respuesta. Las cabeceras se leen y se olvidan; solo quedan las ventanas.
- **Avisos a 80 % y 95 %**, los del terminal: la barra pasa a aviso desde el 80 % y a error desde el 95 %
  (antes 60 % y 90 %), en todas las tarjetas de consumo.
- **No se integra el resto de Gentle Shell:** el lanzador y su actualización (escriben en `~/.pi`), la
  barra, el panel lateral, el editor de mensajes y el menú de comandos tienen ya su sitio en el editor.

**Consecuencias:**

- Proveedores que otras extensiones registran en gentle-shell (`gentle-pi:usage-source/v1`) no se ven: ese
  canal vive dentro de la extensión de terminal, que sigue apagada.
- El contador de la barra de estado sigue siendo solo de NaN (habla de tokens y del periodo de pago, que
  ChatGPT y Claude no dan).
- Es código del conector y una línea de la vista de estado: cabe en un hotfix (ADR-034).
