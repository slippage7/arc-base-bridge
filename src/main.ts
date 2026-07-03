import type { EIP1193Provider } from "viem";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { AppKit } from "@circle-fin/app-kit";

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

type ChainKey = "base" | "arc";

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
    explorerTx: (hash) => `https://testnet.arcscan.app/tx/${hash}`,
  },
};

// Direction: fromKey -> toKey. Starts Base -> Arc.
let fromKey: ChainKey = "base";
let toKey: ChainKey = "arc";

// ---------------------------------------------------------------------------
// Wallet discovery (EIP-6963)
// ---------------------------------------------------------------------------

type EIP6963ProviderInfo = { uuid: string; name: string; icon: string; rdns: string };
type EIP6963ProviderDetail = { info: EIP6963ProviderInfo; provider: EIP1193Provider };

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<EIP6963ProviderDetail>;
  }
}

async function discoverBrowserWallets(): Promise<EIP6963ProviderDetail[]> {
  const providers = new Map<string, EIP6963ProviderDetail>();

  const handle = (event: WindowEventMap["eip6963:announceProvider"]) => {
    providers.set(event.detail.info.uuid, event.detail);
  };

  window.addEventListener("eip6963:announceProvider", handle);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  window.removeEventListener("eip6963:announceProvider", handle);

  const found = [...providers.values()];
  if (found.length > 0) return found;

  // Fallback for mobile wallet in-app browsers (MetaMask Mobile, Trust Wallet,
  // Rainbow, etc.) that inject window.ethereum but don't announce via EIP-6963.
  const injected = (window as any).ethereum as EIP1193Provider | undefined;
  if (injected) {
    return [
      {
        info: { uuid: "injected", name: "Cüzdan tarayıcısı", icon: "", rdns: "injected" },
        provider: injected,
      },
    ];
  }

  return [];
}

