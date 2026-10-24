// Headless UI check with a fake injected wallet (no real funds, nothing is signed).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/verify_ui.js [url] [screenshot-dir]
//
// Checks: no console errors, both chain pickers list every chain, swap works,
// invalid amounts are blocked, the wallet is asked to switch/add the right chain,
// a rejected wallet request is not retried, English and Turkish both render fully
// translated, and every chain logo loads. Saves desktop and mobile screenshots.
import { mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const URL_ = process.argv[2] || "http://localhost:4173/";
const OUT = process.argv[3] || "screenshots";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
mkdirSync(OUT, { recursive: true });
const chains = JSON.parse(readFileSync(new URL("../src/chains.json", import.meta.url), "utf8"));
const hex = (id) => "0x" + id.toString(16);
const dict = {
  en: JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")),
  tr: JSON.parse(readFileSync(new URL("../src/locales/tr.json", import.meta.url), "utf8")),
};
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake EIP-1193 wallet: starts on Ethereum Sepolia, only knows a few chains,
// answers 4902 for unknown chains and rejects every transaction (code 4001).
function fakeWallet() {
  const listeners = {};
  const known = new Set(["0xaa36a7", "0x14a34"]);
  let chainId = "0xaa36a7";
  window.__calls = [];
  window.__added = [];
  const emit = (ev, v) => (listeners[ev] || []).forEach((f) => f(v));
  window.ethereum = {
    isMetaMask: true,
    on: (ev, f) => ((listeners[ev] ||= []).push(f)),
    removeListener: () => {},
    async request({ method, params }) {
      window.__calls.push({ method, params: JSON.parse(JSON.stringify(params ?? null)) });
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return ["0x1111111111111111111111111111111111111111"];
        case "eth_chainId":
          return chainId;
        case "net_version":
          return String(parseInt(chainId, 16));
        case "wallet_switchEthereumChain": {
          const id = params[0].chainId.toLowerCase();
          if (!known.has(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          chainId = id;
          emit("chainChanged", id);
          return null;
        }
        case "wallet_addEthereumChain":
          window.__added.push(params[0]);
          known.add(params[0].chainId.toLowerCase());
          chainId = params[0].chainId.toLowerCase();
          emit("chainChanged", chainId);
          return null;
        case "eth_sendTransaction":
        case "eth_signTypedData_v4":
        case "personal_sign":
        case "wallet_sendCalls":
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        case "wallet_getCapabilities":
          throw Object.assign(new Error("Method not supported"), { code: -32601 });
        default:
          throw Object.assign(new Error(`fake wallet: ${method} not supported`), { code: -32601 });
      }
    },
  };
}

// Pretend the test address holds 100 USDC and 1 coin of gas on every chain (RPC mock).
async function mockBalances(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.postData()) return req.continue();
    let body;
    try { body = JSON.parse(req.postData()); } catch { return req.continue(); }
    const list = Array.isArray(body) ? body : [body];
    const answer = (m) => {
      if (m.method === "eth_getBalance") return "0xde0b6b3a7640000";
      if (m.method === "eth_call" && m.params?.[0]?.data?.startsWith("0x70a08231")) return "0x" + (100_000_000n).toString(16).padStart(64, "0");
      return undefined;
    };
    if (!list.every((m) => answer(m) !== undefined)) return req.continue();
    const res = list.map((m) => ({ jsonrpc: "2.0", id: m.id, result: answer(m) }));
    req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(Array.isArray(body) ? res : res[0]) });
  });
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const consoleErrors = [];

async function newPage(viewport, theme, lang = "en", browserLang = null) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  await page.evaluateOnNewDocument(fakeWallet);
  await page.evaluateOnNewDocument((t, l) => {
    localStorage.setItem("rail:theme", t);
    localStorage.removeItem("rail:route");
    if (l) localStorage.setItem("rail:lang", l); else localStorage.removeItem("rail:lang");
  }, theme, lang);
  if (browserLang) {
    await page.evaluateOnNewDocument((bl) => {
      Object.defineProperty(navigator, "language", { get: () => bl });
      Object.defineProperty(navigator, "languages", { get: () => [bl] });
    }, browserLang);
  }
  await mockBalances(page);
  await page.goto(URL_, { waitUntil: "networkidle0" });
  return page;
}

