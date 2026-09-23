# PiCode

> A curated VSCodium distribution with the **pi** coding agent and **Gentle AI** built in as
> first-class surfaces: the chat panel, the settings, the providers, the themes and the
> first-run wizard are part of the editor, not something you install after it.

PiCode is not a plugin for VS Code. It is a distribution: a stock VSCodium tree, branded and
patched, plus one extension that owns the agent layer. Opening PiCode means opening a
working agentic environment — no setup ceremony.

PiCode itself is **free and complete**: no feature is held back, and nothing it does needs a
server to work.

---

## What is in this repository, and what is not

The repository root doubles as the distribution root, because that is what enables portable
mode (a `data/` folder next to the executable). **The ~1 GB VSCodium payload is not
versioned**, and it cannot be: GitHub refuses any push carrying a file over 100 MB, and the
editor's own executable is 212 MB. What is versioned is the layer that turns a stock archive
into PiCode:

| Path | What it is |
| --- | --- |
| `extensions/picode-pi-chat/` | The agent layer: the chat panel, the settings panel, the wizard, the themes, the packages catalog. TypeScript, one extension, no runtime dependencies. |
| `distribution/` | The modification layer as data: `product-delta.json` (branding, gallery, removed endpoints), `settings.json` (first-run defaults), the icon, and `apply-picode.ps1` which applies the delta, creates the portable profile and stages the built extension into the tree. |
| `odd/tasks/` | The **ODD** feature records: one document per feature, with the decisions taken, the checks observed, the defects found and the commits that carry them. This is where the reasoning lives. |
| `docs/` | `ARCHITECTURE.md`, `DECISIONS.md` (ADRs) and `DISTRIBUTION.md` (how the owned tree is built and what was removed from it). |
| `AGENTS.md` | The owner's own words, verbatim (Spanish), with what each one means in practice. Read it before changing product behaviour. |

So a fresh clone is not a runnable editor yet. That is deliberate: shipping the payload
would double the download and, worse, freeze a copy of VSCodium that nobody would update.
Reproducing it takes two steps.

## Getting a runnable tree

Requirements:

- **Node.js 22.19+** — pi's own requirement, not a preference (developed against 24.x)
- **PowerShell 5.1+** (Windows) to run the apply script
- A **VSCodium archive** for your platform ([releases](https://github.com/VSCodium/vscodium/releases)),
  extracted at the repository root
- Optional, for the `path` runtime: **pi** on `PATH`
  (`npm install -g @earendil-works/pi-coding-agent`). PiCode can also install and update
  **its own** pi from the settings panel, which is the recommended path.

```powershell
# 1. Extract a stock VSCodium archive into the repository root (it brings bin/, resources/,
#    locales/, the Electron artifacts and the executable).

# 2. Apply the PiCode layer. Preview first: without -Apply nothing is written.
./distribution/apply-picode.ps1
./distribution/apply-picode.ps1 -Apply
```

The script is idempotent and non-destructive: it previews by default, backs up
`product.json` before its first write, never overwrites an existing `settings.json`, and
reports "already current" on a second run. It creates `data/` for portable mode (user data,
extensions, sessions, cache) and stages the built agent panel into
`resources/app/extensions/picode-pi-chat`.

Then run `PiCode.exe` (or `bin/picode`). The `data/` folder is disposable by design: delete
it and you get a clean PiCode.

## Working on the agent layer

```bash
cd extensions/picode-pi-chat
npm install            # or `npm ci`, the lockfile is versioned
npm run compile        # tsc, strict, no bundler
npm test               # 35 suites, ~1300 checks: no editor, no network, no real profile
```

For a live session: open **`extensions/picode-pi-chat`** as the folder in VS Code (or
VSCodium) and press `F5`. The committed launch configuration in `.vscode/` compiles the
extension first and opens an **Extension Development Host**; run `PiCode: Abrir el chat de pi`
there. Opening the distribution root as the folder is not the same thing — that folder is a
VSCodium tree, not the extension project.

The suites are plain Node scripts, one per module, run by `npm test` in a fixed order. They
check behaviour first and *shape* second — a webview whose script looks up an element the
markup does not have fails a check named after that agreement, because that failure is
otherwise silent. Three suites need a real machine and are **not** part of `npm test`:
`npm run test:live` (a real `pi --mode rpc` session), `npm run test:sdk` (the embedded
transport) and `npm run test:install` (installing the managed pi runtime, ~410 MB).

After changing the extension, run `apply-picode.ps1 -Apply` again: the editor loads the
**staged build** from `resources/app/extensions/picode-pi-chat`, not your working copy.

## What exists today

- **Chat panel** — streaming transcript with tools, reasoning blocks, sessions (list,
  resume, fork), slash commands, and attachments: images, files, video frames and audio
  transcription.
- **Settings panel** — pi's own settings (models, analytics, network, tools, packages,
  skills) next to PiCode's own (`picode.pi.*`), grouped in categories with a search box and
  a global/project scope.
- **Providers** — sign in to a provider from the editor (API key or subscription), and
  declare a compatible endpoint with its own models (`models.json`) — for whichever pi
  instance is selected.
- **Themes** — a gallery with a real preview rendered from each theme's own colours,
  install-and-apply in one action, reachable from the palette, the settings panel and the
  first-run wizard.
- **Two instances** — PiCode's **own** pi (installed and updated from the panel, with its
  profile inside PiCode and isolated from the rest of the machine) or the **external** pi on
  your `PATH`, with a one-shot import that copies a profile instead of sharing it.
- **First-run wizard** — choose the runtime, switch Gentle AI on, choose a theme; all of it
  inside the editor, with no terminal step.
- **Gentle AI** — its panel and its package install, wired to the same state the rest of the
  editor reads.
- **Packages and extensions** — search the pi package catalog (npm registry) and the editor's
  own gallery, list what is installed, install, update and remove.
- **Status and usage** — what pi is using right now (version, providers, sessions, tokens,
  cost) and the session statistics.

How it talks to pi is a setting: `rpc` spawns `pi --mode rpc` as a child process and speaks
line-delimited JSON on stdio; `embedded` loads the same pi inside the extension through its
SDK. Both use the same installation.

## Known state

- The VSCodium payload is not in git, so the first run of a fresh clone is the two steps
  above. Nothing else is missing.
- The interactive surfaces — pickers, dialogs, the theme gallery's clicks — have **no
  automated coverage**: what is tested is every decision around them (what is shown, what is
  written, what is refused), and the click paths are checked by hand.
- The extension inside the distribution is a staged copy. Editing the source is not enough
  until the script runs again.
- A theme that exists only in the **Microsoft Marketplace** cannot be installed here: the
  gallery is Open VSX, which is what this editor installs from. Browse such a theme on
  `vscodethemes.com`, install it here only if it is also on Open VSX.
- The managed pi runtime is installed on demand (about 410 MB) rather than shipped in the
  archive.

## Where the reasoning lives

Every non-trivial change is worked as an ODD feature and leaves a record in `odd/tasks/`:
what was asked, what was verified, what was decided, what was deliberately *not* built, the
defects found (including the ones found by an independent verification pass) and the commits
that carry them. Start there when a decision looks arbitrary — it usually is not, and the
reason is written down.

## License

MIT — see [LICENSE](LICENSE). PiCode is a distribution of VSCodium, which is a build of the
MIT-licensed VS Code source; upstream licenses and attribution are preserved and documented
in `docs/DISTRIBUTION.md`.
