// The remote server: Streamable HTTP over a real socket with the official SDK
// client, plus the routes and limits around it. Socrata is still mocked, so
// nothing here touches the network beyond 127.0.0.1.
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppConfig } from "../src/app.js";
import { clientIp, nodeServer } from "../src/http.js";
import { fixture, json, mockFetch, param, testClient } from "./helpers.js";

const restaurantRoutes = () =>
  mockFetch([
    { match: param("$select", (s) => s.includes("max(inspection_date)")), respond: () => json(fixture("restaurants-summary.json")) },
    { match: param("$where", (s) => s.startsWith("camis in")), respond: () => json(fixture("restaurants-history.json")) },
    { match: (u) => u.pathname === "/resource/zzzz-zzzz.json", respond: () => json(fixture("error-dataset-missing.json"), 404) },
  ]);

function app(config: Partial<AppConfig> = {}, fetch = restaurantRoutes().fetch) {
  return createApp({ client: testClient(fetch), config, log: () => {} });
}

const RPC_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

function rpc(method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: { ...RPC_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const INIT_PARAMS = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } };
const local = { ip: "127.0.0.1" };

describe("HTTP transport with the SDK client over a real socket", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((r) => server?.close(r));
    server = undefined;
  });

  async function listen(config: Partial<AppConfig> = {}) {
    const handler = app(config);
    server = nodeServer(handler, 64 * 1024);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("initializes, lists tools and calls one", async () => {
    const base = await listen();
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

    expect(client.getServerVersion()).toMatchObject({ name: "nyc-open-data", version: "0.2.0" });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["query_dataset", "restaurant_inspections", "search_datasets", "service_requests_311"]);

    const res: any = await client.callTool({ name: "restaurant_inspections", arguments: { name: "ramen", zip_code: "10003" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.restaurants[0]).toMatchObject({ latest_grade: "A" });

    const missing: any = await client.callTool({ name: "query_dataset", arguments: { dataset_id: "zzzz-zzzz" } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/was not found/);

    await client.close();
  });

  it("answers 413 for an oversized body even without Content-Length", async () => {
    const base = await listen();
    const { port } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...RPC_HEADERS, "Transfer-Encoding": "chunked" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.write("x".repeat(40 * 1024));
      req.end("y".repeat(40 * 1024));
    });
    expect(status).toBe(413);
  });
});

