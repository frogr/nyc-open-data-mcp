/**
 * Helpers for building SoQL safely.
 *
 * Rule of thumb: any user-supplied *value* that ends up inside a SoQL clause
 * goes through `soqlString()` (or `soqlLike()`), never string concatenation.
 * Identifiers we build ourselves are hard-coded, so they never need escaping.
 */

/** Escape a value for use inside a single-quoted SoQL string literal. */
export function escapeSoqlString(value: string): string {
  // SoQL (like SQL) escapes a single quote by doubling it.
  return value.replace(/'/g, "''");
}

/** Quote a value as a SoQL string literal: O'Brien -> 'O''Brien' */
export function soqlString(value: string): string {
  return `'${escapeSoqlString(value)}'`;
}

/**
 * Build a case-insensitive "contains" predicate for a column.
 * LIKE wildcards in the user's input (% and _) are treated as literals by
 * stripping them, so "100%" can't turn into a match-everything pattern.
 */
export function soqlContains(column: string, value: string): string {
  const cleaned = value.replace(/[%_]/g, " ").trim().toUpperCase();
  return `upper(${column}) like ${soqlString(`%${cleaned}%`)}`;
}

/** `column in ('a','b')`, every value escaped. */
export function soqlIn(column: string, values: readonly string[]): string {
  return `${column} in (${values.map(soqlString).join(", ")})`;
}

/** Join non-empty predicates with AND. Returns undefined when there are none. */
export function and(...predicates: Array<string | undefined | false>): string | undefined {
  const parts = predicates.filter((p): p is string => typeof p === "string" && p.length > 0);
  if (parts.length === 0) return undefined;
  return parts.map((p) => (parts.length > 1 ? `(${p})` : p)).join(" AND ");
}

/** Socrata four-by-four dataset identifier, e.g. 43nn-pn8j. */
export const DATASET_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

/** YYYY-MM-DD, validated as a real calendar date. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

/** Floating-timestamp literal bounds for an inclusive day range. */
export function dayRange(column: string, start: string, end: string): string {
  return `${column} between ${soqlString(`${start}T00:00:00`)} and ${soqlString(`${end}T23:59:59.999`)}`;
}