async function requestAccount(provider: EIP1193Provider): Promise<string | null> {
  await provider.request({ method: "eth_requestAccounts", params: undefined });
  const accounts = (await provider.request({ method: "eth_accounts", params: undefined })) as string[];
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let connectedProvider: EIP1193Provider | null = null;
let connectedAddress: string | null = null;
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

function setBridgeButtonState() {
  if (!connectedAddress) {
    bridgeBtn.disabled = true;
    bridgeBtn.textContent = "Önce cüzdanı bağla";
    return;
  }
  const amount = Number(amountInput.value);
  if (!amount || amount <= 0) {
    bridgeBtn.disabled = true;
    bridgeBtn.textContent = "Geçerli bir miktar gir";
    return;
  }
  bridgeBtn.disabled = false;
  bridgeBtn.textContent = `${CHAINS[fromKey].label} → ${CHAINS[toKey].label} bridge et`;
}

function setHint(text: string, tone: "" | "error" | "success" = "") {
  statusHint.textContent = text;
  statusHint.className = `hint ${tone}`.trim();
}

function setLogStatus(text: string, tone: "" | "done" | "error" = "") {
  logStatus.textContent = text;
  logStatus.className = `log-header-sub ${tone}`.trim();
}

function clearLedger() {
  ledger.innerHTML = "";
}

function addLedgerEntry(name: string, state: "pending" | "success" | "error", detail: string, explorerUrl?: string) {
  ledgerEmpty.remove();

  const li = document.createElement("li");
  li.className = `entry state-${state}`;

  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = new Date().toLocaleTimeString("tr-TR", { hour12: false });

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
  const providers = await discoverBrowserWallets();
  if (providers.length === 0) {
    setHint(
      "Cüzdan bulunamadı. Telefondaysan bu sayfayı MetaMask uygulamasının içindeki tarayıcıdan aç (MetaMask → Browser → adresi yapıştır).",
      "error",
    );
    return;
  }

  const selected =
    providers.find(({ info }) => info.rdns === "io.metamask" || info.name === "MetaMask") ?? providers[0];

  connectBtn.disabled = true;
  connectBtn.textContent = "Bağlanıyor…";

  try {
    const address = await requestAccount(selected.provider);
    if (!address) throw new Error("Hesap adresi alınamadı");

    connectedProvider = selected.provider;
    connectedAddress = address;

    connectBtn.textContent = `${selected.info.name} bağlı`;
    walletAddressEl.hidden = false;
    walletAddressEl.textContent = shortAddress(address);
    setHint("Cüzdan bağlandı. Miktarı gir ve bridge işlemini başlat.");
  } catch (err) {
    console.error(err);
    connectBtn.disabled = false;
    connectBtn.textContent = "Cüzdan bağla (MetaMask)";
    setHint("Cüzdan bağlantısı reddedildi ya da başarısız oldu.", "error");
  } finally {
    setBridgeButtonState();
  }
}

// ---------------------------------------------------------------------------
// Bridge flow
// ---------------------------------------------------------------------------

kit.on("*", (payload: any) => {
  const values = payload?.values ?? payload;
  const name: string = values?.name ?? payload?.method ?? "event";
  const state: string = values?.state ?? "pending";
  const explorerUrl: string | undefined = values?.explorerUrl ?? values?.data?.explorerUrl;
  const txHash: string | undefined = values?.txHash ?? values?.data?.txHash;

  const detail = txHash ? shortAddress(txHash) : state;
  const normalizedState = state === "success" ? "success" : state === "error" ? "error" : "pending";

  addLedgerEntry(name, normalizedState, detail, explorerUrl);

  if (normalizedState === "pending") {
    railPulse.classList.add("running");
    setLogStatus(name.toUpperCase() + "…");
  }
});

async function runBridge() {
  if (!connectedProvider || !connectedAddress) return;

  const amount = amountInput.value.trim();
  bridgeBtn.disabled = true;
  connectBtn.disabled = true;
  switchBtn.disabled = true;
  clearLedgerIfFirstRun();
  setLogStatus("çalışıyor…");
  setHint(`${amount} USDC, ${CHAINS[fromKey].label} → ${CHAINS[toKey].label} olarak gönderiliyor…`);
  railPulse.classList.add("running");

  try {
    const adapter = await createViemAdapterFromProvider({ provider: connectedProvider });

    let result: any = await kit.bridge({
      from: { adapter, chain: CHAINS[fromKey].appKitId },
      to: { adapter, chain: CHAINS[toKey].appKitId },
      amount,
    });

    if (result.state === "error") {
      addLedgerEntry("retry", "pending", "ilk deneme başarısız, tekrar deneniyor");
      result = await kit.retryBridge(result, { from: adapter, to: adapter });
    }

    if (result.state === "error") {
      throw new Error(result.error?.message ?? "Bridge başarısız oldu");
    }

    setLogStatus("tamamlandı", "done");
    setHint(`Bridge tamamlandı: ${amount} USDC şimdi ${CHAINS[toKey].label} üzerinde.`, "success");
  } catch (err: any) {
    console.error(err);
    setLogStatus("hata", "error");
    setHint(err?.message ?? "Bridge sırasında bir hata oluştu.", "error");
  } finally {
    railPulse.classList.remove("running");
    connectBtn.disabled = false;
    switchBtn.disabled = false;
    setBridgeButtonState();
  }
}

let hasRunOnce = false;
function clearLedgerIfFirstRun() {
  if (!hasRunOnce) {
    hasRunOnce = true;
    return;
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

connectBtn.addEventListener("click", connectBrowserWallet);
bridgeBtn.addEventListener("click", runBridge);
amountInput.addEventListener("input", setBridgeButtonState);

switchBtn.addEventListener("click", () => {
  [fromKey, toKey] = [toKey, fromKey];
  renderRoute();
  setBridgeButtonState();
});

renderRoute();
setBridgeButtonState();
