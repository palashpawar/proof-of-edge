// Buyer agent: Claude decides which forecasts to buy and what to trade; policy.ts decides what is allowed.
//   npm run agent                 one round
//   npm run agent -- --rounds 6   six rounds, one every ~2.5 minutes
// Needs the marketplace running (npm run marketplace) and ANTHROPIC_API_KEY in .env.
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { formatUnits, parseUnits, type Hex } from "viem";
import { ensureDeposit, escrowEvents, sendEscrow } from "./chain.ts";
import { ROOT, accountFor } from "./config.ts";
import { buyQuote, checkQuote, ensureGatewayBalance, gatewayClient, waitForReveal } from "./buyer.ts";
import { activeOrders, cancelOrder, hasTradingKey, placeOrder } from "./gemini-trade.ts";
import { loadMarket } from "./markets.ts";
import { fromPpm } from "./quote.ts";
import { POLICY, allowBuy, allowOrder, humanApproves, isProven, newRun, type RunState, type SellerRecord } from "./policy.ts";

const BASE = process.env.MARKETPLACE_URL ?? "http://localhost:8811";
const MODEL = "claude-opus-5-5";
const MAX_STEPS = 14;
const ROUND_GAP_MS = 150_000;

const client = new Anthropic();
const gateway = gatewayClient();
const me = accountFor("BUYER").address;

// ──────────────────────────────── logging ────────────────────────────────

type Kind = "think" | "paid" | "trade" | "blocked" | "info";
function log(kind: Kind, text: string, symbol?: string) {
  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  appendFileSync(resolve(ROOT, "data/agent-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), kind, symbol, text }) + "\n");
  console.log(`[${kind}]${symbol ? ` ${symbol}` : ""} ${text}`);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface State {
  sellers: { id: string; stats: { n: number; meanEdge: number | null; ci95: [number, number] | null; netUsdc: number } | null }[];
  swaps: { buyer: string; status: string; stake: string }[];
}

async function sellerRecords(): Promise<SellerRecord[]> {
  const s = await getJson<State>("/api/state");
  return s.sellers.map((x) => ({ id: x.id, n: x.stats?.n ?? 0, ciLow: x.stats?.ci95?.[0] ?? null }));
}

async function openStakeUsdc(): Promise<number> {
  const s = await getJson<State>("/api/state");
  return s.swaps
    .filter((r) => r.buyer === me && (r.status === "Open" || r.status === "Revealed"))
    .reduce((a, r) => a + Number(r.stake) / 1e6, 0);
}

// ───────────────────────────────── tools ─────────────────────────────────

const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_markets",
    description: "Live Gemini 5/15-minute crypto 'Up' markets that sellers will quote: symbol, title, seconds left, YES bid/ask, reference strike (null before the window starts).",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "get_sellers",
    description: "Forecast sellers with their settled track record: n swaps, mean edge over the market (Brier improvement), 95% CI, net USDC, and whether policy treats them as proven.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "buy_forecast",
    description:
      "Pay a seller's $0.001 x402 fee for a quote on one market, verify it, open the edge swap on Arc (locks stake_usdc from both sides) and wait for the revealed forecast. Returns the seller's probability p and the market reference m.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        seller: { type: "string", description: "Seller id from get_sellers." },
        symbol: { type: "string", description: "Instrument symbol from get_markets." },
        stake_usdc: { type: "number", description: `Stake each side locks, at most ${POLICY.maxStakePerSwapUsdc}.` },
        reason: { type: "string", description: "One sentence: why this seller and market." },
      },
      required: ["seller", "symbol", "stake_usdc", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "place_order",
    description:
      "Place a buy limit order on Gemini (sandbox, same contract symbol) leaning on a forecast bought this run. It is also marked against the live production book as a paper fill. Only buys: buy YES if you think YES is underpriced, buy NO if YES is overpriced.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        outcome: { type: "string", enum: ["yes", "no"] },
        price: { type: "number", description: "Limit price in (0,1) for the chosen outcome." },
        quantity: { type: "integer", description: "Contracts." },
        reason: { type: "string", description: "One sentence: the edge you see." },
      },
      required: ["symbol", "outcome", "price", "quantity", "reason"],
      additionalProperties: false,
    },
  },
];

