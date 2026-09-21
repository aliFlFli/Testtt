import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/StringSession.js";
import { NewMessage } from "telegram/events/NewMessage.js";
import { CallbackQuery } from "telegram/events/CallbackQuery.js";
import { cfg } from "./config.js";
import { logger } from "./lib/logger.js";
import {
  escapeHtml, sanitizeFileName, sanitizeCategoryName, fmtSize, getExtension,
  normalizeId, RateLimiter, withRetry, sleep,
} from "./lib/utils.js";
import { t, type Lang } from "./i18n/index.js";
import { openDb } from "./store/db.js";
import { makeStore, type Store } from "./store/index.js";
import { JobPool } from "./queue.js";
import { SessionStore, type PendingFile } from "./session.js";
import type { RenameItem } from "./pipeline/rename.js";
import { processOneFile } from "./pipeline/rename.js";
import {
  approvalKeyboard, backKeyboard, cancelKeyboard, categoryKeyboard, confirmKeyboard,
  doneKeyboard, languageKeyboard, mainKeyboard, markup, button, myFilesKeyboard,
  premiumKeyboard, processCancelKeyboard,
} from "./bot/keyboards.js";
import {
  answerCallback, autoDelete, errorMessage, safeDelete, safeEdit, safeSend,
} from "./bot/telegram.js";
import {
  categoryFilesMessage, previewMessage, profileMessage, welcomeMessage,
} from "./bot/messages.js";

const db = openDb(cfg.dataDir);
const store = makeStore(db);
store.ensureBotConfig({ maxFileSize: cfg.maxFileSize, normalDailyLimit: cfg.normalDailyLimit });
const queue = new JobPool(cfg.queueConcurrency);
const sessions = new SessionStore();
const limiter = new RateLimiter(cfg.rateLimitMaxFiles, cfg.rateLimitWindowMs);
const startTime = Date.now();
const sessionFile = path.join(cfg.dataDir, "gramjs.session");
let botUsername = "Bot";

function langOf(user: { lang: string | null }): Lang {
  return user.lang === "en" ? "en" : "fa";
}

function isAdmin(id: string): boolean {
  return id === cfg.adminId;
}

function uptime(): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor(seconds % 86400 / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  return `${d}d ${h}h ${m}m`;
}

function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === "CANCELLED_BY_USER";
}

async function notifyAdmin(client: TelegramClient, text: string, keyboard?: Api.ReplyInlineMarkup): Promise<void> {
  try {
    await safeSend(client, cfg.adminId, text, { keyboard });
  } catch (err) {
    logger.error({ err: errorMessage(err) }, "Admin notification failed");
  }
}

async function sendErrorToAdmin(client: TelegramClient, err: unknown, context: string): Promise<void> {
  await notifyAdmin(client,
    `⚠️ <b>Bot error</b>\n📍 <code>${escapeHtml(context)}</code>\n<code>${escapeHtml(errorMessage(err).slice(0, 1200))}</code>`);
  logger.error({ err, context }, "Bot error");
}

function extractDocument(message: Api.Message): Api.Document | undefined {
  if (message.media instanceof Api.MessageMediaDocument) return message.media.document;
  const document = (message as any).document;
  return document instanceof Api.Document ? document : undefined;
}

function fileNameFromDocument(document: Api.Document, messageId: number): string {
  const attr = document.attributes?.find((a) => a instanceof Api.DocumentAttributeFilename) as
    | Api.DocumentAttributeFilename | undefined;
  return sanitizeFileName(attr?.fileName ?? `file_${messageId}`, `file_${messageId}`);
}

function getFileSize(document: Api.Document): number {
  return Number(document.size ?? 0);
}

async function showHome(client: TelegramClient, chatId: string, lang: Lang): Promise<void> {
  const home = welcomeMessage(lang);
  await safeSend(client, chatId, home.text, { keyboard: home.keyboard });
}

async function notifyNewUser(client: TelegramClient, id: string, lang: Lang, referredBy: string | null): Promise<void> {
  const ref = referredBy ? `\n🔗 Referred by: <code>${escapeHtml(referredBy)}</code>` : "";
  await notifyAdmin(client,
    `🆕 <b>New user request</b>\n👤 <code>${escapeHtml(id)}</code>\n🌐 ${lang}${ref}`,
    approvalKeyboard(id));
}

