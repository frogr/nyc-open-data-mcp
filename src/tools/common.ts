import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SocrataError } from "../socrata.js";

/** A user-fixable input problem detected after schema validation. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Successful result: JSON text for any client + structuredContent for clients that use outputSchema. */
export function ok<T extends Record<string, unknown>>(data: T): CallToolResult & { structuredContent: T } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Error result the model can read and act on, instead of a protocol-level failure. */
export function fail(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof SocrataError) text = err.toToolMessage();
  else if (err instanceof ToolInputError) text = `Invalid input: ${err.message}`;
  else text = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: "text", text }] };
}

/** Wrap a handler so every thrown error becomes a readable tool error. */
export function safe<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      return fail(err);
    }
  };
}

/** Rough cap on the JSON we hand back to the model, to protect its context window. */
export const MAX_RESULT_CHARS = 60_000;

/**
 * Drop rows from the end until the serialized payload fits the budget.
 * Returns the kept rows and how many were dropped.
 */
export function fitRows<T>(rows: T[], budget = MAX_RESULT_CHARS): { rows: T[]; dropped: number } {
  let size = 2;
  for (let i = 0; i < rows.length; i++) {
    size += JSON.stringify(rows[i]).length + 1;
    if (size > budget) return { rows: rows.slice(0, Math.max(i, 1)), dropped: rows.length - Math.max(i, 1) };
  }
  return { rows, dropped: 0 };
}

export function truncate(text: string | undefined | null, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Today's date in New York as YYYY-MM-DD. */
export function todayInNyc(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
