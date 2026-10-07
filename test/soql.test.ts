import { describe, expect, it } from "vitest";
import { and, dayRange, escapeSoqlString, isIsoDate, soqlContains, soqlIn, soqlString } from "../src/soql.js";

describe("SoQL string escaping", () => {
  it("doubles single quotes", () => {
    expect(escapeSoqlString("Joe's")).toBe("Joe''s");
    expect(soqlString("O'Brien's")).toBe("'O''Brien''s'");
  });

  it("neutralizes a quote-breaking injection attempt", () => {
    const evil = "x' OR '1'='1";
    const lit = soqlString(evil);
    expect(lit).toBe("'x'' OR ''1''=''1'");
    // Every quote inside the literal is doubled, so the literal never terminates early:
    // stripping the outer quotes and all doubled pairs leaves no stray quote.
    expect(lit.slice(1, -1).replace(/''/g, "")).not.toContain("'");
  });

  it("leaves strings without quotes untouched", () => {
    expect(soqlString("10003")).toBe("'10003'");
  });

  it("builds a case-insensitive contains and treats LIKE wildcards literally", () => {
    expect(soqlContains("dba", "joe's")).toBe("upper(dba) like '%JOE''S%'");
    expect(soqlContains("dba", "100%_ramen")).toBe("upper(dba) like '%100  RAMEN%'");
  });

  it("escapes every value in an IN list", () => {
    expect(soqlIn("camis", ["1", "2'3"])).toBe("camis in ('1', '2''3')");
  });

  it("joins predicates with AND and skips empties", () => {
    expect(and("a = 1", undefined, false, "b = 2")).toBe("(a = 1) AND (b = 2)");
    expect(and("a = 1")).toBe("a = 1");
    expect(and(undefined)).toBeUndefined();
  });
});

describe("dates", () => {
  it("validates real calendar dates", () => {
    expect(isIsoDate("2026-09-30")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("09/30/2026")).toBe(false);
    expect(isIsoDate("2026-09-30' OR '1'='1")).toBe(false);
  });

  it("builds an inclusive day range", () => {
    expect(dayRange("created_date", "2026-09-01", "2026-09-30")).toBe(
      "created_date between '2026-09-01T00:00:00' and '2026-09-30T23:59:59.999'",
    );
  });
});
