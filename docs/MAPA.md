# 🗺️ Mapa del repositorio

> **Generado** con `node dev/map-docs.mjs` — no editar a mano.
> Cada carpeta se describe con **la primera línea de su propio `README.md`**:
> si aquí pone «sin README», el hueco está en la lista de abajo.

## 📊 Estado

- **21** carpetas documentadas · **0** sin README.
- Ficheros de la raíz descritos: 12.

## 🌳 Árbol

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
│   └── PULL_REQUEST_TEMPLATE.md
├── assets/ — Las imágenes del propio repositorio (no las del producto): lo que se ve en el README público y en la cabecera de GitHub.
│   ├── pi.svg
│   ├── picode-banner.png
│   └── vscodium.svg
├── builder/ — The window for building PiCode. C# and WinUI 3, in this folder so the pipeline in dev/ stays what it is: the engine, runnable without any of this,…
│   ├── Assets/
│   │   ├── brands/ — The marks of the tools the build needs, so the panel shows each one as itself instead of a tick.
│   │   │   ├── git.svg
│   │   │   ├── json.svg
│   │   │   ├── linux.svg
│   │   │   ├── nodedotjs.svg
│   │   │   ├── python.svg
│   │   │   ├── README.md
│   │   │   └── rust.svg
│   │   └── picode-builder-background.svg
│   ├── app.manifest
│   ├── App.xaml
│   ├── App.xaml.cs
│   ├── build.cmd
│   ├── MainWindow.xaml
│   ├── MainWindow.xaml.cs
│   ├── PiCode.Builder.csproj
│   ├── Pipeline.cs
│   ├── publish.cmd
│   └── README.md
├── cloud/ — Todo lo que vive en la nube: la única parte de pago del producto. El editor es gratis y completo; esto es la sincronización y el respaldo de la…
│   └── sync-api/ — The backend of PiCode's sync service: it implements the REST contract the editor's Settings Sync engine expects, authenticates against Firebase Auth,…
│       ├── src/
│       │   ├── app/
│       │   │   └── api/
│       │   │       ├── health/
│       │   │       │   └── route.ts
│       │   │       └── v1/
│       │   │           ├── account/
│       │   │           ├── collection/
│       │   │           ├── download/
│       │   │           ├── manifest/
│       │   │           └── resource/
│       │   └── lib/
│       │       ├── auth.ts
│       │       ├── contract.ts
│       │       ├── crypto.ts
│       │       ├── firebase-admin.ts
│       │       ├── http.ts
│       │       ├── plans.ts
│       │       ├── quota.ts
│       │       ├── retention.ts
│       │       └── store.ts
│       ├── test/
│       │   ├── plans.test.ts
│       │   └── retention.test.ts
│       ├── firebase.json
│       ├── firestore.indexes.json
│       ├── firestore.rules
│       ├── next-env.d.ts
│       ├── next.config.mjs
│       ├── package-lock.json
│       ├── package.json
│       ├── README.md
│       └── tsconfig.json
├── dev/ — dev/ builds PiCode from its own source tree.
│   ├── release-notes/ — La descripción que encima del changelog en cada página de release, una por canal. El resumen agrupado por tipo de cambio (novedades, arreglos,…
│   │   ├── beta.md
│   │   ├── experimental.md
│   │   └── stable.md
│   ├── brand-copy.mjs
│   ├── build-connector.sh
│   ├── build-installer.sh
│   ├── build-live.sh
│   ├── build-progress.mjs
│   ├── build-requirements.mjs
│   ├── build-run.sh
│   ├── build-window.cmd
│   ├── build-window.ps1
│   ├── build.sh
│   ├── check-mcp-entries.mjs
│   ├── data-hold.sh
│   ├── deps-current.mjs
│   ├── durable-runtime.sh
│   ├── ico-to-png.mjs
│   ├── make-inno-images.mjs
│   ├── patch-inno-updater.mjs
│   ├── patch-vscode-languageserver.mjs
│   ├── pi-runtime.sh
│   ├── prune-platform-binaries.mjs
│   ├── README.md
│   ├── release-notes.mjs
│   ├── restore-profile.mjs
│   ├── stage-distribution.sh
│   └── update-feed.mjs
│   └── … 25 ficheros en total
├── distribution/ — Operator guide for distribution/. The strategy behind these files is in docs/DISTRIBUTION.md; this file is the short runbook.
│   ├── apply-product-delta.mjs
│   ├── picode-icon.svg
│   ├── picode.ico
│   ├── picode.svg
│   ├── product-delta.json
│   ├── README.md
│   ├── runtime.json
│   └── settings.json
├── docs/ — Los papeles que deciden cómo se junta todo. Las palabras del dueño viven en AGENTS.md; la cara pública (README, wiki) se escribe desde aquí, no al…
│   ├── ARCHITECTURE.md
│   ├── CI.md
│   ├── DECISIONS.md
│   ├── DISENO.md
│   ├── DISTRIBUTION.md
│   ├── HARNESS.md
│   ├── howto-build.md
│   ├── README.md
│   ├── TAREAS.md
│   └── VISION.md
├── picode-source/ — Es el editor entero: la fuente de VS Code con los cambios de VSCodium y los nuestros ya dentro, versionada en este repositorio. No es una descarga ni…
│   ├── build/ · ⬆️ upstream, sin desglose
│   ├── cli/ — Carpeta upstream: aquí no se documenta fichero a fichero. Es el código fuente del comando code (VS Code CLI) tal como desciende de… · ⬆️ upstream, sin desglose
│   ├── durable/ — A self-contained program that runs @earendil-works/pi-durable (1.2.0) against the owner's LAN gateway OmniRoute and proves, with real runs, the three…
│   │   ├── lib/
│   │   │   ├── acp.js
│   │   │   ├── agents.js
│   │   │   ├── client.js
│   │   │   ├── common.js
│   │   │   ├── daemon.d.ts
│   │   │   ├── daemon.js
│   │   │   ├── extensions.js
│   │   │   ├── guard.js
│   │   │   ├── mcp.js
│   │   │   ├── profile.js
│   │   │   ├── protocol.js
│   │   │   ├── render.js
│   │   │   ├── settings.js
│   │   │   └── skills.js
│   │   ├── cli.js
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── proof-acp.sh
│   │   ├── proof-daemon.sh
│   │   ├── proof-editor-lifecycle.js
│   │   ├── proof-record.js
│   │   ├── proof1-kill.js
│   │   ├── proof1-resume.js
│   │   ├── proof2-subagent.js
│   │   ├── proof3-two-clients.js
│   │   ├── README.md
│   │   └── smoke.js
│   ├── durable-acp-client/ — A deliberately small ACP client that proves picode-source/durable speaks the Agent Client Protocol (v1) over stdio (node cli.js acp). It speaks raw…
│   │   ├── client.js
│   │   └── README.md
│   ├── durable-bridge/ — A pi extension (TypeScript, loaded by path — nothing is installed into any pi, and no pi directory is written) that bridges the coding agent you use…
│   │   ├── extension.ts
│   │   ├── proof-kill-survive.mjs
│   │   └── README.md
│   ├── extensions/ — Casi todo lo que hay aquí es upstream: las extensiones que VS Code trae de serie (git, json, markdown, typescript-language-features…), tal como…
│   │   ├── picode/ — La pieza que hace que el chat exista. Es el puente entre el editor y pi: registra al agente en el chat, descubre proveedores y modelos, entrega MCP,…
│   │   │   ├── media/
│   │   │   │   ├── picode-light.svg
│   │   │   │   ├── picode-status.svg
│   │   │   │   └── picode.svg
│   │   │   ├── src/
│   │   │   │   ├── agent.ts
│   │   │   │   ├── agents.ts
│   │   │   │   ├── background-cards.ts
│   │   │   │   ├── background-jobs.ts
│   │   │   │   ├── chat-edits.ts
│   │   │   │   ├── chat-record.ts
│   │   │   │   ├── command-registry.ts
│   │   │   │   ├── commands.ts
│   │   │   │   ├── context.ts
│   │   │   │   ├── customizations.ts
│   │   │   │   ├── declarations.ts
│   │   │   │   ├── durable-cards.ts
│   │   │   │   ├── durable-client.ts
│   │   │   │   ├── durable-folder.ts
│   │   │   │   ├── durable-run-stream.ts
│   │   │   │   ├── durable-sessions-register.ts
│   │   │   │   ├── durable-sessions.ts
│   │   │   │   ├── durable-spawn.ts
│   │   │   │   ├── durable-tasks.ts
│   │   │   │   ├── durable.ts
│   │   │   │   ├── editor-context.ts
│   │   │   │   ├── endpoint.ts
│   │   │   │   ├── extension.ts
│   │   │   │   ├── import-project.ts
│   │   │   │   ├── left-behind-packages.ts
│   │   │   │   ├── login.ts
│   │   │   │   ├── mcp-add.ts
│   │   │   │   ├── mcp-cwd.ts
│   │   │   │   ├── mcp-provider.ts
│   │   │   │   ├── mcp-scopes.ts
│   │   │   │   ├── mcp.ts
│   │   │   │   ├── mcpServers.ts
│   │   │   │   ├── mcpTools.ts
│   │   │   │   ├── models-cache.ts
│   │   │   │   ├── npm-run.ts
│   │   │   │   ├── onboarding.ts
│   │   │   │   ├── packages-data.ts
│   │   │   │   ├── packages-install.ts
│   │   │   │   ├── packages-manage.ts
│   │   │   │   ├── packages-registry.ts
│   │   │   │   ├── packages-updates.ts
│   │   │   │   ├── permissions.ts
│   │   │   │   ├── piConfig.ts
│   │   │   │   ├── piLocate.ts
│   │   │   │   ├── piSdk.ts
│   │   │   │   ├── profile-import.ts
│   │   │   │   ├── progress.ts
│   │   │   │   ├── provider-stream.ts
│   │   │   │   ├── providerIds.ts
│   │   │   │   ├── providers-list.ts
│   │   │   │   ├── providers.ts
│   │   │   │   ├── runtime.ts
│   │   │   │   ├── session-cwd.ts
│   │   │   │   ├── sessions-backup.ts
│   │   │   │   ├── sessions-import-plan.ts
│   │   │   │   ├── sessions-import.ts
│   │   │   │   ├── sessions-provider.ts
│   │   │   │   ├── sessions-resume.ts
│   │   │   │   ├── status-data.ts
│   │   │   │   ├── status-view.ts
│   │   │   │   ├── subscriptions.ts
│   │   │   │   ├── theme-catalog.ts
│   │   │   │   ├── theme-gallery.ts
│   │   │   │   ├── theme-types.ts
│   │   │   │   ├── updates-check.ts
│   │   │   │   ├── usage-data.ts
│   │   │   │   ├── wizard-models.ts
│   │   │   │   └── workspace-area.ts
│   │   │   │   └── … 68 ficheros en total
│   │   │   ├── test/
│   │   │   │   ├── agents.test.ts
│   │   │   │   ├── background-cards.test.ts
│   │   │   │   ├── background-jobs.test.ts
│   │   │   │   ├── chat-edits.test.ts
│   │   │   │   ├── command-registry.test.ts
│   │   │   │   ├── context.test.ts
│   │   │   │   ├── customizations.test.ts
│   │   │   │   ├── declarations.test.ts
│   │   │   │   ├── disabled-tools.test.ts
│   │   │   │   ├── durable-cards.test.ts
│   │   │   │   ├── durable-client.test.ts
│   │   │   │   ├── durable-daemon-agent.test.ts
│   │   │   │   ├── durable-folder.test.ts
│   │   │   │   ├── durable-run-stream.test.ts
│   │   │   │   ├── durable-sessions.test.ts
│   │   │   │   ├── durable-spawn.test.ts
│   │   │   │   ├── durable-tasks.test.ts
│   │   │   │   ├── left-behind-packages.test.ts
│   │   │   │   ├── mcp-add.test.ts
│   │   │   │   ├── mcp-cwd.test.ts
│   │   │   │   ├── mcp-discovered.test.ts
│   │   │   │   ├── mcp-provider.test.ts
│   │   │   │   ├── mcp-signin-scope.test.ts
│   │   │   │   ├── mcp-signin.test.ts
│   │   │   │   ├── models-cache.test.ts
│   │   │   │   ├── npm-run.test.ts
│   │   │   │   ├── packages-data.test.ts
│   │   │   │   ├── packages-install.test.ts
│   │   │   │   ├── packages-manage.test.ts
│   │   │   │   ├── packages-registry.test.ts
│   │   │   │   ├── packages-updates.test.ts
│   │   │   │   ├── permissions.test.ts
│   │   │   │   ├── pi-sdk-builtins.test.ts
│   │   │   │   ├── picode-auth-callback.test.ts
│   │   │   │   ├── provider-stream.test.ts
│   │   │   │   ├── providers-list.test.ts
│   │   │   │   ├── session-cwd.test.ts
│   │   │   │   ├── session-listing.test.ts
│   │   │   │   ├── sessions-backup.test.ts
│   │   │   │   ├── sessions-import-plan.test.ts
│   │   │   │   ├── sessions-provider.test.ts
│   │   │   │   ├── theme-catalog.test.ts
│   │   │   │   ├── updates-check.test.ts
│   │   │   │   ├── usage-data.test.ts
│   │   │   │   └── workspace-area.test.ts
│   │   │   │   └── … 45 ficheros en total
│   │   │   ├── package.json
│   │   │   ├── tsconfig.json
│   │   │   └── tsconfig.test.json
│   │   ├── cgmanifest.json
│   │   ├── CONTRIBUTING.md
│   │   ├── esbuild-common.mts
│   │   ├── esbuild-extension-common.mts
│   │   ├── esbuild-webview-common.mts
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── postinstall.mjs
│   │   ├── tsconfig.base.json
│   │   └── … y 86 extensiones built-in de upstream (solo picode/ es nuestra)
│   ├── remote/ · ⬆️ upstream, sin desglose
│   ├── resources/ · ⬆️ upstream, sin desglose
│   ├── scripts/ · ⬆️ upstream, sin desglose
│   ├── src/ — Carpeta upstream: aquí no se documenta fichero a fichero. Son los 9.400 ficheros del editor de VS Code tal como descienden de upstream/stable.json… · ⬆️ upstream, sin desglose
│   ├── cglicenses.json
│   ├── cgmanifest.json
│   ├── gulpfile.mjs
│   ├── package-lock.json
│   ├── package.json
│   ├── product.json
│   └── tsfmt.json
├── updates/ — The static documents the editor's updater reads. They are served directly from this directory by raw.githubusercontent.com, which is why there is no…
│   ├── experimental/ — Los documentos estáticos que lee el actualizador del editor para el canal experimental, servidos tal cual desde raw.githubusercontent.com (por eso no…
│   │   └── win32/
│   │       └── x64/
│   │           ├── archive/
│   │           │   └── latest.json
│   │           └── user/
│   │               └── latest.json
│   └── README.md
├── upstream/ — Un único fichero que dice de dónde viene el árbol: la versión y el commit exacto de VS Code del que desciende picode-source/.
│   └── stable.json
├── _typos.toml — Falsos positivos del corrector ortográfico `typos`.
├── AGENTS.md — 📋 Las frases del dueño: reglas de producto, UI, arquitectura y forma de trabajar.
├── CODE_OF_CONDUCT.md — 🤝 Código de conducta del repositorio.
├── CONTRIBUTING.md — 🤝 Cómo se contribuye y cómo se publica el árbol propio.
├── LICENSE — Licencia MIT del producto.
├── README.md — 🌍 Cara pública: qué es PiCode, descargas y cómo compilarlo.
├── repomix.config.json — Configuración del volcado del repositorio para LLMs.
└── SECURITY.md — 🛡️ Cómo se reporta una vulnerabilidad.
```

## ⚠️ Carpetas sin README

Ninguna: todas las carpetas del mapa tienen su ficha.

## 📖 Cómo está organizada la documentación

- `docs/` — los papeles internos (visión, diseño, decisiones, tareas): índice en [`docs/README.md`](README.md).
- `README.md` de cada carpeta — qué hace esa carpeta y qué hay dentro.
- Nivel fichero: solo cuando el nombre no explica el fichero, una cabecera de dos líneas.
- El «quién llama a quién» está en el grafo de código (`.codegraph/`), no aquí.
