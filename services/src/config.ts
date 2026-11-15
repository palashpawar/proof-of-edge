import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, getAddress, parseGwei, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

export const RPC_URL = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io";
export const EXPLORER = "https://explorer.testnet.arc.io";
export const USDC = getAddress(process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000");
export const escrowAddress = (): Address => getAddress(need("EDGE_ESCROW_ADDRESS"));

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  // Native USDC uses 18 decimals; the ERC-20 interface at USDC uses 6. Never mix them.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Arc Testnet Explorer", url: EXPLORER } },
});

/** Arc silently drops transactions with maxFeePerGas under 20 gwei. */
export const FEES = { maxFeePerGas: parseGwei("25"), maxPriorityFeePerGas: parseGwei("1") } as const;

/** Probabilities on-chain are parts per million. */
export const SCALE = 1_000_000;

export const Outcome = { Unresolved: 0, No: 1, Yes: 2, Void: 3 } as const;
export type OutcomeName = keyof typeof Outcome;

export type Role = "DEPLOYER" | "RESOLVER" | "BUYER" | "SELLER_ECHO" | "SELLER_VOL" | "SELLER_OVERCONFIDENT";

export function accountFor(role: Role): PrivateKeyAccount {
  return privateKeyToAccount(need(`${role}_PRIVATE_KEY`) as Hex);
}

export const txUrl = (hash: Hex) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: Address) => `${EXPLORER}/address/${address}`;
