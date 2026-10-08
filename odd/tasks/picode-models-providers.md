# Feature: conectar proveedores y modelos propios, para la instancia elegida

## Goal

Make the Modelo category of the settings panel able to bring a provider and its
models in, for whichever pi is selected: PiCode's own internal instance, or the
external one the owner already has on the machine. Today the panel can only *choose*
among the providers and models some pi already has; it cannot add one.

## Why

The owner's words (2026-09-23):

> "necesito que en la config de modelos también podamos conectar proveedores, y
> modelos y tal para cualqueir pi ya sea para el interno o el externo."

Read as three facts about the surface:

1. Connecting a provider belongs **in the models configuration**, next to the
   provider and model rows, not only in the command palette.
2. Models, and not just credentials, are part of it: a provider that is not in pi's
   own catalogue — Ollama, LM Studio, vLLM, a gateway, a proxy — exists only if
   someone declares its endpoint and its model ids in `models.json`.
3. It applies to **either instance**. The login that exists today refuses when the
   owner's own pi is selected, so the external instance cannot be configured from
   the editor at all.

## What is already true (verified, not assumed)

- **pi stores two different things in two different files.** Credentials (an API key
  or an OAuth token) live in `auth.json` and are written by pi's own login
  (`ModelRuntime.login`, reachable from the editor through the SDK, already wired by
  T6b/T5c). A compatible endpoint and its model ids live in `models.json`
  (`{"providers": {"<id>": {baseUrl, api, apiKey, models: [{id, …}], …}}}`), a file
  pi **loads but never writes**: its `ModelConfig` has a `load` and no writer, and
  pi's own documentation tells the owner to add the entry by hand. Opening `/model`
  reloads it (`docs/models.md`, `docs/custom-provider.md`).
- **`models.json` is validated by pi, not by PiCode.** A provider without `baseUrl`
  or without an `api` throws inside pi (`applyModelsJson`), and a model without an
  `api` inherits the provider's. pi's accepted `api` ids on this machine:
  `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai`, `google-vertex`, `mistral-conversations`,
  `azure-openai-responses`, `bedrock-converse-stream`, `openai-codex-responses`,
  `pi-messages`.
- **`models.json` may hold `apiKey`** as a literal, as `$NAME`/`${NAME}` environment
  interpolation, or as a leading `!command`. The same three forms pi accepts.
- **The editor already logs a provider in from the panel's own surface** (command
  `picode.piChat.loginProvider`), but its target is the **unguarded** internal
  profile and it stops with a Spanish refusal when the selected instance is the
  owner's (`LOGIN_TEXTS.ownerInstance`). The refusal was the whole point of T5c:
  PiCode owned exactly one profile and would not write the owner's.
- **The settings panel governs the profile in force** (`selectedAgentDir`), and the
  anti-mute guard answers the owner's profile while PiCode's own is still empty —
  the panel already says so, in its own words, on the `picode.instanceProfile` row.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Which profile a login writes to | The profile of the **selected instance**, unguarded: `managed` → `<distribution>/data/pi-agent`; `path`/`custom` → `PI_CODING_AGENT_DIR`, else `~/.pi/agent` | One rule for both instances, and it is the profile that instance actually reads. It keeps T5c's rule for the internal instance — a login is what *fills* an empty PiCode profile — and extends it to the external one, which is what the owner asked for |
| Writing the owner's profile | **Allowed**, on this explicit request, behind one confirmation that names the profile | `picode-pi-instances.md` set the owner's profile read-only *for that feature*; the owner has now asked for the opposite for this one. The reversal is recorded there, and the confirmation is what keeps it a decision instead of an effect |
| A login is confirmed, not silent | The confirmation appears **only when the target is the owner's own profile** | Behind PiCode's own profile the write is the feature's normal outcome; behind the owner's, it is a file another tool also owns |
| One confirmation per write, never two | Quitting a declared provider always asks; writing in the owner's profile asks as well; when both are true there is **one** modal that says what is about to happen and in which profile | The entry may carry keys the form never collected (`contextWindow`, `headers`), so a removal is not free, and asking twice about one decision reads as a broken dialog. The button is the models surface's own instead of the login's, because it also fronts a removal and one label has to fit both |
| `models.json` writes | Direct read-modify-write of the JSON, through `src/models-config.ts` | pi has no setter for that file; the documented way in is the file. The module preserves every key it does not own, refuses a file that does not parse, and replaces the file with a rename |
| A file PiCode cannot read | Refused, never overwritten | A `models.json` that is not JSON, or whose `providers` is not an object, is a file a stranger wrote. The command says so and stops, because a write over it would drop whatever it held |
| An API key in `models.json` | One field that accepts pi's own three forms — `$NAME`, a literal, or `!command` — with the placeholder saying so; it never echoes, and no sentence, log or test prints it back | The three forms are pi's, and formatting them as a choice would be three steps for one value. The env var is what the placeholder recommends, the literal is what a local endpoint wants, and the field is masked because a literal is the key itself. Empty means “leave the key the entry already has”, so a re-save never drops a working credential |
| Removing a custom provider | Offered, on the same surface | An endpoint that is added with a typo must be removable without a terminal, or the surface creates work it cannot undo |
| Logging a provider **out** | Deliberately out of scope here | pi does expose `logout`, but a session-scoped disconnect has its own questions (which profile, which ending). It is recorded as an open question rather than built by inertia |

