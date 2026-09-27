# Roadmap and Known State

Honesty first: this page distinguishes **shipped and observed** from
**shipped-but-unverified** from **planned**. The authoritative internal list is
[`docs/TAREAS.md`](https://github.com/Tomas-Platero/PiCode/blob/main/docs/TAREAS.md)
(Spanish); this is its public mirror, and when the two disagree, the internal
one wins.

## Shipped and verified

- **Source build** to `PiCode.exe` / Linux trees, with pinned VS Code
  (`1.135.0`) and a vendored VSCodium patch set — full builds in CI on both
  OSes, releases with installers and checksums.
- **Copilot out of the chat** (two real causes found in real logs) and out of
  the model selector (strings verified zero in the built editor).
- **`@pi` as the default chat participant** — ask/agent/edit modes; the VS Code
  Agents window removed (six actions, chat tips, welcome banner — by code, not
  settings).
- **Providers in settings**: per-provider rows, the OAuth subscription list
  from Pi itself, custom endpoint form; declarations project into Pi's files.
- **MCP bridge**: editor MCP tools handed to Pi through the editor's
  permissions (thirteen executed checks).
- **Chat ↔ Pi quality**: the selector drives Pi hot, thinking level, reasoning
  visibility, editor context travels with the message (120-line / 8000-char
  caps).
- **Theme gallery** with previews rendered from each theme's own colours;
  marketplace-only themes explained rather than failing silently.
- **First-run wizard** (runtime → provider/model → Gentle → theme), import
  with counts, credentials unchecked by default.
- **English product copy** swept clean; the sweep verified against the built
  editor.
- **Pinned dual runtime** (path/managed/custom × rpc/embedded) from the panel
  era, still true for the core build.

## In progress (the open migration)

The 2026-09-24 pivot moved everything from the old webview panel into the
editor core. What is **not finished**:

1. **Pi's models surfacing in the editor's model window** — until then a fresh
   build can answer "Language model unavailable". The editor's registration
   door is stable; Pi's catalog is already readable. 🟡
2. **The agent-host class joining session and translation** — the biggest
   single piece; session bridge and event mapping are written and compiling,
   but nothing wires them into one `IAgent` yet. 🔴
3. **Registering Pi as a provider and disabling Claude/Codex** — must follow 2;
   switching them off first empties the picker. 🟢
4. **Connector content** — the built-in `extensions/picode` exists with an
   intentionally empty `activate`; its first real payload (providers service)
   is pending. 🟡
5. **Gentle AI skills inside packages** are discovered by the hub for agents
   (23) but not for package skills (13) — the discovery table cannot express
   package paths yet. 🟢
6. **Recovering panel-era value** into the core chat: Pi statistics, command
   catalog, session list/resume/fork. 🟡
7. **Legacy quarantine**: `legacy/picode-pi-chat.tar.gz` cleanup, removal of
   the panel step from the ZIP apply script. 🟢

## Planned, not started

- **Cloud profile sync** — the commercial layer: `data/` up and down as one
  unit, credentials encrypted, explicit consent. 🔴
- **Language packs** for non-English surfaces.
- **Code signing** once a certificate exists (CI is already wired for the
  secrets).
- **Update feed** publication for the auto-update mechanism that is currently
  patched in but never pointed at anything (and intentionally disabled for the
  in-product updater).

## Known limitations (current, not roadmap)

- Windows binaries **unsigned** → SmartScreen warning on first run.
- Interactive surfaces have **no automated coverage**; every *decision*
  around them is tested, clicks are checked by hand.
- **macOS** refuses explicitly; **ARM** targets are not wired.
- A theme that exists **only** on the Microsoft Marketplace cannot install
  (Open VSX is the licensed gallery).
- The managed Pi runtime installs **on demand** (~410 MB) — first use takes
  time and space.
- The ZIP path and the source path still number versions differently — open
  owner decision.

---
The defects found on the way (including by independent review passes) are not
hidden here; each has its record in
[`odd/tasks/`](https://github.com/Tomas-Platero/PiCode/tree/main/odd/tasks).
