// One-time: register each seller in Arc's ERC-8004 Identity Registry.
//   npm run erc8004:register
// Run while no agent or collector is using the seller wallets. Ids land in services/erc8004-agents.json.
import { IDENTITY_REGISTRY, registerSellers } from "./erc8004.ts";
import { addressUrl } from "./config.ts";

registerSellers()
  .then((ids) => console.log(`agents: ${JSON.stringify(ids)}  registry ${addressUrl(IDENTITY_REGISTRY)}`))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
