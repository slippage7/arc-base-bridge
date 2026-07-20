import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";

async function main() {
  const privateKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const adapterBase = await createViemAdapterFromPrivateKey({ privateKey, chain: "Base_Sepolia" });
  const adapterArc = await createViemAdapterFromPrivateKey({ privateKey, chain: "Arc_Testnet" });
  
  const kit = new AppKit();
  
  console.log("Checking Base (Mainnet) -> Arc Testnet...");
  try {
    const estimate = await kit.estimateSwap({
      from: { adapter: adapterBase, chain: "Base" },
      to: { recipientAddress: adapterBase.address, chain: "Arc_Testnet" },
      tokenIn: "NATIVE",
      tokenOut: "USDC",
      amountIn: "0.01"
    });
    console.log("SUCCESS on Base mainnet!");
  } catch (e) {
    console.log("ERROR on Base:", e.message || e);
  }

  console.log("\nChecking Base_Sepolia -> Arc Testnet...");
  try {
    const estimate = await kit.estimateSwap({
      from: { adapter: adapterBase, chain: "Base_Sepolia" },
      to: { recipientAddress: adapterBase.address, chain: "Arc_Testnet" },
      tokenIn: "NATIVE",
      tokenOut: "USDC",
      amountIn: "0.01"
    });
    console.log("SUCCESS on Base_Sepolia!");
  } catch (e) {
    console.log("ERROR on Base_Sepolia:", e.message || e);
  }
}

main();
