import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { edgeEscrowAbi } from "./abi/EdgeEscrow.ts";
import { FEES, USDC, accountFor, arcTestnet, escrowAddress, txUrl, type Role } from "./config.ts";

export const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

export function walletFor(role: Role) {
  return createWalletClient({ account: accountFor(role), chain: arcTestnet, transport: http() });
}

// One in-flight transaction per account, so concurrent callers never race on the nonce.
const queues = new Map<Role, Promise<unknown>>();
export function serial<T>(role: Role, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(role) ?? Promise.resolve()).then(fn, fn);
  queues.set(role, next.catch(() => undefined));
  return next;
}

export const Status = { None: 0, Open: 1, Revealed: 2, Settled: 3 } as const;

export interface SwapState {
  buyer: Address;
  stake: bigint;
  seller: Address;
  revealDeadline: bigint;
  mRef: number;
  p: number;
  status: number;
  marketId: Hex;
  commit: Hex;
}

export async function readSwap(swapId: Hex): Promise<SwapState> {
  const [buyer, stake, seller, revealDeadline, mRef, p, status, marketId, commit] = await publicClient.readContract({
    address: escrowAddress(),
    abi: edgeEscrowAbi,
    functionName: "swaps",
    args: [swapId],
  });
  return { buyer, stake, seller, revealDeadline, mRef, p, status, marketId, commit };
}

/** Simulates, sends and waits for an EdgeEscrow call; throws with the decoded revert reason on failure. */
export function sendEscrow(
  role: Role,
  functionName: string,
  args: readonly unknown[],
  label = functionName,
): Promise<TransactionReceipt> {
  return serial(role, () => sendEscrowNow(role, functionName, args, label));
}

async function sendEscrowNow(
  role: Role,
  functionName: string,
  args: readonly unknown[],
  label: string,
): Promise<TransactionReceipt> {
  const wallet = walletFor(role);
  const { request } = await publicClient.simulateContract({
    address: escrowAddress(),
    abi: edgeEscrowAbi,
    functionName: functionName as never,
    args: args as never,
    account: wallet.account,
    ...FEES,
  });
  const hash = await wallet.writeContract(request as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${txUrl(hash)}`);
  console.log(`  ✓ ${label.padEnd(10)} ${txUrl(hash)}`);
  return receipt;
}

export function escrowEvents(receipt: TransactionReceipt) {
  return parseEventLogs({ abi: edgeEscrowAbi, logs: receipt.logs });
}

export async function escrowBalance(account: Address): Promise<bigint> {
  return publicClient.readContract({
    address: escrowAddress(),
    abi: edgeEscrowAbi,
    functionName: "balanceOf",
    args: [account],
  });
}

export async function usdcBalance(account: Address): Promise<bigint> {
  return publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

/** Tops up `role`'s free escrow balance to at least `min` (6-decimal USDC units). */
export async function ensureDeposit(role: Role, min: bigint): Promise<void> {
  const wallet = walletFor(role);
  const who = wallet.account.address;
  const have = await escrowBalance(who);
  if (have >= min) return;
  const need = min - have;
  const wallet6 = await usdcBalance(who);
  if (wallet6 < need) throw new Error(`${role} has ${wallet6} USDC units in its wallet, needs ${need}`);

  const approveHash = await wallet.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [escrowAddress(), need],
    ...FEES,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  await sendEscrow(role, "deposit", [need], `deposit ${role.toLowerCase()}`);
}

export async function chainTime(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}

export type { Hex };
