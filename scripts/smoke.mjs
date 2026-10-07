// Stdio smoke test: spawn the built server, speak raw JSON-RPC to it, and
// check that it initializes and lists the expected tools.
//
//   node scripts/smoke.mjs          # initialize + tools/list (no network)
//   node scripts/smoke.mjs --live   # also make one real tools/call to Socrata
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const live = process.argv.includes("--live");
const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000).unref();
  });
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  console.log("initialize ->", JSON.stringify(init.result.serverInfo), "protocol", init.result.protocolVersion);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await request("tools/list", {});
  const tools = list.result.tools;
  console.log(`tools/list -> ${tools.length} tools`);
  for (const t of tools) {
    const params = Object.keys(t.inputSchema.properties ?? {}).join(", ");
    console.log(`  - ${t.name}(${params})\n      ${t.description}`);
  }

  const expected = ["search_datasets", "query_dataset", "restaurant_inspections", "service_requests_311"];
  const missing = expected.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);

  if (live) {
    const res = await request("tools/call", {
      name: "restaurant_inspections",
      arguments: { name: "ramen", zip_code: "10003", limit: 3 },
    });
    console.log("live tools/call restaurant_inspections ->");
    console.log(res.result.content[0].text.slice(0, 1500));
    if (res.result.isError) throw new Error("live call returned isError");
  }

  console.log("SMOKE OK");
  child.kill();
} catch (err) {
  console.error("SMOKE FAILED:", err.message);
  child.kill();
  process.exit(1);
}
