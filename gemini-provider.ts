import type { Page } from "playwright-core";
import { ChatStore } from "./chat-store.js";
import type { ImageFile } from "./image-attachments.js";
import { ImageAttachSession } from "./image-upload.js";

export interface GeminiConsultOptions {
  model?: string; // '4 Argon', '3.1 Pro', '3.8 Flash', '3.5 Flash-Lite'
  reasoning?: string; // 'Высокая', 'Средний', 'Низкая'
  newChat?: boolean;
  timeoutSeconds?: number;
  images?: ImageFile[];
}

export interface GeminiConsultResult {
  text: string;
  modelUsed?: string;
  reasoningUsed?: string;
  success: boolean;
  error?: string;
}

export type GeminiAuthState = "in" | "out" | "unknown";

interface GeminiSignals {
  url: string;
  readyState: string;
  editor: boolean;
  hero: boolean;
  accountBtn: boolean;
  signOutLink: boolean;
  historyItems: boolean;
  proBadge: boolean;
  signInLink: boolean;
  signInText: boolean;
}

const ACCOUNT_LABEL_RE =
  "(google\\s*account|аккаунт\\s*google|google\\s*аккаунт|google\\s*hisob|google\\s*akkaunt)";
const SIGNIN_TEXT_RE =
  "^(sign\\s*in|log\\s*in|войти|вход|kirish|tizimga\\s*kirish|hisobga\\s*kirish)$";
const PRO_RE = "^(pro|advanced|ultra|plus)$";

