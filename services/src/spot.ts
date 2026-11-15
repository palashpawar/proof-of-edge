// Gemini spot data for the underlyings of the crypto up/down markets (public, no key).
const DATA_BASE = process.env.GEMINI_DATA_BASE ?? "https://api.gemini.com";
const HEADERS = { "User-Agent": "proof-of-edge/0.1", Accept: "application/json" };

/** "BTC05M" → "btcusd". */
export function spotSymbolOf(series: string): string {
  const asset = series.replace(/(05M|15M|1H)$/, "").toLowerCase();
  if (!/^[a-z]+$/.test(asset)) throw new Error(`cannot map series ${series} to a spot pair`);
  return `${asset}usd`;
}

export async function spotPrice(pair: string): Promise<number> {
  const res = await fetch(`${DATA_BASE}/v1/pubticker/${pair}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`pubticker ${pair}: HTTP ${res.status}`);
  const t = (await res.json()) as { bid: string; ask: string; last: string };
  const bid = Number(t.bid);
  const ask = Number(t.ask);
  return Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid ? (bid + ask) / 2 : Number(t.last);
}

/**
 * Realised volatility per √second from the last `minutes` 1-minute closes.
 * Candles come newest first as [ms, open, high, low, close, volume].
 */
export async function volPerSqrtSecond(pair: string, minutes = 60): Promise<number> {
  const res = await fetch(`${DATA_BASE}/v2/candles/${pair}/1m`, { headers: HEADERS });
  if (!res.ok) throw new Error(`candles ${pair}: HTTP ${res.status}`);
  const candles = (await res.json()) as number[][];
  const closes = candles
    .slice(0, minutes + 1)
    .map((c) => c[4])
    .filter((x): x is number => typeof x === "number" && x > 0)
    .reverse();
  if (closes.length < 10) throw new Error(`not enough candles for ${pair}`);
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) / Math.sqrt(60);
}

/** Standard normal CDF (Zelen & Severo 26.2.17, |error| < 7.5e-8). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

/**
 * P(S_T > K) for a driftless log-normal price with volatility σ per √second and τ seconds left.
 * This is the digital-option probability the `vol` seller quotes.
 */
export function probAbove(spot: number, strike: number, sigmaPerSqrtSecond: number, secondsLeft: number): number {
  if (secondsLeft <= 0) return spot > strike ? 1 : 0;
  const sd = sigmaPerSqrtSecond * Math.sqrt(secondsLeft);
  if (sd <= 0) return spot > strike ? 1 : 0;
  return normalCdf((Math.log(spot / strike) - (sd * sd) / 2) / sd);
}
