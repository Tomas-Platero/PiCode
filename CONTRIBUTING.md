# Contributing to PiCode

PiCode is a VSCodium distribution built from source, with the [Pi](https://pi.dev) coding
agent and [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) integrated into the
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
| Change editor behaviour | `patches/picode/` (TypeScript patches against the pinned VS Code source) | [docs/howto-build.md](docs/howto-build.md) |
| Change the agent integration | the core connector and agent host under `picode-source/extensions/picode/`, produced by patches | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Fix the pipeline | `dev/` (bash) and `.github/workflows/` | [docs/CI.md](docs/CI.md) |

## Building from source

The scripts are **Bash** — on Windows run them from Git Bash, PowerShell will not work.

```bash
./dev/build.sh          # full chain: fetch, patch, compile, pack, stage
./dev/build.sh -o       # preparation only (phases 1-5), no compile — this is what CI's
                        # pin-check runs, and it takes minutes, not the 20-45 of a build
./dev/build.sh -s       # reuse ./picode-source instead of re-fetching
```

Dependencies (Windows): Git for Windows, Node matching `.nvmrc`, jq, Python 3.11, Rustup,
and Visual Studio 2022 with the **Spectre-mitigated libraries** — without that component the
native modules stop with `error MSB8040`. The authoritative list of checks lives in
[`dev/build-requirements.mjs`](dev/build-requirements.mjs); run it and it tells you what this
machine is missing.

There is also a graphical front-end, [`builder/`](builder/README.md) (C# / WinUI 3, drives the
same scripts; needs only the .NET SDK).

Nothing under `picode-source/` or `PiCode-*` is ever committed — they are build outputs and
git ignores them. **Microsoft's source must never be uploaded to this repository.**

## The two pins

`upstream/stable.json` (the VS Code commit) and `upstream/vscodium.json` (the VSCodium
revision whose patches are vendored verbatim under `patches/vscodium/`) move **together**.
Re-pinning VS Code without re-vendoring the VSCodium patch set is considered a defect, and
`patches/vscodium/**` is never hand-edited — it mirrors upstream exactly.

If a patch stops applying, CI's pin-check goes red and names the patch. The repair process
(semi-automatic and manual) is documented in
[docs/howto-build.md](docs/howto-build.md), section *Arreglar un patch cuando upstream se
mueve*.

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

The agent-layer suites run with `npm test` inside `extensions/picode-pi-chat/` (hermetic, no
editor needed) and `npm run test:live` (needs a real `pi` on PATH). The core itself is
verified today by building and running — a fresh-clone build is the first thing a maintainer
will look at in a PR that touches `dev/`, `patches/` or `distribution/`.

## Reporting

Use the issue templates. For anything that could be a security problem, see
[SECURITY.md](SECURITY.md) — do not open a public issue.
