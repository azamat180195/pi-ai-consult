// consult-reconcile.ts
// Live DOM turn reconciliation for crash recovery (e.g. sudden laptop power-off / battery depletion).
// Inspects active chat threads to detect if the prompt was already answered in the cloud,
// preventing duplicate question submissions and saving quota.

import { createHash } from "node:crypto";
import type { Page } from "playwright-core";

export type ReconcileDecision = "REUSE" | "WAIT" | "SEND" | "UNCERTAIN";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface DomSnapshot {
  url: string;
  composerVisible: boolean;
  historyReady: boolean;
  activeGeneration: boolean;
  activeSignals: string[];
  turns: ChatTurn[];
  signature: string;
}

export interface ReconcileOptions {
  incomingPrompt: string;
  expectedConversationId?: string;
  waitTimeoutMs?: number;
  settleMs?: number;
  log?: (m: string) => void;
}

export interface ReconcileResult {
  decision: ReconcileDecision;
  answer?: string;
  reason: string;
  similarity?: number;
}

const SELECTORS = {
  user: '[data-message-author-role="user"]',
  assistant: '[data-message-author-role="assistant"]',
  composer: [
    "#prompt-textarea",
    'div[contenteditable="true"][role="textbox"]',
    "textarea[placeholder]",
    ".ProseMirror",
  ],
  stop: [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop streaming" i]',
    'button[aria-label*="Stop" i]',
  ],
  streaming: [
    ".result-streaming",
    '[data-is-streaming="true"]',
    '[data-message-author-role="assistant"][aria-busy="true"]',
    '[class*="streaming"]',
  ],
  loading: [
    '[data-testid*="conversation-loading"]',
    '[aria-label*="Loading conversation" i]',
  ],
  status: ['[role="status"]', '[aria-live="polite"]'],
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function canonicalizePrompt(input: string): string {
  let value = input.normalize("NFKC");

  // Strip leading recognized ai-consult metadata
  value = value.replace(/^\s*\[ai-consult\s*[·-][^\]\r\n]*\]\s*/i, "");

  // Strip standalone reference metadata lines
  value = value.replace(/^\s*\[ref\s+[a-z0-9_-]{4,}\]\s*$/gim, "");

  return value
    .toLowerCase()
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function promptHash(input: string): string {
  return createHash("sha256").update(canonicalizePrompt(input)).digest("hex");
}

function fiveWordShingles(text: string): Set<string> {
  const words = text.split(/\s+/).filter(Boolean);
  const result = new Set<string>();
  if (words.length < 5) {
    if (text.trim()) result.add(text.trim());
    return result;
  }
  for (let i = 0; i <= words.length - 5; i++) {
    result.add(words.slice(i, i + 5).join(" "));
  }
  return result;
}

export const STATIC_PREAMBLES: string[] = [
  "You are acting as a senior infrastructure and software architect performing a rigorous design review. Be direct and critical; disagree with me if my thinking is flawed.",
  "We request an architectural and UI/UX design review regarding",
  "We request an architectural and UI/UX design review",
];

const tokenize = (s: string): string[] =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length >= 3);

const PREAMBLE_TOKENS = new Set(STATIC_PREAMBLES.flatMap(tokenize));

export function stripWrappers(s: string): string {
  let t = s.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t.replace(/^\s*\[ai-consult\s*[·-][^\]\r\n]*\]\s*/gi, " ");
  t = t.replace(/^\s*\[ref\s+[a-z0-9_-]{4,}\]\s*$/gim, " ");
  t = t.replace(/---\s*\nRESPONSE PROTOCOL[\s\S]*$/gi, " ");
  t = t.replace(/\[ATTACHMENT MANIFEST:[\s\S]*?\]/gi, " ");
  for (const p of STATIC_PREAMBLES) t = t.split(p).join(" ");
  return t;
}

