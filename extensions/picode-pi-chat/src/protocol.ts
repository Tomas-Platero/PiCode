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

/** Everything a prompt may carry besides its text. */
export interface PiPromptOptions {
  /**
   * Required while the agent is already streaming; omitted when it is idle.
   * `steer` interrupts the current turn, `followUp` waits for it to finish.
   */
  streamingBehavior?: "steer" | "followUp";
  /** Images to send with the message, already prepared for the wire. */
  images?: readonly PiImageContent[];
}

/**
 * Logical command shapes. `id` is deliberately absent: the client assigns a
 * unique id for every command it writes (see {@link PiWireCommand}).
 */
export type PiCommand =
  | ({ type: "prompt"; message: string } & PiPromptOptions)
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
  | { type: "cycle_model" }
  | { type: "get_available_thinking_levels" }
  | { type: "set_thinking_level"; level: PiThinkingLevel }
  | { type: "cycle_thinking_level" }
  | { type: "get_commands" }
  | { type: "switch_session"; sessionPath: string };

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

export interface PiCycleModelData {
  model: PiModel | null;
  thinkingLevel?: PiThinkingLevel;
  isScoped?: boolean;
}

export interface PiThinkingLevelsData {
  levels: PiThinkingLevel[];
}

export interface PiCycleThinkingLevelData {
  level: PiThinkingLevel | null;
}

/** `switch_session` answers whether the switch happened, or was refused. */
export interface PiSwitchSessionData {
  cancelled?: boolean;
}

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
   * The agent asking its host for input, or telling it how to draw a terminal.
   * Both families travel the same channel and share `type`, so they are carried
   * as one request type rather than as two events. The panel does not render
   * extension UI, but the request is part of the event stream and cannot be
   * confused with the responses that settle it.
   */
  | PiExtensionUiRequest;

export type PiEventType = PiEvent["type"];

/* ------------------------------------------------------------------ *
 * Extension UI: the agent asking its host
 * ------------------------------------------------------------------ */

/**
 * Requests pi blocks on until the host answers them.
 *
 * The contract is pi 0.86.1's `RpcExtensionUIRequest`
 * (`resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`),
 * whose method union is identical to 0.87.1's. Every request carries a unique
 * `id`, and pi matches a response **by `id` alone**.
 *
 * `timeout` is pi's own budget: it abandons the request on its own schedule when
 * the host does not answer in time. The host must not track it. A host-side timer
 * would eventually answer a request pi has already given up on, which invents a
 * decision on the owner's behalf.
 */
export type PiExtensionUiDialogRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
    };

/**
 * Requests pi emits and never waits on. There is no response shape for these,
 * so answering one is meaningless: `notify` is a message for the owner, and the
 * other four configure a terminal interface this panel is not.
 */
export type PiExtensionUiNoticeRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type PiExtensionUiRequest = PiExtensionUiDialogRequest | PiExtensionUiNoticeRequest;

/**
 * What the owner decided about one dialog, before it takes on the identity of
 * the request it settles. Three mutually exclusive decisions, so `confirm` can
 * never be answered with free text and `select` can never be answered with a
 * boolean.
 */
export type PiExtensionUiAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

/**
 * The only three records pi accepts as an answer, one per decision. `cancelled`
 * reads as `undefined` in pi for `select`/`input`/`editor` and as `false` for
 * `confirm`, which is exactly the owner dismissing the dialog.
 */
export type PiExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

/**
 * Builds the one record that answers `answer`. The id is the request's, and it
 * can only come from the request: a response that is not correlated by id is
 * dropped by pi, so the correlation is made structural here instead of trusted.
 */
export function extensionUiResponse(id: string, answer: PiExtensionUiAnswer): PiExtensionUiResponse {
  if ("value" in answer) {
    return { type: "extension_ui_response", id, value: answer.value };
  }
  if ("confirmed" in answer) {
    return { type: "extension_ui_response", id, confirmed: answer.confirmed };
  }
  return { type: "extension_ui_response", id, cancelled: true };
}

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