## Tasks

Worked in this order. A task is checked only when its outcome and its checks were
observed; every task closes with one work-unit commit on the feature branch,
recorded here as evidence.

- [x] **T1 — El perfil de la instancia elegida, y el login para los dos.**
  `instanceProfileDir(extensionUri, runtime)` en `instance.ts`: `managed` →
  `<distribución>/data/pi-agent`, `path`/`custom` → el perfil de la máquina
  (`PI_CODING_AGENT_DIR`, si no `~/.pi/agent`). Siempre concreto, sin la guarda
  anti-mudez, porque un login existe para llenar un perfil vacío. `loginProvider` lo
  usa como destino en vez de `instanceAgentDir`, y cuando el destino es el perfil del
  dueño pide **una** confirmación que lo nombra antes de escribir nada.
  Los dos nombres del perfil tienen un solo hogar (`profileNameFor`), porque ahora los
  usan tres superficies. Nada se escribe antes de esa confirmación: la credencial, que
  es la escritura, va después.
- [x] **T2 — `models.json` de una instancia: leer, fusionar, escribir.**
  `src/models-config.ts`, sin `vscode`: parseo tolerante, fusión que conserva lo que no
  es suyo, alta y baja de un proveedor, resumen para la fila del panel, y escritura por
  reemplazo atómico que rechaza un fichero ilegible en vez de pisarlo.
- [x] **T3 — El comando, las filas del panel y su cableado.**
  `picode.piChat.modelsProviders`: enseña lo que hay en el `models.json` del perfil de
  la instancia elegida, añade un proveedor (id, dirección, `api`, clave, ids de modelo)
  o quita uno, informa de lo escrito y ofrece recargar la ventana. En la categoría
  **Modelo** del panel: «Iniciar sesión en un proveedor» y «Proveedores y modelos
  propios», cada una con el comando que ya existe detrás y con el resumen del
  `models.json` en vigor, más la descripción de la categoría diciendo que sirven para las
  dos instancias.
  Dos decisiones que la implementación tuvo que tomar y que quedan escritas:
  **una confirmación por escritura, nunca dos** (quitar un proveedor siempre pregunta,
  porque la entrada puede llevar claves que la forma no recogió; escribir en el perfil del
  dueño pregunta por la misma razón que el login; cuando las dos cosas coinciden hay **un**
  diálogo que dice qué se va a hacer y en qué perfil), y **un nombre para cada cosa** (la
  fila y la paleta dicen «Iniciar sesión en un proveedor», que es como ya lo llamaban la
  paleta y el asistente, en vez de introducir un sinónimo).
- [x] **T4 — Registro.** El cierre, con los commits como evidencia.

## Open questions

- Logging a provider out from the editor (see the decisions table).
- **Quitar la clave de una entrada** que ya la tiene: la forma solo sabe ponerla o dejarla
  como estaba, así que borrarla es hoy un edit del fichero. Es el único camino del panel
  que no tiene puerta de vuelta, y está anotado aquí en vez de resuelto adivinando (el
  candidato obvio, un valor centinela en el campo, se lee como una clave más).
- Whether the panel should also show the credentials already stored (`auth.json`
  provider names), which the `Estado` category reads today.
- A provider that needs an extension (custom streaming or OAuth) is still a package
  install, not a `models.json` entry: that is pi's own boundary and is not crossed
  here.
- The pi popup menu (`menu.ts`) is deliberately not touched: the panel is where
  configuration lives now, and the two rows are there. The command is still in the
  palette for anyone who looks for it there.

## Evidence

