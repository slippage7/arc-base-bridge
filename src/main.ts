import "@fontsource-variable/inter";
import "./style.css";
import { createPublicClient, erc20Abi, fallback, formatUnits, http, parseUnits } from "viem";
import type { EIP1193Provider, PublicClient } from "viem";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { AppKit } from "@circle-fin/app-kit";
import chainList from "./chains.json";

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

// src/chains.json lists every EVM testnet Circle App Kit can bridge USDC on
// (kit.getSupportedChains("bridge", { chainType: "evm", isTestnet: true })).
// Chain ids and USDC addresses come from the SDK; run `npm run check:chains`
// to compare them with the SDK and test every RPC.
type ChainInfo = {
  key: string; // App Kit chain identifier, e.g. "Base_Sepolia"
  name: string;
  badge: string;
  color: string;
  chainId: number;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  explorer: string;
  explorerTx: string; // contains {hash}
  usdc: `0x${string}`;
  cctpDomain: number;
};

const CHAINS = chainList as ChainInfo[];
const byKey = new Map(CHAINS.map((c) => [c.key, c]));
const byId = new Map(CHAINS.map((c) => [c.chainId, c]));
const chain = (key: string) => byKey.get(key)!;

// Official Arc Testnet RPC and explorer. Arc pays gas in USDC.
const ARC_KEY = "Arc_Testnet";
const ARC_RPC_URL = "https://rpc.testnet.arc.io";
const USDC_DECIMALS = 6;
const toHexId = (id: number) => `0x${id.toString(16)}`;
const txUrl = (c: ChainInfo, hash: string) => c.explorerTx.replace("{hash}", hash);
const gasLabel = (c: ChainInfo) => `${c.nativeCurrency.symbol} on ${c.name}`;

// Rough attestation time. Circle Fast Transfer is usually under a minute;
// chains that need full finality for standard transfers can take longer.
function estimatedTime(from: ChainInfo): string {
  if (from.key === "Ethereum_Sepolia") return "About 1–3 minutes (up to ~20 if Fast Transfer is unavailable)";
  return "About 1–3 minutes";
}

const savedRoute = (() => {
  try {
    return JSON.parse(localStorage.getItem("rail:route") || "null") as { from: string; to: string } | null;
  } catch {
    return null;
  }
})();
let fromKey = savedRoute && byKey.has(savedRoute.from) ? savedRoute.from : "Base_Sepolia";
let toKey = savedRoute && byKey.has(savedRoute.to) && savedRoute.to !== fromKey ? savedRoute.to : ARC_KEY;
if (toKey === fromKey) toKey = fromKey === ARC_KEY ? "Base_Sepolia" : ARC_KEY;

const publicClients = new Map<string, PublicClient>();
function publicClientFor(c: ChainInfo): PublicClient {
  let client = publicClients.get(c.key);
  if (!client) {
    client = createPublicClient({ transport: fallback(c.rpcUrls.map((u) => http(u, { timeout: 12_000 }))) }) as PublicClient;
    publicClients.set(c.key, client);
  }
  return client;
}

// Params for wallet_addEthereumChain.
function addChainParams(c: ChainInfo) {
  return {
    chainId: toHexId(c.chainId),
    chainName: c.name,
    rpcUrls: c.rpcUrls,
    nativeCurrency: c.nativeCurrency,
    blockExplorerUrls: [c.explorer],
  };
}

// ---------------------------------------------------------------------------
// Wallet error helpers
// ---------------------------------------------------------------------------

