# Feature: PiCode UI completion

## Goal

Close the three gaps the owner raised after the settings tab landed:

1. **A Skills category.** `Rutas de skills` is buried inside `Paquetes y recursos`,
   and pi's `enableSkillCommands` — whether skills register as slash commands — is
   exposed nowhere in any surface. Both belong in their own category.
2. **A PiCode category with the AI-type selector.** The owner asked for a selector
   that chooses between *our own pi (via SDK)* and *one already installed*. Those
   are PiCode's own settings (`picode.pi.runtime` = `path | managed | custom`, and
   `picode.pi.transport` = `rpc | embedded`), which today live only behind palette
   commands and the panel's controls — the settings tab's `picode` category is
   declared but empty, so it never renders.
3. **A messaging-style transcript.** The chat panel distinguishes speaker with an
   icon-plus-name row above every message. The owner wants chat bubbles instead:
   their messages right, pi's left.

Product decisions (locked by the owner, this session):

| Question | Answer |
| --- | --- |
| What the AI-type selector controls | Both: the pi that runs (3 options) **and** the transport. Two rows in the `picode` category |
| Skills category contents | The skill paths **and** `enableSkillCommands` |
| Bubble style | Aligned bubbles with a small avatar per message (no name row) |

## What exists today

- `src/pi-settings.ts` — the catalogue. `PI_SETTINGS_CATEGORIES` already declares
  `estado` and `picode`, and `describeSettings` drops categories that end up empty,
  which is why neither renders. All descriptors read and write through pi's
  `SettingsManager`; there is no other backing store.
- `src/settings-view.ts` — the tab. Renders whatever the catalogue describes; the
  `select` control already exists, so new dropdown rows need no view change.
- `media/main.js` — `addMessage(role)` is the single place a message element is
  built: it creates `.message-role` (codicon + label) and `.message-body`. Every
  transcript path — live replies, resumed conversations, echoes, errors, system
  notes — goes through it.
- `media/main.css` — `.message` is a two-column grid whose first column is the
  20px icon gutter; `.message-user .message-body` already has a light surface.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Where PiCode's own settings live in the catalogue | The same catalogue, on descriptors carrying a `picodeKey` | One rail, one renderer, one write path. A second catalogue would duplicate the rail, the search and the scope tabs |
| How the service reaches VS Code config | An injected `PiCodeConfigStore` (`get`/`set`), not an import | `pi-settings.ts` is deliberately free of `vscode` so it stays testable in plain Node; the tests import it without a stub |
| Control for the AI type | `select`, like every other enumerated setting | The tab already renders selects; radios would be a second control language for one row |
| Marks the change needs a restart | `needsRestart: true` on both rows | Switching runtime or transport cannot reach a running agent, and the row says so rather than looking inert |
| Bubble avatar | Kept, with the role in `title` and `aria-label` | The name row goes away, so the avatar has to carry the role for accessibility |
| Bubbles for every role | User and assistant get bubbles; error and system keep their own surfaces, aligned left | An error box is a warning, not a message from a speaker |

## Tasks

1. **`skills` category.** Add the id to `PiSettingsCategoryId` and its entry to
   `PI_SETTINGS_CATEGORIES` after `paquetes`; move the `skills` (paths) descriptor
   into it and add an `enableSkillCommands` boolean descriptor reading
   `getEnableSkillCommands()` / writing `setEnableSkillCommands()`.
2. **`picode` category values.** Add `picodeKey?: string` to
   `PiSettingDescriptor`, and make `readAll` / `write` dispatch on it through a
   `PiCodeConfigStore` injected in `PiSettingsServiceOptions`. Declare the two
   descriptors (`runtime`, `transport`) with `needsRestart: true`. Wire the store
   from `src/extension.ts` over `picode.pi.runtime` and `picode.pi.transport`.
3. **Bubble transcript.** Rebuild `addMessage` so a message is a bubble plus an
   avatar, and restyle `.message*` in `media/main.css`: user right, assistant
   left, rounded surfaces, avatar last for the user and first for the assistant.
4. **Tests and evidence.** Catalogue checks for the two new categories and for the
   `picode` dispatch over a fake store; `npm test` green; the vendored extension
   re-staged so the running editor sees the change.

## Out of scope

Editing `picode.pi.executablePath` (the `custom` runtime's path is a free-text
setting that belongs with the runtime picker, not with a select), the
`estado` read-only category, and any change to how a message is stored or
streamed — this is presentation only.

## Evidence

- `npm test` green after every task, with the new catalogue and dispatch checks.
- Work-unit commits on the feature branch, one per task.
- The staged copy under `resources/app/extensions/picode-pi-chat/` refreshed.
