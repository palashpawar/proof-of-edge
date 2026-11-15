// Finishes one revealed swap: waits for Gemini to settle its market, posts the outcome, settles.
//   npm run settle -- <swapId>
import { formatUnits, isHex, type Hex } from "viem";
import { edgeEscrowAbi } from "./abi/EdgeEscrow.ts";
import { Status, publicClient, readSwap } from "./chain.ts";
import { escrowAddress, txUrl } from "./config.ts";
import { waitForResolution } from "./markets.ts";
import { postOutcome, settleSwap } from "./settlement.ts";

/** Finds the instrument symbol for a swap's market from the escrow's MarketResolved events or the marketplace log. */
async function symbolFor(marketId: Hex): Promise<string | null> {
  const logs = await publicClient.getContractEvents({
    address: escrowAddress(),
    abi: edgeEscrowAbi,
    eventName: "MarketResolved",
    args: { marketId },
    fromBlock: 0n,
  });
  const found = logs[0]?.args.instrumentSymbol;
  return typeof found === "string" ? found : null;
}

async function main() {
  const swapId = process.argv[2] as Hex | undefined;
  const symbolArg = process.argv[3];
  if (!swapId || !isHex(swapId) || swapId.length !== 66) throw new Error("usage: npm run settle -- <swapId> [instrumentSymbol]");

  const swap = await readSwap(swapId);
  if (swap.status === Status.Settled) return console.log("already settled");
  if (swap.status !== Status.Revealed) throw new Error(`swap status ${swap.status}; needs to be Revealed (2)`);

  const symbol = symbolArg ?? (await symbolFor(swap.marketId));
  if (!symbol) throw new Error("market not resolved on-chain yet; pass the instrument symbol as the second argument");

  const res = await waitForResolution(symbol);
  console.log(`Gemini resolved ${symbol}: ${res.toUpperCase()}`);
  await postOutcome(symbol, res);
  const { receipt, edgeScore, payment } = await settleSwap(swapId);
  const score = Number(edgeScore) / 1e12;
  console.log(`Δ = ${score.toFixed(4)} → ${score > 0 ? "buyer pays seller" : score < 0 ? "seller pays buyer" : "no payment"} ${formatUnits(payment, 6)} USDC`);
  console.log(`settle ${txUrl(receipt.transactionHash)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