// Wallets often wrap the real error, e.g. MetaMask Mobile returns
// { code: -32603, data: { originalError: { code: 4902 } } }.
// This collects every code found on the error and its nested errors.
function collectErrorCodes(err: any, depth = 0): Array<number | string> {
  if (!err || typeof err !== "object" || depth > 8) return [];
  // App Kit's own RPC_ENDPOINT_ERROR also uses code 4001, but it is not a wallet rejection.
  const codes: Array<number | string> = err.name === "RPC_ENDPOINT_ERROR" ? [] : [err.code];
  // viem marks wallet rejections by name; App Kit nests them as cause.trace.rawError.rawError.cause.
  if (err.name === "UserRejectedRequestError") codes.push(4001);
  for (const inner of [err.data?.originalError, err.data, err.error, err.cause, err.trace, err.rawError]) {
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

class UserRejectedError extends Error {}

// Short, readable error text: no request dumps, hex calldata or library versions.
function friendlyError(err: any, fallbackMessage?: string): string {
  if (isUserRejection(err)) return "Rejected in your wallet.";
  const raw: string =
    err?.shortMessage || err?.reason || fallbackMessage || err?.message ||
    (typeof err === "string" ? err : "") || "Something went wrong.";
  let text = raw.split(/\n|Request Arguments:|Details:|Version:|Request body:/)[0].trim();
  if (text.length > 160) text = text.slice(0, 157).trimEnd() + "…";
  return text || "Something went wrong.";
}

// Switch the wallet to a chain, adding it first when the wallet does not know it (4902).
async function ensureChainRegistered(provider: EIP1193Provider, c: ChainInfo) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHexId(c.chainId) }] });
  } catch (switchError: any) {
    if (isUserRejection(switchError)) {
      throw new UserRejectedError(`You rejected switching to ${c.name} in your wallet.`);
    }
    if (!hasErrorCode(switchError, 4902)) {
      throw new Error(`Could not switch to ${c.name}: ${switchError?.message || "unknown error"}`);
    }
    try {
      await provider.request({ method: "wallet_addEthereumChain", params: [addChainParams(c)] as any });
    } catch (addError: any) {
      if (isUserRejection(addError)) {
        throw new UserRejectedError(`You rejected adding ${c.name} to your wallet.`);
      }
      throw new Error(`Could not add ${c.name} to your wallet: ${addError?.message || "unknown error"}`);
    }
  }
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect-btn");
const accountBox = $("account");
const accountChip = $<HTMLButtonElement>("account-chip");
const accountMenu = $("account-menu");
const accountAddress = $("account-address");
const menuAddress = $("menu-address");
const menuNetwork = $("menu-network");
const viewAddress = $<HTMLAnchorElement>("view-address");
const fromSelect = $<HTMLButtonElement>("from-select");
const toSelect = $<HTMLButtonElement>("to-select");
const fromBalanceEl = $("from-balance");
const toMetaEl = $("to-meta");
const swapBtn = $<HTMLButtonElement>("swap-btn");
const amountInput = $<HTMLInputElement>("amount");
const amountBox = $("amount-box");
const amountHelp = $("amount-help");
const amountBalance = $("amount-balance");
const maxBtn = $<HTMLButtonElement>("max-btn");
const sumReceive = $("sum-receive");
const sumTime = $("sum-time");
const sumGas = $("sum-gas");
const bridgeBtn = $<HTMLButtonElement>("bridge-btn");
const statusHint = $("status-hint");
const progressState = $("progress-state");
const stepsEl = $("steps");
const ledger = $("ledger");
const ledgerEmpty = $("ledger-empty");
const logStatus = $("log-status");
const picker = $("picker");
const pickerTitle = $("picker-title");
const pickerDesc = $("picker-desc");
const chainSearch = $<HTMLInputElement>("chain-search");
const chainListEl = $("chain-list");
const pickerEmpty = $("picker-empty");
const toasts = $("toasts");
const themeToggle = $<HTMLButtonElement>("theme-toggle");

$("chain-count").textContent = String(CHAINS.length);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let connectedProvider: EIP1193Provider | null = null;
let connectedAddress: string | null = null;
let walletChainId: number | null = null;
// USDC balance on the source chain (6 decimals), or null when unknown.
let sourceBalance: bigint | null = null;
let bridging = false;
let connecting = false;
const kit = new AppKit();

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function badge(c: ChainInfo, size: "md" | "sm" = "md") {
  const b = el("span", `chain-badge ${size}`, c.badge);
  b.style.setProperty("--c", c.color);
  if (c.badge.length >= 3) b.classList.add("long");
  b.setAttribute("aria-hidden", "true");
  return b;
}

function formatUsdc(units: bigint): string {
  const [whole, frac = ""] = formatUnits(units, USDC_DECIMALS).split(".");
  const trimmed = frac.replace(/0+$/, "");
  const shown = trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed;
  return `${Number(whole).toLocaleString("en-US")}.${shown}`;
}

function formatNative(value: bigint, decimals: number): string {
  const n = Number(formatUnits(value, decimals));
  if (n === 0) return "0";
  if (n < 0.0001) return "< 0.0001";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

type Tone = "info" | "success" | "error";
function toast(title: string, body = "", tone: Tone = "info") {
  const t = el("div", `toast toast-${tone}`);
  t.setAttribute("role", tone === "error" ? "alert" : "status");
  const icon = el("span", "toast-icon", tone === "success" ? "✓" : tone === "error" ? "!" : "i");
  icon.setAttribute("aria-hidden", "true");
  const text = el("div", "toast-text");
  text.append(el("strong", "", title));
  if (body) text.append(el("span", "", body));
  const close = el("button", "toast-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  t.append(icon, text, close);
  toasts.append(t);
  const remove = () => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 250);
  };
  close.addEventListener("click", remove);
  setTimeout(remove, tone === "error" ? 9000 : 5500);
}

