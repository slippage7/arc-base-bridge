// Checks src/chains.json against Circle App Kit and the live networks:
//  1. every EVM testnet App Kit can bridge is listed (and nothing extra),
//  2. chain id and USDC address match the SDK,
//  3. every RPC answers eth_chainId with the right id,
//  4. the USDC contract answers decimals() = 6 on the first RPC.
// Usage: npm run check:chains
import { readFileSync } from "node:fs";
import { AppKit } from "@circle-fin/app-kit";
import { createPublicClient, erc20Abi, http } from "viem";

const chains = JSON.parse(readFileSync(new URL("../src/chains.json", import.meta.url), "utf8"));
const sdk = new AppKit().getSupportedChains("bridge", { chainType: "evm", isTestnet: true });
let failures = 0;
const fail = (msg) => { failures++; console.log("  ✗ " + msg); };

const sdkKeys = new Set(sdk.map((c) => c.chain));
const ourKeys = new Set(chains.map((c) => c.key));
for (const k of sdkKeys) if (!ourKeys.has(k)) fail(`SDK supports ${k} but it is missing in chains.json`);
for (const k of ourKeys) if (!sdkKeys.has(k)) fail(`${k} is in chains.json but App Kit cannot bridge it`);

async function rpcChainId(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(15000),
  });
  return parseInt((await res.json()).result, 16);
}

await Promise.all(chains.map(async (c) => {
  const lines = [];
  const s = sdk.find((x) => x.chain === c.key);
  if (s) {
    if (s.chainId !== c.chainId) lines.push(`chain id ${c.chainId} != SDK ${s.chainId}`);
    if (s.usdcAddress.toLowerCase() !== c.usdc.toLowerCase()) lines.push(`USDC ${c.usdc} != SDK ${s.usdcAddress}`);
  }
  for (const url of c.rpcUrls) {
    try {
      const id = await rpcChainId(url);
      if (id !== c.chainId) lines.push(`${url} returned chain id ${id}`);
    } catch (e) {
      lines.push(`${url} did not answer (${e.message})`);
    }
  }
  try {
    const client = createPublicClient({ transport: http(c.rpcUrls[0], { timeout: 15000 }) });
    const dec = await client.readContract({ address: c.usdc, abi: erc20Abi, functionName: "decimals" });
    if (dec !== 6) lines.push(`USDC decimals ${dec}`);
  } catch (e) {
    lines.push(`USDC decimals() failed (${e.shortMessage || e.message})`);
  }
  console.log(`${lines.length ? "✗" : "✓"} ${c.name} (${c.chainId})`);
  for (const l of lines) fail(l);
}));

console.log(`\n${chains.length} chains checked, ${failures} problem(s).`);
process.exit(failures ? 1 : 0);
