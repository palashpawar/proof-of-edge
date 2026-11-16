// Records each scene for exactly as long as its narration (audio/durations.json) → raw/<scene>.webm
//   node record.mjs            all scenes
//   node record.mjs agent      one scene
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "playwright-core";

const EXE =
  process.env.CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const W = 1280, H = 720;
const DASH = process.env.DASH_URL ?? "http://localhost:8811";
const EXPLORER = "https://explorer.testnet.arc.io";
const slide = (name) => new URL(`slides/${name}.html`, import.meta.url).href;
const durations = JSON.parse(readFileSync("audio/durations.json", "utf8"));
const offsetsFile = "raw/offsets.json";
const offsets = existsSync(offsetsFile) ? JSON.parse(readFileSync(offsetsFile, "utf8")) : {};

const highlight = (page, sel, on = true) =>
  page.evaluate(([s, o]) => {
    for (const el of document.querySelectorAll(s)) {
      el.style.transition = "outline-color .3s, box-shadow .3s";
      el.style.outline = o ? "3px solid #7aa2ff" : "3px solid transparent";
      el.style.outlineOffset = "4px";
      el.style.boxShadow = o ? "0 0 0 8px rgba(122,162,255,.15)" : "none";
    }
  }, [sel, on]);
const restartAnimations = (page, delays = {}) =>
  page.evaluate((d) => {
    for (const [sel, sec] of Object.entries(d)) document.querySelectorAll(sel).forEach((el) => (el.style.animationDelay = `${sec}s`));
    document.querySelectorAll(".fade").forEach((el) => {
      el.style.animationName = "none";
      void el.offsetHeight;
      el.style.animationName = "";
    });
  }, delays);
const smoothScroll = (page, px, ms) =>
  page.evaluate(([p, t]) => {
    const start = scrollY, t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / t);
      scrollTo(0, start + p * (0.5 - Math.cos(Math.PI * k) / 2));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [px, ms]);

/** Per scene: setup (before narration starts, trimmed off) and run (during narration, d = seconds). */
const SCENES = {
  hook: {
    setup: (p) => p.goto(slide("title")),
    run: (p) => restartAnimations(p),
  },
  mechanism: {
    setup: (p) => p.goto(slide("mechanism")),
    run: (p, d) => restartAnimations(p, { ".formula": d * 0.33, "ul": d * 0.52 }),
  },
  leaderboard: {
    setup: async (p) => {
      await p.goto(DASH);
      await p.waitForSelector("#sellers .card");
      await p.evaluate(() => scrollTo(0, 0));
    },
    run: async (p, d) => {
      const cards = ["#sellers .card:nth-child(1)", "#sellers .card:nth-child(2)", "#sellers .card:nth-child(3)"];
      for (const c of cards) {
        await highlight(p, c);
        await p.waitForTimeout(d * 1000 * 0.13);
        await highlight(p, c, false);
      }
      await p.waitForTimeout(d * 1000 * 0.12);
      await highlight(p, "#sellers .card:nth-child(1)"); // "echo sits at exactly zero"
      await p.waitForTimeout(d * 1000 * 0.2);
      await highlight(p, "#sellers .card:nth-child(1)", false);
      await highlight(p, "#sellers .card:nth-child(2), #sellers .card:nth-child(3)"); // CIs include zero
    },
  },
  erc8004: {
    setup: async (p) => {
      await p.goto(`${EXPLORER}/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/897929`, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
      await p.waitForTimeout(2500);
    },
    run: async (p, d) => {
      await p.waitForTimeout(d * 1000 * 0.5);
      await smoothScroll(p, 260, d * 1000 * 0.35);
    },
  },
  swaps: {
    setup: async (p) => {
      await p.goto(DASH);
      await p.waitForSelector("#swaps tr");
      await p.evaluate(() => document.querySelector("#swaps").closest("section").scrollIntoView());
      await p.evaluate(() => scrollBy(0, -16));
    },
    run: async (p, d) => {
      await highlight(p, "#swaps tr:nth-child(-n+3)");
      await smoothScroll(p, 220, d * 1000 * 0.8);
    },
  },
  agent: {
    setup: (p) => p.goto(slide("agent")),
    run: async (p, d) => {
      const rows = readFileSync("../data/agent-log.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const start = rows.map((r) => r.text).lastIndexOf("round 1 started");
      const lines = rows.slice(start).map((r) => ({ kind: r.kind, text: `${r.symbol ? r.symbol.replace(/^GEMI-/, "") + "  " : ""}${r.text}` }));
      await p.evaluate(([l, ms]) => window.play(l, ms), [lines, d * 1000 * 0.82]);
    },
  },
  explorer: {
    setup: async (p) => {
      await p.goto(`${EXPLORER}/address/0x288a40f4aa06C0A382aA790d4b27857FcF9EF54F?tab=contract`, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
      await p.waitForTimeout(2500);
    },
    run: (p, d) => smoothScroll(p, 300, d * 1000 * 0.7),
  },
  outro: {
    setup: (p) => p.goto(slide("outro")),
    run: (p, d) =>
      restartAnimations(p, { "h1.fade": d * 0.42, ".tag": d * 0.5, ".mono": d * 0.62, "p.fade:last-child": d * 0.7 }),
  },
};

const only = process.argv[2];
mkdirSync("raw", { recursive: true });
const browser = await chromium.launch({ executablePath: EXE });
for (const [id, scene] of Object.entries(SCENES)) {
  if (only && id !== only) continue;
  const d = durations[id];
  if (!d) throw new Error(`no narration duration for ${id}; run tts.mjs first`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: "dark", recordVideo: { dir: "raw/tmp", size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await scene.setup(page);
  const lead = (Date.now() - t0) / 1000;
  const runStart = Date.now();
  await scene.run(page, d);
  const left = d * 1000 + 500 - (Date.now() - runStart);
  if (left > 0) await page.waitForTimeout(left);
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), `raw/${id}.webm`);
  offsets[id] = lead;
  writeFileSync(offsetsFile, JSON.stringify(offsets, null, 2));
  console.log(`${id.padEnd(12)} recorded (${d.toFixed(1)} s narration, trim ${lead.toFixed(2)} s)`);
}
await browser.close();
