import type { Db } from "./db.js";
import type { Category, Status, Tier, User } from "./types.js";
import { today } from "../lib/utils.js";

const USER_COLUMNS = `id, lang, status, count, total_bytes, daily_bytes, daily_date,
  premium_tier, premium_until, premium_limit, referred_by, first_seen, last_seen`;

export function makeStore(db: Db) {
  const getUserStmt = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`);
  const insertUserStmt = db.prepare(
    `INSERT INTO users (id, status, first_seen, last_seen) VALUES (?, 'pending', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const saveUserStmt = db.prepare(
    `UPDATE users SET lang=@lang, status=@status, count=@count, total_bytes=@total_bytes,
      daily_bytes=@daily_bytes, daily_date=@daily_date, premium_tier=@premium_tier,
      premium_until=@premium_until, premium_limit=@premium_limit, referred_by=@referred_by,
      last_seen=@last_seen WHERE id=@id`,
  );

  const store = {
    /** Fetch a user, creating the row on first sight. Admin is auto-approved. */
    getUser(id: string, adminId?: string): User {
      const now = today();
      let row = getUserStmt.get(id) as User | undefined;
      if (!row) {
        const status: Status = id === adminId ? "approved" : "pending";
        insertUserStmt.run(id, now, now);
        if (id === adminId) db.prepare(`UPDATE users SET status='approved' WHERE id=?`).run(id);
        row = getUserStmt.get(id) as User;
      }
      return row;
    },

    saveUser(u: User): void {
      saveUserStmt.run({
        id: u.id,
        lang: u.lang,
        status: u.status,
        count: u.count ?? 0,
        total_bytes: u.total_bytes ?? 0,
        daily_bytes: u.daily_bytes ?? 0,
        daily_date: u.daily_date,
        premium_tier: u.premium_tier,
        premium_until: u.premium_until,
        premium_limit: u.premium_limit,
        referred_by: u.referred_by,
        last_seen: u.last_seen,
      });
    },

    /** Reset the daily counter if the stored date is not today. */
    ensureDailyReset(u: User): User {
      const now = today();
      if (u.daily_date !== now) {
        u.daily_bytes = 0;
        u.daily_date = now;
      }
      return u;
    },

    isPremium(u: User): boolean {
      if (u.status !== "premium" || !u.premium_until) return false;
      if (u.premium_until <= Date.now()) return false;
      return true;
    },

    allUsers(): User[] {
      return db.prepare(`SELECT ${USER_COLUMNS} FROM users`).all() as User[];
    },

    // --- banned ---
    ban(id: string): void {
      db.prepare(`INSERT OR IGNORE INTO banned (id) VALUES (?)`).run(id);
    },
    unban(id: string): void {
      db.prepare(`DELETE FROM banned WHERE id = ?`).run(id);
    },
    isBanned(id: string): boolean {
      return !!db.prepare(`SELECT 1 FROM banned WHERE id = ?`).get(id);
    },
    listBanned(): string[] {
      return (db.prepare(`SELECT id FROM banned`).all() as { id: string }[]).map((r) => r.id);
    },

    // --- stats ---
    incStat(key: string, by: number): void {
      db.prepare(
        `INSERT INTO stats (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      ).run(key, by);
    },
    getStat(key: string): number {
      const row = db.prepare(`SELECT value FROM stats WHERE key = ?`).get(key) as
        | { value: number }
        | undefined;
      return row?.value ?? 0;
    },

    // --- config ---
    ensureBotConfig(defaults: { maxFileSize: number; normalDailyLimit: number }): void {
      db.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES ('maxFileSize', ?), ('normalDailyLimit', ?)`)
        .run(String(defaults.maxFileSize), String(defaults.normalDailyLimit));
    },

    getBotConfig(): { maxFileSize: number; normalDailyLimit: number } {
      const rows = db.prepare(`SELECT key, value FROM config`).all() as {
        key: string;
        value: string;
      }[];
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      return {
        maxFileSize: map.maxFileSize ? Number(map.maxFileSize) : 2 * 1024 ** 3,
        normalDailyLimit: map.normalDailyLimit ? Number(map.normalDailyLimit) : 2 * 1024 ** 3,
      };
    },
    setConfig(key: string, value: string | number): void {
      db.prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, String(value));
    },

    // --- categories ---
    listCategories(userId: string): Category[] {
      return db
        .prepare(
          `SELECT c.id AS id, c.name AS name,
             (SELECT COUNT(*) FROM files f WHERE f.category_id = c.id) AS file_count
           FROM categories c WHERE c.user_id = ? ORDER BY c.name`,
        )
        .all(userId) as Category[];
    },
    findOrCreateCategory(userId: string, name: string): Category {
      db.prepare(`INSERT OR IGNORE INTO categories (user_id, name) VALUES (?, ?)`).run(userId, name);
      const row = db
        .prepare(`SELECT id, name FROM categories WHERE user_id = ? AND name = ?`)
        .get(userId, name) as { id: number; name: string };
      return { id: row.id, name: row.name, file_count: 0 };
    },

    // --- files ---
    recordFile(input: {
      userId: string;
      categoryId: number | null;
      originalName: string;
      newName: string;
      size: number;
    }): void {
      db.prepare(
        `INSERT INTO files (user_id, category_id, original_name, new_name, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.userId,
        input.categoryId,
        input.originalName,
        input.newName,
        input.size,
        new Date().toISOString(),
      );
    },
    countFiles(userId: string, categoryId: number | null): number {
      const row =
        categoryId === null
          ? (db
              .prepare(`SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND category_id IS NULL`)
              .get(userId) as { n: number })
          : (db
              .prepare(`SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND category_id = ?`)
              .get(userId, categoryId) as { n: number });
      return row.n;
    },
    listFiles(userId: string, categoryId: number | null, limit: number, offset: number) {
      const rows =
        categoryId === null
          ? db
              .prepare(
                `SELECT new_name, size FROM files WHERE user_id = ? AND category_id IS NULL
                 ORDER BY id DESC LIMIT ? OFFSET ?`,
              )
              .all(userId, limit, offset)
          : db
              .prepare(
                `SELECT new_name, size FROM files WHERE user_id = ? AND category_id = ?
                 ORDER BY id DESC LIMIT ? OFFSET ?`,
              )
              .all(userId, categoryId, limit, offset);
      return rows as { new_name: string; size: number }[];
    },

    // --- referrals ---
    addReferral(referrerId: string, referredId: string): boolean {
      const info = db
        .prepare(`INSERT OR IGNORE INTO referrals (referrer_id, referred_id, created_at) VALUES (?, ?, ?)`)
        .run(referrerId, referredId, new Date().toISOString());
      return info.changes > 0;
    },
    countReferrals(referrerId: string): number {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ?`)
        .get(referrerId) as { n: number };
      return row.n;
    },
  };

  return store;
}

export type Store = ReturnType<typeof makeStore>;
export type { Tier };
