// image-upload.ts
// Robust multimodal file upload session supporting modern ChatGPT, Claude, and Gemini web interfaces.
// Features document-wide file input discovery, plus-button menu chooser, synthetic blob drop/paste, and composer-scoped tile verification.

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

const IN_ATTR = "data-ac-file-input";
const PLUS_ATTR = "data-ac-plus";
const RM_ATTR = "data-ac-rm";

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
}

export class AttachmentError extends Error {
  constructor(public phase: string, msg: string, public diag?: unknown) {
    super(`[image-attach:${phase}] ${msg}`);
    this.name = "AttachmentError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * In-page DOM inspector to locate composer, inspect state, and tag input/button elements.
 */
function pageOp(page: Page, op: "state" | "tagInput" | "tagPlus" | "tagRemove" | "diag"): Promise<any> {
  return page.evaluate(
    ([op, IN, PL, RM]) => {
      const ta = document.querySelector<HTMLElement>(
        '#prompt-textarea, [data-testid="prompt-textarea"], .ProseMirror[contenteditable="true"], rich-textarea, .ql-editor',
      );
      const inHistory = (e: Element) => !!e.closest("[data-message-author-role], article, model-response, user-query");
      const visible = (e: Element) => (e as HTMLElement).getClientRects().length > 0;

      let root: Element | null = ta ? ta.closest("form") : null;
      if (!root && ta) {
        root = ta;
        for (
          let i = 0;
          i < 6 && root.parentElement && !root.parentElement.querySelector("[data-message-author-role]");
          i++
        ) {
          root = root.parentElement;
        }
      }

      const q = (s: string) =>
        root ? Array.from(root.querySelectorAll<HTMLElement>(s)).filter((e) => !inHistory(e) && visible(e)) : [];

      const RM_SEL =
        'button[aria-label*="remove" i], button[aria-label*="удалить" i], button[aria-label*="olib" i], [data-testid*="remove" i], [data-testid*="attachment-remove" i]';

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

      if (op === "state") {
        const rm = q(RM_SEL).length;
        const blobs = q('img[src^="blob:"], img[src*="oaiusercontent" i], img[src*="/files/" i]').length;
        const chips = q(
          '[data-testid*="attachment" i], [data-testid*="file-tile" i], div[class*="attachment" i], div[class*="image-preview" i]',
        ).length;
        const busy =
          q(
            '[role="progressbar"], [aria-busy="true"], [data-testid*="uploading" i], [data-testid*="spinner" i]',
          ).length > 0;

        return {
          composer: !!root,
          count: Math.max(rm, blobs, chips),
          busy,
          alert: alertText(),
        };
      }

      if (op === "tagInput") {
        document.querySelectorAll(`[${IN}]`).forEach((e) => e.removeAttribute(IN));
        // Search document-wide (file inputs frequently live outside the form in React portals)
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
          'button[aria-haspopup="menu"]',
        ];

        let hit: HTMLElement | undefined;
        for (const s of sels) {
          hit = q(s)[0];
          if (hit) break;
        }

        if (!hit) {
          // Structural fallback: leftmost button with an icon in composer
          const bad = /send|voice|speech|mic|dictat|stop|submit/i;
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

      // Diagnostic dump on failure
      return {
        url: location.href,
        composer: !!root,
        inputs: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).map((i) => ({
          id: i.id,
          accept: i.accept,
          multiple: i.multiple,
          inForm: !!i.closest("form"),
          parent: i.parentElement?.tagName,
        })),
        buttons: q("button").map((b) => ({
          aria: b.getAttribute("aria-label"),
          tid: b.getAttribute("data-testid"),
          text: (b.textContent || "").trim().slice(0, 30),
        })),
        alert: alertText(),
      };
    },
    [op, IN_ATTR, PLUS_ATTR, RM_ATTR] as const,
  );
}

export class ImageAttachSession {
  private files: FilePayload[] = [];
  private disposed = false;

  constructor(
    private page: Page,
    private provider: ProviderId = "chatgpt",
    private composer?: Locator,
    images: (ImageFile | string)[] = [],
    private log: (m: string) => void = (m) => console.error(m),
  ) {
    this.initFiles(images);
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
    if (!this.files.length) return "input";

    await this.clearStale();
    const targetCount = this.files.length;

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

      const timeoutMs = name === "input" || name === "chooser" ? 18000 : 12000;
      const res = await this.waitForSettled(targetCount, timeoutMs);

      if (res.ok) {
        this.log(`[image-attach] attached successfully via ${name}`);
        return name as any;
      }

      if (res.s.count >= targetCount || res.toast) {
        const diag = await pageOp(this.page, "diag");
        throw new AttachmentError(
          "attach",
          `via ${name}: ${res.toast ? "error toast" : "tile appeared but upload did not settle"}: ${res.s.alert || "busy=" + res.s.busy}`,
          diag,
        );
      }

      errs.push(`${name}: no tile appeared`);
    }

    const diag = await pageOp(this.page, "diag");
    throw new AttachmentError("attach", `no upload method produced attachment tiles :: ${errs.join(" | ")}`, diag);
  }

  private async clearStale() {
    for (let i = 0; i < 6 && (await pageOp(this.page, "tagRemove")); i++) {
      await this.page.locator(`[${RM_ATTR}="1"]`).first().click({ timeout: 2000 }).catch(() => {});
      await sleep(300);
    }
  }

  private async viaInput() {
    const r = await pageOp(this.page, "tagInput");
    if (!r.found) throw new Error("no input[type=file] found in document");

    const input = this.page.locator(`[${IN_ATTR}="1"]`);
    await input.setInputFiles(this.files, { timeout: 10000 });
  }

  private async viaChooser() {
    const hasPlus = await pageOp(this.page, "tagPlus");
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
        async ({ name, mimeType, b64, kind }) => {
          const bin = atob(b64);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          const dt = new DataTransfer();
          dt.items.add(new File([u8], name, { type: mimeType }));

          const ta = document.querySelector<HTMLElement>(
            '#prompt-textarea, [data-testid="prompt-textarea"], .ProseMirror[contenteditable="true"], rich-textarea, .ql-editor',
          );
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
        },
      );
    }
  }

  private async waitForSettled(expected: number, timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    let stable = 0;
    let s: ComposerState = await pageOp(this.page, "state");

    while (Date.now() < end) {
      s = await pageOp(this.page, "state");
      if (s.alert && ERR_RE.test(s.alert)) {
        return { ok: false as const, s, toast: true };
      }
      if (s.count >= expected && !s.busy) {
        stable ||= Date.now();
        if (Date.now() - stable >= 600) {
          return { ok: true as const, s, toast: false };
        }
      } else {
        stable = 0;
      }
      await sleep(250);
    }

    return { ok: false as const, s, toast: false };
  }

  async settle(requireSend = false, timeoutMs = 25000): Promise<void> {
    const res = await this.waitForSettled(this.files.length, timeoutMs);
    if (!res.ok) {
      throw new AttachmentError(
        "settle",
        res.toast
          ? `Upload failed or limit reached: ${res.s.alert}`
          : `Images did not finish uploading within ${timeoutMs / 1000}s`,
      );
    }
  }

  async verifySent(timeoutMs = 5000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = await pageOp(this.page, "state");
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
