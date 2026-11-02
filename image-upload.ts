// image-upload.ts
// Robust multimodal file upload session supporting modern ChatGPT, Claude, and Gemini web interfaces.
// Features provider-aware profiles, geometric root boundary, document-wide file input discovery,
// plus-button menu chooser, synthetic blob drop/paste, and tolerant tile verification.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Page, Locator } from "playwright-core";
import type { ImageFile, ProviderId } from "./image-attachments.js";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface Profile {
  id: ProviderId;
  composer: string;
  history: string;
  tiles: string;
  busy: string;
}

const PROFILES: Record<ProviderId, Profile> = {
  chatgpt: {
    id: "chatgpt",
    composer: '#prompt-textarea, [data-testid="prompt-textarea"], .ProseMirror[contenteditable="true"]',
    history: '[data-turn-key], [data-content-search-turn-key], [data-message-author-role], article',
    tiles: '[data-testid*="attachment" i], [data-testid*="file-tile" i]',
    busy: '[role="progressbar"], [aria-busy="true"], [data-testid*="uploading" i], [data-testid*="spinner" i]',
  },
  claude: {
    id: "claude",
    composer: '[data-testid="chat-input"], div.ProseMirror[contenteditable="true"]',
    history: '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-message, .font-user-message, [data-test-render-count]',
    tiles: '[data-testid="file-thumbnail"], [data-testid*="attachment" i], [class*="thumbnail" i], [class*="file-preview" i]',
    busy: '[role="progressbar"], [aria-busy="true"], [data-testid*="uploading" i], [data-testid*="spinner" i]',
  },
  gemini: {
    id: "gemini",
    composer: 'rich-textarea, .ql-editor[contenteditable="true"]',
    history: 'user-query, model-response, message-content',
    tiles: 'uploader-file-preview, [data-test-id*="file-preview" i], [class*="file-preview" i], [class*="attachment" i]',
    busy: '[role="progressbar"], mat-progress-spinner, mat-spinner, [aria-busy="true"]',
  },
};

const IN_ATTR = "data-ac-file-input";
const PLUS_ATTR = "data-ac-plus";
const RM_ATTR = "data-ac-rm";

const RM_SEL =
  'button[aria-label*="remove" i], button[aria-label*="удалить" i], button[aria-label*="убрать" i], button[aria-label*="olib" i], [data-testid*="remove" i], [data-test-id*="remove" i], [data-testid*="attachment-remove" i]';

const UPLOAD_MENU_RE =
  /upload|add (photos|files)|from (computer|device)|photos? (&|and) files|загруз|прикреп|yuklash|biriktir/i;
const ERR_RE =
  /limit|too many|unsupported|failed|error|couldn.?t|can.?t|exceed|превыш|ошибк|xato/i;

export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface ComposerState {
  composer: boolean;
  count: number;
  busy: boolean;
  alert: string;
  sig?: { rm: number; imgs: number; chips: number };
}

