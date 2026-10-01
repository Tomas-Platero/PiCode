# Feature: the default model, live

## Goal

Changing **Modelo por defecto** in the options tab must reach the chat panel and the
running agent straight away, instead of waiting for a restart that nothing announces.

Product decisions (locked by the owner, this session):

| Question | Answer |
| --- | --- |
| What happens to the open chat session | The model is applied to it immediately: same conversation, new model |
| The duplicated setting | `picode.pi.defaultModel` goes away; pi's own `defaultModel` — the tab's row — becomes the only place |

## The problem, precisely

It is not a missing visual refresh. Two separate facts make the current behaviour
look like nothing happened:

1. **A running pi holds its settings in memory.** The tab writes through
   `PiSettingsService`, which goes to pi's settings *file*. The process in the chat
   panel is a different `SettingsManager` instance and nothing tells it to reload —
   its `reload()` exists but no watcher calls it. So the file changes and the live
   agent does not.
2. **Two settings mean the same thing.** pi's `defaultModel` (the tab's row) and
   PiCode's `picode.pi.defaultModel` (read by `applyDefaultModel` when a client is
   bound, and applied to that session). Both decide what a new session starts with,
   and PiCode's would silently win whenever it is non-empty.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| How the host learns a value was written | A `applied(key, value)` hook in `SettingsViewOptions`, called after a successful write | The view owns the service; the host owns the live client and the restart. One callback is the smallest seam that keeps both honest |
| What the callback receives | The value pi actually stored | `PiSettingsService.write` starts returning the coerced value, so the host pushes what was written rather than re-parsing the raw post. Empty means "unset" and is not pushed |
| Which keys get pushed | `defaultModel` (push to the session) and `picode.runtime` / `picode.transport` (restart) | Only these cannot wait: the model decides what the next session starts with, and the other two are read once, at process start |
| A new session | The default model is re-applied after `newSession()` | pi resolves a new session's model from settings it may hold stale; re-applying what the tab wrote keeps the two in step |
| Removing the duplicate | Also from `package.json`, the README table and `distribution/settings.json` | A documented setting that no code reads is worse than no setting; leaving it in the template would re-introduce it in every portable profile |
| The owner's live `settings.json` | Left alone | It holds the key already, and a key no manifest declares is inert. The distribution deliberately never clobbers user settings |

## Tasks

1. **`PiSettingsService.write` returns the coerced value** (`Promise<PiSettingValue>`),
   for both the pi-backed and the `picodeKey` branches. Existing callers ignore it.
2. **`SettingsView` gains the seam**: `applied(key, value)` in `SettingsViewOptions`,
   called after each successful write, plus a public `defaultModel()` that reads pi's
   global `defaultModel` so the host can re-apply it to a new session.
3. **`extension.ts` pushes what was written.** `applyWrittenSetting` decides: a
   restart for the two runtime keys, `setModel` plus a chat refresh for the model,
   nothing for the rest. `startNewSession` re-applies the default after the reset.
   `applyDefaultModel` and its `defaultModelApplied` flag are deleted.
4. **Retire `picode.pi.defaultModel`** from `package.json`, the README table and
   `distribution/settings.json`; fix the `pi-sdk-client.ts` comment that cites it as
   the documented form of a `provider/model` reference.
5. **Tests and evidence.** `write` returning the coerced value, including the
   `picodeKey` branch; a guard that the retired key is gone from the manifest, the
   sources and the README, and that every setting the README documents still exists
   in the manifest. `npm test` green, then re-stage the vendored extension.

## Out of scope

A general "the running agent re-reads its settings" mechanism: most settings only
matter when pi resolves them, so a reload path for all of them is its own feature.
Also out of scope: writing the model chosen in the chat panel's dropdown back into
`defaultModel` — that control changes one session, and the tab changes the default.

## Evidence

- `npm test` green after every task.
- Work-unit commits on the feature branch, one per task.
- The staged copy under `resources/app/extensions/picode-pi-chat/` refreshed.
