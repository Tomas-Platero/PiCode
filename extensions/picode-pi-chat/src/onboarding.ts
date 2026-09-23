import * as vscode from "vscode";
import { GENTLE_PACKAGE, type GentleState } from "./gentle";
import type { RuntimeDescriptor, RuntimeMode } from "./runtime";
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
  /** Gentle AI's real state, so the question and the summary say what is true. */
  gentle(): Promise<GentleState>;
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
        <li id="step-tab-summary" class="onboarding-step">3. Resumen</li>
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
      scripts: ["onboarding.js"],
      styles: ["main.css", "onboarding.css"],
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
      default:
        break;
    }
  }

  private async pushState(): Promise<void> {
    if (this.panel === undefined) {
      return;
    }
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
