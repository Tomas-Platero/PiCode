# Contributing to PiCode

PiCode is a VSCodium distribution built from source, with the [Pi](https://pi.dev) coding
agent integrated into the
editor core — not as side extensions.

Three things to read before anything else:

- [README.md](README.md) — what the repository holds and the two build paths.
- [docs/DECISIONS.md](docs/DECISIONS.md) — the ADRs. Several look counter-intuitive (no fork,
  pinned upstreams, deleted product keys) and each has its reason written down.
- [AGENTS.md](AGENTS.md) — the owner's own words. It is Spanish on purpose; it is the product
  contract, not documentation.

## Which path are you on

| You want to… | You work on… | Start with |
| --- | --- | --- |
| Use PiCode | nothing — download a release | [Releases](https://github.com/Tomas-Platero/PiCode/releases) |
| Change branding, defaults, or what is removed from the product | `distribution/product-delta.json` and the apply scripts | [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) |
| Change editor behaviour | `picode-source/` — the TypeScript itself | [docs/howto-build.md](docs/howto-build.md) |
| Change the agent integration | the core connector and agent host under `picode-source/extensions/picode/` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Fix the pipeline | `dev/` (bash) and `.github/workflows/` | [docs/CI.md](docs/CI.md) |

## Building from source

The scripts are **Bash** — on Windows run them from Git Bash, PowerShell will not work.

```bash
./dev/build.sh          # check the source, install what is missing, compile, pack, stage
./dev/build.sh -o       # check the source only: seconds, nothing installed or compiled
./dev/build.sh -i       # install the dependencies even when the recorded state still matches
```

`./picode-source` is PiCode's own source, not a download: it already carries the VSCodium
patch set, PiCode's changes and the PiCode product identity, and it is committed **in its own
git repository inside that folder**. The PiCode repository ignores it. Building is therefore
local work on the tree: there is no fetch and no patch step to wait for, and the dependencies
are installed once instead of on every build.

Dependencies (Windows): Git for Windows, Node matching `.nvmrc`, Python 3.11, Rustup,
and Visual Studio 2022 with the **Spectre-mitigated libraries** — without that component the
native modules stop with `error MSB8040`. The authoritative list of checks lives in
[`dev/build-requirements.mjs`](dev/build-requirements.mjs); run it and it tells you what this
machine is missing. `jq` is no longer needed by the build: the JSON it touches is read and
written by node.

There is also a graphical front-end, [`builder/`](builder/README.md) (C# / WinUI 3, drives the
same scripts; needs only the .NET SDK).

`picode-source/` is **not** a build output any more: it is the source, and it is versioned in
this repository (decided by the owner on 2026-09-27: one clone carries everything). `PiCode-*`
still is a build output and is ignored. Because Microsoft's source now lives in this tree, the
old "never upload it here" rule moved up a level: **this repository must never be pushed to a
public remote** — publishing it is the owner's decision alone, never a collaborator's or an
agent's. The pre-import history of the tree is kept in a bundle outside the repository
(`.scratch/picode-source-history.bundle`).

## The pin

`upstream/stable.json` records the VS Code commit the tree descends from (`08d4889f`, 1.135.0).
It no longer drives the build — nothing is fetched or patched any more, and the VSCodium patch
machinery was deleted on 2026-09-27 — but it is the provenance of the tree and the starting
point for the day a newer VS Code is brought in. That day is a **merge**, and
[docs/howto-build.md](docs/howto-build.md), section *Traer una versión nueva de VS Code*, is the
plan (unexercised so far).

## Rules that have burned us before

- **A key that core iterates must be empty, not absent.**
  `builtInExtensionsEnabledWithAutoUpdates` missing crashed the editor; the delta keeps it as
  `[]`.
- **A nested object that core dereferences must be pruned, not deleted.** Removing
  `defaultChatAgent` wholesale produced a blocked grey window; its endpoint keys are removed
  individually instead.
- **Never overwrite the `vscode` extension API namespace, internal `out/vs/**` paths, real
  extension IDs, the Open VSX API URL, or the legal notices.** "VSCodium" legitimately
  remains in some binary names (`@vscodium/native-keymap`, ripgrep) — it is the upstream base
  and pretending otherwise would be false.
- **Reverse-applying a patch does not prove it applies forward.** Test against a clean copy.
- **Never edit a running bash script** — `dev/build.sh` will be re-read mid-flight.

## Language

Every string the product shows is **English** (ADR-012): dialogs, notifications, command
titles, settings descriptions. Code, comments, commit messages and docs aimed at GitHub are
English too. Spanish stays where it is the conversation rather than the product: `AGENTS.md`
and the feature records in `odd/tasks/`. Other languages come later through language packs —
do not translate sources in place.

## Style of work

- One reviewable unit per commit and per PR. The project's rule: a human should be able to
  hold the change in their head.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) with
  plain-prose subjects (`fix(build): the heap is sized per system`).
- Do not mark something as done because it compiles. Say how it was **observed working** —
  the log line, the command output, the screen. Every "it compiled but did not work" case in
  this repository is written down in `odd/tasks/`; the list of decisions against shortcuts is
  there too.
- Features leave a record in `odd/tasks/<feature>.md`: what was asked, what was verified,
  what was deliberately not built, and the defects found along the way.

## Tests

The core is verified today by building and running — a fresh-clone build is the first thing
a maintainer will look at in a PR that touches `dev/` or `distribution/`. (The agent-layer
suites used to live inside `extensions/picode-pi-chat/`, hermetic `npm test` plus
`test:live` against a real pi; that folder was deleted on 2026-09-27 by the owner's
decision, and the panel returns as core code, with its tests, when the migration is done.)

## Reporting

Use the issue templates. For anything that could be a security problem, see
[SECURITY.md](SECURITY.md) — do not open a public issue.
