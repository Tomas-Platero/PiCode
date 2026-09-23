import * as vscode from "vscode";
import { GENTLE_PACKAGE, type GentleState } from "./gentle";
import { IMPORT_PROFILE_COMMAND } from "./instance-import-command";
import { LOGIN_PROVIDER_COMMAND } from "./pi-login-command";
import type { InstanceProfileState } from "./pi-settings";
import type { RuntimeDescriptor, RuntimeMode } from "./runtime";
import type { ApplyResult, ThemePreviewResult, ThemeRow } from "./theme-service";
import { appliedMessage, externalUrlToOpen } from "./theme-view";
import { buildWebviewHtml } from "./webview-html";

/**
 * The initial-setup wizard.
 *
 * Two questions — which pi runs and whether Gentle AI is switched on — and a closing
 * summary of what the editor is now wired to. A `WebviewPanel`, like the settings tab,
 * so it is a repeatable tab rather than a modal that disappears with its own answers.
 *
 * Nothing here reimplements the runtime switch or the install. The host is injected,
 * and the extension wires it to the functions the runtime picker and the packages
 * table already call; a wizard with a private copy of the install would leave a second
 * definition of what installing pi or a package means. That reuse is what makes the
 * end state integrated instead of "configure it again afterwards".
 *
 * The pi question carries one part that is not a third question: while PiCode's own pi is
 * selected and its profile cannot carry an instance yet, the step says so and offers the two
 * doors that end it — the import and the provider login. Both are the commands that already
 * exist, run by the host; the wizard only names them, which is the same rule as the install
 * above. No path through the wizard ends in "now run this in a terminal".
 *
 * That part also decides where the step stops advancing by itself: it says something, so the
 * step stays until it is read, and it carries the step's own way forward for the owner who
 * wants to keep running his pi meanwhile. Both travel together — the button lives inside the
 * part — so a profile that just became usable takes the warning and the way out at once, and
 * applying the pi is then what moves the step on.
 *
 * The decision of what that part says is pure (`describeProfilePart`), so the three states —
 * PiCode's own pi without a profile, with one, and the owner's pi — can be exercised without
 * an editor, and the renderer is left with nothing to decide.
 *
 * The markup and the renderer live in `media/onboarding.{js,css}`, the same host /
 * webview split every other panel in this extension uses.
 */

/**
 * The memory half of the Gentle AI layer.
 *
 * `gentle-pi` is the orchestrator — ODD, the method the layer is built around — and it
 * is what the rest of this codebase installs. The memory provider is a separate package,
 * and nothing else ever installed it; the wizard is where the two go in together, because
 * "activate Gentle AI" is one decision and two commands.
 */
export const GENTLE_MEMORY_PACKAGE = "gentle-engram";

/** The npm sources the Gentle AI question installs, in one confirmation. */
export const GENTLE_SOURCES: readonly string[] = [
  `npm:${GENTLE_PACKAGE}`,
  `npm:${GENTLE_MEMORY_PACKAGE}`,
];

/** Where the closing summary sends the owner next. */
export type OnboardingTarget = "chat" | "settings" | "gentle";

export interface OnboardingResult {
  ok: boolean;
  message: string;
}

/* ------------------------------------------------------------------ *
 * The profile part of the pi question
 * ------------------------------------------------------------------ */

/**
 * The commands the profile part's two doors run, taken from the modules that implement them.
 *
 * A literal here would be the second declaration of a command id, and the wizard would keep
 * offering a name that no longer exists the day one is renamed. The union also makes "run
 * something else" a type error, not a habit.
 */
export type OnboardingOfferCommand =
  | typeof IMPORT_PROFILE_COMMAND
  | typeof LOGIN_PROVIDER_COMMAND;

/** One door out of an unusable profile: what it says and the command it runs. */
export interface OnboardingOffer {
  /** The command's own palette title, without the product prefix every title carries. */
  readonly label: string;
  /** The command to run, through its existing implementation and not a copy of it. */
  readonly command: OnboardingOfferCommand;
}

