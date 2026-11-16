// QuickNode Streams filter — Arc Testnet, dataset "block_with_receipts".
// Keeps only logs emitted by the EdgeEscrow contract and delivers them as { logs: [...] }.
// Blocks with no escrow activity are skipped (return null), so the webhook only fires when something happened.
function main(stream) {
  const ESCROW = "0x288a40f4aa06c0a382aa790d4b27857fcf9ef54f";
  const logs = [];
  for (const block of stream.data || []) {
    for (const receipt of block.receipts || []) {
      for (const log of receipt.logs || []) {
        if ((log.address || "").toLowerCase() !== ESCROW) continue;
        logs.push({
          address: log.address,
          topics: log.topics,
          data: log.data,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        });
      }
    }
  }
  return logs.length ? { logs } : null;
}
