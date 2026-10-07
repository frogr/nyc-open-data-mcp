/**
 * Thin, defensive client for the Socrata SODA + Discovery (catalog) APIs.
 *
 * - Timeouts on every request (AbortSignal.timeout).
 * - Optional app token (SOCRATA_APP_TOKEN) for higher rate limits.
 * - Retries with backoff on 429 / 5xx, honoring Retry-After (capped).
 * - Short-lived in-memory cache so an agent re-asking the same question
 *   doesn't hammer the API.
 * - Every failure becomes a SocrataError with an LLM-actionable hint.
 */

export const NYC_DOMAIN = "data.cityofnewyork.us";
export const CATALOG_URL = "https://api.us.socrata.com/api/catalog/v1";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SocrataClientOptions {
  domain?: string;
  appToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtlMs?: number;
  fetch?: FetchLike;
  /** Injected for tests so retries don't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export type SoqlParams = Partial<
  Record<"$select" | "$where" | "$order" | "$group" | "$having" | "$q" | "$limit" | "$offset", string | number>
>;

export class SocrataError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
    readonly hint: string,
  ) {
    super(message);
    this.name = "SocrataError";
  }

  /** Message formatted for an LLM: what happened + what to do next. */
  toToolMessage(): string {
    const status = this.status ? ` (HTTP ${this.status}${this.code ? `, ${this.code}` : ""})` : "";
    return `${this.message}${status}\nHint: ${this.hint}`;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 5_000;
const CACHE_MAX_ENTRIES = 100;

export class SocrataClient {
  readonly domain: string;
  private readonly appToken?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, { expires: number; value: unknown }>();

  constructor(opts: SocrataClientOptions = {}) {
    this.domain = opts.domain ?? NYC_DOMAIN;
    this.appToken = opts.appToken || undefined;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Run a SoQL query against a dataset's /resource endpoint. */
  async query<T = Record<string, unknown>>(datasetId: string, params: SoqlParams): Promise<T[]> {
    const url = new URL(`https://${this.domain}/resource/${encodeURIComponent(datasetId)}.json`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const body = await this.getJson(url.toString(), { datasetId });
    if (!Array.isArray(body)) {
      throw new SocrataError("Unexpected response shape from Socrata (expected an array of rows).", undefined, undefined, "Retry; if it persists, the dataset may not be tabular.");
    }
    return body as T[];
  }

  /** Search the Socrata Discovery API, scoped to this domain. */
  async searchCatalog(params: { q?: string; limit: number; offset: number; category?: string }): Promise<CatalogResponse> {
    const url = new URL(CATALOG_URL);
    url.searchParams.set("domains", this.domain);
    url.searchParams.set("search_context", this.domain);
    url.searchParams.set("only", "dataset");
    if (params.q) url.searchParams.set("q", params.q);
    if (params.category) url.searchParams.set("categories", params.category);
    url.searchParams.set("limit", String(params.limit));
    url.searchParams.set("offset", String(params.offset));
    const body = (await this.getJson(url.toString(), {})) as CatalogResponse;
    if (!body || !Array.isArray(body.results)) {
      throw new SocrataError("Unexpected response shape from the Socrata catalog.", undefined, undefined, "Retry the search in a moment.");
    }
    return body;
  }

  private async getJson(url: string, ctx: { datasetId?: string }): Promise<unknown> {
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.value;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "nyc-open-data-mcp (+https://github.com/frogr/nyc-open-data-mcp)",
    };
    if (this.appToken) headers["X-App-Token"] = this.appToken;

    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (attempt < this.maxRetries && !isTimeout) {
          await this.sleep(backoff(attempt++));
          continue;
        }
        throw isTimeout
          ? new SocrataError(
              `Socrata did not respond within ${Math.round(this.timeoutMs / 1000)}s.`,
              undefined,
              "timeout",
              "Narrow the query: add a $where filter (e.g. a date range), lower $limit, or avoid unfiltered aggregates on very large datasets like 311.",
            )
          : new SocrataError(
              `Network error contacting Socrata: ${err instanceof Error ? err.message : String(err)}`,
              undefined,
              "network",
              "Check internet connectivity / proxy settings, then retry.",
            );
      }

      if (res.ok) {
        const value = await res.json();
        this.remember(url, value);
        return value;
      }

      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        await this.sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoff(attempt));
        attempt++;
        continue;
      }

      throw await toSocrataError(res, ctx, Boolean(this.appToken));
    }
  }

  private remember(url: string, value: unknown) {
    if (this.cacheTtlMs <= 0) return;
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, { expires: Date.now() + this.cacheTtlMs, value });
  }
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, MAX_RETRY_AFTER_MS);
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return undefined;
}

async function toSocrataError(res: Response, ctx: { datasetId?: string }, hasToken: boolean): Promise<SocrataError> {
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const body = (await res.json()) as { code?: string; message?: string; errorCode?: string };
    code = body.code ?? body.errorCode;
    detail = body.message;
  } catch {
    /* non-JSON error body; fall through to generic messages */
  }

  switch (res.status) {
    case 400:
      return new SocrataError(
        `Socrata rejected the query: ${detail ?? "bad request"}`,
        400,
        code,
        "Check SoQL syntax and column names. Column names are the API field names (snake_case) listed by search_datasets; string literals use single quotes; dates look like '2026-01-31T00:00:00'.",
      );
    case 401:
    case 403:
      return new SocrataError(
        "Socrata refused access to this resource.",
        res.status,
        code,
        hasToken ? "SOCRATA_APP_TOKEN may be invalid; remove it or replace it." : "The dataset may be private or restricted; try a different dataset.",
      );
    case 404:
      return new SocrataError(
        ctx.datasetId ? `Dataset '${ctx.datasetId}' was not found on ${NYC_DOMAIN}.` : "Resource not found.",
        404,
        code,
        "Use search_datasets to find a valid dataset id (format: xxxx-xxxx).",
      );
    case 429:
      return new SocrataError(
        "Rate limited by Socrata.",
        429,
        code,
        hasToken ? "Wait a few seconds and retry with a smaller query." : "Wait and retry, or set the SOCRATA_APP_TOKEN env var (free) for much higher rate limits.",
      );
    default:
      return new SocrataError(
        `Socrata returned an error${detail ? `: ${detail}` : "."}`,
        res.status,
        code,
        res.status >= 500 ? "Socrata is having trouble; retry shortly, or narrow the query if it is very broad." : "Check the request parameters.",
      );
  }
}

// ---- Catalog response types (subset we use) ----

export interface CatalogResponse {
  results: CatalogResult[];
  resultSetSize: number;
}

export interface CatalogResult {
  resource: {
    id: string;
    name: string;
    description?: string;
    type?: string;
    updatedAt?: string;
    data_updated_at?: string;
    attribution?: string | null;
    columns_field_name?: string[];
    columns_datatype?: string[];
    download_count?: number;
  };
  classification?: { domain_category?: string };
  permalink?: string;
  link?: string;
}
