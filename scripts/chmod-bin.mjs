// Make the compiled entrypoint executable so `npx nyc-open-data-mcp` works.
import { chmodSync } from "node:fs";

chmodSync(new URL("../dist/index.js", import.meta.url), 0o755);
