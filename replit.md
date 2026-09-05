# Rolex Casino Bot

A private Telegram casino prototype with play-credit games, PvP challenges, channel verification, player statistics, and admin controls.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `TELEGRAM_BOT_TOKEN` — token issued by BotFather
- Optional env: `ADMIN_TELEGRAM_IDS` — comma-separated Telegram numeric IDs

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- Telegram bot: `artifacts/api-server/src/telegram/bot.ts`
- Database schema: `lib/db/src/schema/casino.ts`

## Architecture decisions

- The unlicensed prototype uses non-redeemable play credits only.
- Payment and withdrawal commands are intentionally locked.
- Game balance changes use row locks and database transactions.

## Product

- Telegram onboarding and required-channel verification
- Game directory, wallet, statistics, leaderboard, and support
- PvB coin/dice games and initial PvP challenge creation
- Restricted ban, unban, balance, and platform-stat admin controls

## User preferences

- Product identity: Rolex–casino-bot, English language.
- Community channel: `@RolexCasinos`.

## Gotchas

- The bot must be a channel administrator for reliable membership checks.
- Never enable real-money payment settlement without licensing and compliance controls.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