async function fullShot(page, path) {
  await page.evaluate(() => { document.querySelectorAll(".toast").forEach((t) => t.remove()); window.scrollTo(0, 0); });
  await sleep(200);
  await page.screenshot({ path, fullPage: true });
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim().replace(/\s+/g, " "));
const calls = (page, method) => page.evaluate((m) => window.__calls.filter((c) => c.method === m), method);

async function pickChain(page, side, name) {
  await page.click(`#${side}-select`);
  await sleep(300);
  await page.evaluate((n) => {
    [...document.querySelectorAll(".chain-option")].find((b) => b.querySelector(".chain-name").textContent === n).click();
  }, name);
  await sleep(400);
}

// ---------------------------------------------------------------- desktop
const page = await newPage({ width: 1280, height: 900, deviceScaleFactor: 1 }, "dark");
check((await page.title()).includes("Rail"), "page renders with title");
check((await text(page, "#bridge-btn")) === "Connect wallet to bridge", "main button asks to connect before a wallet is connected");
check(await page.$eval("#connect-btn", (e) => e.closest(".topbar") !== null), "connect button lives in the header");
await page.screenshot({ path: `${OUT}/desktop-dark-disconnected.png` });

// Chain pickers list every chain.
for (const side of ["from", "to"]) {
  await page.click(`#${side}-select`);
  await sleep(300);
  const names = await page.$$eval(".chain-option .chain-name", (n) => n.map((x) => x.textContent));
  check(names.length === chains.length && chains.every((c) => names.includes(c.name)), `${side} picker lists all ${chains.length} chains (${names.length})`);
  if (side === "from") await page.screenshot({ path: `${OUT}/desktop-dark-chain-picker.png` });
  await page.keyboard.press("Escape");
  await sleep(300);
}
// Search filter.
await page.click("#from-select");
await sleep(200);
await page.type("#chain-search", "sepolia");
const filtered = await page.$$eval(".chain-option .chain-name", (n) => n.map((x) => x.textContent));
check(filtered.length > 0 && filtered.every((n) => /sepolia/i.test(n)), `picker search filters (${filtered.length} Sepolia chains)`);
await page.keyboard.press("Escape");
await sleep(300);

// Swap.
const before = [await page.$eval("#from-select", (e) => e.dataset.chain), await page.$eval("#to-select", (e) => e.dataset.chain)];
await page.click("#swap-btn");
await sleep(300);
const after = [await page.$eval("#from-select", (e) => e.dataset.chain), await page.$eval("#to-select", (e) => e.dataset.chain)];
check(after[0] === before[1] && after[1] === before[0], `swap works (${before.join("→")} becomes ${after.join("→")})`);
await page.click("#swap-btn");
await sleep(300);

// Picking the destination chain as source swaps instead of allowing the same chain.
await pickChain(page, "from", "Arc Testnet");
const same = [await page.$eval("#from-select", (e) => e.dataset.chain), await page.$eval("#to-select", (e) => e.dataset.chain)];
check(same[0] === "Arc_Testnet" && same[1] === "Base_Sepolia", "choosing the destination as source swaps them (never the same chain)");
await page.click("#swap-btn");
await sleep(300);

// Connect.
await page.click("#connect-btn");
await sleep(2500);
check(!(await page.$eval("#account", (e) => e.hidden)), "address chip appears in the header after connecting");
check((await text(page, "#account-address")) === "0x1111…1111", "address chip shows the short address");
const sw1 = await calls(page, "wallet_switchEthereumChain");
check(sw1.some((c) => c.params[0].chainId === hex(84532)), "after connect the wallet is asked to switch to Base Sepolia (0x14a34)");
check((await text(page, "#bridge-btn")) === "Bridge 1.00 USDC to Arc Testnet", `main button: "${await text(page, "#bridge-btn")}"`);
check((await text(page, "#from-balance")).includes("100.00 USDC"), `source balance shown: "${await text(page, "#from-balance")}"`);
await page.screenshot({ path: `${OUT}/desktop-dark-connected.png` });

