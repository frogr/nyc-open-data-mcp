/**
 * The remote (HTTP) server as a plain fetch-style handler:
 *   (Request, { ip }) => Promise<Response>
 *
 * Routes:
 *   GET  /          web playground (public/index.html)
 *   GET  /health    liveness + config summary, never calls Socrata
 *   POST /mcp       MCP Streamable HTTP, stateless, JSON responses
 *   OPTIONS *       CORS preflight
 *
 * Keeping this free of node:http makes it easy to test (hand it a Request)
 * and easy to move to another runtime. src/http.ts adapts it to Node.
 */
import { readFileSync } from "node:fs";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DailyCap, RateLimiter, type Clock } from "./rateLimit.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";
import { SocrataClient } from "./socrata.js";

export interface AppConfig {
  /** Requests per minute per IP on /mcp. */
  rateLimitPerMinute: number;
  /** Requests per UTC day on /mcp across everyone. Protects the shared Socrata quota. */
  dailyRequestLimit: number;
  /** Largest accepted POST body, in bytes. */
  maxBodyBytes: number;
  /** Wall-clock limit for one /mcp request. */
  requestTimeoutMs: number;
  /** Value for Access-Control-Allow-Origin: "*" or a comma-separated allow list. */
  corsOrigins: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  rateLimitPerMinute: 30,
  dailyRequestLimit: 5000,
  maxBodyBytes: 64 * 1024,
  requestTimeoutMs: 30_000,
  corsOrigins: "*",
};

/** Read AppConfig from env vars, falling back to defaults for anything missing or invalid. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const int = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    rateLimitPerMinute: int("RATE_LIMIT_PER_MINUTE", DEFAULT_CONFIG.rateLimitPerMinute),
    dailyRequestLimit: int("DAILY_REQUEST_LIMIT", DEFAULT_CONFIG.dailyRequestLimit),
    maxBodyBytes: int("MAX_BODY_BYTES", DEFAULT_CONFIG.maxBodyBytes),
    requestTimeoutMs: int("REQUEST_TIMEOUT_MS", DEFAULT_CONFIG.requestTimeoutMs),
    corsOrigins: env.CORS_ORIGINS?.trim() || DEFAULT_CONFIG.corsOrigins,
  };
}

export interface AppOptions {
  client: SocrataClient;
  config?: Partial<AppConfig>;
  now?: Clock;
  /** Called with internal errors. Details stay in logs; visitors get a generic message. */
  log?: (msg: string, err?: unknown) => void;
}

export type Handler = (req: Request, ctx: { ip: string }) => Promise<Response>;

const PLAYGROUND_HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const CORS_ALLOW_HEADERS = "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID";
const CORS_EXPOSE_HEADERS = "Mcp-Session-Id, Mcp-Protocol-Version, Retry-After, RateLimit-Remaining";

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function createApp(opts: AppOptions): Handler {
  const config: AppConfig = { ...DEFAULT_CONFIG, ...opts.config };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg, err) => console.error(msg, err ?? ""));
  const perIp = new RateLimiter(config.rateLimitPerMinute, 60_000, now);
  const daily = new DailyCap(config.dailyRequestLimit, now);
  const startedAt = now();
  const allowList = config.corsOrigins === "*" ? null : config.corsOrigins.split(",").map((s) => s.trim()).filter(Boolean);

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    const h: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS,
      "Access-Control-Max-Age": "86400",
    };
    if (!allowList) h["Access-Control-Allow-Origin"] = "*";
    else if (origin && allowList.includes(origin)) {
      h["Access-Control-Allow-Origin"] = origin;
      h["Vary"] = "Origin";
    }
    return h;
  }

  async function handleMcp(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
      return rpcError(405, -32000, "Method not allowed. This server is stateless: send JSON-RPC with POST.", { Allow: "POST, OPTIONS" });
    }
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > config.maxBodyBytes) {
      return rpcError(413, -32000, `Request body too large (max ${config.maxBodyBytes} bytes).`);
    }

    // One server + transport per request: the recommended stateless pattern.
    // The Socrata client (and its cache) is shared.
    const server = createServer(opts.client);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: config.maxBodyBytes,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await server.connect(transport);
      const timeout = new Promise<Response>((resolve) => {
        timer = setTimeout(
          () => resolve(rpcError(504, -32001, `Request timed out after ${Math.round(config.requestTimeoutMs / 1000)}s. Try a narrower query.`)),
          config.requestTimeoutMs,
        );
      });
      return await Promise.race([transport.handleRequest(req), timeout]);
    } finally {
      clearTimeout(timer);
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    }
  }

  return async function handle(req, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);
    try {
      if (req.method === "OPTIONS") return withHeaders(new Response(null, { status: 204 }), cors);

      if (url.pathname === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") return withHeaders(text(405, "Method not allowed"), cors);
        return withHeaders(
          jsonResponse(200, {
            status: "ok",
            name: SERVER_NAME,
            version: SERVER_VERSION,
            transport: "streamable-http",
            endpoint: "/mcp",
            uptime_s: Math.round((now() - startedAt) / 1000),
            socrata_app_token: opts.client.hasAppToken,
            limits: { per_ip_per_minute: config.rateLimitPerMinute, daily_requests: config.dailyRequestLimit, daily_used: daily.used },
          }),
          cors,
        );
      }

      if (url.pathname === "/mcp") {
        if (req.method === "POST") {
          const ip = perIp.take(ctx.ip);
          if (!ip.allowed) {
            return withHeaders(
              rpcError(429, -32000, `Rate limit: ${config.rateLimitPerMinute} requests per minute per IP. Retry in ${ip.retryAfterSec}s.`, {
                "Retry-After": String(ip.retryAfterSec),
              }),
              cors,
            );
          }
          const day = daily.take();
          if (!day.allowed) {
            return withHeaders(
              rpcError(429, -32000, "This public demo hit its daily request cap. Try again tomorrow, or run the server yourself (npx nyc-open-data-mcp).", {
                "Retry-After": String(day.retryAfterSec),
              }),
              cors,
            );
          }
          return withHeaders(await handleMcp(req), { ...cors, "RateLimit-Remaining": String(ip.remaining) });
        }
        return withHeaders(await handleMcp(req), cors);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (req.method !== "GET" && req.method !== "HEAD") return text(405, "Method not allowed");
        return new Response(req.method === "HEAD" ? null : PLAYGROUND_HTML, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": PAGE_CSP,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "public, max-age=300",
          },
        });
      }

      return withHeaders(text(404, "Not found. The MCP endpoint is POST /mcp; the playground is at /."), cors);
    } catch (err) {
      log(`[http] ${req.method} ${url.pathname} failed`, err);
      return withHeaders(
        url.pathname === "/mcp" ? rpcError(500, -32603, "Internal server error.") : text(500, "Internal server error."),
        cors,
      );
    }
  };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