async function applyReferral(store: Store, client: TelegramClient, targetId: string): Promise<void> {
  const target = store.getUser(targetId, cfg.adminId);
  if (!target.referred_by) return;
  if (!store.addReferral(target.referred_by, targetId)) return;

  const referrer = store.getUser(target.referred_by, cfg.adminId);
  const count = store.countReferrals(target.referred_by);
  const refLang = langOf(referrer);
  await safeSend(client, target.referred_by,
    `👥 ${refLang === "en" ? "New referral" : "معرف جدید"}\n${count}`);

  // A referral threshold grants the reward once; activation buttons also exist
  // as an explicit path, but the automatic path is useful for the original UX.
  if (count >= 5 && referrer.premium_tier !== "gold") {
    referrer.status = "premium";
    referrer.premium_tier = "gold";
    referrer.premium_until = Date.now() + 30 * 86_400_000;
    referrer.premium_limit = cfg.goldDailyLimit;
    store.saveUser(referrer);
    await safeSend(client, target.referred_by, "🎉 Gold premium activated: 15 GB/day for 30 days");
  } else if (count >= 3 && !referrer.premium_tier) {
    referrer.status = "premium";
    referrer.premium_tier = "silver";
    referrer.premium_until = Date.now() + 15 * 86_400_000;
    referrer.premium_limit = cfg.silverDailyLimit;
    store.saveUser(referrer);
    await safeSend(client, target.referred_by, "🎉 Silver premium activated: 10 GB/day for 15 days");
  }
}

async function approveUser(client: TelegramClient, targetId: string): Promise<void> {
  const target = store.getUser(targetId, cfg.adminId);
  target.status = "approved";
  store.saveUser(target);
  await applyReferral(store, client, targetId);
  await safeSend(client, targetId, t("approved", langOf(target)), { keyboard: mainKeyboard(langOf(target)) });
}

async function processBatch(
  client: TelegramClient,
  chatId: string,
  lang: Lang,
  items: RenameItem[],
): Promise<void> {
  const controller = sessions.beginProcessing(chatId, { stage: "processing", items });

  const status = await safeSend(client, chatId, `${t("queued", lang)} 1`, {
    keyboard: processCancelKeyboard(lang),
  });
  const statusId = status.id as number;

  try {
    await queue.enqueue(
      async () => {
        try {
          for (let i = 0; i < items.length; i++) {
            if (controller.signal.aborted) break;
            const item = items[i]!;
            const prefix = items.length > 1 ? `📦 ${i + 1}/${items.length}\n` : "";
            await safeEdit(
              client,
              chatId,
              statusId,
              `${prefix}⬇️ ${t("downloading", lang)}\n📄 <code>${escapeHtml(item.newName)}</code>`,
              processCancelKeyboard(lang),
            );

            await processOneFile(item, {
              client,
              chatId,
              lang,
              statusMessageId: statusId,
              signal: controller.signal,
            });

            const user = store.getUser(chatId, cfg.adminId);
            store.ensureDailyReset(user);
            user.count += 1;
            user.total_bytes += item.fileSize;
            user.daily_bytes += item.fileSize;
            store.saveUser(user);
            store.recordFile({
              userId: chatId,
              categoryId: item.categoryId,
              originalName: item.originalName,
              newName: item.newName,
              size: item.fileSize,
            });
            store.incStat("files_total", 1);
            store.incStat("bytes_total", item.fileSize);

            if (!isAdmin(chatId)) {
              await notifyAdmin(
                client,
                `🔔 <b>File processed</b>\n` +
                  `👤 <code>${escapeHtml(chatId)}</code>\n` +
                  `📄 <code>${escapeHtml(item.newName)}</code>\n` +
                  `💾 ${fmtSize(item.fileSize)}`,
              );
            }
          }

          await safeDelete(client, chatId, [statusId]);
          if (!controller.signal.aborted) {
            const done = await safeSend(client, chatId, t("done", lang), { keyboard: doneKeyboard(lang) });
            autoDelete(client, chatId, done.id, 5 * 60_000);
          }
        } catch (err) {
          if (!isCancelled(err)) {
            await safeEdit(client, chatId, statusId, t("error", lang));
            await sendErrorToAdmin(client, err, "processBatch");
            autoDelete(client, chatId, statusId, 60_000);
          }
        } finally {
          sessions.clear(chatId);
        }
      },
      (position) => {
        safeEdit(client, chatId, statusId, `${t("queued", lang)} ${position}`, processCancelKeyboard(lang)).catch(() => {});
      },
    );
  } catch (err) {
    sessions.clear(chatId);
    await sendErrorToAdmin(client, err, "queue.enqueue");
  }
}

