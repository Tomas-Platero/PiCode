import { spawn, type ChildProcess } from "node:child_process";
import type * as vscode from "vscode";
import type {
  PiCommand,
  PiCycleModelData,
  PiCycleThinkingLevelData,
  PiEvent,
  PiGetAvailableModelsData,
  PiGetCommandsData,
  PiModel,
  PiNewSessionData,
  PiResponse,
  PiSessionState,
  PiSlashCommand,
  PiThinkingLevel,
  PiThinkingLevelsData,
  PiSwitchSessionData,
  PiWireCommand,
} from "./protocol";
import { type PiClient, type PiSubscription } from "./pi-client";

export type { PiSubscription } from "./pi-client";

export interface PiRpcClientOptions {
  /** Executable to spawn. A bare name is resolved on PATH. */
  executablePath: string;
  /**
   * Arguments placed before the client's own. Used by the managed runtime, which
   * is launched as `node <bundle>/cli.js` rather than through the npm shim.
   */
  argsPrefix?: readonly string[];
  /** Extra arguments appended after `--mode rpc`. */
  extraArgs: readonly string[];
  /** Working directory for the agent; defaults to `process.cwd()`. */
  cwd?: string;
  /** Diagnostic sink; a VS Code OutputChannel named "PiCode" in production. */
  output?: vscode.OutputChannel;
}

interface PendingRequest {
  resolve: (response: PiResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Client for `pi --mode rpc`: spawns the agent, frames stdout as strict LF
 * JSONL, correlates responses by id and fans events out to listeners.
 */
export class PiRpcClient implements PiClient {
  private readonly options: PiRpcClientOptions;
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();

  private child: ChildProcess | undefined;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stderrTail = "";
  private nextRequestId = 0;
  private started = false;
  private streaming = false;
  /** In-flight launch, so concurrent `start()` callers share one spawn. */
  private starting: Promise<void> | undefined;

  constructor(options: PiRpcClientOptions) {
    this.options = options;
  }

  /** True while a run is in flight (`agent_start` .. `agent_settled`). */
  get isStreaming(): boolean {
    return this.streaming;
  }

  get isRunning(): boolean {
    return this.started && this.child !== undefined;
  }

  /** Subscribes to agent events. The returned handle removes the listener. */
  onEvent(listener: (event: PiEvent) => void): PiSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Spawns the agent in RPC mode. Idempotent: a second call while the process
   * is alive resolves immediately, and concurrent callers share one launch.
   * Throws with an actionable message when the executable cannot be started.
   *
   * The in-flight promise is what makes the second property true. `isRunning`
   * only becomes true once the process is attached, which happens after an
   * await, so the check alone is a check-then-act: two callers arriving before
   * that point both pass it and each spawns an agent. Two agents in one
   * workspace means two processes writing files, which is worse than a slow
   * start.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    const attempt = this.launchAndAttach();
    this.starting = attempt;
    try {
      await attempt;
    } finally {
      this.starting = undefined;
    }
  }

  private async launchAndAttach(): Promise<void> {
    this.started = false;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.stderrTail = "";

    const args = [...(this.options.argsPrefix ?? []), "--mode", "rpc", ...this.options.extraArgs];
    let child: ChildProcess;
    try {
      child = await this.launch(args, false);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && this.isBareExecutableName() && isShimSpawnFailure(code)) {
        // Windows npm shims are `.cmd` scripts. Node refuses to execute a `.cmd`
        // without a shell (EINVAL since the CVE-2024-27980 hardening), and it
        // cannot resolve the bare name at all (ENOENT), so retry through the
        // system shell. Trade-off: the direct child becomes `cmd.exe`, which is
        // why stop() kills the whole process tree on Windows.
        this.log("Retrying pi through the Windows command shell (npm .cmd shim).");
        try {
          child = await this.launch(args, true);
        } catch (retryError) {
          throw this.startFailure(retryError);
        }
      } else {
        throw this.startFailure(error);
      }
    }

    this.attach(child);
    this.started = true;
    this.log(`pi RPC process started (pid ${child.pid ?? "unknown"}).`);
  }

