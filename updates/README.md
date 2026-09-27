# Update feed

The static documents the editor's updater reads. They are served directly from this
directory by `raw.githubusercontent.com`, which is why there is no update server to run.

## Why it lives here and not in GitHub Releases

With the updater change baked into the source tree (VSCodium's
`11-update-use-github-release`, now ordinary code in `picode-source/`), the updater asks for

```text
<updateUrl>/<quality>/<platform>/<architecture>[/<target>]/latest.json
```

where `quality` is `stable` or `insider`, `platform` is `win32`, `linux` or `darwin`, and
`architecture` is `x64`, `arm64`, ... (the optional `target` is macOS's `archive`/`msi`/
`system`/`user`). The GitHub Releases API does not answer in that shape, so `updateUrl`
points at this directory instead, and `dev/update-feed.mjs` writes the document from a
published release.

`updateUrl` is set in `distribution/product-delta.json` to

```text
https://raw.githubusercontent.com/TomasPlatero/PiCode/HEAD/updates
```

so a Windows x64 release feed lands at `updates/stable/win32/x64/latest.json`.

## Publishing one

After `gh release create` has uploaded the asset:

```bash
node dev/update-feed.mjs \
  --version 1.135.1 \
  --commit <the commit the build was made from> \
  --url https://github.com/TomasPlatero/PiCode/releases/download/v1.135.1/PiCode-win32-x64-1.135.1.zip \
  --sha256 <sha256 of the asset> \
  --platform win32 --arch x64 \
  --installed <the version the previous release shipped>
```

Then commit the written `latest.json`. The `--installed` check is not optional
bookkeeping: a feed whose `productVersion` is not newer than what is installed makes the
editor claim an update is available forever. That is the known failure mode of this
mechanism and the reason the generator refuses to write such a feed without `--force`.

## Which version the feed must name

The feed's `productVersion` has to be comparable to what the installed build reports, and
it is the same version on both paths. It has **one home**:

```text
distribution/product-delta.json  →  set.version
```

That file is what both paths already apply — this build in the prepare phase, and
`distribution/apply-picode.ps1` onto the packaged tree — so the compiled editor and the
released one cannot disagree. Bumping a release is editing that one value.

The major.minor stay VS Code's on purpose: every extension's `engines.vscode` (`^1.90.0`)
is matched against the product version, so an independent `0.x` numbering would make every
extension look incompatible. Today it reads `1.135.1`.

Before publishing a feed, raise that value so it is **strictly greater** than the version
the previous release shipped. The `--installed` check in `dev/update-feed.mjs` refuses
otherwise.

### What is still not unified

**Unified**: both paths now take the version from `set.version`, so a tree branded by
either one reports the same number.

**Not unified**: an installation that was released *before* this change still reports
VSCodium's `1.135.06055` (not valid strict semver, which is why the vendored update patch
carries a `normalizeVersion` helper at all). That number sorts above `1.135.1`, so those
installs would never be offered an update. Nothing can be done about it from here — it is
the version they already have — but it is worth knowing before publishing the first feed.
