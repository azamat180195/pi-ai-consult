// language-guard.ts
// Invariant: INSTRUCTIONS to external AI must be in technical English.
// Quoted DATA (Android UI strings, device settings, logs, error messages) may be foreign in bounded amounts.

export interface LangStats {
  proseLetters: number;
  proseCyrLetters: number;
  proseCyrWords: number;
  proseRatio: number;
  longestCyrRun: number;
  quotedCyrLetters: number;
  uzLatinHits: number;
  offenders: string[];
}

export type LangVerdict =
  | { ok: true; stats?: LangStats }
  | { ok: false; reason: string; stats?: LangStats };

export const LANG_LIMITS = {
  maxPromptChars: 200_000,
  maxProseCyrRatio: 0.08,     // Max 8% Cyrillic in unquoted author prose
  maxStrayCyrWords: 2,        // Tolerate 1-2 glossed Cyrillic words in prose
  maxCyrRun: 3,               // 4+ consecutive Cyrillic words in unquoted prose = a foreign sentence
  maxQuotedSpan: 160,         // Max chars per quoted UI span
  maxQuotedCyrLetters: 800,   // Max total quoted Cyrillic letters across the prompt
  maxQuotedToProseLatin: 3,   // Quoted Cyrillic cannot outweigh English prose 3:1
  uzLatinMinHits: 4,          // Distinct Uzbek-Latin stop words in prose
} as const;

