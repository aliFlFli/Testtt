export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Turn any Telegram id (bigint | number | string) into a stable string key. */
export function normalizeId(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.trunc(v)) : "";
  return String(v).trim();
}

export function toBigInt(v: unknown): bigint {
  const s = normalizeId(v).replace(/^(-?\d+).*$/, "$1");
  return BigInt(s || "0");
}

export function getExtension(name: string): string {
  const base = String(name ?? "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).replace(/[^\w.-]/g, "").slice(0, 16);
}

export function sanitizeFileName(name: string, fallback = "file"): string {
  let s = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  s = s.replace(/[\\/]/g, "_").replace(/[:*?"<>|]/g, "_");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^\.+/, "");
  if (!s) s = fallback;
  if (s.length > 200) {
    const ext = getExtension(s);
    const base = ext ? s.slice(0, -(ext.length + 1)) : s;
    s = base.slice(0, 190) + (ext ? "." + ext : "");
  }
  return s;
}

export function sanitizeCategoryName(name: string): string | null {
  const s = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return s || null;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function fmtSize(bytes: number): string {
  let b = Number(bytes) || 0;
  let i = 0;
  while (b >= 1024 && i < UNITS.length - 1) {
    b /= 1024;
    i++;
  }
  return (i === 0 ? b.toFixed(0) : b.toFixed(2)) + " " + UNITS[i];
}

export function fmtSpeed(bytesPerSec: number): string {
  return fmtSize(bytesPerSec) + "/s";
}

export function bar(pct: number, width = 12): string {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  return "[" + "\u2588".repeat(filled) + "\u2591".repeat(width - filled) + "]";
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ":" + String(s).padStart(2, "0");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  retryAfterMs(key: string): number {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (!list.length) return 0;
    return Math.max(0, this.windowMs - (now - list[0]!));
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void | Promise<void>;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      const canRetry = attempt < opts.retries && (opts.shouldRetry ? opts.shouldRetry(err) : true);
      if (!canRetry) throw err;
      await opts.onRetry?.(attempt, err);
      await sleep((opts.baseDelayMs ?? 1000) * Math.pow(2, attempt));
      attempt++;
    }
  }
}
