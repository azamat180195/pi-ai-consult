export type ConsultState = "FINAL" | "NEED_INFO" | "UNCERTAIN";
export type NeedKind = "command_output" | "file" | "log" | "config" | "code" | "clarification";

export interface InfoNeed {
  id: string;
  kind: NeedKind;
  what: string;
  how?: string;
}

export interface ParsedReply {
  state: ConsultState | "UNKNOWN";
  needs: InfoNeed[];
  source: "protocol" | "heuristic";
  lint: string[];
  body: string;
}

export const MAX_ROUNDS = Number(process.env.AI_CONSULT_MAX_ROUNDS ?? 8);

// Appended to every outgoing prompt in English
export const PROTOCOL_FOOTER = `
---
RESPONSE PROTOCOL (mandatory). Reply in English. End your reply with exactly one block:
CONSULT_STATUS_BEGIN
state: FINAL | NEED_INFO | UNCERTAIN
needs:
- id: R1 | kind: command_output|file|log|config|code|clarification | what: <one line> | how: <exact read-only command or file path, or n/a>
CONSULT_STATUS_END
Rules:
- FINAL only if you need nothing else AND every claim is verified or explicitly marked as an assumption.
- If anything is missing, ambiguous or unverified, use NEED_INFO or UNCERTAIN and list EVERY item you need in one go.
- Never request information in prose without also listing it in the block.
- Prefer read-only commands (cat, grep, ls, pkg -n, git diff, pfctl -sr). Provide exact commands.`;

const BLOCK_RE = /CONSULT_STATUS_BEGIN([\s\S]*?)CONSULT_STATUS_END/g;

const ASK_RE =
  /\b(send|share|paste|provide|post|show|upload|attach|run|check|give me|let me know|if you can|can you|could you)\b[^.?!\n]{0,120}\b(output|result|results|log|logs|config|configuration|file|snippet|diff|dump|grep|version|status|trace|error|contents?)\b/i;

const HEDGE_RE = /\b(i think|probably|might|maybe|not sure|i'?m not certain|should work|presumably)\b/gi;

function lintBody(b: string): string[] {
  const out: string[] = [];
  if (((b.match(/^```/gm) ?? []).length) % 2) {
    out.push("Unbalanced code fence (reply truncated?)");
  }
  for (const m of b.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    try {
      JSON.parse(m[1]);
    } catch (e) {
      out.push(`Invalid JSON block: ${(e as Error).message}`);
    }
  }
  if (/<(YOUR|REPLACE|INSERT)[A-Z_ -]*>|\bTODO\b|^\s*\.\.\.\s*$/m.test(b)) {
    out.push("Unresolved placeholder/ellipsis in code block");
  }
  if ((b.match(HEDGE_RE) ?? []).length >= 4) {
    out.push("Heavy hedging detected: claims may be unverified");
  }
  return out;
}

function looksLikeCommand(s: string): boolean {
  return /^(grep|cat|ls|find|pkg|git|docker|kubectl|systemctl|journalctl|head|tail|sed|awk|ssh|curl|ip|ss|netstat|pfctl|ps|df|du|uname|dmesg|openssl|diff)\b/.test(
    s.trim(),
  );
}

export function parseReply(raw: string): ParsedReply {
  const body = raw.replace(BLOCK_RE, "").trim();
  const lint = lintBody(body);
  const matches = [...raw.matchAll(BLOCK_RE)];
  const last = matches.length > 0 ? matches[matches.length - 1] : null;

  if (last) {
    const txt = last[1];
    const stMatch = /state:\s*(FINAL|NEED_INFO|UNCERTAIN)/i.exec(txt);
    const st = stMatch ? (stMatch[1].toUpperCase() as ConsultState) : undefined;
    const needs: InfoNeed[] = [];

    for (const line of txt.split("\n")) {
      const m = /^\s*[-•*]\s*id:\s*(\S+)\s*\|\s*kind:\s*(\w+)\s*\|\s*what:\s*(.+?)\s*(?:\|\s*how:\s*(.+?))?\s*$/i.exec(
        line,
      );
      if (m) {
        needs.push({
          id: m[1],
          kind: m[2].toLowerCase() as NeedKind,
          what: m[3].trim(),
          how: m[4] && m[4].toLowerCase() !== "n/a" ? m[4].trim() : undefined,
        });
      }
    }

    if (st) {
      const state = st === "FINAL" && lint.length > 0 ? "UNCERTAIN" : st;
      return { state, needs, source: "protocol", lint, body };
    }
  }

  // ---- Heuristic Fallback (protocol block missing) ----
  const tail = body.slice(-1500);
  const asks = ASK_RE.test(tail) || /\?\s*$/.test(tail.trim());
  const needs: InfoNeed[] = [];
  let n = 0;

  for (const m of tail.matchAll(/(?:^|[\s`(])((?:\/|~\/|[A-Za-z]:[\\\/])[\w.\-\/]+)/g)) {
    needs.push({
      id: `H${++n}`,
      kind: "file",
      what: `Contents/status of ${m[1]}`,
      how: `cat ${m[1]}`,
    });
  }

  for (const m of tail.matchAll(/`([^`\n]{3,200})`/g)) {
    if (looksLikeCommand(m[1])) {
      needs.push({
        id: `H${++n}`,
        kind: "command_output",
        what: `Output of: ${m[1]}`,
        how: m[1],
      });
    }
  }

  if (asks && needs.length === 0) {
    const lastLine = tail.trim().split(/\n+/).pop()?.slice(0, 200) || "Clarification needed";
    needs.push({
      id: "H1",
      kind: "clarification",
      what: lastLine,
    });
  }

  return {
    state: asks || needs.length > 0 ? "NEED_INFO" : lint.length > 0 ? "UNCERTAIN" : "UNKNOWN",
    needs,
    source: "heuristic",
    lint,
    body,
  };
}

// Ensure external model's requested commands are safe and read-only
export function isReadOnlyCommand(cmd: string): boolean {
  const c = cmd.trim();
  // Forbidden destructive or modifying commands anywhere in the command
  if (
    /(?:^|[;&|`\s])(rm|mv|dd|mkfs|chmod|chown|kill|reboot|shutdown|pkg\s+(install|upgrade|delete)|apt\s+(install|remove|purge)|systemctl\s+(restart|stop|start|enable|disable))\b/i.test(
      c,
    )
  ) {
    return false;
  }
  if (/(>|>>|\btee\b|\bsed\s+-i\b|\brm\b|\bmv\b|\bcurl\b.*\|\s*(sh|bash))/i.test(c)) {
    return false;
  }
  return looksLikeCommand(c);
}
