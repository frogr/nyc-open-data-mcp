import { z } from "zod";
import { and, soqlContains, soqlIn, soqlString } from "../soql.js";
import type { SocrataClient } from "../socrata.js";
import { ToolInputError, ok, truncate } from "./common.js";

export const RESTAURANT_DATASET = "43nn-pn8j";

const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"] as const;

const GRADE_MEANINGS: Record<string, string> = {
  A: "A (0-13 points)",
  B: "B (14-27 points)",
  C: "C (28+ points)",
  N: "Not yet graded",
  Z: "Grade pending",
  P: "Grade pending (re-opening after closure)",
};

export const restaurantInspectionsInput = {
  name: z.string().trim().min(2).max(100).optional().describe('Restaurant name or part of it, case-insensitive, e.g. "ramen" or "Joe\'s Pizza".'),
  zip_code: z.string().trim().regex(/^\d{5}$/, "zip_code must be 5 digits").optional().describe("5-digit NYC ZIP code, e.g. 10003."),
  borough: z.enum(BOROUGHS).optional().describe("Borough name."),
  cuisine: z.string().trim().min(2).max(60).optional().describe('Cuisine contains, e.g. "Japanese", "Pizza", "Thai".'),
  limit: z.number().int().min(1).max(50).default(10).describe("Restaurants per page (1-50, default 10)."),
  offset: z.number().int().min(0).max(100_000).default(0).describe("Pagination offset; pass next_offset from a previous call."),
};

const violationSchema = z.object({ code: z.string(), description: z.string().optional(), critical: z.boolean() });

export const restaurantInspectionsOutput = {
  returned: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  restaurants: z.array(
    z.object({
      camis: z.string().describe("Permanent restaurant id."),
      name: z.string(),
      address: z.string(),
      borough: z.string().optional(),
      zip_code: z.string().optional(),
      cuisine: z.string().optional(),
      status: z.enum(["inspected", "not_yet_inspected"]),
      latest_grade: z.string().nullable().describe("Most recent letter grade on record (A/B/C, or N/Z/P)."),
      latest_grade_meaning: z.string().nullable(),
      latest_grade_date: z.string().nullable(),
      latest_inspection: z
        .object({
          date: z.string(),
          type: z.string().optional(),
          score: z.number().nullable().describe("Violation points; lower is better."),
          action: z.string().optional(),
          violation_count: z.number(),
          critical_violation_count: z.number(),
          violations: z.array(violationSchema),
        })
        .nullable(),
    }),
  ),
  note: z.string().optional(),
};

type Args = { name?: string; zip_code?: string; borough?: (typeof BOROUGHS)[number]; cuisine?: string; limit: number; offset: number };

interface InspectionRow {
  camis: string;
  dba?: string;
  boro?: string;
  building?: string;
  street?: string;
  zipcode?: string;
  cuisine_description?: string;
  inspection_date?: string;
  inspection_type?: string;
  action?: string;
  violation_code?: string;
  violation_description?: string;
  critical_flag?: string;
  score?: string;
  grade?: string;
  grade_date?: string;
}

/** Restaurants with no inspection yet carry this placeholder date. */
const NEVER_INSPECTED = "1900-01-01";

