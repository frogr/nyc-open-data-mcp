#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SocrataClient } from "./socrata.js";
import { createServer } from "./server.js";

async function main() {
  const client = new SocrataClient({
    appToken: process.env.SOCRATA_APP_TOKEN,
    timeoutMs: process.env.SOCRATA_TIMEOUT_MS ? Number(process.env.SOCRATA_TIMEOUT_MS) : undefined,
  });
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; logs go to stderr.
  console.error(`nyc-open-data-mcp running on stdio${process.env.SOCRATA_APP_TOKEN ? " (app token set)" : ""}`);
}

main().catch((err) => {
  console.error("nyc-open-data-mcp failed to start:", err);
  process.exit(1);
});