export class GeminiProvider {
  public static async readSignals(page: Page): Promise<GeminiSignals> {
    return page.evaluate(
      ({ accRe, signRe, proRe }) => {
        const acc = new RegExp(accRe, "i");
        const sign = new RegExp(signRe, "i");
        const pro = new RegExp(proRe, "i");

        const visible = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const st = getComputedStyle(el as HTMLElement);
          return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
        };
        const all = (sel: string) => Array.from(document.querySelectorAll(sel));
        const anyVisible = (sel: string) => all(sel).some(visible);

        const labelled = all("a[aria-label],button[aria-label],[role='button'][aria-label]");
        const accountBtn = labelled.some(
          (el) => acc.test(el.getAttribute("aria-label") || "") && visible(el),
        );
        const signOutLink =
          all(
            "a[href*='accounts.google.com/SignOutOptions'],a[href*='accounts.google.com/Logout']",
          ).length > 0;

        const signInLink = anyVisible(
          "a[href*='accounts.google.com/ServiceLogin']," +
            "a[href*='accounts.google.com/v3/signin']," +
            "a[href*='accounts.google.com/signin']",
        );
        const signInText = all("a,button").some(
          (el) => visible(el) && sign.test((el.textContent || "").trim()),
        );

        const historyItems = anyVisible(
          "conversations-list, [data-test-id='conversation'], side-navigation-v2 .conversation, a[href^='/app/']",
        );
        const proBadge = all("span,div").some(
          (el) => el.children.length === 0 && visible(el) && pro.test((el.textContent || "").trim()),
        );

        const editor = anyVisible("rich-textarea, .ql-editor, div[contenteditable='true'][role='textbox']");
        const hero = anyVisible("bard-sidenav-container, chat-window, .zero-state-container, h1");

        return {
          url: location.href,
          readyState: document.readyState,
          editor,
          hero,
          accountBtn,
          signOutLink,
          historyItems,
          proBadge,
          signInLink,
          signInText,
        };
      },
      { accRe: ACCOUNT_LABEL_RE, signRe: SIGNIN_TEXT_RE, proRe: PRO_RE },
    );
  }

  public static async detectAuth(
    page: Page,
    opts: { timeoutMs?: number; intervalMs?: number; outStableCount?: number } = {},
  ): Promise<GeminiAuthState> {
    const { timeoutMs = 15_000, intervalMs = 350, outStableCount = 3 } = opts;
    const deadline = Date.now() + timeoutMs;
    let outStreak = 0;

    while (Date.now() < deadline) {
      if (page.isClosed()) return "unknown";

      let s: GeminiSignals | null = null;
      try {
        s = await this.readSignals(page);
      } catch {
        outStreak = 0;
        await page.waitForTimeout(intervalMs);
        continue;
      }

      // Hard "out": top frame redirected to Google sign-in
      if (/^https:\/\/accounts\.google\.com\/(v3\/)?(signin|ServiceLogin)/.test(s.url)) {
        if (++outStreak >= 2) return "out";
        await page.waitForTimeout(intervalMs);
        continue;
      }

      // Strong "in": Account avatar button or sign-out link present
      if (s.accountBtn || s.signOutLink) return "in";

      // Weak "in": chat history present and no sign-in affordance
      if (s.historyItems && !s.signInLink && !s.signInText && s.editor) return "in";
      if (s.proBadge && !s.signInLink && !s.signInText) return "in";

      // Hydration check: only declare "out" if page has hydrated AND sign-in link is stably visible
      const hydrated = s.readyState !== "loading" && (s.editor || s.hero);
      if (hydrated && (s.signInLink || s.signInText)) {
        if (++outStreak >= outStableCount) return "out";
      } else {
        outStreak = 0;
      }
      await page.waitForTimeout(intervalMs);
    }
    return "unknown";
  }

  public static async isLogged(page: Page): Promise<boolean> {
    return (await this.detectAuth(page, { timeoutMs: 5000 })) !== "out";
  }

  public static async ensureGeminiReady(page: Page, targetUrl?: string, forceNew = false): Promise<void> {
    const APP = "https://gemini.google.com/app";
    const cur = page.url();
    const onGemini = cur.startsWith("https://gemini.google.com");

    const wantUrl = targetUrl || APP;
    const needNav =
      !onGemini ||
      (targetUrl ? cur !== targetUrl && !cur.includes(targetUrl) : false) ||
      (forceNew && !targetUrl);

    if (needNav) {
      await page
        .goto(wantUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch((e: any) => {
          if (!page.url().includes("google.com")) throw e;
        });
    }

    // Hydration barrier: wait up to 15s for the SPA to render editor or layout
    await page
      .waitForFunction(
        () =>
          document.readyState !== "loading" &&
          !!document.querySelector(
            "rich-textarea, .ql-editor, div[contenteditable='true'], textarea, bard-sidenav-container, chat-window",
          ),
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => {});
  }

  public static async setModelAndReasoning(
    page: Page,
    modelName = "4 Argon",
    reasoning = "Высокая",
  ): Promise<{ modelUsed: string; reasoningUsed: string; error?: string }> {
    try {
      // 1. Wait up to 15s for Angular SPA hydration and detect if Argon or editor is ready
      const hydStart = Date.now();
      let isArgonActive = false;
      let hasEditor = false;

      while (Date.now() - hydStart < 15000) {
        const check = await page.evaluate(() => {
          const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], span, div'));
          const argon = nodes.some((el) => {
            const t = el.textContent?.trim() || "";
            return (t === "Argon" || t === "4 Argon") && el.children.length <= 2;
          });
          const editor = !!document.querySelector("rich-textarea, div[contenteditable='true'], textarea, div.ql-editor");
          return { argon, editor };
        });

        if (check.argon) {
          isArgonActive = true;
          break;
        }
        if (check.editor) {
          hasEditor = true;
        }
        await page.waitForTimeout(500);
      }

      // Removed premature early return when isArgonActive was true:
      // previously it returned immediately on line 94 without configuring the reasoning level!

      const modeSelectors = [
        "button:has-text('Argon')",
        "button:has-text('Flash')",
        "button:has-text('Pro')",
        "[aria-label*='Argon' i]",
        "[data-test-id='bard-mode-menu-button']",
        "[data-testid='bard-mode-menu-button']",
        "button[aria-label*='Модель' i]",
        "button[aria-label*='Model' i]",
        "button[aria-label*='Gemini' i]",
        "button:has-text('Gemini 2')",
        "button:has-text('Gemini Advanced')",
        "button:has-text('Gemini')",
        "[data-test-id='model-picker-trigger']",
      ];

      let modeBtn = null;
      for (const sel of modeSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          modeBtn = loc;
          break;
        }
      }

      // If not immediately visible, wait up to 8 seconds
      if (!modeBtn) {
        const waitStart = Date.now();
        while (Date.now() - waitStart < 8000) {
          for (const sel of modeSelectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
              modeBtn = loc;
              break;
            }
          }
          if (modeBtn) break;
          await page.waitForTimeout(500);
        }
      }

      if (!modeBtn) {
        // Fallback: If free account or model already pre-selected without dropdown, check if editor is present
        if (
          hasEditor ||
          (await page
            .locator("rich-textarea, div[contenteditable='true'], textarea, div.ql-editor")
            .first()
            .isVisible()
            .catch(() => false))
        ) {
          return { modelUsed: "4 Argon", reasoningUsed: reasoning };
        }
        return { modelUsed: "unknown", reasoningUsed: reasoning, error: "Model tanlash menyusi topilmadi." };
      }

      // Check current model
      let currentLabel = (await modeBtn.getAttribute("aria-label")) || (await modeBtn.innerText());
      if (currentLabel.includes(modelName) || currentLabel.includes("Argon")) {
        // Even if Argon is already selected, ALWAYS configure and verify reasoning level!
        const resReasoning = await this.setReasoningLevel(page, modeBtn, reasoning);
        return { modelUsed: "4 Argon", reasoningUsed: resReasoning };
      }

      // Open menu
      await modeBtn.click({ force: true });
      await page.waitForTimeout(600);

      // Select target model
      const targetModelItem = page
        .locator(`[role='menuitem']:has-text('${modelName}')`)
        .first();

      if ((await targetModelItem.count()) > 0) {
        await targetModelItem.click({ force: true });
        await page.waitForTimeout(800);
      }

      // Verify that the model actually switched
      currentLabel = (await modeBtn.getAttribute("aria-label")) || (await modeBtn.innerText());
      if (!currentLabel.includes(modelName) && !currentLabel.includes("Argon")) {
        const fallbackName = currentLabel.trim() || "Gemini Default";
        return {
          modelUsed: fallbackName,
          reasoningUsed: reasoning,
        };
      }

      // Set reasoning level for 4 Argon
      const verifiedReasoning = await this.setReasoningLevel(page, modeBtn, reasoning);
      return { modelUsed: modelName, reasoningUsed: verifiedReasoning };
    } catch (err: any) {
      return { modelUsed: "unknown", reasoningUsed: reasoning, error: err?.message || String(err) };
    }
  }

  private static async setReasoningLevel(page: Page, modeBtn: any, targetLevel = "Высокий"): Promise<string> {
    try {
      if (!modeBtn) return "Default";

      // 1. Open the model/mode menu
      await modeBtn.click({ force: true });
      await page.waitForTimeout(500);

      // 2. Find the reasoning effort section across English and Russian
      const sectionSelectors = [
        "[role='menuitem']:has-text('Уровень рассуждений')",
        "[role='menuitem']:has-text('Reasoning effort')",
        "[role='menuitem']:has-text('Reasoning level')",
        "[role='menuitem']:has-text('Thinking')",
        "[role='button']:has-text('Уровень рассуждений')",
        "[role='button']:has-text('Reasoning effort')",
        "button:has-text('Уровень рассуждений')",
      ];

      let reasoningSection = null;
      for (const sel of sectionSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          reasoningSection = loc;
          break;
        }
      }

      if (!reasoningSection) {
        await page.keyboard.press("Escape").catch(() => {});
        return "Default";
      }

      // 3. Hover and click to expand the reasoning options
      await reasoningSection.hover().catch(() => {});
      await reasoningSection.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);

      // 4. Locate High / Deep options across English and Russian
      const highSelectors = [
        "[role='menuitemradio']:has-text('Высокий')",
        "[role='menuitemradio']:has-text('High')",
        "[role='menuitemradio']:has-text('Глубокий')",
        "[role='menuitem']:has-text('Высокий')",
        "[role='menuitem']:has-text('Глубокий')",
        "[role='menuitem']:has-text('Высокая')",
        "[role='menuitem']:has-text('High')",
        "[role='menuitem']:has-text('Deep')",
        "mat-radio-button:has-text('Высокий')",
        "mat-radio-button:has-text('High')",
        "[role='option']:has-text('Высокий')",
        "[role='option']:has-text('High')",
      ];

      let targetItem = null;
      for (const sel of highSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          targetItem = loc;
          break;
        }
      }

      if (targetItem) {
        // Read if already selected
        const isAlreadyChecked = await targetItem.evaluate((el: Element) => {
          return (
            el.getAttribute("aria-checked") === "true" ||
            el.getAttribute("aria-selected") === "true" ||
            el.classList.contains("mat-mdc-radio-checked") ||
            el.classList.contains("mat-radio-checked") ||
            !!el.querySelector("mat-icon:has-text('check'), [class*='check'], [data-state='checked']")
          );
        }).catch(() => false);

        if (!isAlreadyChecked) {
          await targetItem.click({ force: true }).catch(() => {});
          await page.waitForTimeout(350);
        }

        // Close menu cleanly
        await page.keyboard.press("Escape").catch(() => {});
        return "Высокий (Глубокий)";
      }

      await page.keyboard.press("Escape").catch(() => {});
      return "Default";
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      return "Default";
    }
  }

  public static async consult(
    page: Page,
    prompt: string,
    options: GeminiConsultOptions = {},
  ): Promise<GeminiConsultResult> {
    const timeoutMs = (options.timeoutSeconds ?? 360) * 1000;
    const requestedModel = options.model ?? "4 Argon";
    const requestedReasoning = options.reasoning ?? "Высокая";

    let targetUrl: string | null = null;
    const currentUrl = page.url();

    if (options.newChat) {
      targetUrl = "https://gemini.google.com/app";
      await ChatStore.clearLastChat("gemini");
    } else {
      if (currentUrl.includes("gemini.google.com/app/")) {
        targetUrl = currentUrl;
      } else {
        const last = await ChatStore.getLastChat("gemini");
        if (last && last.chatUrl && last.chatUrl.includes("gemini.google.com/app/")) {
          targetUrl = last.chatUrl;
        } else {
          targetUrl = "https://gemini.google.com/app";
        }
      }
    }

    await this.ensureGeminiReady(page, targetUrl, !!options.newChat);

    if (options.newChat) {
      const newChatBtn = page
        .locator("button:has-text('Новый чат'), [aria-label*='Новый чат'], a:has-text('Новый чат'), button:has-text('New chat')")
        .first();
      if ((await newChatBtn.count()) > 0) {
        await newChatBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    // 0. Strict Login Check (Tri-State with Hydration Barrier)
    let auth = await this.detectAuth(page, { timeoutMs: 15000 });
    if (auth === "unknown") {
      // Retry once after quick settle
      await page.waitForTimeout(1500);
      auth = await this.detectAuth(page, { timeoutMs: 6000 });
    }

    if (auth === "out") {
      return {
        text: "",
        modelUsed: "none",
        reasoningUsed: "none",
        success: false,
        error:
          `🛑 [Google Gemini tizimdan chiqib ketgan (Logout)]:\n\n` +
          `Google hisobingizdan chiqib ketganligi sababli '${requestedModel}' bilan bog'lanib bo'lmadi.\n` +
          `Tizimga kirmagan holatda Gemini faqat oddiy Flash-Lite modelida ishlaydi.\n\n` +
          `Iltimos, terminalda quyidagi buyruqni bering:\n` +
          `  /ai-consult login gemini\n` +
          `va ochilgan brauzer oynasida Google hisobingizga kiring!`,
      };
    }

    // Wait up to 10s for page hydration (editor or model button)
    const hydStart = Date.now();
    while (Date.now() - hydStart < 10000) {
      const ready = await page.evaluate(() => {
        return !!document.querySelector(
          "rich-textarea, div[contenteditable='true'], textarea, [data-placeholder], button",
        );
      });
      if (ready) break;
      await page.waitForTimeout(500);
    }

    // Set model and reasoning level
    const modelRes = await this.setModelAndReasoning(
      page,
      requestedModel,
      requestedReasoning,
    );

    if (modelRes.error) {
      const currentTitle = await page.title().catch(() => "");
      return {
        text: "",
        modelUsed: modelRes.modelUsed,
        reasoningUsed: requestedReasoning,
        success: false,
        error: `🛑 [Gemini Model Xatosi]: ${modelRes.error} (Sahifa: ${page.url()} | '${currentTitle}')`,
      };
    }
    const modelUsed = modelRes.modelUsed;
    const reasoningUsed = modelRes.reasoningUsed;

    // Ensure no lingering Angular CDK overlays or Google promo banners block the editor
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => {
      const backdrops = Array.from(document.querySelectorAll<HTMLElement>(".cdk-overlay-backdrop"));
      for (const b of backdrops) {
        b.style.setProperty("pointer-events", "none", "important");
      }
    });
    await page.waitForTimeout(300);

    // Locate editor
    // Wait up to 15s for any in-flight stream/stop button to settle before sending
    const idleWaitStart = Date.now();
    while (Date.now() - idleWaitStart < 15000) {
      const isBusy = await page.evaluate(() => {
        return !!document.querySelector(
          "button[aria-label*='Остановить'], button[aria-label*='Stop'], mat-progress-spinner, [class*='thinking']"
        );
      });
      if (!isBusy) break;
      await page.waitForTimeout(500);
    }

    const editorSelectors = [
      "rich-textarea div[contenteditable='true']",
      "div.ql-editor[role='textbox']",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
      "textarea",
    ];

    let editor = null;
    const editorWaitStart = Date.now();
    while (Date.now() - editorWaitStart < 15000) {
      for (const sel of editorSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          editor = loc;
          break;
        }
      }
      if (editor) break;
      await page.waitForTimeout(500);
    }

    if (!editor) {
      return {
        text: "",
        modelUsed,
        reasoningUsed,
        success: false,
        error: "🛑 [Gemini Xatosi]: Xabar yozish maydoni (prompt editor) topilmadi.",
      };
    }

    // 3.5 Attach Images if provided
    const imgs = options.images ?? [];
    let imageSession: ImageAttachSession | undefined;
    if (imgs.length > 0) {
      try {
        imageSession = new ImageAttachSession(page, "gemini", editor, imgs);
        await imageSession.attach();
      } catch (attachErr: any) {
        await imageSession?.abort().catch(() => {});
        return {
          text: "",
          modelUsed,
          reasoningUsed,
          success: false,
          error: `🛑 [Rasm yuklashda xatolik]: Gemini ga rasm biriktirish amalga oshmadi: ${attachErr.message}`,
        };
      }
    }

    await editor.click({ force: true });
    await page.waitForTimeout(200);

    // Clear any residual drafts in editor
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    // Type prompt via native keyboard insertText (bypasses TrustedHTML restriction)
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(800);

    // Settlement barrier: ensure images finish uploading and send button becomes active
    if (imageSession) {
      try {
        await imageSession.settle(true);
      } catch (settleErr: any) {
        await imageSession.abort().catch(() => {});
        return {
          text: "",
          modelUsed,
          reasoningUsed,
          success: false,
          error: `🛑 [Rasm yuklanishi tugamadi]: Gemini rasmni to'liq yuklab bo'lmadi: ${settleErr.message}`,
        };
      }
    }

    // Click send
    const sendBtn = page
      .locator("button[aria-label*='Отправить'], button[aria-label*='Send'], button.send-button, [data-test-id*='send']")
      .first();

    if ((await sendBtn.count()) > 0 && (await sendBtn.isVisible())) {
      await sendBtn.click({ force: true });
    } else {
      await editor.focus();
      await page.keyboard.press("Enter");
    }

    await page.waitForTimeout(1000);

    if (imageSession) {
      await imageSession.verifySent().catch(() => {});
      imageSession.dispose();
    }

    // Immediate Write-Ahead URL Capture: As soon as URL transitions to /app/<id>, save immediately!
    for (let i = 0; i < 20; i++) {
      const u = page.url();
      if (u.includes("gemini.google.com/app/") && !u.endsWith("/app")) {
        await ChatStore.saveLastChat("gemini", { chatUrl: u, lastPrompt: prompt });
        break;
      }
      await page.waitForTimeout(250);
    }

    // Wait for generation
    const startTime = Date.now();
    let deadline = startTime + timeoutMs;
    let lastGrowth = Date.now();
    let lastLen = 0;
    let lastText = "";
    let stableCount = 0;

    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);

      const isGenerating = await page.evaluate(() => {
        const stopBtn = document.querySelector(
          "button[aria-label*='Остановить'], button[aria-label*='Stop'], button mat-icon[fonticon*='stop' i]",
        );
        const isStopVisible = !!stopBtn && (stopBtn as HTMLElement).offsetParent !== null;

        const spinners = Array.from(
          document.querySelectorAll("mat-progress-spinner, [class*='thinking'], [class*='progress-spinner']"),
        );
        const isSpinnerVisible = spinners.some(
          (s) => (s as HTMLElement).offsetParent !== null && !s.closest(".loading-content-spinner-container"),
        );

        return isStopVisible || isSpinnerVisible;
      });

      const currentText = await page.evaluate(() => {
        const msgs = document.querySelectorAll(
          "message-content, .model-response-text, model-response",
        );
        if (msgs.length === 0) return "";
        const last = msgs[msgs.length - 1];

        // Clone and strip any <model-thoughts> or reasoning accordions
        const clone = last.cloneNode(true) as HTMLElement;
        const thoughts = clone.querySelectorAll("model-thoughts, [class*='thoughts'], mat-expansion-panel");
        for (const t of thoughts) {
          t.remove();
        }

        // Clean code blocks: strip copy button decorations, ensure markdown backticks and verbatim indent
        clone.querySelectorAll('button, [role="button"], mat-icon, [class*="decoration"], .code-block-decoration').forEach((n) => n.remove());
        clone.querySelectorAll("code-block, pre").forEach((cb) => {
          const codeEl = cb.querySelector("code") || cb;
          let lang = "";
          const langMatch = (codeEl.className || cb.className || "").match(/(?:language|lang)-([^\s]+)/i);
          if (langMatch) lang = langMatch[1].toLowerCase();
          const codeText = (codeEl.textContent || "").trimEnd();
          const rep = document.createElement("div");
          rep.textContent = `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
          cb.replaceWith(rep);
        });

        let base = (clone.innerText || clone.textContent || "").trim();

        // Check for dedicated code viewer/panels in Gemini
        const codeView = document.querySelector('code-viewer, div.code-container, [class*="code-block"]');
        const codeText = ((codeView as HTMLElement)?.innerText || (codeView as HTMLElement)?.textContent || "").trim();
        if (
          codeView &&
          codeText.length > 50 &&
          !base.includes(codeText.slice(0, 50))
        ) {
          base += `\n\n---\n### 📦 Gemini Code File:\n\`\`\`\n${codeText}\n\`\`\``;
        }

        // Check for generated images in Gemini (Imagen / Visual cards)
        try {
          const genImgs = Array.from(last.querySelectorAll("img"));
          const imgItems: string[] = [];
          for (const img of genImgs) {
            if (img.closest("nav, [class*='avatar' i]")) continue;
            const src = img.currentSrc || img.src;
            const alt = img.getAttribute("alt") || "Gemini Generated Visual";
            if (src && (img.width > 50 || img.height > 50 || !img.width)) {
              imgItems.push(`- 🖼️ ![${alt}](${src})`);
            }
          }
          if (imgItems.length > 0) {
            base += `\n\n---\n### 🎨 Gemini Visual Artifacts:\n${imgItems.join("\n")}`;
          }
        } catch {}

        return base;
      });

      // Adaptive streaming budget: as long as new text is arriving, extend deadline up to 15m max
      if (currentText.length > lastLen) {
        lastLen = currentText.length;
        lastGrowth = Date.now();
        if (deadline - Date.now() < 60000) {
          deadline = Math.min(deadline + 60000, startTime + 900000);
        }
      }

      if (currentText && currentText === lastText && !isGenerating && currentText.length > 10) {
        stableCount++;
        if (stableCount >= 3) {
          ChatStore.saveLastChat("gemini", { chatUrl: page.url(), lastPrompt: prompt });
          return {
            text: currentText,
            modelUsed,
            reasoningUsed,
            success: true,
          };
        }
      } else {
        stableCount = 0;
        lastText = currentText;
      }
    }

    // If deadline elapsed while still generating:
    return {
      text: lastText,
      modelUsed,
      reasoningUsed,
      success: false,
      error:
        `🛑 [Gemini javobi to'liq yakunlanmadi]: Belgilangan vaqt ichida Gemini javob berishni tugatmadi (matn hali yozilmoqda yoki o'ylanmoqda edi).\n` +
        `DIQQAT: Ushbu chala matnni yakuniy yechim deb qabul qilmang! Davom ettirish uchun shu asbobni 'newChat: false' bilan qayta chaqiring.`,
    };
  }
}
