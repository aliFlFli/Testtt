import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Api, TelegramClient } from "telegram";
import { t, type Lang } from "../i18n/index.js";
import { fmtSize, fmtSpeed, bar, escapeHtml, formatEta, withRetry } from "../lib/utils.js";
import { processCancelKeyboard } from "../bot/keyboards.js";
import { safeEdit } from "../bot/telegram.js";
import { logger } from "../lib/logger.js";

export interface RenameItem {
  messageId: number;
  originalName: string;
  newName: string;
  fileSize: number;
  categoryId: number | null;
}

export interface RenameProgress {
  phase: "download" | "upload";
  percent: number;
  bytes: number;
  total: number;
  speed: number;
  eta: string;
}

export interface RenameDeps {
  client: TelegramClient;
  chatId: string;
  lang: Lang;
  statusMessageId: number;
  signal: AbortSignal;
  onProgress?: (p: RenameProgress) => Promise<void>;
}

export function cloneDocumentAttributes(attrs: Api.TypeDocumentAttribute[], fileName: string): Api.TypeDocumentAttribute[] {
  const result: Api.TypeDocumentAttribute[] = [];
  let filenameSeen = false;

  for (const attr of attrs ?? []) {
    if (attr instanceof Api.DocumentAttributeFilename) {
      result.push(new Api.DocumentAttributeFilename({ fileName }));
      filenameSeen = true;
    } else if (attr instanceof Api.DocumentAttributeVideo) {
      result.push(new Api.DocumentAttributeVideo({
        duration: attr.duration,
        w: attr.w,
        h: attr.h,
        roundMessage: attr.roundMessage,
        supportsStreaming: attr.supportsStreaming,
        nosound: attr.nosound,
        preloadPrefixSize: attr.preloadPrefixSize,
        videoStartTs: attr.videoStartTs,
        videoCodec: attr.videoCodec,
      }));
    } else if (attr instanceof Api.DocumentAttributeAudio) {
      result.push(new Api.DocumentAttributeAudio({
        duration: attr.duration,
        voice: attr.voice,
        title: attr.title,
        performer: attr.performer,
        waveform: attr.waveform,
      }));
    } else if (attr instanceof Api.DocumentAttributeAnimated) {
      result.push(new Api.DocumentAttributeAnimated());
    } else if (attr instanceof Api.DocumentAttributeHasStickers) {
      result.push(new Api.DocumentAttributeHasStickers());
    } else {
      result.push(attr);
    }
  }

  if (!filenameSeen) result.push(new Api.DocumentAttributeFilename({ fileName }));
  return result;
}

function progressText(item: RenameItem, p: RenameProgress, lang: Lang): string {
  const phase = p.phase === "download" ? t("downloading", lang) : t("uploading", lang);
  let text = `${phase}\n\n${bar(p.percent)} <b>${p.percent}%</b>\n`;
  text += `💾 ${fmtSize(p.bytes)} / ${fmtSize(p.total)}\n`;
  if (p.speed > 0) text += `⚡ ${fmtSpeed(p.speed)}\n`;
  if (p.eta) text += `⏱ ${p.eta}\n`;
  text += `📄 <code>${escapeHtml(item.newName)}</code>`;
  return text;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("CANCELLED_BY_USER");
}

async function updateProgress(deps: RenameDeps, item: RenameItem, p: RenameProgress): Promise<void> {
  await deps.onProgress?.(p);
  await safeEdit(
    deps.client,
    deps.chatId,
    deps.statusMessageId,
    progressText(item, p, deps.lang),
    processCancelKeyboard(deps.lang),
  );
}

