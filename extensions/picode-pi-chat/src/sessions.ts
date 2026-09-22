import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * Reading pi's own session files.
 *
 * pi keeps one JSONL per conversation under `~/.pi/agent/sessions/--<working directory>--/`,
 * and the RPC protocol has no command that lists them: it can switch to a session once you
 * know its path, but finding the path is a filesystem job. That is what this does.
 *
 * Nothing here decides what a session *is*: the format is pi's, so this reads as little as
 * it can get away with and says so when it cannot tell.
 */

export interface SessionSummary {
  /** Absolute path of the JSONL file, which is what `switch_session` takes. */
  file: string;
  /** The timestamp pi put in the file name. */
  stamp: string;
  /** Derived from the first user message, because that is what makes a session recognisable. */
  title?: string;
  /** The name pi recorded for the session, which subagent runs set automatically. */
  name?: string;
  bytes: number;
  modified: number;
}

/**
 * How much of a session is read to find its name and title.
 *
 * Larger than it looks like it should be, and measured: the first user message sits behind
 * the system prompt and the tool definitions, which on this machine puts it between 104 and
 * 168 kB into the file. A 64 kB read never reached it, so every session came back untitled.
 */
const HEAD_BYTES = 512 * 1024;

/**
 * The directory name pi uses for a working directory.
 *
 * Documented in pi's `docs/session-format.md`: the leading path separator is removed and
 * `/`, `\` and `:` become `-`, wrapped in `--`. So `D:\repositorios\PiCode` becomes
 * `--D--repositorios-PiCode--`.
 */
export function encodeProjectDir(cwd: string): string {
  const withoutLeadingSeparator = cwd.replace(/^[\\/]+/, "");
  return `--${withoutLeadingSeparator.replace(/[\\/:]/g, "-")}--`;
}

/**
 * Where pi keeps sessions.
 *
 * `--session-dir` is honoured because an owner can point pi elsewhere through
 * `picode.pi.extraArgs`, and reporting an empty list from the wrong directory would look
 * like "you have no sessions" rather than "PiCode looked in the wrong place".
 */
export function sessionsRoot(extraArgs: readonly string[] = []): string {
  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (arg === "--session-dir") {
      const value = extraArgs[index + 1];
      if (value && value.length > 0) {
        return value;
      }
    }
    if (arg.startsWith("--session-dir=")) {
      const value = arg.slice("--session-dir=".length);
      if (value.length > 0) {
        return value;
      }
    }
  }
  return path.join(homedir(), ".pi", "agent", "sessions");
}

/**
 * The directory for one project, or undefined when there is no sessions root at all.
 *
 * The drive letter's case is not stable — `--D--repositorios-PiCode--` and
 * `--d--repositorios-raiderio-adblock--` coexist on this machine — so an exact match is
 * tried first and a case-insensitive one after it.
 */
export function projectSessionsDir(cwd: string, root: string): string | undefined {
  const wanted = encodeProjectDir(cwd);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  const found =
    entries.find((entry) => entry === wanted) ??
    entries.find((entry) => entry.toLowerCase() === wanted.toLowerCase());
  return path.join(root, found ?? wanted);
}

function readHead(file: string, bytes = HEAD_BYTES): string {
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The name pi recorded for the session, when there is one.
 *
 * Worth preferring over the first message: pi sets it automatically for subagent runs
 * (`general-purpose#3b2a3f0e`), so it is the difference between a list of conversations and
 * a list where half the rows are runs the owner never started.
 */
export function sessionName(head: string): string | undefined {
  for (const line of head.split(/\r?\n/)) {
    if (!line.includes("session_info")) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.length > 0) {
        return entry.name;
      }
    } catch {
      // A truncated head can cut a line in half; that is not an error.
    }
  }
  return undefined;
}

/**
 * The first user message, trimmed to something a list can show.
 *
 * Only the head of the file is read: this runs for every session in a project when the
 * menu opens, and a long conversation is several megabytes.
 */
export function sessionTitle(head: string): string | undefined {
  for (const line of head.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A truncated head can cut the last line in half; that is not an error.
      continue;
    }

    const record = entry as { message?: { role?: unknown; content?: unknown }; role?: unknown; content?: unknown };
    const message = record.message ?? record;
    if (message?.role !== "user") {
      continue;
    }

    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((block): block is { type: string; text: string } =>
                typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
              )
              .map((block) => block.text)
              .join(" ")
          : "";

    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
    }
  }
  return undefined;
}

/** A size a list can show without a unit table. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0).replace(".", ",")} kB`;
  }
  return `${(kilobytes / 1024).toFixed(1).replace(".", ",")} MB`;
}

/** The file names pi writes: `<timestamp>_<session-id>.jsonl`. */
function stampFromFileName(file: string): string {
  const base = path.basename(file, ".jsonl");
  const underscore = base.indexOf("_");
  return (underscore > 0 ? base.slice(0, underscore) : base).replace("T", " ").replace("Z", "");
}