export const canonicalCore = (s: string) =>
  stripWrappers(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function coreTokens(prompt: string, max = 60): string[] {
  const uniq = Array.from(new Set(tokenize(stripWrappers(prompt)))).filter(
    (t) => !PREAMBLE_TOKENS.has(t) && (t.length >= 6 || /[0-9_.]/.test(t)),
  );
  return uniq.sort((a, b) => b.length - a.length).slice(0, max);
}

export interface TurnMatch {
  ok: boolean;
  score: number;
  head: number;
  tail: number;
  core: number;
  reason: string;
}

const MIN_SCORE = 0.97;
const MIN_SEGMENT = 0.9;
const MIN_CORE = 0.85;
const MIN_CORE_TOKENS = 6;
const SEG = 400;

export function promptSimilarity(a: string, b: string): number {
  const left = canonicalizePrompt(a);
  const right = canonicalizePrompt(b);

  if (left === right) return 1;

  const aWords = left.split(/\s+/).filter(Boolean);
  const bWords = right.split(/\s+/).filter(Boolean);

  if (Math.min(aWords.length, bWords.length) < 5) {
    return left === right ? 1 : 0;
  }

  const aShingles = fiveWordShingles(left);
  const bShingles = fiveWordShingles(right);

  const intersection = [...aShingles].filter((item) => bShingles.has(item)).length;
  const union = new Set([...aShingles, ...bShingles]).size;

  return union === 0 ? 0 : intersection / union;
}

export function matchUserTurn(prompt: string, turnText: string): TurnMatch {
  const bad = (reason: string, score = 0, head = 0, tail = 0, core = 0): TurnMatch => ({
    ok: false,
    score,
    head,
    tail,
    core,
    reason,
  });

  const a = canonicalCore(prompt);
  const b = canonicalCore(turnText);

  if (!a || !b) return bad("empty canonical form");
  if (a.split(" ").length < 6) {
    return a === b
      ? { ok: true, score: 1, head: 1, tail: 1, core: 1, reason: "exact (short prompt)" }
      : bad("short prompt differs");
  }

  const score = promptSimilarity(a, b);
  if (score < MIN_SCORE) return bad(`similarity ${score.toFixed(2)} < ${MIN_SCORE}`, score);

  let head = 1;
  let tail = 1;
  if (a.length >= SEG + 200 && b.length >= SEG + 200) {
    head = promptSimilarity(a.slice(0, SEG), b.slice(0, SEG));
    tail = promptSimilarity(a.slice(-SEG), b.slice(-SEG));
    if (head < MIN_SEGMENT) return bad(`head differs (${head.toFixed(2)})`, score, head, tail);
    if (tail < MIN_SEGMENT) return bad(`tail differs (${tail.toFixed(2)})`, score, head, tail);
  }

  let core = 1;
  const ct = coreTokens(prompt);
  if (ct.length >= MIN_CORE_TOKENS) {
    const have = new Set(tokenize(turnText));
    core = ct.filter((t) => have.has(t)).length / ct.length;
    if (core < MIN_CORE) return bad(`core keywords missing (${core.toFixed(2)})`, score, head, tail, core);
  }

  return {
    ok: true,
    score,
    head,
    tail,
    core,
    reason: `canonical ${score.toFixed(3)} head ${head.toFixed(2)} tail ${tail.toFixed(2)} core ${core.toFixed(2)}`,
  };
}

export async function readChatGPTSnapshot(page: Page): Promise<DomSnapshot> {
  return page.evaluate((selectors) => {
    const isVisible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0
      );
    };

    const queryVisible = (selector: string): Element[] =>
      Array.from(document.querySelectorAll(selector)).filter(isVisible);

    const composerVisible = selectors.composer.some(
      (selector) => queryVisible(selector).length > 0,
    );

    const stops = queryVisible(selectors.stop.join(","));
    const streaming = queryVisible(selectors.streaming.join(","));

    const statuses = queryVisible(selectors.status.join(","))
      .map((element) => element.textContent ?? "")
      .join("\n");

    const activeSignals: string[] = [];

    if (stops.length) {
      activeSignals.push("stop-button");
    }

    if (streaming.length) {
      activeSignals.push("streaming-marker");
    }

    if (
      /\b(thinking|searching the web|searching|reading sources|working|generating)\b/i.test(
        statuses,
      )
    ) {
      activeSignals.push("active-status");
    }

    const loading = queryVisible(selectors.loading.join(",")).length > 0;

    // Ordered DOM turns
    const nodes = Array.from(
      document.querySelectorAll(`${selectors.user},${selectors.assistant}`),
    ).filter(isVisible);

    const turns: ChatTurn[] = nodes.map((element) => ({
      role: element.matches(selectors.user) ? ("user" as const) : ("assistant" as const),
      text: (element as HTMLElement).innerText ? (element as HTMLElement).innerText.trim() : "",
    }));

    const historyReady = composerVisible && document.querySelector("main") !== null && !loading;

    const signature = JSON.stringify({
      turnsCount: turns.length,
      lastTurnLen: turns.length ? turns[turns.length - 1].text.length : 0,
      activeSignals,
      loading,
    });

    return {
      url: location.href,
      composerVisible,
      historyReady,
      activeGeneration: activeSignals.length > 0,
      activeSignals,
      turns,
      signature,
    };
  }, SELECTORS);
}

