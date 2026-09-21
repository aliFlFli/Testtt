import type { TelegramClient } from "telegram";
import type { Api } from "telegram";
import { logger } from "../lib/logger.js";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GramJS' high-level methods call this field `buttons`; it accepts an Api reply markup. */
export async function safeSend(
  client: TelegramClient,
  chatId: string,
  text: string,
  options: { keyboard?: Api.ReplyInlineMarkup; parseMode?: string; file?: unknown; caption?: string } = {},
): Promise<any> {
  return client.sendMessage(chatId, {
    message: text,
    parseMode: options.parseMode ?? "html",
    buttons: options.keyboard,
    ...(options.file ? { file: options.file, caption: options.caption ?? text } : {}),
  } as any);
}

export async function safeEdit(
  client: TelegramClient,
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: Api.ReplyInlineMarkup,
): Promise<void> {
  try {
    await client.editMessage(chatId, {
      message: messageId,
      text,
      parseMode: "html",
      buttons: replyMarkup,
    } as any);
  } catch (err) {
    logger.debug({ err: errorMessage(err), chatId, messageId }, "Telegram edit ignored");
  }
}

export async function safeDelete(client: TelegramClient, chatId: string, ids: number[]): Promise<void> {
  if (!ids.length) return;
  try {
    await client.deleteMessages(chatId, ids, { revoke: true });
  } catch (err) {
    logger.debug({ err: errorMessage(err), chatId, ids }, "Telegram delete ignored");
  }
}

export function autoDelete(client: TelegramClient, chatId: string, messageId: number, delayMs: number): void {
  setTimeout(() => safeDelete(client, chatId, [messageId]).catch(() => {}), delayMs);
}

export async function answerCallback(query: any): Promise<void> {
  try {
    await query.answer();
  } catch (err) {
    logger.debug({ err: errorMessage(err) }, "Callback answer ignored");
  }
}