/**
 * What the pi step says about the profile of the instance in force.
 *
 * `visible` is part of the answer rather than something the renderer infers, so the three
 * states cannot be half-drawn: there is no text to show without the decision to show it.
 */
export interface OnboardingProfilePart {
  /** True only while PiCode's own pi is selected and its profile cannot carry an instance. */
  readonly visible: boolean;
  /** The sentence the step shows, empty when the part is not visible. */
  readonly text: string;
  /** The doors to fill the profile, empty when the part is not visible. */
  readonly offers: readonly OnboardingOffer[];
}

/**
 * The two ways PiCode's own profile can be unusable, in the settings row's own words.
 *
 * `pi-settings.ts` words the same distinction the same way, and `onboarding.test.js` pins
 * both against that file's source: a profile that is absent and one that has no credentials
 * are different problems, and a wizard that collapsed them into one vague line would be the
 * second wording of the same fact.
 */
export const PROFILE_MISSING_WORDS = {
  profile: "todavía no tiene perfil",
  credentials: "todavía no tiene credenciales",
} as const;

/**
 * The clause both screens use for the same fact: while PiCode's own profile cannot carry an
 * instance, the editor keeps using the owner's.
 *
 * It is a verbatim piece of `CLOSING_TEXTS.withoutCredentials` — the import's closing — and the
 * suite asserts it is still contained there, so the two screens cannot drift into two versions
 * of one sentence. Only the reason in front differs, because that is what actually differs
 * between the two moments: nothing was imported there, and nothing is filled yet here.
 */
export const PROFILE_FALLBACK_CLAUSE =
  "nada ha cambiado: el editor sigue usando el perfil de tu pi";

/**
 * The two doors, in the order the safety rule puts them: import first, because it fills the
 * profile with the configuration the owner already has; the login second, for a deliberate
 * start from zero.
 *
 * Each label is the command's palette title without the `PiCode: ` prefix, which is what the
 * suite checks against the manifest, so a renamed command cannot leave a button behind.
 */
const PROFILE_OFFERS: readonly OnboardingOffer[] = [
  { label: "Importar el perfil de tu pi", command: IMPORT_PROFILE_COMMAND },
  { label: "Iniciar sesión en un proveedor", command: LOGIN_PROVIDER_COMMAND },
];

/** The part with nothing to say: hidden, with no text and no door. */
const HIDDEN_PART: OnboardingProfilePart = { visible: false, text: "", offers: [] };

/**
 * The profile part for the selected instance, or nothing to show.
 *
 * Three states, and only one of them speaks:
 *
 * - the owner's pi: PiCode owns no profile there, so there is nothing to fill and nothing
 *   inapplicable is dangled in front of him;
 * - PiCode's own pi with a usable profile: nothing is missing, so nothing is said;
 * - PiCode's own pi without one: the editor keeps using the owner's pi until PiCode's own
 *   profile has credentials, and the two doors that end that are named by the commands that
 *   already implement them.
 *
 * The input is the settings row's own fact shape (`InstanceProfileState`), read by the host
 * from the instance resolver, so the row and the step cannot disagree about the same profile.
 * `internalProviders` is not needed to decide: the resolver's `owned` already folds in "the
 * directory exists and names a provider".
 */
export function describeProfilePart(state: InstanceProfileState): OnboardingProfilePart {
  // The owner's own pi: PiCode reads that profile and never writes it, so it owns nothing to
  // fill here — and an offer to fill a profile PiCode does not own would be a lie.
  if (!state.managed) {
    return HIDDEN_PART;
  }
  // PiCode's own pi, with a profile that already carries an instance: nothing to say.
  if (state.owned) {
    return HIDDEN_PART;
  }
  const missing = state.internalExists
    ? PROFILE_MISSING_WORDS.credentials
    : PROFILE_MISSING_WORDS.profile;
  return {
    visible: true,
    text:
      `El pi propio de PiCode ${missing}, así que ${PROFILE_FALLBACK_CLAUSE} ` +
      "hasta que el perfil propio de PiCode tenga credenciales.",
    offers: PROFILE_OFFERS,
  };
}

