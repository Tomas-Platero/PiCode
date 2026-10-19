# 🗺️ Repository map

> **Generated** with `node build/docs.mjs map` — do not edit by hand.
> Each folder is described by **the first line of its own `README.md`**:
> if it says "no README" here, the gap is listed below.

## 📊 Status

- **19** folders documented · **20** without a README.
- Root files described: 13.

## 🌳 Tree

```text
├── .github/ — Plantillas y automatismos: lo que se ve cuando alguien abre una issue, un PR o lanza una build.
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── build_failure.yml
│   │   ├── config.yml
│   │   ├── feature_request.yml
│   │   └── question.yml
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── release.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── README.md
├── build/ — build/ builds PiCode from its own source tree, and the source tree is this repository. There is no picode-source/ folder and no download: the…
│   ├── agent-sdk/ — Per-platform agent SDK production. Each VS Code build (darwin-arm64, linux-x64, Alpine REH, etc.) uploads its own platform's SDK tarballs to…
│   │   ├── agents/
│   │   │   ├── claude/
│   │   │   │   ├── package-lock.json
│   │   │   │   └── package.json
│   │   │   └── codex/
│   │   │       ├── package-lock.json
│   │   │       └── package.json
│   │   ├── test/
│   │   │   └── versionSync.test.ts
│   │   ├── common.ts
│   │   ├── package.ts
│   │   ├── produce.ts
│   │   ├── README.md
│   │   └── upload.ts
│   ├── checker/ — ⚠️ no README
│   │   ├── layersChecker.ts
│   │   ├── layersTypeCheck.ts
│   │   ├── tsconfig.browser.json
│   │   ├── tsconfig.electron-browser.json
│   │   ├── tsconfig.electron-main.json
│   │   ├── tsconfig.electron-utility.json
│   │   ├── tsconfig.node.json
│   │   └── tsconfig.worker.json
│   ├── checksums/ — ⚠️ no README
│   │   ├── electron.txt
│   │   ├── explorer-dll.txt
│   │   ├── nodejs.txt
│   │   └── vscode-sysroot.txt
│   ├── codex/ — ⚠️ no README
│   │   ├── test/
│   │   │   └── checkProtocolSync.test.ts
│   │   ├── check-protocol-sync.ts
│   │   ├── codex-version.txt
│   │   ├── generate-protocol.d.mts
│   │   └── generate-protocol.mjs
│   ├── dictation-runtime/ — ⚠️ no README
│   │   ├── common.ts
│   │   ├── nuget.ts
│   │   ├── package.ts
│   │   ├── produce.ts
│   │   └── upload.ts
│   ├── distribution/ — Operator guide for build/distribution/. The strategy behind these files is in docs/DISTRIBUTION.md; this file is the short runbook.
│   │   ├── picode-icon.svg
│   │   ├── picode.ico
│   │   ├── picode.svg
│   │   ├── README.md
│   │   ├── runtime.json
│   │   └── settings.json
│   ├── lib/
│   │   ├── gulp/
│   │   │   ├── facade.ts
│   │   │   └── task.ts
│   │   ├── mangle/
│   │   │   ├── index.ts
│   │   │   ├── renameWorker.ts
│   │   │   └── staticLanguageServiceHost.ts
│   │   ├── policies/
│   │   │   ├── basePolicy.ts
│   │   │   ├── booleanPolicy.ts
│   │   │   ├── copyPolicyDto.ts
│   │   │   ├── exportPolicyData.ts
│   │   │   ├── numberPolicy.ts
│   │   │   ├── objectPolicy.ts
│   │   │   ├── policyData.jsonc
│   │   │   ├── policyDataMerge.ts
│   │   │   ├── policyGenerator.ts
│   │   │   ├── render.ts
│   │   │   ├── stringEnumPolicy.ts
│   │   │   ├── stringPolicy.ts
│   │   │   └── types.ts
│   │   ├── stylelint/
│   │   │   ├── validateDesignTokens.ts
│   │   │   ├── validateHasSelectors.ts
│   │   │   ├── validateVariableNames.ts
│   │   │   └── vscode-known-variables.json
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   └── policies/
│   │   │   │       ├── darwin/
│   │   │   │       │   ├── en-us/
│   │   │   │       │   ├── fr-fr/
│   │   │   │       │   └── com.visualstudio.code.oss.mobileconfig
│   │   │   │       ├── linux/
│   │   │   │       │   └── policy.json
│   │   │   │       └── win32/
│   │   │   │           ├── en-us/
│   │   │   │           ├── fr-fr/
│   │   │   │           └── CodeOSS.admx
│   │   │   ├── agentHostDependencies.test.ts
│   │   │   ├── booleanPolicy.test.ts
│   │   │   ├── checkCyclicDependencies.test.ts
│   │   │   ├── copilot.test.ts
│   │   │   ├── extensionTarget.test.ts
│   │   │   ├── hygiene.test.ts
│   │   │   ├── i18n.test.ts
│   │   │   ├── layersChecker.test.ts
│   │   │   ├── numberPolicy.test.ts
│   │   │   ├── objectPolicy.test.ts
│   │   │   ├── osProxyResolver.test.ts
│   │   │   ├── policyConversion.test.ts
│   │   │   ├── policyDataMerge.test.ts
│   │   │   ├── render.test.ts
│   │   │   ├── rootAnchoredHas.test.ts
│   │   │   ├── stringEnumPolicy.test.ts
│   │   │   ├── stringPolicy.test.ts
│   │   │   └── stylelint.test.ts
│   │   ├── tsb/
│   │   │   ├── builder.ts
│   │   │   ├── index.ts
│   │   │   ├── transpiler.ts
│   │   │   └── utils.ts
│   │   ├── typings/
│   │   │   ├── @vscode/
│   │   │   │   └── gulp-electron.d.ts
│   │   │   ├── asar.d.ts
│   │   │   ├── cgmanifest.json
│   │   │   ├── chromium-pickle-js.d.ts
│   │   │   ├── event-stream.d.ts
│   │   │   ├── gulp-azure-storage.d.ts
│   │   │   ├── gulp-bom.d.ts
│   │   │   ├── gulp-buffer.d.ts
│   │   │   ├── gulp-gunzip.d.ts
│   │   │   ├── gulp-vinyl-zip.d.ts
│   │   │   ├── rcedit.d.ts
│   │   │   ├── stream.d.ts
│   │   │   ├── ternary-stream.d.ts
│   │   │   └── vscode-gulp-watch.d.ts
│   │   ├── watch/
│   │   │   ├── index.ts
│   │   │   ├── watch-win32.ts
│   │   │   └── watcher.exe
│   │   ├── asar.ts
│   │   ├── azureFeed.ts
│   │   ├── builtInExtensions.ts
│   │   ├── builtInExtensionsCG.ts
│   │   ├── bundle.ts
│   │   ├── checkCyclicDependencies.ts
│   │   ├── compilation.ts
│   │   ├── copilot.ts
│   │   ├── date.ts
│   │   ├── dependencies.ts
│   │   ├── electron.ts
│   │   ├── esbuild.ts
│   │   ├── extensions.ts
│   │   ├── extensionTarget.ts
│   │   ├── extractExtensionPoints.ts
│   │   ├── fetch.ts
│   │   ├── formatter.ts
│   │   ├── getVersion.ts
│   │   ├── git.ts
│   │   ├── i18n.resources.json
│   │   ├── i18n.ts
│   │   ├── inlineMeta.ts
│   │   ├── monaco-api.ts
│   │   ├── nls-analysis.ts
│   │   ├── nls.ts
│   │   ├── node.ts
│   │   ├── npmPackage.ts
│   │   ├── optimize.ts
│   │   ├── osProxyResolver.ts
│   │   ├── preLaunch.ts
│   │   ├── propertyInitOrderChecker.ts
│   │   ├── reporter.ts
│   │   ├── screenshotBlocksCi.ts
│   │   ├── screenshotDiffReport.ts
│   │   ├── standalone.ts
│   │   ├── stats.ts
│   │   ├── treeshaking.ts
│   │   ├── tsconfigUtils.ts
│   │   ├── tsgo.ts
│   │   ├── typeScriptLanguageServiceHost.ts
│   │   └── util.ts
│   │   └── … 41 files in total
│   ├── linux/
│   │   ├── debian/
│   │   │   ├── calculate-deps.ts
│   │   │   ├── dep-lists.ts
│   │   │   ├── install-sysroot.ts
│   │   │   └── types.ts
│   │   ├── rpm/
│   │   │   ├── calculate-deps.ts
│   │   │   ├── dep-lists.ts
│   │   │   └── types.ts
│   │   ├── dependencies-generator.ts
│   │   └── libcxx-fetcher.ts
│   ├── monaco/ — ⚠️ no README
│   │   ├── LICENSE
│   │   ├── monaco.d.ts.recipe
│   │   ├── monaco.usage.recipe
│   │   ├── package.json
│   │   ├── README-npm.md
│   │   ├── README.md
│   │   ├── ThirdPartyNotices.txt
│   │   └── version.txt
│   ├── next/ — ⚠️ no README
│   │   ├── devTunnelsShims/
│   │   │   ├── buffer.js
│   │   │   ├── empty.cjs
│   │   │   ├── process.js
│   │   │   └── vscodeJsonrpc.cjs
│   │   ├── test/
│   │   │   ├── build-fast.test.ts
│   │   │   ├── nls-sourcemap.test.ts
│   │   │   ├── private-to-property.test.ts
│   │   │   └── transpile.test.ts
│   │   ├── build-fast.ts
│   │   ├── devTunnelsWeb.ts
│   │   ├── devTunnelsWebEntry.js
│   │   ├── index.ts
│   │   ├── nls-plugin.ts
│   │   ├── private-to-property.ts
│   │   └── transpile.ts
│   ├── npm/ — ⚠️ no README
│   │   ├── gyp/
│   │   │   ├── custom-headers/
│   │   │   │   └── v8-source-location.h
│   │   │   ├── package-lock.json
│   │   │   └── package.json
│   │   ├── check-allow-scripts.ts
│   │   ├── dirs.ts
│   │   ├── fast-install.ts
│   │   ├── installStateHash.ts
│   │   ├── mixin-telemetry-docs.ts
│   │   ├── postinstall.ts
│   │   ├── preinstall.ts
│   │   ├── update-all-grammars.ts
│   │   ├── update-distro.ts
│   │   └── update-localization-extension.ts
│   ├── release-notes/ — La descripción que encima del changelog en cada página de release, una por canal. El resumen agrupado por tipo de cambio (novedades, arreglos,…
│   │   ├── beta.md
│   │   ├── experimental.md
│   │   ├── README.md
│   │   └── stable.md
│   ├── rspack/ — ⚠️ no README
│   │   ├── cssSourceMarkerLoader.mts
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── rspack.serve-out.config.mts
│   │   └── workbench-rspack.html
│   ├── vite/ — ⚠️ no README
│   │   ├── index-workbench.ts
│   │   ├── index.html
│   │   ├── index.ts
│   │   ├── mobile-multi-diff-worker.ts
│   │   ├── mobile-multi-diff.html
│   │   ├── mobile-multi-diff.ts
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── setup-dev.ts
│   │   ├── style.css
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── workbench-electron.ts
│   │   ├── workbench-vite-electron.html
│   │   └── workbench-vite.html
│   ├── win32/
│   │   ├── i18n/
│   │   │   ├── Default.zh-cn.isl
│   │   │   ├── Default.zh-tw.isl
│   │   │   ├── messages.de.isl
│   │   │   ├── messages.en.isl
│   │   │   ├── messages.es.isl
│   │   │   ├── messages.fr.isl
│   │   │   ├── messages.hu.isl
│   │   │   ├── messages.it.isl
│   │   │   ├── messages.ja.isl
│   │   │   ├── messages.ko.isl
│   │   │   ├── messages.pt-br.isl
│   │   │   ├── messages.ru.isl
│   │   │   ├── messages.tr.isl
│   │   │   ├── messages.zh-cn.isl
│   │   │   └── messages.zh-tw.isl
│   │   ├── code.iss
│   │   ├── inno_updater.exe
│   │   ├── signature.ts
│   │   └── vcruntime140.dll
│   ├── branding.mjs
│   ├── build-builder.cmd
│   ├── build-cli.sh
│   ├── build-connector.sh
│   ├── build-fast.sh
│   ├── build-helpers.mjs
│   ├── build-installer.sh
│   ├── build-live.sh
│   ├── build-run.sh
│   ├── build-window.cmd
│   ├── build-window.ps1
│   ├── build.sh
│   ├── buildConfig.ts
│   ├── buildfile.ts
│   ├── checks.mjs
│   ├── data-hold.sh
│   ├── docs.mjs
│   ├── durable-runtime.sh
│   ├── filters.ts
│   ├── gulpfile.cli.ts
│   ├── gulpfile.compile.ts
│   ├── gulpfile.editor.ts
│   ├── gulpfile.extensions.ts
│   ├── gulpfile.hygiene.ts
│   ├── gulpfile.reh.ts
│   ├── gulpfile.scan.ts
│   ├── gulpfile.ts
│   ├── gulpfile.vscode.linux.ts
│   ├── gulpfile.vscode.ts
│   ├── gulpfile.vscode.web.ts
│   ├── gulpfile.vscode.win32.ts
│   ├── hygiene.ts
│   ├── package-lock.json
│   ├── package.json
│   ├── pi-runtime.sh
│   ├── README.md
│   ├── release.mjs
│   ├── setup-npm-registry.ts
│   ├── stage-distribution.sh
│   ├── stylelint.ts
│   └── tsconfig.json
│   └── … 41 files in total
├── cli/ — Carpeta upstream: aquí no se documenta fichero a fichero. Es el código fuente del comando code (VS Code CLI) tal como desciende de… · ⬆️ upstream, no breakdown
├── cloud/ — Todo lo que vive en la nube: la única parte de pago del producto. El editor es gratis y completo; esto es la sincronización y el respaldo de la…
│   ├── sync-api/ — The backend of PiCode's sync service: it implements the REST contract the editor's Settings Sync engine expects, authenticates against Firebase Auth,…
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   └── api/
│   │   │   │       ├── health/
│   │   │   │       │   └── route.ts
│   │   │   │       └── v1/
│   │   │   │           ├── account/
│   │   │   │           ├── collection/
│   │   │   │           ├── download/
│   │   │   │           ├── manifest/
│   │   │   │           └── resource/
│   │   │   └── lib/
│   │   │       ├── auth.ts
│   │   │       ├── contract.ts
│   │   │       ├── crypto.ts
│   │   │       ├── firebase-admin.ts
│   │   │       ├── http.ts
│   │   │       ├── plans.ts
│   │   │       ├── quota.ts
│   │   │       ├── retention.ts
│   │   │       └── store.ts
│   │   ├── test/
│   │   │   ├── plans.test.ts
│   │   │   └── retention.test.ts
│   │   ├── firebase.json
│   │   ├── firestore.indexes.json
│   │   ├── firestore.rules
│   │   ├── next-env.d.ts
│   │   ├── next.config.mjs
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── README.md
│   │   └── tsconfig.json
│   └── README.md
├── docs/ — Los papeles que deciden cómo se junta todo. Las palabras del dueño viven en AGENTS.md; la cara pública (README, wiki) se escribe desde aquí, no al…
│   ├── ARCHITECTURE.md
│   ├── CI.md
│   ├── DECISIONS.md
│   ├── DISENO.md
│   ├── DISTRIBUTION.md
│   ├── HARNESS.md
│   ├── howto-build.md
│   ├── MAPA.md
│   ├── README.md
│   ├── TAREAS.md
│   └── VISION.md
├── durable/ — A self-contained program that runs @earendil-works/pi-durable (1.3.0) against the owner's LAN gateway OmniRoute and proves, with real runs, the three…
│   ├── lib/
│   │   ├── acp.js
│   │   ├── agents.js
│   │   ├── client.js
│   │   ├── common.js
│   │   ├── daemon.d.ts
│   │   ├── daemon.js
│   │   ├── extensions.js
│   │   ├── guard.js
│   │   ├── mcp.js
│   │   ├── profile.js
│   │   ├── protocol.js
│   │   ├── render.js
│   │   ├── settings.js
│   │   └── skills.js
│   ├── cli.js
│   ├── package-lock.json
│   ├── package.json
│   ├── proof-acp.sh
│   ├── proof-daemon.sh
│   ├── proof-editor-lifecycle.js
│   ├── proof-record.js
│   ├── proof1-kill.js
│   ├── proof1-resume.js
│   ├── proof2-subagent.js
│   ├── proof3-two-clients.js
│   ├── README.md
│   └── smoke.js
├── durable-acp-client/ — A deliberately small ACP client that proves durable speaks the Agent Client Protocol (v1) over stdio (node cli.js acp). It speaks raw JSON-RPC on the…
│   ├── client.js
│   └── README.md
├── durable-bridge/ — A pi extension (TypeScript, loaded by path — nothing is installed into any pi, and no pi directory is written) that bridges the coding agent you use…
│   ├── extension.ts
│   ├── proof-kill-survive.mjs
│   └── README.md
├── extensions/ — Casi todo lo que hay aquí es upstream: las extensiones que VS Code trae de serie (git, json, markdown, typescript-language-features…), tal como…
│   ├── picode/ — La pieza que hace que el chat exista. Es el puente entre el editor y pi: registra al agente en el chat, descubre proveedores y modelos, entrega MCP,…
│   │   ├── media/
│   │   │   ├── picode-light.svg
│   │   │   ├── picode-status.svg
│   │   │   └── picode.svg
│   │   ├── src/
│   │   │   ├── agent.ts
│   │   │   ├── agents.ts
│   │   │   ├── background-cards.ts
│   │   │   ├── background-jobs.ts
│   │   │   ├── chat-edits.ts
│   │   │   ├── chat-record.ts
│   │   │   ├── command-registry.ts
│   │   │   ├── commands.ts
│   │   │   ├── context.ts
│   │   │   ├── customizations.ts
│   │   │   ├── declarations.ts
│   │   │   ├── durable-cards.ts
│   │   │   ├── durable-client.ts
│   │   │   ├── durable-folder.ts
│   │   │   ├── durable-run-stream.ts
│   │   │   ├── durable-sessions-register.ts
│   │   │   ├── durable-sessions.ts
│   │   │   ├── durable-spawn.ts
│   │   │   ├── durable-tasks.ts
│   │   │   ├── durable.ts
│   │   │   ├── editor-context.ts
│   │   │   ├── endpoint.ts
│   │   │   ├── extension.ts
│   │   │   ├── import-project.ts
│   │   │   ├── left-behind-packages.ts
│   │   │   ├── login.ts
│   │   │   ├── mcp-add.ts
│   │   │   ├── mcp-cwd.ts
│   │   │   ├── mcp-provider.ts
│   │   │   ├── mcp-scopes.ts
│   │   │   ├── mcp.ts
│   │   │   ├── mcpServers.ts
│   │   │   ├── mcpTools.ts
│   │   │   ├── models-cache.ts
│   │   │   ├── npm-run.ts
│   │   │   ├── onboarding.ts
│   │   │   ├── packages-data.ts
│   │   │   ├── packages-install.ts
│   │   │   ├── packages-manage.ts
│   │   │   ├── packages-registry.ts
│   │   │   ├── packages-updates.ts
│   │   │   ├── permissions.ts
│   │   │   ├── piConfig.ts
│   │   │   ├── piLocate.ts
│   │   │   ├── piSdk.ts
│   │   │   ├── profile-import.ts
│   │   │   ├── progress.ts
│   │   │   ├── provider-stream.ts
│   │   │   ├── providerIds.ts
│   │   │   ├── providers-list.ts
│   │   │   ├── providers.ts
│   │   │   ├── runtime.ts
│   │   │   ├── session-cwd.ts
│   │   │   ├── sessions-backup.ts
│   │   │   ├── sessions-import-plan.ts
│   │   │   ├── sessions-import.ts
│   │   │   ├── sessions-provider.ts
│   │   │   ├── sessions-resume.ts
│   │   │   ├── status-data.ts
│   │   │   ├── status-view.ts
│   │   │   ├── subscriptions.ts
│   │   │   ├── theme-catalog.ts
│   │   │   ├── theme-gallery.ts
│   │   │   ├── theme-types.ts
│   │   │   ├── updates-check.ts
│   │   │   ├── usage-data.ts
│   │   │   ├── wizard-models.ts
│   │   │   └── workspace-area.ts
│   │   │   └── … 68 files in total
│   │   ├── test/
│   │   │   ├── agents.test.ts
│   │   │   ├── background-cards.test.ts
│   │   │   ├── background-jobs.test.ts
│   │   │   ├── chat-edits.test.ts
│   │   │   ├── command-registry.test.ts
│   │   │   ├── context.test.ts
│   │   │   ├── customizations.test.ts
│   │   │   ├── declarations.test.ts
│   │   │   ├── disabled-tools.test.ts
│   │   │   ├── durable-cards.test.ts
│   │   │   ├── durable-client.test.ts
│   │   │   ├── durable-daemon-agent.test.ts
│   │   │   ├── durable-folder.test.ts
│   │   │   ├── durable-run-stream.test.ts
│   │   │   ├── durable-sessions.test.ts
│   │   │   ├── durable-spawn.test.ts
│   │   │   ├── durable-tasks.test.ts
│   │   │   ├── left-behind-packages.test.ts
│   │   │   ├── mcp-add.test.ts
│   │   │   ├── mcp-cwd.test.ts
│   │   │   ├── mcp-discovered.test.ts
│   │   │   ├── mcp-provider.test.ts
│   │   │   ├── mcp-signin-scope.test.ts
│   │   │   ├── mcp-signin.test.ts
│   │   │   ├── models-cache.test.ts
│   │   │   ├── npm-run.test.ts
│   │   │   ├── packages-data.test.ts
│   │   │   ├── packages-install.test.ts
│   │   │   ├── packages-manage.test.ts
│   │   │   ├── packages-registry.test.ts
│   │   │   ├── packages-updates.test.ts
│   │   │   ├── permissions.test.ts
│   │   │   ├── pi-locate.test.ts
│   │   │   ├── pi-sdk-builtins.test.ts
│   │   │   ├── picode-auth-callback.test.ts
│   │   │   ├── pin-sync.test.ts
│   │   │   ├── provider-stream.test.ts
│   │   │   ├── providers-list.test.ts
│   │   │   ├── session-cwd.test.ts
│   │   │   ├── session-listing.test.ts
│   │   │   ├── sessions-backup.test.ts
│   │   │   ├── sessions-import-plan.test.ts
│   │   │   ├── sessions-provider.test.ts
│   │   │   ├── theme-catalog.test.ts
│   │   │   ├── updates-check.test.ts
│   │   │   ├── usage-data.test.ts
│   │   │   └── workspace-area.test.ts
│   │   │   └── … 47 files in total
│   │   ├── package.json
│   │   ├── README.md
│   │   ├── tsconfig.json
│   │   └── tsconfig.test.json
│   ├── cgmanifest.json
│   ├── CONTRIBUTING.md
│   ├── esbuild-common.mts
│   ├── esbuild-extension-common.mts
│   ├── esbuild-webview-common.mts
│   ├── package-lock.json
│   ├── package.json
│   ├── postinstall.mjs
│   ├── README.md
│   ├── tsconfig.base.json
│   └── … and 86 upstream built-in extensions (only picode/ is ours)
├── remote/ · ⬆️ upstream, no breakdown
├── resources/
│   ├── picode/ — Las imágenes del propio repositorio (no las del producto): lo que se ve en el README público y en la cabecera de GitHub.
│   │   ├── pi.svg
│   │   ├── picode-banner.png
│   │   ├── README.md
│   │   └── vscodium.svg
│   └── … and 5 upstream built-in extensions (only picode/ is ours)
├── scripts/ · ⬆️ upstream, no breakdown
├── src/ — Carpeta upstream: aquí no se documenta fichero a fichero. Son los 9.400 ficheros del editor de VS Code tal como descienden de upstream/stable.json… · ⬆️ upstream, no breakdown
├── updates/ — The static documents the editor's updater reads. They are served directly from this directory by raw.githubusercontent.com, which is why there is no…
│   ├── experimental/ — Los documentos estáticos que lee el actualizador del editor para el canal experimental, servidos tal cual desde raw.githubusercontent.com (por eso no…
│   │   ├── win32/
│   │   │   └── x64/
│   │   │       ├── archive/
│   │   │       │   └── latest.json
│   │   │       └── user/
│   │   │           └── latest.json
│   │   └── README.md
│   └── README.md
├── upstream/ — Un único fichero que dice de dónde viene el árbol: la versión y el commit exacto de VS Code del que desciende the tree.
│   ├── README.md
│   └── stable.json
├── _typos.toml — False positives of the `typos` spell checker.
├── AGENTS.md — 📋 The owner's phrases: product, UI, architecture and working rules.
├── cglicenses.json
├── cgmanifest.json
├── CODE_OF_CONDUCT.md — 🤝 The repository's code of conduct.
├── CONTRIBUTING.md — 🤝 How to contribute and how the tree of our own is published.
├── gulpfile.mjs
├── LICENSE — The product's MIT license.
├── package-lock.json
├── package.json
├── product.json
├── README.md — 🌍 Public face: what PiCode is, downloads and how to build it.
├── repomix.config.json — Settings for the repository dump for LLMs.
├── SECURITY.md — 🛡️ How to report a vulnerability.
└── tsfmt.json
```

## ⚠️ Folders without a README

- `build/agent-sdk/agents/`
- `build/checker/`
- `build/checksums/`
- `build/codex/`
- `build/dictation-runtime/`
- `build/lib/gulp/`
- `build/lib/mangle/`
- `build/lib/policies/`
- `build/lib/stylelint/`
- `build/lib/tsb/`
- `build/lib/watch/`
- `build/linux/debian/`
- `build/linux/rpm/`
- `build/monaco/`
- `build/next/`
- `build/next/devTunnelsShims/`
- `build/npm/`
- `build/npm/gyp/`
- `build/rspack/`
- `build/vite/`

## 📖 How the documentation is organized

- `docs/` — the internal papers (vision, design, decisions, tasks): index in [`docs/README.md`](README.md).
- `README.md` of each folder — what that folder does and what is inside it.
- File level: only when the name does not explain the file, a two-line header.
- The "who calls whom" lives in the code graph (`.codegraph/`), not here.
