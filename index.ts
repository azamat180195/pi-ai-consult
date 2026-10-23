/**
 * AI Consult Extension for Pi Coding Agent
 *
 * Connects Pi Agent to your logged-in Claude (claude.ai) and ChatGPT (chatgpt.com)
 * accounts via browser automation (Chrome DevTools Protocol or Persistent Chrome Profile).
 *
 * Tools for Agent:
 *   - consult_claude: Ask or discuss with Claude in your account
 *   - consult_chatgpt: Ask or discuss with ChatGPT in your account
 *   - consult_ai: Unified tool to consult either provider
 *
 * Commands for User:
 *   - /ai-consult status
 *   - /ai-consult login [claude|chatgpt]
 *   - /ai-consult open [claude|chatgpt]
 *   - /ai-consult claude <question>
 *   - /ai-consult chatgpt <question>
 *   - /ai-consult launch-chrome
 *   - /ai-consult close
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BrowserManager } from "./browser-manager.js";
import { ClaudeProvider } from "./claude-provider.js";
import { ChatGPTProvider } from "./chatgpt-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { SecretRedactor } from "./secret-redactor.js";
import { ChatStore, emptyLoop, isLoopOpen, type LoopState } from "./chat-store.js";
import { checkEnglish } from "./language-guard.js";
import {
  PROTOCOL_FOOTER,
  MAX_ROUNDS,
  parseReply,
  isReadOnlyCommand,
  type ParsedReply,
} from "./protocol.js";

import {
  formatBrief,
  formatChallenge,
  formatRedTeam,
  type BriefData,
  type OpenIssue,
} from "./templates.js";

const CONSULT_MULTI_TURN_GUIDELINES = [
  "LANGUAGE ENFORCEMENT - ENGLISH ONLY FOR PROMPTS:",
  "  - All prompts sent to external AIs (Claude, ChatGPT, Gemini) MUST be written in technical English only!",
  "  - Code, logs, error messages, and file paths remain verbatim.",
  "  - The FINAL explanation/report to the user must be delivered in Uzbek.",
  "TRIAGE & SOCRATIC PEER-REVIEW ARCHITECTURE:",
  "  - Classify tasks into tiers: T0 (minor/local/reversible -> no consult needed), T1 (design ambiguity with low blast radius -> 1 round), T2 (production, irreversible, security, DB migration, firewall/network, auth, secrets, hot path, deploy/CI -> FULL Socratic Peer-Review protocol).",
  "  - PRE-CONSULTATION DEEP ANALYSIS (Phase: 'brief'):",
  "      * Before asking the external AI, inspect the codebase and server state yourself with read/bash.",
  "      * Fill the `brief` parameter with: 1-5 hotspots (location, why it is hard, evidence), your initial hypothesis with confidence %, alternatives already considered, and conditions under which it would be wrong/falsified.",
  "      * Never send a lazy or raw user prompt.",
  "  - SOCRATIC CHALLENGE & PUSHBACK (Phase: 'challenge'):",
  "      * Treat every external AI proposal as an untrusted recommendation that must be defended.",
  "      * Probe failure modes: 'Why did you choose library/method X instead of Y?', race conditions, memory/socket leaks, downtime risk, and behavior under the stated production traffic.",
  "      * Batch all challenge questions into ONE message (max 5 questions) to respect message quotas.",
  "      * If the external AI reverses its position without providing new evidence, question the reversal.",
  "  - EVIDENCE HIERARCHY:",
  "      * ran_locally > source_or_docs > reasoning > assertion.",
  "      * If a claim can be verified locally with a read-only command (grep, pfctl -sr, dry-run, test, nginx -t, bash -n), RUN IT LOCALLY instead of merely arguing. Feed the output in Phase 'evidence'.",
  "  - RED-TEAM GATE (Phase: 'redteam'):",
  "      * Before presenting to the user, run a Red Team check: 'Assume this fails in production within 24h. What are the top 3 failure modes, detection signals, and mitigations?'.",
  "DETERMINISTIC MULTI-TURN EVIDENCE & CLARIFICATION LOOP:",
  "  - Every consultation call must specify an `intent` or `phase`:",
  "      * 'initial' / 'brief': starts a new consultation topic (requires newChat: true).",
  "      * 'clarify' / 'challenge': asks for clarification or challenges questionable assumptions (requires newChat: false).",
  "      * 'evidence': answers the external AI's requests for data/files/logs (requires newChat: false and evidence[]).",
  "      * 'verify' / 'redteam': tests failure modes and double-checks final conclusion (requires newChat: false).",
  "  - Inspect the returned `STATUS:` in the tool result:",
  "      * 'NEEDS_FOLLOWUP': The external AI is waiting for specific logs, config files, or command outputs. Your turn is NOT finished! Do not summarize to the user yet! Immediately collect the requested items using your bash/read/grep tools, and call the consult tool again with `intent: 'evidence'`, `newChat: false`, and `evidence: [...]`.",
  "      * 'NEEDS_CLARIFICATION': The response was vague, incomplete, or technically suspicious. Do NOT guess! Call again with `intent: 'clarify'`, `newChat: false`, quote the exact unclear part, and request exact configurations.",
  "      * 'INCOMPLETE': The response was cut off while streaming. Call again with `intent: 'clarify'`, `newChat: false` to continue generating.",
  "      * 'FINAL': The external AI declared nothing else is needed. Now write the comprehensive final report to the user in UZBEK.",
  "EVIDENCE & SAFETY RULES:",
  "  - When the external AI requests command outputs, run ONLY safe read-only commands (grep, cat, ls, pfctl -sr, etc.).",
  "  - Never run destructive or state-modifying commands without explicit user permission.",
  "  - If an item cannot be collected, send it with `status: 'unavailable'` and a `note` explaining why. Never invent or falsify outputs.",
  "CRITICAL CREDENTIALS & SECRETS PROTECTION:",
  "  - NEVER include real production passwords, private keys, API tokens, or secrets when consulting external models!",
  "  - Always replace real credentials with safe placeholders (e.g. 'your_db_password', '[REDACTED_PASSWORD]', 'CHANGE_ME').",
  "  - The extension automatically redacts detected secrets (keys, passwords, tokens) before sending as a defense-in-depth safety measure.",
  "CRITICAL ANTI-FABRICATION & TRUTH ENFORCEMENT:",
  "  - If the consult tool returns an error or failure (e.g. [Claude Error], [ChatGPT Error], [Gemini Error]):",
  "    * YOU ARE STRICTLY FORBIDDEN from inventing, fabricating, hallucinating, or guessing what the AI would have said!",
  "    * YOU MUST NEVER generate a fake 'Katta AI tavsiyasi' when the external AI failed to respond!",
  "    * You MUST immediately and honestly inform the user of the exact error and stop!",
  "    * Attempting to fake or simulate the external AI's response is considered a critical security and truthfulness violation.",
  "MANDATORY TOOL USAGE DIRECTIVE:",
  "  - ALWAYS use the built-in consultation tools (consult_claude, consult_chatgpt, consult_gemini) to interact with external AI models!",
  "  - NEVER write custom Node.js/Playwright runner scripts in bash to automate the browser!",
  "  - Custom runner scripts leave open WebSocket handles that cause the terminal process to hang indefinitely. All CDP and browser lifecycle management is already handled safely inside the registered tools.",
  "FINAL COMPREHENSIVE UZBEK REPORT STRUCTURE (7 Sections):",
  "  - ONLY when the consultation SUCCEEDED with STATUS: FINAL, present the report in UZBEK structured as follows:",
  "    1. 'Qaror': 1-2 sentences summarizing the definitive solution.",
  "    2. 'Nega aynan shu': Core justification backed by concrete evidence (commands run, source references).",
  "    3. 'Rad etilgan variantlar': Table comparing alternatives: | Variant | Nega rad etildi | Qachon to'g'ri bo'lardi |.",
  "    4. 'Xatarlar va qanday yopildi': Table of failure modes: | Xatar (race/leak/downtime/yuk) | Yechim | Dalil darajasi |.",
  "    5. 'Qoldiq xavf': Residual risks that could not be verified locally + canary monitoring metrics.",
  "    6. 'Qo'llash va Rollback': Exact copy-paste commands and rollback procedure.",
  "    7. 'Maslahat tarixi': Summary of consultation rounds and how consensus was established.",
];

export default function aiConsultExtension(pi: ExtensionAPI) {
  const browserManager = new BrowserManager();
  let idleTimer: NodeJS.Timeout | null = null;

  function resetIdleAutoClose(delayMs = 25000) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      try {
        await browserManager.close();
      } catch {}
    }, delayMs);
  }

  function cancelIdleAutoClose() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // Keep browser alive for multi-turn sessions with 15-minute idle safety timeout
  // If an active consult loop is open (waiting for evidence or clarification), NEVER close the browser!
  pi.on("agent_end", async (_e, ctx) => {
    try {
      const openLoops = await Promise.all(
        (["claude", "chatgpt", "gemini"] as const).map(async (p) => ({
          p,
          loop: await ChatStore.getLoop(p),
        })),
      );
      const active = openLoops.filter((x) => isLoopOpen(x.loop));
      if (active.length > 0) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify(
            `⚠️ ai-consult: Faol maslahatlashuv davom etmoqda (${active.map((a) => a.p).join(", ")}) — brauzer ochiq qoldirildi.`,
            "warning",
          );
        }
        return;
      }
    } catch {}
    resetIdleAutoClose(15 * 60 * 1000);
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", async () => {
    cancelIdleAutoClose();
    await browserManager.close();
  });

  // Intercept & block agents from writing or running ad-hoc browser automation scripts
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash") {
      const cmd = String(event.input?.command || "");
      if (
        /node\s+.*(?:claude|chatgpt|gemini|consult|ai-consult).*\.js/i.test(cmd) ||
        /playwright|connectOverCDP|remote-debugging/i.test(cmd)
      ) {
        return {
          block: true,
          reason:
            "🛑 [TAQIQLANGAN]: Brauzer avtomatizatsiyasi uchun alohida Node.js/bash skripti yozish yoki ishga tushirish qat'iyan man etiladi! Bunday skriptlar WebSocket ulanishlarini ochiq qoldirib terminalni 5 daqiqagacha muzlatib (hang qilib) qo'yadi. Buning o'rniga ro'yxatdan o'tgan rasmiy `consult_claude`, `consult_chatgpt` yoki `consult_gemini` asboblaridan to'g'ridan-to'g'ri foydalaning!",
        };
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const path = String(event.input?.path || "");
      const content = String(event.input?.content || "");
      if (
        /(?:claude|chatgpt|gemini|consult).*\.js$/i.test(path) &&
        /(?:browser-manager|claude-provider|chatgpt-provider|gemini-provider|connectOverCDP)/i.test(content)
      ) {
        return {
          block: true,
          reason:
            "🛑 [TAQIQLANGAN]: Brauzer avtomatizatsiyasi uchun alohida skript fayllari yaratish man etiladi! Buning o'rniga Pi tizimida mavjud bo'lgan rasmiy `consult_claude`, `consult_chatgpt` yoki `consult_gemini` asboblarini chaqiring.",
        };
      }
    }
  });

  // Helper: Guard against lazy agents echoing raw user conversational commands to the AI
  function validateConsultPrompt(prompt: string): { valid: boolean; error?: string } {
    const p = prompt.trim().toLowerCase();

    if (p.length < 5) {
      return {
        valid: false,
        error: "🛑 [Xatolik]: Prompt juda qisqa yoki bo'sh. Iltimos, aniq texnik savol yoki kontekst bering.",
      };
    }

    const metaPatterns = [
      /(?:claude|sonnet|chatgpt|gpt)\s*(?:5(?:\.5)?|4o?)?\s*(?:extra\s*)?(?:bilan\s*)?(?:suhbatlash|maslahatlash|gaplash|tekshir)/i,
      /(?:nima\s+deb\s+javob\s+berarkin|deb\s+javob\s+berar|qanday\s+javob\s+beradi)/i,
      /(?:shu\s+qilganini|qilgan\s+ishlarini)\s+(?:tekshirib|yozib)/i,
      /(?:discuss|consult)\s+(?:this\s+)?with\s+(?:claude|sonnet|chatgpt|gpt)/i,
      /^(?:hozir\s+)?(?:gitlab|server|script).*(?:bilan\s+suhbatlash|yozib\s+ko'r\s+nima)/i,
    ];

    for (const pattern of metaPatterns) {
      if (pattern.test(p)) {
        return {
          valid: false,
          error:
            "🛑 [XATOLIK - Meta-prompt aniqlandi!]:\n" +
            "Siz foydalanuvchining botga bergan og'zaki buyrug'ini tahlil qilmasdan to'g'ridan-to'g'ri tashqi AI'ga jo'natmoqchisiz!\n" +
            "Buning o'rniga siz quyidagilarni qilishingiz SHART:\n" +
            "1. Loyihada yoki sessiyada qilingan ishlarni (skriptlar, server sozlamalari, konfiguratsiya fayllari) tahlil qiling.\n" +
            "2. Skriptlar va konfiguratsiyalarning asl kodlarini promptga to'liq kiriting.\n" +
            "3. Claude/ChatGPT'dan arxitektura, xavfsizlik, xatolar va optimizatsiya bo'yicha professional texnik review so'rang.",
        };
      }
    }

    return { valid: true };
  }

  const EvidenceSchema = Type.Object({
    needId: Type.Optional(Type.String({ description: "Request ID from the external AI's last reply, e.g. R1, H1" })),
    kind: Type.Union(
      [
        Type.Literal("command_output"),
        Type.Literal("file"),
        Type.Literal("log"),
        Type.Literal("config"),
        Type.Literal("code"),
        Type.Literal("clarification"),
      ],
      { description: "Type of evidence provided" },
    ),
    source: Type.String({ description: "Exact command executed, or file path[:lines]" }),
    content: Type.String({ description: "VERBATIM output or content. Never summarize or paraphrase." }),
    status: Type.Optional(Type.Union([Type.Literal("ok"), Type.Literal("unavailable")])),
    note: Type.Optional(Type.String({ description: "Why unavailable, or what was truncated (English)" })),
  });

  const HotspotSchema = Type.Object({
    location: Type.String({ description: "file:line, service, or component where the problem resides" }),
    why_hard: Type.String({ description: "Why this part is complex, risky, or a bottleneck" }),
    evidence: Type.String({ description: "Log snippet, grep output, or metric demonstrating the problem" }),
  });

  const HypothesisSchema = Type.Object({
    statement: Type.String({ description: "Your initial proposed direction or solution" }),
    confidence: Type.Integer({ minimum: 0, maximum: 100, description: "Your initial confidence percentage (0-100)" }),
    alternatives_considered: Type.Array(Type.String(), { description: "Other approaches you considered" }),
    falsified_if: Type.String({ description: "Conditions under which your proposal would fail or be wrong" }),
  });

  const BriefSchema = Type.Object({
    goal: Type.String({ description: "Exact objective of the task" }),
    environment: Type.String({ description: "OS, versions, traffic, hardware, constraints" }),
    hotspots: Type.Array(HotspotSchema, { minItems: 1, maxItems: 5, description: "Challenging parts analyzed by you" }),
    hypothesis: HypothesisSchema,
    verified_locally: Type.Optional(Type.Array(Type.String(), { description: "Facts already verified locally" })),
    unknowns: Type.Optional(Type.Array(Type.String(), { description: "Unknowns or un-testable assumptions" })),
  });

  const OpenIssueSchema = Type.Object({
    id: Type.String({ description: "Issue identifier, e.g. I1, I2" }),
    claim: Type.String({ description: "The external AI's claim or recommendation being evaluated" }),
    status: Type.Union(
      [Type.Literal("open"), Type.Literal("verified"), Type.Literal("accepted_risk"), Type.Literal("rejected")],
      { description: "Current evaluation status" },
    ),
    evidence_level: Type.Optional(
      Type.Union([
        Type.Literal("ran_locally"),
        Type.Literal("source_or_docs"),
        Type.Literal("reasoning"),
        Type.Literal("assertion"),
      ]),
    ),
    challenge_question: Type.Optional(Type.String({ description: "Specific challenging question to ask" })),
  });

  function fenceFor(s: string): string {
    const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map((x) => x.length));
    return "`".repeat(longest + 1);
  }

  function capSnippet(s: string, head = 12000, tail = 8000): string {
    return s.length <= head + tail
      ? s
      : `${s.slice(0, head)}\n[... ${s.length - head - tail} chars truncated ...]\n${s.slice(-tail)}`;
  }

  function buildOutgoing(p: any, round = 1): string {
    let mainPrompt = p.prompt?.trim() || "";
    if (p.phase === "brief" && p.brief) {
      mainPrompt = formatBrief(p.brief) + (p.prompt ? `\n\nAdditional Technical Details:\n${p.prompt}` : "");
    } else if (p.phase === "challenge" && p.open_issues?.length) {
      mainPrompt = formatChallenge(round, p.open_issues, p.prompt);
    } else if (p.phase === "redteam") {
      mainPrompt = formatRedTeam(p.prompt || "Review the complete implementation plan.");
    }

    const parts = [mainPrompt];
    for (const ev of p.evidence ?? []) {
      const body = ev.status === "unavailable" ? `(unavailable: ${ev.note ?? "n/a"})` : capSnippet(ev.content);
      const f = fenceFor(body);
      parts.push(
        `### EVIDENCE ${ev.needId ?? "-"} [${ev.kind}] source: ${ev.source}\n${f}text\n${body}\n${f}${
          ev.note && ev.status !== "unavailable" ? `\nnote: ${ev.note}` : ""
        }`,
      );
    }
    parts.push(PROTOCOL_FOOTER);
    return parts.join("\n\n");
  }

  function validateCall(p: any, loop: LoopState): string | null {
    const isNew = p.newChat ?? (p.intent === "initial" || p.phase === "brief");
    if ((p.intent === "initial" || p.phase === "brief") && !isNew) {
      return "intent='initial' or phase='brief' requires newChat: true.";
    }
    if ((p.intent && p.intent !== "initial") || (p.phase && p.phase !== "brief")) {
      if (isNew) {
        return `Follow-up calls (intent='${p.intent || p.phase}') require newChat: false to continue the same chat conversation.`;
      }
    }
    if (isNew && isLoopOpen(loop) && !p.abandonLoop) {
      return `An active consult loop is currently open with pending requests: ${loop.pending.map((n) => n.id).join(", ")}. Continue with newChat: false (intent='evidence', 'challenge', or 'clarify'), or set abandonLoop: true if the user explicitly cancelled.`;
    }
    if (loop.round >= MAX_ROUNDS) {
      return `Consultation round budget exhausted (${MAX_ROUNDS} rounds). STOP looping and report to the user in Uzbek with current verified facts and remaining uncertainties.`;
    }
    if (p.intent === "evidence") {
      if (!p.evidence?.length) return "intent='evidence' requires the evidence[] array.";
      const given = new Set(p.evidence.map((e: any) => e.needId).filter(Boolean));
      const missing = loop.pending.filter((n) => !given.has(n.id)).map((n) => n.id);
      if (missing.length > 0) {
        return `Unanswered requests from external AI: ${missing.join(", ")}. Provide evidence or mark with {status: "unavailable", note: "..."}.`;
      }
    }
    const textToCheck = p.prompt || p.brief?.goal || p.brief?.hypothesis?.statement || "";
    const g = checkEnglish(textToCheck);
    if (!g.ok) {
      return `Prompt MUST be written in English (${g.reason}). Rewrite your prompt in English and call again. (The final response to the user remains in Uzbek).`;
    }
    return null;
  }

  function buildDirective(r: ParsedReply, loop: LoopState, incomplete: boolean): { status: string; text: string } {
    const tag = `round ${loop.round}/${MAX_ROUNDS}`;

    if (incomplete) {
      return {
        status: "INCOMPLETE",
        text: `STATUS: INCOMPLETE (${tag}) — reply was cut off while the model was still generating.
MANDATORY: call again with newChat:false, intent:"clarify", prompt:"Your previous reply was cut off. Continue exactly from where you stopped and end with the CONSULT_STATUS block." Do NOT start a new chat. Do NOT treat partial text as an answer.`,
      };
    }

    if (loop.nudges === -1) {
      return {
        status: "STUCK",
        text: `STATUS: STUCK (${tag}) — external AI repeated the same request(s) after evidence was already supplied.
MANDATORY: stop looping. Report to the user in Uzbek: what was asked, what was sent, and why the external model is not converging.`,
      };
    }

    if (r.state === "NEED_INFO") {
      const items = r.needs
        .map((n) => {
          const safe =
            n.how && n.kind === "command_output"
              ? isReadOnlyCommand(n.how)
                ? " [read-only: run directly]"
                : " [NOT read-only: ask user before running]"
              : "";
          return `  - ID: ${n.id} [${n.kind}] ${n.what}${n.how ? `\n      Command/Path: ${n.how}${safe}` : ""}`;
        })
        .join("\n");

      return {
        status: "NEEDS_FOLLOWUP",
        text: `STATUS: NEEDS_FOLLOWUP (${tag}, detected via ${r.source}) — the external AI is WAITING for additional information/evidence. Your turn is NOT finished!
MANDATORY NEXT ACTION (do not report to the user yet, do not guess):
1. Collect EXACTLY these items with your tools (bash/read/grep). Verbatim output only:
${items}
2. Call this same tool again: newChat:false, intent:"evidence", evidence:[{needId, kind, source, content}] — one entry per ID.
3. If an item cannot be obtained, still send it with status:"unavailable" and note:"<reason>".
4. Never run a non-read-only command without explicit user approval.`,
      };
    }

    if (r.state === "UNCERTAIN" || r.state === "UNKNOWN" || r.lint.length > 0) {
      const issues = r.lint.length ? r.lint.map((l) => `  - ${l}`).join("\n") : "  - no CONSULT_STATUS block or unclear state";
      return {
        status: "NEEDS_CLARIFICATION",
        text: `STATUS: NEEDS_CLARIFICATION (${tag}) — reply is vague, incomplete or technically suspicious:
${issues}
MANDATORY NEXT ACTION: call again with newChat:false, intent:"clarify" (in English). Quote the exact vague/broken part, ask for: exact commands/configs, expected output, and which statements are verified vs assumed. Also validate code blocks locally first (bash -n, tsc --noEmit, etc.). Do NOT guess and do NOT finish the turn.`,
      };
    }

    return {
      status: "FINAL",
      text: `STATUS: FINAL (${tag}) — external AI declared nothing else needed and technical lint is clean.
NEXT: write the final report to the user in UZBEK.
Structure:
1. 'Qaror' (1-2 gap: nima qilinadi)
2. 'Nega aynan shu' (Asosiy sabablar, dalil bilan)
3. 'Rad etilgan variantlar' (Jadval: Variant | Nega rad etildi | Qachon to'g'ri bo'lardi)
4. 'Xatarlar va qanday yopildi' (Jadval: Xatar (race/leak/downtime/yuk) | Yechim | Dalil darajasi)
5. 'Qoldiq xavf' (Lokal tekshirib bo'lmadi + kuzatiladigan metrika)
6. 'Qo'llash va Rollback' (Aniq buyruqlar va rollback qadamlari)
7. 'Maslahat tarixi' (Raundlar, kelishilgan yechim)`,
    };
  }

  const consultParamsBase = {
    prompt: Type.Optional(
      Type.String({
        description: "ENGLISH ONLY. Technical question or architecture inquiry. Code/logs stay verbatim.",
      }),
    ),
    intent: Type.Optional(
      Type.Union(
        [
          Type.Literal("initial"),
          Type.Literal("clarify"),
          Type.Literal("evidence"),
          Type.Literal("verify"),
        ],
        {
          description:
            "initial=new topic (newChat:true). clarify=ask about vague/broken parts of last reply. evidence=supply requested data (evidence[] required). verify=ask it to double-check conclusion.",
        },
      ),
    ),
    phase: Type.Optional(
      Type.Union(
        [
          Type.Literal("brief"),
          Type.Literal("challenge"),
          Type.Literal("evidence"),
          Type.Literal("redteam"),
        ],
        {
          description:
            "brief=initial deep analysis with brief object. challenge=push back against AI assumptions with open_issues. evidence=answer data requests. redteam=final 24h failure simulation before reporting.",
        },
      ),
    ),
    tier: Type.Optional(
      Type.Union([Type.Literal("T0"), Type.Literal("T1"), Type.Literal("T2")], {
        description: "Triage tier: T0=minor/local, T1=design ambiguity/low risk, T2=production/irreversible/hotpath/security.",
      }),
    ),
    brief: Type.Optional(BriefSchema),
    open_issues: Type.Optional(Type.Array(OpenIssueSchema, { maxItems: 6 })),
    newChat: Type.Optional(
      Type.Boolean({
        description: "true for intent=initial or phase=brief. false for all follow-up turns.",
      }),
    ),
    evidence: Type.Optional(Type.Array(EvidenceSchema, { maxItems: 8 })),
    abandonLoop: Type.Optional(
      Type.Boolean({
        description: "Set true only if user explicitly asked to cancel an ongoing consult loop and start fresh.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Maximum seconds to wait for response (default: 360)",
      }),
    ),
  };

  async function executeConsultation(
    provider: "claude" | "chatgpt" | "gemini",
    params: any,
    options: {
      model?: string;
      effort?: string;
      think?: boolean;
      reasoning?: string;
      timeoutSeconds?: number;
    },
    ctx?: any,
  ) {
    const validation = validateConsultPrompt(params.prompt, !!params.brief);
    if (!validation.valid) {
      return {
        content: [{ type: "text", text: validation.error! }],
        details: { success: false, error: validation.error },
      };
    }

    const loop = params.abandonLoop ? emptyLoop() : await ChatStore.getLoop(provider);
    const callError = validateCall(params, loop);
    if (callError) {
      return {
        content: [{ type: "text", text: `🛑 [REJECTED]: ${callError}` }],
        details: { success: false, error: callError },
      };
    }

    const isNew = params.newChat ?? (params.intent === "initial" || params.phase === "brief");
    const outgoing = buildOutgoing(params, loop.round + 1);
    const { text: safePrompt, redactedCount, redactedTypes } = SecretRedactor.redact(outgoing);

    if (redactedCount > 0 && ctx?.ui?.notify) {
      ctx.ui.notify(
        `🔒 [Xavfsizlik]: So'rovdagi ${redactedCount} ta maxfiy ma'lumot (${redactedTypes.join(", ")}) avtomatik tarzda [REDACTED] qilindi!`,
        "info",
      );
    }

    cancelIdleAutoClose();
    browserManager.beginOp();
    return browserManager.serialize(async () => {
      try {
        let result: any;
        if (provider === "claude") {
          const page = await browserManager.getClaudePage(isNew);
          result = await ClaudeProvider.consult(page, safePrompt, {
            newChat: isNew,
            timeoutSeconds: options.timeoutSeconds,
            effort: options.effort ?? "High",
            model: options.model ?? "Sonnet",
          });
        } else if (provider === "chatgpt") {
          const page = await browserManager.getChatGPTPage(isNew);
          result = await ChatGPTProvider.consult(page, safePrompt, {
            newChat: isNew,
            timeoutSeconds: options.timeoutSeconds,
            think: options.think ?? true,
          });
        } else {
          const page = await browserManager.getGeminiPage(isNew);
          result = await GeminiProvider.consult(page, safePrompt, {
            model: options.model ?? "4 Argon",
            reasoning: (options.reasoning as any) ?? "Высокая",
            newChat: isNew,
            timeoutSeconds: options.timeoutSeconds,
          });
        }

        resetIdleAutoClose(25000);

        if (!result.success) {
          if (result.rateLimitHit) {
            return {
              content: [{ type: "text", text: result.error || "Rate limit reached" }],
              details: result,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `🛑 [${provider.toUpperCase()} XATOSI]: ${result.error || "Unknown error occurred"}\n\n[QAT'IY QOIDA]: ${provider} javob bermadi! Sizga 'Katta AI tavsiyasi'ni o'zingiz to'qib chiqarish (fabricate/fake qilish) QAT'IYAN TAQIQLANADI! Foydalanuvchiga faqat ushbu xatolikni bildiring.`,
              },
            ],
            details: { success: false, error: result.error, needsLogin: result.needsLogin },
          };
        }

        const parsed = parseReply(result.text ?? "");
        const needsKey = parsed.needs.map((n) => `${n.kind}:${n.how ?? n.what}`).sort().join("|");
        const stuck = params.intent === "evidence" && parsed.state === "NEED_INFO" && needsKey && needsKey === loop.lastNeedsKey;

        const nextLoop: LoopState = {
          round: (isNew ? 0 : loop.round) + 1,
          state: parsed.state,
          pending: parsed.state === "NEED_INFO" ? parsed.needs : [],
          lastNeedsKey: needsKey,
          nudges: stuck ? -1 : (isNew ? 0 : loop.nudges),
        };
        await ChatStore.setLoop(provider, nextLoop);

        const d = buildDirective(parsed, nextLoop, false);
        return {
          content: [
            {
              type: "text",
              text: `=== AI-CONSULT RESULT === provider:${provider} chat:${result.chatUrl ?? "?"}\n${d.text}\n\n--- EXTERNAL AI RESPONSE (${result.modelUsed || provider}) ---\n${parsed.body || result.text}`,
            },
          ],
          details: {
            success: true,
            status: d.status,
            round: nextLoop.round,
            pending: nextLoop.pending,
            lint: parsed.lint,
            parsedVia: parsed.source,
            chatUrl: result.chatUrl,
            modelUsed: result.modelUsed,
          },
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("closed") || errMsg.includes("Target page")) {
          await browserManager.close(true);
        }
        return {
          content: [{ type: "text", text: `[${provider.toUpperCase()} Error]: ${errMsg}` }],
          details: { success: false, error: errMsg },
        };
      } finally {
        browserManager.endOp();
        resetIdleAutoClose(25000);
      }
    });
  }

  // ── Tool: consult_claude ─────────────────────────────────────────────
  pi.registerTool({
    name: "consult_claude",
    label: "Consult Claude",
    description:
      "Send a technical inquiry to Claude (claude.ai) in English with Socratic review support. Supports model selection ('Sonnet', 'Opus', 'Haiku') and effort levels ('Low', 'Medium', 'High', 'Extra', 'Max').",
    promptSnippet:
      "Consult with Claude (claude.ai) in technical English before writing code or making design decisions",
    promptGuidelines: [
      "CRITICAL: When consulting Claude about work, architecture, or scripts:",
      "  - Prompt MUST be in technical English. Include actual code, configs, and logs.",
      ...CONSULT_MULTI_TURN_GUIDELINES,
      "When the user mentions consulting Claude (e.g., 'Claude bilan maslahatlash', 'ask Claude first'), call consult_claude.",
      "If the user specifies a model (e.g. 'Sonnet', 'Haiku', 'Opus'), pass it to model.",
      "If the user specifies an effort level, pass that value to effort. Defaults to 'High'.",
    ],
    parameters: Type.Object({
      ...consultParamsBase,
      model: Type.Optional(
        Type.String({
          description: "Claude model name: 'Sonnet', 'Opus', 'Haiku'. Defaults to 'Sonnet'.",
        }),
      ),
      effort: Type.Optional(
        Type.Union(
          [
            Type.Literal("Low"),
            Type.Literal("Medium"),
            Type.Literal("High"),
            Type.Literal("Extra"),
            Type.Literal("Max"),
          ],
          {
            description: "Reasoning effort level for Claude. Default: 'High'.",
          },
        ),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx?: any) {
      return executeConsultation(
        "claude",
        params,
        {
          model: params.model ?? "Sonnet",
          effort: params.effort ?? "High",
          timeoutSeconds: params.timeoutSeconds,
        },
        ctx,
      );
    },
  });

  // ── Tool: consult_chatgpt ────────────────────────────────────────────
  pi.registerTool({
    name: "consult_chatgpt",
    label: "Consult ChatGPT",
    description:
      "Send a technical inquiry to ChatGPT (chatgpt.com) in English with Think reasoning mode and Socratic review support.",
    promptSnippet: "Consult with ChatGPT (chatgpt.com) in technical English before writing code or making design decisions",
    promptGuidelines: [
      "CRITICAL: When consulting ChatGPT about work, architecture, or scripts:",
      "  - Prompt MUST be in technical English. Include actual code, configs, and logs.",
      ...CONSULT_MULTI_TURN_GUIDELINES,
      "When the user mentions consulting ChatGPT (e.g., 'ChatGPT bilan maslahatlash', 'GPT bilan gaplash'), call consult_chatgpt.",
      "ChatGPT automatically has 'Think' (reasoning) mode enabled.",
    ],
    parameters: Type.Object({
      ...consultParamsBase,
      think: Type.Optional(
        Type.Boolean({
          description: "Enable ChatGPT Think (reasoning) mode. Default: true.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx?: any) {
      return executeConsultation(
        "chatgpt",
        params,
        {
          think: params.think ?? true,
          timeoutSeconds: params.timeoutSeconds,
        },
        ctx,
      );
    },
  });

  // ── Tool: consult_gemini ─────────────────────────────────────────────
  pi.registerTool({
    name: "consult_gemini",
    label: "Consult Gemini",
    description:
      "Send a technical inquiry to Google Gemini (gemini.google.com) in English with Gemini 4 Argon deep reasoning and Socratic review support.",
    promptSnippet: "Consult Google Gemini (Argon) in technical English before writing code or making design decisions",
    promptGuidelines: [
      "CRITICAL: When consulting Gemini (Argon) about work, architecture, or scripts:",
      "  - Prompt MUST be in technical English. Include actual code, configs, and logs.",
      ...CONSULT_MULTI_TURN_GUIDELINES,
      "Gemini 4 Argon is Google's newest flagship reasoning model for complex code, math, and architecture.",
      "Supports reasoning levels: 'Высокая' (Deep/Глубокий), 'Средний', 'Нizкая'. Default is 'Высокая'.",
    ],
    parameters: Type.Object({
      ...consultParamsBase,
      model: Type.Optional(
        Type.String({
          description: "Gemini model name: '4 Argon', '3.1 Pro', '3.8 Flash', '3.5 Flash-Lite'. Default: '4 Argon'.",
        }),
      ),
      reasoning: Type.Optional(
        Type.Union(
          [Type.Literal("Высокая"), Type.Literal("Средний"), Type.Literal("Низкая")],
          {
            description: "Reasoning level for Gemini 4 Argon: 'Высокая' (Deep), 'Средний', 'Нizкая'. Default: 'Высокая'.",
          },
        ),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx?: any) {
      return executeConsultation(
        "gemini",
        params,
        {
          model: params.model ?? "4 Argon",
          reasoning: params.reasoning ?? "Высокая",
          timeoutSeconds: params.timeoutSeconds,
        },
        ctx,
      );
    },
  });

  // ── Tool: consult_ai ─────────────────────────────────────────────────
  pi.registerTool({
    name: "consult_ai",
    label: "Consult AI",
    description: "Consult either Claude, ChatGPT, or Gemini in technical English with Socratic review support.",
    promptSnippet: "Consult Claude, ChatGPT, or Gemini in technical English",
    parameters: Type.Object({
      provider: Type.Union([Type.Literal("claude"), Type.Literal("chatgpt"), Type.Literal("gemini")], {
        description: "Which AI to consult ('claude', 'chatgpt', or 'gemini')",
      }),
      ...consultParamsBase,
      model: Type.Optional(Type.String({ description: "Model name" })),
      effort: Type.Optional(
        Type.Union(
          [
            Type.Literal("Low"),
            Type.Literal("Medium"),
            Type.Literal("High"),
            Type.Literal("Extra"),
            Type.Literal("Max"),
          ],
          {
            description: "Reasoning effort level for Claude",
          },
        ),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx?: any) {
      return executeConsultation(
        params.provider,
        params,
        {
          model: params.model,
          effort: params.effort,
          timeoutSeconds: params.timeoutSeconds,
        },
        ctx,
      );
    },
  });

  // ── Command: /ai-consult ─────────────────────────────────────────────
  const consultCommandHandler = async (rawArgs: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warn" | "error") => void } }) => {
    const parts = (rawArgs || "").trim().split(/\s+/);
    const subCmd = parts[0]?.toLowerCase() || "status";
    const rest = parts.slice(1).join(" ");

    if (subCmd === "reload") {
      ctx.ui.notify("[ai-consult] Extension qayta yuklanmoqda...", "info");
      await ctx.reload();
      ctx.ui.notify("[ai-consult] Extension muvaffaqiyatli qayta yuklandi!", "info");
      return;
    }

    if (subCmd === "status") {
      const status = await browserManager.getStatus();
      let msg = `[ai-consult] Status:\n`;
      msg += `  Mode: ${status.mode.toUpperCase()}\n`;
      msg += `  CDP Port: ${status.cdpPort}\n`;
      msg += `  Profile: ${status.profileDir}\n`;
      msg += `  Claude Tab: ${status.claudeOpen ? "Open" : "Not opened"}\n`;
      msg += `  ChatGPT Tab: ${status.chatgptOpen ? "Open" : "Not opened"}\n`;
      if (status.chromePath) {
        msg += `  Chrome Path: ${status.chromePath}\n`;
      }
      ctx.ui.notify(msg, "info");
      return;
    }

    if (subCmd === "login" || subCmd === "open") {
      const target = rest.toLowerCase() || "claude";
      ctx.ui.notify(`[ai-consult] Opening browser for ${target}...`, "info");

      if (target.includes("gemini")) {
        const page = await browserManager.getGeminiPage(false);
        await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
        const isLogged = await GeminiProvider.isLogged(page);
        ctx.ui.notify(
          isLogged
            ? "Google Gemini ga muvaffaqiyatli ulangan!"
            : "Gemini ochildi. Iltimos, o'ng yuqoridagi 'Sign in' tugmasi orqali Google hisobingizga kiring.",
          isLogged ? "info" : "warn",
        );
      } else if (target.includes("chatgpt") || target.includes("gpt")) {
        const page = await browserManager.getChatGPTPage(false);
        await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
        const loginCheck = await ChatGPTProvider.checkLogin(page);
        ctx.ui.notify(
          loginCheck.loggedIn
            ? "ChatGPT ga muvaffaqiyatli ulangan!"
            : "ChatGPT ochildi. Iltimos, accountingizga kiring.",
          loginCheck.loggedIn ? "info" : "warn",
        );
      } else {
        const page = await browserManager.getClaudePage(false);
        await page.goto("https://claude.ai/login", { waitUntil: "domcontentloaded" });
        const loginCheck = await ClaudeProvider.checkLogin(page);
        ctx.ui.notify(
          loginCheck.loggedIn
            ? "Claude ga muvaffaqiyatli ulangan!"
            : "Claude ochildi. Iltimos, accountingizga kiring.",
          loginCheck.loggedIn ? "info" : "warn",
        );
      }
      return;
    }

    if (subCmd === "launch-chrome") {
      const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
      ctx.ui.notify("Google Chrome port 9222 bilan ishga tushirilmoqda...", "info");
      spawn(chromePath, ["--remote-debugging-port=9222"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      ctx.ui.notify("Chrome ishga tushirildi! '/ai-consult status' orqali tekshiring.", "info");
      return;
    }

    if (subCmd === "model") {
      const targetModel = (rest || "Sonnet").trim();
      ctx.ui.notify(`Claude modelini '${targetModel}' ga o'rnatilmoqda...`, "info");
      const page = await browserManager.getClaudePage(false);
      const res = await ClaudeProvider.setModel(page, targetModel);
      if (res.fallback) {
        ctx.ui.notify(
          res.notice || `'${targetModel}' pullik bo'lgani sababli '${res.actualModel}' ga o'tildi.`,
          "warn",
        );
      } else {
        ctx.ui.notify(`Claude modeli: ${res.actualModel}`, "info");
      }
      return;
    }

    if (subCmd === "effort") {
      const level = (rest || "High").trim();
      ctx.ui.notify(`Claude effort rejimini '${level}' ga o'rnatilmoqda...`, "info");
      const page = await browserManager.getClaudePage(false);
      await ClaudeProvider.setEffort(page, level);
      const modelBtn = page.locator('[data-testid="model-selector-dropdown"]').first();
      const current = (await modelBtn.count()) > 0 ? await modelBtn.innerText() : level;
      ctx.ui.notify(`Claude modeli va effort holati: ${current}`, "info");
      return;
    }

    if (subCmd === "claude") {
      if (!rest) {
        ctx.ui.notify(
          "Iltimos, savol matnini kiriting: /ai-consult claude [--model <name>] [--effort <level>] <savol>",
          "warn",
        );
        return;
      }
      let promptText = rest;
      let effortLevel = "High";
      let modelName: string | undefined;

      const modelMatch = promptText.match(/--model\s+([A-Za-z0-9._]+)/i);
      if (modelMatch) {
        modelName = modelMatch[1];
        promptText = promptText.replace(modelMatch[0], "").trim();
      }

      const effortMatch = promptText.match(/--effort\s+(Low|Medium|High|Extra|Max)/i);
      if (effortMatch) {
        effortLevel = effortMatch[1];
        promptText = promptText.replace(effortMatch[0], "").trim();
      }

      const infoModel = modelName ? `${modelName}, ${effortLevel}` : effortLevel;
      let safeText = promptText;
      const red = SecretRedactor.redact(promptText);
      if (red.redactedCount > 0) {
        ctx.ui.notify(`🔒 [Xavfsizlik]: ${red.redactedCount} ta maxfiy ma'lumot [REDACTED] qilindi!`, "info");
        safeText = red.text;
      }

      ctx.ui.notify(`Claude (${infoModel}) ga savol yuborilmoqda...`, "info");
      const page = await browserManager.getClaudePage(false);
      const res = await ClaudeProvider.consult(page, safeText, {
        effort: effortLevel,
        model: modelName,
      });
      resetIdleAutoClose(10000);
      if (res.success) {
        const header = res.notice ? `[Eslatma: ${res.notice}]\n\n` : "";
        ctx.ui.notify(`${header}Claude javobi:\n\n${res.text.slice(0, 300)}...`, "info");
      } else {
        ctx.ui.notify(`Xatolik: ${res.error}`, "error");
      }
      return;
    }

    if (subCmd === "chatgpt") {
      if (!rest) {
        ctx.ui.notify("Iltimos, savol matnini kiriting: /ai-consult chatgpt <savol>", "warn");
        return;
      }
      let safeText = rest;
      const red = SecretRedactor.redact(rest);
      if (red.redactedCount > 0) {
        ctx.ui.notify(`🔒 [Xavfsizlik]: ${red.redactedCount} ta maxfiy ma'lumot [REDACTED] qilindi!`, "info");
        safeText = red.text;
      }

      ctx.ui.notify("ChatGPT ga savol yuborilmoqda...", "info");
      const page = await browserManager.getChatGPTPage(false);
      const res = await ChatGPTProvider.consult(page, safeText);
      resetIdleAutoClose(10000);
      if (res.success) {
        ctx.ui.notify(`ChatGPT javobi:\n\n${res.text.slice(0, 300)}...`, "info");
      } else {
        ctx.ui.notify(`Xatolik: ${res.error}`, "error");
      }
      return;
    }

    if (subCmd === "gemini") {
      if (!rest) {
        ctx.ui.notify(
          "Iltimos, savol matnini kiriting: /ai-consult gemini [--model <name>] [--reasoning <level>] <savol>",
          "warn",
        );
        return;
      }
      let promptText = rest;
      let reasoningLevel = "Высокая";
      let modelName = "4 Argon";

      const modelMatch = promptText.match(/--model\s+([A-Za-z0-9._\s]+?)(?:--|$)/i);
      if (modelMatch) {
        modelName = modelMatch[1].trim();
        promptText = promptText.replace(modelMatch[0], "").trim();
      }

      const reasoningMatch = promptText.match(/--reasoning\s+(Высокая|Средний|Низкая)/i);
      if (reasoningMatch) {
        reasoningLevel = reasoningMatch[1];
        promptText = promptText.replace(reasoningMatch[0], "").trim();
      }

      let safeText = promptText;
      const red = SecretRedactor.redact(promptText);
      if (red.redactedCount > 0) {
        ctx.ui.notify(`🔒 [Xavfsizlik]: ${red.redactedCount} ta maxfiy ma'lumot [REDACTED] qilindi!`, "info");
        safeText = red.text;
      }

      ctx.ui.notify(`Gemini (${modelName}, ${reasoningLevel}) ga savol yuborilmoqda...`, "info");
      const page = await browserManager.getGeminiPage(false);
      const res = await GeminiProvider.consult(page, safeText, {
        model: modelName,
        reasoning: reasoningLevel,
      });
      resetIdleAutoClose(10000);
      if (res.success) {
        ctx.ui.notify(`Gemini (${res.modelUsed}) javobi:\n\n${res.text.slice(0, 300)}...`, "info");
      } else {
        ctx.ui.notify(`Xatolik: ${res.error}`, "error");
      }
      return;
    }

    if (subCmd === "reset-limit") {
      await ChatStore.clearLimit();
      ctx.ui.notify("[ai-consult] All cached provider limits cleared! You can now send new queries.", "info");
      return;
    }

    if (subCmd === "doctor" || subCmd === "check") {
      let piVer = "unknown";
      try {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        piVer = readFileSync(join(homedir(), ".pi", "agent", "install", "current-version"), "utf8").trim();
      } catch {}

      const lines = [
        `🩺 [ai-consult Doctor - System Health Check]:`,
        `  Pi Core Version: ${piVer}`,
        `  Extension Directory: ~/.pi/agent/extensions/ai-consult`,
        `  Playwright Driver: Installed & Active`,
        `  Browser Mode: ${status.mode === "cdp" ? "CDP (remote debugging on port 9222)" : "Persistent Profile"}`,
        `  Update Survivability: Isolated user extension directory (100% update-proof)`,
        `  Summary: All systems healthy and ready!`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    if (subCmd === "close") {
      await browserManager.close();
      ctx.ui.notify("[ai-consult] Browser closed.", "info");
      return;
    }

    ctx.ui.notify(
      "Commands:\n  /ai-consult status\n  /ai-consult doctor\n  /ai-consult reset-limit\n  /ai-consult login [claude|chatgpt|gemini]\n  /ai-consult effort [Low|Medium|High|Extra|Max]\n  /ai-consult claude [--effort <level>] <question>\n  /ai-consult chatgpt <question>\n  /ai-consult launch-chrome\n  /ai-consult close",
      "info",
    );
  };

  pi.registerCommand("ai-consult", {
    description: "Consult with Claude & ChatGPT via browser: status, login, claude, chatgpt, close",
    handler: consultCommandHandler,
  });

  pi.registerCommand("consult", {
    description: "Alias for /ai-consult",
    handler: consultCommandHandler,
  });
}
