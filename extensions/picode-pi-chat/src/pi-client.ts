import type {
  PiCycleModelData,
  PiEvent,
  PiModel,
  PiNewSessionData,
  PiPromptOptions,
  PiSessionState,
  PiSlashCommand,
  PiSwitchSessionData,
  PiThinkingLevel,
} from "./protocol";

/** Minimal subscription handle; structurally compatible with `vscode.Disposable`. */
export interface PiSubscription {
  dispose(): void;
}

/**
 * What PiCode needs from a pi session, whatever runs pi underneath.
 *
 * Two backends implement this: `PiRpcClient`, which spawns `pi --mode rpc` and
 * speaks JSON lines over stdio, and the in-process SDK backend. The view, the
 * menu and the session commands are written against this interface only, so
 * choosing a runtime never reaches them.
 *
 * `send` is deliberately absent: raw protocol commands are an implementation
 * detail of the RPC backend. An operation both backends can express belongs
 * here; one only a single backend can express does not.
 */
export interface PiClient {
  /** True while a run is in flight. */
  readonly isStreaming: boolean;
  /** True while the backend is up and able to take work. */
  readonly isRunning: boolean;
  /** Subscribes to agent events. The returned handle removes the listener. */
  onEvent(listener: (event: PiEvent) => void): PiSubscription;
  /** Brings the backend up. Idempotent. Throws when it cannot start. */
  start(): Promise<void>;
  /**
   * Sends a prompt: text plus, optionally, images, because those are the two
   * things pi accepts.
   */
  prompt(text: string, options?: PiPromptOptions): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<PiNewSessionData>;
  getState(): Promise<PiSessionState>;
  getAvailableModels(): Promise<PiModel[]>;
  setModel(modelRef: string, provider?: string): Promise<PiModel>;
  cycleModel(): Promise<PiCycleModelData | null>;
  getAvailableThinkingLevels(): Promise<PiThinkingLevel[]>;
  setThinkingLevel(level: PiThinkingLevel): Promise<void>;
  cycleThinkingLevel(): Promise<PiThinkingLevel | null>;
  switchSession(sessionPath: string): Promise<PiSwitchSessionData>;
  getCommands(): Promise<PiSlashCommand[]>;
  /** Releases the backend. Safe to call more than once. */
  stop(): void;
}