- Work-unit commits, `npm test` green with per-suite counts on each.
- **T1**: `instanceProfileDir()` + `profileNameFor()` in `src/instance.ts`, the login
  retargeted in `src/pi-login-command.ts`, 3 new checks in `test/instance.test.js` and
  the login suite rewritten around the new rule — 25 and 53 checks pass, plus
  `instance-wiring` (7) and `onboarding` (29) untouched and green. The reversal is
  recorded in `AGENTS.md` and in `picode-pi-instances.md`.
- **T2**: `src/models-config.ts` (509 lines, pure half plus `node:fs`) and
  `test/models-config.test.js` — 57 checks, including the two source guards (no editor
  import, never names `auth.json`) and real file I/O in a temp directory (missing file,
  a directory as the target, write → read → parse, no leftover temp, a failed replace
  that still removes its temp, and the `0o600` rule only for a **literal** key and only
  off Windows).
- **T3**: `src/models-command.ts` and `test/models-command.test.js` (52 checks), the two
  `modelo` rows and the models.json state source in `src/pi-settings.ts`, the registration
  and the state-source wiring in `src/extension.ts`, and the command in `package.json`.
  `pi-settings` went from the one expected failure to 85 green. **The whole chain**:
  `npm test` exits 0 — 30 suites, 1163 checks, no failure. Three defects were found
  reviewing the writer's output and fixed before the commit: the owner's profile was being
  written with no confirmation, removing a declared provider asked nothing (and an entry
  may carry keys the form never collected), and the key field echoed a literal credential.
  The suite grew the three guards for exactly those. Two smaller ones: `pickPlaceHolder`
  was declared and never used (deleted — dead copy is the redundancy this project
  rejects), and one doc comment claimed `json` was `undefined` exactly when `problem` was
  set, which a missing file contradicted: a missing file is now `{}`, which is what pi
  itself reads.
- **T5 (the verification pass)**: four more defects, found by the independent read-only
  review and fixed in `e6d1c04` — see *Independent verification* below. Their suites grew
  with them (`models-config` 57 → 65, `models-command` 47 → 52).
- **T4**: the distribution re-staged so the editor actually carries it:
  `distribution/apply-picode.ps1 -Apply` reported the product already matching its
  delta, the portable profile and `settings.json` untouched, and staged the panel into
  `resources/app/extensions/picode-pi-chat` — the folder now holds
  `models-command.js`, `models-config.js` and the new command in `package.json`. That
  tree is a build artifact (untracked), so the staging is reported here instead of in a
  commit.
- **Independent verification** (read-only) over the three commits:
  result below.

## Independent verification

Read-only pass over the three commits, and **four confirmed defects**
found and fixed (`e6d1c04`), each one reachable:

1. **PiCode refused files pi accepts.** pi parses `models.json` as
   `JSON.parse(stripJsonComments(stripBom(content)))`, so `//` comments, a trailing comma
   and a BOM are readable there; `JSON.parse` alone called such a file invalid. The
   tolerances are now mirrored from pi's own `dist/utils/json.js`, and the file that comes
   back normalized says so, because the write serializes the parsed object.
2. **The mirror image was wrong too.** One provider that is not an object, or models that
   are not `{ id }` objects, makes pi discard **every** entry in the file. Those two shapes
   are now refused, because listing providers pi is ignoring — and promising a reload that
   reads nothing — is worse than refusing the file.
3. **A literal key was briefly world-readable.** The temp file was created at the default
   mode and the target narrowed after the rename, so the secret existed at 0644 until the
   rename — and forever if the process died in that window. The temp is now created at the
   owner's mode, as pi's own credential writer does.
4. **The reload was promised where it does nothing.** With PiCode's own pi selected and its
   profile still unusable, the file lands in a profile the running agent does not read; the
   ending now says that and offers no button — the same rule the import's closing follows.

Also fixed from the same report: a failed write named the filesystem's raw message, which
carries the profile's path onto the screen, and it now names a code the owner can act on;
and a provider's `name` was parsed and never shown, which is the dead data this project
does not keep lying around.

Two suspicions are **accepted, not fixed**, and written down so nobody rediscovers them:
the read-modify-write window from the pickers to the write can drop a provider another
window added in the same seconds (single-user desktop, and locking the file is pi's own
business), and the login's no-session fallback still builds the target runtime — which may
create the profile directory and an empty `auth.json` — before its modal. In both cases
what is written is the profile the selection names, so neither can land a credential or a
provider in a profile the owner did not choose.