  /**
   * Writes a command and resolves with the matching `type:"response"` record.
   * Rejects when the command fails (`success:false`) or the process dies.
   */
  async send(command: PiCommand): Promise<PiResponse> {
    const child = this.child;
    const stdin = child?.stdin ?? null;
    if (!this.started || !child || !stdin || !isWritable(child)) {
      throw new Error("pi RPC process is not running.");
    }

    const wire: PiWireCommand = { ...command, id: this.nextId() };
    const response = new Promise<PiResponse>((resolve, reject) => {
      this.pending.set(wire.id, { resolve, reject });
    });

    try {
      stdin.write(`${JSON.stringify(wire)}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(wire.id);
        this.pending.delete(wire.id);
        pending?.reject(new Error(`Failed to write "${wire.type}" to pi: ${error.message}`));
      });
    } catch (error) {
      this.pending.delete(wire.id);
      throw new Error(`Failed to write "${wire.type}" to pi: ${asErrorMessage(error)}`);
    }

    return response;
  }

  /**
   * Sends a user prompt. When the agent is already streaming, the protocol
   * requires an explicit `streamingBehavior`; the client defaults to
   * `followUp` so a busy agent is not turned into a hard error.
   */
  async prompt(text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    const behavior = streamingBehavior ?? (this.streaming ? "followUp" : undefined);
    const command: PiCommand = behavior
      ? { type: "prompt", message: text, streamingBehavior: behavior }
      : { type: "prompt", message: text };
    await this.request<undefined>(command);
  }

  /** Stops the current run and waits for the session to become idle. */
  async abort(): Promise<void> {
    await this.request<undefined>({ type: "abort" });
  }

  /** Starts a fresh session. */
  async newSession(): Promise<PiNewSessionData> {
    return this.request<PiNewSessionData>({ type: "new_session" });
  }

  /** Reads the current session state. */
  async getState(): Promise<PiSessionState> {
    return this.request<PiSessionState>({ type: "get_state" });
  }

  /** Lists configured models. */
  async getAvailableModels(): Promise<PiModel[]> {
    const data = await this.request<PiGetAvailableModelsData>({
      type: "get_available_models",
    });
    return data.models ?? [];
  }

  /**
   * Switches model. `modelRef` is `provider/model-id` unless `provider` is
   * passed explicitly, because pi requires the two halves separately.
   */
  async setModel(modelRef: string, provider?: string): Promise<PiModel> {
    const reference = resolveModelReference(modelRef, provider);
    return this.request<PiModel>({
      type: "set_model",
      provider: reference.provider,
      modelId: reference.modelId,
    });
  }

  /**
   * Cycles to the next available model. pi answers with `null` data when only one
   * model is configured, which is not an error.
   */
  async cycleModel(): Promise<PiCycleModelData | null> {
    const data = await this.request<PiCycleModelData | null>({ type: "cycle_model" });
    return data ?? null;
  }

  /** Lists the reasoning levels the current model supports; `["off"]` when it has none. */
  async getAvailableThinkingLevels(): Promise<PiThinkingLevel[]> {
    const data = await this.request<PiThinkingLevelsData>({
      type: "get_available_thinking_levels",
    });
    return data.levels ?? [];
  }

  /**
   * Sets the reasoning level. pi rejects a level the current model does not
   * support, so callers should offer only what `getAvailableThinkingLevels`
   * returned rather than the full enum.
   */
  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    await this.request<unknown>({ type: "set_thinking_level", level });
  }

  /** Cycles the reasoning level; `null` when the model has no reasoning support. */
  async cycleThinkingLevel(): Promise<PiThinkingLevel | null> {
    const data = await this.request<PiCycleThinkingLevelData>({ type: "cycle_thinking_level" });
    return data.level ?? null;
  }

  /**
   * Loads an existing session file, which is how a conversation is resumed.
   *
   * pi answers `cancelled: true` when an extension refused the switch, which is not a
   * failure and must not be reported as one.
   */
  async switchSession(sessionPath: string): Promise<PiSwitchSessionData> {
    return this.request<PiSwitchSessionData>({ type: "switch_session", sessionPath });
  }

  /** Discover extension commands, prompt templates and skills. */
  async getCommands(): Promise<PiSlashCommand[]> {
    const data = await this.request<PiGetCommandsData>({ type: "get_commands" });
    return data.commands ?? [];
  }

  /**
   * Kills the agent process and rejects outstanding requests. Idempotent.
   */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.started = false;
    this.streaming = false;

    if (child) {
      const pid = child.pid;
      if (process.platform === "win32" && pid !== undefined && child.exitCode === null) {
        // `cmd.exe` is the direct child when the shell fallback was used, so a
        // plain kill would orphan pi; a tree kill reaches the real process.
        try {
          const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          taskkill.on("error", () => undefined);
          taskkill.unref();
        } catch {
          // Fall through to the regular kill below.
        }
      }
      child.kill();
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdin?.removeAllListeners();
      child.stdin?.end();
    }

    this.failPending(new Error("pi RPC client stopped."));
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private async launch(args: readonly string[], shell: boolean): Promise<ChildProcess> {
    const child = spawn(this.options.executablePath, [...args], {
      cwd: this.options.cwd ?? process.cwd(),
      windowsHide: true,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.removeListener("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.removeListener("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    return child;
  }

  private attach(child: ChildProcess): void {
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdin?.setDefaultEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr?.on("data", (chunk: string) => this.consumeStderr(chunk));

    // A closed stdin after exit surfaces as EPIPE; swallow it, the exit
    // handlers below are the ones that report the real failure.
    child.stdin?.on("error", (error: Error) => {
      this.log(`stdin error: ${error.message}`);
    });

    child.on("error", (error: Error) => {
      this.finalize(`pi process error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.finalize(
        `pi process exited (${describeExit(code, signal)})${this.stderrSuffix()}`,
      );
    });
    // `close` fires after stdout/stderr are drained, so it is the authoritative
    // end of the stream; `finalize` is idempotent and only the first call wins.
    child.on("close", (code, signal) => {
      this.finalize(
        `pi process closed (${describeExit(code, signal)})${this.stderrSuffix()}`,
      );
    });
  }

