// Creates the QuickNode Stream that feeds the marketplace webhook.
//   PUBLIC_URL=https://<host> npm run stream:create
// Needs QUICKNODE_API_KEY in .env. Generates QUICKNODE_STREAM_TOKEN into .env if it is missing.
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, escrowAddress } from "./config.ts";

const API = "https://api.quicknode.com/streams/rest/v1/streams";
const NETWORK = process.env.QUICKNODE_NETWORK ?? "arc-testnet";

async function main() {
  const apiKey = process.env.QUICKNODE_API_KEY;
  const publicUrl = process.env.PUBLIC_URL;
  if (!apiKey) throw new Error("QUICKNODE_API_KEY missing from .env");
  if (!publicUrl?.startsWith("https://")) throw new Error("set PUBLIC_URL=https://… (the marketplace's public address)");

  let token = process.env.QUICKNODE_STREAM_TOKEN;
  if (!token) {
    token = randomBytes(32).toString("hex"); // QuickNode requires ≥ 32 characters
    const envPath = resolve(ROOT, ".env");
    const env = readFileSync(envPath, "utf8");
    if (/^QUICKNODE_STREAM_TOKEN=.*$/m.test(env)) writeFileSync(envPath, env.replace(/^QUICKNODE_STREAM_TOKEN=.*$/m, `QUICKNODE_STREAM_TOKEN=${token}`));
    else appendFileSync(envPath, `\nQUICKNODE_STREAM_TOKEN=${token}\n`);
    console.log("generated QUICKNODE_STREAM_TOKEN into .env (restart the marketplace to pick it up)");
  }

  const filter = readFileSync(resolve(ROOT, "services/quicknode/filter.js"), "utf8").replace(
    /const ESCROW = "0x[0-9a-fA-F]{40}"/,
    `const ESCROW = "${escrowAddress().toLowerCase()}"`,
  );

  const res = await fetch(API, {
    method: "POST",
    headers: { accept: "application/json", "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      name: "proof-of-edge-escrow",
      network: NETWORK,
      dataset: "block_with_receipts",
      filter_function: Buffer.from(filter).toString("base64"),
      region: "usa_east",
      dataset_batch_size: 10, // Arc has sub-second blocks; QuickNode needs ≥ 5 there
      elastic_batch_enabled: true,
      fix_block_reorgs: 0,
      keep_distance_from_tip: 0,
      destination: "webhook",
      destination_attributes: {
        url: `${publicUrl.replace(/\/$/, "")}/streams/arc`,
        compression: "none",
        // A Stream terminates once retries run out; ~100 s of tolerance survives a server restart.
        max_retry: 10,
        retry_interval_sec: 10,
        post_timeout_sec: 10,
        security_token: token,
      },
      status: "active",
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`create stream: HTTP ${res.status} ${body.slice(0, 500)}`);
  const stream = JSON.parse(body) as { id: string; status: string; network: string };
  console.log(`stream ${stream.id} ${stream.status} on ${stream.network} → ${publicUrl}/streams/arc`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
