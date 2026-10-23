const UZ_STOP = new Set([
  "va",
  "bilan",
  "uchun",
  "emas",
  "qanday",
  "bu",
  "men",
  "siz",
  "biz",
  "lekin",
  "yoki",
  "agar",
  "kerak",
  "bor",
  "yoq",
  "yo'q",
  "nima",
  "ham",
  "endi",
  "buni",
  "shu",
  "uning",
  "mening",
  "xato",
  "iltimos",
  "bo'lsa",
  "bolsa",
  "qilib",
  "kerakmi",
  "qiling",
  "qilish",
  "tavsiya",
  "haqida",
  "javob",
  "qaysi",
  "boyicha",
  "bo'yicha",
  "masalasi",
  "maslahat",
  "maslahatlash",
  "maslahatlashib",
  "kor",
  "ko'r",
  "qandaydir",
  "shunday",
  "shuni",
  "nimani",
  "qanaqa",
]);

const EN_STOP = new Set([
  "the",
  "and",
  "is",
  "are",
  "to",
  "of",
  "in",
  "for",
  "with",
  "that",
  "this",
  "please",
  "from",
  "not",
  "on",
  "it",
  "we",
  "i",
  "you",
  "can",
  "be",
  "as",
  "at",
  "by",
  "an",
  "have",
  "has",
  "should",
  "would",
  "could",
  "verify",
  "check",
  "analyze",
  "code",
  "file",
  "error",
  "how",
  "what",
  "why",
  "which",
  "when",
  "where",
  "do",
  "does",
  "explain",
  "review",
]);

export function checkEnglish(prompt: string): { ok: boolean; reason?: string } {
  // Strip code blocks, inline code, URLs, and file paths so technical identifiers don't trigger false positives
  const text = prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:\/|~\/|[A-Za-z]:[\\\/])[\w.\-\/]+/g, " ");

  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 25) {
    // Very short technical snippet or command, allow it
    return { ok: true };
  }

  // 1. Cyrillic check (Russian or Uzbek Cyrillic)
  const cyr = (text.match(/[\u0400-\u04FF]/g) ?? []).length;
  if (cyr / letters.length > 0.03) {
    return {
      ok: false,
      reason: "Cyrillic (Russian/Uzbek) text detected. External AI queries must be written in English for maximum reasoning quality.",
    };
  }

  // 2. Uzbek Latin stop word check
  const words = text
    .toLowerCase()
    .replace(/[ʻʼ‘’´]/g, "'")
    .match(/[a-z']+/g) ?? [];

  const uz = words.filter((w) => UZ_STOP.has(w)).length;
  const en = words.filter((w) => EN_STOP.has(w)).length;
  const uzApos = (text.match(/\b[og][ʻʼ‘’`']\w/gi) ?? []).length; // o'z, g'alaba, o'sha

  if (uz + uzApos >= 2 && uz + uzApos > en * 0.25) {
    return {
      ok: false,
      reason: "Uzbek language text detected. Prompts sent to Claude/ChatGPT/Gemini MUST be in English. (The final response to the user will be in Uzbek).",
    };
  }

  if (words.length >= 6 && en === 0) {
    return {
      ok: false,
      reason: "No recognizable English words detected. Prompts sent to Claude/ChatGPT/Gemini MUST be in English.",
    };
  }

  if (words.length >= 20 && en / words.length < 0.06) {
    return {
      ok: false,
      reason: "Text does not appear to be English. External AI queries must be formulated in technical English.",
    };
  }

  return { ok: true };
}
