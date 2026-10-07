// Screenshots of the web playground against live Socrata data.
//
//   npm run build && node scripts/screenshots.mjs
//
// Starts dist/http.js on a free port, drives it with Chromium, writes
// docs/screenshots/*.png. Needs network (the examples call NYC Open Data).
// CHROMIUM_PATH overrides the browser binary.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const port = 4100 + Math.floor(Math.random() * 500);
const base = `http://localhost:${port}`;
const out = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const server = spawn(process.execPath, [new URL("../dist/http.js", import.meta.url).pathname], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function runExample(page, index) {
  await page.locator(".example").nth(index).click();
  await page.waitForFunction(() => !document.querySelector("#tool-form .btn")?.disabled && /ms$/.test(document.querySelector("#result-meta")?.textContent ?? ""), null, { timeout: 45_000 });
  await page.locator("#try").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
}

const browser = await chromium.launch({ executablePath });
try {
  await waitForHealth();

  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await desk.goto(base);
  await desk.waitForSelector("#tool-tabs .tab");
  await desk.waitForFunction(() => /Healthy/.test(document.querySelector("#health-stat")?.textContent ?? ""));
  await desk.screenshot({ path: `${out}playground.png` });

  await runExample(desk, 0);
  await desk.screenshot({ path: `${out}restaurants.png` });

  await runExample(desk, 1);
  await desk.screenshot({ path: `${out}311-east-village.png` });

  await runExample(desk, 5);
  await desk.screenshot({ path: `${out}query-trees.png` });

  await desk.locator("#json-toggle").click();
  await desk.screenshot({ path: `${out}raw-json.png` });

  await desk.locator("#connect").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await desk.locator("#client-tabs .tab", { hasText: "Claude Desktop" }).click();
  await desk.waitForTimeout(200);
  await desk.screenshot({ path: `${out}connect.png` });

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.goto(base);
  await phone.waitForSelector("#tool-tabs .tab");
  await phone.screenshot({ path: `${out}phone.png` });
  await runExample(phone, 0);
  await phone.locator("#result-meta").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await phone.waitForTimeout(200);
  await phone.screenshot({ path: `${out}phone-results.png` });

  console.log(`screenshots written to ${out}`);
} finally {
  await browser.close();
  server.kill();
}
