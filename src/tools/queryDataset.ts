import { z } from "zod";
import { DATASET_ID_PATTERN } from "../soql.js";
import type { SocrataClient, SoqlParams } from "../socrata.js";
import { fitRows, ok } from "./common.js";

export const MAX_QUERY_LIMIT = 500;

const clause = (desc: string) => z.string().trim().min(1).max(2000).optional().describe(desc);

export const queryDatasetInput = {
  dataset_id: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DATASET_ID_PATTERN, "dataset_id must look like 'xxxx-xxxx' (e.g. 43nn-pn8j). Use search_datasets to find one.")
    .describe("Socrata dataset id, e.g. 43nn-pn8j (restaurant inspections) or erm2-nwe9 (311)."),
  select: clause("SoQL $select, e.g. \"borough, count(*) as n\". Default: all columns."),
  where: clause("SoQL $where, e.g. \"zipcode = '10003' AND grade = 'A'\". Single-quote string literals; double any quote inside ('O''Brien')."),
  order: clause('SoQL $order, e.g. "inspection_date DESC".'),
  group: clause("SoQL $group, required when $select mixes aggregates and plain columns."),
  q: z.string().trim().min(1).max(200).optional().describe("Full-text search across all text columns."),
  limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(100).describe(`Rows to return (1-${MAX_QUERY_LIMIT}, default 100).`),
  offset: z.number().int().min(0).max(1_000_000).default(0).describe("Rows to skip; pass next_offset from a previous call to page. Use a stable order when paging."),
};

export const queryDatasetOutput = {
  dataset_id: z.string(),
  offset: z.number(),
  returned: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  rows: z.array(z.record(z.string(), z.unknown())),
  note: z.string().optional(),
};

type Args = {
  dataset_id: string;
  select?: string;
  where?: string;
  order?: string;
  group?: string;
  q?: string;
  limit: number;
  offset: number;
};

export async function queryDataset(client: SocrataClient, args: Args) {
  const params: SoqlParams = {
    $select: args.select,
    $where: args.where,
    $order: args.order,
    $group: args.group,
    $q: args.q,
    // Ask for one extra row so we know for certain whether another page exists.
    $limit: args.limit + 1,
    $offset: args.offset,
  };
  const fetched = await client.query(args.dataset_id, params);

  const hasMore = fetched.length > args.limit;
  const page = hasMore ? fetched.slice(0, args.limit) : fetched;
  const { rows, dropped } = fitRows(page);

  const notes: string[] = [];
  if (dropped > 0) {
    notes.push(`Output trimmed to ${rows.length} of ${page.length} rows to fit the response size budget; use a narrower select or smaller limit.`);
  }
  if (hasMore || dropped > 0) {
    notes.push(`More rows are available: call again with offset=${args.offset + rows.length}.`);
    if (!args.order) notes.push("Tip: set an explicit order (e.g. ':id') so pages are stable.");
  }

  const more = hasMore || dropped > 0;
  return ok({
    dataset_id: args.dataset_id,
    offset: args.offset,
    returned: rows.length,
    has_more: more,
    next_offset: more ? args.offset + rows.length : null,
    rows,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  });
}

export const queryDatasetDescription = `Run a read-only SoQL query against any NYC Open Data dataset by id. Supports select / where / order / group / full-text q, with limit (max ${MAX_QUERY_LIMIT}) and offset paging; the response says when more rows exist. Get the dataset id and column names from search_datasets first. For counts, prefer select="count(*)" or a group-by over pulling raw rows.`;
