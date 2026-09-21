import type { PiAssistantContent, PiUsage } from "./protocol";

/**
 * What a session has cost so far.
 *
 * pi does not report a running total: `get_state` carries the session's identity and
 * the model, and the numbers arrive per message. So PiCode adds them up from the
 * authoritative `message_end` records, which is the only place the usage is stated.
 *
 * All of the arithmetic and formatting is pure, so what the panel claims about money
 * and tokens can be checked without an editor.
 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** The last message's context size, which is what a window limit applies to. */
  contextTokens: number;
  cost: number;
  assistantMessages: number;
  toolCalls: number;
}

export function emptyUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    contextTokens: 0,
    cost: 0,
    assistantMessages: 0,
    toolCalls: 0,
  };
}

/** Adds one assistant message. Returns a new object; the caller's total is untouched. */
export function addMessageUsage(
  totals: UsageTotals,
  usage: PiUsage | undefined,
  content: readonly PiAssistantContent[] | undefined,
): UsageTotals {
  const next: UsageTotals = {
    ...totals,
    assistantMessages: totals.assistantMessages + 1,
    toolCalls: totals.toolCalls + countToolCalls(content),
  };

  if (!usage) {
    return next;
  }

  next.input += usage.input ?? 0;
  next.output += usage.output ?? 0;
  next.cacheRead += usage.cacheRead ?? 0;
  next.cacheWrite += usage.cacheWrite ?? 0;
  next.reasoning += usage.reasoning ?? 0;
  next.cost += usage.cost?.total ?? 0;

  // Context pressure is not a sum: it is how full the window was on the last turn,
  // so the newest message replaces the previous value.
  const used = usage.totalTokens ?? 0;
  if (used > 0) {
    next.contextTokens = used;
  }

  return next;
}

export function countToolCalls(content: readonly PiAssistantContent[] | undefined): number {
  if (!Array.isArray(content)) {
    return 0;
  }
  let calls = 0;
  for (const block of content) {
    if (block && block.type === "toolCall") {
      calls += 1;
    }
  }
  return calls;
}

/**
 * Groups thousands explicitly.
 *
 * `toLocaleString` was the obvious choice and is the wrong one here: Spanish CLDR
 * only groups from five digits, so 3000 renders as 3000 and 20000 as 20.000. The
 * output would then depend on the ICU build. A report about money and tokens should
 * not change shape between machines.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      grouped += ".";
    }
    grouped += digits.charAt(index);
  }
  return sign + grouped;
}

/** `12345` becomes `12,3k`, and small numbers stay exact. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens < 1000) {
    return String(Math.round(tokens));
  }
  const thousands = tokens / 1000;
  if (thousands < 1000) {
    return `${thousands.toFixed(thousands < 100 ? 1 : 0).replace(".", ",")}k`;
  }
  return `${(thousands / 1000).toFixed(2).replace(".", ",")}M`;
}

/** Costs are fractions of a cent, so a two-decimal figure would read as zero. */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) {
    return "0 $";
  }
  const decimals = cost >= 0.1 ? 2 : 4;
  return `${cost.toFixed(decimals).replace(".", ",")} $`;
}

/** How full the context window was on the last turn, or undefined without a window. */
export function contextPressure(totals: UsageTotals, contextWindow: number | undefined): string | undefined {
  if (!contextWindow || contextWindow <= 0 || totals.contextTokens <= 0) {
    return undefined;
  }
  const percent = Math.min(100, Math.round((totals.contextTokens / contextWindow) * 100));
  return `${percent}% de ${formatTokens(contextWindow)}`;
}

/** The one line the chat panel shows under its toolbar. */
export function summarizeUsage(totals: UsageTotals, contextWindow?: number): string {
  if (totals.assistantMessages === 0) {
    return "";
  }

  const parts = [`${formatTokens(totals.input + totals.output)} tokens`];
  if (totals.cacheRead > 0) {
    parts.push(`${formatTokens(totals.cacheRead)} en caché`);
  }
  if (totals.cost > 0) {
    parts.push(formatCost(totals.cost));
  }

  const pressure = contextPressure(totals, contextWindow);
  if (pressure) {
    parts.push(`contexto ${pressure}`);
  }

  return parts.join(" · ");
}

/** The lines the usage report shows, in the order it shows them. */
export function describeUsage(totals: UsageTotals, contextWindow?: number): string[] {
  if (totals.assistantMessages === 0) {
    return ["Todavía no hay ninguna respuesta del agente en esta sesión."];
  }

  const lines = [
    `respuestas: ${totals.assistantMessages} · herramientas: ${totals.toolCalls}`,
    `tokens de entrada: ${formatCount(totals.input)}`,
    `tokens de salida: ${formatCount(totals.output)}`,
  ];

  if (totals.cacheRead > 0) {
    lines.push(`leídos de caché: ${formatCount(totals.cacheRead)}`);
  }
  if (totals.cacheWrite > 0) {
    lines.push(`escritos en caché: ${formatCount(totals.cacheWrite)}`);
  }
  if (totals.reasoning > 0) {
    lines.push(`razonamiento: ${formatCount(totals.reasoning)}`);
  }

  lines.push(`coste acumulado: ${formatCost(totals.cost)}`);

  const pressure = contextPressure(totals, contextWindow);
  lines.push(
    pressure
      ? `contexto de la última respuesta: ${pressure}`
      : "contexto de la última respuesta: ventana desconocida",
  );

  return lines;
}
