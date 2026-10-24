import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { generatePrivateKey } from "viem/accounts";

// Read PROOF_PRIVATE_KEY from a local .env file if there is one (see .env.example).
try {
  process.loadEnvFile();
} catch {
  // no .env file, that's fine
}

async function main() {
  // This script only asks for fee estimates, so the wallet needs no funds.
  // Without PROOF_PRIVATE_KEY a random throwaway key is used.
  // Never put a key that holds real funds here.
  const privateKey = process.env.PROOF_PRIVATE_KEY || generatePrivateKey();
  const adapterBase = await createViemAdapterFromPrivateKey({ privateKey, chain: "Base_Sepolia" });
  const adapterArc = await createViemAdapterFromPrivateKey({ privateKey, chain: "Arc_Testnet" });
  
  const kit = new AppKit();
  
  const replacer = (key, value) => typeof value === 'bigint' ? value.toString() + 'n' : value;

  console.log("Checking Base_Sepolia -> Arc Testnet (USDC Bridge)...");
  try {
    const estimate = await kit.estimateBridge({
      from: { adapter: adapterBase, chain: "Base_Sepolia" },
      to: { adapter: adapterArc, chain: "Arc_Testnet" },
      amount: "0.01",
      token: "USDC"
    });
    console.log("SUCCESS! Bridge route is valid.\nEstimate details:\n" + JSON.stringify(estimate, replacer, 2));
  } catch (e) {
    console.log("ERROR on Base_Sepolia -> Arc Testnet:", e.message || e);
  }

  console.log("\nChecking Arc Testnet -> Base_Sepolia (USDC Bridge)...");
  try {
    const estimate = await kit.estimateBridge({
      from: { adapter: adapterArc, chain: "Arc_Testnet" },
      to: { adapter: adapterBase, chain: "Base_Sepolia" },
      amount: "10",
      token: "USDC"
    });
    console.log("SUCCESS! Bridge route is valid.\nEstimate details:\n" + JSON.stringify(estimate, replacer, 2));
  } catch (e) {
    console.log("ERROR on Arc Testnet -> Base_Sepolia:", e.message || e);
  }
}

main();
