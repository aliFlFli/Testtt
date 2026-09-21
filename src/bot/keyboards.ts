import { Api } from "telegram";
import type { Lang } from "../i18n/index.js";
import { t } from "../i18n/index.js";

export type InlineMarkup = Api.ReplyInlineMarkup;

export function button(text: string, data: string): Api.InlineKeyboardButton {
  return new Api.InlineKeyboardButton({
    text,
    data: Buffer.from(data, "utf8"),
  });
}

export function markup(rows: Api.InlineKeyboardButton[][]): InlineMarkup {
  return new Api.ReplyInlineMarkup({ rows });
}

export function languageKeyboard(): InlineMarkup {
  return markup([[
    button("🇮🇷 فارسی", "lang:fa"),
    button("🇬🇧 English", "lang:en"),
  ]]);
}

export function mainKeyboard(lang: Lang): InlineMarkup {
  return markup([
    [button(t("helpButton", lang), "nav:help"), button(t("aboutButton", lang), "nav:about")],
    [button(t("profile", lang), "nav:profile"), button(t("premium", lang), "nav:premium")],
    [button(t("myFiles", lang), "nav:files")],
    [button(t("language", lang), "nav:language")],
  ]);
}

export function backKeyboard(lang: Lang): InlineMarkup {
  return markup([[button(t("back", lang), "nav:home")]]);
}

export function cancelKeyboard(lang: Lang): InlineMarkup {
  return markup([[button(t("cancel", lang), "flow:cancel")]]);
}

export function processCancelKeyboard(lang: Lang): InlineMarkup {
  return markup([[button(t("cancelProcess", lang), "flow:cancel-process")]]);
}

export function confirmKeyboard(lang: Lang, token: string): InlineMarkup {
  return markup([[
    button(t("confirm", lang), `flow:confirm:${token}`),
    button(t("edit", lang), "flow:edit"),
    button(t("cancel", lang), "flow:cancel"),
  ]]);
}

export function doneKeyboard(lang: Lang): InlineMarkup {
  return markup([[button(t("another", lang), "flow:another")]]);
}

export function approvalKeyboard(userId: string): InlineMarkup {
  return markup([[
    button("✅ Approve", `admin:approve:${userId}`),
    button("❌ Reject", `admin:reject:${userId}`),
  ]]);
}

export function categoryKeyboard(lang: Lang, categories: { id: number; name: string; file_count: number }[], token: string): InlineMarkup {
  const rows: Api.InlineKeyboardButton[][] = categories.slice(0, 8).map((cat) => [
    button(`📁 ${cat.name} (${cat.file_count})`, `cat:pick:${token}:${cat.id}`),
  ]);
  rows.push([
    button(t("newCategory", lang), `cat:new:${token}`),
    button(t("noCategory", lang), `cat:none:${token}`),
  ]);
  return markup(rows);
}

export function myFilesKeyboard(
  lang: Lang,
  categories: { id: number; name: string; file_count: number }[],
  uncategorizedCount: number,
): InlineMarkup {
  const rows: Api.InlineKeyboardButton[][] = categories.map((cat) => [
    button(`📁 ${cat.name} (${cat.file_count})`, `files:category:${cat.id}`),
  ]);
  if (uncategorizedCount > 0) {
    rows.push([button(`${t("noCategory", lang)} (${uncategorizedCount})`, "files:category:none")]);
  }
  rows.push([button(t("back", lang), "nav:home")]);
  return markup(rows);
}

export function premiumKeyboard(lang: Lang, referrals: number): InlineMarkup {
  const rows: Api.InlineKeyboardButton[][] = [];
  if (referrals >= 3) rows.push([button(t("activateSilver", lang), "premium:activate:silver")]);
  if (referrals >= 5) rows.push([button(t("activateGold", lang), "premium:activate:gold")]);
  rows.push([button(t("back", lang), "nav:home")]);
  return markup(rows);
}