export async function restaurantInspections(client: SocrataClient, args: Args) {
  if (!args.name && !args.zip_code && !args.borough && !args.cuisine) {
    throw new ToolInputError("provide at least one of name, zip_code, borough or cuisine (the dataset has ~30k restaurants).");
  }

  const where = and(
    args.name && soqlContains("dba", args.name),
    args.zip_code && `zipcode = ${soqlString(args.zip_code)}`,
    args.borough && `boro = ${soqlString(args.borough)}`,
    args.cuisine && soqlContains("cuisine_description", args.cuisine),
  );

  // Step 1: one row per restaurant (the raw dataset has one row per violation),
  // ordered by most recently inspected. This is what we paginate over.
  const idCols = "camis, dba, boro, building, street, zipcode, cuisine_description";
  const restaurantsPage = await client.query<InspectionRow & { last_inspection_date?: string }>(RESTAURANT_DATASET, {
    $select: `${idCols}, max(inspection_date) as last_inspection_date`,
    $where: where,
    $group: idCols,
    $order: "last_inspection_date DESC, camis",
    $limit: args.limit + 1,
    $offset: args.offset,
  });

  const hasMore = restaurantsPage.length > args.limit;
  const seen = new Set<string>();
  const restaurants = restaurantsPage.slice(0, args.limit).filter((r) => !seen.has(r.camis) && seen.add(r.camis));

  if (restaurants.length === 0) {
    return ok({
      returned: 0,
      has_more: false,
      next_offset: null,
      restaurants: [],
      note: "No restaurants matched. Try a shorter name fragment, drop a filter, or check the ZIP code.",
    });
  }

  // Step 2: full inspection history for just those restaurants, newest first.
  const history = await client.query<InspectionRow>(RESTAURANT_DATASET, {
    $select: "camis, inspection_date, inspection_type, action, violation_code, violation_description, critical_flag, score, grade, grade_date",
    $where: soqlIn("camis", restaurants.map((r) => r.camis)),
    $order: "inspection_date DESC, grade_date DESC",
    $limit: 5000,
  });

  const byCamis = new Map<string, InspectionRow[]>();
  for (const row of history) {
    const list = byCamis.get(row.camis) ?? [];
    list.push(row);
    byCamis.set(row.camis, list);
  }

  const results = restaurants.map((r) => summarize(r, byCamis.get(r.camis) ?? []));

  return ok({
    returned: results.length,
    has_more: hasMore,
    next_offset: hasMore ? args.offset + args.limit : null,
    restaurants: results,
  });
}

function summarize(r: InspectionRow, rows: InspectionRow[]) {
  const base = {
    camis: r.camis,
    name: r.dba ?? "(unnamed)",
    address: [r.building, r.street?.replace(/\s+/g, " ")].filter(Boolean).join(" "),
    borough: r.boro,
    zip_code: r.zipcode,
    cuisine: r.cuisine_description,
  };

  const latestDate = rows[0]?.inspection_date;
  if (!latestDate || latestDate.startsWith(NEVER_INSPECTED)) {
    return { ...base, status: "not_yet_inspected" as const, latest_grade: null, latest_grade_meaning: null, latest_grade_date: null, latest_inspection: null };
  }

  const graded = rows.find((row) => row.grade);
  const latestRows = rows.filter((row) => row.inspection_date === latestDate);
  const violations = dedupeViolations(latestRows);
  const scoreRow = latestRows.find((row) => row.score !== undefined);

  return {
    ...base,
    status: "inspected" as const,
    latest_grade: graded?.grade ?? null,
    latest_grade_meaning: graded?.grade ? GRADE_MEANINGS[graded.grade] ?? graded.grade : null,
    latest_grade_date: day(graded?.grade_date ?? graded?.inspection_date),
    latest_inspection: {
      date: day(latestDate)!,
      type: latestRows[0]?.inspection_type,
      score: scoreRow?.score !== undefined ? Number(scoreRow.score) : null,
      action: latestRows[0]?.action,
      violation_count: violations.length,
      critical_violation_count: violations.filter((v) => v.critical).length,
      violations,
    },
  };
}

function dedupeViolations(rows: InspectionRow[]) {
  const out = new Map<string, z.infer<typeof violationSchema>>();
  for (const row of rows) {
    if (!row.violation_code || out.has(row.violation_code)) continue;
    out.set(row.violation_code, {
      code: row.violation_code,
      description: truncate(row.violation_description, 160),
      critical: row.critical_flag === "Critical",
    });
  }
  return [...out.values()];
}

function day(ts: string | undefined): string | null {
  return ts ? ts.slice(0, 10) : null;
}

export const restaurantInspectionsDescription =
  "Look up NYC restaurant health inspections (DOHMH). Filter by name fragment, ZIP code, borough and/or cuisine (at least one). Returns each restaurant's latest letter grade, latest inspection date, score and a violations summary. Paginated, most recently inspected first.";