function setHint(text: string, tone: "" | "error" | "success" = "") {
  statusHint.textContent = text;
  statusHint.className = `status-line ${tone}`.trim();
}

function setChip(node: HTMLElement, text: string, tone: "" | "live" | "done" | "error" = "") {
  node.textContent = text;
  node.className = `state-chip ${tone}`.trim();
}

// ---------------------------------------------------------------------------
// Route rendering
// ---------------------------------------------------------------------------

function renderSelect(button: HTMLButtonElement, c: ChainInfo) {
  button.replaceChildren();
  const text = el("span", "chain-text");
  text.append(el("span", "chain-name", c.name), el("span", "chain-sub", `Chain ID ${c.chainId} · gas in ${c.nativeCurrency.symbol}`));
  const caret = el("span", "caret");
  caret.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.append(badge(c), text, caret);
  button.dataset.chain = c.key;
}

function renderRoute() {
  const from = chain(fromKey);
  const to = chain(toKey);
  renderSelect(fromSelect, from);
  renderSelect(toSelect, to);
  document.querySelectorAll<HTMLElement>('[data-chain="from"]').forEach((n) => (n.textContent = from.name));
  document.querySelectorAll<HTMLElement>('[data-chain="to"]').forEach((n) => (n.textContent = to.name));
  sumTime.textContent = estimatedTime(from);
  sumGas.textContent =
    from.nativeCurrency.symbol === to.nativeCurrency.symbol && from.nativeCurrency.symbol !== "USDC"
      ? `${from.nativeCurrency.symbol} on both ${from.name} and ${to.name}`
      : `${gasLabel(from)} and ${gasLabel(to)}`;
  try {
    localStorage.setItem("rail:route", JSON.stringify({ from: fromKey, to: toKey }));
  } catch {
    // storage may be blocked; the route simply is not remembered
  }
  renderGasHelp();
  updateNetworkInfo();
  setBridgeButtonState();
}

function renderGasHelp() {
  const from = chain(fromKey);
  const to = chain(toKey);
  $("gas-help").textContent =
    `For this route: ${gasLabel(from)} for approve and burn, ${gasLabel(to)} for the mint. ` +
    `On Arc Testnet gas is paid in USDC.`;
}

// ---------------------------------------------------------------------------
// Chain picker
// ---------------------------------------------------------------------------

let pickerSide: "from" | "to" = "from";
let lastFocus: HTMLElement | null = null;

function openPicker(side: "from" | "to") {
  if (bridging) return;
  pickerSide = side;
  lastFocus = document.activeElement as HTMLElement;
  pickerTitle.textContent = side === "from" ? "Select source chain" : "Select destination chain";
  pickerDesc.textContent =
    side === "from" ? "USDC will be sent from this network." : "USDC will arrive on this network at the same address.";
  chainSearch.value = "";
  renderChainList();
  picker.hidden = false;
  requestAnimationFrame(() => picker.classList.add("open"));
  // Avoid popping up the mobile keyboard; focus the search only on wide screens.
  if (matchMedia("(min-width: 720px)").matches) chainSearch.focus();
  else (chainListEl.querySelector("button[aria-selected=true]") as HTMLElement | null)?.focus();
}

function closePicker() {
  picker.classList.remove("open");
  setTimeout(() => (picker.hidden = true), 180);
  lastFocus?.focus();
}

function renderChainList() {
  const q = chainSearch.value.trim().toLowerCase();
  const current = pickerSide === "from" ? fromKey : toKey;
  const other = pickerSide === "from" ? toKey : fromKey;
  chainListEl.replaceChildren();
  let shown = 0;
  for (const c of CHAINS) {
    if (q && !c.name.toLowerCase().includes(q) && !String(c.chainId).includes(q) && !c.nativeCurrency.symbol.toLowerCase().includes(q)) continue;
    shown++;
    const li = el("li");
    const btn = el("button", "chain-option");
    btn.type = "button";
    btn.dataset.key = c.key;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(c.key === current));
    const text = el("span", "chain-text");
    text.append(el("span", "chain-name", c.name), el("span", "chain-sub", `Chain ID ${c.chainId} · gas in ${c.nativeCurrency.symbol}`));
    btn.append(badge(c), text);
    if (c.key === current) btn.append(el("span", "opt-tag selected", "Selected"));
    else if (c.key === other) btn.append(el("span", "opt-tag", pickerSide === "from" ? "Destination · swap" : "Source · swap"));
    btn.addEventListener("click", () => chooseChain(c.key));
    li.append(btn);
    chainListEl.append(li);
  }
  pickerEmpty.hidden = shown > 0;
}

