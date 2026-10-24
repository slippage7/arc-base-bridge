import "@fontsource-variable/inter";
import "./style.css";
import { createPublicClient, erc20Abi, fallback, formatUnits, http, parseUnits } from "viem";
import type { EIP1193Provider, PublicClient } from "viem";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { AppKit } from "@circle-fin/app-kit";
import chainList from "./chains.json";
import {
  applyTranslations, decimalSeparator, formatAmount, getLang, locale, msg, onLangChange, raw, render, setAttr, setLang, setText,
} from "./i18n";
import type { Key, Lang, Msg, Text } from "./i18n";

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
  logo: string; // self-hosted image in public/chains
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
const gasLabel = (c: ChainInfo): Msg => msg("gas.label", { symbol: c.nativeCurrency.symbol, chain: c.name });

// Rough attestation time. Circle Fast Transfer is usually under a minute;
// chains that need full finality for standard transfers can take longer.
function estimatedTime(from: ChainInfo): Key {
  return from.key === "Ethereum_Sepolia" ? "time.slow" : "time.normal";
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

// Errors that carry a translatable message, so the text follows the language toggle.
class LocalizedError extends Error {
  text: Text;
  constructor(text: Text) {
    super(render(text));
    this.text = text;
  }
}
class UserRejectedError extends LocalizedError {}

function errorText(err: any): Text {
  return err instanceof LocalizedError ? err.text : raw(err?.message || String(err));
}

// Short, readable error text: no request dumps, hex calldata or library versions.
// Messages from App Kit, viem or the wallet are shown as they are (not translated).
function friendlyError(err: any, fallbackMessage?: string): Text {
  if (err instanceof LocalizedError) return err.text;
  if (isUserRejection(err)) return msg("error.rejected");
  const source: string =
    err?.shortMessage || err?.reason || fallbackMessage || err?.message || (typeof err === "string" ? err : "");
  let text = source.split(/\n|Request Arguments:|Details:|Version:|Request body:/)[0].trim();
  if (text.length > 160) text = text.slice(0, 157).trimEnd() + "…";
  return text ? raw(text) : msg("error.generic");
}

// Switch the wallet to a chain, adding it first when the wallet does not know it (4902).
async function ensureChainRegistered(provider: EIP1193Provider, c: ChainInfo) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHexId(c.chainId) }] });
  } catch (switchError: any) {
    if (isUserRejection(switchError)) {
      throw new UserRejectedError(msg("error.switchRejected", { chain: c.name }));
    }
    if (!hasErrorCode(switchError, 4902)) {
      throw new LocalizedError(msg("error.switchFailed", { chain: c.name, error: switchError?.message || msg("error.unknown") }));
    }
    try {
      await provider.request({ method: "wallet_addEthereumChain", params: [addChainParams(c)] as any });
    } catch (addError: any) {
      if (isUserRejection(addError)) {
        throw new UserRejectedError(msg("error.addRejected", { chain: c.name }));
      }
      throw new LocalizedError(msg("error.addFailed", { chain: c.name, error: addError?.message || msg("error.unknown") }));
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
const langSwitch = $("lang-switch");
const burnTitle = $("burn-title");
const mintTitle = $("mint-title");
const gasHelp = $("gas-help");

setText($("meta-title"), "meta.title", { others: CHAINS.length - 1 });
setAttr($("meta-description"), "content", "meta.description", { more: CHAINS.length - 3 });
setText($("hero-pill"), "hero.pill", { count: CHAINS.length });

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
// Last native (gas) balances, kept so texts can be re-rendered in another language.
let gasBalances: { from: bigint | null; to: bigint | null; fromOk: boolean; toOk: boolean } | null = null;
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

// Monogram in the chain's brand color; only shown if a logo image fails to load.
function badge(c: ChainInfo, size: LogoSize = "md") {
  const b = el("span", `chain-badge ${size}`, c.badge);
  b.style.setProperty("--c", c.color);
  if (c.badge.length >= 3) b.classList.add("long");
  b.setAttribute("role", "img");
  setAttr(b, "aria-label", "chain.logoAlt", { chain: c.name });
  return b;
}

type LogoSize = "md" | "sm" | "xs";
const LOGO_PX: Record<LogoSize, number> = { md: 40, sm: 20, xs: 18 };

// Round, self-hosted chain logo with the monogram as fallback.
function chainLogo(c: ChainInfo, size: LogoSize = "md") {
  const wrap = el("span", `chain-logo ${size}`);
  wrap.style.setProperty("--c", c.color);
  wrap.dataset.chain = c.key;
  const img = el("img");
  img.addEventListener("error", () => wrap.replaceWith(badge(c, size)), { once: true });
  img.width = img.height = LOGO_PX[size];
  img.decoding = "async";
  img.draggable = false;
  setAttr(img, "alt", "chain.logoAlt", { chain: c.name });
  img.src = c.logo;
  wrap.append(img);
  return wrap;
}

// USDC amount as a plain decimal string ("1234.5"), at least 2 decimals.
function usdcString(units: bigint): string {
  const [whole, frac = ""] = formatUnits(units, USDC_DECIMALS).split(".");
  const trimmed = frac.replace(/0+$/, "");
  return `${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed}`;
}

function formatNative(value: bigint, decimals: number): string {
  const n = Number(formatUnits(value, decimals));
  if (n === 0) return "0";
  if (n < 0.0001) return `< ${(0.0001).toLocaleString(locale())}`;
  return n.toLocaleString(locale(), { maximumFractionDigits: 4 });
}

// Accepts "1.5" and "1,5"; returns a dot-decimal string or null when it is not a number.
function normalizeAmount(value: string): string | null {
  const text = value.trim();
  if (text.includes(",") && text.includes(".")) return null;
  const dotted = text.replace(",", ".");
  return /^(\d+(\.\d*)?|\.\d+)$/.test(dotted) ? dotted : null;
}

type Tone = "info" | "success" | "error";
function toast(title: Text | Key, body: Text | string = "", tone: Tone = "info") {
  const t = el("div", `toast toast-${tone}`);
  t.setAttribute("role", tone === "error" ? "alert" : "status");
  const icon = el("span", "toast-icon", tone === "success" ? "✓" : tone === "error" ? "!" : "i");
  icon.setAttribute("aria-hidden", "true");
  const text = el("div", "toast-text");
  const strong = el("strong");
  setText(strong, title);
  text.append(strong);
  if (body) {
    const span = el("span");
    setText(span, typeof body === "string" ? raw(body) : body);
    text.append(span);
  }
  const close = el("button", "toast-close", "×");
  close.type = "button";
  setAttr(close, "aria-label", "toast.dismiss");
  t.append(icon, text, close);
  toasts.append(t);
  const remove = () => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 250);
  };
  close.addEventListener("click", remove);
  setTimeout(remove, tone === "error" ? 9000 : 5500);
}

