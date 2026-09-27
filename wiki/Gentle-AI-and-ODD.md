# Gentle AI and ODD

Gentle AI is the **Harness**: the layer that organizes how the agent works —
memory, skills, subagent workflows, review discipline. It is a Pi package,
never a reimplementation, and PiCode's job is to show it in the editor.

## What Gentle AI actually is

Two artifacts share the name, and the confusion is documented upstream:

- **`gentle-ai`** — the Go CLI that installs everything (its binary is bundled
  inside the npm package, so **no Go toolchain is needed by the user**).
- **`gentle-pi`** — the Pi package Pi actually loads (13 skills, 23 subagents,
  4 chains, prompts, themes, orchestrator instructions injected at runtime,
  native review tooling).

Memory comes as a companion package, **`gentle-engram`** (the Engram project):
persistent observations across sessions (`mem_*` tools). PiCode treats it as
one more Pi package.

Requirements Gentle AI assumes: Node ≥ 24, its own config directories, and a
profile it can find. Its config respects `PI_CODING_AGENT_DIR` — which is
precisely the mechanism PiCode uses to keep the internal Pi's profile inside
`data/`.

## ODD — the default workflow

**Organic Driven Development** is Gentle AI's method, and PiCode's sessions
run it by default. Short form:

1. **Authorize** — clarify what is actually being asked; read-only requests
   stay read-only.
2. **Explore** — existing code and requirements before proposing.
3. **Resolve uncertainty** — one focused question only for a real product
   decision; research only for a named gap.
4. **Classify** — small work stays small; substantial work gets tracked.
5. **Track before the first write** — a feature document (`odd/tasks/<feature>.md`)
   and a visible task list.
6. **Implement task by task** — delegate to subagents when the work crosses
   set triggers, commit each work unit, close each task with observed evidence.
7. **Close** — report what is verified, what failed, what remains.

**SDD/OpenSpec is a branch inside ODD**, entered only by explicit request:
proposal → spec → design → tasks → apply → verify → archive, with phase agents
and artifacts. In owner-facing text, "SDD" is never the name of the whole
method — ODD is.

The project's own record proves the loop: every non-trivial change to PiCode
left a document in [`odd/tasks/`](https://github.com/Tomas-Platero/PiCode/tree/main/odd/tasks)
with decisions, observed checks, defects found by independent review passes —
including the embarrassing ones, deliberately kept.

## How the editor shows it

- **Agent Customizations**: the core's discovery table was extended with Pi's
  paths, so Gentle AI's subagents appear in the editor because the host
  discovers them on disk — not because a PiCode panel reads them.
  (Open: skills that live *inside* npm packages are not yet discovered — the
  table cannot express package paths.)
- **First-run wizard** offers the Gentle AI switch; installing it is watchable
  and the chat reloads when it finishes.
- **Review discipline**: gentle-pi carries a native review lifecycle (RDD —
  receipt-driven development) whose switch belongs to the user; PiCode exposes
  its state where the rest of the editor reads state, and writes no policy of
  its own about it.

## What PiCode does NOT do

- No panel, no tab, no custom settings page for Gentle AI (product rule:
  surfaces belong to the editor).
- No reimplementation of skills loading, subagent definitions, or the
  orchestrator.
- No second copy of Gentle AI state — one datum, once.

---
Related: [Pi Inside](Pi-Inside.md) · [Architecture](Architecture.md)
