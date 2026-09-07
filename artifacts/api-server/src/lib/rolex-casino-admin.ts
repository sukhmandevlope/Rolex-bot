import type { CasinoStatsSummary, Currency } from "./rolex-casino-stats";

const INR_PER_USD = 98;

export const ADMIN_RESTRICTED_MESSAGE =
  "This command is restricted to RolexCasino administrators.";

export const USER_INSPECTION_COMMANDS = new Set([
  "userstats",
  "checkstats",
  "userbalance",
  "checkbalance",
  "userinfo",
  "userdetails",
  "checkuser",
]);

export type AdminTarget =
  | { kind: "reply"; telegramUserId: number }
  | { kind: "telegram_id"; telegramUserId: number }
  | { kind: "username"; username: string };

export function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, "").trim().toLowerCase();
}

export function selectUniqueUsernameMatch<T>(
  matches: readonly T[],
): T | undefined {
  return matches.length === 1 ? matches[0] : undefined;
}

export function isAdminUser(
  userId: number,
  configuredIds: string | undefined,
): boolean {
  return new Set(
    (configuredIds ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  ).has(userId);
}

export function parseAdminTarget(input: {
  replyFromId?: number;
  args: readonly string[];
}): AdminTarget | undefined {
  if (
    input.replyFromId !== undefined &&
    Number.isSafeInteger(input.replyFromId) &&
    input.replyFromId > 0
  ) {
    return { kind: "reply", telegramUserId: input.replyFromId };
  }

  const rawTarget = input.args[0]?.trim();
  if (!rawTarget) return undefined;

  const telegramUserId = Number(rawTarget);
  if (Number.isSafeInteger(telegramUserId) && telegramUserId > 0) {
    return { kind: "telegram_id", telegramUserId };
  }

  const username = normalizeUsername(rawTarget);
  return username ? { kind: "username", username } : undefined;
}

type AdminPlayer = {
  displayName: string;
  telegramUserId: number;
  payoutWallet: string | null;
};

type AdminWallet = {
  currency: string;
  balanceMinor: number;
};

function escapeTelegramText(value: string): string {
  return value.replace(/[&<>]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    return "&gt;";
  });
}

function formatMoney(amountMinor: number, currency: Currency): string {
  const amount = (amountMinor / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "INR" ? `₹${amount}` : `$${amount}`;
}

function maskPayoutWallet(value: string | null): string {
  if (!value) return "not set";
  if (value.length <= 6) return `${value.slice(0, 2)}•••`;
  return `${value.slice(0, 3)}•••${value.slice(-3)}`;
}

function convertMinor(amountMinor: number, from: Currency, to: Currency): number {
  if (from === to) return amountMinor;
  return from === "INR"
    ? Math.round(amountMinor / INR_PER_USD)
    : amountMinor * INR_PER_USD;
}

export function formatAdminUserStats(
  player: Pick<AdminPlayer, "displayName" | "telegramUserId">,
  stats: CasinoStatsSummary,
): string {
  return [
    "📊 Admin user statistics",
    "",
    `User: ${escapeTelegramText(player.displayName)}`,
    `Telegram ID: ${player.telegramUserId}`,
    `Category: ${stats.category}`,
    "VIP threshold: ₹1,00,000 wager equivalent",
    "",
    ...stats.currencies.map(
      (item) =>
        `${item.currency}: ${item.rounds} rounds · ${item.wins} wins · Wager ${formatMoney(item.wagerMinor, item.currency)} · Profit ${formatMoney(item.profitMinor, item.currency)}`,
    ),
    `Total wager equivalent: ${formatMoney(stats.wagerInrMinor, "INR")}`,
  ].join("\n");
}

export function formatAdminUserBalance(
  player: Pick<AdminPlayer, "displayName" | "telegramUserId" | "payoutWallet">,
  wallets: readonly AdminWallet[],
): string {
  const inr = wallets.find((wallet) => wallet.currency === "INR")?.balanceMinor ?? 0;
  const usd = wallets.find((wallet) => wallet.currency === "USD")?.balanceMinor ?? 0;
  return [
    "💰 Admin user balance",
    "",
    `User: ${escapeTelegramText(player.displayName)}`,
    `Telegram ID: ${player.telegramUserId}`,
    `INR balance: ${formatMoney(inr, "INR")}`,
    `USD balance: ${formatMoney(usd, "USD")}`,
    `Total INR equivalent: ${formatMoney(inr + convertMinor(usd, "USD", "INR"), "INR")}`,
    `Payout wallet: ${maskPayoutWallet(player.payoutWallet)}`,
    "Sandbox wallet: INR and USD balances shown above",
    "Cash movement: SANDBOX simulation only",
  ].join("\n");
}