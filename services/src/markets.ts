// Market selection and settlement polling shared by the marketplace, buyer and scripts.
import {
  activeCryptoEvents,
  bookOf,
  eventTickerOf,
  getEvent,
  resolutionOf,
  seriesOf,
  type Book,
  type GeminiContract,
  type GeminiEvent,
  type Resolution,
} from "./gemini.ts";

export const MAX_SPREAD = 0.1;
export const MIN_SECONDS_LEFT = 60;
export const SHORT_SERIES = ["BTC05M", "ETH05M", "SOL05M", "XRP05M", "BTC15M", "ETH15M", "SOL15M", "XRP15M"];

export interface Market {
  event: GeminiEvent;
  contract: GeminiContract;
  book: Book | null;
  secondsLeft: number;
}

const secondsUntil = (iso: string) => (Date.parse(iso) - Date.now()) / 1000;

export function isQuotable(m: Market, minSecondsLeft = MIN_SECONDS_LEFT): m is Market & { book: Book } {
  // Small epsilon: 0.35 − 0.25 is 0.09999… in floating point.
  return m.book !== null && m.book.spread <= MAX_SPREAD + 1e-9 && m.secondsLeft >= minSecondsLeft && m.contract.status === "active";
}

/** Live 5/15-minute "Up" markets, soonest first. */
export async function shortMarkets(maxSecondsLeft = 20 * 60): Promise<Market[]> {
  const out: Market[] = [];
  for (const event of await activeCryptoEvents()) {
    if (!SHORT_SERIES.includes(seriesOf(event))) continue;
    const secondsLeft = secondsUntil(event.expiryDate);
    if (secondsLeft <= 0 || secondsLeft > maxSecondsLeft) continue;
    const contract = event.contracts.find((c) => c.label === "Up");
    if (contract) out.push({ event, contract, book: bookOf(contract), secondsLeft });
  }
  return out.sort(
    (a, b) => a.secondsLeft - b.secondsLeft || SHORT_SERIES.indexOf(seriesOf(a.event)) - SHORT_SERIES.indexOf(seriesOf(b.event)),
  );
}

/** Fresh state of one contract by instrument symbol, e.g. "GEMI-BTC05M2611151645-UP". */
export async function loadMarket(symbol: string): Promise<Market | null> {
  let event: GeminiEvent;
  try {
    event = await getEvent(eventTickerOf(symbol));
  } catch {
    return null;
  }
  const contract = event.contracts.find((c) => c.instrumentSymbol === symbol);
  if (!contract) return null;
  return { event, contract, book: bookOf(contract), secondsLeft: secondsUntil(event.expiryDate) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForResolution(
  symbol: string,
  { pollMs = 10_000, timeoutMs = 30 * 60_000, log = (s: string) => console.log(s) } = {},
): Promise<Resolution> {
  const ticker = eventTickerOf(symbol);
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < deadline; i++) {
    try {
      const res = resolutionOf(await getEvent(ticker), symbol);
      if (res) return res;
    } catch (err) {
      log(`  … Gemini unavailable (${err instanceof Error ? err.message : err}); retrying`);
    }
    if (i % 6 === 0) log(`  … waiting for Gemini to settle ${ticker}`);
    await sleep(pollMs);
  }
  throw new Error(`${symbol} did not settle within ${Math.round(timeoutMs / 60_000)} minutes`);
}
