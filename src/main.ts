import { createPublicClient, erc20Abi, formatUnits, http, parseUnits } from "viem";
import type { EIP1193Provider, Chain } from "viem";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { AppKit } from "@circle-fin/app-kit";

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

type ChainKey = "base" | "arc";

// Official Arc Testnet RPC and explorer.
// (The old rpc.testnet.arc.network host is retired and testnet.arcscan.app is outdated.)
const ARC_RPC_URL = "https://rpc.testnet.arc.io";
const ARC_EXPLORER_URL = "https://explorer.testnet.arc.io";

const CHAINS: Record<ChainKey, { appKitId: string; label: string; sub: string; explorerTx: (hash: string) => string }> = {
  base: {
    appKitId: "Base_Sepolia",
    label: "Base Sepolia",
    sub: "chain id 84532",
    explorerTx: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
  },
  arc: {
    appKitId: "Arc_Testnet",
    label: "Arc Testnet",
    sub: "USDC-denominated gas",
    explorerTx: (hash) => `${ARC_EXPLORER_URL}/tx/${hash}`,
  },
};

// USDC ERC-20 contracts (6 decimals on both chains), used to read the balance.
const USDC_DECIMALS = 6;
const USDC: Record<ChainKey, { address: `0x${string}`; rpcUrl: string }> = {
  base: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", rpcUrl: "https://sepolia.base.org" },
  arc: { address: "0x3600000000000000000000000000000000000000", rpcUrl: ARC_RPC_URL },
};

// Direction: fromKey -> toKey. Starts Base -> Arc.
let fromKey: ChainKey = "base";
let toKey: ChainKey = "arc";

// Removed EIP-6963 discovery for simpler window.ethereum usage.

// Raw chain params so we can register them with the wallet via
// wallet_addEthereumChain before attempting to switch/sign on them.
const CHAIN_PARAMS: Record<
  ChainKey,
  {
    chainId: string;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
  }
> = {
  base: {
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    rpcUrls: ["https://sepolia.base.org"],
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
  arc: {
    chainId: "0x4cef52",
    chainName: "Arc Testnet",
    rpcUrls: [
      ARC_RPC_URL,
      "https://arc-testnet.rpc.thirdweb.com",
      "https://arc-testnet.drpc.org",
    ],
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    blockExplorerUrls: [ARC_EXPLORER_URL],
  },
};

// ---------------------------------------------------------------------------
// Wallet error helpers
// ---------------------------------------------------------------------------

// Wallets often wrap the real error, e.g. MetaMask Mobile returns
// { code: -32603, data: { originalError: { code: 4902 } } }.
// This collects every code found on the error and its nested errors.
function collectErrorCodes(err: any, depth = 0): Array<number | string> {
  if (!err || typeof err !== "object" || depth > 5) return [];
  // App Kit's own RPC_ENDPOINT_ERROR also uses code 4001, but it is not a wallet rejection.
  const codes: Array<number | string> = err.name === "RPC_ENDPOINT_ERROR" ? [] : [err.code];
  for (const inner of [err.data?.originalError, err.data, err.error, err.cause]) {
    codes.push(...collectErrorCodes(inner, depth + 1));
  }
  return codes.filter((c) => c !== undefined);
}

function hasErrorCode(err: unknown, code: number | string): boolean {
  return collectErrorCodes(err).some((c) => c === code || String(c) === String(code));
}

// True when the user clicked "Reject" / "Cancel" in the wallet.
function isUserRejection(err: unknown): boolean {
  return hasErrorCode(err, 4001) || hasErrorCode(err, "ACTION_REJECTED");
}

async function ensureChainRegistered(provider: EIP1193Provider, key: ChainKey) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_PARAMS[key].chainId }],
    });
  } catch (switchError: any) {
    if (isUserRejection(switchError)) {
      throw new Error(`You rejected switching to ${CHAIN_PARAMS[key].chainName} in your wallet.`);
    }
    // 4902 = chain not added to the wallet yet (may be nested inside the error)
    if (hasErrorCode(switchError, 4902)) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [CHAIN_PARAMS[key]],
        });
      } catch (addError: any) {
        if (isUserRejection(addError)) {
          throw new Error(`You rejected adding ${CHAIN_PARAMS[key].chainName} to your wallet.`);
        }
        throw new Error(`Failed to add chain ${CHAIN_PARAMS[key].chainName} to wallet: ${addError.message || "Unknown error"}`);
      }
    } else {
      throw new Error(`Failed to switch to chain ${CHAIN_PARAMS[key].chainName}: ${switchError.message || "Unknown error"}`);
    }
  }
}

