export interface RedactionResult {
  text: string;
  redactedCount: number;
  redactedTypes: string[];
}

export class SecretRedactor {
  // 1. Private Keys (RSA, OpenSSH, EC, PGP PRIVATE KEY BLOCK, up to 32KB)
  private static readonly PRIVATE_KEY_REGEX =
    /-----BEGIN ((?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?)-----[\s\S]{0,32768}?(?:-----END \1-----|$)/gi;

  // 2. Database & Network URIs (e.g., postgresql://user:password@host, redis://:password@host)
  // Handles empty usernames (like Redis) and complex password characters
  private static readonly URI_CREDENTIALS_REGEX =
    /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/)([^\s:\/@"'`]*):([^\s\/"'`]+)@(?=[^\s@\/"'`]+)/gi;

  // 3. HTTP Authorization Headers (Bearer, Basic, Token, Digest)
  private static readonly AUTH_HEADER_REGEX =
    /(\b(?:Proxy-)?Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token|Digest)\s+)[^\s"',;]{8,}/gi;

  // 4. CLI flags (e.g. --password "xyz", --token=abc, --api-key 123)
  private static readonly CLI_FLAG_REGEX =
    /(--(?:password|passwd|token|secret|api-key|client-secret)(?:=|\s+))(?:"[^"\n]*"|'[^'\n]*'|(?!-)\S+)/gi;

  // 5. High-Entropy Tokens & Specific Cloud API Keys (using lookbehind to prevent \b _ boundary bugs)
  private static readonly KNOWN_TOKEN_PATTERNS: Array<{ type: string; regex: RegExp; placeholder: string }> = [
    // AWS Access Key ID
    { type: "AWS Access Key", regex: /(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Z0-9])/g, placeholder: "[REDACTED_AWS_KEY]" },
    // Anthropic / OpenAI API keys (sk-ant-..., sk-proj-..., sk-...)
    { type: "AI API Key", regex: /(?<![A-Za-z0-9_-])sk-(?:ant-api\d\d-[A-Za-z0-9_-]{80,}|proj-[A-Za-z0-9_-]{60,}|[A-Za-z0-9_-]{32,})(?![A-Za-z0-9_-])/g, placeholder: "[REDACTED_AI_API_KEY]" },
    // GitHub Tokens (Classic ghp_..., fine-grained github_pat_...)
    { type: "GitHub Token", regex: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})(?![A-Za-z0-9_])/g, placeholder: "[REDACTED_GITHUB_TOKEN]" },
    // GitLab Tokens (glpat-, glptt-, glrt-, GR1348941...)
    { type: "GitLab Token", regex: /(?<![A-Za-z0-9])(?:gl(?:pat|ptt|rt|dt|cbt|imt|agent|soat|ft)-[A-Za-z0-9_-]{20,}|GR1348941[A-Za-z0-9_-]{20})(?![A-Za-z0-9_-])/g, placeholder: "[REDACTED_GITLAB_TOKEN]" },
    // Google Cloud / Firebase API Keys
    { type: "Google API Key", regex: /(?<![A-Za-z0-9])(?:AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})(?![A-Za-z0-9_-])/g, placeholder: "[REDACTED_GOOGLE_KEY]" },
    // Telegram Bot Token (covers bot123456... URL format too)
    { type: "Telegram Bot Token", regex: /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, placeholder: "[REDACTED_TELEGRAM_BOT_TOKEN]" },
    // Stripe API Keys (sk_live_..., rk_live_...)
    { type: "Stripe Key", regex: /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[0-9A-Za-z]{24,}/g, placeholder: "[REDACTED_STRIPE_KEY]" },
    // Slack Tokens & Webhooks
    { type: "Slack Token", regex: /(?<![A-Za-z0-9])(?:xox[abdeoprs]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)/g, placeholder: "[REDACTED_SLACK_TOKEN]" },
    // NPM / HuggingFace / Docker / PyPI / Vault
    { type: "Dev Token", regex: /(?<![A-Za-z0-9])(?:npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{34,}|dckr_pat_[A-Za-z0-9_-]{20,}|hv[sbr]\.[A-Za-z0-9_-]{24,})/g, placeholder: "[REDACTED_DEV_TOKEN]" },
    // JWT Token
    { type: "JWT Token", regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, placeholder: "[REDACTED_JWT]" },
    // Base64-encoded PEM ("-----BEGIN")
    { type: "Base64 PEM", regex: /(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/=]{40,}/g, placeholder: "[REDACTED_B64_PEM]" },
  ];

  // Wordlists for Smart Key Detection (avoids false positives on max_tokens, token_count, private_key_path)
  private static readonly SECRET_WORDS = new Set([
    "password", "passwd", "pass", "pwd", "passphrase", "secret", "token", "apikey",
    "credential", "credentials", "auth", "authorization", "client_secret"
  ]);

  private static readonly NON_SECRET_WORDS = new Set([
    "max", "min", "num", "count", "limit", "type", "length", "expires", "expiry", "ttl",
    "url", "path", "file", "id", "name", "size", "endpoint", "header", "format", "dir", "version"
  ]);

  // Generic assignment pattern (supports yaml, json, env, bash, python, js, etc.)
  private static readonly ASSIGNMENT_REGEX =
    /(?<![\w.-])([a-zA-Z0-9_.-]{1,80})(\\?["']?\s*(?::=|=>|={1,3}|:)\s*)(\\?["'`]?)([^\n\r]*)/g;

