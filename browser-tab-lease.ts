import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Page } from "playwright-core";

const LEASE_DIR = path.join(os.homedir(), ".pi", "agent", "browser-leases");
const LEASE_TTL_MS = 120_000; // 2 minutes stale recovery

export interface TabLeaseHandle {
  provider: string;
  scopeKey: string;
  release: () => void;
}

/**
 * Cross-process file-based lease lock.
 * Serializes requests that target the EXACT SAME workspace and provider.
 * Different workspaces (different scopeKey) run in FULL PARALLEL with zero blocking!
 */
export async function acquireTabLease(
  provider: string,
  scopeKey: string,
  timeoutMs = 60_000,
): Promise<TabLeaseHandle> {
  fs.mkdirSync(LEASE_DIR, { recursive: true });
  const lockFile = path.join(LEASE_DIR, `lease-${provider}-${scopeKey}.lock`);
  const t0 = Date.now();

  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      const info = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      fs.writeSync(fd, info);
      fs.closeSync(fd);

      // Lock acquired successfully!
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (fs.existsSync(lockFile)) {
            const data = JSON.parse(fs.readFileSync(lockFile, "utf8"));
            if (data.pid === process.pid) {
              fs.unlinkSync(lockFile);
            }
          }
        } catch {}
      };

      return { provider, scopeKey, release };
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;

      // Stale lock detection: if process died or lock > TTL
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LEASE_TTL_MS) {
          fs.unlinkSync(lockFile);
        }
      } catch {}

      if (Date.now() - t0 > timeoutMs) {
        // Fallback without hard block to avoid permanent deadlock
        let released = false;
        return {
          provider,
          scopeKey,
          release: () => {
            if (released) return;
            released = true;
          },
        };
      }

      await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
    }
  }
}

/**
 * Check if the given page is actively generating a response.
 */
export async function isTabBusy(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  return await page
    .evaluate(() => {
      const stopBtn = document.querySelector(
        'button[data-testid*="stop" i], button[aria-label*="Stop" i], button[aria-label*="Останов" i], button[title*="Stop" i], [data-icon="stop"], .result-streaming, [data-is-streaming="true"]',
      );
      if (!stopBtn) return false;
      const r = (stopBtn as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(stopBtn as HTMLElement);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    })
    .catch(() => false);
}

/**
 * Wait for an in-flight stream/generation to complete before navigating away.
 * Prevents mid-stream abort disaster.
 */
export async function drainTabIfBusy(page: Page, timeoutMs = 25_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const busy = await isTabBusy(page);
    if (!busy) return;
    await page.waitForTimeout(500);
  }
}

/**
 * Check if another Pi session has an active consultation lease lockfile.
 */
export function hasActiveOtherLeases(currentScopeKey: string): boolean {
  try {
    if (!fs.existsSync(LEASE_DIR)) return false;
    const files = fs.readdirSync(LEASE_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith("lease-") || !file.endsWith(".lock")) continue;
      // Format: lease-${provider}-${scopeKey}.lock
      const raw = file.slice(6, -5);
      const dashIdx = raw.indexOf("-");
      if (dashIdx === -1) continue;
      const scopeKey = raw.slice(dashIdx + 1);

      if (scopeKey && scopeKey === currentScopeKey) {
        continue; // Our own lease
      }

      const fullPath = path.join(LEASE_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs < LEASE_TTL_MS) {
          // Another session has an active, non-stale lease!
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}