async function requestAccount(provider: EIP1193Provider): Promise<string | null> {
  await provider.request({ method: "eth_requestAccounts" });
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  return accounts[0] ?? null;
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const nodeFrom = $<HTMLDivElement>("node-from");
const nodeTo = $<HTMLDivElement>("node-to");
const railPulse = $<HTMLDivElement>("rail-pulse");
const switchBtn = $<HTMLButtonElement>("switch-direction");
const amountInput = $<HTMLInputElement>("amount");
const connectBtn = $<HTMLButtonElement>("connect-btn");
const walletAddressEl = $<HTMLParagraphElement>("wallet-address");
const bridgeBtn = $<HTMLButtonElement>("bridge-btn");
const statusHint = $<HTMLParagraphElement>("status-hint");
const ledger = $<HTMLOListElement>("ledger");
const ledgerEmpty = $<HTMLLIElement>("ledger-empty");
const logStatus = $<HTMLSpanElement>("log-status");
const amountBalance = $<HTMLSpanElement>("amount-balance");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let connectedProvider: EIP1193Provider | null = null;
let connectedAddress: string | null = null;
// USDC balance on the source chain (6 decimals), or null when unknown.
let sourceBalance: bigint | null = null;
let bridging = false;
const kit = new AppKit();

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function renderRoute() {
  const from = CHAINS[fromKey];
  const to = CHAINS[toKey];

  nodeFrom.querySelector(".node-label")!.textContent = from.label;
  nodeFrom.querySelector(".node-sub")!.textContent = from.sub;
  nodeTo.querySelector(".node-label")!.textContent = to.label;
  nodeTo.querySelector(".node-sub")!.textContent = to.sub;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Returns an error text for the amount, or null when it is fine.
function validateAmount(value: string): string | null {
  const text = value.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return "Enter a valid amount";
  if ((text.split(".")[1] ?? "").length > USDC_DECIMALS) return "Max 6 decimals";
  const units = parseUnits(text, USDC_DECIMALS);
  if (units <= 0n) return "Enter a valid amount";
  if (sourceBalance !== null && units > sourceBalance) return "Not enough USDC";
  return null;
}

async function refreshBalance() {
  sourceBalance = null;
  amountBalance.textContent = "";
  setBridgeButtonState();
  if (!connectedAddress) return;

  const key = fromKey;
  const address = connectedAddress;
  try {
    const client = createPublicClient({ transport: http(USDC[key].rpcUrl) });
    const balance = await client.readContract({
      address: USDC[key].address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    });
    // Ignore the answer if the user switched direction or account meanwhile.
    if (key !== fromKey || address !== connectedAddress) return;
    sourceBalance = balance;
    amountBalance.textContent = `Balance: ${formatUnits(balance, USDC_DECIMALS)} USDC`;
  } catch (err) {
    // Balance is only a helper; if the RPC fails we simply skip the check.
    console.warn("Could not read USDC balance", err);
  }
  setBridgeButtonState();
}

function setBridgeButtonState() {
  if (bridging) return;
  if (!connectedAddress) {
    bridgeBtn.disabled = true;
    bridgeBtn.textContent = "Connect wallet first";
    return;
  }
  const amountError = validateAmount(amountInput.value);
  if (amountError) {
    bridgeBtn.disabled = true;
    bridgeBtn.textContent = amountError;
    return;
  }
  bridgeBtn.disabled = false;
  bridgeBtn.textContent = `Bridge ${CHAINS[fromKey].label} → ${CHAINS[toKey].label}`;
}

function setHint(text: string, tone: "" | "error" | "success" = "") {
  statusHint.textContent = text;
  statusHint.className = `hint ${tone}`.trim();
}

function setLogStatus(text: string, tone: "" | "done" | "error" = "") {
  logStatus.textContent = text;
  logStatus.className = `log-header-sub ${tone}`.trim();
}

function addLedgerEntry(name: string, state: "pending" | "success" | "error", detail: string, explorerUrl?: string) {
  ledgerEmpty.remove();

  const li = document.createElement("li");
  li.className = `entry state-${state}`;

  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = new Date().toLocaleTimeString("en-US", { hour12: false });

  const nameEl = document.createElement("span");
  nameEl.className = "entry-name";
  nameEl.textContent = name;

  const detailEl = document.createElement("span");
  detailEl.className = "entry-detail";
  detailEl.textContent = detail;

  li.append(time, nameEl, detailEl);

  if (explorerUrl) {
    const link = document.createElement("a");
    link.className = "entry-link";
    link.href = explorerUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "explorer ↗";
    li.append(link);
  }

  ledger.prepend(li);
}

// ---------------------------------------------------------------------------
// Wallet connect
// ---------------------------------------------------------------------------

async function connectBrowserWallet() {
  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting…";

  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      alert("No Web3 wallet found! Please install MetaMask or use a Web3 browser.");
      throw new Error("No wallet");
    }

    const address = await requestAccount(ethereum);
    if (!address) throw new Error("Could not retrieve account address");

    connectedProvider = ethereum;
    connectedAddress = address;

    connectBtn.textContent = "Connected";
    walletAddressEl.hidden = false;
    walletAddressEl.textContent = shortAddress(address);
    setHint("Wallet connected. Enter an amount and start the bridge.");
    listenToWallet(ethereum);
    refreshBalance();
  } catch (err) {
    console.error(err);
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect Wallet";
    setHint("Wallet connection was rejected or failed.", "error");
  } finally {
    setBridgeButtonState();
  }
}

