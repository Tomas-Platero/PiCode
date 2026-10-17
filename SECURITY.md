# Security Policy

## ✅ Supported versions

PiCode tracks upstream VS Code by pin. Only the **latest release** is supported with
security updates.

| Version | Supported |
| --- | --- |
| Latest release of each channel (stable, beta, experimental) | ✅ — stable is the recommended one |
| Anything older | ❌ — update through the in-product updater, or rebuild from the current source |

## 🔒 Reporting a vulnerability

**Do not open a public issue for anything that could be a security problem.**

Report it privately through GitHub:

- [Security advisories](https://github.com/Tomas-Platero/PiCode/security/advisories/new) on
  this repository, or
- the maintainer's [GitHub profile](https://github.com/Tomas-Platero) if advisories are not
  enabled.

Please include: what version and platform, what you did, what you observed, and (if it is a
build or distribution issue) which layer is involved — `picode-source/` for the editor itself,
`distribution/` for the product identity or `dev/` for the pipeline. A `./dev/build.sh -o` run
is usually enough for the maintainer to reproduce.

We aim to acknowledge private reports within **5 business days**.

## 📡 Upstream advisories

The VS Code pin (`upstream/stable.json`) is reviewed **by hand**: the automated `pin-watch`
workflow was removed with the earlier CI, and [`docs/CI.md`](docs/CI.md) records that. When an
advisory is published for `microsoft/vscode` after the pinned version:

- If upstream has published a fix, it is brought into `picode-source/` (merge or backport) in a
  `fix(security)` PR, labelled `security`, and merged **within days** — security updates are treated as urgent.
- If Microsoft has not yet published a fix, a tracked issue labelled `security` is opened
  until the correction ships.

See [docs/CI.md](docs/CI.md) for the full policy of when the pin moves.

## 🛡️ What you should know before trusting a build

- **Windows binaries are unsigned** while the project has no code-signing certificate.
  SmartScreen will warn on first run of the installer. This is expected, not tampering — but
  verify the `SHA256SUMS.txt` shipped with every release before running anything downloaded.
- **The in-product updater reads a static feed**, written by the release pipeline
  (`dev/update-feed.mjs`) and served from this repository's own channel branch. Updates arrive
  only through GitHub Releases; each channel reads only its own feed, so a stable install is
  never handed a beta or experimental build (ADR-015).
- **Credentials stay in the local PiCode profile** (`data/` in portable builds). Cloud sync is an optional Pro feature (`cloud/sync-api/`, ADR-017): the free plan stores nothing, and credentials (`auth.json`, tokens) are uploaded only encrypted and with your explicit consent. Without a Pro account, nothing leaves your machine unless you send it.
- **The agent asks before it acts.** `bash`, `edit`, `write` and every MCP tool call require your confirmation (`permissions.ts`); approving one is running code on your machine, so read what it asks.
- PiCode bundles third-party runtimes ([Pi](https://pi.dev)); vulnerabilities in those
  should be reported upstream as well as here, since PiCode pins their versions.
