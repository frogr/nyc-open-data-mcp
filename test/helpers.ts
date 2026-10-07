import { readFileSync } from "node:fs";
import { SocrataClient } from "../src/socrata.js";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Route = { match: (url: URL) => boolean; respond: (url: URL) => Response | Promise<Response> };

/**
 * A fetch stand-in that routes by URL and records every call.
 * Unmatched requests fail loudly so tests can never hit the network.
 */
export function mockFetch(routes: Route[]) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fn = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`Unmocked request: ${url.toString()}`);
    return route.respond(url);
  };
  return { fetch: fn, calls };
}

/** Matcher on a SoQL param, e.g. param("$select", s => s.startsWith("count(*)")). */
export const param = (key: string, test: (v: string) => boolean) => (url: URL) => test(url.searchParams.get(key) ?? "");

export function testClient(fetch: ReturnType<typeof mockFetch>["fetch"], extra: Partial<ConstructorParameters<typeof SocrataClient>[0]> = {}) {
  return new SocrataClient({ fetch, cacheTtlMs: 0, sleep: async () => {}, ...extra });
}

/** Pull the structured payload out of a tool result. */
export function data<T = any>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}