const RE_CYR_ALL = /[\u0400-\u04FF]/g;
const RE_CYR_ONE = /[\u0400-\u04FF]/;
const RE_LETTER_ALL = /\p{L}/gu;
const RE_LATIN_ALL = /\p{Script=Latin}/gu;
const RE_WORD = /\p{L}[\p{L}\p{M}]*(?:['’ʻʼ-][\p{L}\p{M}]+)*/gu;

const FENCE = /(```|~~~)[\s\S]*?\1/g;
const INLINE = /`[^`\n]*`/g;
const URL_RE = /https?:\/\/\S+/g;
const PATH_RE = /(?:\/|~\/|[A-Za-z]:[\\\/])[\w.\-\/]+/g;

const Q = LANG_LIMITS.maxQuotedSpan;
const QUOTED = new RegExp(
  [
    `"[^"\\n]{1,${Q}}"`,
    `“[^”\\n]{1,${Q}}”`,
    `«[^»\\n]{1,${Q}}»`,
    `„[^“”\\n]{1,${Q}}[“”]`,
    `‘[^’\\n]{1,${Q}}’`,
    `(?<![\\p{L}\\p{N}])'[^'\\n]{1,${Q}}'(?![\\p{L}\\p{N}])`,
  ].join("|"),
  "gu",
);

const UZ_LATIN_STOP = new Set([
  "uchun", "bilan", "emas", "lekin", "ammo", "kerak", "mumkin", "qanday", "nima",
  "qilib", "yoki", "bo'lib", "bo'lsa", "hamda", "uning", "mening", "sizning",
  "shuning", "chunki", "agar", "qilish", "qilingan", "yordam", "haqida", "bolsa",
  "xato", "iltimos", "qanaqa", "shuni", "nimani",
]);

const EN_STOP = new Set([
  "the", "and", "is", "are", "to", "of", "in", "for", "with", "that", "this",
  "please", "from", "not", "on", "it", "we", "i", "you", "can", "be", "as",
  "at", "by", "an", "have", "has", "should", "would", "could", "verify", "check",
  "analyze", "code", "file", "error", "how", "what", "why", "which", "when",
  "where", "do", "does", "explain", "review", "test", "fix", "issue", "problem",
]);

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const FIX_MSG =
  "External AI queries (ChatGPT/Claude/Gemini) must be written in English for maximum reasoning quality. " +
  'Quote foreign UI labels, device settings, or logs inside backticks or "quotes" (<=160 chars each). ' +
  "(The final response to the user remains in Uzbek).";

/**
 * Extract all plain string values from an arbitrary object/array (e.g. brief)
 * so we don't scan JSON syntax keys/quotes.
 */
export function flattenStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) flattenStrings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) flattenStrings(x, out, depth + 1);
  return out;
}

export function checkEnglish(input: string | string[]): { ok: boolean; reason?: string } {
  const joined = (Array.isArray(input) ? input.join("\n\n") : (input || "")).normalize("NFC");
  if (!joined.trim()) return { ok: true };

  let text = joined.length > LANG_LIMITS.maxPromptChars ? joined.slice(0, LANG_LIMITS.maxPromptChars) : joined;

  // 1. Exempt code blocks, inline code, URLs, and file paths
  text = text.replace(FENCE, " ").replace(INLINE, " ").replace(URL_RE, " ").replace(PATH_RE, " ");

  // 2. Exempt short plain-quoted spans (e.g. "Автозапуск", "Связанный старт", "Работа в фоне")
  let quotedCyr = 0;
  text = text.replace(QUOTED, (m) => {
    const n = count(m, RE_CYR_ALL);
    if (n > 0) {
      quotedCyr += n;
      return " ";
    }
    return m;
  });

  // 3. Evaluate the remaining unquoted author prose
  const proseLetters = count(text, RE_LETTER_ALL);
  const proseLatin = count(text, RE_LATIN_ALL);
  const proseCyr = count(text, RE_CYR_ALL);

  if (proseLetters < 20) {
    // Very short snippet or dominated by quoted data/code
    return { ok: true };
  }

  const words = text.match(RE_WORD) ?? [];
  let cyrWords = 0;
  let enWords = 0;
  let run = 0;
  let longest = 0;
  const offenders: string[] = [];
  const uz = new Set<string>();

  for (const w of words) {
    if (RE_CYR_ONE.test(w)) {
      cyrWords++;
      run++;
      if (run > longest) longest = run;
      if (offenders.length < 5) offenders.push(w);
    } else {
      run = 0;
      const k = w.toLowerCase().replace(/[’ʻʼ]/g, "'");
      if (UZ_LATIN_STOP.has(k)) uz.add(k);
      if (EN_STOP.has(k)) enWords++;
    }
  }

  const ratio = proseLetters > 0 ? proseCyr / proseLetters : 0;
  const L = LANG_LIMITS;

  // Unquoted prose has genuine Cyrillic sentences or high concentration
  if ((cyrWords > L.maxStrayCyrWords && ratio > L.maxProseCyrRatio) || longest > L.maxCyrRun) {
    return {
      ok: false,
      reason: `Unquoted Cyrillic text detected in instructions (${cyrWords} words, e.g. ${offenders.map((o) => `«${o}»`).join(" ")}). ${FIX_MSG}`,
    };
  }

  // Quoted Cyrillic is so massive it dwarfs English instructions
  if (quotedCyr > L.maxQuotedCyrLetters || (proseLatin > 0 && quotedCyr > L.maxQuotedToProseLatin * proseLatin)) {
    return {
      ok: false,
      reason: `Too much raw Cyrillic data (${quotedCyr} letters) relative to English instructions. Put large logs in fenced code blocks. ${FIX_MSG}`,
    };
  }

  // Uzbek Latin stop words check in prose
  if (uz.size >= 2 && (uz.size >= L.uzLatinMinHits || (enWords === 0 && words.length >= 5))) {
    return {
      ok: false,
      reason: `Uzbek language text detected in instructions (${[...uz].join(", ")}). ${FIX_MSG}`,
    };
  }

  // No English words in a multi-word instruction
  if (words.length >= 8 && enWords === 0 && cyrWords === 0) {
    return {
      ok: false,
      reason: `No recognizable English words detected in instructions. ${FIX_MSG}`,
    };
  }

  return { ok: true };
}
