import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import net from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ChatStore } from "./chat-store.js";
import { hasActiveOtherLeases } from "./browser-tab-lease.js";

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
  private cdpPort = 19222;
  private profileDir = join(homedir(), ".pi", "agent", "ai-consult-profile");
  private claudePages = new Map<string, Page>();
  private chatgptPages = new Map<string, Page>();
  private geminiPages = new Map<string, Page>();
  private inFlightOps = 0;
  private opQueue: Promise<unknown> = Promise.resolve();
  private gen = 0;
  private idleTimer?: NodeJS.Timeout;
  private standaloneWatchdog?: NodeJS.Timeout;

  public isStandaloneProcess(): boolean {
    return !process.env.PI_SESSION_ID && !process.env.PI_SESSION_DIR && !process.env.PI_CODING_AGENT;
  }

  public touchStandaloneWatchdog(timeoutMs = 3000): void {
    if (!this.isStandaloneProcess()) return;
    if (this.standaloneWatchdog) {
      clearTimeout(this.standaloneWatchdog);
    }
    this.standaloneWatchdog = setTimeout(async () => {
      try {
        await this.closeNow();
      } catch {}
      process.exit(0);
    }, timeoutMs);
    this.standaloneWatchdog.unref();
  }

  constructor() {
    if (process.env.PI_AI_CONSULT_PROFILE) {
      this.profileDir = process.env.PI_AI_CONSULT_PROFILE;
    }
    if (process.env.PI_AI_CONSULT_CDP_PORT) {
      this.cdpPort = parseInt(process.env.PI_AI_CONSULT_CDP_PORT, 10) || 19222;
    } else {
      this.cdpPort = 19222;
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

  private async closeNow(scopeKey?: string): Promise<void> {
    const targetScope = scopeKey || ChatStore.getScope(process.cwd());

    // 1. Collect and close ONLY this session's own tracked pages
    const pagesToClose: Page[] = [];

    // If specific scopeKey is targeted, close only that scope's page; otherwise close this process's pages
    if (this.claudePages.has(targetScope)) {
      const p = this.claudePages.get(targetScope)!;
      pagesToClose.push(p);
      this.claudePages.delete(targetScope);
    }
    if (this.chatgptPages.has(targetScope)) {
      const p = this.chatgptPages.get(targetScope)!;
      pagesToClose.push(p);
      this.chatgptPages.delete(targetScope);
    }
    if (this.geminiPages.has(targetScope)) {
      const p = this.geminiPages.get(targetScope)!;
      pagesToClose.push(p);
      this.geminiPages.delete(targetScope);
    }

    // Clean up any remaining pages tracked in this process
    if (!scopeKey) {
      for (const p of this.claudePages.values()) pagesToClose.push(p);
      for (const p of this.chatgptPages.values()) pagesToClose.push(p);
      for (const p of this.geminiPages.values()) pagesToClose.push(p);
      this.claudePages.clear();
      this.chatgptPages.clear();
      this.geminiPages.clear();
      this.claudePage = null;
      this.chatgptPage = null;
      this.geminiPage = null;
    }

    // Close only our own pages, NEVER touching another session's page!
    for (const page of pagesToClose) {
      try {
        if (!page.isClosed()) {
          await page.close({ runBeforeUnload: false });
        }
      } catch {}
    }

    // 2. In CDP mode, safely evaluate whether other sessions or tabs are still active
    if (this.mode === "cdp" && this.browser && this.browser.isConnected()) {
      try {
        // Check A: Does another Pi session have an active consultation lock?
        const otherSessionsActive = hasActiveOtherLeases(targetScope);

        // Check B: Are there other non-blank pages open in the browser belonging to other workspaces?
        const otherPagesOpen = this.browser
          .contexts()
          .flatMap((c) => c.pages())
          .filter((p) => !p.isClosed() && !p.url().includes("about:blank"));

        if (!otherSessionsActive && otherPagesOpen.length === 0) {
          // Zero active leases AND zero other tabs across all sessions:
          // Safely terminate the dedicated automation Chrome instance via browser-level CDP session
          try {
            const cdpSession = await this.browser.newBrowserCDPSession();
            await cdpSession.send("Browser.close");
          } catch {
            await this.browser.close();
          }
        } else {
          // Another Pi session is active or has tabs open!
          // ONLY disconnect this process's Playwright client connection, leaving the other session untouched!
          await this.browser.close();
        }
      } catch {
        try {
          await this.browser.close();
        } catch {}
      }
    } else if (this.mode !== "cdp") {
      try {
        if (this.context) {
          await this.context.close();
        }
      } catch {}
      try {
        if (this.browser) {
          await this.browser.close();
        }
      } catch {}
    }

    this.context = null;
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

  private getActivePortFilePath(): string {
    return join(this.profileDir, ".active-port");
  }

  private readSavedPort(): number | null {
    try {
      const file = this.getActivePortFilePath();
      if (existsSync(file)) {
        const val = parseInt(readFileSync(file, "utf8").trim(), 10);
        if (!isNaN(val) && val > 0 && val < 65536) return val;
      }
    } catch {}
    return null;
  }

  private saveActivePort(port: number): void {
    try {
      writeFileSync(this.getActivePortFilePath(), port.toString(), "utf8");
    } catch {}
  }

  private async isPortBindable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolve(true));
      });
    });
  }

  private async findFreePort(preferred = [19222, 29222, 39222, 49222, 9222]): Promise<number> {
    for (const p of preferred) {
      if (await this.isPortBindable(p)) {
        return p;
      }
    }
    // Fallback: ask OS for an ephemeral free port
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
    });
  }

  private cleanupStaleZombies(): void {
    if (process.platform !== "win32") return;
    try {
      const output = execSync(
        'wmic process where "name=\'chrome.exe\'" get processid,commandline /format:csv',
        { encoding: "utf8", timeout: 4000 }
      );
      const lines = output.split("\n").filter((l) => l.includes(this.profileDir));
      for (const l of lines) {
        const lastComma = l.lastIndexOf(",");
        const pid = l.slice(lastComma + 1).trim();
        if (/^\d+$/.test(pid)) {
          try {
            execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
          } catch {}
        }
      }
    } catch {}
  }

  private async isCdpAvailable(port = this.cdpPort): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
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

    // 1. Check candidate CDP ports (env override -> saved .active-port -> candidate ports)
    const saved = this.readSavedPort();
    const candidatePorts = Array.from(
      new Set(
        [
          process.env.PI_AI_CONSULT_CDP_PORT ? parseInt(process.env.PI_AI_CONSULT_CDP_PORT, 10) : null,
          saved,
          this.cdpPort,
          19222,
          29222,
          9222,
        ].filter((p): p is number => typeof p === "number" && p > 0)
      )
    );

    for (const port of candidatePorts) {
      if (await this.isCdpAvailable(port)) {
        try {
          this.cdpPort = port;
          this.saveActivePort(port);
          this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
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
          console.warn(`[ai-consult] CDP connection to port ${port} failed:`, err);
        }
      }
    }

    // 2. If no CDP port responded, clean up any stale zombies locking the profile
    this.cleanupStaleZombies();

    // 3. Dynamically find a guaranteed free, unreserved port
    const freePort = await this.findFreePort();
    this.cdpPort = freePort;

    // 4. Launch Chrome with remote-debugging-port on the verified free port
    const chromePath = this.findChromePath();
    if (chromePath) {
      try {
        spawn(
          chromePath,
          [
            `--remote-debugging-port=${this.cdpPort}`,
            `--user-data-dir=${this.profileDir}`,
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
          if (await this.isCdpAvailable(this.cdpPort)) break;
        }

        if (await this.isCdpAvailable(this.cdpPort)) {
          this.saveActivePort(this.cdpPort);
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
        console.warn("[ai-consult] Spawning Chrome with dynamic CDP failed:", err);
      }
    }

    // 3. Fallback: Direct Persistent Context (single-session only)
    const headless = process.env.PI_AI_CONSULT_HEADLESS === "1";
    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless,
      viewport: { width: 1280, height: 850 },
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
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
      this.claudePages.clear();
      this.chatgptPages.clear();
      this.geminiPages.clear();
    });
    this.mode = "persistent";
    return this.context;
  }

  public async getClaudePage(scopeKey = "global", forceNew = false): Promise<Page> {
    try {
      return await this.internalGetClaudePage(scopeKey, forceNew);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("closed") || msg.includes("Target page")) {
        this.context = null;
        this.browser = null;
        this.claudePages.delete(scopeKey);
        return await this.internalGetClaudePage(scopeKey, forceNew);
      }
      throw err;
    }
  }

  private async internalGetClaudePage(scopeKey = "global", forceNew = false): Promise<Page> {
    const ctx = await this.ensureContext();
    const marker = `__aic_tab_v1__:claude:${scopeKey}`;

    // 1. In-process cache check
    const cached = this.claudePages.get(scopeKey);
    if (cached && !cached.isClosed() && !forceNew) {
      await cached.bringToFront().catch(() => {});
      return cached;
    }

    // 2. CDP mode: scan open tabs for matching marker or this scope's chatUrl
    if (this.mode === "cdp") {
      for (const p of ctx.pages()) {
        if (p.isClosed()) continue;
        try {
          const info = await p
            .evaluate(() => ({
              name: window.name,
              meta: (window as any).__aic_meta__,
              url: location.href,
            }))
            .catch(() => null);

          if (!info) continue;

          // Strong match: window.name tag
          if (info.name === marker || (info.meta && info.meta.marker === marker)) {
            this.claudePages.set(scopeKey, p);
            await p.bringToFront().catch(() => {});
            return p;
          }

          // Fallback match: tab URL matches this workspace's saved chat and isn't claimed by another scope
          const last = await ChatStore.getLastChat("claude", scopeKey).catch(() => null);
          if (
            last?.chatUrl &&
            info.url.startsWith(last.chatUrl) &&
            (!info.meta || info.meta.scopeKey === scopeKey)
          ) {
            await p
              .evaluate(
                ({ m, s }) => {
                  window.name = m;
                  (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "claude" };
                },
                { m: marker, s: scopeKey },
              )
              .catch(() => {});
            this.claudePages.set(scopeKey, p);
            await p.bringToFront().catch(() => {});
            return p;
          }
        } catch {}
      }
    }

    // 3. Dedicated tab creation: never steal or navigate another workspace's active tab!
    const page = await ctx.newPage();
    await page.addInitScript(
      ({ m, s }) => {
        window.name = m;
        (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "claude" };
      },
      { m: marker, s: scopeKey },
    );

    const last = await ChatStore.getLastChat("claude", scopeKey).catch(() => null);
    const targetUrl = !forceNew && last?.chatUrl ? last.chatUrl : "https://claude.ai/new";

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    } catch {}

    await page
      .evaluate(
        ({ m, s }) => {
          window.name = m;
          (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "claude" };
        },
        { m: marker, s: scopeKey },
      )
      .catch(() => {});

    this.claudePages.set(scopeKey, page);
    await page.bringToFront().catch(() => {});
    return page;
  }

  public async getChatGPTPage(scopeKey = "global", forceNew = false): Promise<Page> {
    try {
      return await this.internalGetChatGPTPage(scopeKey, forceNew);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("closed") || msg.includes("Target page")) {
        this.context = null;
        this.browser = null;
        this.chatgptPages.delete(scopeKey);
        return await this.internalGetChatGPTPage(scopeKey, forceNew);
      }
      throw err;
    }
  }

  private async internalGetChatGPTPage(scopeKey = "global", forceNew = false): Promise<Page> {
    const ctx = await this.ensureContext();
    const marker = `__aic_tab_v1__:chatgpt:${scopeKey}`;

    const cached = this.chatgptPages.get(scopeKey);
    if (cached && !cached.isClosed() && !forceNew) {
      await cached.bringToFront().catch(() => {});
      return cached;
    }

    if (this.mode === "cdp") {
      for (const p of ctx.pages()) {
        if (p.isClosed()) continue;
        try {
          const info = await p
            .evaluate(() => ({
              name: window.name,
              meta: (window as any).__aic_meta__,
              url: location.href,
            }))
            .catch(() => null);

          if (!info) continue;

          if (info.name === marker || (info.meta && info.meta.marker === marker)) {
            this.chatgptPages.set(scopeKey, p);
            await p.bringToFront().catch(() => {});
            return p;
          }

          const last = await ChatStore.getLastChat("chatgpt", scopeKey).catch(() => null);
          if (
            last?.chatUrl &&
            info.url.startsWith(last.chatUrl) &&
            (!info.meta || info.meta.scopeKey === scopeKey)
          ) {
            await p
              .evaluate(
                ({ m, s }) => {
                  window.name = m;
                  (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "chatgpt" };
                },
                { m: marker, s: scopeKey },
              )
              .catch(() => {});
            this.chatgptPages.set(scopeKey, p);
            await p.bringToFront().catch(() => {});
            return p;
          }
        } catch {}
      }
    }

    const page = await ctx.newPage();
    await page.addInitScript(
      ({ m, s }) => {
        window.name = m;
        (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "chatgpt" };
      },
      { m: marker, s: scopeKey },
    );

    const last = await ChatStore.getLastChat("chatgpt", scopeKey).catch(() => null);
    const targetUrl = !forceNew && last?.chatUrl ? last.chatUrl : "https://chatgpt.com";

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    } catch {}

    await page
      .evaluate(
        ({ m, s }) => {
          window.name = m;
          (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "chatgpt" };
        },
        { m: marker, s: scopeKey },
      )
      .catch(() => {});

    this.chatgptPages.set(scopeKey, page);
    await page.bringToFront().catch(() => {});
    return page;
  }

  public async getGeminiPage(scopeKey = "global", forceNew = false): Promise<Page> {
    try {
      return await this.internalGetGeminiPage(scopeKey, forceNew);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("closed") || msg.includes("Target page")) {
        this.context = null;
        this.browser = null;
        this.geminiPages.delete(scopeKey);
        return await this.internalGetGeminiPage(scopeKey, forceNew);
      }
      throw err;
    }
  }

  private async internalGetGeminiPage(scopeKey = "global", forceNew = false): Promise<Page> {
    const ctx = await this.ensureContext();
    const marker = `__aic_tab_v1__:gemini:${scopeKey}`;

    const isGeminiUrl = (u: string) =>
      (u.startsWith("https://gemini.google.com") || u.startsWith("https://www.gemini.google.com")) &&
      !u.includes("accounts.google.com");

    const cached = this.geminiPages.get(scopeKey);
    if (cached && !cached.isClosed() && isGeminiUrl(cached.url()) && !forceNew) {
      await cached.bringToFront().catch(() => {});
      return cached;
    }

    if (this.mode === "cdp") {
      for (const p of ctx.pages()) {
        if (p.isClosed()) continue;
        try {
          const info = await p
            .evaluate(() => ({
              name: window.name,
              meta: (window as any).__aic_meta__,
              url: location.href,
            }))
            .catch(() => null);

          if (!info) continue;

          if (info.name === marker || (info.meta && info.meta.marker === marker)) {
            this.geminiPages.set(scopeKey, p);
            await p.bringToFront().catch(() => {});
            return p;
          }

          const last = await ChatStore.getLastChat("gemini", scopeKey).catch(() => null);
          if (
            last?.chatUrl &&
            info.url.startsWith(last.chatUrl) &&
            (!info.meta || info.meta.scopeKey === scopeKey)
          ) {
            await p
              .evaluate(
                ({ m, s }) => {
                  window.name = m;
                  (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "gemini" };
                },
                { m: marker, s: scopeKey },
              )
              .catch(() => {});
            this.geminiPages.set(scopeKey, p);
            await p.bringToFront().catch(() => {});
            return p;
          }
        } catch {}
      }
    }

    const page = await ctx.newPage();
    await page.addInitScript(
      ({ m, s }) => {
        window.name = m;
        (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "gemini" };
      },
      { m: marker, s: scopeKey },
    );

    const last = await ChatStore.getLastChat("gemini", scopeKey).catch(() => null);
    const targetUrl = !forceNew && last?.chatUrl ? last.chatUrl : "https://gemini.google.com/app";

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    } catch (e: any) {
      if (!page.url().includes("google.com")) throw e;
    }

    await page
      .evaluate(
        ({ m, s }) => {
          window.name = m;
          (window as any).__aic_meta__ = { marker: m, scopeKey: s, provider: "gemini" };
        },
        { m: marker, s: scopeKey },
      )
      .catch(() => {});

    this.geminiPages.set(scopeKey, page);
    await page.bringToFront().catch(() => {});
    return page;
  }

  public async getStatus(): Promise<BrowserStatus> {
    return {
      mode: this.mode,
      cdpPort: this.cdpPort,
      profileDir: this.profileDir,
      isHeadless: process.env.PI_AI_CONSULT_HEADLESS === "1",
      chromePath: this.findChromePath(),
      claudeOpen: Array.from(this.claudePages.values()).some((p) => !p.isClosed()),
      chatgptOpen: Array.from(this.chatgptPages.values()).some((p) => !p.isClosed()),
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
