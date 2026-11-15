import { SCALE } from "./config.ts";

/** A forecaster maps the market reference probability (ppm) to its own forecast (ppm). */
export type Forecaster = (mRef: number) => number;

const clamp = (ppm: number) => Math.min(SCALE, Math.max(0, Math.round(ppm)));

/** Repeats the market. Its edge score is exactly zero on every swap. */
export const echo: Forecaster = (m) => m;

/** Pushes the market 20 points further from 50/50 (bounded to 5–95%). Worse than the market on average. */
export const overconfident: Forecaster = (m) => {
  const half = SCALE / 2;
  const pushed = m >= half ? Math.min(0.95 * SCALE, m + 0.2 * SCALE) : Math.max(0.05 * SCALE, m - 0.2 * SCALE);
  return clamp(pushed);
};
