// Buyer side of the marketplace: pays x402 fees through Circle Gateway, checks every quote
// before committing a stake, and waits for the seller's reveal.
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { Status, chainTime, readSwap } from "./chain.ts";
import { RPC_URL, accountFor, escrowAddress } from "./config.ts";
import { loadMarket } from "./markets.ts";
import { fromWire, swapIdOf, toPpm, verifyQuoteSignature, type Quote, type WireQuote } from "./quote.ts";

/** Hard limits, enforced in code before any money moves. */
export const LIMITS = {
  /** Most the buyer will pay for one quote, in 6-decimal USDC units ($0.01). */
  maxFeeUnits: 10_000n,
  /** Most the buyer will lock in one swap. */
  maxStakeUnits: 2_000_000n,
  /** How far the seller's reference price may sit from the live Gemini mid (ppm, 2 points). */
  maxRefDriftPpm: 20_000,
  /** Quotes about to expire are refused so the open transaction can't fail. */
  minQuoteLifeS: 5n,
} as const;

export interface PaidQuote {
  seller: string;
  symbol: string;
  swapId: Hex;
  quote: WireQuote;
  signature: Hex;
  market: { bid: number; ask: number; mid: number; expiry: string };
  escrow: Address;
}

export function gatewayClient(): GatewayClient {
  const key = accountFor("BUYER");
  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey: process.env.BUYER_PRIVATE_KEY as Hex,
    rpcUrl: RPC_URL,
  });
  if (!isAddressEqual(client.account.address, key.address)) throw new Error("Gateway client key mismatch");
  client.onBeforePaymentCreation(async (ctx) => {
    const amount = BigInt((ctx.selectedRequirements as { amount?: string }).amount ?? "0");
    if (amount > LIMITS.maxFeeUnits) return { abort: true, reason: `quote fee ${amount} exceeds cap ${LIMITS.maxFeeUnits}` };
  });
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Makes sure the buyer has at least `minUnits` available in Circle Gateway, depositing `topUp` USDC if not. */
export async function ensureGatewayBalance(client: GatewayClient, minUnits: bigint, topUp = "0.05") {
  let balances = await client.getBalances();
  if (balances.gateway.available >= minUnits) return balances;
  const dep = await client.deposit(topUp);
  console.log(`  ✓ gateway deposit ${dep.formattedAmount} USDC (tx ${dep.depositTxHash})`);
  for (let i = 0; i < 60; i++) {
    balances = await client.getBalances();
    if (balances.gateway.available >= minUnits) return balances;
    if (i % 6 === 0) console.log(`  … waiting for Gateway to credit the deposit (available ${balances.gateway.formattedAvailable})`);
    await sleep(5_000);
  }
  throw new Error("Gateway deposit not credited after 5 minutes");
}

export async function buyQuote(client: GatewayClient, base: string, sellerId: string, symbol: string, stakeUsdc: string) {
  const url = `${base}/forecast/${encodeURIComponent(sellerId)}/${encodeURIComponent(symbol)}?stake=${stakeUsdc}`;
  const result = await client.pay<PaidQuote>(url);
  if (result.status !== 200) throw new Error(`quote request failed: HTTP ${result.status} ${JSON.stringify(result.data)}`);
  return result;
}

/** Every check the buyer runs before locking a stake. Throws with the first failure. */
export async function checkQuote(paid: PaidQuote, me: Address): Promise<Quote> {
  const q = fromWire(paid.quote);
  const escrow = escrowAddress();
  if (!isAddressEqual(getAddress(paid.escrow), escrow)) throw new Error("quote is for a different escrow");
  if (!isAddressEqual(q.buyer, me)) throw new Error("quote is bound to a different buyer");
  if (q.stake <= 0n || q.stake > LIMITS.maxStakeUnits) throw new Error(`stake ${q.stake} outside limits`);
  if (swapIdOf(escrow, q) !== paid.swapId) throw new Error("swap id does not match the quote");
  if (!(await verifyQuoteSignature(escrow, q, paid.signature))) throw new Error("seller signature invalid");
  if (q.expiry < (await chainTime()) + LIMITS.minQuoteLifeS) throw new Error("quote expires too soon");

  const live = await loadMarket(paid.symbol);
  if (!live?.book) throw new Error("market has no live two-sided book");
  const drift = Math.abs(toPpm(live.book.mid) - q.mRef);
  if (drift > LIMITS.maxRefDriftPpm) throw new Error(`seller reference ${q.mRef} is ${drift} ppm from live mid`);
  return q;
}

/** Waits for the seller to reveal; returns p in ppm. */
export async function waitForReveal(swapId: Hex, timeoutMs = 120_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const swap = await readSwap(swapId);
    if (swap.status === Status.Revealed || swap.status === Status.Settled) return swap.p;
    await sleep(1_500);
  }
  throw new Error("seller did not reveal in time; call claimNoReveal after the deadline");
}
