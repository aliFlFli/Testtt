import type { RenameItem } from "./pipeline/rename.js";

export interface PendingFile {
  messageId: number;
  originalName: string;
  fileSize: number;
}

/**
 * A discriminated union describing exactly what the bot is waiting for.
 * The TypeScript compiler guarantees that, e.g., `items` only exists once
 * the user has produced a preview — no optional-field guessing at runtime.
 */
export type Session =
  | { stage: "idle" }
  | { stage: "awaitingName"; files: PendingFile[]; promptMessageId?: number }
  | { stage: "awaitingCategoryName"; items: RenameItem[]; promptMessageId?: number }
  | { stage: "confirming"; items: RenameItem[]; token: string; confirmMessageId?: number }
  | { stage: "pickingCategory"; items: RenameItem[]; token: string; askMessageId?: number }
  | { stage: "processing"; items: RenameItem[] };

const SESSION_TTL_MS = 15 * 60 * 1000;

interface Entry {
  session: Session;
  controller?: AbortController;
  timer: NodeJS.Timeout;
}

/**
 * Per-user session store with automatic expiry, plus the AbortController that
 * owns the lifetime of any in-flight download/upload for that user.
 */
export class SessionStore {
  private entries = new Map<string, Entry>();

  private touch(key: string, entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.clear(key), SESSION_TTL_MS);
    this.entries.set(key, entry);
  }

  get(key: string): Session | undefined {
    return this.entries.get(key)?.session;
  }

  set(key: string, session: Session): void {
    const existing = this.entries.get(key);
    this.touch(key, {
      session,
      controller: existing?.controller,
      timer: existing?.timer ?? setTimeout(() => {}, 0),
    });
  }

  /** Replace the session and attach a fresh AbortController (new processing run). */
  beginProcessing(key: string, session: Session): AbortController {
    const controller = new AbortController();
    this.touch(key, { session, controller, timer: setTimeout(() => {}, 0) });
    return controller;
  }

  controller(key: string): AbortController | undefined {
    return this.entries.get(key)?.controller;
  }

  abort(key: string): boolean {
    const ctrl = this.entries.get(key)?.controller;
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  clear(key: string): void {
    const entry = this.entries.get(key);
    if (entry) clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  clearAll(): number {
    const size = this.entries.size;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
    return size;
  }
}
