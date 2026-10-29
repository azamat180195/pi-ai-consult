import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

export type ProviderId = "claude" | "chatgpt" | "gemini";

// Conservative internal limits, safe for all web UIs
export const IMAGE_LIMITS = { maxFiles: 5, maxBytesEach: 10 * 1024 * 1024, maxBytesTotal: 25 * 1024 * 1024 };

const SUPPORTED: Record<ProviderId, ReadonlySet<string>> = {
  chatgpt: new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  claude: new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  gemini: new Set(["image/png", "image/jpeg", "image/webp"]),
};

export interface ImageFile {
  absPath: string;
  name: string;          // unique, extension corrected from magic bytes
  mime: string;
  bytes: number;
  sha256: string;
  origin: "explicit" | "auto";
  outsideRoots: boolean; // outside cwd/tmp
}

export interface ResolveResult {
  images: ImageFile[];
  errors: string[];       // fatal (explicit path bad)
  warnings: string[];
  skipped: string[];
  missingMentions: string[];
}

export interface ResolveOpts {
  provider: ProviderId;
  explicit?: string[];
  prompt: string;
  cwd: string;
  autoAttach?: boolean;          // default true
  extraRoots?: string[];
  limits?: Partial<typeof IMAGE_LIMITS>;
}

/* ---------------- mention extraction ---------------- */
const EXT = "png|jpe?g|webp|gif|bmp|heic";
const QUOTED = new RegExp(`(["'\`])((?:[A-Za-z]:)?[^"'\`\\r\\n]{1,400}?\\.(?:${EXT}))\\1`, "gi");
// bare tokens: optional drive/./../~/root prefix; never matches inside URLs
const BARE = new RegExp(
  `(?<![\\w./\\\\:~@%+=-])((?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?[\\w@%+=.\\-\\\\/]+?\\.(?:${EXT}))(?![\\w])`,
  "gi",
);

export function extractImageMentions(prompt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (!t || /^https?:/i.test(t) || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  const rest = prompt.replace(QUOTED, (_m, _q, p: string) => {
    push(p);
    return " ";
  });
  for (const m of rest.matchAll(BARE)) push(m[1]);
  return out;
}

/* ---------------- file helpers ---------------- */
const lc = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
function inside(child: string, root: string): boolean {
  const r = path.relative(lc(root), lc(child));
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

function sniff(b: Buffer): { mime: string; ext: string } | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: "image/png", ext: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) return { mime: "image/gif", ext: "gif" };
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { mime: "image/bmp", ext: "bmp" };
  return null;
}

function cleanRaw(raw: string): string {
  let s = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (/^file:\/\//i.test(s)) s = fileURLToPath(s);
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(1));
  return s;
}

async function firstExistingFile(raw: string, cwd: string, extra: string[]): Promise<string | null> {
  const s = cleanRaw(raw);
  const cands = path.isAbsolute(s) ? [s] : [cwd, os.tmpdir(), ...extra].map((r) => path.resolve(r, s));
  for (const c of cands) {
    try {
      if ((await fs.stat(c)).isFile()) return await fs.realpath(c);
    } catch { /* next */ }
  }
  return null;
}

async function readHead(p: string, n = 16): Promise<Buffer> {
  const fh = await fs.open(p, "r");
  try {
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, 0);
    return b.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/* ---------------- main entry ---------------- */
export async function resolveImages(o: ResolveOpts): Promise<ResolveResult> {
  const lim = { ...IMAGE_LIMITS, ...o.limits };
  const res: ResolveResult = { images: [], errors: [], warnings: [], skipped: [], missingMentions: [] };
  const roots = [o.cwd, os.tmpdir(), ...(o.extraRoots ?? [])];
  const explicit = (o.explicit ?? []).filter((s) => typeof s === "string" && s.trim());
  const useExplicit = explicit.length > 0;
  const raws = useExplicit ? explicit : o.autoAttach === false ? [] : extractImageMentions(o.prompt);

  const seenHash = new Set<string>();
  const usedNames = new Set<string>();
  let total = 0;

  for (const raw of raws) {
    const isExplicit = useExplicit;
    const abs = await firstExistingFile(raw, o.cwd, o.extraRoots ?? []);
    if (!abs) {
      if (isExplicit) res.errors.push(`image not found: ${raw}`);
      else res.missingMentions.push(raw);
      continue;
    }
    const st = await fs.stat(abs);
    if (st.size === 0 || st.size > lim.maxBytesEach) {
      (isExplicit ? res.errors : res.warnings).push(
        `${raw}: size ${st.size} B outside 1..${lim.maxBytesEach} B; skipped`);
      continue;
    }
    const kind = sniff(await readHead(abs));
    if (!kind) { (isExplicit ? res.errors : res.warnings).push(`${raw}: not a recognizable image (magic bytes)`); continue; }
    if (!SUPPORTED[o.provider].has(kind.mime)) {
      (isExplicit ? res.errors : res.warnings).push(
        `${raw}: ${kind.mime} is not accepted by ${o.provider}; convert to PNG/JPEG`);
      continue;
    }
    const buf = await fs.readFile(abs);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (seenHash.has(sha)) { res.skipped.push(`${raw} (duplicate content)`); continue; }
    if (res.images.length >= lim.maxFiles) { res.skipped.push(`${raw} (max ${lim.maxFiles} images)`); continue; }
    if (total + st.size > lim.maxBytesTotal) { res.skipped.push(`${raw} (total size cap)`); continue; }

    const stem = path.parse(path.basename(abs)).name.replace(/[^\w.\-]+/g, "_") || "image";
    let name = `${stem}.${kind.ext}`;
    for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${i}_${stem}.${kind.ext}`;
    usedNames.add(name.toLowerCase());
    seenHash.add(sha);
    total += st.size;

    res.images.push({
      absPath: abs, name, mime: kind.mime, bytes: st.size, sha256: sha,
      origin: isExplicit ? "explicit" : "auto",
      outsideRoots: !roots.some((r) => inside(abs, r)),
    });
  }

  // Auto-discovery is confined: drop outside-root files unless the agent passed them explicitly.
  if (!useExplicit) {
    const bad = res.images.filter((i) => i.outsideRoots);
    if (bad.length) {
      res.warnings.push(`auto-attach ignored files outside workspace/tmp: ${bad.map((b) => b.name).join(", ")}`);
      res.images = res.images.filter((i) => !i.outsideRoots);
    }
  } else {
    const attached = new Set(res.images.map((i) => i.absPath));
    for (const m of extractImageMentions(o.prompt)) {
      const abs = await firstExistingFile(m, o.cwd, o.extraRoots ?? []).catch(() => null);
      if (abs && !attached.has(abs)) res.warnings.push(`prompt mentions ${m} (exists) but it is not in images[]`);
    }
  }
  if (res.missingMentions.length)
    res.warnings.push(`prompt references ${res.missingMentions.join(", ")} but no such file in cwd/tmp; pass absolute paths via images[]`);
  return res;
}

/** Tell the external model how attachments map to the prose references. */
export function withAttachmentManifest(prompt: string, images: ImageFile[]): string {
  if (!images.length) return prompt;
  const list = images.map((i, n) => `${n + 1}. ${i.name}`).join("\n");
  return `${prompt}\n\nAttached images (in order; the prompt refers to them by these names):\n${list}`;
}
