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
`distribution/runtime.json` — pi `1.1.0` today — and `dev/pi-runtime.sh` installs it into the
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
through a data delta (`distribution/product-delta.json`) applied by a Node
program, and the agent panel ships as a built-in extension. The distribution
remains uncompiled: no fork, no yarn and Electron build, no patch rebasing
against upstream.

**Consequences:**

- Keys can be deleted, not merely overridden, which is what makes the Copilot
  removal real rather than cosmetic.
- The tree was a build artefact and was not versioned; what was versioned was the
delta, the applier, the defaults and the extension, and `.gitignore` fenced the
700 MB payload. **Superseded by ADR-013**: the tree is now `picode-source/`, versioned.
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
his (`AGENTS.md`, `odd/tasks/`). Other languages are reached later by **language packs**,
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

**Decision:** `picode-source/` is PiCode's own, versioned source tree — the VSCodium changes,
PiCode's work and the product identity already baked in. Nothing is fetched or patched per
build; `dev/build.sh` compiles it in five phases, and the product delta is applied to
`picode-source/product.json` **before** packing.

**Consequences:** A core behaviour change is TypeScript in the tree, compiled, with the
checksums computed over the finished product — the `checksums` map that made the minified
bundle untouchable (ADR-011) no longer bounds us. A newer VS Code becomes a **merge against
`picode-source/`** instead of an archive swap. The trade-off accepted: the repository carries
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
in-tree one (`distribution/runtime.json`), and the CLI is used only for what the SDK does not
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
`updates/<channel>/win32/x64/<target>/`, and `dev/build.sh` seals the channel into
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

**Decision:** Keep the tree as it is and raise only `distribution/product-delta.json →
set.version` (1.135.0 → 1.141.1). The pin `upstream/stable.json` keeps telling the truth about
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
`free` ≈ 1 MB, `pro` ≈ 50 MB, enforced in `cloud/sync-api` (`DEFAULT_PLAN_QUOTAS`). The editor
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