describe("POST /mcp (handler)", () => {
  it("handles initialize statelessly with JSON responses and CORS headers", async () => {
    const res = await app()(rpc("initialize", INIT_PARAMS, { Origin: "https://inspector.example" }), local);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = await res.json();
    expect(body.result.serverInfo).toEqual({ name: "nyc-open-data", version: "0.2.0" });
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("serves tools/call without a prior initialize (stateless)", async () => {
    const res = await app()(rpc("tools/call", { name: "restaurant_inspections", arguments: { zip_code: "10003" } }), local);
    const body = await res.json();
    expect(body.result.structuredContent.returned).toBeGreaterThan(0);
  });

  it("answers CORS preflight", async () => {
    const res = await app()(
      new Request("http://test.local/mcp", { method: "OPTIONS", headers: { Origin: "http://localhost:6274", "Access-Control-Request-Method": "POST" } }),
      local,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Mcp-Protocol-Version/);
    expect(res.headers.get("access-control-expose-headers")).toMatch(/Mcp-Session-Id/);
  });

  it("only echoes allow-listed origins when CORS_ORIGINS is set", async () => {
    const handler = app({ corsOrigins: "https://good.example" });
    const good = await handler(rpc("initialize", INIT_PARAMS, { Origin: "https://good.example" }), local);
    expect(good.headers.get("access-control-allow-origin")).toBe("https://good.example");
    const bad = await handler(rpc("initialize", INIT_PARAMS, { Origin: "https://evil.example" }), local);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects GET/DELETE (no sessions), bad Accept, bad JSON and big bodies with JSON-RPC errors", async () => {
    const handler = app({ maxBodyBytes: 1000 });
    const get = await handler(new Request("http://test.local/mcp", { headers: { Accept: "text/event-stream" } }), local);
    expect(get.status).toBe(405);

    const accept = await handler(rpc("tools/list", {}, { Accept: "application/json" }), local);
    expect(accept.status).toBe(406);

    const garbled = await handler(new Request("http://test.local/mcp", { method: "POST", headers: RPC_HEADERS, body: "{not json" }), local);
    expect(garbled.status).toBe(400);
    const garbledBody = await garbled.json();
    expect(garbledBody.error.code).toBe(-32700);
    expect(JSON.stringify(garbledBody)).not.toMatch(/at .*\.(ts|js):\d+/); // no stack traces

    const big = await handler(
      new Request("http://test.local/mcp", { method: "POST", headers: { ...RPC_HEADERS, "Content-Length": "5000" }, body: "x".repeat(5000) }),
      local,
    );
    expect(big.status).toBe(413);
  });

  it("times out slow upstream calls with a 504", async () => {
    const hanging = async () => new Promise<Response>(() => {});
    const handler = app({ requestTimeoutMs: 50 }, hanging);
    const res = await handler(rpc("tools/call", { name: "query_dataset", arguments: { dataset_id: "43nn-pn8j" } }), local);
    expect(res.status).toBe(504);
    expect((await res.json()).error.message).toMatch(/timed out/);
  });
});

describe("rate limiting", () => {
  it("limits each IP separately and says when to retry", async () => {
    const handler = app({ rateLimitPerMinute: 2 });
    const ok1 = await handler(rpc("tools/list"), { ip: "1.1.1.1" });
    expect(ok1.status).toBe(200);
    expect(ok1.headers.get("ratelimit-remaining")).toBe("1");
    expect((await handler(rpc("tools/list"), { ip: "1.1.1.1" })).status).toBe(200);

    const limited = await handler(rpc("tools/list"), { ip: "1.1.1.1" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("access-control-allow-origin")).toBe("*"); // browsers can read the 429
    expect((await limited.json()).error.message).toMatch(/2 requests per minute/);

    expect((await handler(rpc("tools/list"), { ip: "2.2.2.2" })).status).toBe(200);
  });

  it("enforces the global daily cap", async () => {
    const handler = app({ dailyRequestLimit: 1 });
    expect((await handler(rpc("tools/list"), { ip: "1.1.1.1" })).status).toBe(200);
    const capped = await handler(rpc("tools/list"), { ip: "3.3.3.3" });
    expect(capped.status).toBe(429);
    expect((await capped.json()).error.message).toMatch(/daily request cap/);
  });

  it("does not rate limit the playground or health check", async () => {
    const handler = app({ rateLimitPerMinute: 1 });
    for (let i = 0; i < 5; i++) {
      expect((await handler(new Request("http://test.local/health"), local)).status).toBe(200);
      expect((await handler(new Request("http://test.local/"), local)).status).toBe(200);
    }
  });

  it("takes the client IP from X-Forwarded-For only behind trusted proxies", () => {
    const req = { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, socket: { remoteAddress: "10.0.0.2" } } as any;
    expect(clientIp(req, 0)).toBe("10.0.0.2");
    expect(clientIp(req, 1)).toBe("203.0.113.9"); // the spoofable left entry is ignored
    expect(clientIp(req, 5)).toBe("6.6.6.6");
    expect(clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.2" } } as any, 1)).toBe("10.0.0.2");
  });
});

describe("other routes", () => {
  it("GET /health reports status without calling Socrata", async () => {
    const m = mockFetch([]);
    const handler = createApp({ client: testClient(m.fetch, { appToken: "t" }), log: () => {} });
    const res = await handler(new Request("http://test.local/health"), local);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      name: "nyc-open-data",
      version: "0.2.0",
      transport: "streamable-http",
      endpoint: "/mcp",
      socrata_app_token: true,
      limits: { per_ip_per_minute: 30, daily_requests: 5000, daily_used: 0 },
    });
    expect(m.calls).toHaveLength(0);
    expect((await handler(new Request("http://test.local/health", { method: "POST" }), local)).status).toBe(405);
  });

  it("serves the playground with a strict CSP", async () => {
    const res = await app()(new Request("http://test.local/"), local);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    const html = await res.text();
    expect(html).toContain("<title>NYC Open Data MCP</title>");
    expect(html).toContain("NYC Open Data for your AI assistant");
  });

  it("serves the stylesheet and font the playground loads, and nothing else from public/", async () => {
    const handler = app();
    const css = await handler(new Request("http://test.local/austn-kit.css"), local);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    expect(await css.text()).toContain("font-family: \"Recursive\"");
    const font = await handler(new Request("http://test.local/fonts/recursive-latin.woff2"), local);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect((await handler(new Request("http://test.local/austn-kit.css", { method: "POST" }), local)).status).toBe(405);
    expect((await handler(new Request("http://test.local/fonts/other.woff2"), local)).status).toBe(404);
    expect((await handler(new Request("http://test.local/public/index.html"), local)).status).toBe(404);
  });

  it("404s unknown paths with a pointer to the right ones", async () => {
    const res = await app()(new Request("http://test.local/sse"), local);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/POST \/mcp/);
  });
});
