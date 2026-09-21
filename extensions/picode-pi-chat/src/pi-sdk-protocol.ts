/**
 * Translation between the pi SDK's in-process session objects and PiCode's wire
 * protocol.
 *
 * The embedded transport loads pi inside the extension, so the objects an
 * `AgentSession` hands out are the very ones the RPC transport serialises to
 * JSON and the panel already renders. The two vocabularies line up by
 * construction, which makes the job here narrowing rather than re-interpreting:
 * an event the panel has no renderer for is dropped at the boundary instead of
 * being forwarded to be ignored three layers later.
 *
 * Nothing here imports `vscode` or the SDK, so the hermetic suite can exercise
 * it directly and the shapes stay checkable without a real pi.
 */
import {
  PANEL_EVENT_TYPES,
  type PiEvent,
  type PiEventType,
  type PiModel,
  type PiSessionState,
  type PiSlashCommand,
  type PiThinkingLevel,
} from "./protocol";

/**
 * Translates one pi SDK session event into the wire event the panel consumes.
 *
 * The two vocabularies are the same by construction — RPC serialises these very
 * events — so this narrows rather than re-interprets: an event the panel has no
 * renderer for returns undefined instead of being forwarded to be ignored three
 * layers later. `PANEL_EVENT_TYPES` is the contract, and the client's test
 * asserts this list never drifts from it.
 */
export function toPiEvent(event: unknown): PiEvent | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const type = (event as { type?: unknown }).type;
  if (typeof type !== "string" || !PANEL_EVENT_TYPES.includes(type as PiEventType)) {
    return undefined;
  }

  // Deliberate cast: the guard above proves `type` is one the panel renders, and
  // the objects are the SDK's own session events, whose field names and shapes
  // were verified against `dist/core/agent-session.d.ts`. Re-validating every
  // field here would duplicate the protocol types without narrowing anything.
  return event as PiEvent;
}

/** Narrows a pi-ai model into the shape the panel's picker renders. */
export function toPiModel(model: unknown): PiModel | undefined {
  if (typeof model !== "object" || model === null) {
    return undefined;
  }

  const source = model as Record<string, unknown>;
  // An empty id would render a picker row that cannot be selected, so it is
  // treated as missing rather than kept.
  if (typeof source.id !== "string" || source.id.length === 0) {
    return undefined;
  }

  const result: PiModel = { id: source.id };
  if (typeof source.name === "string") {
    result.name = source.name;
  }
  if (typeof source.api === "string") {
    result.api = source.api;
  }
  if (typeof source.provider === "string") {
    result.provider = source.provider;
  }
  if (typeof source.baseUrl === "string") {
    result.baseUrl = source.baseUrl;
  }
  if (typeof source.reasoning === "boolean") {
    result.reasoning = source.reasoning;
  }
  if (typeof source.contextWindow === "number" && Number.isFinite(source.contextWindow)) {
    result.contextWindow = source.contextWindow;
  }
  if (typeof source.maxTokens === "number" && Number.isFinite(source.maxTokens)) {
    result.maxTokens = source.maxTokens;
  }
  return result;
}

/** What the client can read off a live SDK session, kept structural so this stays testable. */
export interface SdkSessionSnapshot {
  model?: unknown;
  thinkingLevel?: unknown;
  isStreaming?: unknown;
  isCompacting?: unknown;
  sessionFile?: unknown;
  sessionId?: unknown;
  sessionName?: unknown;
  messageCount?: unknown;
  pendingMessageCount?: unknown;
  autoCompactionEnabled?: unknown;
  steeringMode?: unknown;
  followUpMode?: unknown;
}

/** Projects a live session into the state record the panel already knows. */
export function toPiSessionState(snapshot: SdkSessionSnapshot): PiSessionState {
  const state: PiSessionState = {};

  const model = toPiModel(snapshot.model);
  if (model) {
    state.model = model;
  }
  // The SDK's `ThinkingLevel` is a subset of ours, so the string check is the
  // whole narrowing and the cast only records that.
  if (typeof snapshot.thinkingLevel === "string") {
    state.thinkingLevel = snapshot.thinkingLevel as PiThinkingLevel;
  }
  if (typeof snapshot.isStreaming === "boolean") {
    state.isStreaming = snapshot.isStreaming;
  }
  if (typeof snapshot.isCompacting === "boolean") {
    state.isCompacting = snapshot.isCompacting;
  }
  if (typeof snapshot.sessionFile === "string") {
    state.sessionFile = snapshot.sessionFile;
  }
  if (typeof snapshot.sessionId === "string") {
    state.sessionId = snapshot.sessionId;
  }
  if (typeof snapshot.sessionName === "string") {
    state.sessionName = snapshot.sessionName;
  }
  if (typeof snapshot.messageCount === "number" && Number.isFinite(snapshot.messageCount)) {
    state.messageCount = snapshot.messageCount;
  }
  if (
    typeof snapshot.pendingMessageCount === "number" &&
    Number.isFinite(snapshot.pendingMessageCount)
  ) {
    state.pendingMessageCount = snapshot.pendingMessageCount;
  }
  if (typeof snapshot.autoCompactionEnabled === "boolean") {
    state.autoCompactionEnabled = snapshot.autoCompactionEnabled;
  }
  // The two queue modes are a closed set, so a value outside it is dropped
  // rather than cast into the protocol type.
  if (snapshot.steeringMode === "all" || snapshot.steeringMode === "one-at-a-time") {
    state.steeringMode = snapshot.steeringMode;
  }
  if (snapshot.followUpMode === "all" || snapshot.followUpMode === "one-at-a-time") {
    state.followUpMode = snapshot.followUpMode;
  }
  return state;
}

/** What each source of slash commands contributes, loosely typed on purpose. */
export interface SdkCommandSources {
  skills?: readonly unknown[];
  prompts?: readonly unknown[];
  commands?: readonly unknown[];
}

/**
 * Collects the session's slash commands.
 *
 * pi has three sources with three different shapes, and the panel shows one list,
 * so the naming is resolved here: an extension command prefers `invocationName`
 * (what the owner actually types) over `name`. A name seen twice is kept once —
 * the first source wins — because two rows that do the same thing in a picker is
 * a bug the owner cannot work around.
 */
export function toPiCommands(sources: SdkCommandSources): PiSlashCommand[] {
  const commands: PiSlashCommand[] = [];
  const seen = new Set<string>();

  const collect = (
    entries: readonly unknown[],
    source: PiSlashCommand["source"],
    preferInvocationName: boolean,
  ): void => {
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const invocationName = record.invocationName;
      const name =
        preferInvocationName && typeof invocationName === "string" && invocationName.length > 0
          ? invocationName
          : record.name;
      if (typeof name !== "string" || name.length === 0 || seen.has(name)) {
        continue;
      }
      seen.add(name);

      const command: PiSlashCommand = { name, source };
      if (typeof record.description === "string" && record.description.length > 0) {
        command.description = record.description;
      }
      commands.push(command);
    }
  };

  collect(sources.commands ?? [], "extension", true);
  collect(sources.skills ?? [], "skill", false);
  collect(sources.prompts ?? [], "prompt", false);
  return commands;
}
