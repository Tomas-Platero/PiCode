# Security Policy

## Supported versions

PiCode tracks upstream VS Code by pin. Only the **latest release** is supported with
security updates.

| Version | Supported |
| --- | --- |
| Latest release tag (`v*`) | ✅ |
| Anything older | ❌ — rebuild from the current pin |

## Reporting a vulnerability

**Do not open a public issue for anything that could be a security problem.**

Report it privately through GitHub:

- [Security advisories](https://github.com/Tomas-Platero/PiCode/security/advisories/new) on
  this repository, or
- the maintainer's [GitHub profile](https://github.com/Tomas-Platero) if advisories are not
  enabled.

Please include: what version and platform, what you did, what you observed, and (if it is a
patch or distribution issue) which file under `patches/` or `distribution/` is involved. A
`./dev/build.sh -o` run that names the failing patch is usually enough for the maintainer to
reproduce.

We aim to acknowledge private reports within **5 business days**.

## Upstream advisories are watched automatically

The `pin-watch` workflow runs every Monday. It checks the latest VS Code *stable* release and
the [GitHub security advisories published for `microsoft/vscode`](https://github.com/microsoft/vscode/security/advisories)
after the currently pinned version:

- If an advisory exists, the update PR is titled `fix(security)`, labelled `security`, and
  lists each advisory with its CVE and severity.
- Security updates are treated as urgent: the pin is reviewed and merged **within days**.
- If an advisory exists and Microsoft has not yet published a fixed release, a tracked issue
  labelled `security` is opened until upstream ships the correction.

See [docs/CI.md](docs/CI.md) for the full policy of when the pin moves.

## What you should know before trusting a build

- **Windows binaries are unsigned** while the project has no code-signing certificate.
  SmartScreen will warn on first run of the installer. This is expected, not tampering — but
  verify the `SHA256SUMS.txt` shipped with every release before running anything downloaded.
- **The in-product updater is disabled** (`updateUrl` is empty by design, ADR-011): a patched
  tree must never be silently replaced. Updates arrive only through GitHub Releases.
- **Credentials stay in the local PiCode profile** (`data/` in portable builds). Cloud sync
  of the profile is planned; when it lands, credential upload will require explicit consent
  and encryption. Until then, nothing leaves your machine unless you send it.
- PiCode bundles third-party runtimes ([Pi](https://pi.dev)); vulnerabilities in those
  should be reported upstream as well as here, since PiCode pins their versions.
