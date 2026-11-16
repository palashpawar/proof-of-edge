// Keeper: settles every swap without anyone babysitting it.
//   • Open past its reveal deadline → claimNoReveal (buyer takes both stakes)
//   • Revealed, market settled on Gemini → resolver posts the outcome → settle
import type { Hex } from "viem";
import { chainTime, sendEscrow } from "./chain.ts";
import { eventTickerOf, getEvent, resolutionOf } from "./gemini.ts";
import { swaps } from "./indexer.ts";
import { postOutcome, settleSwap } from "./settlement.ts";
import { accountFor } from "./config.ts";
import { agentIds, alreadyPosted, postFeedback } from "./erc8004.ts";
import { SELLER_SPECS } from "./forecasters.ts";

const sellerIdByAddress = new Map(SELLER_SPECS.map((s) => [accountFor(s.role).address, s.id]));

const failures = new Map<Hex, number>();
let running = false;

async function attempt(id: Hex, what: string, fn: () => Promise<unknown>) {
  if ((failures.get(id) ?? 0) >= 3) return; // stop hammering a swap that keeps reverting
  try {
    await fn();
    failures.delete(id);
  } catch (err) {
    failures.set(id, (failures.get(id) ?? 0) + 1);
    console.error(`keeper ${what} ${id.slice(0, 10)}…: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
}

export async function keeperTick() {
  if (running) return;
  running = true;
  try {
    const now = Number(await chainTime());
    const unresolved = new Set<string>();

    for (const row of swaps.values()) {
      if (row.status === "Open" && now > row.revealDeadline) {
        await attempt(row.swapId, "claimNoReveal", () => sendEscrow("RESOLVER", "claimNoReveal", [row.swapId], "forfeit"));
      } else if (row.status === "Revealed" && row.outcome) {
        await attempt(row.swapId, "settle", () => settleSwap(row.swapId, "RESOLVER"));
      } else if (row.status === "Revealed" && row.symbol) {
        unresolved.add(row.symbol);
      }
    }

    // ERC-8004: publish each settled edge score as reputation feedback (a few per tick).
    let feedbackBudget = 3;
    for (const row of swaps.values()) {
      if (feedbackBudget <= 0) break;
      if (row.status !== "Settled" || row.outcome === "Void" || row.edgeScore === null || !row.settleTx) continue;
      const sellerId = sellerIdByAddress.get(row.seller);
      if (!sellerId || agentIds[sellerId] === undefined || alreadyPosted(row.swapId)) continue;
      feedbackBudget--;
      const { swapId, edgeScore, settleTx } = row;
      await attempt(swapId, "feedback", () => postFeedback({ sellerId, swapId, edgeScore, settleTx }));
    }

    for (const symbol of unresolved) {
      try {
        const res = resolutionOf(await getEvent(eventTickerOf(symbol)), symbol);
        if (res) await postOutcome(symbol, res); // MarketResolved then flows back through the indexer
      } catch (err) {
        console.error(`keeper resolve ${symbol}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      }
    }
  } catch (err) {
    console.error(`keeper: ${err instanceof Error ? err.message.split("\n")[0] : err}`); // e.g. RPC unreachable; retry next tick
  } finally {
    running = false;
  }
}

export function startKeeper(everyMs = 15_000) {
  setInterval(() => void keeperTick(), everyMs);
}
