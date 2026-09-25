# PiCode's own patches

Patches that change the **core**: things the inherited `patches/vscodium/**` set
does not do and that cannot be done by data alone. `distribution/` covers the
product, the prebuilt path and the release; a patch here is the last resort, and
that is why the folder is small.

```
patches/picode/                 applied to vscode/ after patches/vscodium/
patches/picode/${OS_NAME}/      windows/, osx/ or linux/, applied after the above
patches/picode/user/            local experiments, not versioned upstream
```

## How they are applied

`dev/prepare_vscode.sh patches-picode` (phase 4 of `./dev/build.sh`) runs them in
this order:

1. `*.json` removal actions, like VSCodium's `52-ext-copilot-remove-it.json`;
2. `*.patch`, sorted with the C locale, so the order never depends on the
   machine's locale;
3. `${OS_NAME}/*.patch`;
4. `user/*.patch`.

Every patch is applied with `git apply --ignore-whitespace`. A single hull that
does not apply fails the build: there is no `--reject` fallback in the pipeline,
because a partially applied patch set is worse than a stopped build.

## The placeholders

The same ones VSCodium uses, expanded by `dev/utils.sh` into a temporary copy of
the patch — the file in this folder is never rewritten:

| Placeholder | Value |
| --- | --- |
| `!!APP_NAME!!` | `PiCode` |
| `!!APP_NAME_LC!!` | `picode` |
| `!!ASSETS_REPOSITORY!!`, `!!GH_REPO_PATH!!` | `TomasPlatero/PiCode` |
| `!!BINARY_NAME!!` | `picode` |
| `!!GLOBAL_DIRNAME!!` | `picode` |
| `!!ORG_NAME!!` | `TomasPlatero` |
| `!!RELEASE_VERSION!!` | the tag in `upstream/stable.json` |
| `!!TUNNEL_APP_NAME!!` | `picode-tunnel` |

Placeholders only appear in added lines, which is what lets `dev/patch.sh` apply
a patch as written while it is being edited.

## Authoring one

```bash
./dev/build.sh -o            # once, to fetch and prepare ./vscode
./dev/patch.sh 00-my-change  # reset, rebuild the baseline, apply, edit, regenerate
./dev/update_patches.sh      # regenerate every patch in order
```

Both scripts work against the real baseline — phases 2–5, inherited patches
included — and regenerate the patch from the git index, so no commit is created
in the source clone.

## Why there are few patches

The current PiCode is a VSCodium binary plus a product delta, so most of what
defines PiCode is data (`distribution/`) rather than a source change. The
candidates for a real core patch are recorded in
`odd/tasks/picode-patch-build.md`, and a patch is added when a change genuinely
cannot be data. Filling this folder to look thorough would misrepresent the
build.

`dev/build.sh` prints every patch it applies, in order, and fails the build if one
of them does not apply. That output is the record of what this folder contributed.
