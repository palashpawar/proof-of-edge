// Proof of Edge marketplace: forecast sellers behind x402 (Circle Gateway nanopayments on Arc).
//
//   GET /health                          free
//   GET /sellers                         free  catalog: id, address, fee, description, escrow bond
//   GET /markets                         free  live Gemini 5/15-minute markets a seller will quote
//   GET /forecast/:seller/:symbol        x402  signed quote with a committed forecast, bound to the payer
//
// After the buyer opens the swap on-chain, the seller reveals its forecast automatically.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { formatUnits, getAddress, isAddress, parseUnits, type Hex } from "viem";
import { Status, chainTime, ensureDeposit, escrowBalance, readSwap, sendEscrow } from "./chain.ts";
import { ROOT, accountFor, addressUrl, escrowAddress } from "./config.ts";
import { SELLER_SPECS, type SellerSpec } from "./forecasters.ts";
import { MAX_SPREAD, MIN_SECONDS_LEFT, isQuotable, loadMarket, shortMarkets, type Market } from "./markets.ts";
import { commitmentOf, marketIdOf, randomNonce, randomSalt, signQuote, swapIdOf, toPpm, toWire, type Quote } from "./quote.ts";

const PORT = Number(process.env.MARKETPLACE_PORT ?? 8811);
const FEE = process.env.QUOTE_FEE ?? "$0.001";
const ARC_TESTNET = "eip155:5042002";
const GATEWAY_TESTNET = "https://gateway-api-testnet.circle.com";
const DEFAULT_STAKE = parseUnits("1", 6);
const MAX_STAKE = parseUnits(process.env.MAX_STAKE_USDC ?? "2", 6);
const SELLER_BOND = parseUnits(process.env.SELLER_BOND_USDC ?? "2", 6);
const QUOTE_TTL_S = 30n;
const REVEAL_WINDOW_S = 120n;
const SWEEP_MS = 3_000;

// ───────────────────────── pending reveals (persisted) ─────────────────────────

interface Pending {
  sellerId: string;
  symbol: string;
  p: number;
  salt: Hex;
  expiry: string;
  createdAt: string;
}

const pendingPath = resolve(ROOT, "data/pending-reveals.json");
const pending = new Map<Hex, Pending>(
  existsSync(pendingPath) ? (Object.entries(JSON.parse(readFileSync(pendingPath, "utf8"))) as [Hex, Pending][]) : [],
);
function persist() {
  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  writeFileSync(pendingPath, JSON.stringify(Object.fromEntries(pending), null, 2));
}

const specById = new Map(SELLER_SPECS.map((s) => [s.id, s]));
const revealing = new Set<Hex>();