async function handleAdminCommand(client: TelegramClient, chatId: string, text: string): Promise<boolean> {
  if (!isAdmin(chatId)) return false;
  const [command, ...args] = text.trim().split(/\s+/);

  if (command === "/ping") {
    await safeSend(client, chatId, `online ✅\nUptime: ${uptime()}`);
    return true;
  }
  if (command === "/stats") {
    const users = store.allUsers();
    const premium = users.filter((u) => store.isPremium(u)).length;
    const cfgDb = store.getBotConfig();
    await safeSend(client, chatId,
      `<b>Stats</b>\n\nFiles: <b>${store.getStat("files_total")}</b>\n` +
      `Size: <b>${fmtSize(store.getStat("bytes_total"))}</b>\nUsers: <b>${users.length}</b>\n` +
      `Premium: <b>${premium}</b>\nBanned: <b>${store.listBanned().length}</b>\n` +
      `Queue: <b>${queue.running} running / ${queue.waiting} waiting</b>\n` +
      `Uptime: <b>${uptime()}</b>\nMax size: <b>${fmtSize(cfgDb.maxFileSize)}</b>`);
    return true;
  }
  if (command === "/approve" && args[0]) {
    const id = normalizeId(args[0]);
    await approveUser(client, id);
    await safeSend(client, chatId, `Approved ${id}`);
    return true;
  }
  if (command === "/reject" && args[0]) {
    const id = normalizeId(args[0]);
    const user = store.getUser(id, cfg.adminId);
    user.status = "banned";
    store.saveUser(user);
    store.ban(id);
    await safeSend(client, id, t("rejected", langOf(user))).catch(() => {});
    await safeSend(client, chatId, `Rejected ${id}`);
    return true;
  }
  if (command === "/ban" && args[0]) {
    const id = normalizeId(args[0]);
    if (id !== cfg.adminId) {
      const user = store.getUser(id, cfg.adminId);
      user.status = "banned";
      store.saveUser(user);
      store.ban(id);
      await safeSend(client, chatId, `Banned ${id}`);
    }
    return true;
  }
  if (command === "/unban" && args[0]) {
    const id = normalizeId(args[0]);
    store.unban(id);
    const user = store.getUser(id, cfg.adminId);
    user.status = "approved";
    store.saveUser(user);
    await safeSend(client, chatId, `Unbanned ${id}`);
    return true;
  }
  if (command === "/banlist") {
    const list = store.listBanned();
    await safeSend(client, chatId, list.length ? `<b>Banned</b>\n${list.map((id) => `• <code>${escapeHtml(id)}</code>`).join("\n")}` : "Banned list is empty.");
    return true;
  }
  if (command === "/pending") {
    const pending = store.allUsers().filter((u) => u.status === "pending");
    await safeSend(client, chatId, pending.length
      ? `<b>Pending</b>\n${pending.slice(0, 50).map((u) => `• <code>${escapeHtml(u.id)}</code>`).join("\n")}`
      : "No pending users.");
    return true;
  }
  if (command === "/setlimit" && args[0]) {
    const gb = Number(args[0]);
    if (!Number.isFinite(gb) || gb <= 0) return true;
    store.setConfig("maxFileSize", Math.floor(gb * 1024 ** 3));
    await safeSend(client, chatId, `Max file size: ${fmtSize(store.getBotConfig().maxFileSize)}`);
    return true;
  }
  if (command === "/premium" && args[0]) {
    const id = normalizeId(args[0]);
    const days = Number(args[1] ?? 30);
    const gb = Number(args[2] ?? 15);
    const user = store.getUser(id, cfg.adminId);
    user.status = "premium";
    user.premium_tier = gb >= 15 ? "gold" : "silver";
    user.premium_until = Date.now() + days * 86_400_000;
    user.premium_limit = Math.floor(gb * 1024 ** 3);
    store.saveUser(user);
    await safeSend(client, chatId, `Premium set for ${id}`);
    await safeSend(client, id, `⭐ Premium activated for ${days} days (${gb} GB/day)`).catch(() => {});
    return true;
  }
  if (command === "/cleanup") {
    const count = sessions.clearAll();
    let removed = 0;
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith("tg-renamer-")) continue;
      try { fs.unlinkSync(path.join(os.tmpdir(), name)); removed++; } catch {}
    }
    await safeSend(client, chatId, `Cleanup done. Sessions: ${count}, files: ${removed}`);
    return true;
  }
  if (command === "/broadcast") {
    const body = text.slice("/broadcast".length).trim();
    const users = store.allUsers();
    let ok = 0;
    for (const user of users) {
      try { await safeSend(client, user.id, body); ok++; } catch {}
      await sleep(50);
    }
    await safeSend(client, chatId, `Sent: ${ok}/${users.length}`);
    return true;
  }
  return false;
}

