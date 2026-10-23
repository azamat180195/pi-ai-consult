import type { Page } from "playwright-core";
import { ChatStore } from "./chat-store.js";

export interface ConsultResult {
  success: boolean;
  text: string;
  chatUrl?: string;
  error?: string;
  needsLogin?: boolean;
  modelUnavailable?: boolean;
  rateLimitHit?: boolean;
  resetTime?: string;
  directive?: "STOP_AND_ASK_USER";
  modelUsed?: string;
  notice?: string;
}

export class ClaudeProvider {
  public static parseResetAt(raw: string, now = new Date()): { until: number; approx: boolean; resetLabel: string } {
    const h = /(\d+)\s*(?:hours?|hrs?|h)\b/i.exec(raw)?.[1];
    const m = /(\d+)\s*(?:minutes?|mins?)\b/i.exec(raw)?.[1];
    if (/\bin\b/i.test(raw) && (h || m)) {
      const until = now.getTime() + (+(h ?? 0) * 60 + +(m ?? 0)) * 60_000;
      const d = new Date(until);
      const resetLabel = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return { until, approx: false, resetLabel };
    }

    const t = /\b(?:at|until|resets?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(raw);
    if (t) {
      let hh = +t[1];
      const mm = +(t[2] ?? 0);
      const ap = t[3]?.toLowerCase();
      if (ap === "pm" && hh < 12) hh += 12;
      if (ap === "am" && hh === 12) hh = 0;
      const d = new Date(now);
      d.setHours(hh, mm, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      const resetLabel = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      return { until: d.getTime(), approx: false, resetLabel };
    }

    const fallbackUntil = now.getTime() + 5 * 3600_000;
    const d = new Date(fallbackUntil);
    const resetLabel = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return { until: fallbackUntil, approx: true, resetLabel };
  }
  public static async isLoginPage(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("/login")) return true;

    try {
      const emailInput = await page.locator('input#email, input[type="email"]').count();
      if (emailInput > 0) return true;

      const signInBtn = await page.locator('button:has-text("Sign in"), button:has-text("Log in")').count();
      if (signInBtn > 0 && !url.includes("/chat/")) return true;
    } catch {}

    return false;
  }

  public static async checkLogin(page: Page): Promise<{ loggedIn: boolean; currentUrl: string }> {
    if (!page.url().includes("claude.ai")) {
      await page.goto("https://claude.ai/new", { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2000);
    }

    const isLogin = await this.isLoginPage(page);
    return {
      loggedIn: !isLogin,
      currentUrl: page.url(),
    };
  }

  public static async setModel(
    page: Page,
    targetModel?: string,
  ): Promise<{
    success: boolean;
    modelUnavailable?: boolean;
    error?: string;
    actualModel: string;
  }> {
    const modelBtn = page.locator('[data-testid="model-selector-dropdown"]').first();
    if ((await modelBtn.count()) === 0) {
      return { success: true, actualModel: "default" };
    }

    const currentText = (await modelBtn.innerText()).trim();
    if (!targetModel) {
      return { success: true, actualModel: currentText };
    }

    const normalizedTarget = targetModel.trim().toLowerCase();
    if (currentText.toLowerCase().includes(normalizedTarget)) {
      return { success: true, actualModel: currentText };
    }

    try {
      await modelBtn.click();
      await page.waitForTimeout(600);

      const menuItems = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'));
        return items.map((el) => ({
          text: el.innerText.trim(),
          role: el.getAttribute("role"),
          isRadio: el.getAttribute("role") === "menuitemradio",
          isUpgrade:
            el.innerText.includes("Upgrade") ||
            el.innerText.includes("Pro or Max") ||
            el.innerText.includes("Pro\n"),
        }));
      });

      const match = menuItems.find((m) => m.text.toLowerCase().includes(normalizedTarget));

      if (match) {
        if (match.isUpgrade || !match.isRadio) {
          // Model requires paid upgrade (Pro/Max)! DO NOT proceed silently. Stop and notify.
          await page.keyboard.press("Escape");
          return {
            success: false,
            modelUnavailable: true,
            error:
              `⚠️ [Model mavjud emas]: Siz so'ragan '${targetModel}' modeli profilingizda mavjud emas (Pro/Max pullik obuna talab qilinadi).\n\n` +
              `Sizning hisobingizda mavjud modellar:\n` +
              `- Sonnet 5.5 (Effort: Low, Medium, High, Extra, Max)\n` +
              `- Haiku 5.5\n\n` +
              `Iltimos, mavjud modellardan birini tanlang yoki "Sonnet orqali davom et" deb ko'rsatma bering.`,
            actualModel: currentText,
          };
        } else {
          // Model is available and selectable
          const radioLocator = page
            .locator('[role="menuitemradio"]')
            .filter({ hasText: new RegExp(targetModel, "i") })
            .first();

          if ((await radioLocator.count()) > 0) {
            await radioLocator.click();
            await page.waitForTimeout(600);
          }
        }
      } else {
        await page.keyboard.press("Escape");
        return {
          success: false,
          modelUnavailable: true,
          error:
            `⚠️ [Model topilmadi]: '${targetModel}' nomli model Claude menyusida topilmadi.\n\n` +
            `Sizning hisobingizdagi mavjud modellar:\n` +
            `- Sonnet 5.5\n` +
            `- Haiku 5.5`,
          actualModel: currentText,
        };
      }

      await page.keyboard.press("Escape");
      const newText = (await modelBtn.innerText()).trim();
      return { success: true, actualModel: newText };
    } catch (err: unknown) {
      console.warn("[ai-consult] setModel warning:", err);
      try {
        await page.keyboard.press("Escape");
      } catch {}
      return { success: false, actualModel: currentText, error: String(err) };
    }
  }

