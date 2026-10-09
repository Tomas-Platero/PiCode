<!--
One reviewable unit per PR. If the diff covers two decisions,
open two PRs. Delete these comments before submitting.

Direct pushes to branches are disabled for contributors; the repository
admin keeps a bypass. Everyone else lands changes through a pull request.
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

- [ ] The editor itself (`picode-source/`)
- [ ] The product layer (`distribution/`, `dev/`, `builder/`)
- [ ] Agent integration (chat, connector, agent host)
- [ ] Build pipeline or `.github/workflows/`
- [ ] Docs and records only

## Review workload

- Approx. lines changed: ______
- Does the VS Code pin move? If `upstream/stable.json` is touched, say so
  and point at the merge that produced the tree.
- Anything a reviewer should run before reading: `./dev/build.sh -o`,
  `npm test` in the connector, etc.

## Records

- [ ] Feature record added/updated in `odd/tasks/` (expected for any
      non-trivial change)
- [ ] The decision log updated if a decision changed or an ADR was
      superseded
- [ ] Product-facing strings are English (ADR-012); Spanish only in
      `AGENTS.md` and `odd/tasks/`
