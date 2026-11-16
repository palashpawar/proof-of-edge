// Renders the YouTube thumbnail with live leaderboard numbers → out/thumbnail.png (1920×1080)
//   npm run video:thumbnail      (needs the marketplace running for live numbers)
import { mkdirSync, statSync } from "node:fs";
import { chromium } from "playwright-core";

const EXE =
  process.env.CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const DASH = process.env.DASH_URL ?? "http://localhost:8811";

const state = await (await fetch(`${DASH}/api/state`)).json();
const sellers = state.sellers.map((s) => ({ id: s.id, n: s.stats?.n ?? 0, mean: s.stats?.meanEdge ?? 0 }));

mkdirSync("out", { recursive: true });
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
await page.goto(new URL("slides/thumbnail.html", import.meta.url).href);
await page.evaluate((s) => window.fill(s), sellers);
await page.screenshot({ path: "out/thumbnail.png" });
await browser.close();
console.log(`out/thumbnail.png (${(statSync("out/thumbnail.png").size / 1024).toFixed(0)} KB) — ${sellers.map((s) => `${s.id} ${s.mean.toFixed(3)}`).join(", ")}`);
