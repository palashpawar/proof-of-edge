// End-to-end smoke test of one edge swap on Arc Testnet against a live Gemini 5-minute market:
// pick market → seller signs quote → buyer opens → seller reveals → wait for Gemini settlement
// → resolver resolves → settle. Run with `npm run smoke` (optionally SELLER=SELLER_ECHO).
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits, type Hex } from "viem";
import { chainTime, ensureDeposit, escrowBalance, escrowEvents, publicClient, sendEscrow } from "./chain.ts";
import { Outcome, ROOT, accountFor, addressUrl, escrowAddress, type Role } from "./config.ts";
import { echo, overconfident, type Forecaster } from "./forecasters.ts";
import {
  activeCryptoEvents,
  bookOf,
  eventTickerOf,
  getEvent,
  resolutionOf,
  seriesOf,
  type Book,
  type GeminiContract,
  type GeminiEvent,
} from "./gemini.ts";
import { edgeEscrowAbi } from "./abi/EdgeEscrow.ts";
import { commitmentOf, fromPpm, marketIdOf, randomNonce, randomSalt, signQuote, toPpm, type Quote } from "./quote.ts";

const STAKE = 1_000_000n; // 1 USDC each side
const MAX_SPREAD = 0.1;
const MIN_TIME_LEFT_S = 90;
const SERIES_PREFERENCE = ["BTC05M", "ETH05M", "SOL05M", "XRP05M", "BTC15M", "ETH15M"];

const SELLERS: Partial<Record<Role, Forecaster>> = { SELLER_OVERCONFIDENT: overconfident, SELLER_ECHO: echo };
const sellerRole = (process.env.SELLER ?? "SELLER_OVERCONFIDENT") as Role;
const chosen = SELLERS[sellerRole];
if (!chosen) throw new Error(`SELLER must be one of ${Object.keys(SELLERS).join(", ")}`);
const forecast: Forecaster = chosen;

