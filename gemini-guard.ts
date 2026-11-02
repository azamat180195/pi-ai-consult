// gemini-guard.ts
// Robust rate-limit detection and model-downgrade prevention for Google Gemini web automation.
// Detects localized reset banners ('Лимит сбросится в 6:24 PM', 'Limit resets at') and asserts active model != Flash-Lite.

import type { Page } from "playwright-core";

export type GuardKind = "RATE_LIMITED" | "MODEL_MISMATCH" | "MODEL_UNVERIFIED";

export interface GuardFail {
  success: false;
  text: "";
  kind: GuardKind;
  rateLimitHit: boolean;
  resetTime?: string;
  resetAt?: string;
  activeModel?: string;
  error: string;
}

export interface LimitInfo {
  hit: boolean;
  resetRaw?: string;
  resetAt?: string;
  evidence?: string;
}

const G = {
  composer: 'rich-textarea, .ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"]',
  history: 'user-query, model-response, message-content',
  modelBtn: '[data-test-id*="model-picker" i], [data-test-id*="mode-menu" i], [data-testid*="model" i], button:has-text("Argon"), button:has-text("Flash")',
};

const TIME = /(\d{1,2})[:.](\d{2})\s*([AP]M|МСК)?/i;

const LIMIT_RES: RegExp[] = [
  /лимит\s+сбросится\s+(?:в\s+)?(\d{1,2}[:.]\d{2}(?:\s*(?:[AP]M|МСК))?)/i,
  /limit\s+(?:will\s+)?resets?\s+(?:at\s+)?(\d{1,2}[:.]\d{2}(?:\s*[AP]M)?)/i,
  /(исчерпан\w*\s+лимит|лимит\w*\s+(?:исчерпан|достигнут)|limit\s+(?:reached|exceeded)|usage\s+limit)/i,
];

export function parseResetTime(raw: string, now = new Date()): string | undefined {
  const m = TIME.exec(raw);
  if (!m) return undefined;
  let h = +m[1];
  const min = +m[2];
  const suf = (m[3] || "").toUpperCase();
  if (min > 59) return undefined;
  if (suf === "PM" && h < 12) h += 12;
  if (suf === "AM" && h === 12) h = 0;
  if (h > 23) return undefined;

  let d =
    suf === "МСК"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 3, min))
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min);

  if (d.getTime() <= now.getTime()) d = new Date(d.getTime() + 86400000);
  return d.toISOString();
}

async function bannerCandidates(page: Page): Promise<string[]> {
  return page.evaluate((G) => {
    const vis = (e: Element) => (e as HTMLElement).getClientRects().length > 0;
    const ta = Array.from(document.querySelectorAll<HTMLElement>(G.composer)).find(vis);
    const cr = ta?.getBoundingClientRect();
    const seen = new Set<string>();
    const out: string[] = [];
    const els = document.querySelectorAll<HTMLElement>("div,section,aside,p,span,[role='alert'],[role='status']");
    for (const e of Array.from(els)) {
      if (!vis(e) || e.closest(G.history) || e.closest("[contenteditable]")) continue;
      const t = (e.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 6 || t.length > 300 || seen.has(t)) continue;
      if (!/limit|лимит|limiti|usage|расход/i.test(t)) continue;
      if (cr) {
        const r = e.getBoundingClientRect();
        if (r.bottom > cr.top + 40 || r.top < cr.top - 400) continue;
      }
      seen.add(t);
      out.push(t);
      if (out.length >= 6) break;
    }
    return out;
  }, G);
}

export async function detectGeminiLimit(page: Page): Promise<LimitInfo> {
  const cands = await bannerCandidates(page).catch(() => [] as string[]);
  for (const t of cands) {
    for (const re of LIMIT_RES) {
      const m = re.exec(t);
      if (m) {
        const raw = TIME.exec(m[1] ?? "")?.[0] ?? TIME.exec(t)?.[0];
        return { hit: true, resetRaw: raw, resetAt: raw ? parseResetTime(raw) : undefined, evidence: t.slice(0, 160) };
      }
    }
    if (/limit|лимит/i.test(t) && TIME.test(t)) {
      const raw = TIME.exec(t)![0];
      return { hit: true, resetRaw: raw, resetAt: parseResetTime(raw), evidence: t.slice(0, 160) };
    }
  }
  return { hit: false };
}

