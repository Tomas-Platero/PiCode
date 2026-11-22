# skills

Skills that PiCode gives pi on top of the ones in its profile, one folder each with its `SKILL.md`. They travel inside the editor and pi loads them for every chat.

- `web-preview/`: when and how pi checks a page in the integrated browser.
- `go-testing/`: Go testing patterns (table tests, golden files, Bubbletea `teatest`).
- `systemic-issue-triage/`: triaging issues by root class instead of one by one.

`go-testing` and `systemic-issue-triage` are copied unchanged from Gentle AI v4.5.0 (`internal/assets/skills/`, Apache-2.0 as their headers state). Gentle AI installs them for every runtime, but gentle-pi does not ship them, so pi inside PiCode would otherwise go without them.
