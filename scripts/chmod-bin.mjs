// Make the compiled entrypoints executable so `npx nyc-open-data-mcp` works.
import { chmodSync } from "node:fs";

for (const file of ["index.js", "http.js"]) chmodSync(new URL(`../dist/${file}`, import.meta.url), 0o755);
