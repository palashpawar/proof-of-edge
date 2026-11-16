// Escrow event index: the single source of truth for the dashboard, leaderboard and keeper.
// Primary feed: QuickNode Streams webhook (ingestRawLogs). Fallback: RPC polling when the Stream is quiet.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { edgeEscrowAbi } from "./abi/EdgeEscrow.ts";
import { publicClient } from "./chain.ts";
import { ROOT, escrowAddress } from "./config.ts";

export interface RawLog {
  address: string;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: string | number | bigint;
  logIndex: string | number;
}

export interface SwapRow {
  swapId: Hex;
  marketId: Hex;
  symbol: string | null;
  seller: Address;
  buyer: Address;
  mRef: number;
  stake: string;
  revealDeadline: number;
  p: number | null;
  outcome: "No" | "Yes" | "Void" | null;
  edgeScore: number | null; // Δ as a fraction
  payment: string | null; // 6-decimal units, signed: + seller earned, − seller paid
  status: "Open" | "Revealed" | "Settled" | "Forfeited" | "Refunded";
  openTx: Hex;
  settleTx: Hex | null;
  openedBlock: number;
}

const OUTCOMES = ["Unresolved", "No", "Yes", "Void"] as const;
const dataDir = resolve(ROOT, "data");
const logFile = resolve(dataDir, "escrow-logs.jsonl");
const cursorFile = resolve(dataDir, "escrow-cursor.json");
const DEPLOY_BLOCK = 72385554n; // from contracts/broadcast/Deploy.s.sol/5042002/run-latest.json
const CHUNK = 5000n; // Arc RPC rejects larger eth_getLogs ranges

const seen = new Set<string>();
export const swaps = new Map<Hex, SwapRow>();
export const symbols = new Map<Hex, string>(); // marketId → instrument symbol
export const stream = { webhookBatches: 0, webhookLogs: 0, lastWebhookAt: null as string | null, polledLogs: 0 };
let cursor = existsSync(cursorFile) ? BigInt(JSON.parse(readFileSync(cursorFile, "utf8")).next) : DEPLOY_BLOCK;

type Listener = (row: SwapRow, event: string) => void;
const listeners: Listener[] = [];
export const onSwapEvent = (fn: Listener) => listeners.push(fn);

const symbolFile = resolve(dataDir, "symbols.json");
if (existsSync(symbolFile)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(symbolFile, "utf8")))) symbols.set(k as Hex, v as string);

/** marketId is a hash, so the symbol is learned from quotes (marketplace) or MarketResolved events. */
export function rememberSymbol(marketId: Hex, symbol: string) {
  if (symbols.get(marketId) !== symbol) {
    symbols.set(marketId, symbol);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(symbolFile, JSON.stringify(Object.fromEntries(symbols)));
  }
  for (const row of swaps.values()) if (row.marketId === marketId && !row.symbol) row.symbol = symbol;
}