/** The rows the theme step shows, and why the gallery part is missing when it is. */
export interface OnboardingThemes {
  rows: readonly ThemeRow[];
  /** The theme in force, so the step can say which one that is. */
  current?: string;
  /** Why the catalogue part is not there, when it could not be reached. */
  error?: string;
}

/**
 * The theme step's decision, in the owner's language.
 *
 * Two exits and no trap: applying a theme moves the step on, and so does continuing without
 * one — the editor always has a theme, so “the one you already have” is a real answer rather
 * than a way out. The catalogue being unreachable is said in the same sentence rather than
 * hidden, because the installed themes are already enough to choose from.
 */
export function describeThemeStep(state: OnboardingThemes): string {
  if (state.error !== undefined) {
    return `${state.error} Puedes elegir entre los que ya tienes instalados, o seguir con el que venga.`;
  }
  return state.current === undefined || state.current === ""
    ? "El editor está con el tema que trae de serie."
    : `Ahora mismo el editor usa «${state.current}».`;
}

/**
 * What the panel may ask the host to do.
 *
 * Every method is a delegate, never a decision: the runtime reading comes from
 * `describeRuntime`, the switch from the function `selectRuntime` uses, the Gentle AI
 * reading from the same state builder the panel and the popup share, and the install
 * from the packages table's own code path.
 */
export interface OnboardingHost {
  /** The runtime in force, with the version resolved right now. */
  runtime(): Promise<RuntimeDescriptor>;
  /** The executable path `picode.pi.executablePath` currently holds. */
  configuredPath(): string;
  /** Applies a chosen pi, exactly the way the runtime picker does. */
  applyRuntime(mode: RuntimeMode, customPath?: string): Promise<OnboardingResult>;
  /**
   * The pi step's profile part, decided from the same facts the settings row states.
   *
   * Synchronous on purpose: the answer is a decision over four resolved facts, not a probe.
   */
  profilePart(): OnboardingProfilePart;
  /**
   * Runs one door of that part: the command that already exists, and nothing else.
   *
   * The host runs it; the wizard neither knows how to import a profile nor how to log a
   * provider in, which is what keeps a second implementation from growing inside it.
   */
  runOffer(command: OnboardingOfferCommand): Promise<void>;
  /** Gentle AI's real state, so the question and the summary say what is true. */
  gentle(): Promise<GentleState>;
  /**
   * The themes the theme step offers: the installed ones first, then the gallery's when it
   * can be reached. The rows are the panel's own shape, so the same component draws both
   * and a theme cannot look one way in the wizard and another in the panel.
   */
  themes(): Promise<OnboardingThemes>;
  /** One theme, painted, for the step's preview. */
  previewTheme(rowId: string, themeId: string): Promise<ThemePreviewResult>;
  /** One theme, in force. */
  applyTheme(rowId: string, themeId: string): Promise<ApplyResult>;
  /**
   * Reloads the window, which is what makes the editor know a theme it has just installed.
   *
   * The wizard asks for it instead of running the editor's own command: the ids of commands
   * live where their surface is, and this module names none.
   */
  reload(): Promise<void>;
  /** Installs both packages of the layer, through the shared install path. */
  installGentle(): Promise<OnboardingResult>;
  /** Records that the wizard ran, so it never opens by itself again. */
  complete(): Promise<void>;
  /** Sends the owner to one of the surfaces the summary names. */
  open(target: OnboardingTarget): Promise<void>;
}

/**
 * The panel body.
 *
 * Kept here, next to the class, because the compiled module is what the script/markup
 * agreement test reads: the ids below and the ones `media/onboarding.js` looks up have
 * to be checked in one place, and a webview whose script misses an element is inert
 * without failing anything else.
 */