export class AttachmentError extends Error {
  constructor(public phase: string, msg: string, public diag?: unknown) {
    super(`[image-attach:${phase}] ${msg}`);
    this.name = "AttachmentError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUSY_GRACE_MS = 12000;

type Op = "state" | "tagInput" | "tagPlus" | "tagRemove" | "diag";

/**
 * In-page DOM inspector to locate composer, inspect state, and tag input/button elements.
 */
function pageOp(page: Page, op: Op, prof: Profile): Promise<any> {
  return page.evaluate(
    ([op, IN, PL, RM, prof, RM_SEL]) => {
      const vis = (e: Element) => (e as HTMLElement).getClientRects().length > 0;
      const ta = Array.from(document.querySelectorAll<HTMLElement>(prof.composer)).find(vis) ?? null;

      // Root = largest ancestor of the composer that (a) holds no chat history and (b) stays composer-sized.
      // Works across Claude (no <form>), ChatGPT, and Gemini.
      const MAXH = Math.min(520, window.innerHeight * 0.6);
      let root: HTMLElement | null = null;
      if (ta) {
        let best: HTMLElement = ta;
        let p: HTMLElement | null = ta;
        for (let i = 0; i < 10 && p; i++, p = p.parentElement) {
          if (p.matches(prof.history) || p.querySelector(prof.history)) break;
          if (p.getBoundingClientRect().height > MAXH) break;
          best = p;
        }
        root = best;
      }

      const q = (s: string) =>
        root
          ? Array.from(root.querySelectorAll<HTMLElement>(s)).filter((e) => vis(e) && !e.closest(prof.history))
          : [];

      const alertText = () =>
        Array.from(
          document.querySelectorAll(
            '[role="alert"], [data-sonner-toast], [data-testid*="toast" i], [role="status"]',
          ),
        )
          .map((e) => (e.textContent || "").trim())
          .filter(Boolean)
          .join(" | ")
          .slice(0, 300);

      const signals = () => {
        const rm = q(RM_SEL).length;
        const imgs = q("img").filter((i) => {
          const r = i.getBoundingClientRect();
          const src = (i as HTMLImageElement).src || "";
          return r.width >= 28 && r.height >= 28 && !/^data:image\/svg/i.test(src);
        }).length;
        const chipEls = q(prof.tiles);
        const chips = chipEls.filter((e) => !chipEls.some((o) => o !== e && e.contains(o))).length;
        return { rm, imgs, chips };
      };

      if (op === "state") {
        const s = signals();
        const count = Math.max(s.rm, s.imgs) || s.chips;
        return {
          composer: !!root,
          count,
          busy: q(prof.busy).length > 0,
          alert: alertText(),
          sig: s,
        };
      }

      if (op === "tagInput") {
        document.querySelectorAll(`[${IN}]`).forEach((e) => e.removeAttribute(IN));
        const all = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter(
          (i) => !i.disabled && !i.webkitdirectory,
        );
        if (!all.length) return { found: false, total: 0 };

        const score = (i: HTMLInputElement) => {
          const a = (i.accept || "").toLowerCase();
          let s = 0;
          if (!a) s += 2;
          if (/image|jpe?g|png|\*/.test(a)) s += 4;
          if (i.multiple) s += 2;
          if (i.closest("form")) s += 2;
          if (i.hasAttribute("capture") || /camera/i.test(i.id)) s -= 5;
          return s;
        };

        all.sort((a, b) => score(b) - score(a));
        all[0].setAttribute(IN, "1");
        return { found: true, total: all.length, multiple: all[0].multiple };
      }

      if (op === "tagPlus") {
        document.querySelectorAll(`[${PL}]`).forEach((e) => e.removeAttribute(PL));
        const sels = [
          '[data-testid="composer-plus-btn"]',
          'button[data-testid*="attach" i]',
          'button[aria-label*="attach" i]',
          'button[aria-label*="add files" i]',
          'button[aria-label*="add photos" i]',
          'button[aria-label*="upload" i]',
          'button[aria-label*="add content" i]',
          'button[aria-label*="прикреп" i]',
          'button[aria-label*="загруз" i]',
        ];

        let hit: HTMLElement | undefined;
        for (const s of sels) {
          hit = q(s)[0];
          if (hit) break;
        }

        if (!hit) {
          const bad = /send|voice|speech|mic|dictat|stop|submit|отправ|голос/i;
          hit = q("button")
            .filter(
              (b) =>
                !(b.textContent || "").trim() &&
                !bad.test((b.getAttribute("aria-label") || "") + (b.getAttribute("data-testid") || "")) &&
                !!b.querySelector("svg"),
            )
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
        }

        if (!hit) return false;
        hit.setAttribute(PL, "1");
        return true;
      }

      if (op === "tagRemove") {
        document.querySelectorAll(`[${RM}]`).forEach((e) => e.removeAttribute(RM));
        const b = q(RM_SEL)[0];
        if (!b) return false;
        b.setAttribute(RM, "1");
        return true;
      }

      // diag: structure only. No private prompt text.
      const r = root?.getBoundingClientRect();
      return {
        url: location.href,
        provider: prof.id,
        composerFound: !!ta,
        root: root ? { tag: root.tagName, w: Math.round(r!.width), h: Math.round(r!.height) } : null,
        historyInsideRoot: root ? root.querySelectorAll(prof.history).length : null,
        signals: root ? signals() : null,
        imgs: q("img").map((i) => ({
          w: Math.round(i.getBoundingClientRect().width),
          h: Math.round(i.getBoundingClientRect().height),
          scheme: ((i as HTMLImageElement).src || "").split(":")[0],
        })),
        busy: q(prof.busy).map((e) => ({
          tag: e.tagName,
          cls: String(e.className).slice(0, 60),
          aria: e.getAttribute("aria-label"),
          role: e.getAttribute("role"),
        })),
        removeButtons: q(RM_SEL).map((e) => e.getAttribute("aria-label")),
        fileInputs: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).map((i) => ({
          accept: i.accept,
          multiple: i.multiple,
          inForm: !!i.closest("form"),
        })),
        alert: alertText(),
      };
    },
    [op, IN_ATTR, PLUS_ATTR, RM_ATTR, prof, RM_SEL] as const,
  );
}

export class ImageAttachSession {
  private files: FilePayload[] = [];
  private disposed = false;
  private prof: Profile;
  private initPromise: Promise<void>;

