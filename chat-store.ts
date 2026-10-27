import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ConsultState, InfoNeed } from "./protocol";

export type IntentStatus = "sending" | "streaming" | "done" | "failed";

export interface Intent {
  nonce: string;
  promptHash: string;
  status: IntentStatus;
  chatUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoopState {
  round: number;
  state: ConsultState | "UNKNOWN" | "INCOMPLETE";
  pending: InfoNeed[];
  lastNeedsKey: string;
  nudges: number;
}

export const emptyLoop = (): LoopState => ({
  round: 0,
  state: "FINAL",
  pending: [],
  lastNeedsKey: "",
  nudges: 0,
});

export const isLoopOpen = (l?: LoopState): boolean =>
  !!l && l.state !== "FINAL" && l.round > 0;

export interface ChatSessionInfo {
  chatUrl: string;
  lastPrompt?: string;
  nonce?: string;
  updatedAt: number;
  rateLimitedUntil?: number;
  turns?: number;
  loop?: LoopState;
}

interface Rec {
  chatUrl?: string;
  turns: number;
  lastPrompt?: string;
  nonce?: string;
  rateLimitedUntil?: number;
  updatedAt?: number;
  intent?: Intent;
  loop?: LoopState;
}

export type Decision = "chatgpt" | "autonomous" | "wait";

export interface ProviderLimit {
  until: number;
  approx: boolean;
  raw: string;
  detectedAt: number;
  resetLabel: string;
  decision?: Decision;
}

interface StoreData {
  limits?: Partial<Record<"claude" | "chatgpt" | "gemini", ProviderLimit>>;
  [scopeOrProvider: string]: any;
}

const STORE_DIR = path.join(os.homedir(), ".pi", "agent");
const FILE = path.join(STORE_DIR, "ai-consult-last-chat.json");
const LOCK = FILE + ".lock";

export const INTENT_TTL_MS = 30 * 60_000; // 30 minutes

const sha = (s: string, n = 12) =>
  crypto.createHash("sha256").update(s).digest("hex").slice(0, n);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findProjectRoot(start: string): string {
  try {
    const startPath = path.resolve(start);
    const homePath = path.resolve(os.homedir());
    const filesystemRoot = path.parse(startPath).root;

    const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
    const isHome = (s: string) => norm(s) === norm(homePath);
    const isFsRoot = (s: string) => norm(s) === norm(filesystemRoot);

    if (isHome(startPath)) return startPath;

    let candidate = startPath;
    for (let i = 0; i < 20; i++) {
      // NEVER match os.homedir() as project root!
      // ~/.pi or ~/.git at home level is global settings/dotfiles, NOT a project root.
      if (isHome(candidate) || isFsRoot(candidate)) {
        break;
      }

      const hasMarker =
        fs.existsSync(path.join(candidate, ".git")) ||
        fs.existsSync(path.join(candidate, ".pi")) ||
        fs.existsSync(path.join(candidate, ".ai-consult.json")) ||
        fs.existsSync(path.join(candidate, "package.json")) ||
        fs.existsSync(path.join(candidate, "Cargo.toml")) ||
        fs.existsSync(path.join(candidate, "pyproject.toml")) ||
        fs.existsSync(path.join(candidate, "go.mod"));

      if (hasMarker) {
        return candidate;
      }

      const parent = path.dirname(candidate);
      if (norm(parent) === norm(candidate)) break;
      candidate = parent;
    }

    // Default: If no marker is found below home, return the start workspace itself!
    // A scratch directory without .git (e.g. ~/Desktop/mute-with-location)
    // is its own isolated project, NOT Administrator!
    return startPath;
  } catch {
    return start;
  }
}

export function getProjectLabel(cwd = process.cwd()): string {
  if (process.env.AI_CONSULT_SCOPE) return process.env.AI_CONSULT_SCOPE;
  try {
    const root = findProjectRoot(cwd);
    const base = path.basename(root);
    return base || "default";
  } catch {
    return "default";
  }
}

export function getScopeKey(cwd = process.cwd()): string {
  if (process.env.AI_CONSULT_SCOPE) return sha(process.env.AI_CONSULT_SCOPE);
  try {
    const root = findProjectRoot(cwd);
    let p = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
    if (process.platform === "win32") p = p.toLowerCase().replace(/\\/g, "/");
    return sha(p, 10);
  } catch {
    return sha(cwd.toLowerCase().replace(/\\/g, "/"), 10);
  }
}

export const hashPrompt = (redactedPrompt: string) => sha(redactedPrompt.trim(), 16);

async function mutate<T>(fn: (data: StoreData) => T, timeoutMs = 4000): Promise<T> {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const t0 = Date.now();

  for (;;) {
    try {
      const fd = fs.openSync(LOCK, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 8000) fs.unlinkSync(LOCK);
      } catch {}
      if (Date.now() - t0 > timeoutMs) {
        // Fallback without lock on timeout to avoid deadlocking
        break;
      }
      await sleep(25 + Math.random() * 40);
    }
  }

  try {
    let data: StoreData = {};
    try {
      if (fs.existsSync(FILE)) {
        data = JSON.parse(fs.readFileSync(FILE, "utf8"));
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        try {
          fs.renameSync(FILE, `${FILE}.corrupt.${Date.now()}`);
        } catch {}
      }
    }

    const out = fn(data);
    const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(tmp, FILE);
        break;
      } catch (err: any) {
        if (["EPERM", "EBUSY"].includes(err.code) && i < 4) {
          await sleep(50 * (i + 1));
          continue;
        }
        throw err;
      }
    }

    return out;
  } finally {
    try {
      if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
    } catch {}
  }
}

const getRec = (d: StoreData, scope: string, prov: string): Rec =>
  ((d[scope] ??= {})[prov] ??= { turns: 0 });

