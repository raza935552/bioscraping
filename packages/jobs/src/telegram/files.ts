// Downloading a screenshot somebody sent the bot. Telegram gives a file id; the file itself comes
// from a second call. Only images, only up to a size cap, and the bot token never leaves this file.

import type { LlmImage } from "@biolinx/drafting";

/** Telegram's own limit for bot downloads is 20MB; we stop far earlier — a screenshot is under 5MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface TelegramPhotoSize {
  file_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface TelegramMessageFiles {
  photo?: TelegramPhotoSize[];
  document?: { file_id?: string; mime_type?: string; file_size?: number; file_name?: string };
}

/** The biggest photo that still fits the cap: Telegram sends several sizes of the same image. */
export function pickPhoto(sizes: TelegramPhotoSize[] | undefined): TelegramPhotoSize | null {
  const usable = (sizes ?? []).filter((s) => s.file_id && (s.file_size ?? 0) <= MAX_IMAGE_BYTES);
  if (usable.length === 0) return null;
  return usable.reduce((best, s) => ((s.file_size ?? 0) > (best.file_size ?? 0) ? s : best));
}

/** What to download for this message, if anything: a photo, or a document that is really an image. */
export function imageRefOf(m: TelegramMessageFiles): { fileId: string; mediaType: string } | null {
  const photo = pickPhoto(m.photo);
  if (photo?.file_id) return { fileId: photo.file_id, mediaType: "image/jpeg" };
  const doc = m.document;
  if (doc?.file_id && doc.mime_type && ALLOWED.has(doc.mime_type) && (doc.file_size ?? 0) <= MAX_IMAGE_BYTES) {
    return { fileId: doc.file_id, mediaType: doc.mime_type };
  }
  return null;
}

export type ImageFetcher = (fileId: string, mediaType: string) => Promise<LlmImage | null>;

/** Downloads a Telegram file and returns it base64-encoded for a vision call. Never throws. */
export function telegramImageFetcher(botToken: string, fetchImpl: typeof fetch = fetch): ImageFetcher {
  return async (fileId, mediaType) => {
    try {
      const meta = await fetchImpl(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!meta.ok) return null;
      const body = (await meta.json()) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
      const path = body.result?.file_path;
      if (!body.ok || !path || (body.result?.file_size ?? 0) > MAX_IMAGE_BYTES) return null;
      const file = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${path}`, { signal: AbortSignal.timeout(30_000) });
      if (!file.ok) return null;
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
      return { mediaType, dataBase64: bytes.toString("base64") };
    } catch {
      return null; // a screenshot that won't download is answered without it, never an error to the chat
    }
  };
}