function apply(log: RawLog) {
  let ev;
  try {
    ev = decodeEventLog({ abi: edgeEscrowAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
  } catch {
    return; // not one of ours (e.g. OwnershipTransferred is fine to skip)
  }
  const a = ev.args as Record<string, unknown>;
  const id = a.swapId as Hex | undefined;
  const row = id ? swaps.get(id) : undefined;
  switch (ev.eventName) {
    case "SwapOpened": {
      const marketId = a.marketId as Hex;
      const r: SwapRow = {
        swapId: id!,
        marketId,
        symbol: symbols.get(marketId) ?? null,
        seller: getAddress(a.seller as string),
        buyer: getAddress(a.buyer as string),
        mRef: Number(a.mRef),
        stake: String(a.stake),
        revealDeadline: Number(a.revealDeadline),
        p: null,
        outcome: null,
        edgeScore: null,
        payment: null,
        status: "Open",
        openTx: log.transactionHash,
        settleTx: null,
        openedBlock: Number(log.blockNumber),
      };
      swaps.set(id!, r);
      return listeners.forEach((fn) => fn(r, "opened"));
    }
    case "ForecastRevealed":
      if (!row) return;
      row.p = Number(a.p);
      row.status = "Revealed";
      return listeners.forEach((fn) => fn(row, "revealed"));
    case "MarketResolved": {
      const marketId = a.marketId as Hex;
      rememberSymbol(marketId, String(a.instrumentSymbol));
      const outcome = OUTCOMES[Number(a.outcome)];
      if (!outcome || outcome === "Unresolved") return;
      for (const r of swaps.values()) if (r.marketId === marketId) r.outcome = outcome;
      return;
    }
    case "SwapSettled": {
      if (!row) return;
      const delta = BigInt(a.edgeScore as bigint);
      const pay = BigInt(a.payment as bigint);
      row.outcome = OUTCOMES[Number(a.outcome)] as SwapRow["outcome"];
      row.edgeScore = Number(delta) / 1e12;
      row.payment = (delta > 0n ? pay : -pay).toString();
      row.status = "Settled";
      row.settleTx = log.transactionHash;
      return listeners.forEach((fn) => fn(row, "settled"));
    }
    case "SwapForfeited":
      if (!row) return;
      row.status = "Forfeited";
      row.payment = (-BigInt(row.stake)).toString();
      row.settleTx = log.transactionHash;
      return;
    case "SwapRefunded":
      if (row) row.status = "Refunded";
      return;
  }
}

/** Idempotent: duplicates (Stream retries, overlap with polling) are ignored. */
export function ingestRawLogs(logs: RawLog[], source: "stream" | "poll" | "disk"): number {
  const escrow = escrowAddress().toLowerCase();
  let fresh = 0;
  const sorted = [...logs].sort(
    (x, y) => Number(x.blockNumber) - Number(y.blockNumber) || Number(x.logIndex) - Number(y.logIndex),
  );
  for (const log of sorted) {
    if (log.address.toLowerCase() !== escrow) continue;
    const key = `${log.transactionHash}:${Number(log.logIndex)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh++;
    if (source !== "disk") {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(logFile, JSON.stringify({ ...log, blockNumber: Number(log.blockNumber), logIndex: Number(log.logIndex) }) + "\n");
    }
    apply(log);
  }
  if (source === "stream") stream.webhookLogs += fresh;
  if (source === "poll") stream.polledLogs += fresh;
  return fresh;
}

async function pollRange(from: bigint, to: bigint) {
  const logs = await publicClient.getLogs({ address: escrowAddress(), fromBlock: from, toBlock: to });
  ingestRawLogs(
    logs.map((l) => ({
      address: l.address,
      topics: l.topics as Hex[],
      data: l.data,
      transactionHash: l.transactionHash!,
      blockNumber: l.blockNumber!,
      logIndex: l.logIndex!,
    })),
    "poll",
  );
}

/** Catches up from the saved cursor to the chain head in RPC-sized chunks. */
export async function catchUp() {
  const head = await publicClient.getBlockNumber();
  while (cursor <= head) {
    const to = cursor + CHUNK - 1n < head ? cursor + CHUNK - 1n : head;
    await pollRange(cursor, to);
    cursor = to + 1n;
    writeFileSync(cursorFile, JSON.stringify({ next: cursor.toString() }));
  }
}

export async function startIndexer({ pollMs = 5_000 } = {}) {
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    ingestRawLogs(lines.map((l) => JSON.parse(l) as RawLog), "disk");
  }
  await catchUp();
  // Safety net next to the Stream: one cheap getLogs per tick; duplicates are dropped by ingestRawLogs.
  setInterval(() => void catchUp().catch((e) => console.error("index poll:", e instanceof Error ? e.message : e)), pollMs);
}

// ───────────────────────────── leaderboard ─────────────────────────────

export interface SellerStats {
  address: Address;
  n: number;
  meanEdge: number | null;
  ci95: [number, number] | null;
  netUsdc: number;
  wins: number;
}

export function leaderboard(): SellerStats[] {
  const by = new Map<Address, SwapRow[]>();
  for (const r of swaps.values()) if (r.status === "Settled" && r.outcome !== "Void") by.set(r.seller, [...(by.get(r.seller) ?? []), r]);
  return [...by.entries()].map(([address, rows]) => {
    const xs = rows.map((r) => r.edgeScore ?? 0);
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
    const half = sd === null ? null : (1.96 * sd) / Math.sqrt(n);
    return {
      address,
      n,
      meanEdge: mean,
      ci95: half === null ? null : [mean - half, mean + half],
      netUsdc: rows.reduce((a, r) => a + Number(r.payment ?? 0), 0) / 1e6,
      wins: xs.filter((x) => x > 0).length,
    };
  });
}