  /**
   * Strict LF-only framing. The buffer is split on "\n" by hand: U+2028 and
   * U+2029 are legal inside JSON strings, so `readline` would corrupt records.
   * A trailing "\r" is stripped for CRLF tolerance.
   */
  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.handleLine(stripCarriageReturn(line));
    }
  }

  /** stderr is only diagnostic: keep a tail for error messages and log lines. */
  private consumeStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    this.stderrBuffer += chunk;
    for (;;) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = stripCarriageReturn(this.stderrBuffer.slice(0, newline)).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line.length > 0) {
        this.log(`[stderr] ${line}`);
      }
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.log(`Ignoring malformed JSON line: ${asErrorMessage(error)}`);
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.log("Ignoring non-object JSON record.");
      return;
    }

    // The payload is untrusted JSON. After checking the discriminant we treat
    // it as the declared protocol shape; the field types are not re-validated.
    if ((parsed as { type?: unknown }).type === "response") {
      this.handleResponse(parsed as PiResponse);
      return;
    }

    const event = parsed as PiEvent;
    if (typeof event.type !== "string") {
      this.log("Ignoring JSON record without a type.");
      return;
    }

    if (event.type === "agent_start") {
      this.streaming = true;
    } else if (event.type === "agent_settled") {
      this.streaming = false;
    }

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private handleResponse(response: PiResponse): void {
    const id = response.id;
    if (typeof id !== "string") {
      this.log(`Ignoring response without id (command "${response.command}").`);
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      this.log(`Ignoring response for unknown id "${id}".`);
      return;
    }

    this.pending.delete(id);
    if (response.success) {
      pending.resolve(response);
      return;
    }
    pending.reject(new Error(response.error || `Command "${response.command}" failed.`));
  }

  /** Sends a command and unwraps `data`; rejects when the command fails. */
  private async request<TData>(command: PiCommand): Promise<TData> {
    const response = await this.send(command);
    if (!response.success) {
      // `send` already rejects on failure; this narrows the union for the cast.
      throw new Error(response.error);
    }
    return response.data as TData;
  }

  /** Marks the client stopped exactly once and rejects outstanding requests. */
  private finalize(message: string): void {
    if (!this.started && this.child === undefined) {
      return;
    }
    // A trailing record without a final LF is still valid JSON; flush it.
    const remainder = stripCarriageReturn(this.stdoutBuffer).trim();
    this.stdoutBuffer = "";
    if (remainder.length > 0) {
      this.handleLine(remainder);
    }

    this.started = false;
    this.streaming = false;
    this.child = undefined;
    this.log(message);
    this.failPending(new Error(message));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private nextId(): string {
    this.nextRequestId += 1;
    return `picode-${this.nextRequestId}`;
  }

  private isBareExecutableName(): boolean {
    const executable = this.options.executablePath;
    return !executable.includes("/") && !executable.includes("\\");
  }

  private startFailure(error: unknown): Error {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = code ? `${code}: ${asErrorMessage(error)}` : asErrorMessage(error);
    const hint =
      process.platform === "win32"
        ? 'Install pi globally (npm i -g @earendil-works/pi-coding-agent) or set "picode.pi.executablePath" to the full path of the pi executable.'
        : 'Install pi globally or set "picode.pi.executablePath" to the pi binary.';
    return new Error(
      `Unable to start the pi agent ("${this.options.executablePath}"). ${detail} ${hint}`,
    );
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim();
    return tail.length > 0 ? ` Last stderr: ${tail.split("\n").slice(-3).join(" | ")}` : "";
  }

  private log(message: string): void {
    this.options.output?.appendLine(`[pi-rpc] ${message}`);
  }
}

/** Splits a `provider/model-id` reference, or accepts an explicit provider. */
function resolveModelReference(
  modelRef: string,
  provider: string | undefined,
): { provider: string; modelId: string } {
  if (provider !== undefined && provider.length > 0 && modelRef.length > 0) {
    return { provider, modelId: modelRef };
  }
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) {
    throw new Error(
      `Model reference "${modelRef}" must be "provider/model-id" (for example "anthropic/claude-sonnet-4").`,
    );
  }
  return {
    provider: modelRef.slice(0, separator),
    modelId: modelRef.slice(separator + 1),
  };
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isWritable(child: ChildProcess): boolean {
  const stdin = child.stdin;
  return child.exitCode === null && stdin !== null && !stdin.destroyed && stdin.writable;
}

function isShimSpawnFailure(code: string | undefined): boolean {
  // ENOENT: the bare name was not resolved. EINVAL: a resolved `.cmd`/`.bat`
  // shim refused without a shell (Node >= 20 hardening).
  return code === "ENOENT" || code === "EINVAL";
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) {
    return `signal ${signal}`;
  }
  return `code ${code ?? "unknown"}`;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
