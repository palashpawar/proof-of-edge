import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICY, allowBuy, allowOrder, isProven, newRun } from "./policy.ts";

const buy = { seller: "vol", stakeUsdc: 1, openStakeUsdc: 0, feeUsd: 0.001 };

test("buys: allowlist, stake, open-stake and fee caps", () => {
  assert.equal(allowBuy(newRun(), buy).ok, true);
  assert.equal(allowBuy(newRun(), { ...buy, seller: "stranger" }).ok, false);
  assert.equal(allowBuy(newRun(), { ...buy, stakeUsdc: POLICY.maxStakePerSwapUsdc + 0.01 }).ok, false);
  assert.equal(allowBuy(newRun(), { ...buy, openStakeUsdc: POLICY.maxOpenStakeUsdc }).ok, false);
  const spent = { ...newRun(), feesUsd: POLICY.maxQuoteFeesPerRunUsd };
  assert.equal(allowBuy(spent, buy).ok, false);
  const busy = { ...newRun(), forecasts: POLICY.maxForecastsPerRun };
  assert.equal(allowBuy(busy, buy).ok, false);
});

test("orders: need a forecast, enough edge, and small size on unproven sellers", () => {
  const run = newRun();
  const order = { symbol: "S", outcome: "yes" as const, price: 0.5, quantity: 1, seller: { id: "vol", n: 0, ciLow: null } };
  assert.equal(allowOrder(run, order).ok, false, "no forecast bought yet");

  run.revealed.set("S", { seller: "vol", p: 0.6, m: 0.5, swapId: "0x" });
  assert.equal(allowOrder(run, order).ok, true, "0.10 edge on YES");
  assert.equal(allowOrder(run, { ...order, price: 0.57 }).ok, false, "0.03 edge is below the minimum");
  assert.equal(allowOrder(run, { ...order, outcome: "no", price: 0.3 }).ok, true, "NO worth 0.40, buy at 0.30");
  assert.equal(allowOrder(run, { ...order, quantity: 2 }).ok, false, "unproven seller: 1 contract max");

  const proven = { id: "vol", n: POLICY.trustedMinSwaps, ciLow: 0.01 };
  assert.equal(isProven(proven), true);
  assert.equal(allowOrder(run, { ...order, quantity: 2, seller: proven }).ok, true);
  assert.equal(allowOrder(run, { ...order, quantity: 20, seller: proven }).ok, false, "notional cap");
});
