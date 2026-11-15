// Authenticated Gemini prediction-market trading (sandbox by default).
// Auth: base64 JSON payload {request, nonce, ...params}, HMAC-SHA384 hex signature with the API secret.
import { createHmac } from "node:crypto";
import "./config.ts"; // loads .env

const BASE = process.env.GEMINI_API_BASE ?? "https://api.sandbox.gemini.com";
export const IS_SANDBOX = BASE.includes("sandbox");

let lastNonce = 0;
const nextNonce = () => (lastNonce = Math.max(Date.now(), lastNonce + 1));

export const hasTradingKey = () => Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_SECRET);

export class GeminiApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${path}: HTTP ${status} ${body.slice(0, 300)}`);
  }
}

export function privatePost<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  return privateRequest<T>("POST", path, params);
}

/** Some endpoints (e.g. terms status) are authenticated GETs with the same signed headers. */
export function privateGet<T>(path: string): Promise<T> {
  return privateRequest<T>("GET", path, {});
}

async function privateRequest<T>(method: "GET" | "POST", path: string, params: Record<string, unknown>): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  const secret = process.env.GEMINI_API_SECRET;
  if (!key || !secret) throw new Error("GEMINI_API_KEY / GEMINI_API_SECRET missing from .env");
  const payload = Buffer.from(JSON.stringify({ request: path, nonce: nextNonce(), ...params })).toString("base64");
  const signature = createHmac("sha384", secret).update(payload).digest("hex");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "no-cache",
      "User-Agent": "proof-of-edge/0.1",
      "X-GEMINI-APIKEY": key,
      "X-GEMINI-PAYLOAD": payload,
      "X-GEMINI-SIGNATURE": signature,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new GeminiApiError(path, res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface PmOrder {
  orderId: number;
  status: "open" | "filled" | "cancelled" | string;
  symbol: string;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  quantity: string;
  filledQuantity?: string;
  price: string;
}

export interface PlaceOrder {
  symbol: string;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  quantity: string;
  price: string;
  timeInForce?: "good-til-cancel" | "immediate-or-cancel" | "fill-or-kill";
  makerOrCancel?: boolean;
}

export const termsStatus = () => privateGet<Record<string, unknown>>("/v1/prediction-markets/terms/status");
export const placeOrder = (o: PlaceOrder) => privatePost<PmOrder>("/v1/prediction-markets/order", { orderType: "limit", ...o });
export const cancelOrder = (orderId: number) =>
  privatePost<{ result?: string; message?: string }>("/v1/prediction-markets/order/cancel", { orderId });
export const activeOrders = () => privatePost<PmOrder[] | { orders?: PmOrder[] }>("/v1/prediction-markets/orders/active");