function chooseChain(key: string) {
  const prevFrom = fromKey;
  if (pickerSide === "from") {
    if (key === toKey) [fromKey, toKey] = [toKey, fromKey];
    else fromKey = key;
  } else {
    if (key === fromKey) [fromKey, toKey] = [toKey, fromKey];
    else toKey = key;
  }
  closePicker();
  renderRoute();
  if (fromKey !== prevFrom) onSourceChanged();
}

function swapRoute() {
  if (bridging) return;
  [fromKey, toKey] = [toKey, fromKey];
  swapBtn.classList.remove("spin");
  void swapBtn.offsetWidth;
  swapBtn.classList.add("spin");
  renderRoute();
  onSourceChanged();
}

// When the source chain changes, refresh balances and ask the wallet to follow.
function onSourceChanged() {
  refreshBalance();
  if (connectedProvider && walletChainId !== chain(fromKey).chainId) void switchWalletToSource(false);
}

async function switchWalletToSource(loud: boolean) {
  if (!connectedProvider) return;
  const from = chain(fromKey);
  try {
    await ensureChainRegistered(connectedProvider, from);
    walletChainId = from.chainId;
    updateNetworkInfo();
  } catch (err: any) {
    // Not fatal: the bridge asks again before it starts.
    if (loud || !(err instanceof UserRejectedError)) toast("Network not switched", err?.message || String(err), "error");
  }
}

// ---------------------------------------------------------------------------
// Balances and validation
// ---------------------------------------------------------------------------

// Returns an error text for the amount, or null when it is fine.
function validateAmount(value: string): string | null {
  const text = value.trim();
  if (text === "") return "Enter an amount";
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return "Enter a valid number";
  if ((text.split(".")[1] ?? "").length > USDC_DECIMALS) return "Use at most 6 decimals";
  const units = parseUnits(text, USDC_DECIMALS);
  if (units <= 0n) return "Enter an amount above 0";
  if (sourceBalance !== null && units > sourceBalance) return `Not enough USDC on ${chain(fromKey).name}`;
  return null;
}

