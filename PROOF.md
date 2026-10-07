# PROOF

What was checked for version 0.2.0 (stdio server plus the remote HTTP server and playground), how, and what was not. Everything below was run on 2026-10-07 with Node 22. Live results came from NYC Open Data that morning (around 09:00 UTC) without an app token, so the numbers will drift as the city adds data.

## Tests

```
$ npm test
 Test Files  6 passed (6)
      Tests  60 passed (60)
```

| File | Tests | What it covers |
| --- | --- | --- |
| `test/tools.test.ts` | 15 | The four tool handlers against recorded fixtures |
| `test/socrata.test.ts` | 10 | Client retries, timeouts, cache, error mapping |
| `test/soql.test.ts` | 8 | Literal escaping and predicate builders |
| `test/server.test.ts` | 5 | Full MCP protocol in memory |
| `test/http.test.ts` | 15 | HTTP transport, routes, CORS, limits, timeouts |
| `test/rateLimit.test.ts` | 7 | Token bucket, daily cap, env config |

The first four files are the original 38 tests and are unchanged. Counts come from `npx vitest run --reporter=verbose`. No test uses the network: `fetch` is mocked and throws on any request it doesn't expect. The HTTP tests bind to 127.0.0.1 only.

The main HTTP test starts the real Node server on a random local port and connects with the official SDK client (`StreamableHTTPClientTransport`): `initialize`, `tools/list` (4 tools), a successful `tools/call`, and a `tools/call` that maps a Socrata 404 to `isError: true`. Other tests check:
- `tools/call` works with no prior `initialize` (stateless)
- CORS preflight, and the allow-list mode only echoes listed origins
- 405 for GET/DELETE, 406 for a bad `Accept`, 400 with code -32700 for broken JSON and no stack trace in the body, 413 for big bodies (with and without `Content-Length`)
- 504 when Socrata hangs past `requestTimeoutMs`
- per-IP 429 with `Retry-After`, IPs counted separately, the daily cap, `/` and `/health` not rate limited
- `X-Forwarded-For` is only trusted for the configured number of proxy hops
- `/health` never calls Socrata

Also run: `npm run typecheck` (clean), `npm audit` (found 0 vulnerabilities).

## Stdio smoke test (no network)

```
$ npm run smoke
nyc-open-data-mcp running on stdio
initialize -> {"name":"nyc-open-data","version":"0.2.0"} protocol 2025-06-18
tools/list -> 4 tools
  - search_datasets(query, category, limit, offset, include_columns)
  - query_dataset(dataset_id, select, where, order, group, q, limit, offset)
  - restaurant_inspections(name, zip_code, borough, cuisine, limit, offset)
  - service_requests_311(zip_codes, borough, complaint_type, start_date, end_date, top_n, sample_size)
SMOKE OK
```
(Tool descriptions trimmed here.)

## HTTP smoke test

```
$ npm run smoke:http
nyc-open-data-mcp listening on http://localhost:4889 (MCP at /mcp, playground at /)
GET /health -> {"status":"ok","name":"nyc-open-data","version":"0.2.0","transport":"streamable-http","endpoint":"/mcp","uptime_s":0,"socrata_app_token":false,"limits":{"per_ip_per_minute":30,"daily_requests":5000,"daily_used":0}}
OPTIONS /mcp -> 204, allow-origin: *
POST /mcp initialize -> 200 {"name":"nyc-open-data","version":"0.2.0"} protocol 2025-06-18
POST /mcp tools/list -> 4 tools: search_datasets, query_dataset, restaurant_inspections, service_requests_311
GET / -> 200, 33430 bytes, title: NYC Open Data MCP
HTTP SMOKE OK
```

Production start command:

```
$ npm run build && PORT=3999 npm start
nyc-open-data-mcp listening on http://localhost:3999 (MCP at /mcp, playground at /)

$ curl -i localhost:3999/health
HTTP/1.1 200 OK
access-control-allow-origin: *
content-type: application/json
{"status":"ok","name":"nyc-open-data","version":"0.2.0", ...}

$ head -c 70000 /dev/zero | curl -X POST localhost:3999/mcp -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' --data-binary @- -w ' HTTP %{http_code}\n'
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Request body too large (max 65536 bytes)."},"id":null} HTTP 413
```

## Live results (fetched 2026-10-07)

