// Telegram notifier — alerts + daily digest into the client's existing group.
// Fail-open: a notification failure must never take a job down with it.

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export function telegramFromEnv(env = process.env): TelegramConfig | null {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;
  return { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
}

export async function sendTelegram(
  config: TelegramConfig | null,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config) {
    console.warn(`[notify] Telegram not configured — message dropped: ${text.slice(0, 120)}`);
    return false;
  }
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    console.error(`[notify] Telegram send failed: ${(err as Error).message}`);
    return false;
  }
}

export const alert = (config: TelegramConfig | null, text: string) =>
  sendTelegram(config, `🚨 ${text}`);
