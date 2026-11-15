import { SCALE, type Role } from "./config.ts";
import { seriesOf, type GeminiContract, type GeminiEvent } from "./gemini.ts";
import { probAbove, spotPrice, spotSymbolOf, volPerSqrtSecond } from "./spot.ts";

export interface ForecastContext {
  /** Market reference YES probability, ppm. */
  mRef: number;
  event: GeminiEvent;
  contract: GeminiContract;
}

/** Returns the seller's YES probability in ppm. */
export type Forecaster = (ctx: ForecastContext) => Promise<number>;

const clamp = (ppm: number) => Math.min(SCALE, Math.max(0, Math.round(ppm)));

/** Repeats the market. Its edge score is exactly zero on every swap. */
export const echo: Forecaster = async ({ mRef }) => mRef;

/** Pushes the market 20 points further from 50/50 (bounded to 5–95%). Worse than the market on average. */
export const overconfident: Forecaster = async ({ mRef }) => {
  const half = SCALE / 2;
  const pushed =
    mRef >= half ? Math.min(0.95 * SCALE, mRef + 0.2 * SCALE) : Math.max(0.05 * SCALE, mRef - 0.2 * SCALE);
  return clamp(pushed);
};

/**
 * Digital-option model for "Up" markets: P(spot at expiry > reference strike) from live Gemini spot
 * and 60-minute realised volatility. Before the window starts the strike is unknown, so it says 50%.
 * Caveat: Gemini settles on a Lukka index, not Gemini spot, so a small basis is ignored.
 */
export const vol: Forecaster = async ({ event, contract }) => {
  const strike = Number(contract.strike?.value);
  if (contract.label !== "Up" || !Number.isFinite(strike) || strike <= 0) return SCALE / 2;
  const pair = spotSymbolOf(seriesOf(event));
  const [spot, sigma] = await Promise.all([spotPrice(pair), volPerSqrtSecond(pair)]);
  const secondsLeft = (Date.parse(event.expiryDate) - Date.now()) / 1000;
  // Keep a sliver of doubt so a single surprise can't cost the full stake.
  return clamp(Math.min(0.99, Math.max(0.01, probAbove(spot, strike, sigma, secondsLeft))) * SCALE);
};

export interface SellerSpec {
  id: string;
  role: Role;
  forecaster: Forecaster;
  description: string;
}

export const SELLER_SPECS: SellerSpec[] = [
  { id: "echo", role: "SELLER_ECHO", forecaster: echo, description: "Repeats the market mid. Never earns, never pays." },
  {
    id: "vol",
    role: "SELLER_VOL",
    forecaster: vol,
    description: "Digital-option model from live spot and 60-minute realised volatility.",
  },
  {
    id: "overconfident",
    role: "SELLER_OVERCONFIDENT",
    forecaster: overconfident,
    description: "Pushes the market 20 points away from 50/50. Should lose on average.",
  },
];
