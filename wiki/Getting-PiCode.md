# Getting PiCode

Two ways in, for two different people.

## 1. To use it: download a release

Go to [Releases](https://github.com/Tomas-Platero/PiCode/releases) and take the
file for your platform:

| File | What it is |
| --- | --- |
| `PiCode-<ver>-win-x64.zip` | Windows portable — unzip anywhere, run `PiCode.exe` |
| `PiCode-<ver>-win-x64-setup.exe` | Windows installer (Inno Setup) |
| `PiCode-<ver>-linux-x64.tar.gz` | Linux portable |
| `PiCode-<ver>-linux-x64.deb` / `.rpm` | Linux installers |
| `SHA256SUMS.txt` | checksums of all of the above |

**Verify the checksum before first run.** Windows binaries are currently
unsigned, so SmartScreen will warn once (*More info → Run anyway*). That is
expected — see [CI and Releases](CI-and-Releases.md#signing-and-runner-notes).

Portable mode: on first run PiCode creates a `data/` folder next to the
executable — user data, extensions, sessions, cache, the Pi profile. **Nothing
is written to your `%APPDATA%` or `~/.pi`.** Deleting `data/` gives you a clean
PiCode; copying it moves your whole PiCode to another machine.

No profile travels inside the archive itself: fresh ZIP, fresh start. Continue
with [First Run and the Wizard](First-Run-and-the-Wizard.md).

## 2. To work on it: a fresh clone is not runnable yet

The repository root doubles as the distribution root, but the ~1 GB editor
payload is **not in git** and cannot be (GitHub rejects files over 100 MB; the
executable alone is 212 MB). What is versioned is the layer that turns a stock
tree into PiCode: patches, pins, product delta, build scripts, CI.

You then pick one of the two build paths:

- **The source build** — clone VS Code at the pinned commit, apply the patch
  sets, compile. This is the way to change editor behaviour and the way
  releases are produced. → [Building PiCode](Building-PiCode.md)
- **The ZIP path** — extract a stock VSCodium archive at the repo root and run
  `distribution/apply-picode.ps1` to stamp the PiCode layer onto it. Fast, no
  toolchain, but it cannot touch compiled core. →
  [Distribution and Licensing](Distribution-and-Licensing.md)

If you plan to contribute, read [CONTRIBUTING.md](https://github.com/Tomas-Platero/PiCode/blob/main/CONTRIBUTING.md)
first — it names the rules that have burned the project before.

## Troubleshooting the first run

| Symptom | Meaning |
| --- | --- |
| SmartScreen warning (Windows) | the binary is unsigned; verify checksum, run anyway |
| No update check ever happens | by design — the in-product updater is disabled so a patched tree cannot be silently replaced |
| `Language model unavailable` in chat | no provider connected yet — connect one in the wizard or [Pi Inside](Pi-Inside.md) |
| A theme cannot install | it exists only on the Microsoft Marketplace; this editor installs from Open VSX |

---
Next: [First Run and the Wizard](First-Run-and-the-Wizard.md)
