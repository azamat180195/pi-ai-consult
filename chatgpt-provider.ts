import type { Page } from "playwright-core";
import { ChatStore } from "./chat-store.js";
import type { ConsultResult } from "./claude-provider.js";

const PROMO_KEYWORDS =
  "meet codex|download the app|get the app|desktop app|try plus|try chatgpt plus|stay logged in|survey|what's new|new feature|cookie|privacy";
const NEVER_DISMISS =
  "limit|too many|later|resets|usage cap|session expired|log in|sign in|something went wrong|network error";
const DISMISS_LABELS =
  "^(close|dismiss|not now|maybe later|no thanks|skip|got it|okay|ok|stay logged in|continue|dismiss chatgpt beacon banner)$";

export class ChatGPTProvider {
  /**
   * Sweeps fixed and sticky overlays (e.g. Codex app promo, beacon banners, floating dialogs)
   * that can intercept clicks or cover the composer on slow or fresh page loads.
   */
  public static async sweepOverlays(page: Page): Promise<number> {
    try {
      return await page.evaluate(
        ({ promo, never, dismiss }) => {
          const P = new RegExp(promo, "i");
          const N = new RegExp(never, "i");
          const D = new RegExp(dismiss, "i");
          const composer = document.querySelector("#prompt-textarea, div.ProseMirror, [data-testid='composer']");

          let count = 0;
          const candidates = Array.from(document.querySelectorAll<HTMLElement>("div, section, aside, [role='dialog'], [role='alertdialog']"));

          for (const el of candidates) {
            const text = (el.innerText || el.textContent || "").trim();
            if (!text || text.length > 350 || !P.test(text)) continue;
            if (N.test(text)) continue; // Never touch rate limit, error or login notices!
            if (composer && el.contains(composer)) continue;

            const pos = window.getComputedStyle(el).position;
            const isFloating = pos === "fixed" || pos === "sticky" || el.matches("[role='dialog'], [role='alertdialog']");
            if (!isFloating) continue;

            // Try clicking dismiss/close button first
            const btn = Array.from(el.querySelectorAll<HTMLElement>("button, [role='button']")).find((b) => {
              const label = (b.getAttribute("aria-label") || b.innerText || "").trim();
              return D.test(label) || label.includes("Dismiss") || label.includes("Close") || label === "✕" || label === "×";
            });

            if (btn) {
              btn.click();
            } else {
              el.style.setProperty("display", "none", "important");
            }
            count++;
          }
          return count;
        },
        { promo: PROMO_KEYWORDS, never: NEVER_DISMISS, dismiss: DISMISS_LABELS },
      );
    } catch {
      return 0;
    }
  }

  public static async isLoginPage(page: Page): Promise<boolean> {
    try {
      const loginBtn = await page.locator('button[data-testid="login-button"], a[data-testid="login-button"], button:has-text("Log in")').count();
      const profileBtn = await page.locator('button[data-testid="profile-button"], [data-testid="user-menu-button"]').count();
      if (profileBtn > 0) return false;
      if (loginBtn > 0) return true;
    } catch {}

    return false;
  }

  public static async checkLogin(page: Page): Promise<{ loggedIn: boolean; currentUrl: string }> {
    if (!page.url().includes("chatgpt.com")) {
      await page.goto("https://chatgpt.com/", { waitUntil: "commit", timeout: 45000 });
      await page.waitForTimeout(2000);
    }

    const isLogin = await this.isLoginPage(page);
    return {
      loggedIn: !isLogin,
      currentUrl: page.url(),
    };
  }