const usd = (units: bigint) => formatUnits(units, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pick {
  event: GeminiEvent;
  contract: GeminiContract;
  book: Book;
}

async function pickMarket(): Promise<Pick> {
  const now = Date.now();
  const picks: Pick[] = [];
  for (const event of await activeCryptoEvents()) {
    if (!SERIES_PREFERENCE.includes(seriesOf(event))) continue;
    const secondsLeft = (Date.parse(event.expiryDate) - now) / 1000;
    if (secondsLeft < MIN_TIME_LEFT_S || secondsLeft > 20 * 60) continue;
    const contract = event.contracts.find((c) => c.label === "Up" && c.status === "active");
    const book = contract && bookOf(contract);
    if (contract && book && book.spread <= MAX_SPREAD) picks.push({ event, contract, book });
  }
  picks.sort(
    (a, b) =>
      Date.parse(a.event.expiryDate) - Date.parse(b.event.expiryDate) ||
      SERIES_PREFERENCE.indexOf(seriesOf(a.event)) - SERIES_PREFERENCE.indexOf(seriesOf(b.event)),
  );
  const pick = picks[0];
  if (!pick) throw new Error("No two-sided 5/15-minute market with a tight enough spread right now; retry shortly.");
  return pick;
}

async function waitForResolution(symbol: string): Promise<"yes" | "no" | "void"> {
  const ticker = eventTickerOf(symbol);
  for (let i = 0; i < 180; i++) {
    const res = resolutionOf(await getEvent(ticker), symbol);
    if (res) return res;
    if (i % 6 === 0) console.log(`  … waiting for Gemini to settle ${ticker}`);
    await sleep(10_000);
  }
  throw new Error(`${symbol} did not settle within 30 minutes`);
}

async function main() {
  const escrow = escrowAddress();
  const buyer = accountFor("BUYER");
  const seller = accountFor(sellerRole);
  const resolver = accountFor("RESOLVER");
  console.log(`EdgeEscrow ${addressUrl(escrow)}\nseller ${sellerRole} ${seller.address}\nbuyer  ${buyer.address}\n`);

  console.log("1. Deposits");
  await ensureDeposit("BUYER", STAKE);
  await ensureDeposit(sellerRole, STAKE);
  const before = { buyer: await escrowBalance(buyer.address), seller: await escrowBalance(seller.address) };
  console.log(`  escrow balances: buyer ${usd(before.buyer)}, seller ${usd(before.seller)} USDC`);

  console.log("2. Market");
  const { event, contract, book } = await pickMarket();
  const symbol = contract.instrumentSymbol;
  const marketId = marketIdOf(symbol);
  const mRef = toPpm(book.mid);
  console.log(`  ${event.title} — ${symbol}`);
  console.log(`  YES book ${book.bid.toFixed(2)} / ${book.ask.toFixed(2)} → m = ${fromPpm(mRef).toFixed(3)}, expires ${event.expiryDate}`);

  console.log("3. Quote (signed by seller, forecast committed)");
  const p = forecast(mRef);
  const salt = randomSalt();
  const now = await chainTime();
  const quote: Quote = {
    seller: seller.address,
    buyer: buyer.address,
    marketId,
    mRef,
    stake: STAKE,
    expiry: now + 60n,
    revealDeadline: now + 180n,
    commit: commitmentOf(marketId, p, salt),
    nonce: randomNonce(),
  };
  const signature = await signQuote(seller, escrow, quote);
  console.log(`  stake ${usd(STAKE)} USDC each side, commit ${quote.commit.slice(0, 18)}…`);

  console.log("4. Buyer opens the swap");
  const opened = await sendEscrow("BUYER", "open", [quote, signature], "open");
  const openLog = escrowEvents(opened).find((l) => l.eventName === "SwapOpened");
  if (!openLog) throw new Error("SwapOpened not found");
  const swapId = (openLog.args as { swapId: Hex }).swapId;
  console.log(`  swapId ${swapId}`);

  console.log("5. Seller reveals");
  await sendEscrow(sellerRole, "reveal", [swapId, p, salt], "reveal");
  console.log(`  p = ${fromPpm(p).toFixed(3)} vs m = ${fromPpm(mRef).toFixed(3)}`);
  console.log("  (the buyer agent would trade on Gemini here)");

  console.log("6. Waiting for Gemini settlement");
  const res = await waitForResolution(symbol);
  console.log(`  Gemini resolved ${symbol}: ${res.toUpperCase()}`);

  console.log("7. Resolver posts the outcome");
  const current = await publicClient.readContract({ address: escrow, abi: edgeEscrowAbi, functionName: "outcomes", args: [marketId] });
  const outcome = res === "yes" ? Outcome.Yes : res === "no" ? Outcome.No : Outcome.Void;
  if (Number(current) === Outcome.Unresolved) await sendEscrow("RESOLVER", "resolve", [symbol, outcome], "resolve");
  else console.log("  already resolved on-chain");

  console.log("8. Settle");
  const settled = await sendEscrow("BUYER", "settle", [swapId], "settle");
  const settleLog = escrowEvents(settled).find((l) => l.eventName === "SwapSettled");
  const { edgeScore, payment } = (settleLog?.args ?? {}) as { edgeScore: bigint; payment: bigint };
  const after = { buyer: await escrowBalance(buyer.address), seller: await escrowBalance(seller.address) };
  const score = Number(edgeScore) / 1e12;

  console.log(`\nΔ = ${score.toFixed(4)} → ${score > 0 ? "buyer pays seller" : score < 0 ? "seller pays buyer" : "no payment"} ${usd(payment)} USDC`);
  console.log(`buyer  ${usd(before.buyer)} → ${usd(after.buyer)} USDC`);
  console.log(`seller ${usd(before.seller)} → ${usd(after.seller)} USDC`);

  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  appendFileSync(
    resolve(ROOT, "data/swaps.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      swapId,
      symbol,
      seller: sellerRole,
      mRef,
      p,
      outcome: res,
      edgeScore: edgeScore.toString(),
      payment: payment.toString(),
      openTx: opened.transactionHash,
      settleTx: settled.transactionHash,
    }) + "\n",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
