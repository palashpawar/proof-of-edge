// End-to-end paid swap through the marketplace:
// discover → pay x402 fee (Circle Gateway, Arc) → check quote → open → seller auto-reveals
// → wait for Gemini settlement → resolve → settle.
// Start the marketplace first (`npm run marketplace`), then `npm run paid-swap` (SELLER_ID=vol|echo|overconfident).
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits, parseUnits, type Hex } from "viem";
import { ensureDeposit, escrowBalance, escrowEvents, sendEscrow } from "./chain.ts";
import { ROOT, accountFor, txUrl } from "./config.ts";
import { buyQuote, checkQuote, ensureGatewayBalance, gatewayClient, waitForReveal } from "./buyer.ts";
import { waitForResolution } from "./markets.ts";
import { fromPpm } from "./quote.ts";
import { postOutcome, settleSwap } from "./settlement.ts";

const BASE = process.env.MARKETPLACE_URL ?? "http://localhost:8811";
const SELLER_ID = process.env.SELLER_ID ?? "vol";
const STAKE_USDC = process.env.STAKE_USDC ?? "1";
const usd = (u: bigint) => formatUnits(u, 6);

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const me = accountFor("BUYER").address;
  const client = gatewayClient();
  console.log(`buyer ${me}\nmarketplace ${BASE}, seller "${SELLER_ID}", stake ${STAKE_USDC} USDC\n`);

  console.log("1. Balances");
  const gw = await ensureGatewayBalance(client, 10_000n);
  console.log(`  gateway available ${gw.gateway.formattedAvailable} USDC`);
  await ensureDeposit("BUYER", parseUnits(STAKE_USDC, 6));
  const escrowBefore = await escrowBalance(me);
  console.log(`  escrow free balance ${usd(escrowBefore)} USDC`);

  console.log("2. Discover");
  const { sellers } = await getJson<{ sellers: { id: string; address: string; bondUsdc: string; fee: string }[] }>("/sellers");
  const seller = sellers.find((s) => s.id === SELLER_ID);
  if (!seller) throw new Error(`no seller "${SELLER_ID}"`);
  console.log(`  seller ${seller.id} ${seller.address} bond ${seller.bondUsdc} USDC, fee ${seller.fee}`);
  type Listed = { symbol: string; title: string; secondsLeft: number; bid: number; ask: number; strike: string | null };
  const markets = await getJson<Listed[]>("/markets");
  // Prefer windows that have started (strike known), then a book comfortably inside the 10¢ limit, then the soonest.
  const rank = (m: Listed) => [m.strike ? 0 : 1, m.ask - m.bid > 0.06 ? 1 : 0, m.secondsLeft];
  const candidates = markets
    .filter((m) => m.secondsLeft >= 90)
    .sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    });
  if (candidates.length === 0) throw new Error("no quotable market with ≥ 90 s left; retry in a minute");

  console.log("3. Pay for a quote (x402 → Circle Gateway)");
  let paid: Awaited<ReturnType<typeof buyQuote>> | null = null;
  for (const market of candidates.slice(0, 4)) {
    console.log(`  trying ${market.title} — ${market.symbol}, book ${market.bid}/${market.ask}, ${market.secondsLeft}s left`);
    try {
      paid = await buyQuote(client, BASE, SELLER_ID, market.symbol, STAKE_USDC);
      break;
    } catch (err) {
      console.log(`  refused before payment: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!paid) throw new Error("every candidate market was refused; retry in a minute");
  console.log(`  paid ${paid.formattedAmount} USDC; gateway settlement ${paid.transaction || "(batched)"}`);

  console.log("4. Check the quote");
  const quote = await checkQuote(paid.data, me);
  console.log(`  ok: bound to us, signature valid, m = ${fromPpm(quote.mRef).toFixed(3)} matches live book, swapId ${paid.data.swapId.slice(0, 12)}…`);

  console.log("5. Open the swap");
  const opened = await sendEscrow("BUYER", "open", [quote, paid.data.signature], "open");
  const swapId = (escrowEvents(opened).find((l) => l.eventName === "SwapOpened")?.args as { swapId: Hex }).swapId;

  console.log("6. Wait for the seller to reveal");
  const p = await waitForReveal(swapId);
  console.log(`  ${SELLER_ID} says p = ${fromPpm(p).toFixed(3)} vs market ${fromPpm(quote.mRef).toFixed(3)}`);
  console.log("  (the buyer agent would trade on Gemini here)");

  console.log("7. Wait for Gemini settlement");
  const res = await waitForResolution(paid.data.symbol);
  console.log(`  Gemini resolved ${paid.data.symbol}: ${res.toUpperCase()}`);
  const resolved = await postOutcome(paid.data.symbol, res);
  if (!resolved) console.log("  outcome already on-chain");

  console.log("8. Settle");
  const { receipt, edgeScore, payment } = await settleSwap(swapId);
  const score = Number(edgeScore) / 1e12;
  const escrowAfter = await escrowBalance(me);
  console.log(
    `\nΔ = ${score.toFixed(4)} → ${score > 0 ? "buyer pays seller" : score < 0 ? "seller pays buyer" : "no payment"} ${usd(payment)} USDC`,
  );
  console.log(`buyer escrow ${usd(escrowBefore)} → ${usd(escrowAfter)} USDC (plus ${paid.formattedAmount} USDC quote fee)`);
  console.log(`settle tx ${txUrl(receipt.transactionHash)}`);

  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  appendFileSync(
    resolve(ROOT, "data/swaps.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      via: "marketplace",
      swapId,
      symbol: paid.data.symbol,
      seller: SELLER_ID,
      mRef: quote.mRef,
      p,
      outcome: res,
      edgeScore: edgeScore.toString(),
      payment: payment.toString(),
      fee: paid.amount.toString(),
      openTx: opened.transactionHash,
      settleTx: receipt.transactionHash,
    }) + "\n",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
