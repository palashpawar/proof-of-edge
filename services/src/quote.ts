import { encodeAbiParameters, keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { SCALE, arcTestnet } from "./config.ts";

/** Mirrors EdgeEscrow.Quote. Probabilities in ppm, stake in 6-decimal USDC units. */
export interface Quote {
  seller: Address;
  buyer: Address;
  marketId: Hex;
  mRef: number;
  stake: bigint;
  expiry: bigint;
  revealDeadline: bigint;
  commit: Hex;
  nonce: bigint;
}

export const QUOTE_TYPES = {
  Quote: [
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "marketId", type: "bytes32" },
    { name: "mRef", type: "uint32" },
    { name: "stake", type: "uint96" },
    { name: "expiry", type: "uint64" },
    { name: "revealDeadline", type: "uint64" },
    { name: "commit", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const escrowDomain = (verifyingContract: Address) =>
  ({ name: "EdgeEscrow", version: "1", chainId: arcTestnet.id, verifyingContract }) as const;

/** keccak256(bytes(instrumentSymbol)), matching EdgeEscrow.resolve. */
export const marketIdOf = (instrumentSymbol: string): Hex => keccak256(stringToBytes(instrumentSymbol));

/** keccak256(abi.encode(marketId, p, salt)), matching EdgeEscrow.commitment. */
export function commitmentOf(marketId: Hex, p: number, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }], [marketId, p, salt]));
}

export const randomSalt = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));
export const randomNonce = (): bigint => BigInt(toHex(crypto.getRandomValues(new Uint8Array(8))));

export function signQuote(seller: PrivateKeyAccount, escrow: Address, quote: Quote): Promise<Hex> {
  return seller.signTypedData({ domain: escrowDomain(escrow), types: QUOTE_TYPES, primaryType: "Quote", message: quote });
}

/** Probability (0..1) → ppm, clamped to the open interval the contract accepts for mRef. */
export function toPpm(probability: number): number {
  return Math.min(SCALE - 1, Math.max(1, Math.round(probability * SCALE)));
}

export const fromPpm = (ppm: number | bigint): number => Number(ppm) / SCALE;