function assistantResponseAfter(turns: ChatTurn[], userIndex: number): string {
  const chunks: string[] = [];
  for (let i = userIndex + 1; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === "user") break;
    if (turn.role === "assistant" && turn.text.trim()) {
      chunks.push(turn.text.trim());
    }
  }
  return chunks.join("\n\n").trim();
}

async function waitForStableSnapshot(
  page: Page,
  settleMs: number,
  timeoutMs = 12_000,
): Promise<DomSnapshot | null> {
  const started = Date.now();
  let previousSignature = "";
  let stableSince = 0;

  while (Date.now() - started < timeoutMs) {
    const current = await readChatGPTSnapshot(page);

    if (current.activeGeneration) {
      previousSignature = "";
      stableSince = 0;
      await delay(400);
      continue;
    }

    if (current.signature !== previousSignature) {
      previousSignature = current.signature;
      stableSince = Date.now();
    }

    if (stableSince > 0 && Date.now() - stableSince >= settleMs) {
      return current;
    }

    await delay(400);
  }

  return null;
}

export async function reconcileChatGPTTurn(
  page: Page,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const {
    incomingPrompt,
    waitTimeoutMs = 15_000,
    settleMs = 1_500,
    log = () => {},
  } = options;

  const incoming = canonicalizePrompt(incomingPrompt);
  if (!incoming) {
    return {
      decision: "UNCERTAIN",
      reason: "Incoming prompt is empty after canonicalization.",
    };
  }

  const started = Date.now();

  while (Date.now() - started < waitTimeoutMs) {
    const snapshot = await readChatGPTSnapshot(page);

    if (!snapshot.historyReady && Date.now() - started < 8_000) {
      await delay(500);
      continue;
    }

    const userIndices = snapshot.turns
      .map((turn, index) => ({ turn, index }))
      .filter(({ turn }) => turn.role === "user")
      .map(({ index }) => index);

    const lastUserIndex = userIndices.at(-1);

    if (snapshot.activeGeneration) {
      log("[reconcile:chatgpt] Active generation in progress (stop button or streaming marker visible)");
      return {
        decision: "WAIT",
        reason: "Active cloud generation in progress. Resumed stream must be completed.",
      };
    }

    if (lastUserIndex === undefined) {
      return {
        decision: "SEND",
        reason: "No user turns in thread history. Proceed with prompt submission.",
      };
    }

    // Check exact canonical match against the LAST user turn
    const lastUserText = canonicalizePrompt(snapshot.turns[lastUserIndex].text);
    const isExactMatch = lastUserText === incoming;
    const similarity = promptSimilarity(incoming, lastUserText);

    if (isExactMatch || similarity >= 0.97) {
      const answer = assistantResponseAfter(snapshot.turns, lastUserIndex);

      if (!answer) {
        log("[reconcile:chatgpt] Matching user turn found but assistant response not yet rendered");
        return {
          decision: "WAIT",
          reason: "Matching user turn exists, waiting for assistant response to render.",
        };
      }

      // Verify stability across settleMs
      const stableSnapshot = await waitForStableSnapshot(page, settleMs, 6_000);
      if (stableSnapshot) {
        const stableUserIndex = stableSnapshot.turns
          .map((turn, index) => ({ turn, index }))
          .filter(({ turn }) => turn.role === "user")
          .map(({ index }) => index)
          .at(-1);

        if (stableUserIndex !== undefined) {
          const stableAnswer = assistantResponseAfter(stableSnapshot.turns, stableUserIndex);
          if (stableAnswer && stableAnswer.length > 50) {
            log(`[reconcile:chatgpt] Successfully REUSED completed response (${stableAnswer.length} chars)`);
            return {
              decision: "REUSE",
              answer: stableAnswer,
              similarity: isExactMatch ? 1.0 : similarity,
              reason: `Exact or high similarity (${similarity.toFixed(2)}) match with settled assistant turn.`,
            };
          }
        }
      }

      return {
        decision: "REUSE",
        answer,
        similarity,
        reason: "Matching user turn with existing assistant response.",
      };
    }

    // If last user turn differs, safe to submit fresh prompt
    return {
      decision: "SEND",
      similarity,
      reason: `Last user turn differs from incoming prompt (similarity ${similarity.toFixed(2)}).`,
    };
  }

  return {
    decision: "SEND",
    reason: "Reconciliation timeout reached. Fall back to standard submission.",
  };
}
