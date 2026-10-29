import { promises as fs } from "node:fs";
import type { Page, Locator } from "playwright-core";
import type { ImageFile, ProviderId } from "./image-attachments.js";

const ROOT_ATTR = "data-aic-root";
const INPUT_ATTR = "data-aic-fileinput";

export class AttachmentError extends Error {
  constructor(public phase: string, msg: string) {
    super(`[image-attach:${phase}] ${msg}`);
    this.name = "AttachmentError";
  }
}

interface UploadProfile {
  attachBtnRe: RegExp;
  menuItemRe: RegExp;
  removeBtnRe: RegExp;
  sendSel: string;
}

const COMMON_SEND =
  '[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="Отправ" i], button[aria-label*="Yubor" i], button.send-button';

const PROFILES: Record<ProviderId, UploadProfile> = {
  chatgpt: {
    attachBtnRe: /add (photos|files)|attach|upload|прикреп|добав|загруз|biriktir|yuklash/i,
    menuItemRe: /(add|upload).{0,20}(photo|file)|photos? (&|and) files|загруз|добавить.{0,20}(фото|файл)|fayl|rasm/i,
    removeBtnRe: /remove|delete|удал|убрать|o['’]chir|olib/i,
    sendSel: COMMON_SEND,
  },
  claude: {
    attachBtnRe: /attach|upload|add (files|content)|прикреп|загруз|добав|biriktir|yuklash/i,
    menuItemRe: /upload.{0,20}(file|photo)|add.{0,20}(file|photo)|загруз|добавить.{0,20}(файл|фото)|fayl|rasm/i,
    removeBtnRe: /remove|delete|удал|убрать|o['’]chir|olib/i,
    sendSel: COMMON_SEND,
  },
  gemini: {
    attachBtnRe: /upload|open upload|attach|add|загруз|прикреп|добав|yuklash|biriktir/i,
    menuItemRe: /upload.{0,10}file|files?$|загрузить.{0,10}файл|файлы|fayllarni|fayl/i,
    removeBtnRe: /remove|delete|удал|убрать|o['’]chir|olib/i,
    sendSel: COMMON_SEND,
  },
};

const TURNS_SEL =
  '[data-turn-key], [data-content-search-turn-key], article, [data-message-author-role], user-query, model-response, [data-testid^="conversation-turn"]';
const ERR_RE =
  "(upload|file|image|attach|photo).{0,60}(fail|error|unsupported|too large|couldn|can'?t|not supported|exceed)|не удалось|ошибк|слишком|не поддерж|xatolik|yuklab bo['’]?lmadi";

class UploadNetworkGate {
  private inflight = new Set<unknown>();
  failure: string | null = null;
  private re = /upload|\/files?(\/|\?|$)|attachment|blob\.core\.windows|push\.clients6|googleusercontent/i;
  private onReq = (r: any) => {
    if (/^(POST|PUT|PATCH)$/.test(r.method()) && this.re.test(r.url())) {
      this.inflight.add(r);
    }
  };
  private onFin = (r: any) => {
    this.inflight.delete(r);
  };
  private onResp = (r: any) => {
    const req = r.request();
    if (this.re.test(req.url()) && /^(POST|PUT|PATCH)$/.test(req.method()) && r.status() >= 400) {
      this.failure = `HTTP ${r.status()} on upload request`;
    }
  };

  constructor(private page: Page) {
    page.on("request", this.onReq);
    page.on("requestfinished", this.onFin);
    page.on("requestfailed", this.onFin);
    page.on("response", this.onResp);
  }

  get pending() {
    return this.inflight.size;
  }

  dispose() {
    this.page.off("request", this.onReq);
    this.page.off("requestfinished", this.onFin);
    this.page.off("requestfailed", this.onFin);
    this.page.off("response", this.onResp);
  }
}

async function tagRoot(composer: Locator) {
  await composer.evaluate((el, a) => {
    document.querySelectorAll(`[${a.attr}]`).forEach((n) => n.removeAttribute(a.attr));
    let best: Element = el.closest("form") ?? el.parentElement ?? el;
    for (let i = 0; i < 6; i++) {
      const p = best.parentElement;
      if (!p || p === document.body || p.tagName === "MAIN" || p.querySelector(a.turns)) break;
      best = p;
    }
    best.setAttribute(a.attr, "1");
  }, { attr: ROOT_ATTR, turns: TURNS_SEL });
}

interface UploadState {
  tiles: number;
  imgsLoaded: boolean;
  spinners: number;
  error: string | null;
  sendEnabled: boolean | null;
}

async function readState(page: Page, p: UploadProfile): Promise<UploadState> {
  return page.evaluate((a) => {
    const root = document.querySelector(`[${a.rootAttr}="1"]`);
    if (!root) return { tiles: 0, imgsLoaded: true, spinners: 0, error: "root-missing", sendEnabled: null };
    const vis = (e: Element) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const inEditor = (e: Element) => !!e.closest('[contenteditable="true"]');
    const imgs = Array.from(root.querySelectorAll("img")).filter((i) => {
      const r = i.getBoundingClientRect();
      return r.width >= 24 && r.height >= 24 && !inEditor(i);
    });
    const rmRe = new RegExp(a.rmRe, "i");
    const removes = Array.from(root.querySelectorAll('button,[role="button"]')).filter(
      (b) => vis(b) && rmRe.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`),
    );
    const spinners = Array.from(root.querySelectorAll(
      '[role="progressbar"],progress,[aria-busy="true"],mat-spinner,svg.animate-spin,[class*="spinner" i],[class*="loading" i]',
    )).filter((e) => vis(e) && !inEditor(e)).length;
    const errRe = new RegExp(a.errRe, "i");
    const errEls = [
      ...Array.from(root.querySelectorAll('[role="alert"],[class*="error" i],[class*="fail" i],[data-state="error"]')),
      ...Array.from(document.querySelectorAll('[role="alert"],[role="status"],[class*="toast" i]')),
    ].filter((e) => vis(e) && !inEditor(e));
    let error: string | null = null;
    for (const e of errEls) {
      const t = (e.textContent ?? "").trim();
      if (t && t.length < 300 && errRe.test(t)) {
        error = t.slice(0, 160);
        break;
      }
    }
    const send = root.querySelector<HTMLButtonElement>(a.sendSel);
    const sendEnabled = send ? !send.disabled && send.getAttribute("aria-disabled") !== "true" : null;
    return {
      tiles: Math.max(imgs.length, removes.length),
      imgsLoaded: imgs.every((i) => i.complete && i.naturalWidth > 0),
      spinners,
      error,
      sendEnabled,
    };
  }, { rootAttr: ROOT_ATTR, rmRe: p.removeBtnRe.source, errRe: ERR_RE, sendSel: p.sendSel });
}

async function tagFileInput(page: Page): Promise<{ found: boolean; multiple: boolean }> {
  return page.evaluate((a) => {
    document.querySelectorAll(`[${a.inAttr}]`).forEach((n) => n.removeAttribute(a.inAttr));
    const root = document.querySelector(`[${a.rootAttr}="1"]`);
    if (!root) return { found: false, multiple: false };
    const scopes: Element[] = [root];
    let p = root.parentElement;
    for (let i = 0; i < 2 && p && !p.querySelector(a.turns); i++) {
      scopes.push(p);
      p = p.parentElement;
    }
    const seen = new Set<Element>();
    const cands: HTMLInputElement[] = [];
    for (const s of scopes) {
      s.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((i) => {
        if (!seen.has(i)) {
          seen.add(i);
          cands.push(i);
        }
      });
    }
    const ok = (i: HTMLInputElement) => {
      const acc = (i.accept || "").toLowerCase();
      return !acc || acc.includes("image") || acc.includes("*/*") || /\.(png|jpe?g|webp)/.test(acc);
    };
    const good = cands.filter(ok).sort((x, y) => Number(y.multiple) - Number(x.multiple));
    if (!good.length) return { found: false, multiple: false };
    good[0].setAttribute(a.inAttr, "1");
    return { found: true, multiple: good[0].multiple };
  }, { rootAttr: ROOT_ATTR, inAttr: INPUT_ATTR, turns: TURNS_SEL });
}

export class ImageAttachSession {
  private net: UploadNetworkGate;
  private profile: UploadProfile;
  private baseline = 0;

  constructor(
    private page: Page,
    provider: ProviderId,
    private composer: Locator,
    private files: ImageFile[],
    private log: (m: string) => void = () => {},
  ) {
    this.profile = PROFILES[provider];
    this.net = new UploadNetworkGate(page);
  }

  private async payloads(subset: ImageFile[] = this.files) {
    return Promise.all(
      subset.map(async (f) => ({
        name: f.name,
        mimeType: f.mime,
        buffer: await fs.readFile(f.absPath),
      })),
    );
  }

  private async clearTiles(max = 10) {
    const root = this.page.locator(`[${ROOT_ATTR}="1"]`);
    for (let i = 0; i < max; i++) {
      const btn = root.getByRole("button", { name: this.profile.removeBtnRe }).first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await btn.click({ timeout: 2000 }).catch(() => {});
      await this.page.waitForTimeout(200);
    }
  }

  async attach(): Promise<"input" | "chooser" | "paste"> {
    await tagRoot(this.composer);
    let st = await readState(this.page, this.profile);
    if (st.tiles > 0) {
      await this.clearTiles();
      st = await readState(this.page, this.profile);
    }
    this.baseline = st.tiles;

    const methods: Array<["input" | "chooser" | "paste", () => Promise<boolean>]> = [
      ["input", () => this.viaInput()],
      ["chooser", () => this.viaChooser()],
      ["paste", () => this.viaPaste()],
    ];

    for (const [name, fn] of methods) {
      let used = false;
      try {
        used = await fn();
      } catch (e) {
        this.log(`${name} failed: ${(e as Error).message}`);
      }
      if (!used) continue;
      try {
        await this.settle(false, 12_000 + 8_000 * this.files.length, this.files.length);
        return name;
      } catch (e) {
        const cur = await readState(this.page, this.profile);
        if (cur.tiles > this.baseline) throw e;
        this.log(`${name}: no tile appeared; trying next tier`);
      }
    }
    await this.abort();
    throw new AttachmentError("attach", "no upload method produced attachment tiles");
  }

  private async viaInput(): Promise<boolean> {
    const { found, multiple } = await tagFileInput(this.page);
    if (!found) return false;
    const input = this.page.locator(`[${INPUT_ATTR}="1"]`);
    if (multiple) {
      await input.setInputFiles(await this.payloads(), { timeout: 10_000 });
      return true;
    }
    for (let i = 0; i < this.files.length; i++) {
      await this.page.locator(`[${INPUT_ATTR}="1"]`).setInputFiles(await this.payloads([this.files[i]]), { timeout: 10_000 });
      await this.settle(false, 20_000, i + 1);
      await tagFileInput(this.page);
    }
    return true;
  }

  private async viaChooser(): Promise<boolean> {
    const root = this.page.locator(`[${ROOT_ATTR}="1"]`);
    const btns = root.getByRole("button", { name: this.profile.attachBtnRe });
    const n = Math.min(await btns.count(), 4);
    for (let i = 0; i < n; i++) {
      const b = btns.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const first = this.page.waitForEvent("filechooser", { timeout: 1500 }).catch(() => null);
      await b.click({ timeout: 3000 }).catch(() => {});
      let ch = await first;
      if (!ch) {
        const item = this.page
          .getByRole("menuitem", { name: this.profile.menuItemRe })
          .or(this.page.getByRole("button", { name: this.profile.menuItemRe }))
          .or(this.page.getByText(this.profile.menuItemRe))
          .first();
        if (await item.isVisible({ timeout: 800 }).catch(() => false)) {
          const second = this.page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
          await item.click({ timeout: 3000 }).catch(() => {});
          ch = await second;
        }
      }
      if (ch) {
        await ch.setFiles(await this.payloads());
        return true;
      }
      await this.page.keyboard.press("Escape").catch(() => {});
    }
    return false;
  }

  private async viaPaste(): Promise<boolean> {
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i];
      const item = {
        name: f.name,
        mime: f.mime,
        b64: (await fs.readFile(f.absPath)).toString("base64"),
      };
      await this.composer.evaluate((el, it) => {
        const bin = atob(it.b64);
        const u8 = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
        const dt = new DataTransfer();
        dt.items.add(new File([u8], it.name, { type: it.mime }));
        (el as HTMLElement).focus();
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, item);
      await this.settle(false, 20_000, i + 1);
    }
    return true;
  }

  async settle(needSend: boolean, timeoutMs = 15_000 + 10_000 * this.files.length, expected = this.files.length, quietMs = 800) {
    const t0 = Date.now();
    let okSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      const st = await readState(this.page, this.profile);
      if (st.error && st.error !== "root-missing") throw new AttachmentError("upload-error", st.error);
      if (this.net.failure) throw new AttachmentError("upload-network", this.net.failure);
      const delta = st.tiles - this.baseline;
      const ok =
        delta >= expected &&
        st.spinners === 0 &&
        st.imgsLoaded &&
        this.net.pending === 0 &&
        (!needSend || st.sendEnabled === true);
      if (ok) {
        okSince ||= Date.now();
        if (Date.now() - okSince >= quietMs) return;
      } else {
        okSince = 0;
      }
      await this.page.waitForTimeout(250);
    }
    const st = await readState(this.page, this.profile);
    throw new AttachmentError(
      "settle-timeout",
      `tiles+${st.tiles - this.baseline}/${expected} spinners=${st.spinners} loaded=${st.imgsLoaded} pendingReq=${this.net.pending} send=${st.sendEnabled}`,
    );
  }

  async verifySent(): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      const st = await readState(this.page, this.profile);
      if (st.tiles <= this.baseline) return true;
      await this.page.waitForTimeout(250);
    }
    return false;
  }

  async abort() {
    await this.clearTiles().catch(() => {});
    this.dispose();
  }

  dispose() {
    this.net.dispose();
  }
}