  public static async detectLimit(
    page: Page,
  ): Promise<{ isLimit: boolean; resetTime?: string; rawMessage?: string }> {
    try {
      const pageInfo = await page.evaluate(() => {
        const errorEls = Array.from(
          document.querySelectorAll(
            '[data-testid*="error"], [role="alert"], .text-red-500, .text-danger, div[class*="banner"]',
          ),
        );
        const errorTexts = errorEls.map((e) => (e as HTMLElement).innerText).filter(Boolean);
        const composerText =
          (document.querySelector('form [role="alert"], [data-testid*="error"], [data-testid*="limit"]') as HTMLElement)
            ?.innerText || "";
        return {
          errorTexts,
          composerText,
        };
      });

      const combinedText = [
        ...pageInfo.errorTexts,
        pageInfo.composerText,
      ].join("\n");

      const patterns = [
        /reached\s+(?:your|our|the)\s+(?:message\s+|free\s+plan\s+|usage\s+)?limit(?:\s+for\s+[a-zA-Z0-9.\-_]+)?\s*(?:until|at|after)?\s*([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i,
        /limit\s+resets?\s+(?:at|in)\s*([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i,
        /too\s+many\s+requests\s*(?:please\s+try\s+again\s+(?:in|after|at)\s*([0-9:AMPampm\s\w]+))?/i,
        /try\s+again\s+(?:after|at|in)\s*([0-9:AMPampm\s]+(?:\s*(?:AM|PM))?)/i,
        /hit\s+the\s+free\s+plan\s+limit/i,
        /reached\s+(?:your|our)\s+limit/i,
      ];

      for (const p of patterns) {
        const match = combinedText.match(p);
        if (match) {
          return {
            isLimit: true,
            resetTime: match[1]?.trim(),
            rawMessage: match[0],
          };
        }
      }

      if (combinedText.includes("usage cap") || combinedText.includes("messaging limit")) {
        return {
          isLimit: true,
          rawMessage: combinedText,
        };
      }
    } catch {}

    return { isLimit: false };
  }

  public static async ensureThinkMode(page: Page): Promise<boolean> {
    try {
      const thinkBtn = page.locator('button:has-text("Think")').first();
      if ((await thinkBtn.count()) === 0) return false;

      const ariaPressed = await thinkBtn.getAttribute("aria-pressed");
      const isEnabled = ariaPressed === "true";

      if (!isEnabled) {
        await thinkBtn.click({ force: true });
        await page.waitForTimeout(300);
        return true;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Robust, slow-network friendly navigation that uses 'commit' plus progressive readiness polling.
   */
  private static async openPage(page: Page, targetUrl: string): Promise<void> {
    const isAlreadyThere = page.url().startsWith("https://chatgpt.com") && page.url().split("?")[0] === targetUrl.split("?")[0];
    const composer = page.locator('#prompt-textarea, div[contenteditable="true"][role="textbox"], div.ProseMirror').first();

    if (isAlreadyThere && (await composer.isVisible().catch(() => false))) {
      await this.sweepOverlays(page);
      return;
    }

    // Try navigation with progressive timeouts (45s -> 60s) using 'commit' so slow chunks don't stall page.goto
    let lastError: unknown;
    for (const timeout of [45000, 60000]) {
      try {
        await page.goto(targetUrl, { waitUntil: "commit", timeout });
        // Poll for composer readiness
        const start = Date.now();
        while (Date.now() - start < timeout) {
          await this.sweepOverlays(page);
          if (await composer.isVisible().catch(() => false)) {
            await page.waitForTimeout(1000);
            return;
          }
          await page.waitForTimeout(500);
        }
      } catch (err) {
        lastError = err;
        await page.waitForTimeout(1500);
      }
    }

    // Final check before failing
    if (await composer.isVisible().catch(() => false)) {
      await this.sweepOverlays(page);
      return;
    }
    throw lastError || new Error("ChatGPT sahifasi yoki prompt maydoni yuklanmadi.");
  }

  public static async consult(
    page: Page,
    prompt: string,
    options: {
      newChat?: boolean;
      timeoutSeconds?: number;
      think?: boolean;
    } = {},
  ): Promise<ConsultResult> {
    const timeoutMs = (options.timeoutSeconds ?? 360) * 1000;
    const nonce = ChatStore.generateNonce();
    const promptToSend = `${prompt}\n\n[ref ${nonce}]`;

    // 0. Pre-flight check: Is ChatGPT currently rate-limited?
    const activeLimit = await ChatStore.activeLimit("chatgpt");
    if (activeLimit) {
      return {
        success: false,
        text: "",
        rateLimitHit: true,
        resetTime: activeLimit.resetLabel,
        directive: "STOP_AND_ASK_USER",
        error: `ChatGPT limiti tugagan (qayta tiklanish: ${activeLimit.resetLabel}).`,
      };
    }

    // 1. Navigation & Chat Persistence
    let targetUrl = "https://chatgpt.com/";
    if (options.newChat) {
      await ChatStore.clearLastChat("chatgpt");
    } else {
      const currentUrl = page.url();
      if (currentUrl.includes("chatgpt.com/c/") && !currentUrl.includes("local-chatgpt")) {
        targetUrl = currentUrl;
      } else {
        const last = await ChatStore.getLastChat("chatgpt");
        if (last && last.chatUrl && last.chatUrl.includes("chatgpt.com/c/") && !last.chatUrl.includes("local-chatgpt")) {
          targetUrl = last.chatUrl;
        }
      }
    }

    try {
      await this.openPage(page, targetUrl);
    } catch (err: any) {
      return {
        success: false,
        text: "",
        error: `ChatGPT sahifasini ochishda xatolik (internet sekin bo'lishi mumkin): ${err?.message || String(err)}`,
      };
    }

    // Dismiss floating overlays
    await this.sweepOverlays(page);

    // 1.05 Reconnaissance: If not newChat, check top recent chat in sidebar to avoid duplicate prompts
    if (!options.newChat && (!page.url().includes("chatgpt.com/c/") || page.url().includes("local-chatgpt"))) {
      try {
        const topRecentUrl = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="/c/"]'));
          for (const a of links) {
            if (a.closest('[data-testid*="pinned" i], [class*="pinned" i]')) continue;
            const href = (a as HTMLAnchorElement).href;
            if (/^https:\/\/chatgpt\.com\/(?:g\/[\w-]+\/)?c\/[0-9a-f-]{36}$/i.test(href) && !href.includes("local-chatgpt")) {
              return href;
            }
          }
          return null;
        });

        if (topRecentUrl) {
          await page.goto(topRecentUrl, { waitUntil: "commit", timeout: 35000 });
          await page.waitForTimeout(2000);
        }
      } catch {}
    }

    // 1.1 Turn-Anchored Recovery Check
    if (!options.newChat && page.url().includes("chatgpt.com/c/")) {
      // Progressive wait for React SPA hydration on slow network (up to 15s)
      const hydStart = Date.now();
      while (Date.now() - hydStart < 15000) {
        const len = await page.evaluate(() => (document.querySelector("main") || document.body).innerText.length);
        if (len > 1500) break;
        await page.waitForTimeout(500);
      }

      const lastSaved = await ChatStore.getLastChat("chatgpt");
      const isSamePrompt =
        lastSaved?.lastPrompt &&
        (lastSaved.lastPrompt.trim() === prompt.trim() ||
          prompt.trim().startsWith(lastSaved.lastPrompt.trim().slice(0, 60)) ||
          lastSaved.lastPrompt.trim().startsWith(prompt.trim().slice(0, 60)));

      if (isSamePrompt) {
        const targetNonce = lastSaved?.nonce;
        const recoveredText = await this.extractResponse(page);
        if (recoveredText && recoveredText.length > 50) {
          await ChatStore.saveLastChat("chatgpt", { chatUrl: page.url(), lastPrompt: prompt, nonce: targetNonce });
          return {
            success: true,
            text: recoveredText,
            chatUrl: page.url(),
          };
        }
      }
    }

    // 2. Login Check
    if (await this.isLoginPage(page)) {
      return {
        success: false,
        text: "",
        needsLogin: true,
        error:
          "ChatGPT profilingizga kirmagansiz. Iltimos, terminalda '/ai-consult login chatgpt' buyrug'ini tering va brauzerda accountingizga kiring.",
      };
    }

    // Pre-flight Rate Limit check
    const preLimit = await this.detectLimit(page);
    if (preLimit.isLimit) {
      return {
        success: false,
        text: "",
        rateLimitHit: true,
        resetTime: preLimit.resetTime,
        error: `🛑 [Limit tugadi]: ChatGPT xabarlar limiti tugagan! (${preLimit.resetTime || "birozdan so'ng"}).`,
      };
    }

    // Enable Think mode if requested
    if (options.think !== false) {
      await this.ensureThinkMode(page);
    }

    // 3. Locate Input
    const inputSelector = [
      "#prompt-textarea",
      'div#prompt-textarea[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[aria-label*="Ask ChatGPT" i]',
      "textarea",
    ].join(", ");

    let inputLocator = page.locator(inputSelector).first();
    try {
      await inputLocator.waitFor({ state: "visible", timeout: 20000 });
    } catch {
      return {
        success: false,
        text: "",
        error: "ChatGPT prompt kiritish maydoni topilmadi. Sahifa yuklanishida xatolik bo'lishi mumkin.",
      };
    }

    // 4. Input Prompt (clean any drafts, use synthetic paste for reliable ProseMirror state)
    // Wait up to 15s for any in-flight stream/stop button to settle before sending
    // Pre-Submission Barrier: Ensure any previous turn (thinking, web searching, or streaming)
    // has completely finished before typing a new prompt. Wait up to 120s to prevent overlapping collisions!
    const idleWaitStart = Date.now();
    let idleStreak = 0;
    while (Date.now() - idleWaitStart < 120000) {
      const isBusy = await page.evaluate(() => {
        const stop = document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i], [data-icon="stop"]');
        const isStopVisible = !!stop && (stop as HTMLElement).offsetParent !== null;
        const streaming = !!document.querySelector('.result-streaming, [class*="streaming"]');
        return isStopVisible || streaming;
      });
      if (!isBusy) {
        idleStreak++;
        if (idleStreak >= 3) break;
      } else {
        idleStreak = 0;
      }
      await page.waitForTimeout(1000);
    }

    await this.sweepOverlays(page);
    await inputLocator.click({ timeout: 5000 }).catch(() => inputLocator.focus());
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    // Synthetic paste event ensures ProseMirror state updates and Send button enables
    await inputLocator.evaluate((el, text) => {
      (el as HTMLElement).focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, promptToSend);

    // Verify text entered; fallback to native insertText if needed
    const entered = await inputLocator.innerText().catch(() => "");
    if (!entered.includes(nonce)) {
      await page.keyboard.insertText(promptToSend);
      await page.waitForTimeout(500);
    }

    // 5. Submit Message via Multi-Rung Submission Ladder
    const basePageUrl = page.url();
    const sendBtnSelector = [
      'button[data-testid="send-button"]',
      'button[type="submit"][aria-label*="Send" i]',
      'button[aria-label="Send"]',
      'button[type="submit"]',
    ].join(", ");

    const sendBtn = page.locator(sendBtnSelector).first();
    let sent = false;

    // Rung 1: Sweep overlays & click button with force
    await this.sweepOverlays(page);
    if ((await sendBtn.count()) > 0) {
      try {
        await sendBtn.waitFor({ state: "visible", timeout: 3000 });
        if (!(await sendBtn.isDisabled())) {
          await sendBtn.click({ force: true, timeout: 4000 });
          sent = true;
        }
      } catch {}
    }

    // Rung 2: Native DOM click (immune to overlay pointer-events interception)
    if (!sent && (await sendBtn.count()) > 0) {
      try {
        sent = await sendBtn.evaluate((b) => {
          if (!b.disabled && b.getAttribute("aria-disabled") !== "true") {
            (b as HTMLElement).click();
            return true;
          }
          return false;
        });
      } catch {}
    }

    // Rung 3: Native HTML form.requestSubmit()
    if (!sent) {
      try {
        sent = await page.evaluate((sel) => {
          const form = document.querySelector(sel)?.closest("form");
          if (form) {
            const btn = form.querySelector<HTMLButtonElement>('button[type="submit"], button[aria-label*="Send" i]');
            if (btn && !btn.disabled) {
              (form as any).requestSubmit(btn);
              return true;
            }
            (form as any).requestSubmit();
            return true;
          }
          return false;
        }, inputSelector);
      } catch {}
    }

    // Rung 4: ControlOrMeta+Enter in ProseMirror (submits multiline text, unlike plain Enter)
    if (!sent) {
      await inputLocator.focus();
      await page.keyboard.press("ControlOrMeta+Enter");
      await page.waitForTimeout(500);
      await page.keyboard.press("Enter");
    }

    // 5.1 Submission Verification: Wait up to 10s to verify submission occurred
    const submitStart = Date.now();
    let verifiedSubmitted = false;
    while (Date.now() - submitStart < 10000) {
      const probe = await page.evaluate(({ tag }) => {
        const hasStop = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i], [data-icon="stop"]');
        const hasStreaming = !!document.querySelector(".result-streaming, [class*='streaming']");
        const hasUserTurn = Array.from(document.querySelectorAll('[data-message-author-role="user"]')).some((u) =>
          u.textContent?.includes(tag),
        );
        const urlChanged = location.href.includes("/c/");
        return hasStop || hasStreaming || hasUserTurn || urlChanged;
      }, { tag: nonce });

      if (probe) {
        verifiedSubmitted = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    // Immediate Write-Ahead URL Capture: As soon as URL transitions to /c/<id>, save immediately!
    for (let i = 0; i < 20; i++) {
      const u = page.url();
      if (u.includes("chatgpt.com/c/") && !u.includes("local-chatgpt")) {
        await ChatStore.saveLastChat("chatgpt", { chatUrl: u, lastPrompt: prompt, nonce });
        break;
      }
      await page.waitForTimeout(250);
    }

    // Check for errors or limits
    const errorNotice = await page.evaluate(() => {
      const errEl = document.querySelector('[data-testid*="error"], .text-red-500, .text-danger');
      if (errEl && errEl.textContent) return errEl.textContent.trim();
      return null;
    });

    if (errorNotice) {
      return {
        success: false,
        text: "",
        error: `ChatGPT xatosi: ${errorNotice}`,
      };
    }

    // 6. Wait for Thinking & Generation to Complete (anchored strictly to current user turn)
    const startTime = Date.now();
    let deadline = startTime + timeoutMs;
    let lastGrowth = Date.now();
    let lastLen = 0;
    let lastResponse = "";
    let stableChecks = 0;
    let retryAttempts = 0;

    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);

      const status = await page.evaluate(
        ({ tag }) => {
          // Find our specific user turn containing the nonce
          const userTurns = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="user"]'));
          const matchedIndex = userTurns.findLastIndex((u) => (u.innerText || u.textContent || "").includes(tag));

          // Has active Stop button? (Any button with aria-label containing "Stop" or square stop icon)
          const hasStop = !!document.querySelector(
            'button[aria-label*="Stop" i], button[data-testid*="stop" i], [data-icon="stop"]',
          );

          // Is Thinking indicator present? ("Thinking", "Skip", "Worked for")
          const hasThinkingIndicator = !!Array.from(document.querySelectorAll("button, div, span")).find((el) => {
            const t = el.textContent?.trim() || "";
            return (
              (t === "Thinking" || t === "Skip" || t.startsWith("Thinking ") || t.startsWith("Worked for ")) &&
              el.children.length <= 2
            );
          });

          // Locate assistant message strictly following our user turn
          const assistantMsgs = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]'));
          let assistantAfterUser: HTMLElement | null = null;

          if (matchedIndex !== -1) {
            const userEl = userTurns[matchedIndex];
            const nextUserEl = userTurns[matchedIndex + 1];
            assistantAfterUser =
              assistantMsgs.find((a) => {
                const follows = !!(userEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
                const precedes = !nextUserEl || !!(nextUserEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
                return follows && precedes;
              }) || null;
          } else if (assistantMsgs.length > 0) {
            assistantAfterUser = assistantMsgs[assistantMsgs.length - 1];
          }

          let currentTurnText = "";
          let hasCopyBtn = false;

          if (assistantAfterUser) {
            const md = assistantAfterUser.querySelector('.markdown, [class*="MarkdownRoot"], [class*="response-"]');
            currentTurnText = ((md as HTMLElement)?.innerText || assistantAfterUser.innerText || "").trim();
            hasCopyBtn = !!assistantAfterUser.querySelector('button[aria-label*="Copy" i], button[data-testid*="copy"]');
          }

          // Universal Modern UI Fallback: Extract from main.innerText via 'ChatGPT said:'
          if (!currentTurnText) {
            const main = document.querySelector("main") || document.body;
            const mainText = main ? main.innerText : "";
            if (mainText.includes("ChatGPT said:")) {
              const chunks = mainText.split("ChatGPT said:");
              const cand = (chunks[chunks.length - 1] || "").trim();
              if (cand.length > 0) {
                currentTurnText = cand;
                hasCopyBtn = !!document.querySelector('button[aria-label="Copy"], button[aria-label*="Copy" i]');
              }
            }
          }

          // Active thinking or generation state
          const isStillThinking = hasStop && (!currentTurnText || hasThinkingIndicator);
          const isStillGenerating = hasStop || isStillThinking;

          return {
            hasStop,
            isStillThinking,
            isStillGenerating,
            hasAssistant: !!assistantAfterUser,
            currentTurnText,
            hasCopyBtn,
          };
        },
        { tag: nonce },
      );

      // Check if limit hit while streaming
      const streamLimit = await this.detectLimit(page);
      if (streamLimit.isLimit) {
        return {
          success: false,
          text: status.currentTurnText,
          rateLimitHit: true,
          resetTime: streamLimit.resetTime,
          error: `🛑 [Limit tugadi]: Xabar yozilayotgan paytda ChatGPT limiti tugab qoldi! (${streamLimit.resetTime || "birozdan so'ng"}).`,
        };
      }

      // Check for inline error notices ("Unknown error", "Something went wrong", "reloading the conversation")
      const generationError = await page.evaluate(() => {
        const errorNodes = Array.from(
          document.querySelectorAll(
            '[data-testid*="error"], .text-red-500, .text-danger, div[class*="border-red"], div[class*="bg-red"], [role="alert"]',
          ),
        );

        for (const el of errorNodes) {
          // Strictly exclude message content so prompts discussing errors never trigger false positive retries
          if (el.closest('[data-message-author-role]') || el.closest('.markdown') || el.closest('#prompt-textarea')) {
            continue;
          }

          const text = (el as HTMLElement).innerText?.trim() || "";
          if (
            text.includes("Unknown error") ||
            text.includes("Something went wrong") ||
            text.includes("error generating a response") ||
            text.includes("reloading the conversation") ||
            text.includes("An error occurred") ||
            text.includes("network error")
          ) {
            return {
              hasError: true,
              message: text,
              isReloadNeeded: text.toLowerCase().includes("reload"),
            };
          }
        }

        // Check for standalone Retry/Try again button in error cards
        const retryBtn = Array.from(document.querySelectorAll("button")).find((b) => {
          if ((b as HTMLElement).offsetParent === null) return false;
          if (b.closest('[data-message-author-role="user"]') || b.closest('#prompt-textarea')) return false;
          const t = (b.innerText || b.textContent || "").trim();
          return t === "Retry" || t === "Try again" || t === "Повторить" || t.includes("Retry");
        });
        if (retryBtn) {
          const container = (retryBtn as HTMLElement).closest('div[class*="border"], div[class*="error"]') || retryBtn.parentElement;
          return {
            hasError: true,
            message: (container as HTMLElement)?.innerText?.trim() || "Unknown error",
            isReloadNeeded: false,
          };
        }

        // Check for centered reload prompt text
        const reloadText = Array.from(document.querySelectorAll("div, p, span")).find((el) => {
          if (el.closest('[data-message-author-role]') || el.closest('.markdown') || el.closest('#prompt-textarea')) {
            return false;
          }
          const t = el.textContent || "";
          return (
            t.includes("Please try reloading the conversation") ||
            t.includes("error generating a response")
          );
        });
        if (reloadText) {
          return {
            hasError: true,
            message: reloadText.textContent?.trim() || "Please try reloading the conversation",
            isReloadNeeded: true,
          };
        }

        return { hasError: false, message: "", isReloadNeeded: false };
      });

      if (generationError.hasError && !status.currentTurnText) {
        if (retryAttempts < 2) {
          retryAttempts++;
          if (generationError.isReloadNeeded) {
            try {
              await page.reload({ waitUntil: "commit", timeout: 35000 });

              // P0 Hydration Barrier: Wait for React hydration on composer before touching DOM
              const hydStart = Date.now();
              while (Date.now() - hydStart < 15000) {
                const hydrated = await page.evaluate(() => {
                  const ta = document.querySelector("#prompt-textarea, div.ProseMirror, div[contenteditable='true']");
                  if (!ta) return false;
                  return Object.keys(ta).some((k) => k.startsWith("__reactFiber") || k.startsWith("__reactProps"));
                });
                if (hydrated) break;
                await page.waitForTimeout(500);
              }

              await this.sweepOverlays(page);
            } catch {}
          } else {
            try {
              // P1 Pre-Retry Invariant: Ensure Stop button is not active to prevent parallel streams
              const isStillStreaming = await page.evaluate(() => {
                const stop = document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i]');
                return !!stop && (stop as HTMLElement).offsetParent !== null;
              });

              if (!isStillStreaming) {
                const retryBtn = page.locator('button:has-text("Retry"), button:has-text("Try again")').first();
                if ((await retryBtn.count()) > 0 && (await retryBtn.isVisible())) {
                  await retryBtn.click({ force: true });
                  await page.waitForTimeout(2000);
                }
              }
            } catch {}
          }
          stableChecks = 0;
          continue;
        } else {
          return {
            success: false,
            text: "",
            error: `🛑 [ChatGPT xatosi]: ${generationError.message || "Unknown error"}. ChatGPT serverlarida uzilish yoki yuklama yuqoriligi sababli javob bermadi.`,
          };
        }
      }

      // Liveness heartbeat: If Stop button is visible or ChatGPT is actively thinking/searching tools,
      // update lastGrowth and extend deadline so we never abort mid-thought or mid-web-search!
      if (status.isStillGenerating || status.isStillThinking || status.hasStop) {
        lastGrowth = Date.now();
        if (deadline - Date.now() < 90000) {
          deadline = Math.min(deadline + 90000, startTime + 900000);
        }
      }

      // Adaptive streaming budget: as long as new text is arriving, extend deadline up to 15m max
      if (status.currentTurnText.length > lastLen) {
        lastLen = status.currentTurnText.length;
        lastGrowth = Date.now();
        if (deadline - Date.now() < 60000) {
          deadline = Math.min(deadline + 60000, startTime + 900000);
        }
      }

      // If still thinking or still generating, keep waiting and do not treat previous response as done
      if (status.isStillGenerating || status.isStillThinking || !status.currentTurnText) {
        stableChecks = 0;
        lastResponse = status.currentTurnText || lastResponse;
        continue;
      }

      // Generation finished: Stop button is gone, current turn text is populated and stable
      if (!status.hasStop && status.currentTurnText && status.currentTurnText === lastResponse) {
        stableChecks++;
        const requiredChecks = status.hasCopyBtn ? 2 : 4;
        if (stableChecks >= requiredChecks) {
          const cleanText = this.cleanResponse(status.currentTurnText);
          await ChatStore.saveLastChat("chatgpt", { chatUrl: page.url(), lastPrompt: prompt, nonce });
          return {
            success: true,
            text: cleanText,
            chatUrl: page.url(),
          };
        }
      } else {
        lastResponse = status.currentTurnText;
        stableChecks = 0;
      }
    }

    // If deadline elapsed while still actively generating or without proof of completion:
    return {
      success: false,
      text: lastResponse,
      error:
        `🛑 [ChatGPT javobi to'liq yakunlanmadi]: Belgilangan vaqt ichida ChatGPT javob berishni tugatmadi (matn hali yozilmoqda yoki o'ylanmoqda edi).\n` +
        `DIQQAT: Ushbu chala matnni yakuniy yechim deb qabul qilmang! Davom ettirish uchun shu asbobni 'newChat: false' bilan qayta chaqiring.`,
    };
  }

  private static cleanResponse(raw: string): string {
    return raw
      .replace(/^ChatGPT said:\s*/i, "")
      .replace(/\n*ChatGPT can make mistakes.*$/is, "")
      .replace(/\n*4o\s*$/i, "")
      .replace(/\[ref [a-f0-9]+\]/gi, "")
      .trim();
  }

  public static async extractResponse(page: Page): Promise<string> {
    try {
      const responseText = await page.evaluate(() => {
        // 1. Check legacy assistant message containers
        const assistantMsgs = Array.from(
          document.querySelectorAll('[data-message-author-role="assistant"]'),
        );
        if (assistantMsgs.length > 0) {
          const last = assistantMsgs[assistantMsgs.length - 1];
          const mdRoot = last.querySelector('.markdown, [class*="MarkdownRoot"], [class*="response-"]');
          if (mdRoot && (mdRoot as HTMLElement).innerText.trim().length > 0) {
            return (mdRoot as HTMLElement).innerText.trim();
          }
          return (last as HTMLElement).innerText.trim();
        }

        // 2. Modern ChatGPT UI: extract from main.innerText via 'ChatGPT said:'
        const main = document.querySelector("main") || document.body;
        const mainText = main ? main.innerText : "";
        let baseText = "";
        if (mainText.includes("ChatGPT said:")) {
          const chunks = mainText.split("ChatGPT said:");
          baseText = (chunks[chunks.length - 1] || "").trim();
        }

        // 3. Fallback: check elements with Copy button
        if (!baseText) {
          const copyBtns = Array.from(document.querySelectorAll('button[aria-label="Copy"], button[aria-label*="Copy" i]'));
          if (copyBtns.length > 0) {
            const lastBtn = copyBtns[copyBtns.length - 1];
            const container = lastBtn.closest('.block-BQZwFn, [class*="agent-turn"], div.group.flex.flex-col') || lastBtn.parentElement;
            if (container && (container as HTMLElement).innerText.trim().length > 0) {
              baseText = (container as HTMLElement).innerText.trim();
            }
          }
        }

        // 4. Check for ChatGPT Canvas / Code Document panels
        let canvasBlock = "";
        try {
          const canvasEl = document.querySelector('[data-testid="canvas"], [class*="canvas-editor"], div.canvas-content') as HTMLElement | null;
          if (canvasEl && canvasEl.innerText.trim().length > 50) {
            const canvasTitle = (document.querySelector('[class*="canvas-header"], [data-testid="canvas-title"]') as HTMLElement)?.innerText || "Canvas Document";
            canvasBlock = `\n\n---\n### 📦 ChatGPT Canvas Document: ${canvasTitle.trim()}\n\`\`\`\n${canvasEl.innerText.trim()}\n\`\`\``;
          }
        } catch {}

        return (baseText + canvasBlock).trim();
      });

      return this.cleanResponse(responseText);
    } catch {
      return "";
    }
  }
}
