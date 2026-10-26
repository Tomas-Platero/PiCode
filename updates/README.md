# Update feed

The static documents the editor's updater reads. They are served from this directory by
`raw.githubusercontent.com`; the editor reaches them through PiCode's own API, which counts the
check anonymously and redirects here (see *Anonymous usage* in
[`cloud/sync-api/README.md`](../cloud/sync-api/README.md)). The documents themselves only live here.

## 🧭 Why it lives here and not in GitHub Releases

With the updater change baked into the source tree (VSCodium's
`11-update-use-github-release`, now ordinary code in `picode-source/`), the updater asks for

```text
<updateUrl>/<quality>/<platform>/<architecture>[/<target>]/latest.json
```

where `quality` is `stable` or `insider`, `platform` is `win32`, `linux` or `darwin`, and
`architecture` is `x64`, `arm64`, ... The optional `target` is how the running build was
packaged, and **the target the editor asks for is the one its own `product.json` resolves
to**, not the one the release happens to be named after. The GitHub Releases API does not
answer in that shape, so `updateUrl` points at this directory instead, and
`dev/update-feed.mjs` writes the document from a published release.

`updateUrl` is set in `distribution/product-delta.json` to

```text
https://www.getpicode.app/api/feed/HEAD/updates
```

which answers every request with a redirect to the same path under
`https://raw.githubusercontent.com/Tomas-Platero/PiCode/<branch>/updates`.

## 🧩 The two Windows feeds (why there are two)

PiCode ships one release with two artifacts, and each is updated from a different path:

| Build | Update type | Target the editor asks for | Feed |
| --- | --- | --- | --- |
| Portable zip, run in place | `Archive` | `archive` | `updates/<channel>/win32/x64/archive/latest.json` |
| Installed with the Inno user setup | `Setup` | `user` (the `user-setup` task injects `target: "user"` into the product it ships) | `updates/<channel>/win32/x64/user/latest.json` |

`<channel>` is `stable`, `beta` or `experimental`, and the feed lives **on that channel's own
branch** (`master`, `beta`, `experimental`) — ADR-015. A beta install reads the `beta` branch
and cannot be handed a stable release, even by mistake.

The installed feed is not optional. Without it the installed editor requests
`.../user/latest.json`, finds nothing, and the update dialog answers **`Server returned
404`** — which is exactly what 0.1.0-beta and 0.1.1-beta shipped without. Both feeds
point at the same release; they differ in the asset they name (zip vs `-setup.exe`).

## 🚀 Publishing them

After `gh release create` has uploaded both assets:

```bash
# 1. The portable feed (zip)
node dev/update-feed.mjs \
  --version <set.version> \
  --picode-version <picodeVersion> \
  --commit <the commit the build was made from> \
  --url https://github.com/Tomas-Platero/PiCode/releases/download/v<picodeVersion>/PiCode-win32-x64-<picodeVersion>.zip \
  --sha256 <sha256 of the zip> \
  --platform win32 --arch x64 --target archive \
  --installed <the editor version the previous release shipped>

# 2. The installed feed (setup exe)
node dev/update-feed.mjs \
  --version <set.version> \
  --picode-version <picodeVersion> \
  --commit <the same commit> \
  --url https://github.com/Tomas-Platero/PiCode/releases/download/v<picodeVersion>/PiCode-win32-x64-<picodeVersion>-setup.exe \
  --sha256 <sha256 of the setup exe> \
  --platform win32 --arch x64 --target user \
  --installed <the editor version the previous release shipped>
```

Then commit both written `latest.json` files. The `--installed` check is not optional
bookkeeping: a feed whose `productVersion` is not newer than what is installed makes the
editor claim an update is available forever. That is the known failure mode of this
mechanism and the reason the generator refuses to write such a feed without `--force`.

## 🔢 Which versions the feed must name

Two numbers, because they do two jobs:

- **`productVersion`** — the **editor's** number, the one the updater compares against the
  installed product. It has **one home**: `distribution/product-delta.json → set.version`.
  The build's prepare phase applies that file to the tree before packing, so the compiled
  editor and the released one cannot disagree. Bumping a
  release is editing that one value, and it must be **strictly greater** than the version
  the previous release shipped; the `--installed` check refuses otherwise.
- **`picodeVersion`** — **PiCode's** own number (`0.1.0-beta`, `0.1.1-beta`, …). It names
  the release and is what the updater UI shows the owner. It comes from
  `distribution/product-delta.json → set.picodeVersion`.

The major.minor of `productVersion` stay VS Code's on purpose: every extension's
`engines.vscode` is matched against the product version, so an independent
`0.x` numbering would make every extension look incompatible. It reads `set.version`, which
runs ahead of the tree's VS Code 1.135.0 base — the gap is deliberate and recorded in
ADR-016.

### What is still not unified

**Unified**: the build takes `set.version` as the product version, so a tree branded
by the build reports the same number; and the updater UI reads `picodeVersion` when the
feed carries one, falling back to `productVersion` for an older feed.

**Not unified**: an installation released *before* the two-number split still reports
VSCodium's `1.135.06055`. It sorts above a normal `1.135.x`, so those installs would never
be offered an update. Nothing can be done from here — it is the version they already have.
