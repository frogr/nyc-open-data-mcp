import { z } from "zod";
import { and, dayRange, isIsoDate, soqlContains, soqlIn, soqlString } from "../soql.js";
import type { SocrataClient } from "../socrata.js";
import { ToolInputError, addDays, ok, todayInNyc, truncate } from "./common.js";

export const SERVICE_REQUESTS_DATASET = "erm2-nwe9";

/** 311 has ~22.7M rows (count(*) on 2026-10-07); unbounded ranges make Socrata time out. */
export const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;

const BOROUGHS = ["MANHATTAN", "BROOKLYN", "QUEENS", "BRONX", "STATEN ISLAND"] as const;

const isoDate = z
  .string()
  .trim()
  .refine(isIsoDate, "must be a real date in YYYY-MM-DD format");

export const serviceRequests311Input = {
  zip_codes: z
    .array(z.string().trim().regex(/^\d{5}$/, "each ZIP code must be 5 digits"))
    .min(1)
    .max(10)
    .optional()
    .describe('One or more 5-digit ZIP codes. Neighborhoods span several, e.g. East Village = ["10003","10009"].'),
  borough: z
    .string()
    .trim()
    .transform((b) => b.toUpperCase())
    .pipe(z.enum(BOROUGHS))
    .optional()
    .describe("Borough: Manhattan, Brooklyn, Queens, Bronx or Staten Island."),
  complaint_type: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .optional()
    .describe('Complaint type contains (case-insensitive), e.g. "noise", "heat", "rodent", "illegal parking".'),
  start_date: isoDate.optional().describe(`Inclusive start date YYYY-MM-DD. Default: ${DEFAULT_RANGE_DAYS} days before end_date.`),
  end_date: isoDate.optional().describe("Inclusive end date YYYY-MM-DD. Default: today (New York time)."),
  top_n: z.number().int().min(1).max(50).default(10).describe("How many complaint types to rank (1-50, default 10)."),
  sample_size: z.number().int().min(0).max(25).default(5).describe("Most recent example requests to include (0-25, default 5)."),
};

export const serviceRequests311Output = {
  date_range: z.object({ start: z.string(), end: z.string() }),
  filters: z.object({
    zip_codes: z.array(z.string()).optional(),
    borough: z.string().optional(),
    complaint_type: z.string().optional(),
  }),
  total_requests: z.number(),
  top_complaint_types: z.array(z.object({ complaint_type: z.string(), count: z.number(), share: z.number().describe("Fraction of total_requests, 0-1.") })),
  other_types_count: z.number().describe("Requests not in the top_n types."),
  samples: z.array(
    z.object({
      unique_key: z.string(),
      created_date: z.string().optional(),
      complaint_type: z.string().optional(),
      descriptor: z.string().optional(),
      address: z.string().optional(),
      zip_code: z.string().optional(),
      status: z.string().optional(),
      agency: z.string().optional(),
      resolution: z.string().optional(),
    }),
  ),
  note: z.string().optional(),
};

type Args = {
  zip_codes?: string[];
  borough?: (typeof BOROUGHS)[number];
  complaint_type?: string;
  start_date?: string;
  end_date?: string;
  top_n: number;
  sample_size: number;
};

interface Row311 {
  unique_key: string;
  created_date?: string;
  complaint_type?: string;
  descriptor?: string;
  incident_address?: string;
  incident_zip?: string;
  status?: string;
  agency?: string;
  resolution_description?: string;
}

export function resolveDateRange(start?: string, end?: string, today = todayInNyc()): { start: string; end: string } {
  const e = end ?? (start ? addDays(start, DEFAULT_RANGE_DAYS) : today);
  const s = start ?? addDays(e, -DEFAULT_RANGE_DAYS);
  if (s > e) throw new ToolInputError(`start_date (${s}) is after end_date (${e}).`);
  const days = (Date.parse(e) - Date.parse(s)) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    throw new ToolInputError(
      `date range is ${days} days; the max is ${MAX_RANGE_DAYS} because the 311 dataset is very large. Split it into smaller ranges, or use query_dataset with a group-by.`,
    );
  }
  return { start: s, end: e };
}

export async function serviceRequests311(client: SocrataClient, args: Args, today?: string) {
  const range = resolveDateRange(args.start_date, args.end_date, today);

  const where = and(
    dayRange("created_date", range.start, range.end),
    args.zip_codes && (args.zip_codes.length === 1 ? `incident_zip = ${soqlString(args.zip_codes[0]!)}` : soqlIn("incident_zip", args.zip_codes)),
    args.borough && `borough = ${soqlString(args.borough)}`,
    args.complaint_type && soqlContains("complaint_type", args.complaint_type),
  );

  // Three small server-side queries instead of pulling raw rows: a total,
  // a grouped count, and a handful of recent examples.
  const [totalRows, countRows, sampleRows] = await Promise.all([
    client.query<{ count: string }>(SERVICE_REQUESTS_DATASET, { $select: "count(*) as count", $where: where }),
    client.query<{ complaint_type?: string; count: string }>(SERVICE_REQUESTS_DATASET, {
      $select: "complaint_type, count(*) as count",
      $where: where,
      $group: "complaint_type",
      $order: "count DESC, complaint_type",
      $limit: args.top_n,
    }),
    args.sample_size > 0
      ? client.query<Row311>(SERVICE_REQUESTS_DATASET, {
          $select: "unique_key, created_date, complaint_type, descriptor, incident_address, incident_zip, status, agency, resolution_description",
          $where: where,
          $order: "created_date DESC",
          $limit: args.sample_size,
        })
      : Promise.resolve([] as Row311[]),
  ]);

  const total = Number(totalRows[0]?.count ?? 0);
  const top = countRows.map((r) => {
    const count = Number(r.count);
    return { complaint_type: r.complaint_type ?? "(unspecified)", count, share: total ? Math.round((count / total) * 1000) / 1000 : 0 };
  });
  const topSum = top.reduce((s, t) => s + t.count, 0);

  return ok({
    date_range: range,
    filters: { zip_codes: args.zip_codes, borough: args.borough, complaint_type: args.complaint_type },
    total_requests: total,
    top_complaint_types: top,
    other_types_count: Math.max(total - topSum, 0),
    samples: sampleRows.map((r) => ({
      unique_key: r.unique_key,
      created_date: r.created_date,
      complaint_type: r.complaint_type,
      descriptor: r.descriptor,
      address: r.incident_address?.replace(/\s+/g, " "),
      zip_code: r.incident_zip,
      status: r.status,
      agency: r.agency,
      resolution: truncate(r.resolution_description, 200),
    })),
    ...(total === 0 ? { note: "No 311 requests matched. Widen the date range, check ZIP codes, or loosen complaint_type." } : {}),
  });
}

export const serviceRequests311Description = `Summarize NYC 311 service requests for an area and time window. Filter by ZIP codes, borough and/or complaint type (substring); dates default to the last ${DEFAULT_RANGE_DAYS} days (max range ${MAX_RANGE_DAYS} days). Returns the total, top complaint types with counts and share, and a few recent example requests.`;
