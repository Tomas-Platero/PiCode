## 🟢 The stable channel

This is the release everyone gets. It is built from the `master` branch, and it is the one
the updater offers on its own: no opting in, nothing to switch on.

**What it is:** the whole editor — with **pi** as its agent, the provider and model settings,
MCP servers, the sessions panel and the theme gallery. Extensions from Open VSX install here
exactly as they do anywhere else.

**How it updates:** an installed PiCode reads its feed at
`updates/stable/win32/x64/<target>/latest.json`. Updates roll out gradually: the updater's
`update.minReleaseAge` defaults to 120 h, so a release can take up to five days to reach you.
That delay is deliberate, not a fault.
