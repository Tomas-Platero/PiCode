## 🧪 The experimental channel

The newest work, published before beta. It is built from the `experimental` branch: this is
where things land first, it may change under you, and it may be rough at the edges.

**It installs beside your stable and beta PiCode, not on top of them.** Its own folder and its
own profile.

**How it updates:** it reads `updates/experimental/win32/x64/<target>/latest.json`, so it only
ever receives its own channel's releases.
