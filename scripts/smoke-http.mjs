// HTTP smoke test: start the built remote server, then speak raw JSON-RPC
// to POST /mcp the way a remote MCP client would.
//
//   node scripts/smoke-http.mjs          # /health, initialize, tools/list, CORS (no network)
//   node scripts/smoke-http.mjs --live   # also make real tools/calls to Socrata
import { spawn } from "node:child_process";

const live = process.argv.includes("--live");
const port = 4600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [new URL("../dist/http.js", import.meta.url).pathname], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "inherit", "inherit"],
});

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: HTTP ${res.status} ${body.error.message}`);
  return { status: res.status, result: body.result };
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

try {
  const health = await waitForHealth();
  console.log("GET /health ->", JSON.stringify(health));

  const pre = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "http://localhost:6274", "Access-Control-Request-Method": "POST" } });
  console.log(`OPTIONS /mcp -> ${pre.status}, allow-origin: ${pre.headers.get("access-control-allow-origin")}`);

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-http", version: "0.0.0" } });
  console.log(`POST /mcp initialize -> ${init.status}`, JSON.stringify(init.result.serverInfo), "protocol", init.result.protocolVersion);

  const list = await rpc("tools/list", {});
  console.log(`POST /mcp tools/list -> ${list.result.tools.length} tools: ${list.result.tools.map((t) => t.name).join(", ")}`);

  const page = await fetch(`${base}/`);
  const html = await page.text();
  console.log(`GET / -> ${page.status}, ${html.length} bytes, title: ${html.match(/<title>(.*?)<\/title>/)?.[1]}`);

  if (live) {
    const calls = [
      ["restaurant_inspections", { name: "ramen", zip_code: "10003", limit: 3 }],
      ["service_requests_311", { zip_codes: ["10003", "10009"], top_n: 5, sample_size: 0 }],
    ];
    for (const [name, args] of calls) {
      const t0 = Date.now();
      const { result } = await rpc("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
      console.log(`live tools/call ${name} (${Date.now() - t0} ms) ->`);
      console.log(result.content[0].text.slice(0, 1200));
    }
  }

  console.log("HTTP SMOKE OK");
} catch (err) {
  console.error("HTTP SMOKE FAILED:", err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
