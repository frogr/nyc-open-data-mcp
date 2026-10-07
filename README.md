# nyc-open-data-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude, Cursor, or any MCP client read-only access to [NYC Open Data](https://opendata.cityofnewyork.us/): 2,400+ city datasets served through the Socrata SODA API. It includes two ready-made tools for the questions people ask most (restaurant health grades and 311 complaints) and two general tools that let the model find and query any other dataset. Inputs are validated, every value placed in a query is escaped, results are paginated and capped in size, upstream errors come back as plain-language hints the model can act on, and the whole thing installs with one line. No API key is required.

## What you can ask

> Which ramen spots in 10003 have an A grade?

> What were the top 311 complaints in the East Village last month?

> Are there any restaurants on St. Marks Place with critical violations in their latest inspection?

> Find the dataset for NYC street tree census and tell me the most common species in Brooklyn.

> How did noise complaints in 11211 change between June and August?

## Install

Requires Node.js 20 or newer.

### Claude Desktop

Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "nyc-open-data": {
      "command": "npx",
      "args": ["-y", "nyc-open-data-mcp"],
      "env": {
        "SOCRATA_APP_TOKEN": "optional-but-recommended"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio nyc-open-data -- npx -y nyc-open-data-mcp

# with an app token, available in every project:
claude mcp add --env SOCRATA_APP_TOKEN=your-token --transport stdio --scope user nyc-open-data -- npx -y nyc-open-data-mcp
```

### Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (this project):

```json
{
  "mcpServers": {
    "nyc-open-data": {
      "command": "npx",
      "args": ["-y", "nyc-open-data-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/frogr/nyc-open-data-mcp && cd nyc-open-data-mcp
npm install && npm run build
# then use "command": "node", "args": ["/absolute/path/to/nyc-open-data-mcp/dist/index.js"]
```

### Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `SOCRATA_APP_TOKEN` | none | Free [Socrata app token](https://data.cityofnewyork.us/profile/edit/developer_settings). Unauthenticated requests share a small IP-based rate limit; a token raises it a lot. |
| `SOCRATA_TIMEOUT_MS` | `20000` | Per-request timeout. |

## Tools

| Tool | What it does | Key inputs | Returns |
| --- | --- | --- | --- |
| `restaurant_inspections` | DOHMH restaurant grades ([43nn-pn8j](https://data.cityofnewyork.us/d/43nn-pn8j)) | `name`, `zip_code`, `borough`, `cuisine` (at least one), `limit` ≤ 50, `offset` | Per restaurant: latest grade and what it means, latest inspection date, type, score, and deduplicated violations with critical flags |
| `service_requests_311` | 311 complaint summary ([erm2-nwe9](https://data.cityofnewyork.us/d/erm2-nwe9)) | `zip_codes[]` (≤ 10), `borough`, `complaint_type` (substring), `start_date`, `end_date` (default: last 30 days, max 366), `top_n`, `sample_size` | Total requests, top complaint types with counts and share, remainder count, most recent example requests |
| `search_datasets` | Search the NYC catalog | `query`, `category`, `limit` ≤ 25, `offset`, `include_columns` | Dataset id, name, short description, category, last-updated date, URL, `field:type` column list |
| `query_dataset` | Read-only SoQL against any dataset | `dataset_id`, `select`, `where`, `order`, `group`, `q`, `limit` ≤ 500, `offset` | Rows, `has_more`, `next_offset`, and a note when the results were cut off |

Every tool is marked `readOnlyHint: true` and declares an `outputSchema`. Results come back as JSON text, which works in any client, and as `structuredContent` for clients that use it.

## Design notes

**Why these four tools.** The two specific tools cover the questions people actually ask, and they do the awkward parts on the server. The restaurant dataset stores one row per violation, so the tool first groups by restaurant to page through restaurants, then fetches the history for only that page and works out the latest grade. That grade isn't always from the latest inspection: a re-inspection can leave a grade pending. The 311 dataset has about 40M rows, so the tool runs three small aggregate queries (total, group-by, recent samples) on Socrata's side instead of downloading rows. The two general tools are the fallback for everything else, and `search_datasets` returns column names so the model can write a valid `where` clause on its first try.

**Pagination.** Every list result includes `next_offset`, which is `null` on the last page. `query_dataset` fetches `limit + 1` rows so `has_more` is exact rather than guessed.

**Limits.** `query_dataset` caps `limit` at 500 rows. Each response is also capped at about 60 KB of JSON; when that cap removes rows, the response says so and gives the offset to continue from. 311 date ranges max out at 366 days so queries don't time out upstream. Long descriptions are shortened.

**Safety.**
- Every user value that goes into SoQL (names, ZIPs, complaint types, dates, ids) is passed through `soqlString()`, which doubles single quotes, so `x' OR '1'='1` stays an ordinary string. In "contains" searches, the LIKE wildcards `%` and `_` are removed from user input.
- Dataset ids must match `xxxx-xxxx`. ZIP codes must be 5 digits. Dates must be real `YYYY-MM-DD` dates. Boroughs come from a fixed list.
- Parameters are encoded with `URLSearchParams`, so a `&` inside a clause can't add extra query parameters.
- `query_dataset` passes SoQL clauses through as written, which is the point of that tool. That's safe because the Socrata endpoint is read-only public data and the tool can only send GET requests to `/resource/{id}.json`.

**Rate limits and reliability.**
- Every request has a timeout.
- 429 and 5xx responses are retried up to 2 times with exponential backoff, following `Retry-After` up to 5 seconds.
- Identical requests are cached in memory for 60 seconds, so an agent that asks the same thing again doesn't send another request.
- An optional app token raises the rate limit.

**Errors.** Upstream failures are mapped to tool errors (`isError: true`) that say what went wrong and what to try next, for example:

```
Dataset 'zzzz-zzzz' was not found on data.cityofnewyork.us. (HTTP 404, dataset.missing)
Hint: Use search_datasets to find a valid dataset id (format: xxxx-xxxx).
```

## Development

```bash
npm install
npm test          # vitest, recorded fixtures only, no network
npm run build     # compiles to dist/
npm run smoke     # spawns the server over stdio, runs initialize + tools/list
node scripts/smoke.mjs --live   # also makes one real call to Socrata
```

Tests use hand-built fixtures in `test/fixtures/` that match Socrata's response shapes, plus a mocked `fetch` that throws on any request it doesn't recognize. `test/server.test.ts` runs the whole MCP protocol in memory: tool listing, schema validation, output-schema checks, and error mapping.

```
src/
  index.ts            stdio entrypoint (the npx bin)
  server.ts           tool registration
  socrata.ts          HTTP client: timeouts, retries, cache, error mapping
  soql.ts             literal escaping and predicate builders
  tools/              one file per tool: zod input/output schemas + handler
test/                 vitest suites + fixtures/
scripts/smoke.mjs     raw JSON-RPC stdio smoke test
```

## License

MIT © Austin French

---

Need an MCP server for your own API? [austn.net](https://austn.net)
