import { readFileSync } from "node:fs";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, http } from "viem";
import { generatePrivateKey } from "viem/accounts";

// Asks Circle App Kit for bridge fee estimates on a few routes. Read-only: no funds needed.
//
//   npm run proof                                   # default routes below
//   npm run proof -- Base_Sepolia:Arc_Testnet ...   # your own routes (App Kit chain keys)
//   npm run proof -- --all-from Arc_Testnet         # Arc Testnet -> every other chain
//
// Read PROOF_PRIVATE_KEY from a local .env file if there is one (see .env.example).
try {
  process.loadEnvFile();
} catch {
  // no .env file, that's fine
}

const chains = JSON.parse(readFileSync(new URL("../src/chains.json", import.meta.url), "utf8"));
const byKey = Object.fromEntries(chains.map((c) => [c.key, c]));
const rpcById = Object.fromEntries(chains.map((c) => [c.chainId, c.rpcUrls[0]]));

const DEFAULT_ROUTES = [
  "Base_Sepolia:Arc_Testnet",
  "Arc_Testnet:Base_Sepolia",
  "Ethereum_Sepolia:Arc_Testnet",
  "Arbitrum_Sepolia:Optimism_Sepolia",
  "Avalanche_Fuji:Polygon_Amoy_Testnet",
  "Arc_Testnet:Unichain_Sepolia",
];

function parseRoutes(args) {
  const i = args.indexOf("--all-from");
  if (i !== -1) {
    const from = args[i + 1];
    return chains.filter((c) => c.key !== from).map((c) => [from, c.key]);
  }
  const list = args.length ? args : DEFAULT_ROUTES;
  return list.map((r) => r.split(":"));
}

// This script only asks for fee estimates, so the wallet needs no funds.
// Without PROOF_PRIVATE_KEY a random throwaway key is used.
// Never put a key that holds real funds here.
const privateKey = process.env.PROOF_PRIVATE_KEY || generatePrivateKey();
const kit = new AppKit();
const adapters = {};
async function adapterFor(key) {
  adapters[key] ??= await createViemAdapterFromPrivateKey({
    privateKey,
    chain: key,
    // Use the same RPCs as the website.
    getPublicClient: ({ chain }) =>
      createPublicClient({ chain, transport: http(rpcById[chain.id] ?? chain.rpcUrls.default.http[0]) }),
  });
  return adapters[key];
}

const fmtFees = (est) =>
  (est.fees ?? []).map((f) => `${f.type}: ${f.amount ?? "0"} ${f.token ?? ""}`.trim()).join(", ") || "no protocol fees";

let ok = 0;
const routes = parseRoutes(process.argv.slice(2));
for (const [from, to] of routes) {
  const label = `${byKey[from]?.name ?? from} → ${byKey[to]?.name ?? to}`;
  if (!byKey[from] || !byKey[to]) {
    console.log(`✗ ${label}: unknown chain key (see src/chains.json)`);
    continue;
  }
  try {
    const estimate = await kit.estimateBridge({
      from: { adapter: await adapterFor(from), chain: from },
      to: { adapter: await adapterFor(to), chain: to },
      amount: "1",
      token: "USDC",
    });
    ok++;
    console.log(`✓ ${label}: ${fmtFees(estimate)}`);
  } catch (e) {
    console.log(`✗ ${label}: ${e.message || e}`);
  }
}
console.log(`\n${ok}/${routes.length} routes estimated.`);
process.exit(ok === routes.length ? 0 : 1);
