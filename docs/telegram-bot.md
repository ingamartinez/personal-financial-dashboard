# Telegram bot

> **Work in progress.** Issue [#185](../../../issues/185) is migrating from a
> single long-poll bot to per-user webhooks. This doc is pruned mid-flight:
> the old polling setup is gone, the new `/settings/telegram` UI lands in
> PR4 ([#220](../../../issues/220)). Once that ships, this file is rewritten
> end-to-end.

## Status

- PR1 ([#217](../../../issues/217)) ✅ — AES-256-GCM crypto helper.
- PR2 ([#218](../../../issues/218)) — **this PR**. Adds `telegram_bots`
  table, drops `telegram_poll_state`, deletes the long-poll worker. Telegram
  ingestion is intentionally non-functional until PR3 ships.
- PR3 ([#219](../../../issues/219)) — webhook route
  (`/api/telegram/webhook/[botId]`) + `userId` threading through the router.
- PR4 ([#220](../../../issues/220)) — `/settings/telegram` UI to paste a
  BotFather token, call `setWebhook`, persist the encrypted row.
- PR5 ([#221](../../../issues/221)) — cleanup, if anything remains.

## Env

Set once in `.env.local` (dev) and `/srv/findash/env/findash.env` (prod):

```
TELEGRAM_TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
```

The decoded key must be exactly 32 bytes. Rotating it invalidates every
stored bot token — users have to re-register from `/settings/telegram`
(no migration tooling is planned; clean slate by design).

## After PR4 ships

1. Open `/settings/telegram` in the app.
2. Create a bot with `@BotFather` on Telegram (`/newbot`).
3. Paste the BotFather token in the form.
4. The server calls `setWebhook` against
   `https://findash.alejoframes.com/api/telegram/webhook/<your-bot-id>` with
   a per-bot secret header; the row is persisted with the token AES-GCM
   encrypted.
5. Start chatting with your bot in Telegram.

Further detail (messaging commands, troubleshooting, revoke flow) will land
alongside PR4.
