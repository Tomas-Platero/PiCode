# host

PiCode's own code, grouped so the repository root is not a pile of unrelated folders. VS Code's
build system needs `src/`, `extensions/`, `resources/` and `build/` at the root, so everything
that is ours and is not one of those lives here.

- `cloud/` -- the cloud sync backend (the only paid part).
- `upstream/` -- the exact VS Code version and commit this tree descends from.

Nothing here is installed by `npm install`; the build copies what it needs into the pack.