let balanceRequest = 0;
async function refreshBalance() {
  const req = ++balanceRequest;
  sourceBalance = null;
  amountBalance.textContent = "";
  maxBtn.disabled = true;
  setBridgeButtonState();
  if (!connectedAddress) {
    fromBalanceEl.textContent = "Connect a wallet to see your balance";
    toMetaEl.textContent = "USDC arrives at the same address";
    return;
  }
  const from = chain(fromKey);
  const to = chain(toKey);
  const address = connectedAddress as `0x${string}`;
  fromBalanceEl.textContent = "Loading balance…";
  fromBalanceEl.classList.add("loading");
  toMetaEl.textContent = "Checking gas…";

  const [usdc, gasFrom, gasTo] = await Promise.allSettled([
    publicClientFor(from).readContract({ address: from.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    publicClientFor(from).getBalance({ address }),
    publicClientFor(to).getBalance({ address }),
  ]);
  if (req !== balanceRequest) return; // the route or account changed meanwhile
  fromBalanceEl.classList.remove("loading");

  if (usdc.status === "fulfilled") {
    sourceBalance = usdc.value;
    const text = `${formatUsdc(usdc.value)} USDC`;
    fromBalanceEl.textContent = `Balance: ${text}`;
    amountBalance.textContent = `Available: ${text}`;
    maxBtn.disabled = usdc.value === 0n;
  } else {
    // The balance is only a helper; if the RPC fails we simply skip the check.
    console.warn("Could not read USDC balance", usdc.reason);
    fromBalanceEl.textContent = "Balance unavailable right now";
  }

  const gasNote = (r: PromiseSettledResult<bigint>, c: ChainInfo) =>
    r.status === "fulfilled" ? `${formatNative(r.value, c.nativeCurrency.decimals)} ${c.nativeCurrency.symbol}` : "unknown";
  toMetaEl.textContent = `Gas here: ${gasNote(gasTo, to)}`;
  const lowFrom = gasFrom.status === "fulfilled" && gasFrom.value === 0n;
  const lowTo = gasTo.status === "fulfilled" && gasTo.value === 0n;
  toMetaEl.classList.toggle("warn", lowTo);
  if (lowFrom || lowTo) {
    const missing = [lowFrom ? gasLabel(from) : "", lowTo ? gasLabel(to) : ""].filter(Boolean).join(" and ");
    setHint(`You have no gas yet: add ${missing} before bridging.`, "error");
  } else if (!bridging && statusHint.classList.contains("error") && statusHint.textContent?.startsWith("You have no gas")) {
    setHint("Gas looks good on both chains.");
  }
  setBridgeButtonState();
}

function setBridgeButtonState() {
  const error = validateAmount(amountInput.value);
  const text = amountInput.value.trim();
  amountBox.classList.toggle("invalid", !!error && text !== "");
  if (error && text !== "" && connectedAddress) {
    amountHelp.textContent = error;
    amountHelp.classList.add("error");
  } else {
    amountHelp.textContent = "USDC uses 6 decimals, for example 25.5 or 0.000001.";
    amountHelp.classList.remove("error");
  }
  const to = chain(toKey);
  sumReceive.textContent = error ? `— on ${to.name}` : `≈ ${text.startsWith(".") ? "0" + text : text} USDC on ${to.name}`;

  if (bridging) return;
  bridgeBtn.classList.remove("loading");
  if (!connectedAddress) {
    bridgeBtn.disabled = connecting;
    bridgeBtn.textContent = connecting ? "Connecting…" : "Connect wallet to bridge";
    return;
  }
  if (error) {
    bridgeBtn.disabled = true;
    bridgeBtn.textContent = error;
    return;
  }
  bridgeBtn.disabled = false;
  bridgeBtn.textContent = `Bridge ${text.startsWith(".") ? "0" + text : text} USDC to ${to.name}`;
}

// ---------------------------------------------------------------------------
// Wallet connect
// ---------------------------------------------------------------------------

function getInjected(): EIP1193Provider | null {
  return ((window as any).ethereum as EIP1193Provider | undefined) ?? null;
}

function updateNetworkInfo() {
  if (!connectedAddress) return;
  const c = walletChainId !== null ? byId.get(walletChainId) : undefined;
  const from = chain(fromKey);
  if (walletChainId === null) menuNetwork.textContent = "Network: unknown";
  else menuNetwork.textContent = `Network: ${c ? c.name : `chain ${walletChainId}`}`;
  const mismatch = walletChainId !== null && walletChainId !== from.chainId;
  accountChip.classList.toggle("mismatch", mismatch);
  accountChip.title = mismatch ? `Wallet is on ${c?.name ?? `chain ${walletChainId}`}. Rail will switch to ${from.name}.` : "";
  viewAddress.href = `${from.explorer}/address/${connectedAddress}`;
}

function showConnected(address: string) {
  connectedAddress = address;
  connectBtn.hidden = true;
  accountBox.hidden = false;
  accountAddress.textContent = shortAddress(address);
  menuAddress.textContent = shortAddress(address);
  updateNetworkInfo();
}

async function readWalletChain(provider: EIP1193Provider) {
  try {
    walletChainId = Number.parseInt((await provider.request({ method: "eth_chainId" })) as string, 16);
  } catch {
    walletChainId = null;
  }
}

async function connectBrowserWallet() {
  if (connecting) return;
  const ethereum = getInjected();
  if (!ethereum) {
    toast("No wallet found", "Install MetaMask, Rabby or another browser wallet, then reload this page.", "error");
    setHint("No browser wallet found. Install one to start bridging.", "error");
    return;
  }
  connecting = true;
  connectBtn.disabled = true;
  connectBtn.querySelector(".connect-label")!.textContent = "Connecting…";
  setBridgeButtonState();
  try {
    await ethereum.request({ method: "eth_requestAccounts" });
    const accounts = (await ethereum.request({ method: "eth_accounts" })) as string[];
    const address = accounts[0];
    if (!address) throw new Error("Could not read your account address");
    connectedProvider = ethereum;
    await readWalletChain(ethereum);
    showConnected(address);
    try {
      localStorage.setItem("rail:connected", "1");
    } catch {
      // ignore
    }
    listenToWallet(ethereum);
    toast("Wallet connected", shortAddress(address), "success");
    setHint("Wallet connected. Enter an amount and start the bridge.");
    refreshBalance();
    if (walletChainId !== chain(fromKey).chainId) void switchWalletToSource(false);
  } catch (err) {
    console.warn("Wallet connection failed:", err);
    const rejected = isUserRejection(err);
    setHint(rejected ? "You rejected the connection request in your wallet." : "Wallet connection failed. Please try again.", "error");
    toast(rejected ? "Connection rejected" : "Connection failed", rejected ? "Nothing was shared with Rail." : friendlyError(err), "error");
  } finally {
    connecting = false;
    connectBtn.disabled = false;
    connectBtn.querySelector(".connect-label")!.textContent = "Connect wallet";
    setBridgeButtonState();
  }
}

// Reconnect silently on reload if the user connected before (no wallet prompt).
async function tryRestoreSession() {
  const ethereum = getInjected();
  let wanted = false;
  try {
    wanted = localStorage.getItem("rail:connected") === "1";
  } catch {
    // ignore
  }
  if (!ethereum || !wanted) return;
  try {
    const accounts = (await ethereum.request({ method: "eth_accounts" })) as string[];
    if (!accounts[0]) return;
    connectedProvider = ethereum;
    await readWalletChain(ethereum);
    showConnected(accounts[0]);
    listenToWallet(ethereum);
    refreshBalance();
  } catch {
    // ignore, the user can connect manually
  }
}

function resetWallet(message = "Wallet disconnected. Connect again to bridge.") {
  connectedProvider = null;
  connectedAddress = null;
  walletChainId = null;
  accountBox.hidden = true;
  accountMenu.hidden = true;
  accountChip.setAttribute("aria-expanded", "false");
  connectBtn.hidden = false;
  setHint(message);
  refreshBalance();
}

async function disconnect() {
  const provider = connectedProvider;
  try {
    localStorage.removeItem("rail:connected");
  } catch {
    // ignore
  }
  resetWallet();
  toast("Disconnected", "Rail forgot your wallet for this site.");
  // Best effort: wallets that support it also drop the site permission.
  try {
    await provider?.request({ method: "wallet_revokePermissions" as any, params: [{ eth_accounts: {} }] as any });
  } catch {
    // not supported by every wallet
  }
}

let listening = false;

// Keep the UI in sync when the user changes account or network in the wallet.
function listenToWallet(ethereum: any) {
  if (listening || typeof ethereum?.on !== "function") return;
  listening = true;

  ethereum.on("accountsChanged", (accounts: string[]) => {
    if (!connectedProvider) return;
    if (!accounts || accounts.length === 0) {
      resetWallet();
      return;
    }
    showConnected(accounts[0]);
    if (!bridging) setHint("Account changed in your wallet.");
    refreshBalance();
  });

  ethereum.on("chainChanged", (chainId: string) => {
    walletChainId = Number.parseInt(chainId, 16);
    updateNetworkInfo();
    // The bridge switches chains itself, so only refresh when idle.
    if (!bridging) refreshBalance();
  });
}

// ---------------------------------------------------------------------------
// Progress steps and activity ledger
// ---------------------------------------------------------------------------

type StepKey = "approve" | "burn" | "attestation" | "mint";
const STEP_ORDER: StepKey[] = ["approve", "burn", "attestation", "mint"];
type StepState = "idle" | "active" | "done" | "skipped" | "error";

function stepEl(key: StepKey) {
  return stepsEl.querySelector<HTMLLIElement>(`[data-step="${key}"]`)!;
}

function setStep(key: StepKey, state: StepState, note = "", link?: { url: string; label: string }) {
  const li = stepEl(key);
  li.dataset.state = state;
  const labels: Record<StepState, string> = { idle: "", active: "In progress", done: "Done", skipped: "Not needed", error: "Failed" };
  li.querySelector(".step-status")!.textContent = note || labels[state];
  const a = li.querySelector<HTMLAnchorElement>(".step-link");
  if (a) {
    if (link) {
      a.href = link.url;
      a.textContent = link.label;
      a.hidden = false;
    } else if (state === "idle") {
      a.hidden = true;
    }
  }
}

function resetSteps() {
  for (const k of STEP_ORDER) setStep(k, "idle");
  stepsEl.classList.remove("running");
}

function stepKeyFor(method: string): StepKey | null {
  const m = method.toLowerCase();
  if (m.includes("approve")) return "approve";
  if (m.includes("burn")) return "burn";
  if (m.includes("attest")) return "attestation";
  if (m.includes("mint")) return "mint";
  return null;
}

const STEP_TITLES: Record<StepKey, string> = {
  approve: "Approve USDC",
  burn: "Burn USDC",
  attestation: "Circle attestation",
  mint: "Mint USDC",
};

function addLedgerEntry(opts: { title: string; chain?: ChainInfo; state: "pending" | "success" | "error"; detail: string; url?: string }) {
  ledgerEmpty.remove();
  const li = el("li", `entry state-${opts.state}`);
  const icon = el("span", "entry-icon", opts.state === "success" ? "✓" : opts.state === "error" ? "!" : "•");
  icon.setAttribute("aria-hidden", "true");
  const main = el("div", "entry-main");
  const top = el("div", "entry-top");
  top.append(el("span", "entry-title", opts.title));
  if (opts.chain) {
    const tag = el("span", "entry-chain");
    tag.append(badge(opts.chain, "sm"), document.createTextNode(opts.chain.name));
    top.append(tag);
  }
  const bottom = el("div", "entry-bottom");
  bottom.append(el("span", "entry-detail", opts.detail));
  bottom.append(el("time", "entry-time", new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })));
  main.append(top, bottom);
  li.append(icon, main);
  if (opts.url) {
    const link = el("a", "entry-link", "View ↗");
    link.href = opts.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.setAttribute("aria-label", `View ${opts.title} on the ${opts.chain?.name ?? ""} explorer`);
    li.append(link);
  }
  ledger.prepend(li);
}

