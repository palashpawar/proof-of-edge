# Proof of Edge

**Pay forecasters for edge, not for data.** AI agents buy probability forecasts for Gemini prediction markets. Access is paid per request with x402 on Arc, and the quality of each forecast is settled by an onchain *edge swap* once the market resolves.

> Work in progress for the UBC 2026 Hackathon (Agentic Payments and AI · Best use of Arc · Gemini Prediction Markets · QuickNode Streams). Full architecture, agent decision loop and safety limits, and the Stream configuration are coming before submission.

## The edge swap

For one binary Gemini contract, the seller signs a quote fixing the market reference probability `m` (the YES mid at quote time) and a hash commitment to its forecast `p`. The buyer opens the swap, which locks the same stake `k` from both sides, and the seller reveals `p`. When the market resolves to `y ∈ {0, 1}`:

```
Δ = (m − y)² − (p − y)²        (Brier improvement over the market, Δ ∈ [−1, 1])
```

If `Δ > 0` the buyer pays the seller `k·Δ`; if `Δ < 0` the seller pays the buyer `k·|Δ|`.

- **Truthful reporting is optimal.** If the true probability is `q`, the seller's expected score is `(m − p)(m + p − 2q)`, maximised at `p = q`.
- **No edge, no pay.** A truthful seller expects `k·(m − q)²`, which is zero exactly when it knows nothing the market doesn't. A seller that echoes the market price nets zero on every swap.
- **Bad forecasts compensate the buyer.** A seller worse than the market pays out in expectation.

All three properties are checked by fuzz tests in [`contracts/test/EdgeEscrow.t.sol`](contracts/test/EdgeEscrow.t.sol).

## Deployed (Arc Testnet, chain ID 5042002)

| Contract | Address |
|---|---|
| `EdgeEscrow` (source verified) | [`0x288a40f4aa06C0A382aA790d4b27857FcF9EF54F`](https://explorer.testnet.arc.io/address/0x288a40f4aa06C0A382aA790d4b27857FcF9EF54F) |
| USDC (ERC-20 interface, 6 decimals; used as-is) | `0x3600000000000000000000000000000000000000` |

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Foundry project: `EdgeEscrow.sol`, tests, deploy script |
| `services/` | TypeScript (viem): Arc client, Gemini market data, quote signing, forecasters, smoke test |
| `scripts/` | Testnet wallet generation and faucet distribution |

## Contracts

```bash
git clone --recurse-submodules <repo>
cd contracts
forge test
```

Deploy to Arc Testnet (chain ID 5042002). USDC is the ERC-20 interface at `0x3600000000000000000000000000000000000000` (6 decimals):

```bash
scripts/new-wallets.sh                 # writes testnet-only keys to .env
# fund DEPLOYER_ADDRESS at https://faucet.circle.com (Arc Testnet)
scripts/distribute.sh --send           # splits faucet USDC across the other wallets
cd contracts && set -a && source ../.env && set +a
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --with-gas-price 25gwei
```

Arc silently drops transactions priced under 20 gwei, so always set the gas price.

## Smoke test: one live swap

Requires Node 22+. Runs a full edge swap against the soonest Gemini 5-minute crypto market with a two-sided book: the seller signs a quote, the buyer opens it, the seller reveals, and once Gemini settles the market the resolver posts the outcome and the swap is settled.

```bash
npm install
npm run smoke                        # overconfident seller (default)
SELLER=SELLER_ECHO npm run smoke     # echo seller: always nets zero
```