async function handleStart(client: TelegramClient, chatId: string, text: string): Promise<void> {
  const user = store.getUser(chatId, cfg.adminId);
  const payload = text.trim().split(/\s+/)[1] ?? "";
  if (payload.startsWith("ref_") && user.status === "pending" && !user.referred_by) {
    const referrer = normalizeId(payload.slice(4));
    if (referrer && referrer !== chatId && store.getUser(referrer, cfg.adminId)) {
      user.referred_by = referrer;
      store.saveUser(user);
    }
  }

  if (!user.lang) {
    await safeSend(client, chatId, t("chooseLanguage", "fa"), { keyboard: languageKeyboard() });
    return;
  }
  const lang = langOf(user);
  if (isAdmin(chatId)) {
    user.status = user.status === "premium" ? user.status : "approved";
    store.saveUser(user);
    await showHome(client, chatId, lang);
    return;
  }
  if (user.status === "pending") {
    await safeSend(client, chatId, t("pending", lang));
    return;
  }
  if (user.status === "banned") {
    await safeSend(client, chatId, t("banned", lang));
    return;
  }
  await showHome(client, chatId, lang);
}

async function handleDocument(client: TelegramClient, chatId: string, message: Api.Message, lang: Lang): Promise<void> {
  const document = extractDocument(message);
  if (!document) return;
  if (!limiter.allow(chatId)) {
    const wait = Math.ceil(limiter.retryAfterMs(chatId) / 1000);
    const sent = await safeSend(client, chatId, `${t("rateLimited", lang)} (${wait}s)`);
    autoDelete(client, chatId, sent.id, 8000);
    return;
  }

  const originalName = fileNameFromDocument(document, message.id);
  const fileSize = getFileSize(document);
  const botCfg = store.getBotConfig();
  if (fileSize > botCfg.maxFileSize) {
    const sent = await safeSend(client, chatId, t("tooBig", lang));
    autoDelete(client, chatId, sent.id, 15000);
    return;
  }

  const user = store.getUser(chatId, cfg.adminId);
  store.ensureDailyReset(user);
  const limit = store.isPremium(user) ? (user.premium_limit ?? cfg.silverDailyLimit) : botCfg.normalDailyLimit;
  if (user.daily_bytes + fileSize > limit) {
    const sent = await safeSend(client, chatId, `${t("dailyLimit", lang)}\n\n${fmtSize(user.daily_bytes)} / ${fmtSize(limit)}`, { keyboard: mainKeyboard(lang) });
    autoDelete(client, chatId, sent.id, 20_000);
    return;
  }

  const previous = sessions.get(chatId);
  const files: PendingFile[] = previous?.stage === "awaitingName" ? [...previous.files] : [];
  files.push({ messageId: message.id, originalName, fileSize });
  if (previous?.stage === "awaitingName" && previous.promptMessageId) {
    await safeDelete(client, chatId, [previous.promptMessageId]);
  }

  const prompt = await safeSend(client, chatId,
    `📦 <b>${escapeHtml(originalName)}</b>\n💾 ${fmtSize(fileSize)}\n\n` +
    (files.length > 1 ? t("enterBatch", lang, files.length) : t("enterName", lang)),
    { keyboard: cancelKeyboard(lang) });
  sessions.set(chatId, { stage: "awaitingName", files, promptMessageId: prompt.id });
}