/** The project's sessions, newest first. Returns an empty list rather than throwing. */
export function listSessions(directory: string, limit = 30): SessionSummary[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const file = path.join(directory, name);
    try {
      const stats = statSync(file);
      const head = readHead(file);
      const sessionNameFound = sessionName(head);
      const title = sessionTitle(head);
      summaries.push({
        file,
        stamp: stampFromFileName(file),
        ...(title ? { title } : {}),
        ...(sessionNameFound ? { name: sessionNameFound } : {}),
        bytes: stats.size,
        modified: stats.mtimeMs,
      });
    } catch {
      // A file that disappeared between the listing and the read is not worth reporting.
    }
  }

  summaries.sort((left, right) => right.modified - left.modified);
  return summaries.slice(0, limit);
}

/** Reads the whole file, for callers that need more than the head. */
export function readSession(file: string): string {
  return readFileSync(file, "utf8");
}

/** One message as the session file recorded it, in the shapes the panel already renders. */
export interface SessionMessage {
  role: "user" | "assistant" | "toolResult";
  /** The message's own content blocks, passed through untouched. */
  content: unknown;
  /** Present on assistant messages. */
  usage?: unknown;
  /** Present on tool results, so a replayed row can be matched to its call. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

export interface SessionReplay {
  /** Every message the file holds, in order, including the ones `tail` was cut from. */
  messages: SessionMessage[];
  /** How many messages the caller asked to omit from the end of `messages`. */
  omitted: number;
  /** The whole conversation's usage, summed from every assistant message present. */
  totals: SessionUsageTotals;
}

/** What a session has cost and consumed, summed over its assistant messages. */
export interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  assistantMessages: number;
  /** The last assistant message's context size, which is what a window limit applies to. */
  contextTokens: number;
  /** Rows of tool results, which is the closest thing a file has to "tool calls". */
  toolCalls: number;
}

/** How many of the most recent messages a replay keeps when the caller does not say. */
const REPLAY_LIMIT = 40;

/** Anything that survived `JSON.parse` and can be read by key. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A missing, non-numeric or non-finite field contributes nothing. */
function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Reads a session file into the messages a panel can replay.
 *
 * `limit` is how many of the most recent messages the caller wants; everything is
 * still parsed, because the totals describe the whole conversation and a resumed
 * session that reported only the cost of its visible tail would be wrong in a way
 * nobody could see.
 *
 * The content blocks are passed through exactly as the file holds them. They are the
 * same vocabulary the live events carry, so the replay renders through the same code
 * as a live reply and the two cannot drift apart.
 */
export function parseSession(text: string, limit?: number): SessionReplay {
  const messages: SessionMessage[] = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let cost = 0;
  let contextTokens = 0;
  let assistantMessages = 0;
  let toolCalls = 0;

  const wanted = typeof limit === "number" && Number.isFinite(limit) ? limit : REPLAY_LIMIT;

  for (const line of typeof text === "string" ? text.split(/\r?\n/) : []) {
    if (line.trim().length === 0) {
      continue;
    }

    // A session file is an append-only log, so the last line can be half-written and a
    // stray line can be anything at all. One unreadable entry must not cost the whole
    // conversation, so anything that does not parse is skipped silently.
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }

    // The message normally sits under `message`, but a bare `{ role, content }` line is
    // tolerated the same way `sessionTitle` already tolerates it.
    const message = isRecord(entry.message) ? entry.message : entry;
    const role = message.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
      continue;
    }

    const parsed: SessionMessage = { role, content: message.content };

    const timestamp = typeof message.timestamp === "number" ? message.timestamp : entry.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      parsed.timestamp = timestamp;
    }

    if (role === "assistant" && message.usage !== undefined) {
      parsed.usage = message.usage;
    }

    if (role === "toolResult") {
      if (typeof message.toolCallId === "string") {
        parsed.toolCallId = message.toolCallId;
      }
      if (typeof message.toolName === "string") {
        parsed.toolName = message.toolName;
      }
      if (typeof message.isError === "boolean") {
        parsed.isError = message.isError;
      }
    }

    messages.push(parsed);

    if (role === "assistant") {
      assistantMessages += 1;
      if (isRecord(message.usage)) {
        const usage = message.usage;
        input += numberOrZero(usage.input);
        output += numberOrZero(usage.output);
        cacheRead += numberOrZero(usage.cacheRead);
        cacheWrite += numberOrZero(usage.cacheWrite);
        reasoning += numberOrZero(usage.reasoning);
        cost += isRecord(usage.cost) ? numberOrZero(usage.cost.total) : 0;
        // Context pressure is not a sum: it is how full the window was on the last
        // turn, so the newest usable reading replaces the previous one.
        contextTokens =
          numberOrZero(usage.input) + numberOrZero(usage.cacheRead) + numberOrZero(usage.cacheWrite);
      }
    } else if (role === "toolResult") {
      toolCalls += 1;
    }
  }

  const omitted = messages.length > wanted ? messages.length - wanted : 0;

  return {
    messages,
    omitted,
    totals: {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      cost,
      assistantMessages,
      contextTokens,
      toolCalls,
    },
  };
}
