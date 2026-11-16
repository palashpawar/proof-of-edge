// Data-collection buyer: every round, buys one forecast from every seller on the same live market
// and opens the swaps. No LLM; the server's keeper settles them. Fills the leaderboard so the agent
// can tell proven sellers from unproven ones.
//   npm run collect -- --rounds 12
import { formatUnits, parseUnits, type Hex } from "viem";
import { ensureDeposit, escrowEvents, sendEscrow } from "./chain.ts";
import { accountFor } from "./config.ts";
import { buyQuote, checkQuote, ensureGatewayBalance, gatewayClient, waitForReveal } from "./buyer.ts";
import { fromPpm } from "./quote.ts";

const BASE = process.env.MARKETPLACE_URL ?? "http://localhost:8811";
const STAKE = process.env.STAKE_USDC ?? "0.25";
const GAP_MS = 150_000;
const SELLERS = ["echo", "vol", "overconfident"];

type Listed = { symbol: string; title: string; secondsLeft: number; bid: number; ask: number; strike: string | null };

async function round(n: number, client: ReturnType<typeof gatewayClient>, me: `0x${string}`) {
  const markets = (await (await fetch(`${BASE}/markets`)).json()) as Listed[];
  // A started window (strike known) with time for three quotes. Wide books jump between quote and open,
  // which the buyer's 2-point reference check rightly refuses, so prefer books ≤ 5¢ wide.
  const started = markets.filter((x) => x.strike && x.secondsLeft >= 100);
  const m = (started.filter((x) => x.ask - x.bid <= 0.05 + 1e-9).length ? started.filter((x) => x.ask - x.bid <= 0.05 + 1e-9) : started)
    .sort((a, b) => a.ask - a.bid - (b.ask - b.bid) || a.secondsLeft - b.secondsLeft)[0];
  if (!m) return console.log(`round ${n}: no started market with ≥100 s left; skipping`);
  console.log(`round ${n}: ${m.symbol} book ${m.bid}/${m.ask}, ${m.secondsLeft}s left`);
  await ensureDeposit("BUYER", parseUnits(STAKE, 6) * BigInt(SELLERS.length));
  for (const seller of SELLERS) {
    try {
      const paid = await buyQuote(client, BASE, seller, m.symbol, STAKE);
      const quote = await checkQuote(paid.data, me);
      const opened = await sendEscrow("BUYER", "open", [quote, paid.data.signature], `open ${seller}`);
      const swapId = (escrowEvents(opened).find((l) => l.eventName === "SwapOpened")?.args as { swapId: Hex }).swapId;
      const p = await waitForReveal(swapId);
      console.log(`  ${seller.padEnd(13)} p=${fromPpm(p).toFixed(3)} m=${fromPpm(quote.mRef).toFixed(3)}`);
    } catch (err) {
      console.log(`  ${seller} skipped: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
}

async function main() {
  const rounds = Number(process.argv[process.argv.indexOf("--rounds") + 1] ?? 1) || 1;
  const client = gatewayClient();
  const me = accountFor("BUYER").address;
  const gw = await ensureGatewayBalance(client, BigInt(SELLERS.length * rounds) * 1_000n, "0.1");
  console.log(`collector: ${rounds} rounds × ${SELLERS.length} sellers, stake ${STAKE}, gateway ${formatUnits(gw.gateway.available, 6)} USDC`);
  for (let i = 1; i <= rounds; i++) {
    await round(i, client, me);
    if (i < rounds) await new Promise((r) => setTimeout(r, GAP_MS));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