// Route that is currently being bridged (fixed for the whole run even if the UI changes).
let run: { from: ChainInfo; to: ChainInfo } | null = null;

kit.on("*", (payload: any) => {
  const values = payload?.values ?? payload;
  const method: string = payload?.method ?? values?.name ?? "event";
  const key = stepKeyFor(`${method} ${values?.name ?? ""}`);
  const state: string = values?.state ?? "pending";
  const txHash: string | undefined = values?.txHash ?? values?.data?.txHash;
  const r = run ?? { from: chain(fromKey), to: chain(toKey) };
  // The mint step happens on the destination chain, everything else on the source chain.
  const stepChain = key === "mint" ? r.to : r.from;
  // Build the explorer link ourselves so it always uses the current explorer domains.
  const url = txHash ? txUrl(stepChain, txHash) : undefined;
  const eventError: any = values?.error ?? values?.data?.error;
  const normalized = state === "success" ? "success" : state === "error" ? "error" : "pending";

  let detail: string;
  if (normalized === "error") {
    detail = friendlyError(eventError, values?.errorMessage);
    console.warn("Bridge step failed:", method, values);
  } else {
    detail = txHash ? `Tx ${shortAddress(txHash)}` : normalized === "success" ? "Confirmed" : "Waiting…";
  }

  if (key) {
    // Earlier steps that never reported (e.g. approve when allowance was enough) were not needed.
    const idx = STEP_ORDER.indexOf(key);
    for (const prev of STEP_ORDER.slice(0, idx)) {
      const s = stepEl(prev).dataset.state;
      if (s === "idle" || s === "active") setStep(prev, prev === "approve" ? "skipped" : "done");
    }
    const link = url ? { url, label: `${txHash ? shortAddress(txHash) : "Transaction"} on ${stepChain.name} ↗` } : undefined;
    if (normalized === "success") {
      setStep(key, "done", "", link);
      const next = STEP_ORDER[idx + 1];
      if (next) setStep(next, "active", next === "attestation" ? "Waiting for Circle" : next === "mint" ? "Confirm in wallet" : "Confirm in wallet");
    } else if (normalized === "error") {
      setStep(key, "error", "", link);
    } else {
      setStep(key, "active", "", link);
    }
    setChip(logStatus, `${STEP_TITLES[key]}…`, "live");
  }

  addLedgerEntry({
    title: key ? STEP_TITLES[key] : method,
    chain: key === "attestation" ? undefined : stepChain,
    state: normalized,
    detail,
    url,
  });
});

