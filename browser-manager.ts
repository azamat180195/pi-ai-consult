import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export interface BrowserStatus {
  mode: "cdp" | "persistent" | "disconnected";
  cdpPort: number;
  profileDir: string;
  isHeadless: boolean;
  chromePath: string | null;
  claudeOpen: boolean;
  chatgptOpen: boolean;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private mode: "cdp" | "persistent" | "disconnected" = "disconnected";
  private cdpPort = 9222;
  private profileDir = join(homedir(), ".pi", "agent", "ai-consult-profile");
  private claudePage: Page | null = null;
  private chatgptPage: Page | null = null;
  private geminiPage: Page | null = null;
  private inFlightOps = 0;
  private opQueue: Promise<unknown> = Promise.resolve();
  private gen = 0;
  private idleTimer?: NodeJS.Timeout;

  constructor() {
    if (process.env.PI_AI_CONSULT_PROFILE) {
      this.profileDir = process.env.PI_AI_CONSULT_PROFILE;
    }
    if (process.env.PI_AI_CONSULT_CDP_PORT) {
      this.cdpPort = parseInt(process.env.PI_AI_CONSULT_CDP_PORT, 10) || 9222;
    }
  }

  public serialize<T>(fn: () => Promise<T>): Promise<T> {
    this.gen++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const next = this.opQueue.then(fn, fn);
    this.opQueue = next.catch(() => {});
    return next;
  }

  public scheduleClose(ms: number): void {
    const g = ++this.gen;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.opQueue = this.opQueue
        .then(async () => {
          if (g !== this.gen || this.inFlightOps > 0) return;
          await this.closeNow();
        })
        .catch(() => {});
    }, ms);
    this.idleTimer.unref();
  }

  public cancelClose(): void {
    this.gen++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  public async close(force = false): Promise<void> {
    if (force) {
      this.cancelClose();
      await this.closeNow();
    } else {
      this.scheduleClose(0);
    }
  }

  private async closeNow(): Promise<void> {
    try {
      if (this.claudePage && !this.claudePage.isClosed()) {
        await this.claudePage.close();
      }
    } catch {}
    this.claudePage = null;

    try {
      if (this.chatgptPage && !this.chatgptPage.isClosed()) {
        await this.chatgptPage.close();
      }
    } catch {}
    this.chatgptPage = null;

    try {
      if (this.geminiPage && !this.geminiPage.isClosed()) {
        await this.geminiPage.close();
      }
    } catch {}
    this.geminiPage = null;

    // In CDP mode, close only the session's own pages and disconnect the client.
    // Do NOT close the shared context or quit Chrome, allowing other Pi sessions to continue untouched!
    if (this.mode !== "cdp") {
      try {
        if (this.context) {
          await this.context.close();
        }
      } catch {}
    }
    this.context = null;

    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch {}
    this.browser = null;
    this.mode = "disconnected";
  }

  private findChromePath(): string | null {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];

    for (const c of candidates) {
      if (existsSync(c)) {
        return c;
      }
    }
    return null;
  }

  private async isCdpAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`, {
        signal: AbortSignal.timeout(600),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  public async ensureContext(): Promise<BrowserContext> {
    if (this.context) {
      try {
        this.context.pages();
        if (this.mode === "cdp" && this.browser && !this.browser.isConnected()) {
          throw new Error("CDP disconnected");
        }
        return this.context;
      } catch {
        this.context = null;
        this.browser = null;
        this.claudePage = null;
        this.chatgptPage = null;
        this.geminiPage = null;
      }
    }

    // 1. Check if Chrome CDP port is already available (from another active Pi session)
    const cdpAvailable = await this.isCdpAvailable();

    if (cdpAvailable) {
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
        const contexts = this.browser.contexts();
        this.context = contexts[0] ?? (await this.browser.newContext());
        this.context.on("close", () => {
          this.context = null;
          this.browser = null;
          this.claudePage = null;
          this.chatgptPage = null;
          this.geminiPage = null;
        });
        this.mode = "cdp";
        return this.context;
      } catch (err) {
        console.warn("[ai-consult] CDP connection to running Chrome failed:", err);
      }
    }

    // 2. Launch Chrome with remote-debugging-port so all concurrent sessions can share it
    const chromePath = this.findChromePath();
    if (chromePath) {
      try {
        spawn(
          chromePath,
          [
            `--remote-debugging-port=${this.cdpPort}`,
            `--remote-debugging-address=127.0.0.1`,
            `--user-data-dir=${this.profileDir}`,
            "--disable-blink-features=AutomationControlled",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1280,850",
            "about:blank",
          ],
          { detached: true, stdio: "ignore" },
        ).unref();

        // Wait up to 10 seconds for CDP port to become ready
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 250));
          if (await this.isCdpAvailable()) break;
        }

        if (await this.isCdpAvailable()) {
          this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
          const contexts = this.browser.contexts();
          this.context = contexts[0] ?? (await this.browser.newContext());
          this.context.on("close", () => {
            this.context = null;
            this.browser = null;
            this.claudePage = null;
            this.chatgptPage = null;
            this.geminiPage = null;
          });
          this.mode = "cdp";
          return this.context;
        }
      } catch (err) {
        console.warn("[ai-consult] Spawning Chrome with CDP failed:", err);
      }
    }

    // 3. Fallback: Direct Persistent Context (single-session only)
    const headless = process.env.PI_AI_CONSULT_HEADLESS === "1";
    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless,
      viewport: { width: 1280, height: 850 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-infobars",
        "--window-size=1280,850",
      ],
    };

    if (chromePath) {
      launchOptions.executablePath = chromePath;
    }

    this.context = await chromium.launchPersistentContext(this.profileDir, launchOptions);
    this.context.on("close", () => {
      this.context = null;
      this.browser = null;
      this.claudePage = null;
      this.chatgptPage = null;
      this.geminiPage = null;
    });
    this.mode = "persistent";
    return this.context;
  }

  public async getClaudePage(forceNew = false): Promise<Page> {
    try {
      return await this.internalGetClaudePage(forceNew);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("closed") || msg.includes("Target page")) {
        this.context = null;
        this.browser = null;
        this.claudePage = null;
        return await this.internalGetClaudePage(forceNew);
      }
      throw err;
    }
  }

  private async internalGetClaudePage(forceNew = false): Promise<Page> {
    const ctx = await this.ensureContext();

    if (this.claudePage && !this.claudePage.isClosed() && !forceNew) {
      return this.claudePage;
    }

    // In CDP mode, search existing tabs first
    if (this.mode === "cdp") {
      const existing = ctx.pages().find((p) => p.url().includes("claude.ai"));
      if (existing && !existing.isClosed() && !forceNew) {
        this.claudePage = existing;
        await this.claudePage.bringToFront();
        return this.claudePage;
      }
    }

    // Otherwise use first blank page or open new page
    const pages = ctx.pages();
    let page: Page | undefined;
    if (pages.length > 0 && (pages[0].url() === "about:blank" || pages[0].url() === "")) {
      page = pages[0];
    } else {
      page = await ctx.newPage();
    }

    this.claudePage = page;
    await this.claudePage.bringToFront();
    return this.claudePage;
  }

  public async getChatGPTPage(forceNew = false): Promise<Page> {
    try {
      return await this.internalGetChatGPTPage(forceNew);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("closed") || msg.includes("Target page")) {
        this.context = null;
        this.browser = null;
        this.chatgptPage = null;
        return await this.internalGetChatGPTPage(forceNew);
      }
      throw err;
    }
  }

  private async internalGetChatGPTPage(forceNew = false): Promise<Page> {
    const ctx = await this.ensureContext();

    if (this.chatgptPage && !this.chatgptPage.isClosed() && !forceNew) {
      return this.chatgptPage;
    }

    // In CDP mode, search existing tabs first
    if (this.mode === "cdp") {
      const existing = ctx.pages().find((p) => p.url().includes("chatgpt.com"));
      if (existing && !existing.isClosed() && !forceNew) {
        this.chatgptPage = existing;
        await this.chatgptPage.bringToFront();
        return this.chatgptPage;
      }
    }

    // Otherwise use first blank page or open new page
    const pages = ctx.pages();
    let page: Page | undefined;
    if (pages.length > 0 && (pages[0].url() === "about:blank" || pages[0].url() === "")) {
      page = pages[0];
    } else {
      page = await ctx.newPage();
    }

    this.chatgptPage = page;
    await this.chatgptPage.bringToFront();
    return this.chatgptPage;
  }

  public async getGeminiPage(forceNew = false): Promise<Page> {
    try {
      return await this.internalGetGeminiPage(forceNew);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("closed") || msg.includes("Target page")) {
        this.context = null;
        this.browser = null;
        this.geminiPage = null;
        return await this.internalGetGeminiPage(forceNew);
      }
      throw err;
    }
  }

  private async internalGetGeminiPage(forceNew = false): Promise<Page> {
    const ctx = await this.ensureContext();

    if (this.geminiPage && !this.geminiPage.isClosed() && !forceNew) {
      return this.geminiPage;
    }

    if (this.mode === "cdp") {
      const existing = ctx.pages().find((p) => p.url().includes("gemini.google.com"));
      if (existing && !existing.isClosed() && !forceNew) {
        this.geminiPage = existing;
        await this.geminiPage.bringToFront();
        return this.geminiPage;
      }
    }

    const pages = ctx.pages();
    let page: Page | undefined;
    if (pages.length > 0 && (pages[0].url() === "about:blank" || pages[0].url() === "")) {
      page = pages[0];
    } else {
      page = await ctx.newPage();
    }

    this.geminiPage = page;
    await this.geminiPage.bringToFront();
    return this.geminiPage;
  }

  public async getStatus(): Promise<BrowserStatus> {
    return {
      mode: this.mode,
      cdpPort: this.cdpPort,
      profileDir: this.profileDir,
      isHeadless: process.env.PI_AI_CONSULT_HEADLESS === "1",
      chromePath: this.findChromePath(),
      claudeOpen: !!(this.claudePage && !this.claudePage.isClosed()),
      chatgptOpen: !!(this.chatgptPage && !this.chatgptPage.isClosed()),
    };
  }

  public beginOp(): void {
    this.inFlightOps++;
  }

  public endOp(): void {
    this.inFlightOps = Math.max(0, this.inFlightOps - 1);
  }

  public get inFlight(): number {
    return this.inFlightOps;
  }
}
