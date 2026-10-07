import { describe, expect, it } from "vitest";
import { queryDataset } from "../src/tools/queryDataset.js";
import { restaurantInspections } from "../src/tools/restaurantInspections.js";
import { searchDatasets } from "../src/tools/searchDatasets.js";
import { resolveDateRange, serviceRequests311 } from "../src/tools/serviceRequests311.js";
import { ToolInputError } from "../src/tools/common.js";
import { data, fixture, json, mockFetch, param, testClient } from "./helpers.js";

describe("search_datasets", () => {
  it("maps catalog results to compact dataset summaries with pagination", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json(fixture("catalog-search.json")) }]);
    const out = data(await searchDatasets(testClient(m.fetch), { query: "restaurant", limit: 2, offset: 0, include_columns: true }));

    expect(out.total).toBe(4);
    expect(out.returned).toBe(2);
    expect(out.next_offset).toBe(2);
    const [first, second] = out.datasets;
    expect(first).toMatchObject({
      id: "43nn-pn8j",
      name: "DOHMH New York City Restaurant Inspection Results",
      category: "Health",
      updated_at: "2026-10-06T22:05:45.000Z",
      url: "https://data.cityofnewyork.us/d/43nn-pn8j",
    });
    expect(first.description.length).toBeLessThanOrEqual(280);
    expect(first.description.endsWith("…")).toBe(true);
    expect(first.columns).toContain("inspection_date:calendar date");
    expect(first.columns.some((c: string) => c.startsWith(":@"))).toBe(false);
    expect(second.description).not.toMatch(/[\r\n]/);
  });

  it("returns next_offset null on the last page and can omit columns", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json(fixture("catalog-search.json")) }]);
    const out = data(await searchDatasets(testClient(m.fetch), { query: "restaurant", limit: 2, offset: 2, include_columns: false }));
    expect(out.next_offset).toBeNull();
    expect(out.datasets[0].columns).toBeUndefined();
  });

  it("explains how to broaden a zero-result search", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json({ results: [], resultSetSize: 0 }) }]);
    const out = data(await searchDatasets(testClient(m.fetch), { query: "rat sightings", limit: 10, offset: 0, include_columns: true }));
    expect(out.note).toMatch(/fewer or broader/);
  });
});

describe("query_dataset", () => {
  it("requests limit+1 rows and reports has_more / next_offset", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json(fixture("query-rows.json")) }]);
    const out = data(
      await queryDataset(testClient(m.fetch), {
        dataset_id: "43nn-pn8j",
        select: "boro, count(*) as n",
        group: "boro",
        order: "n DESC",
        limit: 3,
        offset: 0,
      }),
    );
    const sent = m.calls[0]!.url.searchParams;
    expect(sent.get("$limit")).toBe("4");
    expect(sent.get("$group")).toBe("boro");
    expect(out.returned).toBe(3);
    expect(out.has_more).toBe(true);
    expect(out.next_offset).toBe(3);
    expect(out.note).toMatch(/offset=3/);
  });

  it("has no note when everything fit", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json(fixture("query-rows.json")) }]);
    const out = data(await queryDataset(testClient(m.fetch), { dataset_id: "43nn-pn8j", limit: 10, offset: 0 }));
    expect(out).toMatchObject({ returned: 4, has_more: false, next_offset: null });
    expect(out.note).toBeUndefined();
  });

  it("trims oversized pages to protect the model's context", async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ id: i, blob: "x".repeat(5_000) }));
    const m = mockFetch([{ match: () => true, respond: () => json(big) }]);
    const out = data(await queryDataset(testClient(m.fetch), { dataset_id: "abcd-1234", order: ":id", limit: 50, offset: 100 }));
    expect(out.returned).toBeLessThan(50);
    expect(out.has_more).toBe(true);
    expect(out.next_offset).toBe(100 + out.returned);
    expect(out.note).toMatch(/trimmed/);
  });
});