async function runTool(run: RunState, name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "get_markets": {
      const markets = await getJson<unknown[]>("/markets");
      return JSON.stringify(markets.slice(0, 12));
    }
    case "get_sellers": {
      const s = await getJson<State>("/api/state");
      return JSON.stringify(
        s.sellers.map((x) => ({
          id: x.id,
          ...x.stats,
          proven: isProven({ id: x.id, n: x.stats?.n ?? 0, ciLow: x.stats?.ci95?.[0] ?? null }),
        })),
      );
    }
    case "buy_forecast": {
      const seller = String(input.seller);
      const symbol = String(input.symbol);
      const stakeUsdc = Number(input.stake_usdc);
      const verdict = allowBuy(run, { seller, stakeUsdc, openStakeUsdc: await openStakeUsdc(), feeUsd: 0.001 });
      if (!verdict.ok) {
        log("blocked", `buy_forecast from ${seller} refused by policy: ${verdict.reason}`, symbol);
        return JSON.stringify({ refused: verdict.reason });
      }
      log("think", `buying from ${seller}: ${String(input.reason)}`, symbol);
      const stake = stakeUsdc.toFixed(6).replace(/\.?0+$/, "");
      await ensureDeposit("BUYER", parseUnits(stake, 6));
      const paid = await buyQuote(gateway, BASE, seller, symbol, stake);
      run.feesUsd += Number(paid.formattedAmount);
      run.forecasts++;
      const quote = await checkQuote(paid.data, me);
      const opened = await sendEscrow("BUYER", "open", [quote, paid.data.signature], "open");
      const swapId = (escrowEvents(opened).find((l) => l.eventName === "SwapOpened")?.args as { swapId: Hex }).swapId;
      const p = await waitForReveal(swapId);
      const m = fromPpm(quote.mRef);
      run.revealed.set(symbol, { seller, p: fromPpm(p), m, swapId });
      log("paid", `${seller} says ${fromPpm(p).toFixed(3)} vs market ${m.toFixed(3)} (fee $${paid.formattedAmount}, stake ${stake} USDC)`, symbol);
      return JSON.stringify({ seller, symbol, p: fromPpm(p), m, swapId, stakeUsdc: Number(stake) });
    }
    case "place_order": {
      const symbol = String(input.symbol);
      const outcome = input.outcome === "no" ? "no" : "yes";
      const price = Math.round(Number(input.price) * 100) / 100; // Gemini ticks are 1¢
      const quantity = Number(input.quantity);
      const f = run.revealed.get(symbol);
      const sellers = await sellerRecords();
      const verdict = allowOrder(run, { symbol, outcome, price, quantity, seller: sellers.find((s) => s.id === f?.seller) });
      if (!verdict.ok) {
        log("blocked", `order ${quantity}× ${outcome.toUpperCase()} @ ${price} refused by policy: ${verdict.reason}`, symbol);
        return JSON.stringify({ refused: verdict.reason });
      }
      const notional = price * quantity;
      if (notional > POLICY.approvalAboveUsd && !(await humanApproves(`buy ${quantity}× ${outcome.toUpperCase()} ${symbol} @ ${price} ($${notional.toFixed(2)})`))) {
        log("blocked", `order $${notional.toFixed(2)} needs human approval and was not approved`, symbol);
        return JSON.stringify({ refused: "human approval required and not given" });
      }
      run.orders++;
      log("think", `trading: ${String(input.reason)}`, symbol);

      // Paper fill against the live production book (the sandbox book for these contracts is usually empty).
      const live = await loadMarket(symbol);
      const ask = outcome === "yes" ? live?.book?.ask : live?.book ? 1 - live.book.bid : undefined;
      const paperFill = ask !== undefined && price >= ask ? ask : null;

      let sandbox: { orderId?: string; status?: string; error?: string } = {};
      if (hasTradingKey()) {
        try {
          const o = await placeOrder({ symbol, side: "buy", outcome, quantity: String(quantity), price: price.toFixed(2), timeInForce: "good-til-cancel" });
          sandbox = { orderId: o.orderId, status: o.status };
        } catch (err) {
          sandbox = { error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
        }
      }
      log(
        "trade",
        `buy ${quantity}× ${outcome.toUpperCase()} @ ${price.toFixed(2)} — sandbox ${sandbox.orderId ? `order ${sandbox.orderId} ${sandbox.status}` : `not placed (${sandbox.error ?? "no key"})`}; paper ${paperFill === null ? "not filled (limit below live ask)" : `filled at ${paperFill.toFixed(2)}`}`,
        symbol,
      );
      appendFileSync(resolve(ROOT, "data/paper-trades.jsonl"), JSON.stringify({ at: new Date().toISOString(), symbol, outcome, quantity, limit: price, paperFill, sandbox }) + "\n");
      return JSON.stringify({ sandbox, paperFill });
    }
    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}

// ─────────────────────────────── agent loop ───────────────────────────────

const SYSTEM = `You are the buyer agent for Proof of Edge, a marketplace where forecasters sell probability forecasts for Gemini prediction markets.

How payment works: each forecast costs a $0.001 x402 fee, and you open an "edge swap" on Arc: you and the seller each lock a stake. When the market resolves to y, Δ = (m − y)² − (p − y)² where m is the market mid when you bought and p is the seller's forecast. If Δ > 0 you pay the seller stake·Δ; if Δ < 0 the seller pays you. A seller who adds nothing beyond the market (p = m) costs you nothing. So buying forecasts is cheap when sellers are bad, and you only pay real money to sellers who beat the market.

Your job each round:
1. Check get_markets and get_sellers.
2. Buy a few forecasts (at most ${POLICY.maxForecastsPerRun}). Prefer markets whose window has started (strike known) and that expire within ~10 minutes. Audition sellers without a track record at small stakes so the leaderboard learns who has edge; lean on proven sellers when they exist.
3. Trade only when a forecast says an outcome is worth at least ${POLICY.minEdge} more than you would pay. Size small: orders on unproven sellers are capped at ${POLICY.unprovenMaxQuantity} contract.
4. Finish with two sentences: what you bought, what you traded, and why.

Hard limits are enforced in code, not by you; if a tool returns "refused", read the reason and adapt rather than retrying the same call. Keep every "reason" field to one sentence.`;

async function round(n: number) {
  const run = newRun();
  log("info", `round ${n} started`);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Round ${n}. It is ${new Date().toISOString()}. Run your process.` },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // on a policy decline the API re-runs the request on a fallback model
      output_config: { effort: "medium" },
      system: SYSTEM,
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      log("info", `model declined (${response.stop_details?.category ?? "unknown"}); ending round`);
      break;
    }
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;

    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || uses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (text) log("think", text);
      break;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      try {
        results.push({ type: "tool_result", tool_use_id: use.id, content: await runTool(run, use.name, use.input as Record<string, unknown>) });
      } catch (err) {
        let msg = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        // Gateway's error drops the body; the marketplace only answers 409 when the market isn't quotable.
        if (/status 409/.test(msg)) msg += " (market not quotable right now: one-sided or >10¢-wide book, or under 60 s left; no fee was charged; try another market)";
        log("blocked", `${use.name} failed: ${msg}`);
        results.push({ type: "tool_result", tool_use_id: use.id, content: msg, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  log("info", `round ${n} done: ${run.forecasts} forecasts, ${run.orders} orders, fees $${run.feesUsd.toFixed(3)}`);
}

/** Resting sandbox orders don't outlive the agent. */
async function cancelSandboxOrders() {
  if (!hasTradingKey()) return;
  const a = await activeOrders();
  for (const o of Array.isArray(a) ? a : (a.orders ?? [])) await cancelOrder(o.orderId).catch(() => undefined);
}

async function main() {
  const rounds = Number(process.argv[process.argv.indexOf("--rounds") + 1] ?? 1) || 1;
  const gw = await ensureGatewayBalance(gateway, 20_000n);
  console.log(`buyer ${me}, gateway ${formatUnits(gw.gateway.available, 6)} USDC available, ${rounds} round(s)`);
  for (let i = 1; i <= rounds; i++) {
    await round(i);
    if (i < rounds) await new Promise((r) => setTimeout(r, ROUND_GAP_MS));
  }
  await cancelSandboxOrders();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await cancelSandboxOrders().catch(() => undefined);
  process.exit(1);
});