export class ChatStore {
  public static generateNonce(): string {
    return crypto.randomBytes(3).toString("hex"); // e.g. "a3f1c8"
  }

  public static getScope(cwd = process.cwd()): string {
    return getScopeKey(cwd);
  }

  public static getProjectLabel(cwd = process.cwd()): string {
    return getProjectLabel(cwd);
  }

  public static async getLastChat(
    provider: "claude" | "chatgpt" | "gemini",
    cwd = process.cwd(),
  ): Promise<ChatSessionInfo | undefined> {
    const scope = getScopeKey(cwd);
    return mutate((d) => {
      const r = getRec(d, scope, provider);
      if (!r.chatUrl) return undefined;
      return {
        chatUrl: r.chatUrl,
        lastPrompt: r.lastPrompt,
        nonce: r.nonce,
        updatedAt: r.updatedAt ?? Date.now(),
        rateLimitedUntil: r.rateLimitedUntil,
        turns: r.turns,
      };
    });
  }

  /**
   * Write-ahead intent. If the same prompt was already submitted within TTL,
   * reuses the exact same nonce and marks it resumed: true (preventing duplicate sends).
   */
  public static async beginIntent(
    provider: "claude" | "chatgpt" | "gemini",
    redactedPrompt: string,
    cwd = process.cwd(),
    force = false,
  ): Promise<{ intent: Intent; resumed: boolean; hints: string[] }> {
    const scope = getScopeKey(cwd);
    const h = hashPrompt(redactedPrompt);

    return mutate((d) => {
      const r = getRec(d, scope, provider);
      const hints: string[] = [];
      if (r.chatUrl) hints.push(r.chatUrl);

      const i = r.intent;
      if (
        !force &&
        i &&
        i.promptHash === h &&
        i.status !== "failed" &&
        Date.now() - i.createdAt < INTENT_TTL_MS
      ) {
        if (i.chatUrl) hints.unshift(i.chatUrl);
        return { intent: { ...i }, resumed: true, hints: [...new Set(hints)] };
      }

      const intent: Intent = {
        nonce: crypto.randomBytes(3).toString("hex"),
        promptHash: h,
        status: "sending",
        chatUrl: r.chatUrl,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      r.intent = intent;
      return { intent: { ...intent }, resumed: false, hints: [...new Set(hints)] };
    });
  }

  public static async patchIntent(
    provider: "claude" | "chatgpt" | "gemini",
    patch: Partial<Intent>,
    cwd = process.cwd(),
  ): Promise<void> {
    const scope = getScopeKey(cwd);
    await mutate((d) => {
      const r = getRec(d, scope, provider);
      if (r.intent) {
        Object.assign(r.intent, patch, { updatedAt: Date.now() });
        if (patch.chatUrl) r.chatUrl = patch.chatUrl;
      }
    });
  }

  public static async saveLastChat(
    provider: "claude" | "chatgpt" | "gemini",
    info: { chatUrl: string; lastPrompt?: string; nonce?: string; rateLimitedUntil?: number },
    cwd = process.cwd(),
  ): Promise<void> {
    const scope = getScopeKey(cwd);
    await mutate((d) => {
      const r = getRec(d, scope, provider);
      r.chatUrl = info.chatUrl;
      r.lastPrompt = info.lastPrompt;
      r.nonce = info.nonce;
      r.rateLimitedUntil = info.rateLimitedUntil;
      r.updatedAt = Date.now();
      r.turns = (r.turns ?? 0) + 1;
      if (r.intent) {
        r.intent.status = "done";
        r.intent.chatUrl = info.chatUrl;
        r.intent.updatedAt = Date.now();
      }
    });
  }

  public static async clearLastChat(
    provider?: "claude" | "chatgpt" | "gemini",
    cwd = process.cwd(),
  ): Promise<void> {
    const scope = getScopeKey(cwd);
    await mutate((d) => {
      if (!provider) {
        delete d[scope];
      } else if (d[scope]) {
        delete d[scope][provider];
      }
    });
  }

  public static async activeLimit(
    provider: "claude" | "chatgpt" | "gemini",
    now = Date.now(),
  ): Promise<ProviderLimit | undefined> {
    return mutate((d) => {
      const l = d.limits?.[provider];
      return l && l.until > now ? l : undefined;
    });
  }

  public static async setLimit(
    provider: "claude" | "chatgpt" | "gemini",
    limit: ProviderLimit,
  ): Promise<void> {
    await mutate((d) => {
      if (!d.limits) d.limits = {};
      d.limits[provider] = limit;
    });
  }

  public static async clearLimit(
    provider?: "claude" | "chatgpt" | "gemini",
  ): Promise<void> {
    await mutate((d) => {
      if (!provider) {
        delete d.limits;
      } else if (d.limits) {
        delete d.limits[provider];
      }
    });
  }

  public static async getLoop(
    provider: "claude" | "chatgpt" | "gemini",
    cwd = process.cwd(),
  ): Promise<LoopState> {
    const scope = getScopeKey(cwd);
    return mutate((d) => {
      const r = getRec(d, scope, provider);
      return r.loop ?? emptyLoop();
    });
  }

  public static async setLoop(
    provider: "claude" | "chatgpt" | "gemini",
    loop: LoopState,
    cwd = process.cwd(),
  ): Promise<void> {
    const scope = getScopeKey(cwd);
    await mutate((d) => {
      const r = getRec(d, scope, provider);
      r.loop = loop;
    });
  }

  public static async clearLoop(
    provider: "claude" | "chatgpt" | "gemini",
    cwd = process.cwd(),
  ): Promise<void> {
    const scope = getScopeKey(cwd);
    await mutate((d) => {
      const r = getRec(d, scope, provider);
      r.loop = emptyLoop();
    });
  }
}