describe("restaurant_inspections", () => {
  const routes = () =>
    mockFetch([
      { match: param("$select", (s) => s.includes("max(inspection_date)")), respond: () => json(fixture("restaurants-summary.json")) },
      { match: param("$where", (s) => s.startsWith("camis in")), respond: () => json(fixture("restaurants-history.json")) },
    ]);

  it("summarizes latest grade, inspection and violations per restaurant", async () => {
    const m = routes();
    const out = data(await restaurantInspections(testClient(m.fetch), { name: "ramen", zip_code: "10003", limit: 2, offset: 0 }));

    expect(out.returned).toBe(2);
    expect(out.has_more).toBe(true);
    expect(out.next_offset).toBe(2);

    const [tompkins, joes] = out.restaurants;
    expect(tompkins).toMatchObject({
      name: "TOMPKINS RAMEN HOUSE",
      address: "141 AVENUE A",
      status: "inspected",
      latest_grade: "A",
      latest_grade_date: "2026-09-18",
      latest_inspection: { date: "2026-09-18", score: 9, violation_count: 2, critical_violation_count: 1 },
    });

    // Duplicate violation rows are collapsed; grade pending is explained.
    expect(joes).toMatchObject({
      name: "JOE'S RAMEN & DUMPLING",
      address: "84 EAST 7 STREET",
      latest_grade: "Z",
      latest_grade_meaning: "Grade pending",
      latest_inspection: { date: "2026-08-27", score: 31, violation_count: 3, critical_violation_count: 2 },
    });
    expect(joes.latest_inspection.violations.map((v: { code: string }) => v.code)).toEqual(["04L", "06C", "10B"]);
  });

  it("builds escaped SoQL filters and fetches history only for the current page", async () => {
    const m = routes();
    await restaurantInspections(testClient(m.fetch), { name: "Joe's", borough: "Manhattan", limit: 2, offset: 0 });

    const summaryWhere = m.calls[0]!.url.searchParams.get("$where");
    expect(summaryWhere).toBe("(upper(dba) like '%JOE''S%') AND (boro = 'Manhattan')");
    expect(m.calls[0]!.url.searchParams.get("$limit")).toBe("3");

    const historyWhere = m.calls[1]!.url.searchParams.get("$where");
    expect(historyWhere).toBe("camis in ('50140012', '41720398')");
  });

  it("marks restaurants that have not been inspected yet", async () => {
    const m = routes();
    const out = data(await restaurantInspections(testClient(m.fetch), { zip_code: "10003", limit: 10, offset: 0 }));
    const lab = out.restaurants.find((r: { name: string }) => r.name === "SAINT MARKS RAMEN LAB");
    expect(lab).toMatchObject({ status: "not_yet_inspected", latest_grade: null, latest_inspection: null });
    expect(out.has_more).toBe(false);
  });

  it("skips the history call and explains when nothing matches", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json([]) }]);
    const out = data(await restaurantInspections(testClient(m.fetch), { name: "zzzz", limit: 10, offset: 0 }));
    expect(out.restaurants).toEqual([]);
    expect(out.note).toMatch(/No restaurants matched/);
    expect(m.calls).toHaveLength(1);
  });

  it("requires at least one filter", async () => {
    const m = mockFetch([]);
    await expect(restaurantInspections(testClient(m.fetch), { limit: 10, offset: 0 })).rejects.toBeInstanceOf(ToolInputError);
    expect(m.calls).toHaveLength(0);
  });
});

describe("service_requests_311", () => {
  const routes = () =>
    mockFetch([
      { match: param("$select", (s) => s === "count(*) as count"), respond: () => json(fixture("311-total.json")) },
      { match: param("$group", (s) => s === "complaint_type"), respond: () => json(fixture("311-counts.json")) },
      { match: param("$order", (s) => s === "created_date DESC"), respond: () => json(fixture("311-samples.json")) },
    ]);

  it("returns totals, ranked complaint types with share, and samples", async () => {
    const m = routes();
    const out = data(
      await serviceRequests311(testClient(m.fetch), {
        zip_codes: ["10003", "10009"],
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        top_n: 5,
        sample_size: 2,
      }),
    );

    expect(out.date_range).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(out.total_requests).toBe(4823);
    expect(out.top_complaint_types[0]).toEqual({ complaint_type: "Encampment", count: 746, share: 0.155 });
    expect(out.other_types_count).toBe(4823 - (746 + 472 + 359 + 267 + 245));
    expect(out.samples[0]).toMatchObject({ unique_key: "70600571", address: "330 EAST 4 STREET", zip_code: "10009" });
    expect(out.samples[1].resolution).toBeUndefined();

    const where = m.calls[0]!.url.searchParams.get("$where");
    expect(where).toBe(
      "(created_date between '2026-09-01T00:00:00' and '2026-09-30T23:59:59.999') AND (incident_zip in ('10003', '10009'))",
    );
  });

  it("escapes complaint_type and skips the sample query when sample_size is 0", async () => {
    const m = routes();
    await serviceRequests311(
      testClient(m.fetch),
      { borough: "BROOKLYN", complaint_type: "noise' OR '1'='1", top_n: 3, sample_size: 0 },
      "2026-10-07",
    );
    expect(m.calls).toHaveLength(2);
    const where = m.calls[0]!.url.searchParams.get("$where");
    expect(where).toContain("(borough = 'BROOKLYN')");
    expect(where).toContain("(upper(complaint_type) like '%NOISE'' OR ''1''=''1%')");
    expect(where).toContain("'2026-09-07T00:00:00' and '2026-10-07T23:59:59.999'");
  });

  it("defaults to the last 30 days and validates ranges", () => {
    expect(resolveDateRange(undefined, undefined, "2026-10-07")).toEqual({ start: "2026-09-07", end: "2026-10-07" });
    expect(resolveDateRange("2026-01-01", undefined, "2026-10-07")).toEqual({ start: "2026-01-01", end: "2026-01-31" });
    expect(() => resolveDateRange("2026-10-01", "2026-09-01")).toThrow(/after end_date/);
    expect(() => resolveDateRange("2024-01-01", "2026-01-01")).toThrow(/max is 366/);
  });

  it("explains an empty result", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json([]) }]);
    const out = data(await serviceRequests311(testClient(m.fetch), { zip_codes: ["10004"], top_n: 5, sample_size: 1 }, "2026-10-07"));
    expect(out.total_requests).toBe(0);
    expect(out.note).toMatch(/No 311 requests matched/);
  });
});