async function handleText(client: TelegramClient, chatId: string, text: string, lang: Lang): Promise<void> {
  const state = sessions.get(chatId);
  if (!state) {
    const tip = await safeSend(client, chatId, t("sendFileFirst", lang), { keyboard: backKeyboard(lang) });
    autoDelete(client, chatId, tip.id, 4000);
    return;
  }

  if (state.stage === "awaitingCategoryName") {
    const name = sanitizeCategoryName(text);
    if (!name) return;
    const category = store.findOrCreateCategory(chatId, name);
    await processBatch(client, chatId, lang, state.items.map((item) => ({ ...item, categoryId: category.id })));
    return;
  }

  if (state.stage !== "awaitingName") return;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== state.files.length) {
    const tip = await safeSend(client, chatId,
      lang === "en" ? `Please send exactly ${state.files.length} name(s), one per line.` : `دقیقاً ${state.files.length} نام بفرست؛ هر نام در یک خط.`,
      { keyboard: cancelKeyboard(lang) });
    autoDelete(client, chatId, tip.id, 8000);
    return;
  }

  const items: RenameItem[] = state.files.map((file, index) => {
    const ext = getExtension(file.originalName);
    let candidate = lines[index]!;
    if (ext && !candidate.includes(".")) candidate += `.${ext}`;
    return {
      messageId: file.messageId,
      originalName: file.originalName,
      newName: sanitizeFileName(candidate, file.originalName),
      fileSize: file.fileSize,
      categoryId: null,
    };
  });

  if (state.promptMessageId) await safeDelete(client, chatId, [state.promptMessageId]);
  const token = `c${Date.now().toString(36)}`;
  const preview = await safeSend(client, chatId, previewMessage(items, lang), { keyboard: confirmKeyboard(lang, token) });
  sessions.set(chatId, { stage: "confirming", items, token, confirmMessageId: preview.id });
}

async function handleNavigation(client: TelegramClient, chatId: string, action: string, lang: Lang): Promise<void> {
  if (action === "home") {
    sessions.clear(chatId);
    await showHome(client, chatId, lang);
  } else if (action === "help") {
    const msg = await safeSend(client, chatId, t("help", lang), { keyboard: backKeyboard(lang) });
    autoDelete(client, chatId, msg.id, 10 * 60_000);
  } else if (action === "about") {
    const msg = await safeSend(client, chatId, t("about", lang, store.getBotConfig().maxFileSize), { keyboard: backKeyboard(lang) });
    autoDelete(client, chatId, msg.id, 10 * 60_000);
  } else if (action === "language") {
    await safeSend(client, chatId, t("chooseLanguage", lang), { keyboard: languageKeyboard() });
  } else if (action === "profile") {
    const user = store.getUser(chatId, cfg.adminId);
    store.ensureDailyReset(user);
    store.saveUser(user);
    const limit = store.isPremium(user) ? (user.premium_limit ?? cfg.silverDailyLimit) : store.getBotConfig().normalDailyLimit;
    const link = `https://t.me/${botUsername}?start=ref_${chatId}`;
    await safeSend(client, chatId, profileMessage(user, limit, store.countReferrals(chatId), link, lang), { keyboard: backKeyboard(lang) });
  } else if (action === "premium") {
    const user = store.getUser(chatId, cfg.adminId);
    const refs = store.countReferrals(chatId);
    let text = `${t("premium", lang)}\n\n${t("premiumInfo", lang)}\n\n${t("referrals", lang)}${refs}`;
    if (store.isPremium(user)) text += `\n\n${t("premiumActive", lang)}`;
    await safeSend(client, chatId, text, { keyboard: premiumKeyboard(lang, refs) });
  } else if (action === "files") {
    const cats = store.listCategories(chatId);
    const uncategorized = store.countFiles(chatId, null);
    await safeSend(client, chatId, t("myFiles", lang), { keyboard: myFilesKeyboard(lang, cats, uncategorized) });
  }
}

