## 🟡 The beta channel

A preview of what is coming next, published ahead of the stable channel. It is built from the
`beta` branch.

**It installs beside your stable PiCode, not on top of it.** Its own folder, its own settings
and its own extensions — nothing is shared, so you can keep both open, and removing this one
leaves the other untouched.

**How it updates:** a beta install reads its own feed at
`updates/beta/win32/x64/<target>/latest.json`, so it is never handed a stable release — and a
stable install is never handed this one.
