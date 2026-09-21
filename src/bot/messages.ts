import type { Category } from "../store/types.js";
import type { Lang } from "../i18n/index.js";
import { t } from "../i18n/index.js";
import { escapeHtml, fmtSize } from "../lib/utils.js";
import { mainKeyboard, markup, button } from "./keyboards.js";
import type { InlineMarkup } from "./keyboards.js";

export function welcomeMessage(lang: Lang): { text: string; keyboard: InlineMarkup } {
  return { text: t("welcome", lang), keyboard: mainKeyboard(lang) };
}

export function previewMessage(items: { originalName: string; newName: string }[], lang: Lang): string {
  let text = items.length > 1 ? `${t("preview", lang)}\n\n` : `${t("preview", lang)}\n\n`;
  items.forEach((item, index) => {
    if (items.length > 1) text += `<b>#${index + 1}</b>\n`;
    text += `${t("current", lang)}<code>${escapeHtml(item.originalName)}</code>\n`;
    text += `${t("next", lang)}<code>${escapeHtml(item.newName)}</code>\n\n`;
  });
  return text;
}

export function profileMessage(user: {
  id: string; status: string; count: number; daily_bytes: number; total_bytes: number;
  premium_tier: string | null; premium_until: number | null;
}, limit: number, referrals: number, referralLink: string, lang: Lang): string {
  let text = `${t("profile", lang)}\n\n🆔 <code>${escapeHtml(user.id)}</code>\n`;
  text += `${t("status", lang)}${escapeHtml(user.status)}\n`;
  if (user.premium_until) {
    const days = Math.max(0, Math.ceil((user.premium_until - Date.now()) / 86_400_000));
    text += `⭐ ${escapeHtml(user.premium_tier ?? "")} — ${days}d\n`;
  }
  text += `📁 ${t("files", lang)}${user.count}\n`;
  text += `💾 ${t("today", lang)}${fmtSize(user.daily_bytes)} / ${fmtSize(limit)}\n`;
  text += `📦 ${t("total", lang)}${fmtSize(user.total_bytes)}\n`;
  text += `👥 ${t("referrals", lang)}${referrals}\n\n`;
  text += `${t("referralInfo", lang)}<code>${escapeHtml(referralLink)}</code>`;
  return text;
}

export function myFilesMessage(lang: Lang): string {
  return t("myFiles", lang);
}

export function categoryFilesMessage(files: { new_name: string; size: number }[], lang: Lang): string {
  let text = t("filesInCategory", lang);
  if (!files.length) return text + t("noFilesHere", lang);
  for (const file of files) {
    text += `📄 <code>${escapeHtml(file.new_name)}</code> — ${fmtSize(file.size)}\n`;
  }
  return text;
}

export function buildConfirmKeyboardText(lang: Lang): InlineMarkup {
  return markup([[button(t("back", lang), "nav:home")]]);
}

export type { Category };