async function handleCallback(client: TelegramClient, event: any): Promise<void> {
  await answerCallback(event.query);
  const chatId = normalizeId(event.query.userId);
  const data = String(event.data ?? "");
  const user = store.getUser(chatId, cfg.adminId);
  const lang = langOf(user);

  if (data.startsWith("lang:")) {
    const newLang = data.slice(5) === "en" ? "en" : "fa";
    user.lang = newLang;
    store.saveUser(user);
    await safeSend(client, chatId, t("languageSet", newLang));
    if (user.status === "pending" && !isAdmin(chatId)) {
      await safeSend(client, chatId, t("pending", newLang));
      await notifyNewUser(client, chatId, newLang, user.referred_by);
    } else {
      await showHome(client, chatId, newLang);
    }
    return;
  }

  if (data.startsWith("nav:")) {
    await handleNavigation(client, chatId, data.slice(4), lang);
    return;
  }
  if (data === "flow:cancel") {
    const state = sessions.get(chatId);
    if (state && "promptMessageId" in state && state.promptMessageId) await safeDelete(client, chatId, [state.promptMessageId]);
    if (state && "confirmMessageId" in state && state.confirmMessageId) await safeDelete(client, chatId, [state.confirmMessageId]);
    sessions.clear(chatId);
    await showHome(client, chatId, lang);
    return;
  }
  if (data === "flow:cancel-process") {
    sessions.abort(chatId);
    await safeSend(client, chatId, `${t("cancelled", lang)}\n${t("cancelledHint", lang)}`, { keyboard: mainKeyboard(lang) });
    return;
  }
  if (data === "flow:another") {
    sessions.clear(chatId);
    await showHome(client, chatId, lang);
    return;
  }
  if (data === "flow:edit") {
    const state = sessions.get(chatId);
    if (state?.stage === "confirming") {
      if (state.confirmMessageId) await safeDelete(client, chatId, [state.confirmMessageId]);
      const prompt = await safeSend(client, chatId,
        state.items.length > 1 ? t("enterBatch", lang, state.items.length) : t("enterName", lang),
        { keyboard: cancelKeyboard(lang) });
      sessions.set(chatId, {
        stage: "awaitingName",
        files: state.items.map((i) => ({ messageId: i.messageId, originalName: i.originalName, fileSize: i.fileSize })),
        promptMessageId: prompt.id,
      });
    }
    return;
  }
  if (data.startsWith("flow:confirm:")) {
    const state = sessions.get(chatId);
    const token = data.slice("flow:confirm:".length);
    if (state?.stage !== "confirming" || state.token !== token) return;
    if (state.confirmMessageId) await safeDelete(client, chatId, [state.confirmMessageId]);
    const ask = await safeSend(client, chatId, t("askCategory", lang), {
      keyboard: categoryKeyboard(lang, store.listCategories(chatId), token),
    });
    sessions.set(chatId, { stage: "pickingCategory", items: state.items, token, askMessageId: ask.id });
    return;
  }
  if (data.startsWith("cat:")) {
    const state = sessions.get(chatId);
    if (state?.stage !== "pickingCategory") return;
    if (state.askMessageId) await safeDelete(client, chatId, [state.askMessageId]);
    const [, action, token, id] = data.split(":");
    if (token !== state.token) return;
    if (action === "new") {
      const prompt = await safeSend(client, chatId, t("enterCategory", lang), { keyboard: cancelKeyboard(lang) });
      sessions.set(chatId, { stage: "awaitingCategoryName", items: state.items, promptMessageId: prompt.id });
    } else {
      const categoryId = action === "none" ? null : Number(id);
      await processBatch(client, chatId, lang, state.items.map((item) => ({ ...item, categoryId })));
    }
    return;
  }
  if (data.startsWith("files:category:")) {
    const raw = data.slice("files:category:".length);
    const categoryId = raw === "none" ? null : Number(raw);
    await safeSend(client, chatId, categoryFilesMessage(store.listFiles(chatId, categoryId, 20, 0), lang), {
      keyboard: markup([[button(t("back", lang), "nav:files")]]),
    });
    return;
  }
  if (data.startsWith("premium:activate:")) {
    const tier = data.slice("premium:activate:".length);
    const refs = store.countReferrals(chatId);
    if ((tier === "silver" && refs < 3) || (tier === "gold" && refs < 5)) {
      await safeSend(client, chatId, t("needMore", lang));
      return;
    }
    user.status = "premium";
    user.premium_tier = tier === "gold" ? "gold" : "silver";
    user.premium_until = Date.now() + (tier === "gold" ? 30 : 15) * 86_400_000;
    user.premium_limit = tier === "gold" ? cfg.goldDailyLimit : cfg.silverDailyLimit;
    store.saveUser(user);
    await safeSend(client, chatId, t("premiumActivated", lang), { keyboard: mainKeyboard(lang) });
    return;
  }
  if (data.startsWith("admin:")) {
    if (!isAdmin(chatId)) return;
    const [, action, id] = data.split(":");
    if (action === "approve" && id) await approveUser(client, id);
    if (action === "reject" && id) {
      const target = store.getUser(id, cfg.adminId);
      target.status = "banned";
      store.saveUser(target);
      store.ban(id);
      await safeSend(client, id, t("rejected", langOf(target))).catch(() => {});
    }
    await safeSend(client, chatId, `${action} ${id} ✅`);
  }
}

