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

const CONSULT_FOLLOWUP_NOTICE =
  "\n\n---\n💡 [MUHIM ESLATMA]: Agar ushbu javobda biror narsa tushunarsiz, noaniq bo'lsa yoki to'liq kod/yechim yetishmayotgan bo'lsa, sessiyani yopmasdan darhol shu asbobni `newChat: false` bilan qayta chaqiring va aniqlashtiruvchi savol bering! Faqat 100% to'liq va tushunarli yechim olingach foydalanuvchiga taqdim eting.";

const CONSULT_MULTI_TURN_GUIDELINES = [
  "CRITICAL CREDENTIALS & SECRETS PROTECTION:",
  "  - NEVER include real production passwords, private keys, API tokens, or secrets when consulting external models!",
  "  - Always replace real credentials with safe placeholders (e.g. 'your_db_password', '[REDACTED_PASSWORD]', 'CHANGE_ME').",
  "  - The extension automatically redacts detected secrets (keys, passwords, tokens) before sending as a defense-in-depth safety measure.",
  "MANDATORY MULTI-TURN QUALITY & CLARITY VERIFICATION LOOP:",
  "  - After receiving the AI's response (Claude, ChatGPT, or Gemini), YOU MUST critically evaluate it against the task requirements:",
  "    1. Did the external AI fully and comprehensively answer the question, or is anything omitted, vague, or generic?",
  "    2. Are there any ambiguous architectural details, missing code blocks, syntax gaps, or unvalidated assumptions?",
  "    3. Do you have 100% concrete, unambiguous, and copy-paste ready implementation details?",
  "  - IF THE ANSWER IS INSUFFICIENT, UNCLEAR, INCOMPLETE, OR LACKS CRITICAL DETAILS:",
  "    * YOU MUST NOT stop, guess, or assume missing pieces!",
  "    * YOU MUST IMMEDIATELY ask a follow-up question in the SAME chat session by calling the consult tool again with `newChat: false`!",
  "    * Formulate your follow-up inquiry specifically pointing out what was unclear or missing.",
  "    * Continue this multi-turn discussion loop (`newChat: false`) until you have a 100% validated, concrete, and comprehensive solution.",
  "  - Only once all details are completely understood and verified should you conclude the consultation and report to the user.",
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
  "COMPARATIVE RESPONSE STRUCTURE TO USER:",
  "  - ONLY when the consultation SUCCEEDED and a real response was received from the external AI, follow this structure:",
  "    1. 'Dastlabki reja/holat': What you originally intended to do or what was initially implemented.",
  "    2. 'Katta AI tavsiyasi': What the AI suggested with its reasoning.",
  "    3. 'Taqqoslash va baholash': Why the AI's proposal is better (e.g. handles edge cases, zero downtime, avoids conflicts).",
  "    4. 'Yakuniy tuzatilgan kod va amaliy yechim': The complete, fixed code ready to deploy.",
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
  pi.on("agent_end", async () => {
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

  // ── Tool: consult_claude ─────────────────────────────────────────────
  pi.registerTool({
    name: "consult_claude",
    label: "Consult Claude",
    description:
      "Send a question or technical discussion prompt to Claude (claude.ai) in the user's logged-in browser account, wait for Claude's response, and return the answer. Supports model selection ('Sonnet', 'Opus', 'Haiku') and reasoning effort levels ('Low', 'Medium', 'High', 'Extra', 'Max').",
    promptSnippet:
      "Consult with Claude (claude.ai) in the user's browser account (with customizable model & effort) before writing code or making design decisions",
    promptGuidelines: [
      "CRITICAL: When consulting Claude about work, architecture, or scripts:",
      "  - NEVER pass the user's raw conversational command or meta-instructions into the prompt!",
      "  - YOU MUST inspect the codebase/session, include the actual code/scripts/configurations in the prompt, and formulate an in-depth technical review request as a senior engineer.",
      ...CONSULT_MULTI_TURN_GUIDELINES,
      "When the user mentions consulting Claude (e.g., 'Claude bilan maslahatlash', 'ask Claude first', 'discuss with Claude'), call consult_claude before executing code changes.",
      "If the user specifies a model (e.g. 'Claude Opus bilan', 'Haiku bilan', 'Sonnet orqali'), pass it to the model parameter.",
      "If the user specifies an effort level (e.g., 'Low effort', 'Medium qilib', 'High bilan', 'Extra bilan', 'Max effort'), pass that value to the effort parameter. Defaults to 'High'.",
      "If the user asks for an unavailable or paid model like Opus and the account is Free, the tool stops and returns a clear message stating the model is unavailable along with the list of available models. Inform the user and ask for instructions.",
      "CRITICAL RATE LIMIT PROTOCOL: If consult_claude returns rateLimitHit: true or mentions that Claude limit is reached:",
      "  - YOU MUST STOP IMMEDIATELY and NOT make code changes or call any other tool!",
      "  - Output a clear message to the user in Uzbek: 'Claude limiti tugabdi (qayta tiklanish: <reset_time>). Loyiha asosida o'zim mustaqil davom ettiraymi yoki o'zim qilib beraymi?'",
      "  - Present the 3 choices to the user:",
      "      1) O'zim mustaqil qilib beray (lokal model bilan, Claude'siz)",
      "      2) ChatGPT bilan maslahatlashish (savolni ChatGPT Think'ga yo'naltirish)",
      "      3) Kutaman (<reset_time> gacha)",
      "  - End your turn immediately and wait for the user's decision before making any code modifications or calling further tools!",
      "You can have a multi-turn discussion with Claude by making follow-up calls with newChat: false.",
      "Summarize Claude's advice clearly for the user and apply the recommended technical solution to your implementation.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The question, architecture problem, or context to send to Claude",
      }),
      model: Type.Optional(
        Type.String({
          description:
            "Claude model name to use (e.g. 'Sonnet', 'Opus', 'Haiku'). If not available in the user's account, automatically falls back to Sonnet.",
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
            description:
              "Reasoning effort level for Claude: 'Low', 'Medium', 'High', 'Extra', or 'Max'. Default: 'High'.",
          },
        ),
      ),
      newChat: Type.Optional(
        Type.Boolean({
          description:
            "Start a fresh conversation (true) or continue the current conversation (false). Default: false.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          description: "Maximum seconds to wait for Claude to generate response (default: 180)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx?: any) {
      const validation = validateConsultPrompt(params.prompt);
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: validation.error! }],
          details: { success: false, error: validation.error },
        };
      }

      const { text: safePrompt, redactedCount, redactedTypes } = SecretRedactor.redact(params.prompt);
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
          const page = await browserManager.getClaudePage(params.newChat ?? false);
          const result = await ClaudeProvider.consult(page, safePrompt, {
            newChat: params.newChat ?? false,
            timeoutSeconds: params.timeoutSeconds,
            effort: params.effort ?? "High",
            model: params.model ?? "Sonnet",
          });
          resetIdleAutoClose(25000);

          if (!result.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `🛑 [CLAUDE XATOSI]: ${result.error || "Unknown error occurred"}\n\n[QAT'IY QOIDA]: Claude javob bermadi! Sizga 'Katta AI tavsiyasi'ni o'zingiz to'qib chiqarish (fabricate/fake qilish) QAT'IYAN TAQIQLANADI! Foydalanuvchiga faqat ushbu xatolikni bildiring.`,
                },
              ],
              details: { success: false, error: result.error, needsLogin: result.needsLogin },
            };
          }

          const modelHeader = result.modelUsed || params.model || "Sonnet";
          return {
            content: [
              {
                type: "text",
                text: `### Claude (${modelHeader}) Response:\n\n${result.text}${CONSULT_FOLLOWUP_NOTICE}`,
              },
            ],
            details: {
              success: true,
              chatUrl: result.chatUrl,
              responseLength: result.text.length,
              modelUsed: result.modelUsed,
              notice: result.notice,
              effort: params.effort ?? "High",
            },
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("closed") || errMsg.includes("Target page")) {
            await browserManager.close(true);
          }
          return {
            content: [{ type: "text", text: `[Claude Error]: ${errMsg}` }],
            details: { success: false, error: errMsg },
          };
        } finally {
          browserManager.endOp();
          resetIdleAutoClose(25000);
        }
      });
    },
  });

  // ── Tool: consult_chatgpt ────────────────────────────────────────────
  pi.registerTool({
    name: "consult_chatgpt",
    label: "Consult ChatGPT",
    description:
      "Send a question or technical discussion prompt to ChatGPT (chatgpt.com) in the user's logged-in browser account, wait for ChatGPT's response, and return the answer. Use this whenever the user asks to consult ChatGPT or get advice from GPT before implementing a task.",
    promptSnippet:
      "Consult with ChatGPT (chatgpt.com) in the user's browser account before writing code or making design decisions",
    promptGuidelines: [
      "CRITICAL: When consulting ChatGPT about work, architecture, or scripts:",
      "  - NEVER pass the user's raw conversational command or meta-instructions into the prompt!",
      "  - YOU MUST inspect the codebase/session, include the actual code/scripts/configurations in the prompt, and formulate an in-depth technical review request as a senior engineer.",
      ...CONSULT_MULTI_TURN_GUIDELINES,
      "When the user mentions consulting ChatGPT (e.g., 'ChatGPT bilan maslahatlash', 'GPT bilan gaplash', 'ask ChatGPT first'), call consult_chatgpt before executing code changes.",
      "ChatGPT automatically has 'Think' (reasoning) mode enabled for in-depth technical answers.",
      "You can have a multi-turn discussion with ChatGPT by making follow-up calls with newChat: false.",
      "Summarize ChatGPT's advice clearly for the user and apply the recommended technical solution to your implementation.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The question, architecture problem, or context to send to ChatGPT",
      }),
      think: Type.Optional(
        Type.Boolean({
          description: "Enable ChatGPT Think (reasoning) mode for smarter in-depth answers. Default: true.",
        }),
      ),
      newChat: Type.Optional(
        Type.Boolean({
          description:
            "Start a fresh conversation (true) or continue the current conversation (false). Default: false.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          description: "Maximum seconds to wait for ChatGPT to generate response (default: 120)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx?: any) {
      const validation = validateConsultPrompt(params.prompt);
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: validation.error! }],
          details: { success: false, error: validation.error },
        };
      }

      const { text: safePrompt, redactedCount, redactedTypes } = SecretRedactor.redact(params.prompt);
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
          const page = await browserManager.getChatGPTPage(params.newChat ?? false);
          const result = await ChatGPTProvider.consult(page, safePrompt, {
            newChat: params.newChat ?? false,
            timeoutSeconds: params.timeoutSeconds,
            think: params.think ?? true,
          });
          resetIdleAutoClose(25000);

          if (!result.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `🛑 [CHATGPT XATOSI]: ${result.error || "Unknown error occurred"}\n\n[QAT'IY QOIDA]: ChatGPT javob bermadi! Sizga 'Katta AI tavsiyasi'ni o'zingiz to'qib chiqarish (fabricate/fake qilish) QAT'IYAN TAQIQLANADI! Foydalanuvchiga faqat ushbu xatolikni bildiring.`,
                },
              ],
              details: { success: false, error: result.error, needsLogin: result.needsLogin },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `### ChatGPT (chatgpt.com) Response:\n\n${result.text}${CONSULT_FOLLOWUP_NOTICE}`,
              },
            ],
            details: {
              success: true,
              chatUrl: result.chatUrl,
              responseLength: result.text.length,
            },
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("closed") || errMsg.includes("Target page")) {
            await browserManager.close(true);
          }
          return {
            content: [{ type: "text", text: `[ChatGPT Error]: ${errMsg}` }],
            details: { success: false, error: errMsg },
          };
        } finally {
          browserManager.endOp();
          resetIdleAutoClose(25000);
        }
      });
    },
  });

  // ── Tool: consult_gemini ─────────────────────────────────────────────
  pi.registerTool({
    name: "consult_gemini",
    label: "Consult Gemini",
    description:
      "Send a question or technical discussion prompt to Google Gemini (gemini.google.com) in the user's logged-in browser account, wait for Gemini's response, and return the answer. Supports '4 Argon', '3.1 Pro', '3.8 Flash' and reasoning levels ('Высокая', 'Средний', 'Низкая').",
    promptSnippet: "Consult Google Gemini (Argon) in the browser before writing code or making design decisions",
    promptGuidelines: [
      "CRITICAL: When consulting Gemini (Argon) about work, architecture, or scripts:",
      "  - NEVER pass the user's raw conversational command or meta-instructions into the prompt!",
      "  - YOU MUST inspect the codebase/session, include the actual code/scripts/configurations in the prompt, and formulate an in-depth technical review request as a senior engineer.",
      ...CONSULT_MULTI_TURN_GUIDELINES,
      "Gemini 4 Argon is Google's newest flagship reasoning model for complex code, math, and architecture.",
      "Supports reasoning levels: 'Высокая' (Deep/Глубокий), 'Средний', 'Низкая'. Default is 'Высокая'.",
      "You can have a multi-turn discussion with Gemini by making follow-up calls with newChat: false.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The question, architecture problem, or context to send to Gemini",
      }),
      model: Type.Optional(
        Type.String({
          description: "Gemini model name: '4 Argon', '3.1 Pro', '3.8 Flash', '3.5 Flash-Lite'. Default: '4 Argon'.",
        }),
      ),
      reasoning: Type.Optional(
        Type.Union(
          [Type.Literal("Высокая"), Type.Literal("Средний"), Type.Literal("Низкая")],
          {
            description: "Reasoning level for Gemini 4 Argon: 'Высокая' (Deep/Глубокий), 'Средний', 'Низкая'. Default: 'Высокая'.",
          },
        ),
      ),
      newChat: Type.Optional(
        Type.Boolean({
          description: "Start a fresh conversation (true) or continue current (false). Default: false.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          description: "Maximum seconds to wait for Gemini response (default: 180)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx?: any) {
      const validation = validateConsultPrompt(params.prompt);
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: validation.error! }],
          details: { success: false, error: validation.error },
        };
      }

      const { text: safePrompt, redactedCount, redactedTypes } = SecretRedactor.redact(params.prompt);
      if (redactedCount > 0 && ctx?.ui?.notify) {
        ctx.ui.notify(
          `🔒 [Xavfsizlik]: So'rovdagi ${redactedCount} ta maxfiy ma'lumot (${redactedTypes.join(", ")}) avtomatik tarzda [REDACTED] qilindi!`,
          "info",
        );
      }

      cancelIdleAutoClose();
      browserManager.beginOp();
      return await browserManager.serialize(async () => {
        try {
          const page = await browserManager.getGeminiPage(params.newChat ?? false);
          const result = await GeminiProvider.consult(page, safePrompt, {
            model: params.model ?? "4 Argon",
            reasoning: params.reasoning ?? "Высокая",
            newChat: params.newChat ?? false,
            timeoutSeconds: params.timeoutSeconds,
          });
          resetIdleAutoClose(25000);

          if (!result.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `🛑 [GEMINI XATOSI]: ${result.error || "Unknown error occurred"}\n\n[QAT'IY QOIDA]: Gemini javob bermadi! Sizga 'Katta AI tavsiyasi'ni o'zingiz to'qib chiqarish (fabricate/fake qilish) QAT'IYAN TAQIQLANADI! Foydalanuvchiga faqat ushbu xatolikni bildiring.`,
                },
              ],
              details: { success: false, error: result.error },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `### Gemini (${result.modelUsed ?? "4 Argon"}, ${result.reasoningUsed ?? "Высокая"}) Response:\n\n${result.text}${CONSULT_FOLLOWUP_NOTICE}`,
              },
            ],
            details: {
              success: true,
              modelUsed: result.modelUsed,
              reasoningUsed: result.reasoningUsed,
              responseLength: result.text.length,
            },
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("closed") || errMsg.includes("Target page")) {
            await browserManager.close(true);
          }
          return {
            content: [{ type: "text", text: `[Gemini Error]: ${errMsg}` }],
            details: { success: false, error: errMsg },
          };
        } finally {
          browserManager.endOp();
          resetIdleAutoClose(25000);
        }
      });
    },
  });

  // ── Tool: consult_ai ─────────────────────────────────────────────────
  pi.registerTool({
    name: "consult_ai",
    label: "Consult AI",
    description: "Consult either Claude or ChatGPT in the user's browser account.",
    promptSnippet: "Consult Claude or ChatGPT in the browser",
    parameters: Type.Object({
      provider: Type.Union([Type.Literal("claude"), Type.Literal("chatgpt"), Type.Literal("gemini")], {
        description: "Which AI to consult ('claude', 'chatgpt', or 'gemini')",
      }),
      prompt: Type.String({ description: "Question or discussion prompt" }),
      model: Type.Optional(Type.String({ description: "Model name (e.g. 'Sonnet', 'Opus', 'Haiku')" })),
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
            description: "Reasoning effort level for Claude (Low, Medium, High, Extra, Max). Default: High.",
          },
        ),
      ),
      newChat: Type.Optional(Type.Boolean({ description: "Start new conversation" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx?: any) {
      const validation = validateConsultPrompt(params.prompt);
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: validation.error! }],
          details: { success: false, error: validation.error },
        };
      }

      const { text: safePrompt, redactedCount, redactedTypes } = SecretRedactor.redact(params.prompt);
      if (redactedCount > 0 && ctx?.ui?.notify) {
        ctx.ui.notify(
          `🔒 [Xavfsizlik]: So'rovdagi ${redactedCount} ta maxfiy ma'lumot (${redactedTypes.join(", ")}) avtomatik tarzda [REDACTED] qilindi!`,
          "info",
        );
      }

      if (params.provider === "claude") {
        const page = await browserManager.getClaudePage(params.newChat ?? false);
        const res = await ClaudeProvider.consult(page, safePrompt, {
          newChat: params.newChat ?? false,
          timeoutSeconds: params.timeoutSeconds,
          effort: params.effort ?? "High",
          model: params.model ?? "Sonnet",
        });
        return {
          content: [
            {
              type: "text",
              text: res.success
                ? `### Claude Response [Effort: ${params.effort ?? "High"}]:\n\n${res.text}`
                : `[Error]: ${res.error}`,
            },
          ],
          details: res,
        };
      } else if (params.provider === "gemini") {
        const page = await browserManager.getGeminiPage(params.newChat ?? false);
        const res = await GeminiProvider.consult(page, safePrompt, {
          newChat: params.newChat ?? false,
          timeoutSeconds: params.timeoutSeconds,
          model: params.model ?? "4 Argon",
        });
        return {
          content: [
            {
              type: "text",
              text: res.success ? `### Gemini Response:\n\n${res.text}` : `[Error]: ${res.error}`,
            },
          ],
          details: res,
        };
      } else {
        const page = await browserManager.getChatGPTPage(params.newChat ?? false);
        const res = await ChatGPTProvider.consult(page, safePrompt, {
          newChat: params.newChat ?? false,
          timeoutSeconds: params.timeoutSeconds,
        });
        return {
          content: [
            {
              type: "text",
              text: res.success ? `### ChatGPT Response:\n\n${res.text}` : `[Error]: ${res.error}`,
            },
          ],
          details: res,
        };
      }
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