function resetWallet() {
  connectedProvider = null;
  connectedAddress = null;
  connectBtn.disabled = false;
  connectBtn.textContent = "Connect Wallet";
  walletAddressEl.hidden = true;
  walletAddressEl.textContent = "";
  setHint("Wallet disconnected. Connect again to bridge.");
  refreshBalance();
}

let listening = false;

// Keep the UI in sync when the user changes account or network in the wallet.
function listenToWallet(ethereum: any) {
  if (listening || typeof ethereum?.on !== "function") return;
  listening = true;

  ethereum.on("accountsChanged", (accounts: string[]) => {
    if (!accounts || accounts.length === 0) {
      resetWallet();
      return;
    }
    connectedAddress = accounts[0];
    walletAddressEl.hidden = false;
    walletAddressEl.textContent = shortAddress(accounts[0]);
    if (!bridging) setHint("Account changed in wallet.");
    refreshBalance();
  });

  ethereum.on("chainChanged", () => {
    // The bridge switches chains itself, so only refresh when idle.
    if (!bridging) refreshBalance();
  });
}

// ---------------------------------------------------------------------------
// Bridge flow
// ---------------------------------------------------------------------------

kit.on("*", (payload: any) => {
  const values = payload?.values ?? payload;
  const name: string = values?.name ?? payload?.method ?? "event";
  const state: string = values?.state ?? "pending";
  const txHash: string | undefined = values?.txHash ?? values?.data?.txHash;
  // Build the explorer link ourselves so it always uses the current explorer domains.
  // The mint step happens on the destination chain, everything else on the source chain.
  const stepChain: ChainKey = /mint/i.test(`${name} ${payload?.method ?? ""}`) ? toKey : fromKey;
  const explorerUrl: string | undefined = txHash
    ? CHAINS[stepChain].explorerTx(txHash)
    : values?.explorerUrl ?? values?.data?.explorerUrl;
  const eventError: any = values?.error ?? values?.data?.error;

  const normalizedState = state === "success" ? "success" : state === "error" ? "error" : "pending";

  let detail: string;
  if (normalizedState === "error") {
    const raw =
      eventError?.shortMessage || eventError?.reason || eventError?.message ||
      (eventError ? JSON.stringify(eventError).slice(0, 200) : "") ||
      JSON.stringify(values ?? {}).slice(0, 200);
    detail = raw || "error";
    console.error("kit event error:", name, values);
  } else {
    detail = txHash ? shortAddress(txHash) : state;
  }

  addLedgerEntry(name, normalizedState, detail, explorerUrl);

  if (normalizedState === "pending") {
    railPulse.classList.add("running");
    setLogStatus(name.toUpperCase() + "…");
  }
});

