import { describe, expect, it } from "vitest";
import { SocrataClient, SocrataError } from "../src/socrata.js";
import { fixture, json, mockFetch } from "./helpers.js";

const anyUrl = () => true;

describe("SocrataClient", () => {
  it("sends the app token and URL-encodes SoQL params (no param smuggling)", async () => {
    const m = mockFetch([{ match: anyUrl, respond: () => json([]) }]);
    const client = new SocrataClient({ fetch: m.fetch, appToken: "tok123", cacheTtlMs: 0 });
    await client.query("43nn-pn8j", { $where: "dba = 'A&B' &$limit=50000", $limit: 10 });

    const { url, headers } = m.calls[0]!;
    expect(url.pathname).toBe("/resource/43nn-pn8j.json");
    expect(headers["X-App-Token"]).toBe("tok123");
    expect(url.searchParams.get("$where")).toBe("dba = 'A&B' &$limit=50000");
    expect(url.searchParams.get("$limit")).toBe("10");
    expect(url.searchParams.getAll("$limit")).toHaveLength(1);
  });

  it("omits the token header when none is configured", async () => {
    const m = mockFetch([{ match: anyUrl, respond: () => json([]) }]);
    await new SocrataClient({ fetch: m.fetch }).query("43nn-pn8j", {});
    expect(m.calls[0]!.headers["X-App-Token"]).toBeUndefined();
  });

  it("retries 429s, honoring Retry-After, then succeeds", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const m = mockFetch([
      { match: anyUrl, respond: () => (n++ === 0 ? json({ message: "slow down" }, 429, { "retry-after": "2" }) : json([{ ok: 1 }])) },
    ]);
    const client = new SocrataClient({ fetch: m.fetch, sleep: async (ms) => void sleeps.push(ms) });
    await expect(client.query("43nn-pn8j", {})).resolves.toEqual([{ ok: 1 }]);
    expect(m.calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up after maxRetries with a rate-limit hint mentioning the app token", async () => {
    const m = mockFetch([{ match: anyUrl, respond: () => json({}, 429) }]);
    const client = new SocrataClient({ fetch: m.fetch, maxRetries: 2, sleep: async () => {} });
    const err = await client.query("43nn-pn8j", {}).catch((e) => e);
    expect(err).toBeInstanceOf(SocrataError);
    expect(err.status).toBe(429);
    expect(err.toToolMessage()).toMatch(/SOCRATA_APP_TOKEN/);
    expect(m.calls).toHaveLength(3);
  });

  it("maps a malformed-SoQL 400 to an actionable error without retrying", async () => {
    const m = mockFetch([{ match: anyUrl, respond: () => json(fixture("error-malformed-query.json"), 400) }]);
    const err = await new SocrataClient({ fetch: m.fetch }).query("43nn-pn8j", { $where: "bogus =" }).catch((e) => e);
    expect(err).toBeInstanceOf(SocrataError);
    expect(err.code).toBe("query.compiler.malformed");
    expect(err.message).toMatch(/Could not parse SoQL/);
    expect(err.toToolMessage()).toMatch(/Hint: Check SoQL syntax/);
    expect(m.calls).toHaveLength(1);
  });

  it("maps a 404 to a dataset-not-found error pointing at search_datasets", async () => {
    const m = mockFetch([{ match: anyUrl, respond: () => json(fixture("error-dataset-missing.json"), 404) }]);
    const err = await new SocrataClient({ fetch: m.fetch }).query("zzzz-zzzz", {}).catch((e) => e);
    expect(err.message).toBe("Dataset 'zzzz-zzzz' was not found on data.cityofnewyork.us.");
    expect(err.hint).toMatch(/search_datasets/);
  });

  it("turns a timeout into a 'narrow your query' error and does not retry it", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const err = await new SocrataClient({ fetch, timeoutMs: 1500 }).query("erm2-nwe9", {}).catch((e) => e);
    expect(err).toBeInstanceOf(SocrataError);
    expect(err.code).toBe("timeout");
    expect(err.message).toMatch(/within 2s/);
    expect(err.hint).toMatch(/Narrow the query/);
    expect(calls).toBe(1);
  });

  it("retries transient network errors", async () => {
    let calls = 0;
    const fetch = async () => {
      if (calls++ === 0) throw new TypeError("fetch failed");
      return json([]);
    };
    await expect(new SocrataClient({ fetch, sleep: async () => {} }).query("43nn-pn8j", {})).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it("caches identical requests briefly", async () => {
    const m = mockFetch([{ match: anyUrl, respond: () => json([{ a: 1 }]) }]);
    const client = new SocrataClient({ fetch: m.fetch, cacheTtlMs: 60_000 });
    await client.query("43nn-pn8j", { $limit: 1 });
    await client.query("43nn-pn8j", { $limit: 1 });
    await client.query("43nn-pn8j", { $limit: 2 });
    expect(m.calls).toHaveLength(2);
  });

  it("scopes catalog searches to the NYC domain and datasets only", async () => {
    const m = mockFetch([{ match: anyUrl, respond: () => json(fixture("catalog-search.json")) }]);
    await new SocrataClient({ fetch: m.fetch }).searchCatalog({ q: "restaurant", limit: 2, offset: 0 });
    const url = m.calls[0]!.url;
    expect(url.host).toBe("api.us.socrata.com");
    expect(url.searchParams.get("domains")).toBe("data.cityofnewyork.us");
    expect(url.searchParams.get("only")).toBe("dataset");
    expect(url.searchParams.get("q")).toBe("restaurant");
  });
});
