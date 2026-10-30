import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GatePhase = "idle" | "required" | "final" | "halted";

export interface GateState {
  phase: GatePhase;
  reason?: string;
  provider?: string;
  consults: number;
  since: number;
}

const TRIGGER =
  /\b(consult|chatgpt|gpt|claude|gemini|sonnet|opus|argon)\b|konsult|maslahat|suhbatlash|maslaxat|консульт|совет/i;
const CONSULT_TOOL = /^consult_(claude|chatgpt|gemini|ai)$/;
const READ_ONLY_TOOLS = new Set([
  "read",
  "web_search",
  "google_search",
  "web_fetch",
  "ask_user_question",
  "subagents_list",
  "browser_goto",
  "browser_eval",
  "browser_screenshot",
  "browser_console",
  "browser_network",
  "browser_close",
]);

const DANGEROUS_BASH =
  /[>`]|\$\(|<\(|-exec\b|-delete\b|\b(tee|sed\s+-i|rm|mv|cp|chmod|chown|dd|truncate|curl|wget|npm|pnpm|yarn|gradlew|docker|kubectl|ssh|scp|node\s+-[ec]|python\s+-[ec]|git\s+(checkout|restore|reset|clean|commit|push|apply|stash|merge|rebase))\b/i;
const SAFE_BASH =
  /^(cat|ls|head|tail|wc|grep|rg|find|stat|pwd|git\s+(status|diff|log|show|rev-parse|ls-files|branch)|adb\s+(devices|shell\s+dumpsys|logcat\s+-d)|node\s+--check)\b/i;

function isBashReadOnly(cmd: string): boolean {
  if (DANGEROUS_BASH.test(cmd)) return false;
  const parts = cmd.split(/\s*(?:\|\||&&|;|\|)\s*/);
  return parts.every((p) => SAFE_BASH.test(p.trim()));
}

function parseConsultStatus(text: string): { state: string; needs: number } | null {
  const blocks = [...text.matchAll(/=== AI-CONSULT RESULT ===[\s\S]*?STATUS:\s*([A-Z_]+)/g)];
  const lastMatch = blocks.at(-1);
  if (!lastMatch) return null;
  const state = lastMatch[1];
  const needs = (text.match(/R\d+:/g) ?? []).length;
  return { state, needs };
}

export function installConsultGate(pi: ExtensionAPI) {
  const getGateFile = (cwd: string) => {
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    return path.join(process.env.TEMP ?? "/tmp", `ai-consult-gate-${hash}.json`);
  };

  const loadGate = (cwd: string): GateState => {
    try {
      const content = fs.readFileSync(getGateFile(cwd), "utf8");
      const g = JSON.parse(content) as GateState;
      // Auto-expire after 2 hours
      if (Date.now() - g.since > 2 * 60 * 60 * 1000) {
        return { phase: "idle", consults: 0, since: Date.now() };
      }
      return g;
    } catch {
      return { phase: "idle", consults: 0, since: Date.now() };
    }
  };

  const saveGate = (cwd: string, g: GateState) => {
    const file = getGateFile(cwd);
    const tmp = `${file}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(g, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return g;
  };

  const halt = (ctx: any, g: GateState, reason: string) => {
    saveGate(ctx.cwd, { ...g, phase: "halted", reason });
    if (ctx?.ui?.notify) {
      ctx.ui.notify(
        `⛔ [CONSULTATION GATE HALT]: Konsultatsiya amalga oshmadi (${reason}). Agent to'xtatildi! Davom etish uchun: /consult-resume yoki /consult-off`,
        "error",
      );
    }
  };

  // 1. Capture user input intent & self-heal halted gates on new user messages
  pi.on("input", async (event, ctx) => {
    const text = event.text ?? "";
    if (text.startsWith("/")) return { action: "continue" };

    const g = loadGate(ctx.cwd);

    if (TRIGGER.test(text)) {
      let provider = "AI";
      if (/chatgpt|gpt/i.test(text)) provider = "ChatGPT";
      else if (/claude|sonnet|opus/i.test(text)) provider = "Claude";
      else if (/gemini|argon/i.test(text)) provider = "Gemini";

      saveGate(ctx.cwd, {
        phase: "required",
        provider,
        consults: 0,
        since: Date.now(),
      });
      return { action: "continue" };
    }

    // Self-healing: If gate was halted, a new message from the user heals it back to required
    if (g.phase === "halted") {
      saveGate(ctx.cwd, {
        ...g,
        phase: "required",
        consults: 0,
        reason: undefined,
      });
      if (ctx?.ui?.notify) {
        ctx.ui.notify(
          "ℹ️ [CONSULTATION GATE]: Yangi xabaringiz bilan Halt bekor qilindi (phase: required).",
          "info",
        );
      }
    }

    return { action: "continue" };
  });

  // 2. Authorize or block tool calls
  pi.on("tool_call", async (event, ctx) => {
    const g = loadGate(ctx.cwd);
    if (g.phase === "idle" || g.phase === "final") return undefined;

    if (g.phase === "halted") {
      return {
        block: true,
        reason: `⛔ [FAIL-CLOSED HALT]: Konsultatsiya xatoga uchragan (${g.reason}). Foydalanuvchi buyrug'isiz kod yozish yoki asbob chaqirish qat'iyan man etiladi! To'xtang va xatolikni foydalanuvchiga tushuntiring.`,
      };
    }

    const t = event.toolName;

    // Consult tools and read-only reconnaissance are ALWAYS allowed
    if (CONSULT_TOOL.test(t) || READ_ONLY_TOOLS.has(t)) return undefined;

    // Read-only bash is allowed (to collect logs, diffs, status)
    if (t === "bash" && isBashReadOnly(String(event.input?.command ?? ""))) {
      return undefined;
    }

    // Any state-modifying tool (edit, write, dangerous bash) is BLOCKED!
    return {
      block: true,
      reason:
        `🛑 [FAIL-CLOSED CONSULTATION GATE]: Foydalanuvchi sizga avval ${g.provider ?? "tashqi AI"} bilan maslahatlashishni buyurgan! ` +
        `Konsultatsiya asbobi muvaffaqiyatli yakunlanmaguncha '${t}' vositasi orqali kodni o'zgartirish qat'iyan taqiqlangan! ` +
        `Asbob ishlamaydi deb taxmin qilib, konsultatsiyani aylanib o'tishga yo'l qo'yilmaydi! ` +
        `Darhol consult_${(g.provider ?? "chatgpt").toLowerCase()} asbobini chaqiring. Agar u xato bersa, kod yozmasdan to'xtang va sababini bildiring.`,
    };
  });

  // 3. Track consultation results using structured metadata
  pi.on("tool_result", async (event, ctx) => {
    if (!CONSULT_TOOL.test(event.toolName)) return;

    const g = loadGate(ctx.cwd);
    if (g.phase === "idle" || g.phase === "final") return;

    const d = event.details && typeof event.details === "object" ? event.details : undefined;

    // Structured failure checks
    if (event.isError === true) {
      halt(ctx, g, `${event.toolName} tool ijro xatosi berdi`);
      return;
    }
    if (d?.success === false) {
      halt(ctx, g, `${event.toolName} xatolik berdi: ${d.error ?? "noma'lum xatolik"}`);
      return;
    }

    const text = (event.content ?? []).map((c: any) => c.text ?? "").join("\n");

    // Check for explicit harness rejection banners ONLY at the start of output (never searching model body)
    if (/^🛑\s*\[(REJECTED|.*XATOSI)\]/im.test(text.slice(0, 150))) {
      halt(ctx, g, `${event.toolName} xatosi: ${text.slice(0, 120)}`);
      return;
    }

    // Check for FINAL state via structured details or anchored status text
    const isStructuredFinal = d?.status === "FINAL" || d?.success === true && text.includes("STATUS: FINAL");
    const consults = g.consults + 1;

    if (isStructuredFinal) {
      saveGate(ctx.cwd, { ...g, phase: "final", consults });
      if (ctx?.ui?.notify) {
        ctx.ui.notify(
          `✅ [CONSULTATION GATE]: ${g.provider ?? "AI"} konsultatsiyasi FINAL deb qabul qilindi. Kod tahrirlashga ruxsat berildi.`,
          "info",
        );
      }
      return;
    }

    if (consults >= 8) {
      halt(ctx, g, `8 ta turn o'tdi, lekin yakuniy FINAL olinmadi`);
      return;
    }

    // Stays in "required" phase: reconnaissance and follow-up consults allowed
    saveGate(ctx.cwd, { ...g, consults });
  });

  // User slash commands to inspect or override gate
  pi.registerCommand("consult-status", {
    description: "Fail-closed consultation gate holatini ko'rish",
    handler: async (_args: string, ctx: any) => {
      const g = loadGate(ctx.cwd);
      ctx.ui.notify(
        `Gate: phase=${g.phase}, provider=${g.provider ?? "none"}, consults=${g.consults}, reason=${g.reason ?? "none"}`,
        "info",
      );
    },
  });

  pi.registerCommand("consult-final", {
    description: "Konsultatsiyani muvaffaqiyatli deb tasdiqlash va gate'ni final (ochiq) holatga o'tkazish",
    handler: async (_args: string, ctx: any) => {
      saveGate(ctx.cwd, { phase: "final", consults: 0, since: Date.now() });
      ctx.ui.notify("Gate: final deb belgilandi (kod tahrirlashga ruxsat berildi)", "info");
    },
  });

  pi.registerCommand("consult-resume", {
    description: "Halted holatdagi konsultatsiya darvozasini qayta faollashtirish (required)",
    handler: async (_args: string, ctx: any) => {
      saveGate(ctx.cwd, { phase: "required", consults: 0, since: Date.now() });
      ctx.ui.notify("Gate qayta faollashtirildi (phase: required)", "info");
    },
  });

  pi.registerCommand("consult-off", {
    description: "Konsultatsiya darvozasini o'chirish (idle holatga tushirish)",
    handler: async (_args: string, ctx: any) => {
      saveGate(ctx.cwd, { phase: "idle", consults: 0, since: Date.now() });
      ctx.ui.notify("Gate o'chirildi (phase: idle)", "info");
    },
  });
}
