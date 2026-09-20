/**
 * Wire types for the pi RPC protocol (`pi --mode rpc`, pi 0.86.1).
 *
 * Records are JSON lines: commands travel host -> agent on stdin, responses and
 * events travel agent -> stdout. Every command carries a client-assigned `id`;
 * the matching `{type:"response", id}` record settles the request. Events carry
 * no `id` and stream asynchronously.
 *
 * These are type-only definitions: they describe the wire contract and are not
 * validated at runtime. The client performs structural checks at the parse
 * boundary and then treats the payload as the declared type.
 */

/* ------------------------------------------------------------------ *
 * Shared value shapes
 * ------------------------------------------------------------------ */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface PiUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: PiUsageCost;
}

export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** A model as reported by `get_state`, `set_model` and `get_available_models`. */
export interface PiModel {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** A command (extension command, prompt template or skill) from `get_commands`. */
export interface PiSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

/** Session state from `get_state`. */
export interface PiSessionState {
  model?: PiModel | null;
  thinkingLevel?: PiThinkingLevel;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
}

/* ------------------------------------------------------------------ *
 * Message content (authoritative shape carried by message_* events)
 * ------------------------------------------------------------------ */

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
}

export type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCall;

export interface PiUserMessage {
  role: "user";
  content: string | Array<PiTextContent | PiImageContent>;
  timestamp?: number;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: PiAssistantContent[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  content?: Array<PiTextContent | PiImageContent>;
  isError?: boolean;
  timestamp?: number;
}

/** Any other message role pi may emit; kept structurally open on purpose. */
export interface PiOtherMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
}

export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiOtherMessage;

/** Accumulated (not delta) tool payload used by `tool_execution_*` events. */
export interface PiToolResultPayload {
  content?: Array<PiTextContent | PiImageContent>;
  details?: JsonValue;
}

/* ------------------------------------------------------------------ *
 * Commands (host -> agent)
 * ------------------------------------------------------------------ */

/**
 * Logical command shapes. `id` is deliberately absent: the client assigns a
 * unique id for every command it writes (see {@link PiWireCommand}).
 */
export type PiCommand =
  | {
      type: "prompt";
      message: string;
      images?: PiImageContent[];
      /** Required when the agent is already streaming; omitted when idle. */
      streamingBehavior?: "steer" | "followUp";
    }
  | { type: "abort" }
  | { type: "new_session"; parentSession?: string }
  | { type: "get_state" }
  | { type: "get_available_models" }
  /**
   * `set_model` needs both halves of the model reference. pi 0.86.1 rejects a
   * bare `model` field, so callers pass `provider` + `modelId` (or a
   * `provider/model-id` string that the client splits).
   */
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "get_commands" };

export type PiCommandType = PiCommand["type"];

/** A command exactly as written to stdin: the logical shape plus its id. */
export type PiWireCommand = PiCommand & { id: string };

/* ------------------------------------------------------------------ *
 * Responses (agent -> host)
 * ------------------------------------------------------------------ */

export interface PiResponseOk {
  id?: string;
  type: "response";
  command: string;
  success: true;
  data?: unknown;
}

export interface PiResponseError {
  id?: string;
  type: "response";
  command: string;
  success: false;
  error: string;
}

export type PiResponse = PiResponseOk | PiResponseError;

export interface PiGetAvailableModelsData {
  models: PiModel[];
}

export interface PiGetCommandsData {
  commands: PiSlashCommand[];
}

export interface PiNewSessionData {
  cancelled: boolean;
}

/* ------------------------------------------------------------------ *
 * Assistant streaming deltas (payload of `message_update`)
 * ------------------------------------------------------------------ */

export type PiAssistantDelta =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content?: string }
  | { type: "toolcall_start"; contentIndex: number; id?: string; toolName?: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall?: PiToolCall };

/* ------------------------------------------------------------------ *
 * Events (agent -> host, no id)
 * ------------------------------------------------------------------ */

export type PiCompactionReason = "manual" | "threshold" | "overflow";

export interface PiCompactionResult {
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  usage?: PiUsage;
}

/**
 * Events the panel consumes. `message_update` is delta-only: there is no
 * cumulative snapshot and no `partial` field, so live text is assembled from
 * `contentIndex` + `delta` and `message_end` is treated as authoritative.
 */
export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: PiAgentMessage[]; willRetry?: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: PiAgentMessage; toolResults?: PiAgentMessage[] }
  | { type: "message_start"; message: PiAgentMessage }
  | { type: "message_end"; message: PiAgentMessage }
  | { type: "message_update"; usage?: PiUsage; assistantMessageEvent: PiAssistantDelta }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args?: JsonObject;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: JsonObject;
      /** Accumulated output so far, not a delta: replace on each update. */
      partialResult?: PiToolResultPayload;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result?: PiToolResultPayload;
      isError?: boolean;
    }
  | { type: "queue_update"; steering?: string[]; followUp?: string[] }
  | { type: "compaction_start"; reason: PiCompactionReason }
  | {
      type: "compaction_end";
      reason: PiCompactionReason;
      result: PiCompactionResult | null;
      aborted?: boolean;
      willRetry?: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage?: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "extension_error"; extensionPath?: string; event?: string; error: string }
  /** Direct `bash` command output, correlated by the originating command id. */
  | { type: "bash_execution_update"; id?: string; delta: string }
  /**
   * Extension UI requests are emitted by the agent itself (status widgets,
   * notifications). The chat panel does not render extension UI yet, but the
   * client must not confuse them with responses, so they are typed and ignored.
   */
  | {
      type: "extension_ui_request";
      id: string;
      method: string;
      title?: string;
      message?: string;
      options?: string[];
      statusKey?: string;
      statusText?: string;
      widgetKey?: string;
      widgetLines?: string[];
      notifyType?: "info" | "warning" | "error";
    };

export type PiEventType = PiEvent["type"];

/** Events forwarded verbatim to the webview (extension UI traffic is not). */
export const PANEL_EVENT_TYPES: readonly PiEventType[] = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "extension_error",
];

export function isPanelEvent(event: PiEvent): boolean {
  return PANEL_EVENT_TYPES.includes(event.type);
}