export async function processOneFile(item: RenameItem, deps: RenameDeps): Promise<void> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(os.tmpdir(), `tg-renamer-in-${stamp}`);
  const outputPath = path.join(os.tmpdir(), `tg-renamer-out-${stamp}-${item.newName}`);
  let lastUpdate = 0;
  let lastBytes = 0;
  let lastTime = Date.now();

  const shouldUpdate = () => {
    const now = Date.now();
    if (now - lastUpdate < 1500) return false;
    lastUpdate = now;
    return true;
  };

  try {
    checkAborted(deps.signal);
    const messages = await deps.client.getMessages(deps.chatId, { ids: [item.messageId] });
    const original = messages[0];
    if (!original?.media) throw new Error("Original media not found");

    const document = original.media instanceof Api.MessageMediaDocument ? original.media.document : undefined;
    const attributes = cloneDocumentAttributes(document?.attributes ?? [], item.newName);

    await safeEdit(
      deps.client,
      deps.chatId,
      deps.statusMessageId,
      progressText(item, { phase: "download", percent: 0, bytes: 0, total: item.fileSize, speed: 0, eta: "" }, deps.lang),
      processCancelKeyboard(deps.lang),
    );

    await withRetry(
      async () => {
        checkAborted(deps.signal);
        lastUpdate = 0;
        lastBytes = 0;
        lastTime = Date.now();
        await deps.client.downloadMedia(original.media!, {
          outputFile: inputPath,
          progressCallback: async (downloaded: bigint | number, total: bigint | number) => {
            checkAborted(deps.signal);
            if (!shouldUpdate()) return;
            const bytes = Number(downloaded);
            const totalBytes = Number(total) || item.fileSize;
            const now = Date.now();
            const elapsed = Math.max(0.001, (now - lastTime) / 1000);
            const speed = Math.max(0, (bytes - lastBytes) / elapsed);
            lastBytes = bytes;
            lastTime = now;
            const percent = totalBytes > 0 ? Math.min(99, Math.floor(bytes / totalBytes * 100)) : 0;
            await updateProgress(deps, item, {
              phase: "download",
              percent,
              bytes,
              total: totalBytes,
              speed,
              eta: speed > 0 ? formatEta((totalBytes - bytes) / speed) : "",
            });
          },
        });
      },
      { retries: 2, baseDelayMs: 2000, shouldRetry: (err) => err instanceof Error && err.message !== "CANCELLED_BY_USER" },
    );

    checkAborted(deps.signal);
    fs.renameSync(inputPath, outputPath);

    await safeEdit(
      deps.client,
      deps.chatId,
      deps.statusMessageId,
      progressText(item, { phase: "upload", percent: 0, bytes: 0, total: item.fileSize, speed: 0, eta: "" }, deps.lang),
      processCancelKeyboard(deps.lang),
    );

    const uploaded = await withRetry(
      async () => {
        checkAborted(deps.signal);
        lastUpdate = 0;
        lastBytes = 0;
        lastTime = Date.now();
        return deps.client.uploadFile({
          file: outputPath,
          workers: 1,
          progressCallback: async (uploadedBytes: number | bigint, total: number | bigint) => {
            checkAborted(deps.signal);
            if (!shouldUpdate()) return;
            const bytes = Number(uploadedBytes);
            const totalBytes = Number(total) || item.fileSize;
            const now = Date.now();
            const elapsed = Math.max(0.001, (now - lastTime) / 1000);
            const speed = Math.max(0, (bytes - lastBytes) / elapsed);
            lastBytes = bytes;
            lastTime = now;
            const percent = totalBytes > 0 ? Math.min(99, Math.floor(bytes / totalBytes * 100)) : 0;
            await updateProgress(deps, item, {
              phase: "upload",
              percent,
              bytes,
              total: totalBytes,
              speed,
              eta: speed > 0 ? formatEta((totalBytes - bytes) / speed) : "",
            });
          },
        });
      },
      { retries: 2, baseDelayMs: 2000, shouldRetry: (err) => err instanceof Error && err.message !== "CANCELLED_BY_USER" },
    );

    checkAborted(deps.signal);
    await deps.client.sendFile(deps.chatId, {
      file: uploaded,
      forceDocument: true,
      attributes,
      caption: `${t("done", deps.lang)}\n📄 <code>${escapeHtml(item.newName)}</code>\n💾 ${fmtSize(item.fileSize)}`,
      parseMode: "html",
    });
  } finally {
    for (const file of [inputPath, outputPath]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (err) {
        logger.debug({ err, file }, "Temporary file cleanup failed");
      }
    }
  }
}