// Invalid amounts.
for (const [value, expected] of [["abc", "Enter a valid number"], ["1.1234567", "Use at most 6 decimals"], ["0", "Enter an amount above 0"], ["", "Enter an amount"], ["250", "Not enough USDC on Base Sepolia"]]) {
  await page.$eval("#amount", (e) => (e.value = ""));
  if (value) await page.type("#amount", value);
  else await page.$eval("#amount", (e) => e.dispatchEvent(new Event("input")));
  const disabled = await page.$eval("#bridge-btn", (e) => e.disabled);
  const label = await text(page, "#bridge-btn");
  check(disabled && label === expected, `amount "${value}" is blocked: "${label}"`);
  if (value === "1.1234567") await page.screenshot({ path: `${OUT}/desktop-dark-invalid-amount.png` });
}
await page.$eval("#amount", (e) => (e.value = ""));
await page.type("#amount", "2.5");
check(!(await page.$eval("#bridge-btn", (e) => e.disabled)), "valid amount 2.5 enables the bridge button");

// Switch to a chain the wallet does not know: switch -> 4902 -> add.
await page.evaluate(() => (window.__calls = []));
await pickChain(page, "from", "Polygon Amoy");
await sleep(1500);
const sw2 = await calls(page, "wallet_switchEthereumChain");
const add2 = await calls(page, "wallet_addEthereumChain");
check(sw2.some((c) => c.params[0].chainId === hex(80002)), "selecting Polygon Amoy sends wallet_switchEthereumChain 0x13882");
const addP = add2[0]?.params?.[0];
check(addP?.chainId === hex(80002) && addP.nativeCurrency.symbol === "POL" && addP.blockExplorerUrls[0] === "https://amoy.polygonscan.com", "on 4902 wallet_addEthereumChain gets Polygon Amoy params");

// Bridge Arc -> Avalanche: wallet adds/switches dest then source; transaction is rejected, no retry.
await pickChain(page, "from", "Arc Testnet");
await pickChain(page, "to", "Avalanche Fuji");
await sleep(1500);
await page.evaluate(() => (window.__calls = []));
await page.click("#bridge-btn");
await page.waitForFunction(() => !document.body.classList.contains("is-bridging"), { timeout: 90_000 });
await sleep(500);
const order = (await page.evaluate(() => window.__calls.filter((c) => c.method.startsWith("wallet_") && c.method.includes("Chain")).map((c) => `${c.method}:${c.params[0].chainId}`)));
console.log("  wallet chain calls:", order.join(", "));
check(order[0] === `wallet_switchEthereumChain:${hex(43113)}` && order.includes(`wallet_addEthereumChain:${hex(43113)}`), "bridge first switches/adds the destination (Avalanche Fuji 0xa869)");
const arcAdd = (await page.evaluate(() => window.__added)).find((p) => p.chainId === hex(5042002));
check(order.some((o) => o.endsWith(hex(5042002))), "then switches to the source Arc Testnet (0x4cef52)");
check(arcAdd?.rpcUrls[0] === "https://rpc.testnet.arc.io" && arcAdd?.blockExplorerUrls[0] === "https://explorer.testnet.arc.io" && arcAdd?.nativeCurrency.symbol === "USDC", "Arc Testnet is added with rpc.testnet.arc.io and explorer.testnet.arc.io");
const hint = await text(page, "#status-hint");
const ledgerText = await text(page, "#ledger");
check(/reject/i.test(hint), `rejected transaction is reported: "${hint}"`);
check(!/Retrying/.test(ledgerText), "a wallet rejection is not retried");
check((await text(page, "#progress-state")) === "Rejected", "progress card shows Rejected");
await page.screenshot({ path: `${OUT}/desktop-dark-after-rejection.png` });

// Styled preview of a transfer in flight (DOM only, for the screenshot).
await page.evaluate(() => {
  // Uses the same data-i18n keys as the app so a later language switch re-renders it.
  const tag = (el, text, key, vars) => { el.textContent = text; el.setAttribute("data-i18n", vars ? JSON.stringify({ key, vars }) : key); };
  const set = (k, s, text, key) => { const li = document.querySelector(`[data-step="${k}"]`); li.dataset.state = s; tag(li.querySelector(".step-status"), text, key); };
  set("approve", "done", "Done", "step.done"); set("burn", "done", "Done", "step.done");
  set("attestation", "active", "Waiting for Circle", "step.waitingCircle"); { const li = document.querySelector('[data-step="mint"]'); li.dataset.state = "idle"; const st = li.querySelector(".step-status"); st.removeAttribute("data-i18n"); st.textContent = ""; }
  const a = document.querySelector('[data-step="burn"] .step-link'); a.hidden = false;
  tag(a, "0x8f3a…91c2 on Arc Testnet ↗", "step.link", { tx: "0x8f3a…91c2", chain: "Arc Testnet" });
  const chip = document.getElementById("progress-state"); tag(chip, "In progress", "chip.inProgress"); chip.className = "state-chip live";
});
await page.screenshot({ path: `${OUT}/desktop-dark-progress-preview.png` });
await fullShot(page, `${OUT}/desktop-dark-full.png`);

