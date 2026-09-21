import "dotenv/config";
import { z } from "zod";

const GB = 1024 ** 3;

const Schema = z.object({
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_ID: z.string().min(1),
  DATA_DIR: z.string().default("./data"),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  RATE_LIMIT_MAX_FILES: z.coerce.number().int().min(1).default(8),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  MAX_FILE_SIZE_GB: z.coerce.number().positive().default(2),
  NORMAL_DAILY_LIMIT_GB: z.coerce.number().positive().default(2),
  PREMIUM_SILVER_DAILY_GB: z.coerce.number().positive().default(10),
  PREMIUM_GOLD_DAILY_GB: z.coerce.number().positive().default(15),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;

export const cfg = {
  apiId: env.TELEGRAM_API_ID,
  apiHash: env.TELEGRAM_API_HASH,
  botToken: env.TELEGRAM_BOT_TOKEN,
  adminId: env.TELEGRAM_ADMIN_ID,
  dataDir: env.DATA_DIR,
  queueConcurrency: env.QUEUE_CONCURRENCY,
  rateLimitMaxFiles: env.RATE_LIMIT_MAX_FILES,
  rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
  maxFileSize: Math.floor(env.MAX_FILE_SIZE_GB * GB),
  normalDailyLimit: Math.floor(env.NORMAL_DAILY_LIMIT_GB * GB),
  silverDailyLimit: Math.floor(env.PREMIUM_SILVER_DAILY_GB * GB),
  goldDailyLimit: Math.floor(env.PREMIUM_GOLD_DAILY_GB * GB),
  logLevel: env.LOG_LEVEL,
} as const;

export type AppConfig = typeof cfg;
