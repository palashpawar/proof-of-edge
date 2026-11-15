#!/usr/bin/env bash
# Splits the deployer's faucet USDC across the other testnet wallets.
# Keeps 2 USDC on the deployer for gas, gives the resolver 1 USDC, then
# 40% of the rest to the buyer and 20% to each seller.
#
#   scripts/distribute.sh          # dry run: prints the plan
#   scripts/distribute.sh --send   # sends the transfers
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAST="${CAST:-$HOME/.foundry/bin/cast}"
set -a; source "$ROOT/.env"; set +a

GAS=(--gas-price 25gwei --priority-gas-price 1gwei)   # Arc drops txs under 20 gwei
bal() { "$CAST" call "$USDC_ADDRESS" 'balanceOf(address)(uint256)' "$1" --rpc-url "$ARC_RPC_URL" | awk '{print $1}'; }

total="$(bal "$DEPLOYER_ADDRESS")"
keep=2000000; resolver_amt=1000000
if [ "$total" -le $((keep + resolver_amt)) ]; then
  echo "Deployer has $(python3 -I -c "print($total/1e6)") USDC; fund $DEPLOYER_ADDRESS at faucet.circle.com (Arc Testnet) first." >&2
  exit 1
fi
rest=$((total - keep - resolver_amt))
buyer_amt=$((rest * 40 / 100)); seller_amt=$((rest * 20 / 100))

plan=(
  "RESOLVER $RESOLVER_ADDRESS $resolver_amt"
  "BUYER $BUYER_ADDRESS $buyer_amt"
  "SELLER_ECHO $SELLER_ECHO_ADDRESS $seller_amt"
  "SELLER_VOL $SELLER_VOL_ADDRESS $seller_amt"
  "SELLER_OVERCONFIDENT $SELLER_OVERCONFIDENT_ADDRESS $seller_amt"
)

echo "Deployer balance: $(python3 -I -c "print($total/1e6)") USDC"
for row in "${plan[@]}"; do
  read -r name addr amt <<<"$row"
  printf '  %-22s %s  %s USDC\n' "$name" "$addr" "$(python3 -I -c "print($amt/1e6)")"
done

[ "${1:-}" = "--send" ] || { echo "(dry run; pass --send to transfer)"; exit 0; }

for row in "${plan[@]}"; do
  read -r name addr amt <<<"$row"
  "$CAST" send "$USDC_ADDRESS" 'transfer(address,uint256)' "$addr" "$amt" \
    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$ARC_RPC_URL" "${GAS[@]}" --json \
    | python3 -I -c 'import json,sys; r=json.load(sys.stdin); r=r.get("data",r) if isinstance(r,dict) else r; print("  sent", sys.argv[1], r.get("transactionHash"), "status", r.get("status"))' "$name"
done
