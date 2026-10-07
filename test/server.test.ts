// End-to-end through the real MCP protocol layer (in-memory transport):
// tool listing, SDK-side zod validation, outputSchema validation, error mapping.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { fixture, json, mockFetch, param, testClient } from "./helpers.js";

async function connect(fetch: ReturnType<typeof mockFetch>["fetch"]) {
  const server = createServer(testClient(fetch));
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: any) => r.content[0].text as string;

describe("MCP server", () => {
  it("lists the four read-only tools with input and output schemas", async () => {
    const client = await connect(mockFetch([]).fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["query_dataset", "restaurant_inspections", "search_datasets", "service_requests_311"]);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema).toBeDefined();
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    const query = tools.find((t) => t.name === "query_dataset")!;
    expect(query.inputSchema.required).toEqual(["dataset_id"]);
    expect((query.inputSchema.properties as any).limit).toMatchObject({ maximum: 500, default: 100 });
  });

  it("returns text + structuredContent for a successful call", async () => {
    const m = mockFetch([
      { match: param("$select", (s) => s.includes("max(inspection_date)")), respond: () => json(fixture("restaurants-summary.json")) },
      { match: param("$where", (s) => s.startsWith("camis in")), respond: () => json(fixture("restaurants-history.json")) },
    ]);
    const client = await connect(m.fetch);
    const res: any = await client.callTool({ name: "restaurant_inspections", arguments: { name: "ramen", zip_code: "10003" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.restaurants[0].latest_grade).toBe("A");
    expect(JSON.parse(text(res))).toEqual(res.structuredContent);
  });

  it("rejects invalid input before any HTTP request", async () => {
    const m = mockFetch([]);
    const client = await connect(m.fetch);

    const badId: any = await client.callTool({ name: "query_dataset", arguments: { dataset_id: "restaurants; drop" } });
    expect(badId.isError).toBe(true);
    expect(text(badId)).toMatch(/xxxx-xxxx/);

    const tooMany: any = await client.callTool({ name: "query_dataset", arguments: { dataset_id: "43nn-pn8j", limit: 5000 } });
    expect(tooMany.isError).toBe(true);
    expect(text(tooMany)).toMatch(/limit/);

    const badZip: any = await client.callTool({ name: "service_requests_311", arguments: { zip_codes: ["1000"] } });
    expect(badZip.isError).toBe(true);
    expect(text(badZip)).toMatch(/5 digits/);

    const noFilter: any = await client.callTool({ name: "restaurant_inspections", arguments: {} });
    expect(noFilter.isError).toBe(true);
    expect(text(noFilter)).toMatch(/at least one of name, zip_code, borough or cuisine/);

    expect(m.calls).toHaveLength(0);
  });

  it("normalizes friendly input (borough casing, dataset id casing)", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json([]) }]);
    const client = await connect(m.fetch);
    await client.callTool({ name: "service_requests_311", arguments: { borough: "Staten Island", sample_size: 0 } });
    expect(m.calls[0]!.url.searchParams.get("$where")).toContain("borough = 'STATEN ISLAND'");
    await client.callTool({ name: "query_dataset", arguments: { dataset_id: "43NN-PN8J" } });
    expect(m.calls.at(-1)!.url.pathname).toBe("/resource/43nn-pn8j.json");
  });

  it("surfaces upstream errors as readable tool errors", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json(fixture("error-dataset-missing.json"), 404) }]);
    const client = await connect(m.fetch);
    const res: any = await client.callTool({ name: "query_dataset", arguments: { dataset_id: "zzzz-zzzz" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(
      "Dataset 'zzzz-zzzz' was not found on data.cityofnewyork.us. (HTTP 404, dataset.missing)\nHint: Use search_datasets to find a valid dataset id (format: xxxx-xxxx).",
    );
  });
});
