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
    if (url.includes("accounts.google.com")) return false;

    return await page.evaluate(() => {
      // 1. Look for explicit Sign In buttons or links
      const hasSignIn = Array.from(document.querySelectorAll("a, button, span")).some((el) => {
        const text = (el.textContent || "").trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        return (
          text === "sign in" ||
          text === "войти" ||
          text === "kirish" ||
          aria.includes("sign in") ||
          aria.includes("войти")
        );
      });
      if (hasSignIn) return false;

      // 2. Look for Google Account profile avatar or SignOut links
      const hasAccountAvatar = !!document.querySelector(
        'a[href*="SignOutOptions"], [aria-label*="Google Account" i], [aria-label*="Аккаунт Google" i], img[src*="googleusercontent.com"]'
      );
      return hasAccountAvatar;
    });
  }

  public static async setModelAndReasoning(
    page: Page,
    modelName = "4 Argon",
    reasoning = "Высокая",
  ): Promise<{ modelUsed: string; reasoningUsed: string; error?: string }> {
    try {
      const modeBtn = page.locator("[data-test-id='bard-mode-menu-button']").first();
      if ((await modeBtn.count()) === 0) {
        return { modelUsed: "unknown", reasoningUsed: reasoning, error: "Model tanlash menyusi topilmadi." };
      }

      // Check current model
      let currentLabel = (await modeBtn.getAttribute("aria-label")) || (await modeBtn.innerText());
      if (currentLabel.includes(modelName)) {
        return { modelUsed: modelName, reasoningUsed: reasoning };
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
        return {
          modelUsed: currentLabel.trim(),
          reasoningUsed: reasoning,
          error: `Modelni '${modelName}' ga o'tkazib bo'lmadi (Hozirgi model: '${currentLabel.trim()}'). Google hisobingizda Gemini Advanced/Argon faolligini tekshiring!`,
        };
      }

      // If reasoning level is requested and model is 4 Argon, set reasoning
      if (modelName.includes("Argon")) {
        await modeBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(400);

        const reasoningMenu = page
          .locator("[role='menuitem']:has-text('Уровень рассуждений')")
          .first();

        if ((await reasoningMenu.count()) > 0) {
          await reasoningMenu.hover().catch(() => {});
          await page.waitForTimeout(400);

          const levelItem = page
            .locator(`[role='menuitem']:has-text('${reasoning}'), button:has-text('${reasoning}')`)
            .first();

          if ((await levelItem.count()) > 0) {
            await levelItem.click({ force: true }).catch(() => {});
            await page.waitForTimeout(400);
          }
        }
        // Close menu if still open
        await page.keyboard.press("Escape").catch(() => {});
      }

      return { modelUsed: modelName, reasoningUsed: reasoning };
    } catch (err: any) {
      return { modelUsed: "unknown", reasoningUsed: reasoning, error: err?.message || String(err) };
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
      ChatStore.clearLastChat("gemini");
    } else {
      if (currentUrl.includes("gemini.google.com/app/")) {
        targetUrl = currentUrl;
      } else {
        const last = ChatStore.getLastChat("gemini");
        if (last && last.chatUrl && last.chatUrl.includes("gemini.google.com/app/")) {
          targetUrl = last.chatUrl;
        } else {
          targetUrl = "https://gemini.google.com/app";
        }
      }
    }

    if (!page.url().includes("gemini.google.com") || (targetUrl && page.url() !== targetUrl && !page.url().includes(targetUrl))) {
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

    // Set model and reasoning level
    const modelRes = await this.setModelAndReasoning(
      page,
      requestedModel,
      requestedReasoning,
    );

    if (modelRes.error) {
      return {
        text: "",
        modelUsed: modelRes.modelUsed,
        reasoningUsed: requestedReasoning,
        success: false,
        error: `🛑 [Gemini Model Xatosi]: ${modelRes.error}`,
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

    const editor = page.locator("div.ql-editor[role='textbox']").first();
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await editor.click({ force: true });
    await page.waitForTimeout(200);

    // Clear any residual drafts in Quill editor
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    // Type prompt via native keyboard insertText (bypasses TrustedHTML restriction)
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(800);

    // Click send
    const sendBtn = page
      .locator("button[aria-label*='Отправить'], button[aria-label*='Send']")
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
        const stopBtn = !!document.querySelector(
          "button[aria-label*='Остановить'], button[aria-label*='Stop'], button mat-icon[fonticon*='stop' i]",
        );
        const hasSpinner = !!document.querySelector(
          "mat-progress-spinner, [class*='thinking'], [class*='progress-spinner']",
        );
        return stopBtn || hasSpinner;
      });

      const currentText = await page.evaluate(() => {
        const msgs = document.querySelectorAll(
          "message-content, .model-response-text, model-response",
        );
        if (msgs.length === 0) return "";
        const last = msgs[msgs.length - 1];
        let base = (last as HTMLElement).innerText.trim();

        // Check for dedicated code viewer/panels in Gemini
        const codeView = document.querySelector('code-viewer, div.code-container, [class*="code-block"]');
        if (
          codeView &&
          (codeView as HTMLElement).innerText.length > 50 &&
          !base.includes((codeView as HTMLElement).innerText.slice(0, 50))
        ) {
          base += `\n\n---\n### 📦 Gemini Code File:\n\`\`\`\n${(codeView as HTMLElement).innerText.trim()}\n\`\`\``;
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