function failedStep(result: any): any {
  return (result?.steps ?? []).find((step: any) => step?.state === "error");
}

function wasRejectedByUser(result: any): boolean {
  const step = failedStep(result);
  return step?.errorCategory === "user_rejected" || isUserRejection(step?.error);
}

async function runBridge() {
  if (!connectedProvider || !connectedAddress) return;

  const amountError = validateAmount(amountInput.value);
  if (amountError) {
    setHint(amountError, "error");
    return;
  }
  // Normalize e.g. "1." or ".5" to "1" / "0.5" before passing it to App Kit.
  const amount = formatUnits(parseUnits(amountInput.value.trim(), USDC_DECIMALS), USDC_DECIMALS);
  bridging = true;
  bridgeBtn.disabled = true;
  connectBtn.disabled = true;
  switchBtn.disabled = true;
  setLogStatus("running…");
  setHint(`Sending ${amount} USDC from ${CHAINS[fromKey].label} to ${CHAINS[toKey].label}…`);
  railPulse.classList.add("running");

  try {
    const adapter = await createViemAdapterFromProvider({ 
      provider: connectedProvider,
      getPublicClient: ({ chain }) => {
        let rpcUrl = chain.rpcUrls.default.http[0];
        if (chain.id === 5042002) { // Arc Testnet: always use the official RPC
          rpcUrl = ARC_RPC_URL;
        }
        return createPublicClient({ chain, transport: http(rpcUrl) });
      }
    });

    // Ensure both source and destination chains are registered in the wallet
    // Check destination first, then source, so the wallet ends up on the source chain!
    await ensureChainRegistered(connectedProvider, toKey);
    await ensureChainRegistered(connectedProvider, fromKey);

    let result: any = await kit.bridge({
      from: { adapter, chain: CHAINS[fromKey].appKitId as any },
      to: { adapter, chain: CHAINS[toKey].appKitId as any },
      amount,
    });

    // Retry once, but never when the user rejected the request in the wallet.
    if (result.state === "error" && !wasRejectedByUser(result)) {
      addLedgerEntry("retry", "pending", "first attempt failed, retrying");
      result = await kit.retryBridge(result, { from: adapter, to: adapter });
    }

    if (result.state === "error") {
      if (wasRejectedByUser(result)) {
        throw new Error("Transaction rejected in your wallet. Nothing was retried.");
      }
      const failed = failedStep(result);
      const errObj: any = failed?.error;
      const detail =
        failed?.errorMessage || errObj?.shortMessage || errObj?.reason || errObj?.message ||
        (errObj ? JSON.stringify(errObj).slice(0, 300) : "Bridge failed");
      throw new Error(detail);
    }

    setLogStatus("done", "done");
    setHint(`Bridge complete: ${amount} USDC is now on ${CHAINS[toKey].label}.`, "success");
  } catch (err: any) {
    console.error(err);
    setLogStatus(isUserRejection(err) ? "rejected" : "error", "error");
    const detail = isUserRejection(err)
      ? "Request rejected in your wallet."
      : err?.shortMessage || err?.reason || err?.message ||
      (typeof err === "string" ? err : JSON.stringify(err, Object.getOwnPropertyNames(err || {})).slice(0, 300));
    setHint(detail || "Something went wrong during the bridge.", "error");
  } finally {
    railPulse.classList.remove("running");
    bridging = false;
    connectBtn.disabled = connectedAddress !== null;
    switchBtn.disabled = false;
    refreshBalance();
  }
}

connectBtn.addEventListener("click", connectBrowserWallet);
bridgeBtn.addEventListener("click", runBridge);
amountInput.addEventListener("input", setBridgeButtonState);

switchBtn.addEventListener("click", () => {
  [fromKey, toKey] = [toKey, fromKey];
  renderRoute();
  refreshBalance();
});

renderRoute();
setBridgeButtonState();
