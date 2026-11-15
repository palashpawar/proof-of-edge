// Posting Gemini outcomes on-chain and settling swaps (used by scripts now, the resolver service next).
import type { Hex, TransactionReceipt } from "viem";
import { edgeEscrowAbi } from "./abi/EdgeEscrow.ts";
import { escrowEvents, publicClient, sendEscrow } from "./chain.ts";
import { Outcome, escrowAddress } from "./config.ts";
import type { Resolution } from "./gemini.ts";
import { marketIdOf } from "./quote.ts";

export const outcomeOf = (res: Resolution) => (res === "yes" ? Outcome.Yes : res === "no" ? Outcome.No : Outcome.Void);

/** Posts the outcome for `symbol` as the resolver unless it is already on-chain. */
export async function postOutcome(symbol: string, res: Resolution): Promise<TransactionReceipt | null> {
  const current = await publicClient.readContract({
    address: escrowAddress(),
    abi: edgeEscrowAbi,
    functionName: "outcomes",
    args: [marketIdOf(symbol)],
  });
  if (Number(current) !== Outcome.Unresolved) return null;
  return sendEscrow("RESOLVER", "resolve", [symbol, outcomeOf(res)], "resolve");
}

export interface Settlement {
  receipt: TransactionReceipt;
  edgeScore: bigint;
  payment: bigint;
}

export async function settleSwap(swapId: Hex): Promise<Settlement> {
  const receipt = await sendEscrow("BUYER", "settle", [swapId], "settle");
  const log = escrowEvents(receipt).find((l) => l.eventName === "SwapSettled");
  const { edgeScore, payment } = (log?.args ?? { edgeScore: 0n, payment: 0n }) as { edgeScore: bigint; payment: bigint };
  return { receipt, edgeScore, payment };
}