function failedStep(result: any): any {
  return (result?.steps ?? []).find((step: any) => step?.state === "error");
}

function wasRejectedByUser(result: any): boolean {
  const step = failedStep(result);
  return step?.errorCategory === "user_rejected" || isUserRejection(step?.error);
}

function lockForm(locked: boolean) {
  for (const b of [fromSelect, toSelect, swapBtn, maxBtn]) b.disabled = locked;
  amountInput.disabled = locked;
  if (!locked) maxBtn.disabled = !sourceBalance;
  document.body.classList.toggle("is-bridging", locked);
}

async function runBridge() {
  if (bridging) return;
  if (!connectedProvider || !connectedAddress) {
    await connectBrowserWallet();
    return;
  }
  const amountError = validateAmount(amountInput.value);
  if (amountError) {
    setHint(amountError, "error");
    return;
  }
  // Normalize e.g. "1." or ".5" to "1" / "0.5" before passing it to App Kit.
  const amount = formatUnits(parseUnits(amountInput.value.trim(), USDC_DECIMALS), USDC_DECIMALS);
  const from = chain(fromKey);
  const to = chain(toKey);
  run = { from, to };
  bridging = true;
  lockForm(true);
  bridgeBtn.disabled = true;
  bridgeBtn.classList.add("loading");
  bridgeBtn.textContent = "Bridging…";
  resetSteps();
  stepsEl.classList.add("running");
  setChip(progressState, "In progress", "live");
  setChip(logStatus, "Switching network…", "live");
  setStep("approve", "active", "Preparing…");
  setHint(`Sending ${amount} USDC from ${from.name} to ${to.name}. Keep this tab open.`);

  try {
    const adapter = await createViemAdapterFromProvider({
      provider: connectedProvider,
      // Read chain data through Rail's RPC list (always the official Arc RPC first).
      getPublicClient: ({ chain: viemChain }) => {
        const known = byId.get(viemChain.id);
        const urls = viemChain.id === 5042002 ? [ARC_RPC_URL, ...(known?.rpcUrls.slice(1) ?? [])] : known?.rpcUrls ?? [viemChain.rpcUrls.default.http[0]];
        return createPublicClient({ chain: viemChain, transport: fallback(urls.map((u) => http(u))) });
      },
    });

    // Make sure both chains are known to the wallet. Destination first, then source,
    // so the wallet ends up on the source chain.
    await ensureChainRegistered(connectedProvider, to);
    await ensureChainRegistered(connectedProvider, from);
    walletChainId = from.chainId;
    updateNetworkInfo();
    setStep("approve", "active", "Confirm in wallet");
    setChip(logStatus, "Waiting for wallet…", "live");

    let result: any = await kit.bridge({
      from: { adapter, chain: from.key as any },
      to: { adapter, chain: to.key as any },
      amount,
    });

    // Retry once, but never when the user rejected the request in the wallet.
    if (result.state === "error" && !wasRejectedByUser(result)) {
      addLedgerEntry({ title: "Retrying", state: "pending", detail: "The first attempt failed, trying once more" });
      result = await kit.retryBridge(result, { from: adapter, to: adapter });
    }

    if (result.state === "error") {
      if (wasRejectedByUser(result)) throw new UserRejectedError("Transaction rejected in your wallet. Nothing was retried.");
      const failed = failedStep(result);
      throw new Error(friendlyError(failed?.error, failed?.errorMessage));
    }

    for (const k of STEP_ORDER) if (stepEl(k).dataset.state !== "done" && stepEl(k).dataset.state !== "skipped") setStep(k, "done");
    setChip(progressState, "Complete", "done");
    setChip(logStatus, "Done", "done");
    setHint(`Done: ${amount} USDC is now on ${to.name}.`, "success");
    toast("Bridge complete", `${amount} USDC arrived on ${to.name}.`, "success");
  } catch (err: any) {
    console.warn("Bridge stopped:", err);
    const rejected = err instanceof UserRejectedError || isUserRejection(err);
    for (const k of STEP_ORDER) if (stepEl(k).dataset.state === "active") setStep(k, "error", rejected ? "Rejected" : "Failed");
    setChip(progressState, rejected ? "Rejected" : "Failed", "error");
    setChip(logStatus, rejected ? "Rejected" : "Error", "error");
    const detail = rejected && !(err instanceof UserRejectedError)
      ? "Request rejected in your wallet. Nothing was retried."
      : err instanceof UserRejectedError ? err.message : friendlyError(err);
    setHint(detail || "Something went wrong during the bridge.", "error");
    toast(rejected ? "Request rejected" : "Bridge failed", detail || "", "error");
  } finally {
    stepsEl.classList.remove("running");
    bridging = false;
    run = null;
    lockForm(false);
    refreshBalance();
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyThemeLabel() {
  const dark = document.documentElement.dataset.theme !== "light";
  themeToggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#070b14" : "#f5f7fb");
}

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.classList.add("theme-anim");
  document.documentElement.dataset.theme = next;
  setTimeout(() => document.documentElement.classList.remove("theme-anim"), 400);
  try {
    localStorage.setItem("rail:theme", next);
  } catch {
    // ignore
  }
  applyThemeLabel();
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

connectBtn.addEventListener("click", connectBrowserWallet);
bridgeBtn.addEventListener("click", runBridge);
amountInput.addEventListener("input", setBridgeButtonState);
amountInput.addEventListener("blur", () => {
  const t = amountInput.value.trim();
  if (!validateAmount(t) && t.startsWith(".")) amountInput.value = `0${t}`;
});
maxBtn.addEventListener("click", () => {
  if (sourceBalance === null) return;
  amountInput.value = formatUnits(sourceBalance, USDC_DECIMALS);
  setBridgeButtonState();
});
swapBtn.addEventListener("click", swapRoute);
fromSelect.addEventListener("click", () => openPicker("from"));
toSelect.addEventListener("click", () => openPicker("to"));
chainSearch.addEventListener("input", renderChainList);
chainSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") (chainListEl.querySelector("button") as HTMLButtonElement | null)?.click();
});
picker.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-close]")) closePicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!picker.hidden) closePicker();
  if (!accountMenu.hidden) toggleMenu(false);
});

function toggleMenu(open = accountMenu.hidden) {
  accountMenu.hidden = !open;
  accountChip.setAttribute("aria-expanded", String(open));
}
accountChip.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu();
});
document.addEventListener("click", (e) => {
  if (!accountMenu.hidden && !(e.target as HTMLElement).closest("#account")) toggleMenu(false);
});
$("copy-address").addEventListener("click", async () => {
  if (!connectedAddress) return;
  try {
    await navigator.clipboard.writeText(connectedAddress);
    toast("Address copied", shortAddress(connectedAddress), "success");
  } catch {
    toast("Could not copy", connectedAddress, "error");
  }
  toggleMenu(false);
});
$("disconnect-btn").addEventListener("click", () => void disconnect());

applyThemeLabel();
resetSteps();
renderRoute();
void tryRestoreSession();
