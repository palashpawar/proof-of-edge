// The buyer agent's safety layer. Claude proposes; these checks decide. Nothing here is visible to,
// or changeable by, the model: every money-moving tool call passes through allowBuy / allowOrder first.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ROOT } from "./config.ts";

export const POLICY = {
  sellerAllowlist: ["echo", "vol", "overconfident"],
  maxQuoteFeesPerRunUsd: 0.02, // x402 fees, also capped per quote at $0.01 in buyer.ts
  maxStakePerSwapUsdc: 1,
  maxOpenStakeUsdc: 4, // stake locked across this buyer's open + revealed swaps
  maxForecastsPerRun: 4,
  maxOrdersPerRun: 4,
  maxOrderNotionalUsd: 5, // price × quantity, per order
  approvalAboveUsd: 2, // orders above this need a human yes (refused when nobody is at the terminal)
  minEdge: 0.05, // |forecast − limit price| needed before trading on a forecast
  trustedMinSwaps: 5, // a seller is "proven" with n ≥ 5 settled swaps and a 95% CI lower bound > 0
  unprovenMaxQuantity: 1, // orders on unproven sellers' forecasts are capped at 1 contract
} as const;

export interface SellerRecord {
  id: string;
  n: number;
  ciLow: number | null;
}

export const isProven = (s: SellerRecord | undefined) =>
  !!s && s.n >= POLICY.trustedMinSwaps && s.ciLow !== null && s.ciLow > 0;

export interface RunState {
  feesUsd: number;
  forecasts: number;
  orders: number;
  /** Forecasts bought this run, by symbol: what an order is allowed to lean on. */
  revealed: Map<string, { seller: string; p: number; m: number; swapId: string }>;
}

export const newRun = (): RunState => ({ feesUsd: 0, forecasts: 0, orders: 0, revealed: new Map() });

export const killSwitchOn = () => existsSync(resolve(ROOT, "data/KILL"));

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });

export function allowBuy(run: RunState, a: { seller: string; stakeUsdc: number; openStakeUsdc: number; feeUsd: number }): Verdict {
  if (killSwitchOn()) return no("kill switch is on (data/KILL exists)");
  if (!(POLICY.sellerAllowlist as readonly string[]).includes(a.seller)) return no(`seller "${a.seller}" is not on the allowlist`);
  if (run.forecasts >= POLICY.maxForecastsPerRun) return no(`already bought ${run.forecasts} forecasts this run (max ${POLICY.maxForecastsPerRun})`);
  if (!(a.stakeUsdc > 0) || a.stakeUsdc > POLICY.maxStakePerSwapUsdc) return no(`stake must be in (0, ${POLICY.maxStakePerSwapUsdc}] USDC`);
  if (a.openStakeUsdc + a.stakeUsdc > POLICY.maxOpenStakeUsdc)
    return no(`open stake would be ${(a.openStakeUsdc + a.stakeUsdc).toFixed(2)} USDC (max ${POLICY.maxOpenStakeUsdc})`);
  if (run.feesUsd + a.feeUsd > POLICY.maxQuoteFeesPerRunUsd) return no(`quote fee budget of $${POLICY.maxQuoteFeesPerRunUsd} for this run is spent`);
  return { ok: true };
}

export function allowOrder(
  run: RunState,
  a: { symbol: string; outcome: "yes" | "no"; price: number; quantity: number; seller: SellerRecord | undefined },
): Verdict {
  if (killSwitchOn()) return no("kill switch is on (data/KILL exists)");
  if (run.orders >= POLICY.maxOrdersPerRun) return no(`already placed ${run.orders} orders this run (max ${POLICY.maxOrdersPerRun})`);
  const f = run.revealed.get(a.symbol);
  if (!f) return no("no forecast was bought for this market in this run; trades must lean on a paid forecast");
  if (!(a.price > 0 && a.price < 1) || !Number.isInteger(a.quantity) || a.quantity < 1) return no("price must be in (0,1) and quantity a positive integer");
  const fair = a.outcome === "yes" ? f.p : 1 - f.p;
  if (fair - a.price < POLICY.minEdge)
    return no(`edge ${(fair - a.price).toFixed(3)} is below the ${POLICY.minEdge} minimum (forecast says ${a.outcome} is worth ${fair.toFixed(3)})`);
  if (!isProven(a.seller) && a.quantity > POLICY.unprovenMaxQuantity)
    return no(`seller "${f.seller}" is unproven, so orders are capped at ${POLICY.unprovenMaxQuantity} contract`);
  if (a.price * a.quantity > POLICY.maxOrderNotionalUsd) return no(`notional $${(a.price * a.quantity).toFixed(2)} exceeds $${POLICY.maxOrderNotionalUsd}`);
  return { ok: true };
}

/** Human-in-the-loop gate for larger orders. With no terminal attached, the answer is no. */
export async function humanApproves(summary: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nApprove ${summary}? [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