let hintIsNoGas = false;
function setHint(text: Text | Key, tone: "" | "error" | "success" = "") {
  setText(statusHint, text);
  statusHint.className = `status-line ${tone}`.trim();
  hintIsNoGas = false;
}

function setChip(node: HTMLElement, text: Text | Key, tone: "" | "live" | "done" | "error" = "") {
  setText(node, text);
  node.className = `state-chip ${tone}`.trim();
}

function chainSub(c: ChainInfo) {
  const sub = el("span", "chain-sub");
  setText(sub, "chain.sub", { id: c.chainId, symbol: c.nativeCurrency.symbol });
  return sub;
}

// ---------------------------------------------------------------------------
// Route rendering
// ---------------------------------------------------------------------------

function renderSelect(button: HTMLButtonElement, c: ChainInfo) {
  button.replaceChildren();
  const text = el("span", "chain-text");
  text.append(el("span", "chain-name", c.name), chainSub(c));
  const caret = el("span", "caret");
  caret.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.append(chainLogo(c), text, caret);
  button.dataset.chain = c.key;
}

function renderRoute() {
  const from = chain(fromKey);
  const to = chain(toKey);
  renderSelect(fromSelect, from);
  renderSelect(toSelect, to);
  setText(burnTitle, "step.burn.title", { chain: from.name });
  setText(mintTitle, "step.mint.title", { chain: to.name });
  setText(sumTime, estimatedTime(from));
  const gasText = el("span");
  setText(
    gasText,
    from.nativeCurrency.symbol === to.nativeCurrency.symbol && from.nativeCurrency.symbol !== "USDC"
      ? msg("summary.gasBoth", { symbol: from.nativeCurrency.symbol, a: from.name, b: to.name })
      : msg("summary.gasPair", { a: gasLabel(from), b: gasLabel(to) }),
  );
  const pair = el("span", "logo-pair");
  pair.append(chainLogo(from, "xs"), chainLogo(to, "xs"));
  sumGas.replaceChildren(pair, gasText);
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
  setText(gasHelp, "gas.help", { from: gasLabel(from), to: gasLabel(to) });
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
  setText(pickerTitle, side === "from" ? "picker.fromTitle" : "picker.toTitle");
  setText(pickerDesc, side === "from" ? "picker.fromDesc" : "picker.toDesc");
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
    text.append(el("span", "chain-name", c.name), chainSub(c));
    btn.append(chainLogo(c), text);
    const tag = (cls: string, key: Key) => {
      const span = el("span", cls);
      setText(span, key);
      btn.append(span);
    };
    if (c.key === current) tag("opt-tag selected", "picker.selected");
    else if (c.key === other) tag("opt-tag", pickerSide === "from" ? "picker.isDestination" : "picker.isSource");
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
    if (loud || !(err instanceof UserRejectedError)) toast("toast.networkNotSwitched", errorText(err), "error");
  }
}