  public static async detectLimit(
    page: Page,
  ): Promise<{ isLimit: boolean; resetTime?: string; rawMessage?: string }> {
    try {
      const pageInfo = await page.evaluate(() => {
        // 1. Modal dialogs and portal root
        const dialogEls = Array.from(
          document.querySelectorAll('div[role="dialog"], #portal-root, [class*="modal"]')
        );
        const dialogTexts = dialogEls.map((d) => (d as HTMLElement).innerText).filter(Boolean);

        // 2. Alert and error elements
        const errorEls = Array.from(
          document.querySelectorAll(
            '[data-testid*="error"], [role="alert"], .text-danger, .font-danger, div[class*="banner"], div[class*="warning"]',
          ),
        );
        const errorTexts = errorEls.map((e) => (e as HTMLElement).innerText).filter(Boolean);

        // 3. Composer warning banner (excluding the contenteditable input itself!)
        const composerAlert =
          (document.querySelector('form [role="alert"], fieldset [role="alert"], [data-testid*="limit"], [data-testid*="error"]') as HTMLElement)
            ?.innerText || "";

        return {
          dialogTexts,
          errorTexts,
          composerText: composerAlert,
        };
      });

      const combinedText = [
        ...pageInfo.dialogTexts,
        ...pageInfo.errorTexts,
        pageInfo.composerText,
      ].join("\n");

      const patterns = [
        /hit\s+your\s+(?:\d+-hour\s+)?message\s+limit/i,
        /5-hour\s+message\s+limit/i,
        /upgrade\s+to\s+keep\s+chatting/i,
        /resets\s+at\s+([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i,
        /reached\s+your\s+(?:messaging\s+|message\s+|free\s+usage\s+)?limit\s*(?:until|at)?\s*([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i,
        /out\s+of\s+(?:free\s+)?messages\s*(?:until|at)?\s*([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i,
        /try\s+again\s+(?:after|at)\s*([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i,
        /limit\s+resets?\s+(?:at|in)\s*([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i,
        /reached\s+your\s+(?:messaging|message)\s+limit/i,
        /you\s+are\s+out\s+of\s+messages/i,
        /free\s+tier\s+message\s+limit\s+reached/i,
      ];

      let isLimit = false;
      let rawMessage = "";
      let resetTime: string | undefined;

      for (const p of patterns) {
        const match = combinedText.match(p);
        if (match) {
          isLimit = true;
          rawMessage = rawMessage || match[0];
          if (match[1] && !resetTime) {
            resetTime = match[1].trim();
          }
        }
      }

      // Explicitly check for 'resets at <time>'
      if (isLimit && !resetTime) {
        const timeMatch = combinedText.match(/resets\s+at\s+([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i);
        if (timeMatch && timeMatch[1]) {
          resetTime = timeMatch[1].trim();
        }
      }

      if (isLimit) {
        // Dismiss the limit modal so it doesn't block the screen
        try {
          const dismissBtn = page.locator('button:has-text("Not now"), button[aria-label="Close"], button:has-text("Close")').first();
          if ((await dismissBtn.count()) > 0 && (await dismissBtn.isVisible())) {
            await dismissBtn.click();
          }
        } catch {}

        return {
          isLimit: true,
          resetTime,
          rawMessage,
        };
      }
    } catch {}

    return { isLimit: false };
  }

  public static async setEffort(page: Page, targetEffort: string = "High"): Promise<void> {
    try {
      const modelBtn = page.locator('[data-testid="model-selector-dropdown"]').first();
      if ((await modelBtn.count()) === 0) return;

      const currentText = await modelBtn.innerText();
      const normalizedTarget = (targetEffort || "High").trim().toLowerCase();

      // Check if current text already includes target effort
      const words = currentText.toLowerCase().split(/\s+/);
      if (words.includes(normalizedTarget)) {
        return;
      }

      // Open model menu
      await modelBtn.click();
      await page.waitForTimeout(600);

      const effortItem = page.locator('[role="menuitem"]:has-text("Effort")').first();
      if ((await effortItem.count()) > 0) {
        await effortItem.hover();
        await page.waitForTimeout(600);

        // Find effort radio item starting with target name (Low, Medium, High, Extra, Max)
        const radio = page
          .locator('[role="menuitemradio"]')
          .filter({ hasText: new RegExp("^" + targetEffort, "i") })
          .first();

        if ((await radio.count()) > 0) {
          await radio.click();
          await page.waitForTimeout(600);
        }
      }
      await page.keyboard.press("Escape");
    } catch (err: unknown) {
      console.warn("[ai-consult] setEffort warning:", err);
    }
  }

  private static async readTurn(
    page: Page,
    nonce: string,
    prompt: string,
  ): Promise<{ found: boolean; answered: boolean; streaming: boolean; text: string }> {
    return page.evaluate(
      ({ tag, pSub }) => {
        const userMsgs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="user-message"]'));
        const assistantMsgs = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="assistant-message"], .font-claude-response'),
        );

        if (userMsgs.length === 0) return { found: false, answered: false, streaming: false, text: "" };

        let matchedUserIndex = -1;
        if (tag) {
          matchedUserIndex = userMsgs.findLastIndex((u) => (u.innerText || u.textContent || "").includes(tag));
        }

        if (matchedUserIndex === -1 && pSub) {
          matchedUserIndex = userMsgs.findLastIndex((u) => {
            const t = (u.innerText || u.textContent || "").trim();
            return t.includes(pSub) || pSub.includes(t.slice(0, 50));
          });
        }

        if (matchedUserIndex === -1) return { found: false, answered: false, streaming: false, text: "" };

        const userEl = userMsgs[matchedUserIndex];
        const nextUserEl = userMsgs[matchedUserIndex + 1];

        const matchedAssistant = assistantMsgs.find((a) => {
          const followsUser = !!(userEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
          const precedesNextUser = !nextUserEl || !!(nextUserEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
          return followsUser && precedesNextUser;
        });

        const isStreaming = !!document.querySelector(
          '[data-is-streaming="true"], button[aria-label*="Stop" i], button[data-testid*="stop" i]',
        );

        if (matchedAssistant) {
          const text = (matchedAssistant as HTMLElement).innerText.trim();
          return {
            found: true,
            answered: text.length > 50,
            streaming: isStreaming,
            text,
          };
        }

        return { found: true, answered: false, streaming: isStreaming, text: "" };
      },
      { tag: `[ref ${nonce}]`, pSub: prompt.trim().slice(0, 50) },
    );
  }

  public static async consult(
    page: Page,
    prompt: string,
    options: {
      newChat?: boolean;
      timeoutSeconds?: number;
      effort?: "Low" | "Medium" | "High" | "Extra" | "Max" | string;
      model?: string;
    } = {},
  ): Promise<ConsultResult> {
    const timeoutMs = (options.timeoutSeconds ?? 360) * 1000;
    let currentModelName = options.model || "Sonnet";

    // 0. Pre-flight check: Is Claude currently rate-limited?
    const activeLimit = await ChatStore.activeLimit("claude");
    if (activeLimit) {
      return {
        success: false,
        text: "",
        rateLimitHit: true,
        resetTime: activeLimit.resetLabel,
        directive: "STOP_AND_ASK_USER",
        error:
          `🛑 [Claude limiti tugagan] (qayta tiklanish: ${activeLimit.resetLabel}).\n\n` +
          `STOP. Hech qanday boshqa tool chaqirmang. Foydalanuvchiga aynan ushbu xabarni bering va uning qarorini kuting:\n\n` +
          `"Claude limiti tugabdi (qayta tiklanish: ${activeLimit.resetLabel}). Loyiha asosida o'zim mustaqil davom ettiraymi yoki o'zim qilib beraymi?"\n\n` +
          `Variantlar:\n` +
          `1) O'zim mustaqil qilib beray (lokal model bilan, Claude'siz)\n` +
          `2) ChatGPT bilan maslahatlashish (ChatGPT Think orqali davom ettirish)\n` +
          `3) Kutaman (${activeLimit.resetLabel} gacha)`,
      };
    }

    // 1. Begin Intent (reusing existing nonce if same prompt was asked within 30m TTL)
    const { intent, resumed, hints } = await ChatStore.beginIntent(
      "claude",
      prompt,
      process.cwd(),
      options.newChat,
    );
    const nonce = intent.nonce;
    const promptToSend = `${prompt}\n\n[ref ${nonce}]`;

    // 1.1 Reconnaissance: Check hints + top recent chats before creating a new chat or sending prompt
    if (!options.newChat) {
      const candidateUrls: string[] = [];
      if (page.url().includes("claude.ai/chat/")) candidateUrls.push(page.url());
      candidateUrls.push(...hints);

      // Add top N unpinned recent chats from sidebar (strictly excluding pinned chats container)
      try {
        const sidebarUrls = await page.evaluate((maxCount: number) => {
          const root = document.querySelector('nav') ?? document;
          const seen = new Set<string>();
          const out: string[] = [];

          for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/chat/"]'))) {
            // Exclude pinned chats container
            if (a.closest('[data-testid*="pinned" i], [class*="pinned" i]')) {
              continue;
            }

            const path = a.href.split("?")[0];
            const m = /^https:\/\/claude\.ai\/chat\/[0-9a-f-]{36}$/i.exec(path);
            if (!m || seen.has(m[0])) continue;
            seen.add(m[0]);

            out.push(m[0]);
            if (out.length >= maxCount) break;
          }

          return out;
        }, 5);

        candidateUrls.push(...sidebarUrls);
      } catch {}

      const uniqueUrls = [...new Set(candidateUrls)];

      for (const u of uniqueUrls) {
        if (!u || !u.includes("claude.ai/chat/")) continue;
        if (page.url() !== u) {
          try {
            await page.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 });
            await page.waitForTimeout(1500);
          } catch {
            continue;
          }
        }

        const turn = await this.readTurn(page, nonce, prompt);
        if (turn.found) {
          if (turn.answered && turn.text) {
            const cleanedText = this.cleanExtractedText(turn.text);
            await ChatStore.saveLastChat("claude", { chatUrl: u, lastPrompt: prompt, nonce });
            return {
              success: true,
              text: cleanedText,
              chatUrl: u,
              modelUsed: currentModelName,
            };
          }
        }
      }
    }

    // 1.2 Navigation for new send
    let targetUrl = options.newChat ? "https://claude.ai/new" : (hints[0] || "https://claude.ai/new");
    if (options.newChat) {
      await ChatStore.clearLastChat("claude");
    }

    if (!page.url().includes("claude.ai") || (targetUrl && page.url() !== targetUrl && !page.url().includes(targetUrl))) {
      await page.goto(targetUrl, {
        waitUntil: "commit",
        timeout: 45000,
      });
      // Progressive wait for composer readiness on slow network
      const composerWaitStart = Date.now();
      const quickSel = 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"], div[role="textbox"]';
      while (Date.now() - composerWaitStart < 45000) {
        if (await page.locator(quickSel).first().isVisible().catch(() => false)) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1500);
    }

    // 2. Login Check
    if (await this.isLoginPage(page)) {
      return {
        success: false,
        text: "",
        needsLogin: true,
        error:
          "Claude profilingizga ulanmagan. Iltimos, terminalda '/ai-consult login claude' buyrug'ini tering va brauzerda accountingizga kiring.",
      };
    }

    // 3. Handle model selection on new chats (model is fixed for ongoing conversations)
    if (options.newChat || page.url().endsWith("/new")) {
      const requestedModel = options.model || "Sonnet";
      const modelResult = await this.setModel(page, requestedModel);
      if (!modelResult.success) {
        return {
          success: false,
          text: "",
          modelUnavailable: true,
          error: modelResult.error || `Tanlangan model ('${requestedModel}') mavjud emas.`,
        };
      }
      currentModelName = modelResult.actualModel;

      // Set desired effort mode (Low, Medium, High, Extra, Max). Default is High.
      await this.setEffort(page, options.effort || "High");
    }

    // Pre-flight Rate Limit check
    const preLimit = await this.detectLimit(page);
    if (preLimit.isLimit) {
      const parsed = this.parseResetAt(preLimit.rawMessage || preLimit.resetTime || "");
      await ChatStore.setLimit("claude", {
        until: parsed.until,
        approx: parsed.approx,
        raw: preLimit.rawMessage || "",
        detectedAt: Date.now(),
        resetLabel: parsed.resetLabel,
      });

      return {
        success: false,
        text: "",
        rateLimitHit: true,
        resetTime: parsed.resetLabel,
        directive: "STOP_AND_ASK_USER",
        error:
          `🛑 [Claude limiti tugadi] (qayta tiklanish: ${parsed.resetLabel}).\n\n` +
          `STOP. Hech qanday boshqa tool chaqirmang. Foydalanuvchiga aynan ushbu xabarni bering va uning qarorini kuting:\n\n` +
          `"Claude limiti tugabdi (qayta tiklanish: ${parsed.resetLabel}). Loyiha asosida o'zim mustaqil davom ettiraymi yoki o'zim qilib beraymi?"\n\n` +
          `Variantlar:\n` +
          `1) O'zim mustaqil qilib beray (lokal model bilan, Claude'siz)\n` +
          `2) ChatGPT bilan maslahatlashish (ChatGPT Think orqali davom ettirish)\n` +
          `3) Kutaman (${parsed.resetLabel} gacha)`,
      };
    }

    // 3. Locate Input
    // Wait up to 15s for any in-flight stream/generation on the page to settle before attempting a new send
    const idleWaitStart = Date.now();
    while (Date.now() - idleWaitStart < 15000) {
      const isBusy = await page.evaluate(() => {
        const hasStop = !!document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i]');
        const isStreaming = !!document.querySelector('[data-is-streaming="true"]');
        return hasStop || isStreaming;
      });
      if (!isBusy) break;
      await page.waitForTimeout(500);
    }

    // Dismiss any blocking dialogs/nudges before interacting
    try {
      const dismissBtn = page.locator('button:has-text("Not now"), button[aria-label="Close"], button:has-text("Close"), button:has-text("Dismiss")').first();
      if ((await dismissBtn.count()) > 0 && (await dismissBtn.isVisible())) {
        await dismissBtn.click();
        await page.waitForTimeout(300);
      }
    } catch {}

    const inputSelector = [
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      'fieldset div[contenteditable="true"]',
      'div[contenteditable="true"]',
      'div[role="textbox"]',
    ].join(", ");

    let inputLocator;
    try {
      inputLocator = page.locator(inputSelector).first();
      await inputLocator.waitFor({ state: "visible", timeout: 35000 });
    } catch {
      return {
        success: false,
        text: "",
        error: "Claude xabar yozish maydoni (prompt box) topilmadi. Sahifa yuklanishida xatolik bo'lishi mumkin.",
      };
    }

    // 4. Input Prompt
    try {
      await inputLocator.click({ timeout: 4000 });
    } catch {
      // Escape any lingering overlay then force click
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      await inputLocator.click({ force: true });
    }
    await inputLocator.focus();
    await page.waitForTimeout(200);

    // Fast, reliable multiline text insertion without typing char-by-char
    await page.keyboard.insertText(promptToSend);
    await page.waitForTimeout(500);

    // 5. Submit Message
    const sendBtnSelector = [
      'button[aria-label*="Send" i]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Yuborish" i]',
    ].join(", ");

    const sendBtn = page.locator(sendBtnSelector).first();
    let sent = false;

    if (await sendBtn.count() > 0) {
      try {
        await sendBtn.waitFor({ state: "visible", timeout: 2000 });
        if (!(await sendBtn.isDisabled())) {
          await sendBtn.click();
          sent = true;
        }
      } catch {}
    }

    if (!sent) {
      await inputLocator.press("Enter");
    }

    await page.waitForTimeout(1200);

    // If Claude shows a "Use caution before running this prompt" safety prompt, dismiss/confirm it
    try {
      const confirmBtn = page
        .locator('button:has-text("Run anyway"), button:has-text("Send anyway"), button:has-text("Continue"), button:has-text("I understand")')
        .first();
      if ((await confirmBtn.count()) > 0 && (await confirmBtn.isVisible())) {
        await confirmBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    // Immediate Write-Ahead URL Capture: As soon as URL transitions to /chat/<id>, save immediately!
    for (let i = 0; i < 20; i++) {
      const u = page.url();
      if (u.includes("claude.ai/chat/")) {
        await ChatStore.patchIntent("claude", { chatUrl: u, status: "streaming" });
        await ChatStore.saveLastChat("claude", { chatUrl: u, lastPrompt: prompt, nonce });
        break;
      }
      await page.waitForTimeout(250);
    }

    // Check for rate limits or actual fatal error messages
    const errorNotice = await page.evaluate(() => {
      // Ignore non-fatal caution / disclaimer banners
      const errEl = document.querySelector('[data-testid*="error"], .text-danger, .font-danger');
      if (errEl && errEl.textContent) {
        const text = errEl.textContent.trim();
        if (!text.toLowerCase().includes("use caution") && !text.toLowerCase().includes("malicious content")) {
          return text;
        }
      }
      if (document.body.innerText.includes("You have reached your messaging limit")) {
        return "You have reached your messaging limit on Claude.";
      }
      return null;
    });

    if (errorNotice) {
      return {
        success: false,
        text: "",
        error: `Claude xatosi: ${errorNotice}`,
      };
    }

    // 6. Wait for Generation & Streaming to Complete
    // First, wait up to 15s for streaming to start
    const genStartTimeout = Date.now();
    while (Date.now() - genStartTimeout < 15000) {
      const started = await page.evaluate(() => {
        const hasStop = !!document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i]');
        const isStreaming = !!document.querySelector('[data-is-streaming="true"]');
        return hasStop || isStreaming;
      });
      if (started) break;
      await page.waitForTimeout(500);
    }

    // Now poll until isGenerating is false AND response text stabilizes
    const startTime = Date.now();
    let deadline = startTime + timeoutMs;
    let lastGrowth = Date.now();
    let lastLen = 0;
    let lastResponse = "";
    let stableChecks = 0;
    let retryAttempts = 0;
    const maxRetries = 2;

    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);

      const genStatus = await page.evaluate(() => {
        const hasStop = !!document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i]');
        const isStreaming = !!document.querySelector('[data-is-streaming="true"]');
        const lastAssistant = document.querySelector('div[data-testid="assistant-message"]:last-of-type');
        const assistantStreaming = lastAssistant ? lastAssistant.getAttribute("data-is-streaming") === "true" : false;

        // Active spinner or thinking indicator
        const hasSpinner = !!document.querySelector('[class*="animate-spin"], [data-testid*="spinner"], svg[class*="spin"], [aria-busy="true"]');
        const isThinking = !!lastAssistant && (
          lastAssistant.innerText.includes("Claude is thinking") ||
          lastAssistant.innerText.includes("running\n") ||
          lastAssistant.innerText.includes("Getting started on the request") ||
          lastAssistant.innerText.endsWith("running")
        );

        // Copy button on last assistant message (only appears when generation finished)
        const hasCopyBtn = lastAssistant ? !!lastAssistant.querySelector('button[aria-label*="Copy" i], button[data-testid*="copy"]') : false;

        return {
          isGenerating: hasStop || isStreaming || assistantStreaming || hasSpinner || isThinking,
          hasCopyBtn,
        };
      });

      const currentText = await this.extractResponse(page);

      // Adaptive streaming budget: as long as new text is arriving, extend deadline up to 10m max
      if (currentText.length > lastLen) {
        lastLen = currentText.length;
        lastGrowth = Date.now();
        if (deadline - Date.now() < 60000) {
          deadline = Math.min(deadline + 60000, startTime + 600000);
        }
      }

      // Check for stream interruption ONLY on the LAST assistant message
      const isInterrupted = await page.evaluate(() => {
        const assistantMsgs = document.querySelectorAll(
          'div[data-testid="assistant-message"], [data-message-author-role="assistant"]'
        );
        if (assistantMsgs.length === 0) return false;
        const last = assistantMsgs[assistantMsgs.length - 1] as HTMLElement;

        // If the message already has substantive content (> 150 chars), it is not a dead interruption
        if (last.innerText.trim().length > 150) {
          return false;
        }

        const parent = last.parentElement;
        const containerText = (last.innerText + " " + (parent ? parent.innerText : "")).toLowerCase();

        const hasInterruptedNotice =
          containerText.includes("claude’s response was interrupted") ||
          containerText.includes("claude's response was interrupted");

        const hasTryAgain =
          !!last.querySelector('button[aria-label*="Try again" i]') ||
          (parent
            ? Array.from(parent.querySelectorAll("button")).some((b) =>
                (b.innerText || "").toLowerCase().includes("try again")
              )
            : false);

        return hasInterruptedNotice && hasTryAgain;
      });

      if (isInterrupted) {
        if (retryAttempts < maxRetries) {
          retryAttempts++;
          const tryAgainBtn = page.locator('button:has-text("Try again"), button[aria-label*="Try again" i]').first();
          if ((await tryAgainBtn.count()) > 0 && (await tryAgainBtn.isVisible())) {
            await tryAgainBtn.click();
            await page.waitForTimeout(2500);
            stableChecks = 0;
            lastResponse = "";
            continue;
          }
        } else {
          return {
            success: false,
            text: currentText,
            error:
              "🛑 [Claude xatosi]: Claude javobi uzilib qoldi ('Claude's response was interrupted'). Tarmoq yoki Anthropic serverlaridagi uzilish tufayli javob to'liq yakunlanmadi. Iltimos, bir ozdan so'ng qayta urinib ko'ring yoki ChatGPT bilan maslahatlashing.",
          };
        }
      }

      // Check if limit hit while streaming
      const streamLimit = await this.detectLimit(page);
      if (streamLimit.isLimit) {
        const parsed = this.parseResetAt(streamLimit.rawMessage || streamLimit.resetTime || "");
        await ChatStore.setLimit("claude", {
          until: parsed.until,
          approx: parsed.approx,
          raw: streamLimit.rawMessage || "",
          detectedAt: Date.now(),
          resetLabel: parsed.resetLabel,
        });

        return {
          success: false,
          text: currentText,
          rateLimitHit: true,
          resetTime: parsed.resetLabel,
          directive: "STOP_AND_ASK_USER",
          error:
            `🛑 [Xabar yozilayotgan paytda Claude limiti tugab qoldi] (qayta tiklanish: ${parsed.resetLabel}).\n\n` +
            (currentText ? `Shu paytgacha yozilgan qismi:\n"""\n${currentText}\n"""\n\n` : "") +
            `STOP. Hech qanday boshqa tool chaqirmang. Foydalanuvchiga aynan ushbu xabarni bering va uning qarorini kuting:\n\n` +
            `"Claude limiti tugabdi (qayta tiklanish: ${parsed.resetLabel}). Loyiha asosida o'zim mustaqil davom ettiraymi yoki o'zim qilib beraymi?"\n\n` +
            `Variantlar:\n` +
            `1) O'zim mustaqil qilib beray (lokal model bilan, Claude'siz)\n` +
            `2) ChatGPT bilan maslahatlashish (ChatGPT Think orqali davom ettirish)\n` +
            `3) Kutaman (${parsed.resetLabel} gacha)`,
        };
      }

      if (!genStatus.isGenerating && currentText && currentText === lastResponse) {
        stableChecks++;
        const requiredChecks = genStatus.hasCopyBtn ? 2 : 5;
        if (stableChecks >= requiredChecks) {
          // Finished!
          await ChatStore.saveLastChat("claude", { chatUrl: page.url(), lastPrompt: prompt, nonce });
          return {
            success: true,
            text: currentText,
            chatUrl: page.url(),
            modelUsed: currentModelName,
          };
        }
      } else if (currentText) {
        lastResponse = currentText;
        stableChecks = 0;
      }
    }

    // If deadline elapsed while still actively generating or without proof of completion:
    return {
      success: false,
      text: lastResponse,
      error:
        `🛑 [Claude javobi to'liq yakunlanmadi]: Belgilangan vaqt ichida Claude javob berishni tugatmadi (matn hali yozilmoqda edi).\n` +
        `DIQQAT: Ushbu chala matnni yakuniy yechim deb qabul qilmang! Davom ettirish uchun shu asbobni 'newChat: false' bilan qayta chaqiring.`,
    };
  }

  private static async extractResponse(page: Page): Promise<string> {
    const raw = await page.evaluate(async () => {
      // 1. Look for assistant message containers
      const assistantMsgs = Array.from(document.querySelectorAll('div[data-testid="assistant-message"]'));
      let chatText = "";
      let lastAssistant: HTMLElement | null = null;

      if (assistantMsgs.length > 0) {
        lastAssistant = assistantMsgs[assistantMsgs.length - 1] as HTMLElement;
        const resp = lastAssistant.querySelector(
          '.font-claude-response, .standard-markdown, .font-claude-message'
        ) as HTMLElement | null;
        chatText = resp && resp.innerText.trim() ? resp.innerText.trim() : lastAssistant.innerText.trim();
      } else {
        // Fallback: look for response elements
        const candidates = Array.from(
          document.querySelectorAll(
            '.font-claude-response, .standard-markdown, .font-claude-message, [data-is-streaming="false"]'
          )
        );

        if (candidates.length > 0) {
          lastAssistant = candidates[candidates.length - 1] as HTMLElement;
          chatText = lastAssistant.innerText.trim();
        } else {
          const messages = Array.from(
            document.querySelectorAll('[data-testid*="user-message"], [data-testid*="assistant-message"]')
          );
          if (messages.length > 0) {
            lastAssistant = messages[messages.length - 1] as HTMLElement;
            chatText = lastAssistant.innerText.trim();
          }
        }
      }

      // 2. Check for Claude Artifacts (Downloadable code files / split view panel)
      let artifactBlock = "";
      try {
        const artifactCard = lastAssistant
          ? lastAssistant.querySelector('[class*="artifact-block"], [data-sheet-kind], button[data-testid="file-card-open"]')
          : document.querySelector('[class*="artifact-block"], [data-sheet-kind], button[data-testid="file-card-open"]');

        if (artifactCard) {
          // Ensure drawer is open
          const openBtn = (lastAssistant?.querySelector('button[data-testid="file-card-open"]') || artifactCard) as HTMLElement;
          const drawerOpen = !!document.querySelector('[data-drawer-slot]');
          if (!drawerOpen && openBtn && typeof openBtn.click === "function") {
            openBtn.click();
            await new Promise((r) => setTimeout(r, 600));
          }

          // Extract title from card or toolbar
          const cardText = (artifactCard as HTMLElement).innerText || "";
          const toolbarText = (document.querySelector('[data-cds="Toolbar"], header') as HTMLElement)?.innerText || "";
          const title = toolbarText.split("\n")[0] || cardText.split("\n")[0] || "Artifact Code";

          // Extract code lines from drawer
          const drawer = document.querySelector('[data-drawer-slot]');
          if (drawer) {
            const codeLines = Array.from(drawer.querySelectorAll('.group\\/line, [class*="group/line"]'));
            let codeContent = "";
            if (codeLines.length > 0) {
              codeContent = codeLines
                .map((line) => {
                  const children = Array.from(line.children);
                  const codePart = children.length > 1 ? children[children.length - 1] : line;
                  return (codePart as HTMLElement)?.innerText || "";
                })
                .join("\n");
            } else {
              const textEl = (drawer.querySelector('div.bg-surface-3, pre, code') || drawer) as HTMLElement;
              codeContent = textEl.innerText || "";
            }

            if (codeContent.trim().length > 0) {
              artifactBlock = `\n\n---\n### 📦 Artifact File: ${title}\n\`\`\`\n${codeContent.trim()}\n\`\`\``;
            }
          }
        }
      } catch {}

      return chatText + artifactBlock;
    });

    if (!raw) return "";

    return this.cleanExtractedText(raw);
  }

  public static cleanExtractedText(raw: string): string {
    if (!raw) return "";

    // Clean UI artifacts, memory recalls, and interruption banners
    return raw
      .replace(/^Claude responded:\s*/gim, "")
      .replace(/^Recalled \d+ memories\s*>?\s*/gim, "")
      .replace(/Claude[’']s response was interrupted\.?/gi, "")
      .replace(/\[ref\s+[a-f0-9]{6,12}\]/gi, "")
      .replace(/\bEdit prompt\b/gi, "")
      .replace(/\bTry again\b/gi, "")
      .trim();
  }
}