`node scripts/smoke-http.mjs --live`, real `tools/call` over HTTP:

- `restaurant_inspections {name: "ramen", zip_code: "10003", limit: 3}` (1394 ms): RAMEN BY RA, latest grade A (graded 2026-01-31, latest inspection 2026-10-03, 0 violations); KYURAMEN, latest grade B (graded 2025-01-22, latest inspection 2026-07-22 with 6 violations, 3 critical). `has_more: true`.
- `service_requests_311 {zip_codes: ["10003","10009"], top_n: 5}` (890 ms), default window 2026-09-07 to 2026-10-07: 4,743 requests. Top types: Encampment 674 (14.2%), Noise - Residential 497 (10.5%), Illegal Parking 368 (7.8%), Noise - Street/Sidewalk 274 (5.8%), Noise - Commercial 250 (5.3%).

`curl` to `POST /mcp` with `query_dataset {dataset_id: "uvpi-gqnh", select: "boroname, count(*) as trees", group: "boroname", order: "trees DESC"}` (2015 street tree census): Queens 250,551, Brooklyn 177,293, Staten Island 105,318, Bronx 85,203, Manhattan 65,423.

The playground screenshots below show more live results from the same morning: East Village 311 for September 2026 (4,823 requests, Encampment 746 first) and the most common street trees in Brooklyn (London planetree 34,886).

The "2,400+ datasets" figure in the README and playground comes from:

```
$ curl -sS "https://api.us.socrata.com/api/catalog/v1?domains=data.cityofnewyork.us&search_context=data.cityofnewyork.us&only=datasets&limit=1" | jq .resultSetSize
2404
```

## Screenshots

Taken with `npm run screenshots` (Playwright + the preinstalled Chromium) against the built server and live Socrata data. Desktop shots are 1280x800; phone shots use a 390x844 viewport at 2x.

| File | Shows |
| --- | --- |
| `docs/screenshots/playground.png` | Landing view, endpoint, health line, example questions |
| `docs/screenshots/restaurants.png` | `restaurant_inspections` results as a table with grade badges |
| `docs/screenshots/311-east-village.png` | `service_requests_311` totals and top complaint types |
| `docs/screenshots/query-trees.png` | `query_dataset` group-by on the tree census |
| `docs/screenshots/raw-json.png` | Raw JSON toggle on the same result |
| `docs/screenshots/connect.png` | Client config tabs (Claude Desktop selected) |
| `docs/screenshots/phone.png` | Phone width, top of the page |
| `docs/screenshots/phone-results.png` | Phone width, restaurant results stacked into cards |

## Size of the 311 dataset

```
$ curl -sS 'https://data.cityofnewyork.us/resource/erm2-nwe9.json?$select=count(*)'
[{"count":"22715014"}]
```

Run on 2026-10-07. An earlier code comment said about 40 million; it now says 22.7 million.

## Install from GitHub without npm

The package is not on npm. The README installs it with `npx -y github:frogr/nyc-open-data-mcp`, which works because a `prepare` script runs `npm run build` when npm installs from git. The GitHub repo wasn't public when this was checked, so the same path was tested from a local git URL with an empty npx cache:

```
$ rm -rf ~/.npm/_npx
$ echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | npx -y git+file:///home/claude/nyc-open-data-mcp
nyc-open-data-mcp running on stdio
{"result":{"protocolVersion":"2025-06-18",...,"serverInfo":{"name":"nyc-open-data","version":"0.2.0"},...}
```

First start took 16 s (clone, install, TypeScript build). Not checked: the same command against github.com, which needs the repo to be public.

## Not verified

- **No real deployment.** `render.yaml` follows Render's Blueprint format but was not deployed. The free-tier sleep behavior is from Render's docs, not tested.
- **Docker image not built.** The Docker daemon isn't available in this environment, so the `Dockerfile` is unverified.
- **Real clients over HTTP.** Claude Desktop, Claude Code, Cursor and `mcp-remote` were not connected to the remote endpoint. The HTTP transport was tested with the official SDK client, which is what those clients build on.
- **Behind a proxy.** `TRUST_PROXY` handling is unit tested, not tested behind Render's actual proxy.
- **Load.** No load test. The rate limiter is in memory and per instance.
- **App token.** All live calls ran without `SOCRATA_APP_TOKEN`.