  constructor(
    private page: Page,
    private provider: ProviderId = "chatgpt",
    private composer?: Locator,
    images: (ImageFile | string)[] = [],
    private log: (m: string) => void = (m) => console.error(m),
  ) {
    this.prof = PROFILES[this.provider] || PROFILES.chatgpt;
    this.initPromise = this.initFiles(images);
  }

  private async initFiles(images: (ImageFile | string)[]) {
    this.files = await Promise.all(
      images.map(async (img) => {
        const absPath = typeof img === "string" ? img : img.absPath;
        const name = typeof img === "string" ? basename(absPath) : img.name;
        const ext = extname(absPath).toLowerCase();
        const mimeType = typeof img === "string" ? MIME_BY_EXT[ext] || "image/jpeg" : img.mime;
        const buffer = await readFile(absPath);
        return { name, mimeType, buffer };
      }),
    );
  }

  async attach(): Promise<"input" | "chooser" | "drop" | "paste"> {
    await this.initPromise;
    if (!this.files.length) return "input";

    await this.clearStale();
    const baseCount = (await pageOp(this.page, "state", this.prof)).count;
    const targetCount = baseCount + this.files.length;

    const tiers: [string, () => Promise<void>][] = [
      ["input", () => this.viaInput()],
      ["chooser", () => this.viaChooser()],
      ["drop", () => this.viaDrop("drop")],
      ["paste", () => this.viaDrop("paste")],
    ];

    const errs: string[] = [];
    for (const [name, run] of tiers) {
      try {
        await run();
      } catch (e: any) {
        errs.push(`${name}: ${e.message}`);
        continue;
      }

      const timeoutMs =
        name === "input" || name === "chooser"
          ? Math.min(60000, 18000 + Math.ceil(this.totalBytes() / 1048576) * 5000)
          : 12000;

      const res = await this.waitForSettled(targetCount, timeoutMs);

      if (res.ok) {
        this.log(`[image-attach] attached successfully via ${name} (${res.why})`);
        return name as any;
      }

      if (res.s.count >= targetCount || res.toast) {
        const diag = await pageOp(this.page, "diag", this.prof);
        throw new AttachmentError(
          "attach",
          `via ${name}: ${res.toast ? "error toast" : "tile appeared but upload did not settle"}: ${res.s.alert || "busy=" + res.s.busy}`,
          diag,
        );
      }

      errs.push(`${name}: no tile appeared`);
    }

    const diag = await pageOp(this.page, "diag", this.prof);
    throw new AttachmentError("attach", `no upload method produced attachment tiles :: ${errs.join(" | ")}`, diag);
  }

  private totalBytes(): number {
    return this.files.reduce((acc, f) => acc + (f.buffer?.length || 0), 0);
  }

  private async clearStale() {
    for (let i = 0; i < 6 && (await pageOp(this.page, "tagRemove", this.prof)); i++) {
      await this.page.locator(`[${RM_ATTR}="1"]`).first().click({ timeout: 2000 }).catch(() => {});
      await sleep(300);
    }
  }