// ---------------------------------------------------------------------------
// Balances and validation
// ---------------------------------------------------------------------------

// Returns an error message for the amount, or null when it is fine.
function validateAmount(value: string): Msg | null {
  if (value.trim() === "") return msg("amount.errEmpty");
  const text = normalizeAmount(value);
  if (text === null) return msg("amount.errNumber");
  if ((text.split(".")[1] ?? "").length > USDC_DECIMALS) return msg("amount.errDecimals");
  const units = parseUnits(text, USDC_DECIMALS);
  if (units <= 0n) return msg("amount.errZero");
  if (sourceBalance !== null && units > sourceBalance) return msg("amount.errBalance", { chain: chain(fromKey).name });
  return null;
}

// Valid amount as a dot-decimal string with a leading zero ("0.5"), or null.
function amountValue(): string | null {
  if (validateAmount(amountInput.value)) return null;
  const text = normalizeAmount(amountInput.value)!;
  return text.startsWith(".") ? `0${text}` : text;
}

let balanceRequest = 0;
async function refreshBalance() {
  const req = ++balanceRequest;
  sourceBalance = null;
  gasBalances = null;
  setText(amountBalance, raw(""));
  maxBtn.disabled = true;
  setBridgeButtonState();
  toMetaEl.classList.remove("warn");
  if (!connectedAddress) {
    setText(fromBalanceEl, "from.connectHint");
    setText(toMetaEl, "to.sameAddress");
    return;
  }
  const from = chain(fromKey);
  const to = chain(toKey);
  const address = connectedAddress as `0x${string}`;
  setText(fromBalanceEl, "balance.loading");
  fromBalanceEl.classList.add("loading");
  setText(toMetaEl, "balance.checkingGas");

  const [usdc, gasFrom, gasTo] = await Promise.allSettled([
    publicClientFor(from).readContract({ address: from.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    publicClientFor(from).getBalance({ address }),
    publicClientFor(to).getBalance({ address }),
  ]);
  if (req !== balanceRequest) return; // the route or account changed meanwhile
  fromBalanceEl.classList.remove("loading");

  if (usdc.status === "fulfilled") {
    sourceBalance = usdc.value;
    maxBtn.disabled = usdc.value === 0n;
  } else {
    // The balance is only a helper; if the RPC fails we simply skip the check.
    console.warn("Could not read USDC balance", usdc.reason);
  }
  gasBalances = {
    from: gasFrom.status === "fulfilled" ? gasFrom.value : null,
    to: gasTo.status === "fulfilled" ? gasTo.value : null,
    fromOk: gasFrom.status === "fulfilled",
    toOk: gasTo.status === "fulfilled",
  };
  renderBalances();

  const lowFrom = gasBalances.from === 0n;
  const lowTo = gasBalances.to === 0n;
  toMetaEl.classList.toggle("warn", lowTo);
  if (lowFrom || lowTo) {
    const missing = lowFrom && lowTo
      ? msg("summary.gasPair", { a: gasLabel(from), b: gasLabel(to) })
      : gasLabel(lowFrom ? from : to);
    setHint(msg("hint.noGas", { missing }), "error");
    hintIsNoGas = true;
  } else if (!bridging && hintIsNoGas) {
    setHint("hint.gasOk");
  }
  setBridgeButtonState();
}

// Balance texts, rendered from the last fetched values (numbers follow the language).
function renderBalances() {
  if (!connectedAddress || !gasBalances) return;
  const to = chain(toKey);
  if (sourceBalance !== null) {
    const value = `${formatAmount(usdcString(sourceBalance))} USDC`;
    setText(fromBalanceEl, "balance.value", { value });
    setText(amountBalance, "balance.available", { value });
  } else {
    setText(fromBalanceEl, "balance.unavailable");
  }
  const gasValue = gasBalances.to !== null
    ? `${formatNative(gasBalances.to, to.nativeCurrency.decimals)} ${to.nativeCurrency.symbol}`
    : msg("balance.unknown");
  setText(toMetaEl, "balance.gasHere", { value: gasValue });
}

function setBridgeButtonState() {
  const error = validateAmount(amountInput.value);
  const text = amountInput.value.trim();
  amountBox.classList.toggle("invalid", !!error && text !== "");
  if (error && text !== "" && connectedAddress) {
    setText(amountHelp, error);
    amountHelp.classList.add("error");
  } else {
    setText(amountHelp, "amount.help");
    amountHelp.classList.remove("error");
  }
  const to = chain(toKey);
  const amount = amountValue();
  const receive = el("span");
  setText(receive, amount === null ? msg("summary.receiveNone", { chain: to.name }) : msg("summary.receiveValue", { amount: { amount }, chain: to.name }));
  sumReceive.replaceChildren(chainLogo(to, "xs"), receive);

  if (bridging) return;
  bridgeBtn.classList.remove("loading");
  if (!connectedAddress) {
    bridgeBtn.disabled = connecting;
    setText(bridgeBtn, connecting ? "button.connecting" : "button.connect");
    return;
  }
  if (error || amount === null) {
    bridgeBtn.disabled = true;
    setText(bridgeBtn, error ?? msg("amount.errNumber"));
    return;
  }
  bridgeBtn.disabled = false;
  setText(bridgeBtn, "button.bridge", { amount: { amount }, chain: to.name });
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
  const walletName = c ? c.name : msg("account.chainNumber", { id: walletChainId ?? 0 });
  const networkText = el("span");
  setText(networkText, walletChainId === null ? msg("account.networkUnknown") : msg("account.network", { name: walletName }));
  menuNetwork.replaceChildren(...(c ? [chainLogo(c, "xs")] : []), networkText);
  const mismatch = walletChainId !== null && walletChainId !== from.chainId;
  accountChip.classList.toggle("mismatch", mismatch);
  if (mismatch) setAttr(accountChip, "title", "account.mismatch", { wallet: walletName, chain: from.name });
  else {
    accountChip.removeAttribute("title");
    accountChip.removeAttribute("data-i18n-title");
  }
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
    toast("toast.noWallet", msg("toast.noWalletBody"), "error");
    setHint("hint.noWallet", "error");
    return;
  }
  connecting = true;
  connectBtn.disabled = true;
  setText(connectBtn.querySelector(".connect-label")!, "connect.connecting");
  setBridgeButtonState();
  try {
    await ethereum.request({ method: "eth_requestAccounts" });
    const accounts = (await ethereum.request({ method: "eth_accounts" })) as string[];
    const address = accounts[0];
    if (!address) throw new LocalizedError(msg("error.noAddress"));
    connectedProvider = ethereum;
    await readWalletChain(ethereum);
    showConnected(address);
    try {
      localStorage.setItem("rail:connected", "1");
    } catch {
      // ignore
    }
    listenToWallet(ethereum);
    toast("toast.connected", shortAddress(address), "success");
    setHint("hint.connected");
    refreshBalance();
    if (walletChainId !== chain(fromKey).chainId) void switchWalletToSource(false);
  } catch (err) {
    console.warn("Wallet connection failed:", err);
    const rejected = isUserRejection(err);
    setHint(rejected ? "hint.connectRejected" : "hint.connectFailed", "error");
    toast(rejected ? "toast.connectRejected" : "toast.connectFailed", rejected ? msg("toast.nothingShared") : friendlyError(err), "error");
  } finally {
    connecting = false;
    connectBtn.disabled = false;
    setText(connectBtn.querySelector(".connect-label")!, "connect.label");
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

function resetWallet(message: Key = "hint.disconnected") {
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
  toast("toast.disconnected", msg("toast.disconnectedBody"));
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
    if (!bridging) setHint("hint.accountChanged");
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

function setStep(key: StepKey, state: StepState, note?: Key, link?: { url: string; label: Msg }) {
  const li = stepEl(key);
  li.dataset.state = state;
  const labels: Record<StepState, Key | null> = { idle: null, active: "step.active", done: "step.done", skipped: "step.skipped", error: "step.error" };
  const label = note ?? labels[state];
  setText(li.querySelector(".step-status")!, label ? msg(label) : raw(""));
  const a = li.querySelector<HTMLAnchorElement>(".step-link");
  if (a) {
    if (link) {
      a.href = link.url;
      setText(a, link.label);
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

const STEP_TITLES: Record<StepKey, Key> = {
  approve: "stepName.approve",
  burn: "stepName.burn",
  attestation: "stepName.attestation",
  mint: "stepName.mint",
};

function addLedgerEntry(opts: { title: Text; chain?: ChainInfo; state: "pending" | "success" | "error"; detail: Text; url?: string }) {
  ledgerEmpty.remove();
  const li = el("li", `entry state-${opts.state}`);
  const icon = el("span", "entry-icon", opts.state === "success" ? "✓" : opts.state === "error" ? "!" : "•");
  icon.setAttribute("aria-hidden", "true");
  const main = el("div", "entry-main");
  const top = el("div", "entry-top");
  const title = el("span", "entry-title");
  setText(title, opts.title);
  top.append(title);
  if (opts.chain) {
    const tag = el("span", "entry-chain");
    tag.append(chainLogo(opts.chain, "sm"), el("span", "", opts.chain.name));
    top.append(tag);
  }
  const bottom = el("div", "entry-bottom");
  const detail = el("span", "entry-detail");
  setText(detail, opts.detail);
  const now = new Date();
  const time = el("time", "entry-time");
  time.dateTime = now.toISOString();
  setText(time, "ledger.time", { time: { time: now.toISOString() } });
  bottom.append(detail, time);
  main.append(top, bottom);
  li.append(icon, main);
  if (opts.url) {
    const link = el("a", "entry-link");
    setText(link, "ledger.view");
    link.href = opts.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    setAttr(link, "aria-label", "ledger.viewLabel", { title: "raw" in opts.title ? opts.title.raw : opts.title, chain: opts.chain?.name ?? "" });
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

  let detail: Text;
  if (normalized === "error") {
    detail = friendlyError(eventError, values?.errorMessage);
    console.warn("Bridge step failed:", method, values);
  } else {
    detail = txHash ? msg("ledger.tx", { hash: shortAddress(txHash) }) : msg(normalized === "success" ? "ledger.confirmed" : "ledger.waiting");
  }

  if (key) {
    // Earlier steps that never reported (e.g. approve when allowance was enough) were not needed.
    const idx = STEP_ORDER.indexOf(key);
    for (const prev of STEP_ORDER.slice(0, idx)) {
      const s = stepEl(prev).dataset.state;
      if (s === "idle" || s === "active") setStep(prev, prev === "approve" ? "skipped" : "done");
    }
    const link = url && txHash ? { url, label: msg("step.link", { tx: shortAddress(txHash), chain: stepChain.name }) } : undefined;
    if (normalized === "success") {
      setStep(key, "done", undefined, link);
      const next = STEP_ORDER[idx + 1];
      if (next) setStep(next, "active", next === "attestation" ? "step.waitingCircle" : "step.confirm");
    } else if (normalized === "error") {
      setStep(key, "error", undefined, link);
    } else {
      setStep(key, "active", undefined, link);
    }
    setChip(logStatus, msg("chip.step", { step: msg(STEP_TITLES[key]) }), "live");
  }

  addLedgerEntry({
    title: key ? msg(STEP_TITLES[key]) : raw(method),
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
  // Normalize e.g. "1.", ".5" or "0,5" to "1" / "0.5" before passing it to App Kit.
  const amount = formatUnits(parseUnits(amountValue()!, USDC_DECIMALS), USDC_DECIMALS);
  const shown = { amount };
  const from = chain(fromKey);
  const to = chain(toKey);
  run = { from, to };
  bridging = true;
  lockForm(true);
  bridgeBtn.disabled = true;
  bridgeBtn.classList.add("loading");
  setText(bridgeBtn, "button.bridging");
  resetSteps();
  stepsEl.classList.add("running");
  setChip(progressState, "chip.inProgress", "live");
  setChip(logStatus, "chip.switching", "live");
  setStep("approve", "active", "step.preparing");
  setHint(msg("hint.sending", { amount: shown, from: from.name, to: to.name }));

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
    setStep("approve", "active", "step.confirm");
    setChip(logStatus, "chip.waitingWallet", "live");

    let result: any = await kit.bridge({
      from: { adapter, chain: from.key as any },
      to: { adapter, chain: to.key as any },
      amount,
    });

    // Retry once, but never when the user rejected the request in the wallet.
    if (result.state === "error" && !wasRejectedByUser(result)) {
      addLedgerEntry({ title: msg("ledger.retrying"), state: "pending", detail: msg("ledger.retryingDetail") });
      result = await kit.retryBridge(result, { from: adapter, to: adapter });
    }

    if (result.state === "error") {
      if (wasRejectedByUser(result)) throw new UserRejectedError(msg("hint.txRejected"));
      const failed = failedStep(result);
      throw new LocalizedError(friendlyError(failed?.error, failed?.errorMessage));
    }

    for (const k of STEP_ORDER) if (stepEl(k).dataset.state !== "done" && stepEl(k).dataset.state !== "skipped") setStep(k, "done");
    setChip(progressState, "chip.complete", "done");
    setChip(logStatus, "chip.done", "done");
    setHint(msg("hint.done", { amount: shown, to: to.name }), "success");
    toast("toast.bridgeComplete", msg("toast.bridgeCompleteBody", { amount: shown, to: to.name }), "success");
  } catch (err: any) {
    console.warn("Bridge stopped:", err);
    const rejected = err instanceof UserRejectedError || isUserRejection(err);
    for (const k of STEP_ORDER) if (stepEl(k).dataset.state === "active") setStep(k, "error", rejected ? "step.rejected" : "step.error");
    setChip(progressState, rejected ? "chip.rejected" : "chip.failed", "error");
    setChip(logStatus, rejected ? "chip.rejected" : "chip.error", "error");
    let detail: Text = rejected && !(err instanceof UserRejectedError) ? msg("hint.requestRejected") : friendlyError(err);
    if ("raw" in detail && !detail.raw) detail = msg("hint.bridgeFailed");
    setHint(detail, "error");
    toast(rejected ? "toast.requestRejected" : "toast.bridgeFailed", detail, "error");
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
  setAttr(themeToggle, "aria-label", dark ? "theme.toLight" : "theme.toDark");
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
  const text = amountInput.value.trim();
  if (!validateAmount(text) && /^[.,]/.test(text)) amountInput.value = `0${text}`;
});
maxBtn.addEventListener("click", () => {
  if (sourceBalance === null) return;
  amountInput.value = formatUnits(sourceBalance, USDC_DECIMALS).replace(".", decimalSeparator());
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
    toast("toast.copied", shortAddress(connectedAddress), "success");
  } catch {
    toast("toast.copyFailed", connectedAddress, "error");
  }
  toggleMenu(false);
});
$("disconnect-btn").addEventListener("click", () => void disconnect());

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

function applyLangButtons(lang: Lang) {
  langSwitch.querySelectorAll<HTMLButtonElement>("button[data-lang]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  });
}

langSwitch.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-lang]");
  if (button) setLang(button.dataset.lang as Lang);
});

onLangChange((lang) => {
  applyLangButtons(lang);
  // Keep the typed amount but use the decimal separator of the new language.
  const value = amountInput.value;
  if (normalizeAmount(value) !== null) amountInput.value = value.replace(/[.,]/, decimalSeparator());
  renderRoute();
  renderBalances();
  if (!picker.hidden) renderChainList();
});

if (getLang() !== "en") amountInput.value = amountInput.value.replace(".", decimalSeparator());
applyTranslations();
applyLangButtons(getLang());
applyThemeLabel();
setChip(progressState, "chip.ready");
setChip(logStatus, "chip.idle");
setHint("hint.default");
resetSteps();
renderRoute();
document.documentElement.classList.remove("i18n-pending");
void tryRestoreSession();
