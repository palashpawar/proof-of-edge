// Places one resting, non-marketable limit order on the Gemini SANDBOX and cancels it.
// Proves auth, terms and order plumbing without any chance of a fill.
import { GeminiApiError, IS_SANDBOX, activeOrders, cancelOrder, hasTradingKey, placeOrder, termsStatus } from "./gemini-trade.ts";
import { bookOf, seriesOf, type GeminiEvent } from "./gemini.ts";

const SANDBOX_DATA = "https://api.sandbox.gemini.com";

async function sandboxEvents(): Promise<GeminiEvent[]> {
  const res = await fetch(`${SANDBOX_DATA}/v1/prediction-markets/events?status=active&limit=100`, {
    headers: { "User-Agent": "proof-of-edge/0.1" },
  });
  if (!res.ok) throw new Error(`sandbox events: HTTP ${res.status}`);
  return ((await res.json()) as { data: GeminiEvent[] }).data;
}

async function main() {
  if (!IS_SANDBOX) throw new Error("Refusing to run: GEMINI_API_BASE is not the sandbox.");
  if (!hasTradingKey()) throw new Error("Add GEMINI_API_KEY and GEMINI_API_SECRET (sandbox) to .env first.");

  console.log("1. Terms status");
  try {
    console.log(" ", JSON.stringify(await termsStatus()));
  } catch (err) {
    console.log(`  could not read terms status: ${err instanceof Error ? err.message : err}`);
  }

  console.log("2. Pick a sandbox contract");
  const events = await sandboxEvents();
  const pick = events
    .flatMap((e) => e.contracts.filter((c) => c.status === "active").map((c) => ({ e, c, book: bookOf(c) })))
    .sort((a, b) => Number(Boolean(b.book)) - Number(Boolean(a.book)))[0];
  if (!pick) throw new Error("no active sandbox contracts");
  console.log(`  ${pick.e.title} [${seriesOf(pick.e)}] ${pick.c.instrumentSymbol} book ${pick.book ? `${pick.book.bid}/${pick.book.ask}` : "none"}`);

  console.log("3. Place a resting 1-contract BUY YES at $0.01 (maker-only)");
  let order;
  try {
    order = await placeOrder({
      symbol: pick.c.instrumentSymbol,
      side: "buy",
      outcome: "yes",
      quantity: "1",
      price: "0.01",
      timeInForce: "good-til-cancel",
      makerOrCancel: true,
    });
  } catch (err) {
    if (err instanceof GeminiApiError && /TERMS/i.test(err.body)) {
      throw new Error("Prediction-market terms not accepted on this sandbox account. Accept them in the sandbox web UI, then rerun.");
    }
    if (err instanceof GeminiApiError && /InvalidApiKey/i.test(err.body)) {
      throw new Error(
        "The sandbox does not recognise this key. Create an account-level key (Trader role) at exchange.sandbox.gemini.com → Settings → API; production keys and master keys do not work here.",
      );
    }
    throw err;
  }
  console.log(`  order ${order.orderId} status ${order.status}, filled ${order.filledQuantity ?? "0"}`);

  console.log("4. Active orders");
  const active = await activeOrders();
  const list = Array.isArray(active) ? active : (active.orders ?? []);
  console.log(`  ${list.length} active; ours present: ${list.some((o) => o.orderId === order.orderId)}`);

  console.log("5. Cancel");
  console.log(" ", JSON.stringify(await cancelOrder(order.orderId)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
