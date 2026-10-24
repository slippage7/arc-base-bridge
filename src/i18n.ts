// Tiny homegrown i18n: two JSON dictionaries, a t() helper and DOM bindings
// that re-render themselves when the language changes.
import en from "./locales/en.json";
import tr from "./locales/tr.json";

export type Lang = "en" | "tr";
export type Key = keyof typeof en;

// A message is a dictionary key plus variables. Variables can be plain text,
// another message, a USDC amount (formatted per language) or a timestamp.
export type Var = string | number | Msg | { amount: string } | { time: string };
export type Vars = Record<string, Var>;
export type Msg = { key: Key; vars?: Vars };
export type Text = Msg | { raw: string };

export const LANGS: Lang[] = ["en", "tr"];
const DICTS: Record<Lang, Record<string, string>> = { en, tr };
const STORAGE_KEY = "rail:lang";

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "tr") return saved;
  } catch {
    // storage blocked: fall back to the browser language
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return (langs[0] || "").toLowerCase().startsWith("tr") ? "tr" : "en";
}

let lang: Lang = detectLang();
const listeners: Array<(l: Lang) => void> = [];

export const getLang = () => lang;
export const locale = () => (lang === "tr" ? "tr-TR" : "en-US");
export const decimalSeparator = () => (lang === "tr" ? "," : ".");
export const msg = (key: Key, vars?: Vars): Msg => ({ key, vars });
export const raw = (text: string): Text => ({ raw: text });

// "1234.5" -> "1,234.5" (en) or "1.234,5" (tr). Keeps the decimals as given.
export function formatAmount(value: string): string {
  const [whole, frac] = value.split(".");
  const grouped = Number(whole || "0").toLocaleString(locale());
  return frac !== undefined && frac !== "" ? `${grouped}${decimalSeparator()}${frac}` : grouped;
}

function resolveVar(v: Var): string {
  if (typeof v === "string" || typeof v === "number") return String(v);
  if ("key" in v) return t(v.key, v.vars);
  if ("amount" in v) return formatAmount(v.amount);
  return new Date(v.time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function t(key: Key, vars?: Vars): string {
  const template = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (m, name) => (vars && name in vars ? resolveVar(vars[name]) : m));
}

export function render(text: Text): string {
  return "raw" in text ? text.raw : t(text.key, text.vars);
}

// --- DOM bindings ---------------------------------------------------------
// Static markup uses data-i18n="key" (text) and data-i18n-<attr>="key".
// Dynamic nodes store the full message as JSON in the same attributes.
const ATTRS = ["aria-label", "title", "placeholder", "alt", "content"] as const;
type Attr = (typeof ATTRS)[number];

function decode(value: string): Text {
  return value.startsWith("{") ? (JSON.parse(value) as Text) : { key: value as Key };
}

export function setText(node: Element, text: Text | Key, vars?: Vars) {
  const m: Text = typeof text === "string" ? { key: text, vars } : text;
  if ("raw" in m) node.removeAttribute("data-i18n");
  else node.setAttribute("data-i18n", JSON.stringify(m));
  node.textContent = render(m);
}

export function setAttr(node: Element, attr: Attr, text: Text | Key, vars?: Vars) {
  const m: Text = typeof text === "string" ? { key: text, vars } : text;
  if ("raw" in m) node.removeAttribute(`data-i18n-${attr}`);
  else node.setAttribute(`data-i18n-${attr}`, JSON.stringify(m));
  node.setAttribute(attr, render(m));
}

export function applyTranslations(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((n) => {
    n.textContent = render(decode(n.dataset.i18n!));
  });
  for (const attr of ATTRS) {
    root.querySelectorAll(`[data-i18n-${attr}]`).forEach((n) => {
      n.setAttribute(attr, render(decode(n.getAttribute(`data-i18n-${attr}`)!)));
    });
  }
  document.documentElement.lang = lang;
  document.title = document.querySelector("title")?.textContent ?? document.title;
}

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // not remembered when storage is blocked
  }
  applyTranslations();
  for (const fn of listeners) fn(next);
}

export function onLangChange(fn: (l: Lang) => void) {
  listeners.push(fn);
}