/** Reveals every pending forecast whose swap is open; drops quotes that expired unopened. */
async function sweep(only?: Hex) {
  const now = await chainTime();
  for (const [swapId, entry] of pending) {
    if ((only && swapId !== only) || revealing.has(swapId)) continue;
    const spec = specById.get(entry.sellerId);
    if (!spec) continue;
    revealing.add(swapId);
    try {
      const swap = await readSwap(swapId);
      if (swap.status === Status.Open) {
        await sendEscrow(spec.role, "reveal", [swapId, entry.p, entry.salt], `reveal ${spec.id}`);
        pending.delete(swapId);
      } else if (swap.status === Status.None && now > BigInt(entry.expiry)) {
        pending.delete(swapId); // buyer never opened it
      } else if (swap.status === Status.Revealed || swap.status === Status.Settled) {
        pending.delete(swapId);
      }
    } catch (err) {
      console.error(`reveal ${swapId.slice(0, 10)}… failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      revealing.delete(swapId);
      persist();
    }
  }
}

// ──────────────────────────────── handlers ────────────────────────────────

function parseStake(raw: unknown): bigint | null {
  if (raw === undefined) return DEFAULT_STAKE;
  if (typeof raw !== "string" || !/^\d+(\.\d{1,6})?$/.test(raw)) return null;
  const stake = parseUnits(raw, 6);
  return stake > 0n && stake <= MAX_STAKE ? stake : null;
}

interface Checked {
  market: Market & { book: NonNullable<Market["book"]> };
  stake: bigint;
}

/**
 * Runs before the x402 paywall, on both the unpaid and the paid request, so anything that would
 * make the seller refuse is rejected before a fee is ever charged. The paid handler then uses
 * this exact snapshot of the book.
 */
function precheck(spec: SellerSpec) {
  const seller = accountFor(spec.role);
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stake = parseStake(req.query.stake);
      if (stake === null) return res.status(400).json({ error: `stake must be a USDC amount in (0, ${formatUnits(MAX_STAKE, 6)}]` });
      const symbol = String(req.params.symbol);
      const market = await loadMarket(symbol);
      if (!market) return res.status(404).json({ error: `unknown market ${symbol}` });
      if (!isQuotable(market)) {
        return res.status(409).json({
          error: `not quotable: needs a two-sided book with spread ≤ ${MAX_SPREAD} and ≥ ${MIN_SECONDS_LEFT}s left`,
          book: market.book,
          secondsLeft: Math.round(market.secondsLeft),
        });
      }
      if ((await escrowBalance(seller.address)) < stake) return res.status(409).json({ error: "seller bond too low for this stake" });
      res.locals.checked = { market, stake } satisfies Checked;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function quoteHandler(spec: SellerSpec) {
  const seller = accountFor(spec.role);
  return async (req: Request, res: Response) => {
    const payment = (req as Request & { payment?: { payer?: string; amount?: string } }).payment;
    const payer = payment?.payer;
    if (!payer || !isAddress(payer)) return res.status(402).json({ error: "payment required" });
    const buyer = getAddress(payer);
    const { market, stake } = res.locals.checked as Checked;
    const symbol = market.contract.instrumentSymbol;

    const marketId = marketIdOf(symbol);
    const mRef = toPpm(market.book.mid);
    const p = await spec.forecaster({ mRef, event: market.event, contract: market.contract });
    const salt = randomSalt();
    const now = await chainTime();
    const quote: Quote = {
      seller: seller.address,
      buyer,
      marketId,
      mRef,
      stake,
      expiry: now + QUOTE_TTL_S,
      revealDeadline: now + REVEAL_WINDOW_S,
      commit: commitmentOf(marketId, p, salt),
      nonce: randomNonce(),
    };
    const escrow = escrowAddress();
    const signature = await signQuote(seller, escrow, quote);
    const swapId = swapIdOf(escrow, quote);

    pending.set(swapId, { sellerId: spec.id, symbol, p, salt, expiry: quote.expiry.toString(), createdAt: new Date().toISOString() });
    persist();
    console.log(`quote ${spec.id} → ${buyer.slice(0, 8)}… ${symbol} m=${(mRef / 1e6).toFixed(3)} stake ${formatUnits(stake, 6)} (fee ${payment?.amount ?? "?"} units)`);

    res.json({
      seller: spec.id,
      symbol,
      swapId,
      quote: toWire(quote),
      signature,
      market: { bid: market.book.bid, ask: market.book.ask, mid: market.book.mid, expiry: market.event.expiryDate },
      escrow,
    });
  };
}

// ────────────────────────────────── app ───────────────────────────────────

const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true, escrow: escrowAddress(), pendingReveals: pending.size });
});

app.get("/sellers", async (_req, res) => {
  const sellers = await Promise.all(
    SELLER_SPECS.map(async (s) => {
      const address = accountFor(s.role).address;
      return {
        id: s.id,
        address,
        description: s.description,
        fee: FEE,
        maxStakeUsdc: formatUnits(MAX_STAKE, 6),
        bondUsdc: formatUnits(await escrowBalance(address), 6),
        endpoint: `/forecast/${s.id}/:symbol?stake=1`,
      };
    }),
  );
  res.json({ network: ARC_TESTNET, escrow: escrowAddress(), sellers });
});

app.get("/markets", async (_req, res) => {
  const markets = (await shortMarkets()).filter((m) => isQuotable(m));
  res.json(
    markets.map((m) => ({
      symbol: m.contract.instrumentSymbol,
      title: m.event.title,
      expiry: m.event.expiryDate,
      secondsLeft: Math.round(m.secondsLeft),
      bid: m.book?.bid,
      ask: m.book?.ask,
      strike: m.contract.strike?.value ?? null,
    })),
  );
});

for (const spec of SELLER_SPECS) {
  const gateway = createGatewayMiddleware({
    sellerAddress: accountFor(spec.role).address,
    networks: [ARC_TESTNET],
    facilitatorUrl: GATEWAY_TESTNET,
    description: `Proof of Edge forecast from "${spec.id}"`,
  });
  app.get(`/forecast/${spec.id}/:symbol`, precheck(spec), gateway.require(FEE) as never, quoteHandler(spec));
}

/** Lets an event pipeline (QuickNode Streams, next) trigger an immediate reveal. */
export async function onSwapOpened(swapId: Hex) {
  if (pending.has(swapId)) await sweep(swapId);
}

async function main() {
  console.log("Topping up seller bonds…");
  for (const spec of SELLER_SPECS) await ensureDeposit(spec.role, SELLER_BOND);
  setInterval(() => void sweep(), SWEEP_MS);
  app.listen(PORT, () => {
    console.log(`Proof of Edge marketplace on http://localhost:${PORT}  (escrow ${escrowAddress()}, fee ${FEE})`);
    console.log(`explorer: ${addressUrl(escrowAddress())}`);
  });
}

void main();
