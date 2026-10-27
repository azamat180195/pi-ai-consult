import type { Page } from "playwright-core";
import { ChatStore } from "./chat-store.js";

export interface GeminiConsultOptions {
  model?: string; // '4 Argon', '3.1 Pro', '3.8 Flash', '3.5 Flash-Lite'
  reasoning?: string; // 'Высокая', 'Средний', 'Низкая'
  newChat?: boolean;
  timeoutSeconds?: number;
}

export interface GeminiConsultResult {
  text: string;
  modelUsed?: string;
  reasoningUsed?: string;
  success: boolean;
  error?: string;
}

export class GeminiProvider {
  public static async isLogged(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("accounts.google.com") && !url.includes("RotateCookiesPage")) return false;

    return await page.evaluate(() => {
      if (!document.body) return false;
      const bodyText = document.body.innerText || document.body.textContent || "";

      // 1. Positive proof: has user profile / Pro badge / sidebar chat history / Argon button
      const hasPro = !!bodyText.match(/\b(Pro|Advanced)\b/i);
      const hasRecentChats = document.querySelectorAll('a[href*="/app/"]').length > 1;
      const hasArgonBtn = Array.from(document.querySelectorAll('button, [role="button"]')).some((b) => {
        const t = (b.textContent || "").trim();
        return t === "Argon" || t.includes("Argon") || t.includes("4 Argon");
      });
      const hasAvatar = !!document.querySelector(
        'a[href*="SignOutOptions"], [aria-label*="Google Account" i], [aria-label*="Аккаунт Google" i], [data-testid*="user"], img[src*="googleusercontent.com"]',
      );

      if (hasArgonBtn || hasRecentChats || hasPro || hasAvatar) {
        return true;
      }

      // 2. Fallback check: is there a prominent visible "Sign in" button in the top-right header?
      const headerBtns = Array.from(
        document.querySelectorAll(
          'header a, header button, [role="banner"] a, [role="banner"] button, div.top-bar a, div.top-bar button',
        ),
      );
      const hasVisibleSignIn = headerBtns.some((el) => {
        const text = (el.textContent || "").trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const isSignInText =
          text === "sign in" || text === "войти" || text === "kirish" || aria.includes("sign in") || aria.includes("войти");
        return isSignInText && (el as HTMLElement).offsetParent !== null;
      });

      return !hasVisibleSignIn;
    });
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

    if (!page.url().startsWith("https://gemini.google.com") || (targetUrl && page.url() !== targetUrl && !page.url().includes(targetUrl))) {
      await page.goto(targetUrl || "https://gemini.google.com/app", {
        waitUntil: "commit",
        timeout: 45000,
      });
      // Progressive wait for Quill editor readiness on slow network
      const editorWaitStart = Date.now();
      while (Date.now() - editorWaitStart < 45000) {
        if (await page.locator("div.ql-editor[role='textbox']").first().isVisible().catch(() => false)) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1500);
    }

    if (options.newChat) {
      const newChatBtn = page
        .locator("button:has-text('Новый чат'), [aria-label*='Новый чат'], a:has-text('Новый чат')")
        .first();
      if ((await newChatBtn.count()) > 0) {
        await newChatBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    // 0. Strict Login Check - NEVER consult when logged out!
    const loggedIn = await this.isLogged(page);
    if (!loggedIn) {
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

    await editor.click({ force: true });
    await page.waitForTimeout(200);

    // Clear any residual drafts in editor
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    // Type prompt via native keyboard insertText (bypasses TrustedHTML restriction)
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(800);

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
