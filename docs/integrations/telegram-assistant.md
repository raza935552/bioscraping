# The Telegram assistant

The team and the client ask about the affiliate engine in Telegram; the bot answers from live data,
argues back when a request would break a platform rule, and logs anything that needs Raza as a task
on the admin's Requests page. Built 2026-09-21.

Unlike social DM automation, this is what Telegram's bot platform is built for: no ban risk, no
imitation of a person, official API.

## What it does

- **Answers questions** — "how many affiliates do we have", "is the scrape running", "what did last
  night find", "how many leads are waiting". Numbers come from a live read of the database on every
  question, never from memory.
- **Reads screenshots.** A photo (with or without a caption) is downloaded and read, so people can
  paste a page of the admin or an error instead of describing it.
- **Argues back, kindly.** A request that would break a platform rule, risk the brand account or
  break compliance gets a short explanation and the alternative that works, before it is logged.
- **Creates tasks.** Anything that asks for a change, reports a problem or proposes an idea becomes a
  row in `tasks`, visible on **Requests** in the admin with what the assistant replied. A
  "pushed back" tag marks the ones it disagreed with.
- **Commands:** `/status` (numbers, no model, never capped), `/tasks` (what is open), `/help`.

## What it will not do

- It only reads the engine. The only things it writes are a task and its own log.
- It answers only in allow-listed chats. Anywhere else it says to ask Raza for access.
- It never reveals keys, passwords, database details, customer emails or an individual creator's
  personal data. Counts and aggregates only.
- It never promises a date.
- In a group it stays quiet unless mentioned by name, replied to, or given a command.

## Setup

1. **Create the bot.** Message @BotFather, `/newbot`, pick a name and a username. Copy the token.
2. **Get the chat id.** Add the bot to the team group, send any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id` (a group id starts
   with `-100`).
3. **Fill in Settings → Alerts, digest & the chat assistant:**
   - Bot token, Chat ID (where alerts go)
   - Bot username, without the `@`
   - Webhook secret: any long random string
   - Chats allowed to ask: comma-separated ids; blank means the alert chat only
   - Answers per day: 120 by default
4. **Point Telegram at us**, once, with the token and the same secret:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://gemboxpk.com/webhooks/telegram" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\"]"
```

5. **Check it:** send `/status` in the chat. Numbers come back with no model call.

To move the bot to another server, call `setWebhook` again with the new URL. To switch it off,
`deleteWebhook`, or clear the allow-list.

## How an answer is made

1. Telegram posts the update to `POST /webhooks/telegram`, carrying the secret token header. A wrong
   secret is refused; every other outcome answers `200` so Telegram does not retry in a storm.
2. The update id is checked against `telegram_log`, so a Telegram retry never answers twice.
3. The message is classified by keywords: question, change, bug or idea.
4. A snapshot of the live numbers is read (counts only).
5. Claude writes the answer from the brief in `packages/jobs/src/telegram/brief.ts`, the snapshot,
   and the screenshot when there is one. The brief is the single place the assistant's facts and tone
   live; its promises are asserted in tests.
6. Anything that is not a question becomes a task, and the reply says which number it was logged as.

## Cost

One answer is one Claude call. `/status` and `/tasks` use none. The daily cap (120 by default) is a
setting, and when it is reached the bot says so and still answers with the numbers.

## Files

- `packages/jobs/src/telegram/brief.ts` — what it knows and how it behaves
- `packages/jobs/src/telegram/snapshot.ts` — the live numbers
- `packages/jobs/src/telegram/assistant.ts` — the handler, commands, tasks, caps
- `packages/jobs/src/telegram/files.ts` — downloading a screenshot
- `apps/api/src/index.ts` — `POST /webhooks/telegram`, `/api/tasks`
- `apps/admin/src/pages/Requests.tsx` — the Requests page
