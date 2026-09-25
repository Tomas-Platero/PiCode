/*
 * One pi turn, translated into what a chat surface can draw.
 *
 * This module is pure on purpose: it imports no `vscode` and no Node API, so the
 * mapping from pi's event stream to a sink is exercisable in plain Node. The same
 * mapping then serves whichever backend runs pi, exactly like `PiClient` does for
 * the panel.
 *
 * The panel and this forwarder listen to the same stream and do different things
 * with it: the panel keeps a transcript model, and this only needs to say what the
 * reader sees now. Nothing is buffered here beyond the turn's completion, because
 * the surface that receives `markdown` is already the accumulator.
 */

import type { JsonObject, PiEvent } from "./protocol";

/** Where the turn is written. The chat participant implements this over its stream. */
export interface TurnSink {
  /** Appends assistant text, which may arrive in pieces. */
  markdown(text: string): void;
  /** Replaces the single line that says what is happening while it happens. */
  progress(text: string): void;
}

/** How a turn ended. `ok` is false only when something reached the reader as a failure. */
export interface TurnOutcome {
  ok: boolean;
  error?: string;
}

/**
 * The cancellation surface a turn needs, kept minimal so a caller can supply its own.
 * `vscode.CancellationToken` is structurally compatible with it.
 */
export interface TurnCancellation {
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * A sink that keeps the assistant text instead of drawing it.
 *
 * Progress is transient by definition, so it is received and dropped: a caller that
 * wants the transcript wants the answer, not the last line of the status area.
 */
export class CollectingSink implements TurnSink {
  private readonly parts: string[] = [];

  markdown(text: string): void {
    this.parts.push(text);
  }

  progress(_text: string): void {
    // Intentionally empty.
  }

  get text(): string {
    return this.parts.join("");
  }
}

/**
 * The tool names worth translating, and what the reader is told.
 *
 * A name that is not here is not hidden: it is printed as it came, because a tool the
 * list has not caught up with is still a tool the reader is watching run. Guessing a
 * friendlier label from an unknown name would be worse than the name itself.
 */
const TOOL_LABELS: Record<string, string> = {
  read: "Leyendo",
  write: "Escribiendo",
  edit: "Editando",
  bash: "Ejecutando",
  grep: "Buscando en el código",
  find: "Buscando archivos",
  ls: "Listando",
  web_search: "Buscando en la web",
  web_fetch: "Leyendo una página",
  mem_search: "Consultando la memoria",
  mem_save: "Guardando en la memoria",
  mem_get_observation: "Leyendo la memoria",
  task: "Delegando en un subagente",
};

/** The argument a tool call is worth naming in the progress line, in priority order. */
const TARGET_KEYS: readonly string[] = ["path", "filePath", "file", "command", "query", "pattern"];

/** As much of a long target as one progress line can carry. */
const TARGET_LIMIT = 80;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function truncate(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > TARGET_LIMIT ? `${single.slice(0, TARGET_LIMIT - 1)}…` : single;
}

/**
 * The one line that says which tool is running and on what.
 *
 * Exported because both the participant and the tests state the mapping, and a second
 * copy of it would be the thing that drifts.
 */
export function describeToolCall(name: string, args?: JsonObject): string {
  const label = TOOL_LABELS[name] ?? name;
  if (args === undefined) {
    return label;
  }
  for (const key of TARGET_KEYS) {
    const target = asString(args[key]);
    if (target !== undefined) {
      return `${label}: ${truncate(target)}`;
    }
  }
  return label;
}

/**
 * Consumes the event stream of one turn and settles when pi says the run is over.
 *
 * `agent_settled` is the end, not `agent_end`: a turn that retries fires `agent_end`
 * with `willRetry` and is not finished. `prompt()` resolving is also not the end — it
 * settles when the command is accepted, which is why the participant awaits this.
 */
export class PiTurnForwarder {
  private readonly completion: Promise<TurnOutcome>;
  private settle: (outcome: TurnOutcome) => void = () => undefined;
  private finished = false;

  constructor(private readonly sink: TurnSink) {
    this.completion = new Promise<TurnOutcome>((resolve) => {
      this.settle = resolve;
    });
  }

  /** Resolves once, with the turn's outcome. */
  get settled(): Promise<TurnOutcome> {
    return this.completion;
  }

  /** Feeds one event. Events after the turn settled are ignored, not replayed. */
  handle(event: PiEvent): void {
    if (this.finished) {
      return;
    }

    switch (event.type) {
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta" && delta.delta.length > 0) {
          this.sink.markdown(delta.delta);
        } else if (delta.type === "thinking_start") {
          this.sink.progress("Pensando…");
        }
        break;
      }
      case "tool_execution_start":
        this.sink.progress(describeToolCall(event.toolName, event.args));
        break;
      case "auto_retry_start":
        this.sink.progress(`Reintentando (${event.attempt}/${event.maxAttempts})…`);
        break;
      case "compaction_start":
        this.sink.progress("Compactando el contexto…");
        break;
      case "extension_error":
        this.sink.markdown(`\n\n> PiCode: error de una extensión de pi — ${event.error}\n`);
        break;
      case "message_end": {
        const message = event.message as { role?: unknown; errorMessage?: unknown };
        if (message.role === "assistant" && typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
          this.sink.markdown(`\n\n> PiCode: ${message.errorMessage}\n`);
        }
        break;
      }
      case "agent_settled":
        this.finish({ ok: true });
        break;
      default:
        break;
    }
  }

  /**
   * Ends the turn from the host side, for the case where no `agent_settled` will
   * arrive because `prompt()` itself threw. Idempotent: a later `agent_settled` finds
   * the turn already closed instead of settling it twice.
   */
  finish(outcome: TurnOutcome): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.settle(outcome);
  }
}