  private async viaInput() {
    const r = await pageOp(this.page, "tagInput", this.prof);
    if (!r.found) throw new Error("no input[type=file] found in document");

    const input = this.page.locator(`[${IN_ATTR}="1"]`);
    await input.setInputFiles(this.files, { timeout: 10000 });
  }

  private async viaChooser() {
    const hasPlus = await pageOp(this.page, "tagPlus", this.prof);
    if (!hasPlus) throw new Error("plus/attach button not found in composer");

    const direct = this.page.waitForEvent("filechooser", { timeout: 7000 });
    direct.catch(() => {});

    await this.page.locator(`[${PLUS_ATTR}="1"]`).click({ timeout: 3000 });

    const item = this.page.getByRole("menuitem", { name: UPLOAD_MENU_RE }).first();
    const itemVisible = await item.waitFor({ state: "visible", timeout: 2000 }).then(
      () => true,
      () => false,
    );

    if (itemVisible) {
      await item.click({ timeout: 2000 });
    }

    try {
      const chooser = await direct;
      await chooser.setFiles(this.files);
    } catch (e) {
      await this.page.keyboard.press("Escape").catch(() => {});
      throw e;
    }
  }

  private async viaDrop(kind: "drop" | "paste") {
    for (const f of this.files) {
      await this.page.evaluate(
        async ({ name, mimeType, b64, kind, composerSel }) => {
          const bin = atob(b64);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          const dt = new DataTransfer();
          dt.items.add(new File([u8], name, { type: mimeType }));

          const ta = document.querySelector<HTMLElement>(composerSel);
          if (!ta) throw new Error("composer textarea not found");

          if (kind === "paste") {
            ta.focus();
            ta.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
          } else {
            const form = ta.closest("form") ?? ta;
            for (const type of ["dragenter", "dragover", "drop"]) {
              form.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
            }
          }
        },
        {
          name: f.name,
          mimeType: f.mimeType,
          b64: f.buffer.toString("base64"),
          kind,
          composerSel: this.prof.composer,
        },
      );
    }
  }

  private async waitForSettled(
    expected: number,
    timeoutMs: number,
  ): Promise<{ ok: boolean; s: ComposerState; toast: boolean; why: string }> {
    const end = Date.now() + timeoutMs;
    let stableSince = 0;
    let busySince = 0;
    let s: ComposerState = await pageOp(this.page, "state", this.prof);

    while (Date.now() < end) {
      s = await pageOp(this.page, "state", this.prof);
      if (s.alert && ERR_RE.test(s.alert)) {
        return { ok: false, s, toast: true, why: "toast" };
      }
      if (s.count >= expected) {
        if (!s.busy) {
          busySince = 0;
          stableSince ||= Date.now();
          if (Date.now() - stableSince >= 600) {
            return { ok: true, s, toast: false, why: "settled" };
          }
        } else {
          stableSince = 0;
          busySince ||= Date.now();
          // Accept stuck busy spinners after 12s grace period to prevent indefinite timeout
          if (Date.now() - busySince >= BUSY_GRACE_MS) {
            return { ok: true, s, toast: false, why: "busy-indicator-grace-accepted" };
          }
        }
      } else {
        stableSince = 0;
        busySince = 0;
      }
      await sleep(250);
    }

    return { ok: false, s, toast: false, why: "timeout" };
  }

  async settle(requireSend = false, timeoutMs = 25000): Promise<void> {
    await this.initPromise;
    const res = await this.waitForSettled(this.files.length, timeoutMs);
    if (!res.ok) {
      throw new AttachmentError(
        "settle",
        res.toast
          ? `Upload failed or limit reached: ${res.s.alert}`
          : `Images did not finish uploading within ${timeoutMs / 1000}s (${res.why})`,
      );
    }
  }

  async verifySent(timeoutMs = 5000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = await pageOp(this.page, "state", this.prof);
      if (s.count === 0) return;
      await sleep(250);
    }
  }

  async abort(): Promise<void> {
    await this.clearStale();
  }

  dispose(): void {
    this.disposed = true;
  }
}
