import { z } from "zod";
import type { SocrataClient } from "../socrata.js";
import { ok, truncate } from "./common.js";

export const searchDatasetsInput = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Keywords, e.g. "restaurant inspections", "bike lanes", "rat sightings".'),
  category: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('Optional NYC Open Data category, e.g. "Health", "Transportation", "Housing & Development".'),
  limit: z.number().int().min(1).max(25).default(10).describe("Results per page (1-25, default 10)."),
  offset: z.number().int().min(0).max(10_000).default(0).describe("Pagination offset; pass next_offset from a previous call."),
  include_columns: z
    .boolean()
    .default(true)
    .describe("Include each dataset's column names and types (needed to write query_dataset filters)."),
};

export const searchDatasetsOutput = {
  total: z.number().describe("Total matching datasets."),
  offset: z.number(),
  returned: z.number(),
  next_offset: z.number().nullable().describe("Pass as offset for the next page; null when there are no more."),
  datasets: z.array(
    z.object({
      id: z.string().describe("Dataset id for query_dataset (xxxx-xxxx)."),
      name: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      updated_at: z.string().optional().describe("When the data was last updated (ISO 8601)."),
      url: z.string().optional(),
      columns: z.array(z.string()).optional().describe('"field_name:type" pairs.'),
    }),
  ),
  note: z.string().optional(),
};

type Args = { query: string; category?: string; limit: number; offset: number; include_columns: boolean };

export async function searchDatasets(client: SocrataClient, args: Args) {
  const res = await client.searchCatalog({ q: args.query, category: args.category, limit: args.limit, offset: args.offset });

  const datasets = res.results.map((r) => {
    const fields = r.resource.columns_field_name ?? [];
    const types = r.resource.columns_datatype ?? [];
    return {
      id: r.resource.id,
      name: r.resource.name,
      description: truncate(r.resource.description, 280),
      category: r.classification?.domain_category,
      updated_at: r.resource.data_updated_at ?? r.resource.updatedAt,
      url: r.permalink ?? r.link,
      ...(args.include_columns
        ? {
            columns: fields
              .map((f, i) => `${f}:${(types[i] ?? "unknown").toLowerCase()}`)
              // ":@computed_region_*" columns are Socrata internals, not useful to query.
              .filter((c) => !c.startsWith(":@")),
          }
        : {}),
    };
  });

  const nextOffset = args.offset + datasets.length;
  return ok({
    total: res.resultSetSize,
    offset: args.offset,
    returned: datasets.length,
    next_offset: datasets.length > 0 && nextOffset < res.resultSetSize ? nextOffset : null,
    datasets,
    ...(res.resultSetSize === 0
      ? { note: 'No datasets matched. The catalog matches all keywords, so try fewer or broader terms (e.g. "rodent" instead of "rat sightings").' }
      : {}),
  });
}

export const searchDatasetsDescription =
  "Search the NYC Open Data catalog (data.cityofnewyork.us) by keyword. Returns dataset ids, names, short descriptions, last-updated dates and column names. Use this first to find a dataset id and its columns before calling query_dataset.";
