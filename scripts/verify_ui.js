// Headless UI check with a fake injected wallet (no real funds, nothing is signed).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/verify_ui.js [url] [screenshot-dir]
//
// Checks: no console errors, both chain pickers list every chain, swap works,
// invalid amounts are blocked, the wallet is asked to switch/add the right chain,
// and a rejected wallet request is not retried. Saves desktop and mobile screenshots.
import { mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const URL_ = process.argv[2] || "http://localhost:4173/";
const OUT = process.argv[3] || "screenshots";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
mkdirSync(OUT, { recursive: true });
const chains = JSON.parse(readFileSync(new URL("../src/chains.json", import.meta.url), "utf8"));
const hex = (id) => "0x" + id.toString(16);

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

async function newPage(viewport, theme) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  await page.evaluateOnNewDocument(fakeWallet);
  await page.evaluateOnNewDocument((t) => { localStorage.setItem("rail:theme", t); localStorage.removeItem("rail:route"); }, theme);
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
  const set = (k, s, note) => { const li = document.querySelector(`[data-step="${k}"]`); li.dataset.state = s; li.querySelector(".step-status").textContent = note; };
  set("approve", "done", "Done"); set("burn", "done", "Done"); set("attestation", "active", "Waiting for Circle"); set("mint", "idle", "");
  const a = document.querySelector('[data-step="burn"] .step-link'); a.hidden = false; a.textContent = "0x8f3a…91c2 on Arc Testnet ↗";
  const chip = document.getElementById("progress-state"); chip.textContent = "In progress"; chip.className = "state-chip live";
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

// ---------------------------------------------------------------- mobile
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