// Light theme.
await page.click("#theme-toggle");
await sleep(600);
check((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "theme toggle switches to light");
await page.screenshot({ path: `${OUT}/desktop-light.png` });
await fullShot(page, `${OUT}/desktop-light-full.png`);

// Account menu + disconnect.
await page.click("#account-chip");
await sleep(300);
await page.screenshot({ path: `${OUT}/desktop-light-account-menu.png` });
await page.click("#disconnect-btn");
await sleep(500);
check(!(await page.$eval("#connect-btn", (e) => e.hidden)) && (await text(page, "#bridge-btn")) === "Connect wallet to bridge", "disconnect returns to the connect state");

// ---------------------------------------------------------------- language + logos
// Dictionaries: same keys, and every key used by the app exists.
const enKeys = Object.keys(dict.en).sort();
const trKeys = Object.keys(dict.tr).sort();
check(JSON.stringify(enKeys) === JSON.stringify(trKeys), `EN and TR dictionaries have the same ${enKeys.length} keys`);
const groups = [...new Set(enKeys.map((k) => k.split(".")[0]))].join("|");
const used = new Set();
for (const f of ["../src/main.ts", "../index.html"]) {
  const src = readFileSync(new URL(f, import.meta.url), "utf8");
  for (const mm of src.matchAll(new RegExp(`["'\`]((?:${groups})\\.[A-Za-z][\\w.]*)["'\`]`, "g"))) used.add(mm[1]);
}
const missing = [...used].filter((k) => !(k in dict.en) && !/\.(ts|json|svg|webp|css|html)$/.test(k));
check(used.size > 100 && missing.length === 0, `all ${used.size} keys used in main.ts/index.html exist${missing.length ? ": missing " + missing.join(", ") : ""}`);

// Everything a user can see or hear: text nodes (also in hidden dialogs/toasts),
// accessible attributes, the title and the meta description.
const collectStrings = (p) => p.evaluate(() => {
  const out = [document.title, document.querySelector('meta[name="description"]').content];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement.closest("script, style, svg") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  while (walker.nextNode()) if (walker.currentNode.textContent.trim()) out.push(walker.currentNode.textContent.trim());
  for (const el of document.querySelectorAll("[aria-label], [title], [placeholder], img[alt]")) {
    for (const a of ["aria-label", "title", "placeholder", "alt"]) if (el.getAttribute(a)) out.push(el.getAttribute(a));
  }
  return out;
});
const allKeys = new Set(enKeys);
const rawLeft = (strings) => strings.filter((x) => allKeys.has(x.trim()) || /\{\w+\}|\[object|undefined|NaN/.test(x));

// Words that only appear in English copy. Proper names and product terms are allowed in Turkish.
const words = (s) => (s.toLowerCase().match(/[a-zçğıöşü]{3,}/g) || []);
const trWords = new Set(Object.values(dict.tr).flatMap(words));
const ALLOW = new Set([
  ...chains.flatMap((c) => words(c.name)), "rail", "usdc", "circle", "cctp", "faucet", "metamask", "rabby", "mit",
  "testnet", "testnets", "llc", "technology", "services", "github", "arc", "eth", "pol", "avax", "sepolia", "fuji", "amoy",
]);
const enOnly = new Set(Object.values(dict.en).flatMap(words).filter((w) => !trWords.has(w) && !ALLOW.has(w)));
const englishLeft = (strings) => [...new Set(strings.flatMap((x) => words(x).filter((w) => enOnly.has(w))))];

// Toggle on the desktop page (light theme, disconnected).
check((await page.evaluate(() => document.documentElement.lang)) === "en", "html lang is en in English");
check(rawLeft(await collectStrings(page)).length === 0, "English: no raw keys or {placeholders} on the page");
await page.click('#lang-switch [data-lang="tr"]');
await sleep(400);
check((await page.evaluate(() => document.documentElement.lang)) === "tr", "language toggle sets html lang to tr");
check((await page.title()) === fill(dict.tr["meta.title"], { others: chains.length - 1 }), `title is Turkish: "${await page.title()}"`);
check((await text(page, "#bridge-btn")) === dict.tr["button.connect"], `TR main button: "${await text(page, "#bridge-btn")}"`);
check(await page.$eval('#lang-switch [data-lang="tr"]', (e) => e.getAttribute("aria-pressed") === "true"), "TR button is marked pressed");
await page.click("#from-select");
await sleep(400);
const trStrings = await collectStrings(page);
const trRaw = rawLeft(trStrings);
check(trRaw.length === 0, `Turkish: no raw keys or {placeholders}${trRaw.length ? ": " + trRaw.slice(0, 5).join(" | ") : ""}`);
const trEnglish = englishLeft(trStrings);
check(trEnglish.length === 0, `Turkish: no leftover English words${trEnglish.length ? ": " + trEnglish.join(", ") : ""}`);
check((await text(page, "#picker-title")) === dict.tr["picker.fromTitle"], "picker title is Turkish");

// Logos: every chain image in the picker, the route and the summary has loaded.
const logos = await page.evaluate(async () => {
  const imgs = [...document.querySelectorAll(".chain-option img, #from-select img, #to-select img, .summary img")];
  await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  return {
    total: imgs.length,
    picker: document.querySelectorAll(".chain-option .chain-logo img").length,
    broken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.alt),
    noAlt: imgs.filter((i) => !i.alt).length,
    fallback: document.querySelectorAll(".chain-option .chain-badge").length,
  };
});
check(logos.picker === chains.length && logos.fallback === 0, `picker shows a real logo for all ${chains.length} chains (${logos.picker}, ${logos.fallback} monograms)`);
check(logos.broken.length === 0, `all ${logos.total} chain images on screen loaded${logos.broken.length ? ": broken " + logos.broken.join(", ") : ""}`);
check(logos.noAlt === 0, "every chain image has alt text");
const files = await page.evaluate(async (list) => Promise.all(list.map(async (c) => {
  const img = new Image();
  img.src = c.logo;
  try { await img.decode(); return img.naturalWidth > 0 ? null : c.name; } catch { return c.name; }
})), chains.map((c) => ({ name: c.name, logo: c.logo })));
const badFiles = files.filter(Boolean);
check(chains.every((c) => c.logo) && badFiles.length === 0, `every chains.json logo file decodes (${chains.length})${badFiles.length ? ": " + badFiles.join(", ") : ""}`);
await page.keyboard.press("Escape");
await sleep(300);

// Turkish wording follows the app state, and amounts use a decimal comma.
await page.click("#connect-btn");
await sleep(2500);
const trBtn = await text(page, "#bridge-btn");
// The amount typed in English (2.5) now shows with a decimal comma.
check(/^2,5 USDC'yi .+ ağına köprüle$/.test(trBtn), `TR bridge button: "${trBtn}"`);
await page.$eval("#amount", (e) => (e.value = ""));
await page.type("#amount", "2,5");
check(!(await page.$eval("#bridge-btn", (e) => e.disabled)) && (await text(page, "#bridge-btn")).startsWith("2,5 USDC'yi"), "TR amount \"2,5\" (decimal comma) is accepted");
await page.$eval("#amount", (e) => (e.value = ""));
await page.type("#amount", "abc");
check((await text(page, "#bridge-btn")) === dict.tr["amount.errNumber"], "TR validation message is Turkish");
await page.$eval("#amount", (e) => (e.value = ""));
await page.type("#amount", "1,5");
const trConnected = await collectStrings(page);
const trConnEnglish = englishLeft(trConnected);
check(rawLeft(trConnected).length === 0 && trConnEnglish.length === 0, `Turkish (connected): fully translated${trConnEnglish.length ? ": " + trConnEnglish.join(", ") : ""}`);
const fitsDesktop = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth &&
  [...document.querySelectorAll(".btn, .chain-select, .lang-switch, .summary dd, .field-head, .card-head")].every((e) => e.scrollWidth <= e.clientWidth + 1));
check(fitsDesktop, "Turkish at 1280px: nothing overflows");
await page.screenshot({ path: `${OUT}/desktop-light-tr.png` });

// Switching back restores English live, including the amount's decimal point.
await page.click('#lang-switch [data-lang="en"]');
await sleep(400);
const back = await text(page, "#bridge-btn");
check((await page.evaluate(() => document.documentElement.lang)) === "en" && back.startsWith("Bridge 1.5 USDC"), `switching back to EN: "${back}"`);
check(rawLeft(await collectStrings(page)).length === 0, "English after switching back: no raw keys");
await page.click("#account-chip");
await sleep(200);
await page.click("#disconnect-btn");
await sleep(300);

// A Turkish browser starts in Turkish; the saved choice wins over the browser language.
const auto = await newPage({ width: 1280, height: 900 }, "dark", null, "tr-TR");
check((await auto.evaluate(() => document.documentElement.lang)) === "tr" && (await text(auto, "#bridge-btn")) === dict.tr["button.connect"], "tr-TR browser defaults to Turkish");
check(!(await auto.evaluate(() => document.documentElement.classList.contains("i18n-pending"))), "page is revealed after translating");
await auto.close();
const saved = await newPage({ width: 1280, height: 900 }, "dark", "en", "tr-TR");
check((await saved.evaluate(() => document.documentElement.lang)) === "en", "saved EN choice wins over a Turkish browser");
await saved.close();

// ---------------------------------------------------------------- mobile
const mt = await newPage({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, "dark", "tr");
const fitsMobile = await mt.evaluate(() => {
  const w = window.innerWidth;
  const bad = [...document.querySelectorAll(".topbar-inner > *, .topbar-actions > *, .card, .amount-box, .chain-select, .btn, .lang-switch, .summary dd")]
    .filter((e) => e.getBoundingClientRect().right > w + 0.5 || (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "hidden"));
  return { ok: document.documentElement.scrollWidth <= w && bad.length === 0, bad: bad.map((e) => e.id || e.className) };
});
check(fitsMobile.ok, `Turkish at 390px: nothing overflows${fitsMobile.bad.length ? ": " + fitsMobile.bad.join(", ") : ""}`);
const oneLine = async (p) => p.evaluate(() => [...document.querySelectorAll(".topbar-actions > *")].filter((e) => !e.hidden && e.offsetHeight > 44).map((e) => e.id || e.className));
const tall = await oneLine(mt);
check(tall.length === 0, `Turkish at 390px: header controls stay on one line${tall.length ? ": " + tall.join(", ") : ""}`);
await mt.screenshot({ path: `${OUT}/mobile-tr.png` });
if (await mt.$eval("#connect-btn", (e) => !e.hidden)) await mt.click("#connect-btn");
await sleep(2500);
const tall2 = await oneLine(mt);
check(tall2.length === 0, `Turkish at 390px (connected): header controls stay on one line${tall2.length ? ": " + tall2.join(", ") : ""}`);
await mt.click("#account-chip");
await sleep(200);
await mt.click("#disconnect-btn");
await sleep(300);
await mt.close();

const m = await newPage({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, "dark");
const overflow = await m.evaluate(() =>
  document.documentElement.scrollWidth > window.innerWidth + 1 ||
  [...document.querySelectorAll(".card, .amount-box, .chain-select")].some((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5));
check(!overflow, "mobile layout has no horizontal scroll");
await m.screenshot({ path: `${OUT}/mobile-dark.png` });
await m.click("#connect-btn");
await sleep(2500);
await m.screenshot({ path: `${OUT}/mobile-dark-connected.png` });
await fullShot(m, `${OUT}/mobile-dark-full.png`);
await m.click("#to-select");
await sleep(400);
await m.screenshot({ path: `${OUT}/mobile-dark-chain-picker.png` });
await m.keyboard.press("Escape");
await sleep(300);
await m.click("#theme-toggle");
await sleep(600);
await m.screenshot({ path: `${OUT}/mobile-light.png` });
await fullShot(m, `${OUT}/mobile-light-full.png`);

// Network errors from public RPCs are not app errors; list them separately.
const appErrors = consoleErrors.filter((e) => !/Failed to load resource|net::ERR_/.test(e));
check(appErrors.length === 0, `no console errors (${appErrors.length})`);
for (const e of appErrors) console.log("   console:", e.slice(0, 300));
const expected = consoleErrors.length - appErrors.length;
if (expected) console.log(`  (${expected} expected console errors from the rejected test transaction / network)`);

await browser.close();
console.log(`\n${failures ? `${failures} check(s) failed` : "All UI checks passed"}. Screenshots in ${OUT}/`);
process.exit(failures ? 1 : 0);