const ONBOARDING_BODY = `    <header class="onboarding-head">
      <h1 class="onboarding-title">Configuración inicial de PiCode</h1>
      <p class="onboarding-lead">Dos preguntas y el editor queda conectado a pi y, si quieres, a Gentle AI.</p>
      <ol id="steps" class="onboarding-steps">
        <li id="step-tab-pi" class="onboarding-step">1. Qué pi se ejecuta</li>
        <li id="step-tab-gentle" class="onboarding-step">2. Gentle AI</li>
        <li id="step-tab-theme" class="onboarding-step">3. Tema</li>
        <li id="step-tab-summary" class="onboarding-step">4. Resumen</li>
      </ol>
    </header>
    <p id="notice" class="onboarding-notice" hidden></p>
    <main class="onboarding-body">
      <section id="step-pi" class="onboarding-section">
        <h2 class="onboarding-question">¿Qué pi debe ejecutar PiCode?</h2>
        <p id="runtime-current" class="onboarding-current">leyendo…</p>
        <div id="runtime-choices" class="onboarding-choices"></div>
        <div id="runtime-custom" class="onboarding-custom" hidden>
          <label class="onboarding-field-label" for="runtime-path">Ruta del ejecutable</label>
          <input id="runtime-path" class="onboarding-input" type="text" spellcheck="false" placeholder="C:\\ruta\\a\\pi.cmd" />
        </div>
        <div class="onboarding-actions">
          <button id="runtime-apply" class="onboarding-button primary" type="button">Aplicar este pi</button>
        </div>
        <p id="runtime-result" class="onboarding-result" hidden></p>
        <div id="profile-part" hidden>
          <p id="profile-part-text" class="onboarding-current"></p>
          <div id="profile-part-offers" class="onboarding-actions"></div>
          <div class="onboarding-actions">
            <button id="profile-part-continue" class="onboarding-button" type="button">Continuar con el perfil de tu pi</button>
          </div>
        </div>
      </section>
      <section id="step-gentle" class="onboarding-section" hidden>
        <h2 class="onboarding-question">¿Activamos Gentle AI ahora?</h2>
        <p id="gentle-current" class="onboarding-current">leyendo…</p>
        <p>Gentle AI se apoya en el agente que ya usas, no lo sustituye. Mantiene el contexto entre sesiones, así que las decisiones ya tomadas no vuelven a preguntarse. El trabajo pequeño sigue siendo pequeño y el grande conserva un único documento con el que retomarlo. Antes de cambiar nada, el agente explora; después, comprueba lo que cambió.</p>
        <p>Si respondes que no, la opción sigue disponible más tarde desde el panel de Gentle AI, sin reinstalar nada.</p>
        <div class="onboarding-actions">
          <button id="gentle-install" class="onboarding-button primary" type="button">Instalar Gentle AI</button>
          <button id="gentle-skip" class="onboarding-button" type="button">Ahora no</button>
        </div>
        <p id="gentle-result" class="onboarding-result" hidden></p>
      </section>
      <section id="step-theme" class="onboarding-section" hidden>
        <h2 class="onboarding-question">¿Con qué tema quieres trabajar?</h2>
        <p class="onboarding-current">Los temas que ya tienes instalados salen primero y sin red; los del catálogo se leen de su paquete y se enseñan pintados con sus propios colores.</p>
        <div id="wizard-theme-root" class="onboarding-theme"></div>
        <p id="wizard-theme-note" class="onboarding-result" hidden></p>
        <div class="onboarding-actions">
          <button id="wizard-theme-continue" class="onboarding-button primary" type="button">Continuar</button>
        </div>
      </section>
      <section id="step-summary" class="onboarding-section" hidden>
        <h2 class="onboarding-question">Esto es lo que usa el editor desde ahora</h2>
        <p id="summary-runtime" class="onboarding-current">leyendo…</p>
        <p id="summary-gentle" class="onboarding-current">leyendo…</p>
        <p>Puedes seguir por donde quieras:</p>
        <div id="summary-next" class="onboarding-actions">
          <button id="open-chat" class="onboarding-button primary" type="button">Abrir el chat de pi</button>
          <button id="open-settings" class="onboarding-button" type="button">Ajustes de pi</button>
          <button id="open-gentle" class="onboarding-button" type="button">Panel de Gentle AI</button>
        </div>
        <div class="onboarding-actions">
          <button id="finish" class="onboarding-button" type="button">Terminar la configuración</button>
        </div>
      </section>
    </main>`;

