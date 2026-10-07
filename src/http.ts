#!/usr/bin/env node
/**
 * Remote entrypoint: serves the MCP endpoint over Streamable HTTP plus the
 * web playground. `npm start` runs this; the package bin (dist/index.js) stays stdio.
 *
 *   PORT=3000 node dist/http.js
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { configFromEnv, createApp, type AppConfig, type Handler } from "./app.js";
import { SocrataClient } from "./socrata.js";

export interface StartOptions {
  port?: number;
  host?: string;
  client?: SocrataClient;
  config?: Partial<AppConfig>;
  /** How many reverse proxies sit in front of us (Render: 1). 0 = use the socket address. */
  trustProxyHops?: number;
}

/** Wrap a fetch-style handler in a Node HTTP server. Exported for tests. */
export function nodeServer(handler: Handler, maxBodyBytes: number, trustProxyHops = 0): Server {
  const server = createHttpServer(async (req, res) => {
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, maxBodyBytes);
      if (body === TOO_LARGE) {
        send(res, 413, { jsonrpc: "2.0", error: { code: -32000, message: `Request body too large (max ${maxBodyBytes} bytes).` }, id: null });
        return;
      }
      const host = req.headers.host ?? "localhost";
      const request = new Request(new URL(req.url ?? "/", `http://${host}`), {
        method: req.method,
        headers: toHeaders(req),
        body: body as Uint8Array<ArrayBuffer> | undefined,
      });
      const response = await handler(request, { ip: clientIp(req, trustProxyHops) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body && req.method !== "HEAD") {
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      console.error("[http] adapter error", err);
      if (!res.headersSent) send(res, 500, { error: "Internal server error." });
      else res.destroy();
    }
  });
  // Slow-client protection: headers must arrive quickly, whole request within a minute.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

const TOO_LARGE = Symbol("too-large");

async function readBody(req: IncomingMessage, max: number): Promise<Uint8Array | typeof TOO_LARGE> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > max) {
    req.resume();
    return TOO_LARGE;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) {
      req.resume();
      return TOO_LARGE;
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function toHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) h.append(k, item);
    else h.set(k, v);
  }
  return h;
}

/**
 * The client's IP for rate limiting. Behind N trusted proxies, the real client
 * is the Nth address from the right of X-Forwarded-For; anything further left
 * was supplied by the client and can't be trusted.
 */
export function clientIp(req: Pick<IncomingMessage, "headers" | "socket">, trustProxyHops: number): string {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (trustProxyHops <= 0) return socketIp;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return socketIp;
  const hops = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return hops[Math.max(hops.length - trustProxyHops, 0)] ?? socketIp;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function start(opts: StartOptions = {}): Promise<Server> {
  const env = process.env;
  const config = { ...configFromEnv(env), ...opts.config };
  const client =
    opts.client ??
    new SocrataClient({
      appToken: env.SOCRATA_APP_TOKEN,
      // Leave room inside REQUEST_TIMEOUT_MS for a retry.
      timeoutMs: env.SOCRATA_TIMEOUT_MS ? Number(env.SOCRATA_TIMEOUT_MS) : 15_000,
    });
  const handler = createApp({ client, config });
  const server = nodeServer(handler, config.maxBodyBytes, opts.trustProxyHops ?? Number(env.TRUST_PROXY ?? 0));
  const port = opts.port ?? Number(env.PORT ?? 3000);
  const host = opts.host ?? env.HOST ?? "0.0.0.0";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}

// Run when executed directly (node dist/http.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  start()
    .then((server) => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : "?";
      console.error(
        `nyc-open-data-mcp listening on http://localhost:${port} (MCP at /mcp, playground at /)${process.env.SOCRATA_APP_TOKEN ? " (app token set)" : ""}`,
      );
      const shutdown = () => server.close(() => process.exit(0));
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch((err) => {
      console.error("nyc-open-data-mcp failed to start:", err);
      process.exit(1);
    });
}
