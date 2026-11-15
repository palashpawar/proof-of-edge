// Gemini prediction-market data (public endpoints, no key needed).
const DATA_BASE = process.env.GEMINI_DATA_BASE ?? "https://api.gemini.com";
const HEADERS = { "User-Agent": "proof-of-edge/0.1", Accept: "application/json" };

export interface GeminiPrices {
  bestBid?: string;
  bestAsk?: string;
  lastTradePrice?: string;
  buy?: { yes?: string; no?: string };
  sell?: { yes?: string; no?: string };
}

export interface GeminiContract {
  label: string;
  instrumentSymbol: string;
  status: string;
  marketState?: string;
  prices?: GeminiPrices;
  strike?: { type?: string; value?: string; availableAt?: string };
  resolutionSide?: string | null;
  settlementValue?: string | null;
  resolvedAt?: string | null;
}

export interface GeminiEvent {
  ticker: string;
  title: string;
  status: string;
  category?: string;
  expiryDate: string;
  series?: string | { ticker?: string };
  contracts: GeminiContract[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with retries on network errors, 429 and 5xx (Gemini returns occasional 503s). */
async function getJson<T>(path: string, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${DATA_BASE}${path}`, { headers: HEADERS });
      if (res.ok) return (await res.json()) as T;
      last = new Error(`Gemini ${path}: HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw last;
    } catch (err) {
      last = err;
      if (err instanceof Error && /HTTP 4\d\d/.test(err.message) && !/HTTP 429/.test(err.message)) throw err;
    }
    await sleep(1_000 * 2 ** i);
  }
  throw last;
}

export async function activeCryptoEvents(): Promise<GeminiEvent[]> {
  const body = await getJson<{ data: GeminiEvent[] }>(
    "/v1/prediction-markets/events?status=active&category=Crypto&limit=200",
  );
  return body.data;
}

export async function getEvent(ticker: string): Promise<GeminiEvent> {
  const body = await getJson<GeminiEvent | { data: GeminiEvent }>(
    `/v1/prediction-markets/events/${encodeURIComponent(ticker)}`,
  );
  return "data" in body ? body.data : body;
}

export function seriesOf(event: GeminiEvent): string {
  return (typeof event.series === "string" ? event.series : event.series?.ticker) ?? "";
}

export interface Book {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
}

/** Two-sided YES book for a contract, or null if either side is missing. */
export function bookOf(contract: GeminiContract): Book | null {
  const p = contract.prices ?? {};
  const bid = Number(p.bestBid ?? p.sell?.yes);
  const ask = Number(p.bestAsk ?? p.buy?.yes);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return null;
  return { bid, ask, mid: (bid + ask) / 2, spread: ask - bid };
}

export type Resolution = "yes" | "no" | "void";

/** Settled outcome for one contract of an event, or null while it is still open. */
export function resolutionOf(event: GeminiEvent, instrumentSymbol: string): Resolution | null {
  const contract = event.contracts.find((c) => c.instrumentSymbol === instrumentSymbol);
  if (!contract) throw new Error(`${instrumentSymbol} not found in ${event.ticker}`);
  const side = contract.resolutionSide?.toLowerCase();
  if (contract.status === "settled" && (side === "yes" || side === "no")) return side;
  if (["cancelled", "canceled", "voided", "void"].includes(contract.status)) return "void";
  return null;
}

/** "BTC05M2611150340" from "GEMI-BTC05M2611150340-UP". */
export function eventTickerOf(instrumentSymbol: string): string {
  const parts = instrumentSymbol.split("-");
  if (parts.length < 3 || parts[0] !== "GEMI") throw new Error(`unexpected symbol ${instrumentSymbol}`);
  return parts.slice(1, -1).join("-");
}
