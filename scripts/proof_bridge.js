import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";

async function main() {
  const privateKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
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
