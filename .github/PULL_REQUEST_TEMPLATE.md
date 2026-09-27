<!--
One reviewable unit per PR. If the diff covers two decisions,
open two PRs. Delete these comments before submitting.
-->

## What changes, in one line

## Why

The problem being solved — not the mechanism, which the diff shows.
Link the issue if there is one (`Fixes #…` / `Part of #…`).

## How was it observed working

PiCode's rule: nothing is marked done because it compiles.
Say what you actually ran and saw.

```text
the command / the log line / the screen, pasted here
```

If a surface could only be checked by hand, say so plainly instead
of leaving it implied.

## Which layer

- [ ] `patches/picode/` (source patches — CI pin-check will re-apply them)
- [ ] `patches/vscodium/` (vendored — should be **empty** in a PR; it mirrors upstream)
- [ ] `distribution/` (product delta, settings, apply scripts)
- [ ] Agent integration (core chat / connector / agent host)
- [ ] `dev/` pipeline or `.github/workflows/`
- [ ] Docs / records only

## Review workload

- Approx. lines changed: ______
- Does a pin move? `upstream/stable.json` and `upstream/vscodium.json` move **together**,
  and the VSCodium patch set must be re-vendored — if either is touched here, say so.
- Anything a reviewer should run before reading: `./dev/build.sh -o`, `npm test` in the
  extension, etc.

## Records

- [ ] Feature record added/updated in `odd/tasks/` (expected for any non-trivial change)
- [ ] `docs/DECISIONS.md` updated if a decision changed or an ADR was superseded
- [ ] Product-facing strings are English (ADR-012); Spanish only in `AGENTS.md` and
      `odd/tasks/`