export async function readActiveModel(page: Page): Promise<{ label: string; candidates: string[] }> {
  return page.evaluate((G) => {
    const vis = (e: Element) => (e as HTMLElement).getClientRects().length > 0;
    const txt = (e: HTMLElement) => (e.innerText || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const explicit = Array.from(document.querySelectorAll<HTMLElement>(G.modelBtn)).filter(vis).map(txt).filter(Boolean);
    if (explicit.length) return { label: explicit[0], candidates: explicit };
    const ta = Array.from(document.querySelectorAll<HTMLElement>(G.composer)).find(vis);
    if (!ta) return { label: "", candidates: [] as string[] };
    const cr = ta.getBoundingClientRect();
    const BAD = /mic|микрофон|upload|загруз|добав|attach|tools|инструмент|send|отправ|voice|голос|more|ещё|еще/i;
    const c = Array.from(document.querySelectorAll<HTMLElement>("button,[role='button']"))
      .filter(vis)
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.bottom > cr.top - 40 && r.top < cr.bottom + 90 && r.right > cr.left - 40 && r.left < cr.right + 40;
      })
      .filter((b) => b.getAttribute("aria-haspopup") || b.getAttribute("aria-expanded") !== null)
      .map((b) => ({ t: txt(b), x: b.getBoundingClientRect().left }))
      .filter((o) => o.t.length >= 2 && o.t.length <= 40 && !BAD.test(o.t))
      .sort((a, b) => b.x - a.x);
    return { label: c[0]?.t ?? "", candidates: c.map((o) => o.t) };
  }, G);
}

const tokens = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const DOWNGRADE = /flash|lite/i;

const labelMatches = (label: string, req: string, accept: string[] = []) => {
  const L = new Set(tokens(label));
  return [req, ...accept].some((r) => tokens(r).length > 0 && tokens(r).every((t) => L.has(t)));
};

export interface GuardOpts {
  requestedModel?: string;
  strict?: boolean;
  acceptLabels?: string[];
}

export async function geminiGuard(page: Page, o: GuardOpts): Promise<GuardFail | null> {
  const strict = o.strict ?? true;
  const lim = await detectGeminiLimit(page);
  const active = o.requestedModel ? await readActiveModel(page) : { label: "", candidates: [] as string[] };

  if (lim.hit) {
    return {
      success: false,
      text: "",
      kind: "RATE_LIMITED",
      rateLimitHit: true,
      resetTime: lim.resetRaw,
      resetAt: lim.resetAt,
      activeModel: active.label || undefined,
      error:
        `🛑 [Gemini limiti tugagan]: ${o.requestedModel ?? "Gemini"} limiti to'ldi` +
        (active.label ? `, faol model "${active.label}" ga tushirilgan` : "") +
        `. Qayta tiklanish: ${lim.resetRaw ?? "noma'lum"}. So'rov YUBORILMADI.`,
    };
  }

  if (!o.requestedModel) return null;

  // Accept common aliases like "Argon" for "4 Argon"
  const accept = o.acceptLabels ?? ["Argon", "Gemini 4 Argon", "Gemini Advanced"];
  if (active.label && labelMatches(active.label, o.requestedModel, accept)) {
    return null;
  }

  const isReqFlagship = !DOWNGRADE.test(o.requestedModel);
  const isActiveDowngraded = active.label ? DOWNGRADE.test(active.label) : false;

  if (isReqFlagship && isActiveDowngraded) {
    return {
      success: false,
      text: "",
      kind: "MODEL_MISMATCH",
      rateLimitHit: true, // Auto-downgrade to Flash-Lite is caused by rate limit exhaustion on 4 Argon
      resetTime: lim.resetRaw,
      resetAt: lim.resetAt,
      activeModel: active.label,
      error: `🛑 [Gemini 4 Argon Limiti tugagan]: So'ralgan model "${o.requestedModel}", lekin Google uni avtomatik ravishda "${active.label}" ga tushirib qo'ygan! Qayta tiklanish: ${lim.resetRaw || "noma'lum"}. Zaif modelga so'rov yuborish TO'XTATILDI.`,
    };
  }

  if (strict && !active.label) {
    return {
      success: false,
      text: "",
      kind: "MODEL_UNVERIFIED",
      rateLimitHit: false,
      error: `🛑 [Gemini modeli tekshirilmadi]: Faol model nomini aniqlab bo'lmadi (nomzodlar: ${JSON.stringify(active.candidates)}). Xavfsizlik yuzasidan so'rov YUBORILMADI.`,
    };
  }

  return null;
}
