#!/usr/bin/env bash
# Generates fresh TESTNET-ONLY wallets for every role and writes them into .env.
# Refuses to overwrite keys that already exist. Prints addresses only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
CAST="${CAST:-$HOME/.foundry/bin/cast}"
ROLES=(DEPLOYER RESOLVER BUYER SELLER_ECHO SELLER_VOL SELLER_OVERCONFIDENT)

[ -f "$ENV_FILE" ] || cp "$ROOT/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"

for role in "${ROLES[@]}"; do
  if grep -qE "^${role}_PRIVATE_KEY=0x[0-9a-fA-F]{64}$" "$ENV_FILE"; then
    echo "${role}: already set, keeping it"
    continue
  fi
  json="$("$CAST" wallet new --json)"
  # cast 1.9 wraps output as {"data": [{address, public_key, private_key}], ...}; older versions emit the bare list.
  pick='import json,sys; d=json.load(sys.stdin); d=d["data"] if isinstance(d,dict) else d; print(d[0][sys.argv[1]])'
  addr="$(printf '%s' "$json" | python3 -I -c "$pick" address)"
  key="$(printf '%s' "$json" | python3 -I -c "$pick" private_key)"
  python3 -I - "$ENV_FILE" "$role" "$addr" "$key" <<'PY'
import re, sys
path, role, addr, key = sys.argv[1:]
text = open(path).read()
for name, value in ((f"{role}_ADDRESS", addr), (f"{role}_PRIVATE_KEY", key)):
    line = f"{name}={value}"
    if re.search(rf"^{name}=.*$", text, flags=re.M):
        text = re.sub(rf"^{name}=.*$", line, text, flags=re.M)
    else:
        text += f"\n{line}"
open(path, "w").write(text)
PY
  echo "${role}: ${addr}"
done