  // Patterns that indicate a value is a code reference, template, or safe placeholder - NOT a raw secret
  private static readonly SAFE_VALUE_PATTERN =
    /^\s*(?:\$\{\s*|\{\{\s*|<[^>]*>$|%\w+%|(?:process\.env|os\.environ|os\.getenv|System\.getenv|ENV\b|config\.|settings\.|self\.|this\.)|[A-Za-z_][\w.]*\(|ENC\[|vault:|\*{3,}$|(?:string|number|str|int|bool\w*|any|unknown)\b|(?:true|false|null|none|undefined|changeme)$|\[REDACTED|<REDACTED)/i;

  public static isSecretKeyName(key: string): boolean {
    const segments = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

    // If key contains non-secret qualifiers (e.g. max_tokens, private_key_path, token_count), skip it!
    if (segments.some((x) => this.NON_SECRET_WORDS.has(x))) {
      return false;
    }

    const joined = segments.join("_");
    const hasSecretWord = segments.some((x) => this.SECRET_WORDS.has(x));
    const hasSecretCompound = /(?:^|_)(?:api_key|private_key|access_key|secret_key|signing_key|client_secret|key_data)(?:_|$)/.test(joined);

    return hasSecretWord || hasSecretCompound;
  }

  /**
   * Scans text, detects secrets, passwords, private keys and tokens,
   * replacing them with safe placeholders while keeping the code/config structure intact.
   */
  public static redact(input: string): RedactionResult {
    if (!input) {
      return { text: "", redactedCount: 0, redactedTypes: [] };
    }

    let result = input;
    let count = 0;
    const typesSet = new Set<string>();

    // 1. Redact Private Keys (RSA, EC, OpenSSH, PGP Block up to 32KB)
    result = result.replace(this.PRIVATE_KEY_REGEX, () => {
      count++;
      typesSet.add("Private Key");
      return "[REDACTED_PRIVATE_KEY]";
    });

    // 2. Redact URIs with credentials (e.g., postgres://user:pass@host/db, redis://:pass@host)
    result = result.replace(this.URI_CREDENTIALS_REGEX, (_match, proto, user, _pass) => {
      count++;
      typesSet.add("Database URI Password");
      return `${proto}${user}:[REDACTED_PASSWORD]@`;
    });

    // 3. Redact Authorization Headers
    result = result.replace(this.AUTH_HEADER_REGEX, (_match, prefix) => {
      count++;
      typesSet.add("Authorization Header");
      return `${prefix}[REDACTED_TOKEN]`;
    });

    // 4. Redact CLI flags (--password "xyz", --token=abc)
    result = result.replace(this.CLI_FLAG_REGEX, (_match, prefix) => {
      count++;
      typesSet.add("CLI Secret Flag");
      return `${prefix}[REDACTED_SECRET]`;
    });

    // 5. Redact High-Entropy Tokens & API Keys
    for (const item of this.KNOWN_TOKEN_PATTERNS) {
      result = result.replace(item.regex, (m) => {
        if (m.includes("REDACTED") || m.includes("example") || m.includes("your-")) {
          return m;
        }
        count++;
        typesSet.add(item.type);
        return item.placeholder;
      });
    }

    // 6. Generic Assignment Redaction with Smart Key Classification
    result = result.replace(this.ASSIGNMENT_REGEX, (fullMatch, keyName, sep, quote, rawRest) => {
      if (!this.isSecretKeyName(keyName)) {
        return fullMatch;
      }

      const rest = rawRest.trim();
      if (!rest || rest.length < 3) {
        return fullMatch;
      }

      // Check if value is a reference, variable, type declaration, or safe placeholder
      if (this.SAFE_VALUE_PATTERN.test(rest)) {
        return fullMatch;
      }

      // If quoted: redact up to the closing quote
      if (quote) {
        const closeQuoteIdx = rawRest.indexOf(quote);
        if (closeQuoteIdx !== -1) {
          const val = rawRest.slice(0, closeQuoteIdx);
          if (this.SAFE_VALUE_PATTERN.test(val.trim())) {
            return fullMatch;
          }
          count++;
          typesSet.add("Config/Env Secret");
          const remainder = rawRest.slice(closeQuoteIdx + 1);
          return `${keyName}${sep}${quote}[REDACTED_SECRET]${quote}${remainder}`;
        }
      }

      // If unquoted (e.g. YAML, ENV, Bash): preserve any trailing comments (#, //)
      let secretValue = rawRest;
      let trailingComment = "";
      const commentIdx = rawRest.search(/\s+(?:#|\/\/)/);
      if (commentIdx !== -1) {
        secretValue = rawRest.slice(0, commentIdx).trim();
        trailingComment = rawRest.slice(commentIdx);
      } else {
        secretValue = secretValue.trim();
      }

      // Final check on stripped unquoted value
      if (this.SAFE_VALUE_PATTERN.test(secretValue)) {
        return fullMatch;
      }

      // Don't redact trailing commas, semicolons, brackets in JSON/JS: e.g. "secret": "xyz",
      const cleanTrailing = secretValue.match(/[,;}]+$/);
      let suffix = "";
      if (cleanTrailing) {
        suffix = cleanTrailing[0];
        secretValue = secretValue.slice(0, -suffix.length);
      }

      count++;
      typesSet.add("Config/Env Secret");
      return `${keyName}${sep}[REDACTED_SECRET]${suffix}${trailingComment}`;
    });

    return {
      text: result,
      redactedCount: count,
      redactedTypes: Array.from(typesSet),
    };
  }
}