async function start(): Promise<void> {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const session = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, "utf8").trim() : "";
  const client = new TelegramClient(new StringSession(session), cfg.apiId, cfg.apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
  });

  await client.start({ botAuthToken: cfg.botToken });
  fs.writeFileSync(sessionFile, client.session.save(), "utf8");
  const me = await client.getMe();
  botUsername = me.username ?? "Bot";
  store.getUser(cfg.adminId, cfg.adminId);

  client.addEventHandler(async (event: any) => {
    try {
      const message = event.message as Api.Message;
      if (!message?.isPrivate) return;
      const chatId = normalizeId(message.chatId);
      const text = String(message.message ?? "");
      const user = store.getUser(chatId, cfg.adminId);
      const lang = langOf(user);

      if ((user.status === "banned" || store.isBanned(chatId)) && !isAdmin(chatId)) {
        await safeSend(client, chatId, t("banned", lang));
        return;
      }
      user.last_seen = new Date().toISOString();
      store.saveUser(user);

      if (text.startsWith("/")) {
        if (await handleAdminCommand(client, chatId, text)) return;
        if (text.startsWith("/start")) {
          await handleStart(client, chatId, text);
          return;
        }
      }
      if (!isAdmin(chatId) && user.status !== "approved" && user.status !== "premium") {
        if (user.status === "pending") await safeSend(client, chatId, t("pending", lang));
        return;
      }

      const document = extractDocument(message);
      if (document) {
        await handleDocument(client, chatId, message, lang);
      } else if (text && !text.startsWith("/")) {
        await handleText(client, chatId, text, lang);
      }
    } catch (err) {
      await sendErrorToAdmin(client, err, "new-message");
    }
  }, new NewMessage({}));

  client.addEventHandler(async (event: any) => {
    try {
      await handleCallback(client, event);
    } catch (err) {
      await sendErrorToAdmin(client, err, "callback");
    }
  }, new CallbackQuery({}));

  await notifyAdmin(client,
    `<b>Bot online ✅</b>\nUsername: @${escapeHtml(botUsername)}\nQueue: ${cfg.queueConcurrency}\nMax file: ${fmtSize(store.getBotConfig().maxFileSize)}`);
  logger.info({ botUsername }, "Bot is ready");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    sessions.clearAll();
    try { await client.disconnect(); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