export class OnboardingView {
  public static readonly viewType = "picode.onboarding";

  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  /** The theme rows the step is showing, so a message names one instead of carrying it. */
  private themeRows: readonly ThemeRow[] = [];

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: OnboardingHost,
  ) {}

  public static create(extensionUri: vscode.Uri, host: OnboardingHost): OnboardingView {
    return new OnboardingView(extensionUri, host);
  }

  /** Opens the tab, revealing it rather than duplicating it when it already exists. */
  public async show(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.panel === undefined) {
      this.createPanel();
    }
    this.panel?.reveal();
    await this.pushState();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel?.dispose();
    this.panel = undefined;
  }

  private createPanel(): void {
    this.panel = vscode.window.createWebviewPanel(
      OnboardingView.viewType,
      "PiCode: configuración inicial",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
        retainContextWhenHidden: true,
      },
    );
    this.panel.webview.html = buildWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.extensionUri,
      title: "PiCode: configuración inicial",
      body: ONBOARDING_BODY,
      scripts: ["theme-gallery.js", "onboarding.js"],
      styles: ["main.css", "theme.css", "onboarding.css"],
    });
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      null,
      this.disposables,
    );
  }

  private post(message: unknown): void {
    if (this.panel === undefined || this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const record = message as Record<string, unknown>;

    switch (record.type) {
      case "ready": {
        await this.pushState();
        // The theme step's own data is pushed with the rest: the gallery is part of the
        // wizard's first screen, and fetching it on arrival would show an empty step for a
        // moment every time the window is opened.
        await this.pushThemes();
        break;
      }
      case "applyRuntime": {
        if (!isRuntimeMode(record.mode)) {
          break;
        }
        const path = typeof record.path === "string" ? record.path : undefined;
        try {
          const result = await this.host.applyRuntime(record.mode, path);
          // The state is asked for again before the outcome is posted, so the panel's
          // reading of the runtime is the one that just changed rather than the one
          // from before the switch.
          await this.pushState();
          this.post({ type: "runtimeResult", ok: result.ok, message: result.message });
        } catch (error) {
          this.post({
            type: "runtimeResult",
            ok: false,
            message: `No se pudo aplicar el pi: ${describeError(error)}`,
          });
        }
        break;
      }
      case "runOffer": {
        if (!isOfferCommand(record.command)) {
          break;
        }
        try {
          await this.host.runOffer(record.command);
          // A door may have filled the profile — the import brings credentials, the login
          // creates one — so the part is read again: a profile that just became usable stops
          // being advertised instead of leaving the owner looking at a stale warning.
          await this.pushState();
        } catch (error) {
          this.post({
            type: "error",
            message: `No se pudo abrir esa acción: ${describeError(error)}`,
          });
        }
        break;
      }
      case "installGentle": {
        try {
          const result = await this.host.installGentle();
          await this.pushState();
          this.post({ type: "gentleResult", ok: result.ok, message: result.message });
        } catch (error) {
          this.post({
            type: "gentleResult",
            ok: false,
            message: `No se pudo instalar Gentle AI: ${describeError(error)}`,
          });
        }
        break;
      }
      case "skipGentle": {
        await this.pushState();
        this.post({
          type: "gentleResult",
          ok: true,
          message: "Gentle AI queda disponible desde su panel en cuanto quieras, sin reinstalar nada.",
        });
        break;
      }
      case "finish": {
        await this.host.complete();
        this.post({ type: "completed" });
        break;
      }
      case "open": {
        if (isTarget(record.target)) {
          await this.host.open(record.target);
        }
        break;
      }
      case "search": {
        // The compact gallery draws no filter, but a message is answered rather than dropped:
        // the step has one list and the host's is the same one.
        await this.pushThemes();
        break;
      }
      case "preview": {
        await this.pushThemePreview(record);
        break;
      }
      case "apply": {
        await this.pushThemeApplied(record);
        break;
      }
      case "themes": {
        await this.pushThemes();
        break;
      }
      case "openGallery": {
        // The same allow-list the panel uses: a wizard step is not a second, looser door.
        const url = typeof record.url === "string" ? record.url : "";
        const allowed = externalUrlToOpen(url);
        if (allowed !== undefined) {
          await vscode.env.openExternal(vscode.Uri.parse(allowed));
        }
        break;
      }
      case "reload": {
        await this.host.reload();
        break;
      }
      default:
        break;
    }
  }

  /**
   * The theme step's rows, pushed with the sentence that says which one is in force.
   *
   * Kept here as well, so the two messages that follow name a row instead of carrying one:
   * a webview is a document this extension does not control, and a message that names an id
   * is resolved against the list the host sent rather than trusted.
   */
  private async pushThemes(): Promise<void> {
    const state = await this.host.themes();
    this.themeRows = state.rows;
    this.post({
      type: "themes",
      rows: state.rows,
      query: "",
      stepText: describeThemeStep(state),
      ...(state.current === undefined ? {} : { current: state.current }),
      ...(state.error === undefined ? {} : { error: state.error }),
    });
  }

  /** One theme painted, or the reason it could not be read. */
  private async pushThemePreview(record: Record<string, unknown>): Promise<void> {
    const requestId = typeof record.requestId === "number" ? record.requestId : 0;
    const row = this.themeRows.find((candidate) => candidate.id === record.rowId);
    const themeId = typeof record.themeId === "string" ? record.themeId : "";
    if (row === undefined) {
      this.post({ type: "preview", requestId, ok: false, reason: "Ese tema ya no está en la lista." });
      return;
    }
    const answer = await this.host
      .previewTheme(row.id, themeId)
      .catch((cause: unknown) => ({
        ok: false as const,
        reason: `No se pudo leer el tema: ${cause instanceof Error ? cause.message : String(cause)}`,
      }));
    if (!answer.ok) {
      this.post({ type: "preview", requestId, ok: false, reason: answer.reason });
      return;
    }
    this.post({ type: "preview", requestId, ok: true, variant: answer.variant, preview: answer.preview });
  }

  /** One theme applied, said the same way the panel says it. */
  private async pushThemeApplied(record: Record<string, unknown>): Promise<void> {
    const row = this.themeRows.find((candidate) => candidate.id === record.rowId);
    const themeId = typeof record.themeId === "string" ? record.themeId : "";
    if (row === undefined) {
      return;
    }
    let result: ApplyResult;
    let failure: string | undefined;
    try {
      result = await this.host.applyTheme(row.id, themeId);
    } catch (cause) {
      // A host that fails still gets an ending: the note says what went wrong instead of
      // leaving the step waiting on an answer that is never coming.
      result = { applied: false, installed: false, needsReload: false };
      failure = `No se pudo aplicar el tema: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    this.post({
      type: "applied",
      rowId: row.id,
      themeId,
      result,
      message: failure ?? appliedMessage(row, themeId, result),
    });
  }

  private async pushState(): Promise<void> {
    if (this.panel === undefined) {
      return;
    }
    // The profile part travels as its own reading, before the process probe: it is a decision
    // over the resolver's facts, not the runtime's version, and a probe that fails must not
    // also silence what the pi step says about PiCode's own profile.
    this.post({ type: "instanceProfile", profile: this.host.profilePart() });
    try {
      const runtime = await this.host.runtime();
      const gentle = await this.host.gentle();
      this.post({
        type: "state",
        runtime,
        gentle,
        configuredPath: this.host.configuredPath(),
      });
    } catch (error) {
      this.post({
        type: "error",
        message: `No se pudo leer el estado actual: ${describeError(error)}`,
      });
    }
  }
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "path" || value === "managed" || value === "custom";
}

function isTarget(value: unknown): value is OnboardingTarget {
  return value === "chat" || value === "settings" || value === "gentle";
}

/**
 * Whether a message names one of the two doors.
 *
 * The webview only ever sends an id it received from the host, so this is not a trust
 * boundary being crossed — it is what keeps the host from becoming a generic "run any
 * command" endpoint the day a message is built by hand.
 */
function isOfferCommand(value: unknown): value is OnboardingOfferCommand {
  return value === IMPORT_PROFILE_COMMAND || value === LOGIN_PROVIDER_COMMAND;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
