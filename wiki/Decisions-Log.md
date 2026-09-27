# Decisions Log

The ADRs constrain the shape of the product. Full text with context,
consequences, rejected alternatives and **reversal triggers** lives in
[`docs/DECISIONS.md`](https://github.com/Tomas-Platero/PiCode/blob/main/docs/DECISIONS.md).
This is the index, because several decisions look counter-intuitive until you
read the reason.

## ADR-001
**Layered distribution, not a full fork.** A fork means a multi-GB tree, a
30–90 minute cycle per iteration, and a permanent merge burden against
upstream. Consequence accepted: core behaviour upstream does not expose stays
out of reach on the binary path — each patch against source is a maintenance
tax you pay knowingly.

## ADR-002
**VSCodium as the upstream base.** The official Microsoft binaries may not be
redistributed under a modified brand; VSCodium is the MIT community build and
is redistributable. Consequence: we inherit VSCodium's release cadence and
build choices.

## ADR-003
**Pi as a child process over `pi --mode rpc`, not the in-process SDK.** An
extension host it does not control should not share a crash domain with an
agent that owns cwd, file writes and shell. Gains: process isolation, version
independence, protocol parity with CLI users. Cost: PiCode owns spawn, framing
and correlation. The SDK remains valid for a future embedded mode (and arrived
as an opt-in transport).

## ADR-004
**Windows first for the MVP.** The development machine is Windows; one
platform validated before paying for multi-OS CI. Linux has since been wired
end to end; macOS is explicitly refused by the build.

## ADR-005
**Strict LF-only framing in the RPC client; `readline` is banned from the
protocol path.** `U+2028`/`U+2029` are legal inside JSON strings and Node's
`readline` splits on them — using it would corrupt records. Cost: hand-written
framing, which we own and test.

## ADR-006
**The RPC client forwards payloads after the discriminant check, without
re-validating fields.** The authoritative schema lives in Pi; a second schema
would drift. The risk is bounded at the render boundary: webviews use
`textContent`, never `innerHTML` with untrusted strings.

## ADR-007
**Models are addressed as `provider` + `modelId`, not a single string** — a
corrected assumption: the initial design said `{"model": id}`; the real Pi
schema said otherwise. Kept as the concrete example of the project's rule:
plans die against measured evidence, and the death gets written down.

## ADR-008
**Layer on a stock VSCodium without compiling** — brand via a user-level
`product.json` overlay. *Partially superseded by ADR-011* (PiCode now owns the
tree and compiles from source). The fork path was **deferred with named
trigger conditions**, and those conditions arrived; this ADR is why the deferral
was reasonable at the time.

## ADR-009
**The Pi panel is opt-in, never auto-opened.** A panel that opens itself on
startup steals focus and makes every session begin with something the user did
not ask for. Verified property of the shipped manifest, not a plan.

## ADR-010
**Pin and ship Pi and Gentle AI; never run whatever is on PATH.** Unpinned
means every user runs a different agent, bug reports describe an unknown
version, and integration drift is silent. The pin is owned deliberately: Pi
releases get tested, then the pin moves. `picode.pi.executablePath` keeps the
user's escape hatch.

## ADR-011
**Own the editor tree; delete product keys instead of overriding them.** The
overlay merge can restate a key but never remove one — so Copilot's fourteen
endpoints could not be extirpated by the old path. The tree is owned: the
product is modified by a data delta, the build is compiled from pinned source,
and `updateUrl` is emptied so an in-product updater can never silently replace
a patched tree. Two limits made explicit by running the result: a residual
Copilot default survives in minified core (the effective switch is
`chat.disableAIFeatures`), and keys core iterates must be empty arrays, not
absent.

## ADR-012
**Product copy is English; other languages are language packs.** Mixed-language
dialogs were measured, not styled: the platform appends its own English suffix
to our Spanish prompts and no extension can translate it. The Spanish language
pack works but paints the whole editor, which is not this product's decision to
make for its users. The owner's correction of 2026-09-25 is quoted verbatim in
`AGENTS.md`; the reversal trigger is a world where packs cannot be built.

---
The precedence between papers is documented in
[`docs/README.md`](https://github.com/Tomas-Platero/PiCode/blob/main/docs/README.md):
the owner's words beat everything; then the task list; then the why-papers.
