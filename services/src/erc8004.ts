// Seller reputation on Arc's ERC-8004 registries.
// Identity: each seller registers itself (it owns its agent NFT, so it cannot rate itself).
// Reputation: the keeper's resolver wallet posts every settled edge score Δ as signed feedback,
// so anyone can read a seller's average edge from Arc with getSummary(agentId, [resolver], "edgeScore", "").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { publicClient, serial, walletFor } from "./chain.ts";
import { FEES, ROOT, accountFor, arcTestnet, txUrl } from "./config.ts";
import { SELLER_SPECS } from "./forecasters.ts";

export const IDENTITY_REGISTRY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const REPUTATION_REGISTRY: Address = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://spend.panther-kingsnake.ts.net:8443";
export const TAG = "edgeScore";
const TAG2 = "proof-of-edge";
const DECIMALS = 6;

const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);
const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

// Public, so it lives in the repo: which ERC-8004 agent id each seller registered as.
const agentsFile = resolve(ROOT, "services/erc8004-agents.json");
export const agentIds: Record<string, number> = existsSync(agentsFile) ? JSON.parse(readFileSync(agentsFile, "utf8")) : {};

/** ERC-8004 registration file for a seller, served at /agents/:id.json. */
export function registrationFile(sellerId: string) {
  const spec = SELLER_SPECS.find((s) => s.id === sellerId);
  if (!spec) return null;
  const agentId = agentIds[sellerId];
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: `Proof of Edge forecaster: ${spec.id}`,
    description: `${spec.description} Sells probability forecasts for Gemini prediction markets over x402; every forecast is settled by an edge swap on Arc.`,
    services: [
      { name: "x402", endpoint: `${PUBLIC_URL}/forecast/${spec.id}/{instrumentSymbol}` },
      { name: "agentWallet", endpoint: `eip155:${arcTestnet.id}:${accountFor(spec.role).address}` },
    ],
    x402Support: true,
    active: true,
    registrations: agentId === undefined ? [] : [{ agentId, agentRegistry: `eip155:${arcTestnet.id}:${IDENTITY_REGISTRY}` }],
    supportedTrust: ["reputation"],
  };
}

/** One-time: each unregistered seller registers itself. Returns the id map. */
export async function registerSellers(): Promise<Record<string, number>> {
  for (const spec of SELLER_SPECS) {
    if (agentIds[spec.id] !== undefined) continue;
    const wallet = walletFor(spec.role);
    const hash = await wallet.writeContract({
      address: IDENTITY_REGISTRY,
      abi: identityAbi,
      functionName: "register",
      args: [`${PUBLIC_URL}/agents/${spec.id}.json`],
      ...FEES,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: identityAbi, logs: receipt.logs, eventName: "Registered" })[0];
    if (!ev) throw new Error(`no Registered event for ${spec.id} (${txUrl(hash)})`);
    agentIds[spec.id] = Number(ev.args.agentId);
    writeFileSync(agentsFile, JSON.stringify(agentIds, null, 2) + "\n");
    console.log(`  ✓ ${spec.id} registered as ERC-8004 agent #${agentIds[spec.id]} ${txUrl(hash)}`);
  }
  return agentIds;
}

// ───────────────────────────── feedback ─────────────────────────────

const postedFile = resolve(ROOT, "data/erc8004-posted.json");
const posted = new Set<string>(existsSync(postedFile) ? JSON.parse(readFileSync(postedFile, "utf8")) : []);

export const alreadyPosted = (swapId: Hex) => posted.has(swapId);

/** Δ (fraction in [−1, 1]) → signed fixed-point with 6 decimals. */
export const toFeedbackValue = (edgeScore: number) => BigInt(Math.round(edgeScore * 10 ** DECIMALS));

export async function postFeedback(a: { sellerId: string; swapId: Hex; edgeScore: number; settleTx: Hex }) {
  const agentId = agentIds[a.sellerId];
  if (agentId === undefined || posted.has(a.swapId)) return;
  await serial("RESOLVER", async () => {
    const wallet = walletFor("RESOLVER");
    const hash = await wallet.writeContract({
      address: REPUTATION_REGISTRY,
      abi: reputationAbi,
      functionName: "giveFeedback",
      args: [
        BigInt(agentId),
        toFeedbackValue(a.edgeScore),
        DECIMALS,
        TAG,
        TAG2,
        `${PUBLIC_URL}/forecast/${a.sellerId}/{instrumentSymbol}`,
        txUrl(a.settleTx),
        a.swapId,
      ],
      ...FEES,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`giveFeedback reverted ${txUrl(hash)}`);
    posted.add(a.swapId);
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(postedFile, JSON.stringify([...posted]));
    console.log(`  ✓ feedback ${a.sellerId} Δ=${a.edgeScore.toFixed(4)} → agent #${agentId} ${txUrl(hash)}`);
  });
}

/** Average edge per seller as Arc reports it, counting only feedback from our resolver. */
export async function onchainSummary(sellerId: string) {
  const agentId = agentIds[sellerId];
  if (agentId === undefined) return null;
  const [count, value, decimals] = await publicClient.readContract({
    address: REPUTATION_REGISTRY,
    abi: reputationAbi,
    functionName: "getSummary",
    args: [BigInt(agentId), [accountFor("RESOLVER").address], TAG, ""],
  });
  return { agentId, count: Number(count), meanEdge: Number(value) / 10 ** decimals };
}
