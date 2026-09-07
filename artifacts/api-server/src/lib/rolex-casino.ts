import { randomInt, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  casinoChallengeParticipantsTable,
  casinoChallengeRollsTable,
  casinoChallengesTable,
  casinoCashRequestsTable,
  casinoDailyBonusSettingsTable,
  casinoEscrowsTable,
  casinoGameBetSettingsTable,
  casinoGameRoundsTable,
  casinoHouseWalletsTable,
  casinoJackpotParticipantsTable,
  casinoJackpotsTable,
  casinoLedgerEntriesTable,
  casinoPlayersTable,
  casinoPromoClaimsTable,
  casinoPromoCodesTable,
  casinoWagerRequirementsTable,
  casinoWalletsTable,
  db,
} from "@workspace/db";
import { logger } from "./logger";
import {
  ADMIN_RESTRICTED_MESSAGE,
  USER_INSPECTION_COMMANDS,
  formatAdminUserBalance,
  formatAdminUserStats,
  isAdminUser,
  normalizeUsername,
  parseAdminTarget,
  selectUniqueUsernameMatch,
} from "./rolex-casino-admin";
import { INR_PER_USD, summarizeCasinoStats } from "./rolex-casino-stats";
import type { Currency, CasinoStatsSummary } from "./rolex-casino-stats";
import {
  BATTLE_TURN_TIMEOUT_MS,
  battleTimeoutOutcome,
  calculateBattlePayouts,
  isBattleTurnExpired,
  resolveBattleRounds,
  scoreBattleRound,
  sevenUpMultiplier,
  sumBattleRolls,
} from "./rolex-casino-battle-rules";
import {
  createEscrow,
  escrowErrorText,
  releaseEscrow,
} from "./rolex-casino-escrow";

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  type: string;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date?: number;
  text?: string;
  caption?: string;
  dice?: { emoji: string; value: number };
  photo?: Array<{ file_id: string; width: number; height: number }>;
  forward_from?: TelegramUser;
  forward_origin?: unknown;
  is_automatic_forward?: boolean;
  reply_to_message?: TelegramMessage;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

type TelegramSticker = {
  emoji?: string;
  custom_emoji_id?: string;
};

type TelegramStickerSet = {
  stickers: TelegramSticker[];
};

type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

type BotConfig = {
  label: string;
  token: string;
  gameType?: "slots" | "dice" | "darts";
  emoji?: string;
};

type GameResult = {
  outcome: string;
  multiplier: number;
};

const SUPPORTED_CURRENCIES = ["INR", "USD"] as const;
const MIN_BET_INR_MINOR = 1_000;
const MAX_BET_INR_MINOR = 50_000;
const CONFIGURABLE_GAME_TYPES = new Set([
  "dice",
  "darts",
  "bowling",
  "basketball",
  "football",
  "slots",
  "7up",
  "dr",
]);
const MIN_DEPOSIT_MINOR: Record<Currency, number> = { INR: 5_000, USD: 50 };
const MAX_DEPOSIT_MINOR: Record<Currency, number> = { INR: 500_000, USD: 5_000 };
const MIN_WITHDRAWAL_MINOR: Record<Currency, number> = {
  INR: 10_000,
  USD: 100,
};
const TIP_CONFIRMATION_THRESHOLD_INR_MINOR = 5_000;
const WITHDRAWAL_FEE_RATE = 0.04;
const REFERRAL_BONUS_MINOR: Record<Currency, number> = { INR: 500, USD: 50 };
const JACKPOT_CONTRIBUTION_RATE = 0.005;
const DEPOSIT_NETWORKS = ["upi", "btc", "bsc", "solana", "ethereum"] as const;
type DepositNetwork = (typeof DEPOSIT_NETWORKS)[number];
type CashFlowStage = "amount" | "network" | "paid" | "utr" | "screenshot" | "address";

type PendingDeposit = {
  stage: CashFlowStage;
  amountMinor?: number;
  currency?: Currency;
  requestId?: number;
  network?: DepositNetwork;
  address?: string;
  utr?: string;
};

type PendingWithdrawal = {
  stage: CashFlowStage;
  amountMinor?: number;
  currency?: Currency;
  network?: DepositNetwork;
  address?: string;
};

const pendingDeposits = new Map<number, PendingDeposit>();
const pendingWithdrawals = new Map<number, PendingWithdrawal>();
const pendingWalletSetups = new Map<number, DepositNetwork>();
const withdrawalConfirmations = new Map<
  string,
  {
    userId: number;
    playerId: number;
    amountMinor: number;
    feeMinor: number;
    currency: Currency;
    network: DepositNetwork;
    address: string;
  }
>();
let casinoPowerOn = true;

const MAINTENANCE_MESSAGE =
  "🔧 RolexCasino is temporarily in maintenance mode. Please try again later.";

const helperConfigs: BotConfig[] = [
  {
    label: "slots-helper",
    token: process.env.TELEGRAM_HELPER_BOT_1_TOKEN ?? "",
    gameType: "slots",
    emoji: "🎰",
  },
  {
    label: "dice-helper",
    token: process.env.TELEGRAM_HELPER_BOT_2_TOKEN ?? "",
    gameType: "dice",
    emoji: "🎲",
  },
  {
    label: "darts-helper",
    token: process.env.TELEGRAM_HELPER_BOT_3_TOKEN ?? "",
    gameType: "darts",
    emoji: "🎯",
  },
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeTelegramText(value: string): string {
  return value.replace(/[&<>]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    return "&gt;";
  });
}

const premiumEmojiByUnicode = new Map<string, string>();

function applyPremiumEmojis(
  text: string,
  options?: { copyableCode?: string },
): {
  text: string;
  parseMode?: "HTML";
} {
  const copyableCode = options?.copyableCode
    ? escapeTelegramText(options.copyableCode)
    : null;
  const hasHtmlMarkup = /<\/?(?:b|strong|code|i|u)>/.test(text);
  if (premiumEmojiByUnicode.size === 0 && !copyableCode && !hasHtmlMarkup) return { text };

  let formatted = escapeTelegramText(text);
  if (hasHtmlMarkup) {
    formatted = formatted.replace(
      /&lt;(\/?(?:b|strong|code|i|u))&gt;/g,
      "<$1>",
    );
  }
  const codeToken = copyableCode && formatted.includes(copyableCode)
    ? "\uE100"
    : null;
  if (codeToken && copyableCode) {
    formatted = formatted.split(copyableCode).join(codeToken);
  }
  const replacements: Array<{ token: string; tag: string }> = [];
  let replacementIndex = 0;
  for (const [unicode, customEmojiId] of [...premiumEmojiByUnicode.entries()].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    if (!formatted.includes(unicode)) continue;
    const token = `\uE000${replacementIndex}\uE001`;
    formatted = formatted.split(unicode).join(token);
    replacements.push({
      token,
      tag: `<tg-emoji emoji-id="${customEmojiId}">${unicode}</tg-emoji>`,
    });
    replacementIndex += 1;
  }
  if (replacements.length === 0 && !codeToken) {
    const preferredId = premiumEmojiByUnicode.get("✨");
    const fallbackEntry = premiumEmojiByUnicode.entries().next().value as
      | [string, string]
      | undefined;
    const defaultEntry = preferredId
      ? (["✨", preferredId] as [string, string])
      : fallbackEntry;
    if (defaultEntry) {
      const [unicode, customEmojiId] = defaultEntry;
      const token = `\uE000${replacementIndex}\uE001`;
      formatted = `${formatted}\n${token}`;
      replacements.push({
        token,
        tag: `<tg-emoji emoji-id="${customEmojiId}">${unicode}</tg-emoji>`,
      });
    }
  }

  for (const replacement of replacements) {
    formatted = formatted.split(replacement.token).join(replacement.tag);
  }
  if (codeToken && copyableCode) {
    formatted = formatted
      .split(codeToken)
      .join(`<code>${copyableCode}</code>`);
  }
  return replacements.length > 0 || Boolean(codeToken) || hasHtmlMarkup
    ? { text: formatted, parseMode: "HTML" }
    : { text };
}

function playerName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "Player";
}

function parseCurrency(value: string | undefined, fallback: Currency): Currency {
  const normalized = value?.toUpperCase();
  return normalized === "INR" || normalized === "USD" ? normalized : fallback;
}

function parseMoney(value: string | undefined): number | null {
  if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const minor = Math.round(amount * 100);
  return minor > 0 && minor <= 2_000_000_000 ? minor : null;
}

function formatMoney(amountMinor: number, currency: Currency): string {
  const amount = (amountMinor / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "INR" ? `₹${amount}` : `$${amount}`;
}

function convertMinor(amountMinor: number, from: Currency, to: Currency): number {
  if (from === to) return amountMinor;
  return from === "INR"
    ? Math.round(amountMinor / INR_PER_USD)
    : amountMinor * INR_PER_USD;
}

async function configuredMinimumBetMinor(
  gameType: string | undefined,
  currency: Currency,
): Promise<number> {
  if (!gameType) {
    return currency === "INR"
      ? MIN_BET_INR_MINOR
      : Math.ceil(MIN_BET_INR_MINOR / INR_PER_USD);
  }
  const [setting] = await db
    .select()
    .from(casinoGameBetSettingsTable)
    .where(
      and(
        eq(casinoGameBetSettingsTable.gameType, gameType),
        eq(casinoGameBetSettingsTable.currency, currency),
      ),
    )
    .limit(1);
  if (setting) return setting.minimumBetMinor;
  return currency === "INR"
    ? MIN_BET_INR_MINOR
    : Math.ceil(MIN_BET_INR_MINOR / INR_PER_USD);
}

async function betInRange(
  amountMinor: number,
  currency: Currency,
  gameType?: string,
): Promise<boolean> {
  const amountInrMinor = convertMinor(amountMinor, currency, "INR");
  const minimumMinor = await configuredMinimumBetMinor(gameType, currency);
  return amountMinor >= minimumMinor && amountInrMinor <= MAX_BET_INR_MINOR;
}

function betLimitText(currency: Currency, minimumMinor?: number): string {
  const minMinor = minimumMinor ??
    (currency === "INR"
      ? MIN_BET_INR_MINOR
      : Math.ceil(MIN_BET_INR_MINOR / INR_PER_USD));
  const maxMinor =
    currency === "INR"
      ? MAX_BET_INR_MINOR
      : Math.floor(MAX_BET_INR_MINOR / INR_PER_USD);
  const min = formatMoney(minMinor, currency);
  const max = formatMoney(maxMinor, currency);
  return `Bet limits: ${min} minimum to ${max} maximum (1 USD = ₹${INR_PER_USD}).`;
}

async function configuredBetLimitText(
  currency: Currency,
  gameType: string,
): Promise<string> {
  return betLimitText(
    currency,
    await configuredMinimumBetMinor(gameType, currency),
  );
}

function normalizeConfigurableGameType(value: string | undefined): string | null {
  const normalized = value?.toLowerCase().replace(/[-_]/g, "");
  const aliases: Record<string, string> = {
    dice: "dice",
    darts: "darts",
    bowling: "bowling",
    basket: "basketball",
    basketball: "basketball",
    football: "football",
    slots: "slots",
    "7up": "7up",
    dr: "dr",
    dicerush: "dr",
  };
  const gameType = aliases[normalized ?? ""];
  return gameType && CONFIGURABLE_GAME_TYPES.has(gameType) ? gameType : null;
}

function commandFrom(text: string | undefined): {
  command: string;
  args: string[];
} {
  const [rawCommand, ...args] = text?.trim().split(/\s+/) ?? [];
  return {
    command:
      rawCommand?.replace(/^\/+/, "").split("@")[0].toLowerCase() ?? "",
    args,
  };
}

function isGroupChat(chat: TelegramChat): boolean {
  return chat.type === "group" || chat.type === "supergroup";
}

function isPrivateChat(chat: TelegramChat): boolean {
  return chat.type === "private";
}

function isOfficialGameChat(chat: TelegramChat): boolean {
  const officialChatId = Number(process.env.CASINO_MAIN_GROUP_CHAT_ID ?? "");
  return (
    isGroupChat(chat) &&
    Number.isSafeInteger(officialChatId) &&
    chat.id === officialChatId
  );
}

function adminTelegramIds(): number[] {
  return (process.env.CASINO_ADMIN_TELEGRAM_IDS ?? process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function privateBotUrl(bot: TelegramBot, start = ""): string {
  const username = bot.botUsername.replace(/^@/, "");
  return `https://t.me/${username}${start ? `?start=${encodeURIComponent(start)}` : ""}`;
}

function officialGroupUrl(): string {
  const configured = process.env.CASINO_OFFICIAL_GROUP_URL?.trim();
  if (configured) return configured;
  const username = (process.env.CASINO_MAIN_GROUP_USERNAME ?? "RolexCasinos").replace(/^@/, "");
  return `https://t.me/${username}`;
}

function ownedCallback(action: string, telegramUserId: number): string {
  return `owner:${telegramUserId}:${action}`;
}

function resolveCallbackOwner(
  action: string,
  telegramUserId: number,
): string | null {
  if (!action.startsWith("owner:")) return action;
  const [, rawOwner, ...rest] = action.split(":");
  return Number(rawOwner) === telegramUserId ? rest.join(":") : null;
}

function privateOnlyKeyboard(bot: TelegramBot, start: "deposit" | "withdraw") {
  return {
    inline_keyboard: [[
      {
        text: start === "deposit" ? "Open Private Deposit" : "Open Private Withdrawal",
        url: privateBotUrl(bot, start),
      },
    ]],
  };
}

function officialGroupKeyboard() {
  return {
    inline_keyboard: [[{ text: "Join Official Group", url: officialGroupUrl() }]],
  };
}

function paymentAddress(network: DepositNetwork): string {
  const envKeys: Record<DepositNetwork, string> = {
    upi: "DEPOSIT_UPI_ADDRESS",
    btc: "DEPOSIT_BTC_ADDRESS",
    bsc: "DEPOSIT_BSC_ADDRESS",
    solana: "DEPOSIT_SOLANA_ADDRESS",
    ethereum: "DEPOSIT_ETHEREUM_ADDRESS",
  };
  return process.env[envKeys[network]]?.trim() ?? "";
}

function networkLabel(network: DepositNetwork): string {
  return {
    upi: "UPI (INR)",
    btc: "BTC",
    bsc: "BSC (BEP20)",
    solana: "Solana",
    ethereum: "Ethereum",
  }[network];
}

function networkSupportsCurrency(network: DepositNetwork, currency: Currency): boolean {
  return currency === "INR" ? network === "upi" : network !== "upi";
}

const FAIR_ID_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789_-";

function createFairId(): string {
  let value = "PF_";
  while (value.length < 24) {
    value += FAIR_ID_ALPHABET[randomInt(FAIR_ID_ALPHABET.length)];
  }
  return value;
}

function parseAmountAndCurrency(
  value: string | undefined,
  fallback: Currency,
): { amountMinor: number | null; currency: Currency } {
  const tokens = value?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (
    tokens.length > 2 ||
    (tokens.length === 2 && !isSupportedCurrency(tokens[1].toUpperCase()))
  ) {
    return { amountMinor: null, currency: fallback };
  }
  const amountMinor = parseMoney(tokens[0]);
  const currency = parseCurrency(tokens[1], fallback);
  return { amountMinor, currency };
}

function depositAmountIsValid(amountMinor: number, currency: Currency): boolean {
  return (
    amountMinor >= MIN_DEPOSIT_MINOR[currency] &&
    amountMinor <= MAX_DEPOSIT_MINOR[currency]
  );
}

function depositLimitText(currency: Currency): string {
  return `Deposit limits: ${formatMoney(MIN_DEPOSIT_MINOR[currency], currency)} to ${formatMoney(MAX_DEPOSIT_MINOR[currency], currency)}.`;
}

function withdrawalFeeMinor(amountMinor: number): number {
  return Math.max(1, Math.ceil(amountMinor * WITHDRAWAL_FEE_RATE));
}

function payoutAddressIsValid(network: DepositNetwork, value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 120 || /\s/.test(normalized)) {
    return false;
  }
  if (network === "upi") return /^[a-zA-Z0-9._-]{2,100}@[a-zA-Z]{2,30}$/.test(normalized);
  if (network === "btc") {
    return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,90}$/.test(normalized);
  }
  if (network === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalized);
  return /^0x[a-fA-F0-9]{40}$/.test(normalized);
}

function proofIsValid(network: DepositNetwork, value: string): boolean {
  const normalized = value.trim();
  if (network === "upi") return /^\d{12}$/.test(normalized);
  return /^[A-Za-z0-9._:-]{60,}$/.test(normalized);
}

function noteForCashRequest(input: Record<string, unknown>): string {
  return JSON.stringify({ rolex: 1, ...input });
}

function cashRequestNote(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function maskedDestination(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}•••`;
  return `${value.slice(0, 4)}•••${value.slice(-4)}`;
}

function referralCodeFor(userId: number): string {
  return `ROLEX${userId.toString(36).toUpperCase()}`;
}

function maskPayoutWallet(value: string | null): string {
  if (!value) return "not set";
  if (value.length <= 6) return `${value.slice(0, 2)}•••`;
  return `${value.slice(0, 3)}•••${value.slice(-3)}`;
}

function isSupportedCurrency(value: string): value is Currency {
  return SUPPORTED_CURRENCIES.includes(value as Currency);
}

function isAdmin(userId: number): boolean {
  return isAdminUser(userId, process.env.CASINO_ADMIN_TELEGRAM_IDS);
}

class TelegramBot {
  private offset = 0;
  private username = "";
  private readonly config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  get label(): string {
    return this.config.label;
  }

  get gameType(): BotConfig["gameType"] {
    return this.config.gameType;
  }

  get emoji(): string {
    return this.config.emoji ?? "";
  }

  get botUsername(): string {
    return this.username;
  }

  async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.token}/${method}`,
      {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(
        `${this.config.label} ${method} failed: ${payload.description ?? response.statusText}`,
      );
    }
    return payload.result;
  }

  async initialize(): Promise<void> {
    const me = await this.call<TelegramUser>("getMe");
    this.username = me.username ?? "";
    logger.info(
      { bot: this.config.label, username: this.username },
      "RolexCasino Telegram bot connected",
    );
  }

  async getStickerSet(name: string): Promise<TelegramStickerSet> {
    return this.call<TelegramStickerSet>("getStickerSet", { name });
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: {
      inline_keyboard: InlineKeyboardButton[][];
    },
  ): Promise<TelegramMessage> {
    const formatted = applyPremiumEmojis(text);
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: formatted.text,
      ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async sendPhoto(
    chatId: number,
    photo: Buffer,
    caption?: string,
    replyMarkup?: {
      inline_keyboard: InlineKeyboardButton[][];
    },
    options?: { copyableCode?: string },
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const photoBytes = photo.buffer.slice(
      photo.byteOffset,
      photo.byteOffset + photo.byteLength,
    ) as ArrayBuffer;
    form.append("photo", new Blob([photoBytes], { type: "image/png" }), "rolex-stats.png");
    const formattedCaption = caption
      ? applyPremiumEmojis(caption, options)
      : undefined;
    if (formattedCaption) {
      form.append("caption", formattedCaption.text);
      if (formattedCaption.parseMode) form.append("parse_mode", formattedCaption.parseMode);
    }
    if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.token}/sendPhoto`,
      { method: "POST", body: form },
    );
    const payload = (await response.json()) as TelegramResponse<TelegramMessage>;
    if (!response.ok || !payload.ok) {
      throw new Error(
        `${this.config.label} sendPhoto failed: ${payload.description ?? response.statusText}`,
      );
    }
    return payload.result;
  }

  async sendPhotoFileId(
    chatId: number,
    fileId: string,
    caption?: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
  ): Promise<TelegramMessage> {
    const formattedCaption = caption ? applyPremiumEmojis(caption) : undefined;
    return this.call<TelegramMessage>("sendPhoto", {
      chat_id: chatId,
      photo: fileId,
      ...(formattedCaption ? { caption: formattedCaption.text } : {}),
      ...(formattedCaption?.parseMode ? { parse_mode: formattedCaption.parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async editPhoto(
    chatId: number,
    messageId: number,
    photo: Buffer,
    caption?: string,
    replyMarkup?: {
      inline_keyboard: InlineKeyboardButton[][];
    },
    options?: { copyableCode?: string },
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("message_id", String(messageId));
    const formattedCaption = caption
      ? applyPremiumEmojis(caption, options)
      : undefined;
    form.append(
      "media",
      JSON.stringify({
        type: "photo",
        media: "attach://rolex-escrow.png",
        ...(formattedCaption
          ? {
              caption: formattedCaption.text,
              ...(formattedCaption.parseMode
                ? { parse_mode: formattedCaption.parseMode }
                : {}),
            }
          : {}),
      }),
    );
    const photoBytes = photo.buffer.slice(
      photo.byteOffset,
      photo.byteOffset + photo.byteLength,
    ) as ArrayBuffer;
    form.append("rolex-escrow.png", new Blob([photoBytes], { type: "image/png" }), "rolex-escrow.png");
    if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.token}/editMessageMedia`,
      { method: "POST", body: form },
    );
    const payload = (await response.json()) as TelegramResponse<TelegramMessage>;
    if (!response.ok || !payload.ok) {
      throw new Error(
        `${this.config.label} editMessageMedia failed: ${payload.description ?? response.statusText}`,
      );
    }
    return payload.result;
  }

  async pinChatMessage(chatId: number, messageId: number): Promise<void> {
    await this.call("pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  }

  async unpinChatMessage(chatId: number, messageId: number): Promise<void> {
    await this.call("unpinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async sendDice(chatId: number, emoji = this.emoji): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendDice", {
      chat_id: chatId,
      emoji,
    });
  }

  async answerCallback(id: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id });
  }

  async start(handler: (bot: TelegramBot, update: TelegramUpdate) => Promise<void>): Promise<void> {
    while (true) {
      try {
        const updates = await this.call<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 20,
          allowed_updates: ["message", "callback_query"],
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await handler(this, update);
          } catch (error) {
            logger.error(
              { err: error, bot: this.config.label },
              "Telegram update failed",
            );
          }
        }
      } catch (error) {
        logger.error(
          { err: error, bot: this.config.label },
          "Telegram polling failed; retrying",
        );
        await wait(3_000);
      }
    }
  }
}

async function loadPremiumEmojiPack(bot: TelegramBot): Promise<void> {
  const packName = "Emoji_fan37_by_TgEmodziBot";
  try {
    const stickerSet = await bot.getStickerSet(packName);
    let loaded = 0;
    for (const sticker of stickerSet.stickers) {
      if (sticker.emoji && sticker.custom_emoji_id && !premiumEmojiByUnicode.has(sticker.emoji)) {
        premiumEmojiByUnicode.set(sticker.emoji, sticker.custom_emoji_id);
        loaded += 1;
      }
    }
    logger.info(
      { packName, loaded },
      "RolexCasino custom emoji pack loaded",
    );
  } catch (error) {
    logger.warn(
      { err: error, packName },
      "Custom emoji pack unavailable; using standard emoji fallback",
    );
  }
}

function winLogChatId(): number | null {
  const chatId = Number(
    process.env.CASINO_LOG_CHAT_ID ?? process.env.CASINO_WIN_LOG_CHAT_ID ?? "",
  );
  return Number.isSafeInteger(chatId) ? chatId : null;
}

let resolvedTransactionLogChatId: number | null | undefined;

async function transactionLogChatId(bot: TelegramBot): Promise<number | null> {
  if (resolvedTransactionLogChatId !== undefined) {
    return resolvedTransactionLogChatId;
  }
  const configured = winLogChatId();
  if (configured !== null) {
    resolvedTransactionLogChatId = configured;
    return configured;
  }
  const username = (process.env.CASINO_LOG_CHAT_USERNAME ?? "RolexCasinoLOGS").replace(/^@/, "");
  try {
    const chat = await bot.call<TelegramChat>("getChat", { chat_id: `@${username}` });
    resolvedTransactionLogChatId = Number.isSafeInteger(chat.id) ? chat.id : null;
  } catch (error) {
    resolvedTransactionLogChatId = null;
    logger.error(
      { err: error, username },
      "Transaction log channel could not be resolved; configure CASINO_LOG_CHAT_ID or add the bot as an administrator",
    );
  }
  return resolvedTransactionLogChatId;
}

async function auditTransaction(
  bot: TelegramBot,
  text: string,
): Promise<void> {
  const chatId = await transactionLogChatId(bot);
  if (chatId === null) return;
  try {
    await bot.sendMessage(chatId, `<b>🧾 RolexCasino transaction log</b>\n${text}`);
  } catch (error) {
    logger.warn({ err: error, chatId }, "Transaction log delivery failed");
  }
}

async function broadcastPlayerWin(
  bot: TelegramBot,
  playerId: number,
  gameType: string,
  payoutMinor: number,
  currency: Currency,
): Promise<void> {
  const chatId = winLogChatId();
  if (chatId === null || payoutMinor <= 0) return;

  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, playerId))
    .limit(1);
  if (!player) return;

  const winnerName = player.displayName || "Player";
  const time = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date());

  try {
    await bot.sendMessage(
      chatId,
      `🏆🎉 ${gameType.toUpperCase()} ${winnerName} WON ${formatMoney(payoutMinor, currency)} (${time})`,
    );
  } catch (error) {
    logger.warn(
      { err: error, chatId, playerId, gameType },
      "Win-log broadcast failed after a successful settlement",
    );
  }
}

async function ensurePlayer(user: TelegramUser): Promise<typeof casinoPlayersTable.$inferSelect> {
  const username = user.username ? normalizeUsername(user.username) || null : null;
  await db
    .insert(casinoPlayersTable)
    .values({
      telegramUserId: user.id,
      username,
      displayName: playerName(user),
      referralCode: referralCodeFor(user.id),
    })
    .onConflictDoUpdate({
      target: casinoPlayersTable.telegramUserId,
      set: {
        username,
        displayName: playerName(user),
        updatedAt: new Date(),
      },
    });

  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.telegramUserId, user.id))
    .limit(1);
  if (!player) throw new Error("Could not create casino player");
  if (!player.referralCode) {
    await db
      .update(casinoPlayersTable)
      .set({ referralCode: referralCodeFor(user.id), updatedAt: new Date() })
      .where(eq(casinoPlayersTable.id, player.id));
    player.referralCode = referralCodeFor(user.id);
  }
  return player;
}

async function ensureWallet(
  playerId: number,
  currency: Currency,
): Promise<typeof casinoWalletsTable.$inferSelect> {
  await db
    .insert(casinoWalletsTable)
    .values({ playerId, currency })
    .onConflictDoNothing();

  const [wallet] = await db
    .select()
    .from(casinoWalletsTable)
    .where(
      and(
        eq(casinoWalletsTable.playerId, playerId),
        eq(casinoWalletsTable.currency, currency),
      ),
    )
    .limit(1);
  if (!wallet) throw new Error("Could not create casino wallet");
  return wallet;
}

async function ensureHouseWallet(
  currency: Currency,
): Promise<typeof casinoHouseWalletsTable.$inferSelect> {
  await db
    .insert(casinoHouseWalletsTable)
    .values({ currency })
    .onConflictDoNothing();
  const [wallet] = await db
    .select()
    .from(casinoHouseWalletsTable)
    .where(eq(casinoHouseWalletsTable.currency, currency))
    .limit(1);
  if (!wallet) throw new Error("Could not create house wallet");
  return wallet;
}

function jackpotDayInfo(now = new Date()): {
  dayKey: string;
  drawAt: Date;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Calcutta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const dayKey = `${values.year}-${values.month}-${values.day}`;
  return {
    dayKey,
    drawAt: new Date(`${dayKey}T23:59:00+05:30`),
  };
}

async function ensureJackpot(currency: Currency): Promise<
  typeof casinoJackpotsTable.$inferSelect
> {
  const { dayKey, drawAt } = jackpotDayInfo();
  await db
    .insert(casinoJackpotsTable)
    .values({ dayKey, currency, drawAt })
    .onConflictDoNothing();
  const [jackpot] = await db
    .select()
    .from(casinoJackpotsTable)
    .where(
      and(
        eq(casinoJackpotsTable.dayKey, dayKey),
        eq(casinoJackpotsTable.currency, currency),
      ),
    )
    .limit(1);
  if (!jackpot) throw new Error("Could not create jackpot");
  return jackpot;
}

function jackpotContribution(stakeMinor: number, joined: boolean): number {
  return joined
    ? Math.max(1, Math.floor(stakeMinor * JACKPOT_CONTRIBUTION_RATE))
    : 0;
}

function houseContribution(
  stakeMinor: number,
  payoutMinor: number,
): number {
  return payoutMinor > 0
    ? Math.floor(stakeMinor * 0.8)
    : stakeMinor;
}

async function balanceText(playerId: number, preferredCurrency: Currency): Promise<string> {
  const wallets = await db
    .select()
    .from(casinoWalletsTable)
    .where(eq(casinoWalletsTable.playerId, playerId));
  const selectedBalance =
    wallets.find((wallet) => wallet.currency === preferredCurrency)?.balanceMinor ??
    0;
  const alternateCurrency = preferredCurrency === "INR" ? "USD" : "INR";
  const alternateBalance =
    wallets.find((wallet) => wallet.currency === alternateCurrency)?.balanceMinor ??
    0;
  const totalInrMinor = wallets.reduce(
    (total, wallet) =>
      total +
      convertMinor(
        wallet.balanceMinor,
        parseCurrency(wallet.currency, "INR"),
        "INR",
      ),
    0,
  );
  return [
    `💰 ${preferredCurrency} wallet: ${formatMoney(selectedBalance, preferredCurrency)}`,
    `💼 ${alternateCurrency} wallet: ${formatMoney(alternateBalance, alternateCurrency)}`,
    `📊 Total value: ${formatMoney(totalInrMinor, "INR")}`,
    `📈 Rate: 1 USD = ₹${INR_PER_USD}`,
  ].join("\n");
}

async function changePlayerCurrency(
  playerId: number,
  preferredCurrency: Currency,
): Promise<void> {
  await ensureWallet(playerId, "INR");
  await ensureWallet(playerId, "USD");
  const wallets = await db
    .select()
    .from(casinoWalletsTable)
    .where(eq(casinoWalletsTable.playerId, playerId));
  const totalInrMinor = wallets.reduce(
    (total, wallet) =>
      total +
      convertMinor(
        wallet.balanceMinor,
        parseCurrency(wallet.currency, "INR"),
        "INR",
      ),
    0,
  );
  const targetMinor = convertMinor(totalInrMinor, "INR", preferredCurrency);
  const otherCurrency = preferredCurrency === "INR" ? "USD" : "INR";
  await db.transaction(async (tx) => {
    await tx
      .update(casinoWalletsTable)
      .set({ balanceMinor: targetMinor, updatedAt: new Date() })
      .where(
        and(
          eq(casinoWalletsTable.playerId, playerId),
          eq(casinoWalletsTable.currency, preferredCurrency),
        ),
      );
    await tx
      .update(casinoWalletsTable)
      .set({ balanceMinor: 0, updatedAt: new Date() })
      .where(
        and(
          eq(casinoWalletsTable.playerId, playerId),
          eq(casinoWalletsTable.currency, otherCurrency),
        ),
      );
    await tx
      .update(casinoPlayersTable)
      .set({ preferredCurrency, updatedAt: new Date() })
      .where(eq(casinoPlayersTable.id, playerId));
  });
}

async function settleGame(input: {
  playerId: number;
  helperBot: string;
  gameType: string;
  currency: Currency;
  stakeMinor: number;
  rollValue: number;
  result: GameResult;
}): Promise<{ balanceMinor: number; fairId: string }> {
  const wallet = await ensureWallet(input.playerId, input.currency);
  const payoutMinor = Math.floor(input.stakeMinor * input.result.multiplier);
  const transactionId = randomUUID();
  const fairId = createFairId();
  const houseWallet = await ensureHouseWallet(input.currency);
  const jackpot = await ensureJackpot(input.currency);
  const [jackpotParticipant] = await db
    .select()
    .from(casinoJackpotParticipantsTable)
    .where(
      and(
        eq(casinoJackpotParticipantsTable.jackpotId, jackpot.id),
        eq(casinoJackpotParticipantsTable.playerId, input.playerId),
      ),
    )
    .limit(1);
  const jackpotMinor = jackpotContribution(input.stakeMinor, Boolean(jackpotParticipant));
  const totalDebit = input.stakeMinor + jackpotMinor;

  return db.transaction(async (tx) => {
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${payoutMinor} - ${totalDebit}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoWalletsTable.id, wallet.id),
          gte(casinoWalletsTable.balanceMinor, totalDebit),
        ),
      )
      .returning();

    if (!updatedWallet) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId,
      entryType: "game_stake",
      amountMinor: -input.stakeMinor,
      description: `${input.gameType} stake via ${input.helperBot}; fair ${fairId}`,
    });

    if (payoutMinor > 0) {
      await tx.insert(casinoLedgerEntriesTable).values({
        walletId: wallet.id,
        transactionId,
        entryType: "game_payout",
        amountMinor: payoutMinor,
        description: `${input.gameType} payout; fair ${fairId}`,
      });
    }
    if (jackpotMinor > 0 && jackpotParticipant) {
      await tx
        .update(casinoJackpotParticipantsTable)
        .set({
          contributionMinor: sql`${casinoJackpotParticipantsTable.contributionMinor} + ${jackpotMinor}`,
        })
        .where(eq(casinoJackpotParticipantsTable.id, jackpotParticipant.id));
      await tx
        .update(casinoJackpotsTable)
        .set({
          poolMinor: sql`${casinoJackpotsTable.poolMinor} + ${jackpotMinor}`,
        })
        .where(eq(casinoJackpotsTable.id, jackpot.id));
      await tx.insert(casinoLedgerEntriesTable).values({
        walletId: wallet.id,
        transactionId,
        entryType: "jackpot_contribution",
        amountMinor: -jackpotMinor,
        description: `${input.gameType} daily jackpot contribution`,
      });
    }
    await tx
      .update(casinoHouseWalletsTable)
      .set({
        balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} + ${houseContribution(input.stakeMinor, payoutMinor)}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoHouseWalletsTable.id, houseWallet.id));

    await tx.insert(casinoGameRoundsTable).values({
      playerId: input.playerId,
      helperBot: input.helperBot,
      gameType: input.gameType,
      currency: input.currency,
      stakeMinor: input.stakeMinor,
      rollValue: input.rollValue,
      outcome: input.result.outcome,
      payoutMinor,
      fairId,
    });

    await tx
      .insert(casinoWagerRequirementsTable)
      .values({
        playerId: input.playerId,
        currency: input.currency,
        requiredMinor: 0,
        completedMinor: input.stakeMinor,
      })
      .onConflictDoUpdate({
        target: [
          casinoWagerRequirementsTable.playerId,
          casinoWagerRequirementsTable.currency,
        ],
        set: {
          completedMinor: sql`LEAST(${casinoWagerRequirementsTable.requiredMinor}, ${casinoWagerRequirementsTable.completedMinor} + ${input.stakeMinor})`,
          updatedAt: new Date(),
        },
      });

    return { balanceMinor: updatedWallet.balanceMinor, fairId };
  });
}

async function adjustBalance(input: {
  adminId: number;
  telegramUserId: number;
  amountMinor: number;
  currency: Currency;
  entryType: "admin_credit" | "admin_debit";
  description: string;
}): Promise<{ balanceMinor: number; fairId: string }> {
  const player = await ensurePlayer({
    id: input.telegramUserId,
    first_name: `Player ${input.telegramUserId}`,
  });
  const wallet = await ensureWallet(player.id, input.currency);
  const signedAmount =
    input.entryType === "admin_credit" ? input.amountMinor : -input.amountMinor;
  const fairId = createFairId();

  return db.transaction(async (tx) => {
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${signedAmount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoWalletsTable.id, wallet.id),
          input.entryType === "admin_debit"
            ? gte(casinoWalletsTable.balanceMinor, input.amountMinor)
            : sql`true`,
        ),
      )
      .returning();
    if (!updatedWallet) throw new Error("INSUFFICIENT_BALANCE");

    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId: randomUUID(),
      entryType: input.entryType,
      amountMinor: signedAmount,
      description: `${input.description} by admin ${input.adminId}; fair ${fairId}`,
    });
    return { balanceMinor: updatedWallet.balanceMinor, fairId };
  });
}

export async function sandboxDeposit(input: {
  playerId: number;
  amountMinor: number;
  currency: Currency;
}): Promise<{ requestId: number; balanceMinor: number }> {
  const wallet = await ensureWallet(input.playerId, input.currency);
  const transactionId = randomUUID();
  return db.transaction(async (tx) => {
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${input.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, wallet.id))
      .returning();
    if (!updatedWallet) throw new Error("SANDBOX_DEPOSIT_FAILED");

    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId,
      entryType: "sandbox_deposit",
      amountMinor: input.amountMinor,
      description: `Sandbox deposit of ${formatMoney(input.amountMinor, input.currency)}`,
    });
    const [request] = await tx
      .insert(casinoCashRequestsTable)
      .values({
        playerId: input.playerId,
        requestType: "deposit",
        currency: input.currency,
        amountMinor: input.amountMinor,
        status: "completed",
        note: "SANDBOX ONLY — no real payment was processed",
        reviewedAt: new Date(),
      })
      .returning({ id: casinoCashRequestsTable.id });
    if (!request) throw new Error("SANDBOX_DEPOSIT_FAILED");
    return { requestId: request.id, balanceMinor: updatedWallet.balanceMinor };
  });
}

async function sandboxWithdrawal(input: {
  playerId: number;
  amountMinor: number;
  currency: Currency;
  payoutWalletType: string;
}): Promise<{ requestId: number; balanceMinor: number }> {
  const wallet = await ensureWallet(input.playerId, input.currency);
  const transactionId = randomUUID();
  return db.transaction(async (tx) => {
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} - ${input.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoWalletsTable.id, wallet.id),
          gte(casinoWalletsTable.balanceMinor, input.amountMinor),
        ),
      )
      .returning();
    if (!updatedWallet) throw new Error("INSUFFICIENT_BALANCE");

    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId,
      entryType: "sandbox_withdrawal",
      amountMinor: -input.amountMinor,
      description: `Sandbox withdrawal of ${formatMoney(input.amountMinor, input.currency)} via ${input.payoutWalletType}`,
    });
    const [request] = await tx
      .insert(casinoCashRequestsTable)
      .values({
        playerId: input.playerId,
        requestType: "withdrawal",
        currency: input.currency,
        amountMinor: input.amountMinor,
        status: "completed",
        note: `SANDBOX ONLY — simulated ${input.payoutWalletType} payout; no real transfer was processed`,
        reviewedAt: new Date(),
      })
      .returning({ id: casinoCashRequestsTable.id });
    if (!request) throw new Error("SANDBOX_WITHDRAWAL_FAILED");
    return { requestId: request.id, balanceMinor: updatedWallet.balanceMinor };
  });
}

async function createDepositRequest(
  playerId: number,
  amountMinor: number,
  currency: Currency,
): Promise<typeof casinoCashRequestsTable.$inferSelect> {
  const [request] = await db
    .insert(casinoCashRequestsTable)
    .values({
      playerId,
      requestType: "deposit",
      currency,
      amountMinor,
      status: "created",
      fairId: createFairId(),
      note: noteForCashRequest({ kind: "deposit", stage: "network" }),
    })
    .returning();
  if (!request) throw new Error("DEPOSIT_REQUEST_FAILED");
  return request;
}

async function addWagerRequirement(
  playerId: number,
  currency: Currency,
  amountMinor: number,
): Promise<void> {
  await db
    .insert(casinoWagerRequirementsTable)
    .values({
      playerId,
      currency,
      requiredMinor: amountMinor,
      completedMinor: 0,
    })
    .onConflictDoUpdate({
      target: [
        casinoWagerRequirementsTable.playerId,
        casinoWagerRequirementsTable.currency,
      ],
      set: {
        requiredMinor: sql`${casinoWagerRequirementsTable.requiredMinor} + ${amountMinor}`,
        updatedAt: new Date(),
      },
    });
}

async function wagerRemaining(
  playerId: number,
  currency: Currency,
): Promise<number> {
  const [requirement] = await db
    .select()
    .from(casinoWagerRequirementsTable)
    .where(
      and(
        eq(casinoWagerRequirementsTable.playerId, playerId),
        eq(casinoWagerRequirementsTable.currency, currency),
      ),
    )
    .limit(1);
  if (!requirement) return 0;
  return Math.max(0, requirement.requiredMinor - requirement.completedMinor);
}

async function submitWithdrawalRequest(input: {
  playerId: number;
  amountMinor: number;
  feeMinor: number;
  currency: Currency;
  network: DepositNetwork;
  address: string;
}): Promise<{ requestId: number; balanceMinor: number; fairId: string }> {
  const wallet = await ensureWallet(input.playerId, input.currency);
  const transactionId = randomUUID();
  return db.transaction(async (tx) => {
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} - ${input.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoWalletsTable.id, wallet.id),
          gte(casinoWalletsTable.balanceMinor, input.amountMinor),
        ),
      )
      .returning();
    if (!updatedWallet) throw new Error("INSUFFICIENT_BALANCE");

    await tx.insert(casinoLedgerEntriesTable).values([
      {
        walletId: wallet.id,
        transactionId,
        entryType: "withdrawal_hold",
        amountMinor: -(input.amountMinor - input.feeMinor),
        description: `Withdrawal payout hold via ${input.network}`,
      },
      {
        walletId: wallet.id,
        transactionId,
        entryType: "withdrawal_fee",
        amountMinor: -input.feeMinor,
        description: "Withdrawal processing fee (4%)",
      },
    ]);
    const fairId = createFairId();
    const [request] = await tx
      .insert(casinoCashRequestsTable)
      .values({
        playerId: input.playerId,
        requestType: "withdrawal",
        currency: input.currency,
        amountMinor: input.amountMinor - input.feeMinor,
        feeMinor: input.feeMinor,
        fairId,
        status: "pending",
        note: noteForCashRequest({
          kind: "withdrawal",
          network: input.network,
          address: input.address,
          requestedMinor: input.amountMinor,
          payoutMinor: input.amountMinor - input.feeMinor,
        }),
      })
      .returning({ id: casinoCashRequestsTable.id });
    if (!request) throw new Error("WITHDRAWAL_REQUEST_FAILED");
    return { requestId: request.id, balanceMinor: updatedWallet.balanceMinor, fairId };
  });
}

async function notifyAdmins(
  bot: TelegramBot,
  text: string,
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
): Promise<void> {
  await Promise.all(
    adminTelegramIds().map(async (adminId) => {
      try {
        await bot.sendMessage(adminId, text, replyMarkup);
      } catch (error) {
        logger.warn({ err: error, adminId }, "Could not notify casino administrator");
      }
    }),
  );
}

async function approveCashRequest(
  bot: TelegramBot,
  requestId: number,
  adminId: number,
): Promise<"approved" | "rejected" | "unavailable"> {
  if (!isAdmin(adminId)) return "unavailable";
  const [request] = await db
    .select()
    .from(casinoCashRequestsTable)
    .where(eq(casinoCashRequestsTable.id, requestId))
    .limit(1);
  if (!request || request.status !== "submitted" || request.requestType !== "deposit") {
    return "unavailable";
  }
  const currency = parseCurrency(request.currency, "USD");
  const requestNote = cashRequestNote(request.note);
  const requestNetwork = requestNote.network as DepositNetwork | undefined;
  const requestProof = typeof requestNote.utr === "string"
    ? requestNote.utr
    : "";
  if (
    !requestNetwork ||
    !DEPOSIT_NETWORKS.includes(requestNetwork) ||
    !networkSupportsCurrency(requestNetwork, currency) ||
    !proofIsValid(requestNetwork, requestProof) ||
    typeof requestNote.paymentAddress !== "string" ||
    requestNote.paymentAddress !== paymentAddress(requestNetwork)
  ) {
    return "unavailable";
  }
  const result = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(casinoCashRequestsTable)
      .set({ status: "completed", reviewedAt: new Date() })
      .where(
        and(
          eq(casinoCashRequestsTable.id, requestId),
          eq(casinoCashRequestsTable.status, "submitted"),
        ),
      )
      .returning();
    if (!claimed) return null;
    const wallet = await ensureWallet(request.playerId, currency);
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${request.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, wallet.id))
      .returning();
    if (!updatedWallet) throw new Error("DEPOSIT_CREDIT_FAILED");
    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId: randomUUID(),
      entryType: "deposit_credit",
      amountMinor: request.amountMinor,
      description: `Verified ${currency} deposit #${requestId}`,
    });
    await tx
      .insert(casinoWagerRequirementsTable)
      .values({
        playerId: request.playerId,
        currency,
        requiredMinor: request.amountMinor,
        completedMinor: 0,
      })
      .onConflictDoUpdate({
        target: [
          casinoWagerRequirementsTable.playerId,
          casinoWagerRequirementsTable.currency,
        ],
        set: {
          requiredMinor: sql`${casinoWagerRequirementsTable.requiredMinor} + ${request.amountMinor}`,
          updatedAt: new Date(),
        },
      });
    return updatedWallet.balanceMinor;
  });
  if (result === null) return "unavailable";
  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, request.playerId))
    .limit(1);
  if (player) {
    await bot.sendMessage(
      player.telegramUserId,
      [
        "✅ <b>Deposit Approved</b>",
        `Credited: ${formatMoney(request.amountMinor, currency)}`,
        `Balance: ${formatMoney(result, currency)}`,
        `Fair ID: <code>${request.fairId ?? "legacy"}</code>`,
        `Wager requirement added: ${formatMoney(request.amountMinor, currency)} (1×)`,
        "Track progress with /wagerstatus.",
      ].join("\n"),
    );
  }
  await auditTransaction(
    bot,
    [
      "Type: deposit approved",
      `Request: #${request.id}`,
      `Player: ${request.playerId}`,
      `Amount: ${formatMoney(request.amountMinor, currency)}`,
      `Fair ID: <code>${request.fairId ?? "legacy"}</code>`,
      "Status: wallet credited; 1× wagering added",
    ].join("\n"),
  );
  return "approved";
}

async function rejectCashRequest(
  bot: TelegramBot,
  requestId: number,
  adminId: number,
): Promise<"rejected" | "unavailable"> {
  if (!isAdmin(adminId)) return "unavailable";
  const [request] = await db
    .select()
    .from(casinoCashRequestsTable)
    .where(
      and(
        eq(casinoCashRequestsTable.id, requestId),
        eq(casinoCashRequestsTable.status, "submitted"),
      ),
    )
    .limit(1);
  if (!request) return "unavailable";
  const [updated] = await db
    .update(casinoCashRequestsTable)
    .set({ status: "rejected", reviewedAt: new Date() })
    .where(
      and(
        eq(casinoCashRequestsTable.id, requestId),
        eq(casinoCashRequestsTable.status, "submitted"),
      ),
    )
    .returning();
  if (!updated) return "unavailable";
  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, request.playerId))
    .limit(1);
  if (player) {
    await bot.sendMessage(
      player.telegramUserId,
      [
        "❌ <b>Deposit Rejected</b>",
        `Request: #${requestId}`,
        `Amount: ${formatMoney(request.amountMinor, parseCurrency(request.currency, "USD"))}`,
        `Fair ID: <code>${request.fairId ?? "legacy"}</code>`,
        "Contact support with /support if you believe this is incorrect.",
      ].join("\n"),
    );
  }
  await auditTransaction(
    bot,
    [
      "Type: deposit rejected",
      `Request: #${request.id}`,
      `Player: ${request.playerId}`,
      `Amount: ${formatMoney(request.amountMinor, parseCurrency(request.currency, "USD"))}`,
      `Fair ID: <code>${request.fairId ?? "legacy"}</code>`,
      "Status: rejected",
    ].join("\n"),
  );
  return "rejected";
}

async function approveWithdrawal(
  bot: TelegramBot,
  requestId: number,
  adminId: number,
): Promise<"approved" | "unavailable"> {
  if (!isAdmin(adminId)) return "unavailable";
  const [request] = await db
    .select()
    .from(casinoCashRequestsTable)
    .where(
      and(
        eq(casinoCashRequestsTable.id, requestId),
        eq(casinoCashRequestsTable.requestType, "withdrawal"),
        eq(casinoCashRequestsTable.status, "pending"),
      ),
    )
    .limit(1);
  if (!request) return "unavailable";
  const [updated] = await db
    .update(casinoCashRequestsTable)
    .set({ status: "completed", reviewedAt: new Date() })
    .where(
      and(
        eq(casinoCashRequestsTable.id, requestId),
        eq(casinoCashRequestsTable.status, "pending"),
      ),
    )
    .returning();
  if (!updated) return "unavailable";
  const note = cashRequestNote(request.note);
  const payoutMinor = Number(note.payoutMinor) || request.amountMinor;
  const requestedMinor =
    Number(note.requestedMinor) || request.amountMinor + request.feeMinor;
  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, request.playerId))
    .limit(1);
  if (player) {
    await bot.sendMessage(
      player.telegramUserId,
      [
        "✅ <b>Withdrawal Approved</b>",
        `Your withdrawal is approved [<code>${request.id}</code>]`,
        "Check your wallet or contact /support for help!",
        `Requested: ${formatMoney(requestedMinor, parseCurrency(request.currency, "USD"))}`,
        `Fee: ${formatMoney(request.feeMinor, parseCurrency(request.currency, "USD"))} (4%)`,
        `Payout: ${formatMoney(payoutMinor, parseCurrency(request.currency, "USD"))}`,
        `Fair ID: <code>${request.fairId ?? "legacy"}</code>`,
        "Your payout is approved for processing.",
      ].join("\n"),
    );
  }
  await auditTransaction(
    bot,
    [
      "Type: withdrawal approved",
      `Request: #${request.id}`,
      `Player: ${request.playerId}`,
      `Requested: ${formatMoney(requestedMinor, parseCurrency(request.currency, "USD"))}`,
      `Fee: ${formatMoney(request.feeMinor, parseCurrency(request.currency, "USD"))}`,
      `Payout: ${formatMoney(payoutMinor, parseCurrency(request.currency, "USD"))}`,
      `Fair ID: <code>${request.fairId ?? "legacy"}</code>`,
      "Status: approved",
    ].join("\n"),
  );
  return "approved";
}

async function rejectWithdrawal(
  bot: TelegramBot,
  requestId: number,
  adminId: number,
): Promise<"rejected" | "unavailable"> {
  if (!isAdmin(adminId)) return "unavailable";
  const result = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(casinoCashRequestsTable)
      .where(
        and(
          eq(casinoCashRequestsTable.id, requestId),
          eq(casinoCashRequestsTable.requestType, "withdrawal"),
          eq(casinoCashRequestsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (!request) return null;
    const wallet = await ensureWallet(request.playerId, parseCurrency(request.currency, "USD"));
    const [claimed] = await tx
      .update(casinoCashRequestsTable)
      .set({ status: "rejected", reviewedAt: new Date() })
      .where(
        and(
          eq(casinoCashRequestsTable.id, requestId),
          eq(casinoCashRequestsTable.status, "pending"),
        ),
      )
      .returning();
    if (!claimed) return null;
    const refundMinor = request.amountMinor + request.feeMinor;
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${refundMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, wallet.id))
      .returning();
    if (!updatedWallet) throw new Error("WITHDRAWAL_REFUND_FAILED");
    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId: randomUUID(),
      entryType: "withdrawal_refund",
      amountMinor: refundMinor,
      description: `Rejected withdrawal #${requestId}; full requested amount refunded`,
    });
    return { request, balanceMinor: updatedWallet.balanceMinor };
  });
  if (!result) return "unavailable";
  const currency = parseCurrency(result.request.currency, "USD");
  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, result.request.playerId))
    .limit(1);
  if (player) {
    await bot.sendMessage(
      player.telegramUserId,
      [
        "❌ <b>Withdrawal Rejected</b>",
        `Refunded: ${formatMoney(result.request.amountMinor + result.request.feeMinor, currency)}`,
        `Balance: ${formatMoney(result.balanceMinor, currency)}`,
        `Fair ID: <code>${result.request.fairId ?? "legacy"}</code>`,
        "The full requested amount, including the fee, has been returned.",
      ].join("\n"),
    );
  }
  await auditTransaction(
    bot,
    [
      "Type: withdrawal rejected",
      `Request: #${result.request.id}`,
      `Player: ${result.request.playerId}`,
      `Refunded: ${formatMoney(result.request.amountMinor + result.request.feeMinor, currency)}`,
      `Fair ID: <code>${result.request.fairId ?? "legacy"}</code>`,
      "Status: rejected; requested amount and fee refunded",
    ].join("\n"),
  );
  return "rejected";
}

function evaluateRoll(gameType: NonNullable<BotConfig["gameType"]>, value: number): GameResult {
  if (gameType === "slots") {
    if (value === 64) return { outcome: "JACKPOT", multiplier: 10 };
    if (value % 8 === 0) return { outcome: "BIG WIN", multiplier: 5 };
    if (value % 4 === 0) return { outcome: "WIN", multiplier: 2 };
    return { outcome: "NO WIN", multiplier: 0 };
  }
  if (gameType === "dice") {
    if (value === 6) return { outcome: "SIX", multiplier: 5 };
    if (value >= 4) return { outcome: "HIGH ROLL", multiplier: 2 };
    return { outcome: "LOW ROLL", multiplier: 0 };
  }
  if (value === 6) return { outcome: "BULLSEYE", multiplier: 8 };
  if (value >= 4) return { outcome: "ON TARGET", multiplier: 3 };
  return { outcome: "MISS", multiplier: 0 };
}

function mainMenu(
  helperLinks: Map<string, string>,
  ownerTelegramUserId: number,
): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  const keyboard: InlineKeyboardButton[][] = [
    [
      { text: "My balance", callback_data: ownedCallback("main:balance", ownerTelegramUserId) },
      { text: "My profile", callback_data: ownedCallback("main:profile", ownerTelegramUserId) },
    ],
    [
      { text: "Games", callback_data: ownedCallback("main:games", ownerTelegramUserId) },
      { text: "History", callback_data: ownedCallback("main:history", ownerTelegramUserId) },
    ],
    [
      { text: "Deposit", callback_data: ownedCallback("main:deposit", ownerTelegramUserId) },
      { text: "Withdraw", callback_data: ownedCallback("main:withdraw", ownerTelegramUserId) },
    ],
    [
      { text: "Currency", callback_data: ownedCallback("main:currency", ownerTelegramUserId) },
      { text: "Support", callback_data: ownedCallback("main:support", ownerTelegramUserId) },
    ],
  ];
  return { inline_keyboard: keyboard };
}

function currencyKeyboard(
  preferredCurrency: Currency,
  ownerTelegramUserId: number,
): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  return {
    inline_keyboard: [[
      {
        text: `🇮🇳 INR ${preferredCurrency === "INR" ? "✓" : ""}`,
        callback_data: ownedCallback("currency:set:INR", ownerTelegramUserId),
      },
      {
        text: `🇺🇸 USD ${preferredCurrency === "USD" ? "✓" : ""}`,
        callback_data: ownedCallback("currency:set:USD", ownerTelegramUserId),
      },
    ]],
  };
}

async function sendMainWelcome(
  bot: TelegramBot,
  chatId: number,
  helperLinks: Map<string, string>,
  displayName: string,
  privateChat: boolean,
  ownerTelegramUserId: number,
): Promise<void> {
  await bot.sendMessage(
    chatId,
    [
      `<b>✨ Welcome, ${escapeTelegramText(displayName)}!</b>`,
      "",
      "<b>‼️ I'm Rolex–Casino-Bot</b>",
      "",
      privateChat
        ? "Your private account and wallet center is ready."
        : "Games are available in this official RolexCasino group.",
      "",
      "Use /help to see how to play, deposit, withdraw, and get support.",
      "",
      "All balances and cash requests are protected by the casino ledger.",
    ].join("\n"),
    mainMenu(helperLinks, ownerTelegramUserId),
  );
}

async function sendMainHelp(
  bot: TelegramBot,
  chatId: number,
  ownerTelegramUserId: number,
): Promise<void> {
  const diceMinimum = await configuredBetLimitText("INR", "dice");
  const slotsMinimum = await configuredBetLimitText("INR", "slots");
  await bot.sendMessage(
    chatId,
    [
      "<b>🎰 RolexCasino-Bot — how can I help you?</b>",
      "",
      "<b>/games</b> — view available games",
      "<b>/support</b> — contact customer support",
      "<b>/wallet</b> or <b>/bal</b> — view your wallet",
      "<b>/deposit</b> — fund your wallet privately",
      "<b>/withdraw</b> — request a payout privately",
      "<b>/currency</b> — switch INR/USD display",
      "<b>/setwallet</b> — save a payout destination",
      "<b>/mygames</b> — view your latest 10 rounds",
      "<b>/stats</b> — view your performance card",
      "",
      `<b>Game minimums:</b> Dice ${diceMinimum}; Slots ${slotsMinimum}. Use /games for every game.`,
      "",
      "Use the buttons below or send a command to continue.",
    ].join("\n"),
    {
      inline_keyboard: [[
        { text: "🎮 Games", callback_data: ownedCallback("main:games", ownerTelegramUserId) },
        { text: "🎧 Support", callback_data: ownedCallback("main:support", ownerTelegramUserId) },
      ]],
    },
  );
}

async function sendProfile(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  await bot.sendMessage(
    chatId,
    [
      "👤 RolexCasino player profile",
      "",
      `Player ID: ${player.telegramUserId}`,
      `Name: ${player.displayName}`,
      `Username: ${player.username ? `@${player.username}` : "not set"}`,
      `Preferred currency: ${player.preferredCurrency}`,
      `Payout wallet: ${maskPayoutWallet(player.payoutWallet)}`,
      `Referral code: ${player.referralCode ?? "not set"}`,
      "",
      await balanceText(
        player.id,
        parseCurrency(player.preferredCurrency, "USD"),
      ),
    ].join("\n"),
  );
}

async function sendSupport(bot: TelegramBot, chatId: number): Promise<void> {
  await bot.sendMessage(
    chatId,
    [
      "<b>🎧 CUSTOMER SUPPORT</b>",
      "",
      "Need help? Our support team is here to assist you.",
      "",
      "<b>📩 For Customer Support:</b>",
      "Please contact @RolexCasinoMOD",
      "",
      "<b>📝 Support Format:</b>",
      "Username:",
      "User ID:",
      "Issue:",
      "Transaction ID: (if applicable)",
      "Screenshot/Proof: (if applicable)",
      "",
      "⚠️ Important:",
      "Please provide complete and accurate information so our admins can resolve your issue quickly.",
      "",
      "👑 Admin Notice:",
      "For admin-related matters, please inform the admins directly @admins.",
    ].join("\n"),
  );
}

async function sendWallet(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  await bot.sendMessage(
    chatId,
    [
      "<b>🏦 Your Wallet</b>",
      "",
      await balanceText(player.id, parseCurrency(player.preferredCurrency, "USD")),
      "",
      `👨‍💻 Payout wallet: ${maskPayoutWallet(player.payoutWallet)}`,
      "⚠️ Promo Lock: wagering must be completed before withdrawal.",
      "📈 Use /wagerstatus to track your remaining wager.",
      "Minimum withdrawal: ₹100 or $1.00",
    ].join("\n"),
    currencyKeyboard(
      parseCurrency(player.preferredCurrency, "USD"),
      player.telegramUserId,
    ),
  );
}

async function sendMyStats(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  const [rounds, battles] = await Promise.all([
    db
      .select()
      .from(casinoGameRoundsTable)
      .where(eq(casinoGameRoundsTable.playerId, player.id)),
    db
      .select()
      .from(casinoChallengesTable)
      .where(
        and(
          eq(casinoChallengesTable.status, "completed"),
          or(
            eq(casinoChallengesTable.creatorPlayerId, player.id),
            eq(casinoChallengesTable.playerTwoId, player.id),
          ),
        ),
    ),
  ]);
  const stats = summarizeCasinoStats(player.id, rounds, battles);
  const currency = parseCurrency(player.preferredCurrency, "USD");
  const currencyStats = stats.currencies.find((item) => item.currency === currency);
  if (!currencyStats) throw new Error(`Missing stats for supported currency ${currency}`);
  const winRate = currencyStats.rounds
    ? Math.round((currencyStats.wins / currencyStats.rounds) * 100)
    : 0;
  const joined = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeZone: "Asia/Kolkata",
  }).format(new Date(player.createdAt));
  const image = await statsCardPng({
    name: player.displayName,
    joined,
    currency,
    totalWager: formatMoney(currencyStats.wagerMinor, currency),
    totalProfit: formatMoney(currencyStats.profitMinor, currency),
    category: stats.category,
    rounds: currencyStats.rounds,
    winRate,
  });
  await bot.sendPhoto(
    chatId,
    image,
    `📊 ${player.displayName} · ${stats.category} · Total wager ${formatMoney(currencyStats.wagerMinor, currency)}`,
  );
}

type StatsCardData = {
  name: string;
  joined: string;
  currency: Currency;
  totalWager: string;
  totalProfit: string;
  category: string;
  rounds: number;
  winRate: number;
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character] ?? character;
  });
}

function statsCardSvg(data: StatsCardData): string {
  const categoryColor = data.category === "VIP" ? "#f6c453" : "#8da2bd";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101a31"/><stop offset="1" stop-color="#182948"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e5ad43"/><stop offset="1" stop-color="#ffe6a1"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="720" rx="42" fill="url(#bg)"/>
  <circle cx="1040" cy="90" r="190" fill="#3b82f6" opacity=".12"/>
  <circle cx="112" cy="670" r="220" fill="#f59e0b" opacity=".08"/>
  <rect x="42" y="42" width="1116" height="636" rx="32" fill="none" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="86" y="112" fill="#f6c453" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="184" fill="#ffffff" font-size="46" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.name)}</text>
  <text x="86" y="226" fill="#9db0cb" font-size="23" font-family="DejaVu Sans, sans-serif">PLAYER STATISTICS</text>
  <rect x="900" y="92" width="180" height="62" rx="31" fill="${categoryColor}" fill-opacity=".18" stroke="${categoryColor}" stroke-opacity=".8"/>
  <text x="990" y="132" text-anchor="middle" fill="${categoryColor}" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.category)}</text>
  <text x="86" y="286" fill="#8da2bd" font-size="21" font-family="DejaVu Sans, sans-serif">JOINED</text>
  <text x="86" y="323" fill="#ffffff" font-size="27" font-family="DejaVu Sans, sans-serif">${escapeXml(data.joined)}</text>
  <line x1="86" y1="362" x2="1114" y2="362" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="86" y="416" fill="#8da2bd" font-size="20" font-family="DejaVu Sans, sans-serif">TOTAL WAGER (${data.currency})</text>
  <text x="86" y="466" fill="url(#accent)" font-size="42" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.totalWager)}</text>
  <text x="650" y="416" fill="#8da2bd" font-size="20" font-family="DejaVu Sans, sans-serif">TOTAL PROFIT (${data.currency})</text>
  <text x="650" y="466" fill="#76e3a3" font-size="42" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.totalProfit)}</text>
  <text x="86" y="548" fill="#8da2bd" font-size="20" font-family="DejaVu Sans, sans-serif">ROUNDS PLAYED</text>
  <text x="86" y="588" fill="#ffffff" font-size="29" font-family="DejaVu Sans, sans-serif" font-weight="bold">${data.rounds}</text>
  <text x="650" y="548" fill="#8da2bd" font-size="20" font-family="DejaVu Sans, sans-serif">WIN RATE</text>
  <text x="650" y="588" fill="#ffffff" font-size="29" font-family="DejaVu Sans, sans-serif" font-weight="bold">${data.winRate}%</text>
  <text x="86" y="640" fill="#7185a3" font-size="17" font-family="DejaVu Sans, sans-serif">VIP category starts at ₹1,00,000 total wager equivalent.</text>
</svg>`;
}

async function statsCardPng(data: StatsCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`Could not render stats image: ${Buffer.concat(errors).toString("utf8")}`));
      }
    });
    process.stdin.end(statsCardSvg(data));
  });
}

type GameHistoryCardItem = {
  gameType: string;
  currency: string;
  stakeMinor: number;
  outcome: "WIN" | "LOSS" | "TIE";
  createdAt: Date | string;
};

function gameHistoryCardSvg(
  name: string,
  rounds: GameHistoryCardItem[],
): string {
  const rows = rounds
    .map((round, index) => {
      const color =
        round.outcome === "WIN"
          ? "#76e3a3"
          : round.outcome === "TIE"
            ? "#f6c453"
            : "#ff8291";
      const date = new Date(round.createdAt).toLocaleDateString("en-IN");
      const y = 230 + index * 64;
      return [
        `<text x="70" y="${y}" fill="#ffffff" font-size="22" font-family="DejaVu Sans, sans-serif">${index + 1}. ${escapeXml(round.gameType.toUpperCase())}</text>`,
        `<text x="330" y="${y}" fill="#a9bad2" font-size="20" font-family="DejaVu Sans, sans-serif">${escapeXml(round.currency)} ${escapeXml(formatMoney(round.stakeMinor, round.currency as Currency))}</text>`,
        `<text x="580" y="${y}" fill="${color}" font-size="21" font-family="DejaVu Sans, sans-serif" font-weight="bold">${round.outcome}</text>`,
        `<text x="710" y="${y}" fill="#a9bad2" font-size="18" font-family="DejaVu Sans, sans-serif">${escapeXml(date)}</text>`,
        `<line x1="70" y1="${y + 18}" x2="1110" y2="${y + 18}" stroke="#ffffff" stroke-opacity=".08"/>`,
      ].join("");
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="920" viewBox="0 0 1200 920">
  <defs><linearGradient id="historyBg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#101a31"/><stop offset="1" stop-color="#182948"/>
  </linearGradient></defs>
  <rect width="1200" height="920" rx="42" fill="url(#historyBg)"/>
  <rect x="42" y="42" width="1116" height="836" rx="32" fill="none" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="70" y="105" fill="#f6c453" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="4">ROLEXCASINO</text>
  <text x="70" y="164" fill="#ffffff" font-size="38" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(name)}</text>
  <text x="70" y="202" fill="#9db0cb" font-size="20" font-family="DejaVu Sans, sans-serif">LATEST 10 GAME RESULTS</text>
  <text x="70" y="245" fill="#8da2bd" font-size="17" font-family="DejaVu Sans, sans-serif">GAME</text>
  <text x="330" y="245" fill="#8da2bd" font-size="17" font-family="DejaVu Sans, sans-serif">STAKE</text>
  <text x="580" y="245" fill="#8da2bd" font-size="17" font-family="DejaVu Sans, sans-serif">RESULT</text>
  <text x="710" y="245" fill="#8da2bd" font-size="17" font-family="DejaVu Sans, sans-serif">DATE</text>
  ${rows}
</svg>`;
}

async function gameHistoryCardPng(
  name: string,
  rounds: GameHistoryCardItem[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`Could not render game history image: ${Buffer.concat(errors).toString("utf8")}`));
      }
    });
    process.stdin.end(gameHistoryCardSvg(name, rounds));
  });
}

type ReferralLeaderboardItem = {
  rank: number;
  name: string;
  referrals: number;
  earnings: string;
};

function referralLeaderboardSvg(
  items: ReferralLeaderboardItem[],
): string {
  const rows = items.length > 0
    ? items.map((item, index) => {
        const y = 250 + index * 58;
        return [
          `<text x="78" y="${y}" fill="#f6c453" font-size="23" font-family="DejaVu Sans, sans-serif" font-weight="bold">${item.rank}</text>`,
          `<text x="150" y="${y}" fill="#ffffff" font-size="23" font-family="DejaVu Sans, sans-serif">${escapeXml(item.name)}</text>`,
          `<text x="780" y="${y}" text-anchor="end" fill="#76e3a3" font-size="23" font-family="DejaVu Sans, sans-serif" font-weight="bold">${item.referrals}</text>`,
          `<text x="1080" y="${y}" text-anchor="end" fill="#dbe7f5" font-size="21" font-family="DejaVu Sans, sans-serif">${escapeXml(item.earnings)}</text>`,
          `<line x1="78" y1="${y + 19}" x2="1080" y2="${y + 19}" stroke="#ffffff" stroke-opacity=".08"/>`,
        ].join("");
      }).join("")
    : `<text x="600" y="330" text-anchor="middle" fill="#a9bad2" font-size="25" font-family="DejaVu Sans, sans-serif">No verified referrals yet</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <defs><linearGradient id="refBg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#101a31"/><stop offset="1" stop-color="#182948"/>
  </linearGradient></defs>
  <rect width="1200" height="900" rx="42" fill="url(#refBg)"/>
  <circle cx="1070" cy="85" r="200" fill="#eab308" opacity=".12"/>
  <circle cx="90" cy="820" r="210" fill="#2563eb" opacity=".11"/>
  <rect x="42" y="42" width="1116" height="816" rx="32" fill="none" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="78" y="112" fill="#f6c453" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="78" y="174" fill="#ffffff" font-size="40" font-family="DejaVu Sans, sans-serif" font-weight="bold">REFERRAL LEADERBOARD</text>
  <text x="78" y="214" fill="#9db0cb" font-size="20" font-family="DejaVu Sans, sans-serif">VERIFIED INVITES · TOP 10 PLAYERS</text>
  <text x="150" y="236" fill="#8da2bd" font-size="16" font-family="DejaVu Sans, sans-serif">PLAYER</text>
  <text x="780" y="236" text-anchor="end" fill="#8da2bd" font-size="16" font-family="DejaVu Sans, sans-serif">REFERRALS</text>
  <text x="1080" y="236" text-anchor="end" fill="#8da2bd" font-size="16" font-family="DejaVu Sans, sans-serif">EARNED (INR)</text>
  ${rows}
  <text x="78" y="825" fill="#7185a3" font-size="17" font-family="DejaVu Sans, sans-serif">A referral is verified when a new player opens the bot from a referral link.</text>
</svg>`;
}

async function referralLeaderboardPng(
  items: ReferralLeaderboardItem[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`Could not render referral leaderboard image: ${Buffer.concat(errors).toString("utf8")}`));
      }
    });
    process.stdin.end(referralLeaderboardSvg(items));
  });
}

async function sendReferralLeaderboard(
  bot: TelegramBot,
  chatId: number,
): Promise<void> {
  const referredPlayers = await db
    .select({
      referrerId: casinoPlayersTable.referredByPlayerId,
    })
    .from(casinoPlayersTable)
    .where(sql`${casinoPlayersTable.referredByPlayerId} IS NOT NULL`);
  const counts = new Map<number, number>();
  for (const row of referredPlayers) {
    if (row.referrerId != null) {
      counts.set(row.referrerId, (counts.get(row.referrerId) ?? 0) + 1);
    }
  }
  const referrerIds = [...counts.keys()];
  const players = referrerIds.length > 0
    ? await db
        .select()
        .from(casinoPlayersTable)
        .where(inArray(casinoPlayersTable.id, referrerIds))
    : [];
  const playerById = new Map(players.map((player) => [player.id, player]));
  const items = referrerIds
    .map((referrerId) => {
      const player = playerById.get(referrerId);
      return {
        name: player?.username
          ? `@${player.username}`
          : player?.displayName ?? "Player",
        referrals: counts.get(referrerId) ?? 0,
        earningsMinor: player?.referralEarningsMinor ?? 0,
        earnings: formatMoney(player?.referralEarningsMinor ?? 0, "INR"),
      };
    })
    .sort((left, right) =>
      right.referrals - left.referrals ||
      right.earningsMinor - left.earningsMinor,
    )
    .slice(0, 10)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const image = await referralLeaderboardPng(items);
  await bot.sendPhoto(chatId, image, "<b>🤝 Referral leaderboard</b>\nTop verified inviters");
}

async function sendReferral(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  const referrals = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.referredByPlayerId, player.id));
  await bot.sendMessage(
    chatId,
    [
      "🤝 RolexCasino referral center",
      "",
      `Your code: ${player.referralCode ?? referralCodeFor(player.telegramUserId)}`,
      `Your referral link: ${privateBotUrl(bot, `ref_${player.referralCode ?? referralCodeFor(player.telegramUserId)}`)}`,
      `Referrals: ${referrals.length}`,
      "Bonus per verified referral: ₹5.00 + $0.50",
      `Referral earnings recorded: ₹${(player.referralEarningsMinor / 100).toFixed(2)}`,
      "A referral is verified when the new user opens the bot from this link for the first time.",
    ].join("\n"),
  );
}

async function rewardSuccessfulReferral(
  referrer: typeof casinoPlayersTable.$inferSelect,
  referredPlayerId: number,
): Promise<boolean> {
  if (referrer.id === referredPlayerId) return false;
  const inrWallet = await ensureWallet(referrer.id, "INR");
  const usdWallet = await ensureWallet(referrer.id, "USD");
  return db.transaction(async (tx) => {
    const [linkedPlayer] = await tx
      .update(casinoPlayersTable)
      .set({
        referredByPlayerId: referrer.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoPlayersTable.id, referredPlayerId),
          sql`${casinoPlayersTable.referredByPlayerId} IS NULL`,
        ),
      )
      .returning({ id: casinoPlayersTable.id });
    if (!linkedPlayer) return false;

    const transactionId = randomUUID();
    const [updatedInr] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${REFERRAL_BONUS_MINOR.INR}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, inrWallet.id))
      .returning();
    const [updatedUsd] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${REFERRAL_BONUS_MINOR.USD}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, usdWallet.id))
      .returning();
    if (!updatedInr || !updatedUsd) throw new Error("REFERRAL_REWARD_FAILED");

    await tx.insert(casinoLedgerEntriesTable).values([
      {
        walletId: inrWallet.id,
        transactionId,
        entryType: "referral_bonus",
        amountMinor: REFERRAL_BONUS_MINOR.INR,
        description: `Verified referral bonus ₹5.00 from ${referrer.id}`,
      },
      {
        walletId: usdWallet.id,
        transactionId,
        entryType: "referral_bonus",
        amountMinor: REFERRAL_BONUS_MINOR.USD,
        description: `Verified referral bonus $0.50 from ${referrer.id}`,
      },
    ]);
    await tx
      .update(casinoPlayersTable)
      .set({
        referralEarningsMinor: sql`${casinoPlayersTable.referralEarningsMinor} + ${REFERRAL_BONUS_MINOR.INR}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoPlayersTable.id, referrer.id));
    return true;
  });
}

async function sendJackpot(
  bot: TelegramBot,
  chatId: number,
  ownerTelegramUserId: number,
): Promise<void> {
  const jackpots = await Promise.all(
    (["INR", "USD"] as Currency[]).map((currency) => ensureJackpot(currency)),
  );
  const lines = ["✨ <b>Daily Jackpot</b> ✨", ""];
  for (const jackpot of jackpots) {
    const participants = await db
      .select()
      .from(casinoJackpotParticipantsTable)
      .where(eq(casinoJackpotParticipantsTable.jackpotId, jackpot.id));
    const joinedIds = participants.map((participant) => participant.playerId);
    const players =
      joinedIds.length > 0
        ? await db
            .select()
            .from(casinoPlayersTable)
            .where(inArray(casinoPlayersTable.id, joinedIds))
        : [];
    const playerNames = new Map(players.map((player) => [
      player.id,
      player.username ? `@${player.username}` : player.displayName,
    ]));
    const joined = joinedIds.length > 0
      ? joinedIds.slice(0, 8).map((id) => escapeTelegramText(playerNames.get(id) ?? "Player")).join(", ")
      : "No players yet";
    lines.push(
      `<b>${jackpot.currency}</b>`,
      `💰 Current Pool: <b>${formatMoney(jackpot.poolMinor, jackpot.currency as Currency)}</b>`,
      `🎁 Players: ${participants.length}`,
      `👥 Joined: ${joined}`,
      "📊 Contribution: 0.5% of every eligible bet",
      "🔔 Min to draw: ₹100 / $1.00",
      "⏰ Auto draw at: 23:59 Asia/Calcutta",
      "",
    );
  }
  lines.push("🚀 Join a currency below. Every eligible bet then adds 0.5% to that day's jackpot.");
  await bot.sendMessage(chatId, lines.join("\n"), {
    inline_keyboard: [
      [
        { text: "Join INR", callback_data: ownedCallback("jackpot:join:INR", ownerTelegramUserId) },
        { text: "Join USD", callback_data: ownedCallback("jackpot:join:USD", ownerTelegramUserId) },
      ],
      [{ text: "How it works", callback_data: ownedCallback("jackpot:how", ownerTelegramUserId) }],
    ],
  });
}

async function joinJackpot(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  currency: Currency,
): Promise<void> {
  const player = await ensurePlayer(user);
  const jackpot = await ensureJackpot(currency);
  const [joined] = await db
    .insert(casinoJackpotParticipantsTable)
    .values({ jackpotId: jackpot.id, playerId: player.id })
    .onConflictDoNothing()
    .returning();
  await bot.sendMessage(
    chatId,
    joined
      ? `✅ You joined the ${currency} Daily Jackpot. Your eligible ${currency} bets will contribute 0.5% until 23:59.`
      : `You are already in today's ${currency} Daily Jackpot.`,
  );
}

async function drawDueJackpots(bot: TelegramBot): Promise<void> {
  const dueJackpots = await db
    .select()
    .from(casinoJackpotsTable)
    .where(
      and(
        eq(casinoJackpotsTable.status, "active"),
        sql`${casinoJackpotsTable.drawAt} <= NOW()`,
      ),
    );
  for (const jackpot of dueJackpots) {
    const participants = await db
      .select()
      .from(casinoJackpotParticipantsTable)
      .where(eq(casinoJackpotParticipantsTable.jackpotId, jackpot.id));
    if (participants.length === 0 || jackpot.poolMinor <= 0) {
      await db
        .update(casinoJackpotsTable)
        .set({ status: "drawn", drawnAt: new Date() })
        .where(
          and(
            eq(casinoJackpotsTable.id, jackpot.id),
            eq(casinoJackpotsTable.status, "active"),
          ),
        );
      continue;
    }
    const winner = participants[randomInt(participants.length)];
    const winnerWallet = await ensureWallet(winner.playerId, jackpot.currency as Currency);
    const transactionId = randomUUID();
    const [drawn] = await db.transaction(async (tx) => {
      const [updatedJackpot] = await tx
        .update(casinoJackpotsTable)
        .set({
          status: "drawn",
          winnerPlayerId: winner.playerId,
          drawnAt: new Date(),
        })
        .where(
          and(
            eq(casinoJackpotsTable.id, jackpot.id),
            eq(casinoJackpotsTable.status, "active"),
          ),
        )
        .returning();
      if (!updatedJackpot) return [];
      await tx
        .update(casinoWalletsTable)
        .set({
          balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${jackpot.poolMinor}`,
          updatedAt: new Date(),
        })
        .where(eq(casinoWalletsTable.id, winnerWallet.id));
      await tx.insert(casinoLedgerEntriesTable).values({
        walletId: winnerWallet.id,
        transactionId,
        entryType: "jackpot_payout",
        amountMinor: jackpot.poolMinor,
        description: `Daily ${jackpot.currency} jackpot payout`,
      });
      return [updatedJackpot];
    });
    if (!drawn) continue;
    const [winnerPlayer] = await db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.id, winner.playerId))
      .limit(1);
    const message = [
      "🎉 <b>Daily Jackpot Draw</b>",
      `Currency: ${jackpot.currency}`,
      `Prize: <b>${formatMoney(jackpot.poolMinor, jackpot.currency as Currency)}</b>`,
      `Winner: ${escapeTelegramText(winnerPlayer?.displayName ?? "Player")}`,
    ].join("\n");
    const officialChatId = Number(process.env.CASINO_MAIN_GROUP_CHAT_ID ?? "");
    if (Number.isSafeInteger(officialChatId)) {
      await bot.sendMessage(officialChatId, message);
    }
    if (winnerPlayer) {
      await bot.sendMessage(winnerPlayer.telegramUserId, message);
    }
    await auditTransaction(
      bot,
      [
        "Type: jackpot payout",
        `Currency: ${jackpot.currency}`,
        `Winner: ${winnerPlayer?.telegramUserId ?? winner.playerId}`,
        `Amount: ${formatMoney(jackpot.poolMinor, jackpot.currency as Currency)}`,
      ].join("\n"),
    );
  }
}

async function sendWagerStatus(
  bot: TelegramBot,
  chatId: number,
  playerId: number,
  currency: Currency,
): Promise<void> {
  const [requirement] = await db
    .select()
    .from(casinoWagerRequirementsTable)
    .where(
      and(
        eq(casinoWagerRequirementsTable.playerId, playerId),
        eq(casinoWagerRequirementsTable.currency, currency),
      ),
    )
    .limit(1);
  const remaining = requirement
    ? Math.max(0, requirement.requiredMinor - requirement.completedMinor)
    : 0;
  await bot.sendMessage(
    chatId,
    [
      "🎯 Wager status",
      "",
      `Currency: ${currency}`,
      `Required: ${formatMoney(requirement?.requiredMinor ?? 0, currency)}`,
      `Completed: ${formatMoney(requirement?.completedMinor ?? 0, currency)}`,
      `Remaining: ${formatMoney(remaining, currency)}`,
      remaining > 0
        ? "Complete gameplay wagering before requesting a withdrawal."
        : "No active wagering restriction for this currency.",
    ].join("\n"),
  );
}

async function savePayoutWallet(
  playerId: number,
  value: string,
): Promise<"upi" | "crypto"> {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 120 || /\s/.test(normalized)) {
    throw new Error("INVALID_WALLET");
  }
  const type = normalized.includes("@") ? "upi" : "crypto";
  await db
    .update(casinoPlayersTable)
    .set({
      payoutWallet: normalized,
      payoutWalletType: type,
      updatedAt: new Date(),
    })
    .where(eq(casinoPlayersTable.id, playerId));
  return type;
}

async function savePayoutDestination(
  playerId: number,
  network: DepositNetwork,
  value: string,
): Promise<void> {
  if (!payoutAddressIsValid(network, value)) {
    throw new Error("INVALID_WALLET");
  }
  await db
    .update(casinoPlayersTable)
    .set({
      payoutWallet: value.trim(),
      payoutWalletType: network,
      updatedAt: new Date(),
    })
    .where(eq(casinoPlayersTable.id, playerId));
}

async function tipPlayer(input: {
  fromPlayerId: number;
  toPlayerId: number;
  amountMinor: number;
  currency: Currency;
}): Promise<{ balanceMinor: number; fairId: string }> {
  if (input.fromPlayerId === input.toPlayerId) {
    throw new Error("SELF_TIP");
  }
  const senderWallet = await ensureWallet(input.fromPlayerId, input.currency);
  const receiverWallet = await ensureWallet(input.toPlayerId, input.currency);
  const transactionId = randomUUID();
  const fairId = createFairId();
  return db.transaction(async (tx) => {
    const [sender] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} - ${input.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoWalletsTable.id, senderWallet.id),
          gte(casinoWalletsTable.balanceMinor, input.amountMinor),
        ),
      )
      .returning();
    if (!sender) throw new Error("INSUFFICIENT_BALANCE");
    const [receiver] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${input.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, receiverWallet.id))
      .returning();
    if (!receiver) throw new Error("TIP_FAILED");
    await tx.insert(casinoLedgerEntriesTable).values([
      {
        walletId: senderWallet.id,
        transactionId,
        entryType: "tip_sent",
        amountMinor: -input.amountMinor,
        description: `Player tip sent; fair ${fairId}`,
      },
      {
        walletId: receiverWallet.id,
        transactionId,
        entryType: "tip_received",
        amountMinor: input.amountMinor,
        description: `Player tip received; fair ${fairId}`,
      },
    ]);
    return { balanceMinor: sender.balanceMinor, fairId };
  });
}

async function acceptEscrow(
  code: string,
  buyerPlayerId: number,
): Promise<typeof casinoEscrowsTable.$inferSelect> {
  const [escrow] = await db
    .update(casinoEscrowsTable)
    .set({
      status: "accepted",
      acceptedAt: new Date(),
      senderCancelRequestedAt: null,
      recipientCancelRequestedAt: null,
    })
    .where(
      and(
        eq(casinoEscrowsTable.code, code.toUpperCase()),
        eq(casinoEscrowsTable.recipientPlayerId, buyerPlayerId),
        eq(casinoEscrowsTable.status, "pending"),
      ),
    )
    .returning();
  if (!escrow) throw new Error("ESCROW_NOT_ACCEPTABLE");
  return escrow;
}

async function cancelEscrowImmediately(
  code: string,
  actorPlayerId?: number,
): Promise<typeof casinoEscrowsTable.$inferSelect> {
  const [escrow] = await db
    .select()
    .from(casinoEscrowsTable)
    .where(eq(casinoEscrowsTable.code, code.toUpperCase()))
    .limit(1);
  if (!escrow) throw new Error("ESCROW_NOT_FOUND");
  if (actorPlayerId != null && escrow.recipientPlayerId !== actorPlayerId) {
    throw new Error("ESCROW_NOT_SENDER");
  }
  if (actorPlayerId != null && escrow.status !== "pending") {
    if (escrow.status === "accepted") throw new Error("ESCROW_CANCEL_REQUIRES_MUTUAL");
    throw new Error("ESCROW_ALREADY_COMPLETED");
  }
  if (actorPlayerId == null && escrow.status !== "pending" && escrow.status !== "accepted") {
    throw new Error("ESCROW_ALREADY_COMPLETED");
  }
  const sellerWallet = await ensureWallet(
    escrow.senderPlayerId,
    parseCurrency(escrow.currency, "USD"),
  );
  const transactionId = randomUUID();
  return db.transaction(async (tx) => {
    const [cancelled] = await tx
      .update(casinoEscrowsTable)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(
        and(
          eq(casinoEscrowsTable.id, escrow.id),
          actorPlayerId == null
            ? inArray(casinoEscrowsTable.status, ["pending", "accepted"])
            : eq(casinoEscrowsTable.status, "pending"),
        ),
      )
      .returning();
    if (!cancelled) throw new Error("ESCROW_ALREADY_COMPLETED");
    const [seller] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${escrow.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, sellerWallet.id))
      .returning();
    if (!seller) throw new Error("ESCROW_REFUND_FAILED");
    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: sellerWallet.id,
      transactionId,
      entryType: "escrow_refund",
      amountMinor: escrow.amountMinor,
      description: `Escrow ${escrow.code} cancelled; fee retained`,
    });
    return cancelled;
  });
}

type EscrowCancelResult = {
  escrow: typeof casinoEscrowsTable.$inferSelect;
  completed: boolean;
};

async function requestEscrowCancellation(
  code: string,
  actorPlayerId: number,
): Promise<EscrowCancelResult> {
  const normalizedCode = code.toUpperCase();
  return db.transaction(async (tx) => {
    let [escrow] = await tx
      .select()
      .from(casinoEscrowsTable)
      .where(eq(casinoEscrowsTable.code, normalizedCode))
      .limit(1);
    if (!escrow) throw new Error("ESCROW_NOT_FOUND");
    const isSender = escrow.senderPlayerId === actorPlayerId;
    const isRecipient = escrow.recipientPlayerId === actorPlayerId;
    if (!isSender && !isRecipient) throw new Error("ESCROW_NOT_PARTICIPANT");
    if (escrow.status !== "pending" && escrow.status !== "accepted") {
      throw new Error("ESCROW_ALREADY_COMPLETED");
    }

    const otherRequested = isSender
      ? escrow.recipientCancelRequestedAt
      : escrow.senderCancelRequestedAt;
    if (!otherRequested) {
      const [updated] = await tx
        .update(casinoEscrowsTable)
        .set(
          isSender
            ? { senderCancelRequestedAt: new Date() }
            : { recipientCancelRequestedAt: new Date() },
        )
        .where(
          and(
            eq(casinoEscrowsTable.id, escrow.id),
            inArray(casinoEscrowsTable.status, ["pending", "accepted"]),
          ),
        )
        .returning();
      if (!updated) throw new Error("ESCROW_ALREADY_COMPLETED");
      if (!updated.senderCancelRequestedAt || !updated.recipientCancelRequestedAt) {
        return { escrow: updated, completed: false };
      }
      escrow = updated;
    }

    const [wallet] = await tx
      .select()
      .from(casinoWalletsTable)
      .where(
        and(
          eq(casinoWalletsTable.playerId, escrow.senderPlayerId),
          eq(casinoWalletsTable.currency, escrow.currency),
        ),
      )
      .limit(1);
    if (!wallet) throw new Error("ESCROW_REFUND_FAILED");
    const transactionId = randomUUID();
    const [cancelled] = await tx
      .update(casinoEscrowsTable)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(
        and(
          eq(casinoEscrowsTable.id, escrow.id),
          inArray(casinoEscrowsTable.status, ["pending", "accepted"]),
        ),
      )
      .returning();
    if (!cancelled) throw new Error("ESCROW_ALREADY_COMPLETED");
    const [sender] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${escrow.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, wallet.id))
      .returning();
    if (!sender) throw new Error("ESCROW_REFUND_FAILED");
    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId,
      entryType: "escrow_refund",
      amountMinor: escrow.amountMinor,
      description: `Escrow ${escrow.code} mutually cancelled; fee retained`,
    });
    return { escrow: cancelled, completed: true };
  });
}

async function unpinEscrow(bot: TelegramBot, escrow: typeof casinoEscrowsTable.$inferSelect): Promise<void> {
  if (!escrow.messageId) return;
  try {
    await bot.unpinChatMessage(escrow.chatId, escrow.messageId);
  } catch (error) {
    logger.warn({ err: error, escrowCode: escrow.code }, "Escrow unpin failed");
  }
}

type EscrowCardData = {
  code: string;
  buyer: string;
  seller: string;
  amount: string;
  fee: string;
  status: string;
  cancelStatus: string;
};

function escrowCardSvg(data: EscrowCardData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101a31"/><stop offset="1" stop-color="#182948"/></linearGradient><linearGradient id="gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e5ad43"/><stop offset="1" stop-color="#ffe6a1"/></linearGradient></defs>
  <rect width="1200" height="720" rx="42" fill="url(#bg)"/><circle cx="1060" cy="80" r="210" fill="#3b82f6" opacity=".12"/><circle cx="120" cy="680" r="230" fill="#f59e0b" opacity=".08"/>
  <rect x="42" y="42" width="1116" height="636" rx="32" fill="none" stroke="#fff" stroke-opacity=".14"/>
  <text x="86" y="112" fill="#f6c453" font-size="25" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO ESCROW</text>
  <text x="86" y="180" fill="#fff" font-size="42" font-family="DejaVu Sans" font-weight="bold">Secure transaction</text>
  <rect x="86" y="215" width="390" height="68" rx="34" fill="#f6c453" fill-opacity=".16" stroke="#f6c453" stroke-opacity=".75"/>
  <text x="281" y="259" text-anchor="middle" fill="#ffe6a1" font-size="28" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.code)}</text>
  <text x="86" y="346" fill="#8da2bd" font-size="20" font-family="DejaVu Sans">BUYER</text><text x="86" y="384" fill="#fff" font-size="27" font-family="DejaVu Sans">${escapeXml(data.buyer)}</text>
  <text x="650" y="346" fill="#8da2bd" font-size="20" font-family="DejaVu Sans">SELLER</text><text x="650" y="384" fill="#fff" font-size="27" font-family="DejaVu Sans">${escapeXml(data.seller)}</text>
  <line x1="86" y1="426" x2="1114" y2="426" stroke="#fff" stroke-opacity=".14"/>
  <text x="86" y="480" fill="#8da2bd" font-size="20" font-family="DejaVu Sans">AMOUNT HELD</text><text x="86" y="528" fill="url(#gold)" font-size="40" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.amount)}</text>
  <text x="650" y="480" fill="#8da2bd" font-size="20" font-family="DejaVu Sans">SERVICE FEE</text><text x="650" y="528" fill="#fff" font-size="32" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.fee)} · 0.2%</text>
  <text x="86" y="610" fill="#76e3a3" font-size="25" font-family="DejaVu Sans" font-weight="bold">STATUS: ${escapeXml(data.status)}</text>
  <text x="86" y="646" fill="#f6c453" font-size="18" font-family="DejaVu Sans">${escapeXml(data.cancelStatus)}</text>
  <text x="86" y="680" fill="#7185a3" font-size="17" font-family="DejaVu Sans">Sandbox only · Fee is charged when escrow is created.</text>
</svg>`;
}

async function escrowCardPng(data: EscrowCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render escrow image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(escrowCardSvg(data));
  });
}

async function sendEscrowCard(
  bot: TelegramBot,
  escrow: typeof casinoEscrowsTable.$inferSelect,
  buyer: typeof casinoPlayersTable.$inferSelect,
  seller: typeof casinoPlayersTable.$inferSelect,
  pin = true,
): Promise<void> {
  const currency = parseCurrency(escrow.currency, "USD");
  const cancelStatus =
    escrow.senderCancelRequestedAt && escrow.recipientCancelRequestedAt
      ? "MUTUAL CANCEL CONFIRMED"
      : escrow.senderCancelRequestedAt
        ? "CANCEL REQUESTED BY SELLER"
        : escrow.recipientCancelRequestedAt
          ? "CANCEL REQUESTED BY BUYER"
          : "LIVE DEAL";
  const image = await escrowCardPng({
    code: escrow.code,
    buyer: buyer.displayName,
    seller: seller.displayName,
    amount: formatMoney(escrow.amountMinor, currency),
    fee: formatMoney(escrow.feeMinor, currency),
    status: escrow.status.toUpperCase(),
    cancelStatus,
  });
  const caption = [
    `<b>🔐 ESCROW ${escrow.code}</b>`,
    `<b>Buyer:</b> ${escapeTelegramText(buyer.displayName)}`,
    `<b>Seller:</b> ${escapeTelegramText(seller.displayName)}`,
    `<b>Amount:</b> ${formatMoney(escrow.amountMinor, currency)}`,
    `<b>Fee:</b> ${formatMoney(escrow.feeMinor, currency)} (0.2%)`,
    `<b>Fair ID:</b> <code>${escrow.fairId ?? "legacy"}</code>`,
    "All actions and status updates stay in this single card.",
  ].join("\n");
  const inlineKeyboard: InlineKeyboardButton[][] =
    escrow.status === "pending"
      ? [[
          { text: "Accept deal", callback_data: `escrow:accept:${escrow.code}` },
          { text: "Reject deal", callback_data: `escrow:reject:${escrow.code}` },
        ]]
      : escrow.status === "accepted"
        ? [[
            { text: "Seller: release payment", callback_data: `escrow:release:${escrow.code}` },
            { text: "Mutual cancel", callback_data: `escrow:cancel:${escrow.code}` },
          ]]
        : [];
  if (escrow.messageId) {
    await bot.editPhoto(
      escrow.chatId,
      escrow.messageId,
      image,
      caption,
      { inline_keyboard: inlineKeyboard },
      { copyableCode: escrow.code },
    );
  } else {
    const sent = await bot.sendPhoto(
      escrow.chatId,
      image,
      caption,
      { inline_keyboard: inlineKeyboard },
      { copyableCode: escrow.code },
    );
    await db
      .update(casinoEscrowsTable)
      .set({ messageId: sent.message_id })
      .where(eq(casinoEscrowsTable.id, escrow.id));
  }
  if (pin) {
    try {
      if (!escrow.messageId) {
        const [stored] = await db
          .select({ messageId: casinoEscrowsTable.messageId })
          .from(casinoEscrowsTable)
          .where(eq(casinoEscrowsTable.id, escrow.id))
          .limit(1);
        if (stored?.messageId) await bot.pinChatMessage(escrow.chatId, stored.messageId);
      } else {
        await bot.pinChatMessage(escrow.chatId, escrow.messageId);
      }
    } catch (error) {
      logger.warn({ err: error, escrowCode: escrow.code }, "Escrow pin failed");
    }
  }
}

async function refreshEscrowCard(
  bot: TelegramBot,
  escrow: typeof casinoEscrowsTable.$inferSelect,
  pin = false,
): Promise<void> {
  const players = await db
    .select()
    .from(casinoPlayersTable)
    .where(inArray(casinoPlayersTable.id, [
      escrow.senderPlayerId,
      escrow.recipientPlayerId,
    ]));
  const buyer = players.find((player) => player.id === escrow.recipientPlayerId);
  const seller = players.find((player) => player.id === escrow.senderPlayerId);
  if (!buyer || !seller) throw new Error("ESCROW_PARTICIPANTS_NOT_FOUND");
  await sendEscrowCard(bot, escrow, buyer, seller, pin);
}

async function handleEscrowCallback(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
  action: string,
): Promise<void> {
  const [, verb, rawCode] = action.split(":");
  const code = rawCode?.toUpperCase();
  if (!code || !["accept", "reject", "release", "cancel"].includes(verb ?? "")) return;
  try {
    if (verb === "accept") {
      const escrow = await acceptEscrow(code, player.id);
      await refreshEscrowCard(bot, escrow);
      await auditTransaction(
        bot,
        [
          "Type: escrow accepted",
          `Code: ${escrow.code}`,
          `Fair ID: <code>${escrow.fairId ?? "legacy"}</code>`,
          `Buyer: ${escrow.recipientPlayerId}`,
          `Seller: ${escrow.senderPlayerId}`,
          `Amount: ${formatMoney(escrow.amountMinor, parseCurrency(escrow.currency, "USD"))}`,
        ].join("\n"),
      );
      return;
    }
    if (verb === "reject") {
      const escrow = await cancelEscrowImmediately(code, player.id);
      await refreshEscrowCard(bot, escrow, true);
      await auditTransaction(
        bot,
        [
          "Type: escrow rejected",
          `Code: ${escrow.code}`,
          `Fair ID: <code>${escrow.fairId ?? "legacy"}</code>`,
          `Amount refunded to seller: ${formatMoney(escrow.amountMinor, parseCurrency(escrow.currency, "USD"))}`,
        ].join("\n"),
      );
      return;
    }
    if (verb === "release") {
      const escrow = await releaseEscrow(code, player.id);
      await refreshEscrowCard(bot, escrow, true);
      await auditTransaction(
        bot,
        [
          "Type: escrow released",
          `Code: ${escrow.code}`,
          `Fair ID: <code>${escrow.fairId ?? "legacy"}</code>`,
          `Amount credited to accepting buyer: ${formatMoney(escrow.amountMinor, parseCurrency(escrow.currency, "USD"))}`,
        ].join("\n"),
      );
    } else {
      const [current] = await db
        .select()
        .from(casinoEscrowsTable)
        .where(eq(casinoEscrowsTable.code, code))
        .limit(1);
      if (current?.status === "pending") {
        const escrow = await cancelEscrowImmediately(code, player.id);
        await refreshEscrowCard(bot, escrow, true);
        await auditTransaction(
          bot,
          [
            "Type: escrow rejected",
            `Code: ${escrow.code}`,
            `Fair ID: <code>${escrow.fairId ?? "legacy"}</code>`,
            `Amount refunded to seller: ${formatMoney(escrow.amountMinor, parseCurrency(escrow.currency, "USD"))}`,
          ].join("\n"),
        );
      } else {
        const result = await requestEscrowCancellation(code, player.id);
        await refreshEscrowCard(bot, result.escrow, result.completed);
        if (result.completed) {
          await auditTransaction(
            bot,
            [
              "Type: escrow cancelled",
              `Code: ${result.escrow.code}`,
              `Fair ID: <code>${result.escrow.fairId ?? "legacy"}</code>`,
              `Amount refunded to seller: ${formatMoney(result.escrow.amountMinor, parseCurrency(result.escrow.currency, "USD"))}`,
            ].join("\n"),
          );
        }
      }
    }
  } catch (error) {
    logger.info({ err: error, chatId }, "Escrow callback rejected");
    await bot.sendMessage(chatId, `<b>${escapeTelegramText(escrowErrorText(error))}</b>`);
  }
}

async function handleEscrowCommand(
  bot: TelegramBot,
  chatId: number,
  message: TelegramMessage,
  player: typeof casinoPlayersTable.$inferSelect,
  args: string[],
): Promise<void> {
  const action = args[0]?.toLowerCase();
  if (action === "release" || action === "cancel") {
    const code = args[1]?.toUpperCase();
    if (!code) {
      await bot.sendMessage(chatId, `Usage: /escrow ${action} RX-XXXXXXXXXX`);
      return;
    }
    try {
      if (action === "release") {
        const escrow = await releaseEscrow(code, player.id);
        await refreshEscrowCard(bot, escrow, true);
        await auditTransaction(
          bot,
          [
            "Type: escrow released",
            `Code: ${escrow.code}`,
            `Fair ID: <code>${escrow.fairId ?? "legacy"}</code>`,
            `Amount credited to accepting buyer: ${formatMoney(escrow.amountMinor, parseCurrency(escrow.currency, "USD"))}`,
          ].join("\n"),
        );
      } else {
        const [current] = await db
          .select()
          .from(casinoEscrowsTable)
          .where(eq(casinoEscrowsTable.code, code))
          .limit(1);
        if (current?.status === "pending") {
          const escrow = await cancelEscrowImmediately(code, player.id);
          await refreshEscrowCard(bot, escrow, true);
          await auditTransaction(
            bot,
            [
              "Type: escrow rejected",
              `Code: ${escrow.code}`,
              `Fair ID: <code>${escrow.fairId ?? "legacy"}</code>`,
              `Amount refunded to seller: ${formatMoney(escrow.amountMinor, parseCurrency(escrow.currency, "USD"))}`,
            ].join("\n"),
          );
        } else {
          const result = await requestEscrowCancellation(code, player.id);
          await refreshEscrowCard(bot, result.escrow, result.completed);
          if (result.completed) {
            await auditTransaction(
              bot,
              [
                "Type: escrow cancelled",
                `Code: ${result.escrow.code}`,
                `Fair ID: <code>${result.escrow.fairId ?? "legacy"}</code>`,
                `Amount refunded to seller: ${formatMoney(result.escrow.amountMinor, parseCurrency(result.escrow.currency, "USD"))}`,
              ].join("\n"),
            );
          }
        }
      }
    } catch (error) {
      await bot.sendMessage(chatId, escrowErrorText(error));
    }
    return;
  }

  const replyTarget = message.reply_to_message?.from;
  const mentionTarget = args[0]?.startsWith("@") ? normalizeUsername(args[0]) : null;
  const amountArg = replyTarget ? args[0] : args[1];
  const currencyArg = replyTarget ? args[1] : args[2];
  const amountMinor = parseMoney(amountArg);
  if (!amountMinor || (!replyTarget && !mentionTarget)) {
    await bot.sendMessage(
      chatId,
      "Usage: /escrow @buyer AMOUNT INR|USD\nOr reply to a buyer: /escrow AMOUNT INR|USD",
    );
    return;
  }

  let buyer: typeof casinoPlayersTable.$inferSelect | undefined;
  if (replyTarget) {
    buyer = await ensurePlayer(replyTarget);
  } else if (mentionTarget) {
    [buyer] = await db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.username, mentionTarget))
      .limit(1);
  }
  if (!buyer) {
    await bot.sendMessage(chatId, "That buyer must open RolexCasino with /start before receiving an escrow.");
    return;
  }
  const currency = parseCurrency(currencyArg, parseCurrency(player.preferredCurrency, "USD"));
  try {
    const escrow = await createEscrow({
      sellerPlayerId: player.id,
      buyerPlayerId: buyer.id,
      amountMinor,
      currency,
      chatId,
    });
    await sendEscrowCard(bot, escrow, buyer, player);
    await auditTransaction(
      bot,
      [
        "Type: escrow created",
        `Code: ${escrow.code}`,
        `Fair ID: <code>${escrow.fairId ?? "legacy"}</code>`,
        `Seller: ${player.telegramUserId}`,
        `Buyer: ${buyer.telegramUserId}`,
        `Amount held: ${formatMoney(escrow.amountMinor, currency)}`,
        `Fee: ${formatMoney(escrow.feeMinor, currency)}`,
      ].join("\n"),
    );
  } catch (error) {
    await bot.sendMessage(chatId, escrowErrorText(error));
  }
}

async function claimPromo(
  playerId: number,
  code: string,
): Promise<{ amountMinor: number; currency: Currency }> {
  const [promo] = await db
    .select()
    .from(casinoPromoCodesTable)
    .where(eq(casinoPromoCodesTable.code, code.toUpperCase()))
    .limit(1);
  if (!promo || !promo.active || promo.claimedCount >= promo.maxClaims) {
    throw new Error("PROMO_INVALID");
  }
  const wallet = await ensureWallet(playerId, parseCurrency(promo.currency, "USD"));
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .insert(casinoPromoClaimsTable)
      .values({ promoCodeId: promo.id, playerId })
      .onConflictDoNothing()
      .returning();
    if (!claim) throw new Error("PROMO_ALREADY_CLAIMED");
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${promo.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, wallet.id))
      .returning();
    await tx
      .update(casinoPromoCodesTable)
      .set({ claimedCount: sql`${casinoPromoCodesTable.claimedCount} + 1` })
      .where(eq(casinoPromoCodesTable.id, promo.id));
    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId: randomUUID(),
      entryType: "promo_claim",
      amountMinor: promo.amountMinor,
      description: `Promotional code ${promo.code}`,
    });
    return {
      amountMinor: promo.amountMinor,
      currency: parseCurrency(promo.currency, "USD"),
    };
  });
}

const battleGameMap: Record<
  string,
  { gameType: string; emoji: string }
> = {
  dice: { gameType: "dice", emoji: "🎲" },
  darts: { gameType: "darts", emoji: "🎯" },
  bowling: { gameType: "bowling", emoji: "🎳" },
  basket: { gameType: "basketball", emoji: "🏀" },
  football: { gameType: "football", emoji: "⚽" },
  slots: { gameType: "slots", emoji: "🎰" },
};

function parseBattleArguments(args: string[], fallbackCurrency: Currency): {
  mode: "pvb" | "pvp";
  amountMinor: number | null;
  rounds: number;
  rollsPerRound: number;
  targetWins: number | null;
  currency: Currency;
  resultRule: "high" | "crazy";
} {
  const mode = args[0]?.toLowerCase() === "pvp" ? "pvp" : "pvb";
  const offset = args[0]?.toLowerCase() === "pvp" || args[0]?.toLowerCase() === "pvb" ? 1 : 0;
  const resultRule = args.some((arg) => arg.toLowerCase() === "crazy") ? "crazy" : "high";
  const battleArgs = args
    .slice(offset)
    .filter((arg) => arg.toLowerCase() !== "crazy");
  const amountMinor = parseMoney(battleArgs[0]);
  const pattern = battleArgs.find((arg) => /^(\d+)d(\d+)(w)?$/i.test(arg))?.match(/^(\d+)d(\d+)(w)?$/i);
  const targetWins = pattern?.[3]
    ? Math.min(3, Math.max(1, Math.trunc(Number(pattern[2]) || 1)))
    : null;
  const currencyToken = battleArgs.find((arg) => isSupportedCurrency(arg.toUpperCase()));
  const plainRoundToken = battleArgs.find(
    (arg, index) =>
      index > 0 &&
      /^\d+$/.test(arg) &&
      !pattern?.[0].includes(arg),
  );
  const rollsPerRound = Math.min(
    3,
    Math.max(
      1,
      Math.trunc(Number(pattern?.[1] ?? 1) || 1),
    ),
  );
  const rounds = Math.min(
    3,
    Math.max(
      1,
      Math.trunc(Number(pattern?.[2] ?? plainRoundToken ?? 1) || 1),
    ),
  );
  const currency = parseCurrency(currencyToken, fallbackCurrency);
  return { mode, amountMinor, rounds, rollsPerRound, targetWins, currency, resultRule };
}

const battleTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

function clearBattleTimeout(battleId: number): void {
  const timeout = battleTimeouts.get(battleId);
  if (timeout) clearTimeout(timeout);
  battleTimeouts.delete(battleId);
}

async function expirePvbBattle(
  resultBot: TelegramBot,
  battleId: number,
): Promise<void> {
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(eq(casinoChallengesTable.id, battleId))
    .limit(1);
  if (
    !battle ||
    battle.mode !== "pvb" ||
      !["pending_confirmation", "running", "rolling"].includes(battle.status)
  ) {
    clearBattleTimeout(battleId);
    return;
  }
  if (battle.turnDeadlineAt && !isBattleTurnExpired(battle.turnDeadlineAt)) {
    scheduleBattleTimeout(resultBot, battle.id, battle.turnDeadlineAt.getTime() - Date.now());
    return;
  }

  const [cancelledBattle] = await db
    .update(casinoChallengesTable)
    .set({
      status: "cancelled",
      turnDeadlineAt: null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "running"),
      ),
    )
    .returning();
  clearBattleTimeout(battleId);
  if (!cancelledBattle) return;

  const timeoutOutcome = battleTimeoutOutcome(battle.stakeMinor);
  await resultBot.sendMessage(
    battle.chatId,
    battle.status === "pending_confirmation"
      ? "⏰ PVB room expired because Play was not confirmed in time. No balance was changed."
      : [
          "⏰ Time expired.",
          "The player did not finish the required rolls within 60 seconds.",
          `The stake ${formatMoney(timeoutOutcome.refundMinor, parseCurrency(battle.currency, "USD"))} was refunded.`,
          "Challenge cancelled automatically.",
        ].join("\n"),
  );
}

async function expirePvpBattle(
  resultBot: TelegramBot,
  battleId: number,
): Promise<void> {
  const [cancelledBattle] = await db
    .update(casinoChallengesTable)
    .set({
      status: "cancelled",
      turnDeadlineAt: null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(casinoChallengesTable.id, battleId),
        eq(casinoChallengesTable.mode, "pvp"),
        inArray(casinoChallengesTable.status, [
          "coin_choice",
          "awaiting_player_one",
          "awaiting_player_two",
          "rolling",
        ]),
      ),
    )
    .returning();
  clearBattleTimeout(battleId);
  if (!cancelledBattle) return;
  await resultBot.sendMessage(
    cancelledBattle.chatId,
    "⏰ PVP room expired because the required emoji was not sent in time. No balance was changed.",
  );
}

function scheduleBattleTimeout(
  resultBot: TelegramBot,
  battleId: number,
  delayMs = BATTLE_TURN_TIMEOUT_MS,
): void {
  clearBattleTimeout(battleId);
  const delay = Math.max(1, Math.min(delayMs, BATTLE_TURN_TIMEOUT_MS));
  battleTimeouts.set(
    battleId,
    setTimeout(() => {
      void (async () => {
        const [battle] = await db
          .select()
          .from(casinoChallengesTable)
          .where(eq(casinoChallengesTable.id, battleId))
          .limit(1);
        if (battle?.mode === "pvp") {
          await expirePvpBattle(resultBot, battleId);
        } else {
          await expirePvbBattle(resultBot, battleId);
        }
      })().catch((error) => {
        logger.error({ err: error, battleId }, "PvB timeout handling failed");
      });
    }, delay),
  );
}

async function recoverPvbBattleTimeouts(resultBot: TelegramBot): Promise<void> {
  const battles = await db
    .select()
    .from(casinoChallengesTable)
    .where(
      inArray(casinoChallengesTable.status, [
        "pending_confirmation",
        "running",
          "rolling",
        "coin_choice",
        "awaiting_player_one",
        "awaiting_player_two",
      ]),
    );
  for (const battle of battles) {
    if (battle.mode !== "pvb" && battle.mode !== "pvp") continue;
    const deadline = battle.turnDeadlineAt ?? new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS);
    if (!battle.turnDeadlineAt) {
      await db
        .update(casinoChallengesTable)
        .set({ turnDeadlineAt: deadline })
        .where(eq(casinoChallengesTable.id, battle.id));
    }
    scheduleBattleTimeout(
      resultBot,
      battle.id,
      Math.max(1, deadline.getTime() - Date.now()),
    );
  }
}

async function settleBattle(input: {
  battleId: number;
  chatId: number;
  playerOneId: number;
  playerTwoId: number | null;
  mode: "pvb" | "pvp";
  gameType: string;
  currency: Currency;
  stakeMinor: number;
  playerOneScore: number;
  playerTwoScore: number;
  playerOneWon: boolean;
  fairId: string;
}): Promise<{
  playerOneBalance: number;
  playerTwoBalance: number | null;
  fairId: string;
}> {
  const playerOneWallet = await ensureWallet(input.playerOneId, input.currency);
  const playerTwoWallet = input.playerTwoId
    ? await ensureWallet(input.playerTwoId, input.currency)
    : null;
  const houseWallet = input.mode === "pvb"
    ? await ensureHouseWallet(input.currency)
    : null;
  const jackpot = await ensureJackpot(input.currency);
  const [playerOneJackpotParticipant] = await db
    .select()
    .from(casinoJackpotParticipantsTable)
    .where(
      and(
        eq(casinoJackpotParticipantsTable.jackpotId, jackpot.id),
        eq(casinoJackpotParticipantsTable.playerId, input.playerOneId),
      ),
    )
    .limit(1);
  const [playerTwoJackpotParticipant] = input.playerTwoId
    ? await db
        .select()
        .from(casinoJackpotParticipantsTable)
        .where(
          and(
            eq(casinoJackpotParticipantsTable.jackpotId, jackpot.id),
            eq(casinoJackpotParticipantsTable.playerId, input.playerTwoId),
          ),
        )
        .limit(1)
    : [];
  const playerOneJackpotMinor = jackpotContribution(
    input.stakeMinor,
    Boolean(playerOneJackpotParticipant),
  );
  const playerTwoJackpotMinor = input.playerTwoId
    ? jackpotContribution(input.stakeMinor, Boolean(playerTwoJackpotParticipant))
    : 0;
  const playerOneDebit = input.stakeMinor + playerOneJackpotMinor;
  const playerTwoDebit = input.stakeMinor + playerTwoJackpotMinor;
  const transactionId = randomUUID();

  return db.transaction(async (tx) => {
    const [playerOne] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} - ${playerOneDebit}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoWalletsTable.id, playerOneWallet.id),
          gte(casinoWalletsTable.balanceMinor, playerOneDebit),
        ),
      )
      .returning();
    if (!playerOne) throw new Error("INSUFFICIENT_BALANCE");

    let playerOneBalance = playerOne.balanceMinor;
    let playerTwoBalance: number | null = null;
    if (input.playerTwoId && playerTwoWallet) {
      const [playerTwo] = await tx
        .update(casinoWalletsTable)
        .set({
          balanceMinor: sql`${casinoWalletsTable.balanceMinor} - ${playerTwoDebit}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(casinoWalletsTable.id, playerTwoWallet.id),
            gte(casinoWalletsTable.balanceMinor, playerTwoDebit),
          ),
        )
        .returning();
      if (!playerTwo) throw new Error("OPPONENT_INSUFFICIENT_BALANCE");
      playerTwoBalance = playerTwo.balanceMinor;
    }

    const {
      tie,
      playerOnePayout,
      playerTwoPayout,
    } = calculateBattlePayouts({
      stakeMinor: input.stakeMinor,
      playerOneScore: input.playerOneScore,
      playerTwoScore: input.playerTwoScore,
      playerOneWon: input.playerOneWon,
      hasPlayerTwo: Boolean(input.playerTwoId),
    });

    if (playerOnePayout > 0) {
      const [updated] = await tx
        .update(casinoWalletsTable)
        .set({
          balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${playerOnePayout}`,
          updatedAt: new Date(),
        })
        .where(eq(casinoWalletsTable.id, playerOneWallet.id))
        .returning();
      playerOneBalance = updated.balanceMinor;
    }
    if (input.playerTwoId && playerTwoWallet && playerTwoPayout > 0) {
      const [updated] = await tx
        .update(casinoWalletsTable)
        .set({
          balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${playerTwoPayout}`,
          updatedAt: new Date(),
        })
        .where(eq(casinoWalletsTable.id, playerTwoWallet.id))
        .returning();
      playerTwoBalance = updated.balanceMinor;
    }
    const totalJackpotMinor = playerOneJackpotMinor + playerTwoJackpotMinor;
    if (totalJackpotMinor > 0) {
      await tx
        .update(casinoJackpotsTable)
        .set({
          poolMinor: sql`${casinoJackpotsTable.poolMinor} + ${totalJackpotMinor}`,
        })
        .where(eq(casinoJackpotsTable.id, jackpot.id));
      if (playerOneJackpotParticipant) {
        await tx
          .update(casinoJackpotParticipantsTable)
          .set({
            contributionMinor: sql`${casinoJackpotParticipantsTable.contributionMinor} + ${playerOneJackpotMinor}`,
          })
          .where(eq(casinoJackpotParticipantsTable.id, playerOneJackpotParticipant.id));
      }
      if (playerTwoJackpotParticipant) {
        await tx
          .update(casinoJackpotParticipantsTable)
          .set({
            contributionMinor: sql`${casinoJackpotParticipantsTable.contributionMinor} + ${playerTwoJackpotMinor}`,
          })
          .where(eq(casinoJackpotParticipantsTable.id, playerTwoJackpotParticipant.id));
      }
    }
    if (houseWallet && !tie) {
      const houseAmount = input.playerOneWon
        ? Math.floor(input.stakeMinor * 0.8)
        : input.stakeMinor;
      await tx
        .update(casinoHouseWalletsTable)
        .set({
          balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} + ${houseAmount}`,
          updatedAt: new Date(),
        })
        .where(eq(casinoHouseWalletsTable.id, houseWallet.id));
    }

    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: playerOneWallet.id,
      transactionId,
      entryType: "battle_stake",
      amountMinor: -input.stakeMinor,
      description: `${input.gameType} ${input.mode} battle stake; fair ${input.fairId}`,
    });
    if (playerOneJackpotMinor > 0) {
      await tx.insert(casinoLedgerEntriesTable).values({
        walletId: playerOneWallet.id,
        transactionId,
        entryType: "jackpot_contribution",
        amountMinor: -playerOneJackpotMinor,
        description: `${input.gameType} battle jackpot contribution`,
      });
    }
    if (playerOnePayout > 0) {
      await tx.insert(casinoLedgerEntriesTable).values({
        walletId: playerOneWallet.id,
        transactionId,
        entryType: tie ? "battle_refund" : "battle_payout",
        amountMinor: playerOnePayout,
        description: `${input.gameType} battle ${tie ? "refund" : "payout"} at 1.92x; fair ${input.fairId}`,
      });
    }
    if (input.playerTwoId && playerTwoWallet) {
      await tx.insert(casinoLedgerEntriesTable).values({
        walletId: playerTwoWallet.id,
        transactionId,
        entryType: "battle_stake",
        amountMinor: -input.stakeMinor,
        description: `${input.gameType} ${input.mode} battle stake; fair ${input.fairId}`,
      });
      if (playerTwoJackpotMinor > 0) {
        await tx.insert(casinoLedgerEntriesTable).values({
          walletId: playerTwoWallet.id,
          transactionId,
          entryType: "jackpot_contribution",
          amountMinor: -playerTwoJackpotMinor,
          description: `${input.gameType} battle jackpot contribution`,
        });
      }
      if (playerTwoPayout > 0) {
        await tx.insert(casinoLedgerEntriesTable).values({
          walletId: playerTwoWallet.id,
          transactionId,
          entryType: tie ? "battle_refund" : "battle_payout",
          amountMinor: playerTwoPayout,
          description: `${input.gameType} battle ${tie ? "refund" : "payout"} at 1.92x; fair ${input.fairId}`,
        });
      }
    }

    await tx
      .update(casinoChallengesTable)
      .set({
        playerOneScore: input.playerOneScore,
        playerTwoScore: input.playerTwoScore,
        winnerPlayerId: tie ? null : input.playerOneWon ? input.playerOneId : input.playerTwoId,
        status: "completed",
        completedAt: new Date(),
      })
      .where(eq(casinoChallengesTable.id, input.battleId));

    return {
      playerOneBalance: playerOne.balanceMinor + playerOnePayout,
      playerTwoBalance,
      fairId: input.fairId,
    };
  });
}

type BattleRoundScore = {
  playerOneScore: number;
  playerTwoScore: number;
};

function casinoPlayerLabel(
  player: typeof casinoPlayersTable.$inferSelect | undefined,
  fallback: string,
): string {
  return player?.username
    ? `@${escapeTelegramText(player.username)}`
    : escapeTelegramText(player?.displayName || fallback);
}

function battleResultText(options: {
  battleId: number;
  gameType: string;
  mode: "pvb" | "pvp";
  playerOneLabel: string;
  playerTwoLabel: string;
  rounds: BattleRoundScore[];
  playerOneWon: boolean;
  crazyMode: boolean;
  tie: boolean;
  payoutMinor: number;
  currency: Currency;
  fairId: string;
}): string {
  const roundLines = options.rounds.flatMap((round, index) => {
    const playerOneRoundWon = options.crazyMode
      ? round.playerOneScore < round.playerTwoScore
      : round.playerOneScore > round.playerTwoScore;
    const roundTie = round.playerOneScore === round.playerTwoScore;
    const winner = roundTie
      ? "Draw"
      : playerOneRoundWon
        ? options.playerOneLabel
        : options.playerTwoLabel;
    return [
      `🏆 Round ${index + 1}: ${winner} ${roundTie ? "🤝" : "✅"} (${round.playerOneScore}-${round.playerTwoScore})`,
    ];
  });

  const playerOneRoundWins = options.rounds.filter((round) =>
    options.crazyMode
      ? round.playerOneScore < round.playerTwoScore
      : round.playerOneScore > round.playerTwoScore,
  ).length;
  const playerTwoRoundWins = options.rounds.filter((round) =>
    options.crazyMode
      ? round.playerTwoScore < round.playerOneScore
      : round.playerTwoScore > round.playerOneScore,
  ).length;
  const winnerLabel = options.playerOneWon
    ? options.playerOneLabel
    : options.playerTwoLabel;
  const matchPrefix = options.gameType.slice(0, 3).toUpperCase();
  const payoutLabel = options.tie
    ? "Stake refunded: 1.00x"
    : options.playerOneWon
      ? `Payout: ${formatMoney(options.payoutMinor, options.currency)} (1.92x)`
      : options.mode === "pvb"
        ? `Payout: ${formatMoney(0, options.currency)} — the house bot won this match.`
        : `Payout: ${formatMoney(options.payoutMinor, options.currency)} (1.92x)`;
  return [
    `<b>🎮 ${options.gameType.toUpperCase()} ${options.mode.toUpperCase()} RESULT</b>`,
    `Match ID: <code>${matchPrefix}-${String(options.battleId).padStart(6, "0")}</code>`,
    `Fair ID: <code>${options.fairId}</code>`,
    `Challenger: ${options.playerOneLabel}`,
    `Opponent: ${options.playerTwoLabel}`,
    "",
    ...roundLines,
    "",
    options.tie
      ? `<b>🤝 Match tied (${playerOneRoundWins}-${playerTwoRoundWins})</b>`
      : `<b>🏆 ${winnerLabel} wins ${playerOneRoundWins}-${playerTwoRoundWins}!</b>`,
    payoutLabel,
    options.tie
      ? "No balance was lost; the stake was returned."
      : options.playerOneWon
        ? "The winning wallet has been credited."
        : options.mode === "pvb"
          ? "Your stake was settled to the house account."
          : "The opponent's winning wallet has been credited.",
  ].join("\n");
}

function pvbRematchKeyboard(
  battle: typeof casinoChallengesTable.$inferSelect,
  creator: typeof casinoPlayersTable.$inferSelect,
): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [[
      {
        text: "🔁 Bet Again",
        callback_data: ownedCallback(
          `battle:rematch:${battle.id}:again`,
          creator.telegramUserId,
        ),
      },
      {
        text: "⚡ Bet Double",
        callback_data: ownedCallback(
          `battle:rematch:${battle.id}:double`,
          creator.telegramUserId,
        ),
      },
    ]],
  };
}

async function runPvpBattle(
  rollBot: TelegramBot,
  resultBot: TelegramBot,
  battle: typeof casinoChallengesTable.$inferSelect,
): Promise<void> {
  const roundScores: BattleRoundScore[] = [];
  let resolution = resolveBattleRounds(roundScores, {
    fixedRounds: battle.rounds,
    targetWins: battle.targetWins,
    resultRule: battle.resultRule === "crazy" ? "crazy" : "high",
  });
  for (let round = 1; !resolution.complete; round += 1) {
    let playerOneRound = 0;
    let playerTwoRound = 0;
    for (let roll = 1; roll <= battle.rollsPerRound; roll += 1) {
      let playerRoll: TelegramMessage;
      let botRoll: TelegramMessage;
      try {
        playerRoll = await rollBot.sendDice(battle.chatId, battle.emoji);
        botRoll = await rollBot.sendDice(battle.chatId, battle.emoji);
      } catch (error) {
        logger.warn(
          { err: error, helper: rollBot.label, battleId: battle.id },
          "Helper could not roll in the battle chat; using main bot fallback",
        );
        playerRoll = await resultBot.sendDice(battle.chatId, battle.emoji);
        botRoll = await resultBot.sendDice(battle.chatId, battle.emoji);
      }
      playerOneRound += playerRoll.dice?.value ?? 0;
      playerTwoRound += botRoll.dice?.value ?? 0;
    }
    roundScores.push({
      playerOneScore: playerOneRound,
      playerTwoScore: playerTwoRound,
    });
    resolution = resolveBattleRounds(roundScores, {
      fixedRounds: battle.rounds,
      targetWins: battle.targetWins,
      resultRule: battle.resultRule === "crazy" ? "crazy" : "high",
    });
  }

  const crazyMode = battle.resultRule === "crazy";
  const finalPlayerOneScore = resolution.playerOneScore;
  const finalPlayerTwoScore = resolution.playerTwoScore;
  const playerOneWon = resolution.playerOneWon;
  const tie = resolution.tie;
  await settleBattle({
    battleId: battle.id,
    chatId: battle.chatId,
    playerOneId: battle.creatorPlayerId,
    playerTwoId: battle.playerTwoId,
    mode: battle.mode === "pvp" ? "pvp" : "pvb",
    gameType: battle.gameType,
    currency: parseCurrency(battle.currency, "USD"),
    stakeMinor: battle.stakeMinor,
    playerOneScore: finalPlayerOneScore,
    playerTwoScore: finalPlayerTwoScore,
    playerOneWon,
    fairId: battle.fairId ?? createFairId(),
  });
  if (!tie) {
    const winnerPlayerId = playerOneWon ? battle.creatorPlayerId : battle.playerTwoId;
    if (winnerPlayerId) {
      await broadcastPlayerWin(
        resultBot,
        winnerPlayerId,
        battle.gameType,
        Math.round(battle.stakeMinor * 1.92),
        parseCurrency(battle.currency, "USD"),
      );
    }
  }
  const [playerOne, playerTwo] = await Promise.all([
    db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
      .limit(1)
      .then(([player]) => player),
    battle.playerTwoId
      ? db
          .select()
          .from(casinoPlayersTable)
          .where(eq(casinoPlayersTable.id, battle.playerTwoId))
          .limit(1)
          .then(([player]) => player)
      : Promise.resolve(undefined),
  ]);
  const playerOneLabel = casinoPlayerLabel(playerOne, "Player 1");
  const playerTwoLabel = casinoPlayerLabel(playerTwo, "Player 2");
  await resultBot.sendMessage(
    battle.chatId,
    battleResultText({
      battleId: battle.id,
      gameType: battle.gameType,
      mode: battle.mode === "pvp" ? "pvp" : "pvb",
      playerOneLabel,
      playerTwoLabel,
      rounds: roundScores,
      playerOneWon,
      crazyMode,
      tie,
      payoutMinor: tie ? 0 : Math.round(battle.stakeMinor * 1.92),
      currency: parseCurrency(battle.currency, "USD"),
      fairId: battle.fairId ?? "legacy",
    }),
  );
  await auditTransaction(
    resultBot,
    [
      "Type: battle settlement",
      `Battle: #${battle.id}`,
      `Mode: ${battle.mode.toUpperCase()}`,
      `Game: ${battle.gameType}`,
      `Stake: ${formatMoney(battle.stakeMinor, parseCurrency(battle.currency, "USD"))}`,
      `Fair ID: <code>${battle.fairId ?? "legacy"}</code>`,
      tie ? "Outcome: tie; stake refunded" : `Outcome: ${playerOneWon ? "player one won" : "player two/house won"}`,
    ].join("\n"),
  );
}

async function createBattle(
  resultBot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  game: { gameType: string; emoji: string },
  input: ReturnType<typeof parseBattleArguments>,
  invitedPlayer?: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  if (!input.amountMinor) {
    await resultBot.sendMessage(
      chatId,
      "Usage: /dice [pvb|pvp] AMOUNT ROLLSxROUNDS[w] INR|USD\nExample: /dice pvb 100 3d3w INR means 3 rolls per round and first to 3 round wins.",
    );
    return;
  }
  if (!(await betInRange(input.amountMinor, input.currency, game.gameType))) {
    await resultBot.sendMessage(
      chatId,
      await configuredBetLimitText(input.currency, game.gameType),
    );
    return;
  }
  const player = await ensurePlayer(user);
  if (invitedPlayer?.id === player.id) {
    await resultBot.sendMessage(chatId, "You cannot challenge yourself.");
    return;
  }
  const wallet = await ensureWallet(player.id, input.currency);
  if (wallet.balanceMinor < input.amountMinor) {
    await resultBot.sendMessage(chatId, `Insufficient balance. Your ${input.currency} balance is ${formatMoney(wallet.balanceMinor, input.currency)}.`);
    return;
  }
  const [battle] = await db
    .insert(casinoChallengesTable)
    .values({
      creatorPlayerId: player.id,
      mode: input.mode,
      playerTwoId: input.mode === "pvp" ? invitedPlayer?.id ?? null : null,
      chatId,
      gameType: game.gameType,
      emoji: game.emoji,
      currency: input.currency,
      stakeMinor: input.amountMinor,
      rounds: input.rounds,
      rollsPerRound: input.rollsPerRound,
      targetWins: input.targetWins,
      resultRule: input.resultRule,
      fairId: createFairId(),
      status: input.mode === "pvp" ? "open" : "running",
    })
    .returning();
  if (!battle) throw new Error("Could not create battle");

  if (input.mode === "pvp") {
    await resultBot.sendMessage(
      chatId,
      [
        `PVP ${game.gameType} battle #${battle.id} created.`,
        `Stake: ${formatMoney(input.amountMinor, input.currency)}`,
        input.targetWins
          ? `First to ${input.targetWins} round wins · ${input.rollsPerRound} rolls per round`
          : `${input.rounds} rounds · ${input.rollsPerRound} rolls per round`,
        input.resultRule === "crazy"
          ? "Crazy mode: the lowest total wins."
          : "Normal mode: the highest total wins.",
        invitedPlayer
          ? `Challenge for ${escapeTelegramText(invitedPlayer.displayName)}.`
          : "Another player can accept below. Both players must have enough balance when the battle starts.",
      ].join("\n"),
      {
        inline_keyboard: [[
          { text: "Accept battle", callback_data: `battle:join:${battle.id}` },
          { text: "Decline", callback_data: `battle:decline:${battle.id}` },
        ]],
      },
    );
    return;
  }

  await resultBot.sendMessage(
    chatId,
    [
      `<b>🤖 ${game.gameType.toUpperCase()} — PLAYER VS BOT</b>`,
      "",
      `Stake: ${formatMoney(input.amountMinor, input.currency)}`,
      input.targetWins
        ? `First to ${input.targetWins} round wins · ${input.rollsPerRound} roll${input.rollsPerRound === 1 ? "" : "s"} per round`
        : `${input.rounds} round${input.rounds === 1 ? "" : "s"} · ${input.rollsPerRound} roll${input.rollsPerRound === 1 ? "" : "s"} per round`,
      input.resultRule === "crazy"
        ? "Crazy mode: the lowest score wins each round."
        : "Highest score wins each round.",
      "",
      "Press Play to confirm, or Cancel to close this room.",
    ].join("\n"),
    {
      inline_keyboard: [[
        {
          text: "🤖 Play with Bot",
          callback_data: ownedCallback(`battle:pvb:play:${battle.id}`, player.telegramUserId),
        },
        {
          text: "Cancel",
          callback_data: ownedCallback(`battle:pvb:cancel:${battle.id}`, player.telegramUserId),
        },
      ]],
    },
  );
  scheduleBattleTimeout(resultBot, battle.id);
}

async function createPvbRematch(
  resultBot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  battleId: number,
  multiplier: "again" | "double",
): Promise<void> {
  const [previousBattle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(
      and(
        eq(casinoChallengesTable.id, battleId),
        eq(casinoChallengesTable.mode, "pvb"),
        eq(casinoChallengesTable.status, "completed"),
      ),
    )
    .limit(1);
  if (!previousBattle) {
    await resultBot.sendMessage(chatId, "That PVB result is no longer available for a rematch.");
    return;
  }

  const [creator] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, previousBattle.creatorPlayerId))
    .limit(1);
  if (!creator || creator.telegramUserId !== user.id) {
    await resultBot.sendMessage(chatId, "Only the player who started that PVB match can use its rematch buttons.");
    return;
  }

  const [activeBattle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(
      and(
        eq(casinoChallengesTable.creatorPlayerId, creator.id),
        eq(casinoChallengesTable.mode, "pvb"),
        inArray(casinoChallengesTable.status, [
          "pending_confirmation",
          "running",
          "rolling",
        ]),
      ),
    )
    .limit(1);
  if (activeBattle) {
    await resultBot.sendMessage(
      chatId,
      `You already have an active PVB room (#${activeBattle.id}). Finish or cancel it before starting another.`,
    );
    return;
  }

  const amountMinor =
    multiplier === "double"
      ? previousBattle.stakeMinor * 2
      : previousBattle.stakeMinor;
  if (!Number.isSafeInteger(amountMinor)) {
    await resultBot.sendMessage(chatId, "That rematch amount is too large.");
    return;
  }
  await createBattle(
    resultBot,
    chatId,
    user,
    { gameType: previousBattle.gameType, emoji: previousBattle.emoji },
    {
      mode: "pvb",
      amountMinor,
      rounds: previousBattle.rounds,
      rollsPerRound: previousBattle.rollsPerRound,
      targetWins: previousBattle.targetWins,
      currency: parseCurrency(previousBattle.currency, "USD"),
      resultRule: previousBattle.resultRule === "crazy" ? "crazy" : "high",
    },
  );
}

async function joinBattle(
  resultBot: TelegramBot,
  helperBots: Map<string, TelegramBot>,
  chatId: number,
  user: TelegramUser,
  battleId: number,
): Promise<void> {
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(eq(casinoChallengesTable.id, battleId))
    .limit(1);
  if (!battle || battle.mode !== "pvp" || battle.status !== "open") {
    await resultBot.sendMessage(chatId, "That PVP battle is no longer open.");
    return;
  }
  if (battle.creatorPlayerId === user.id) {
    await resultBot.sendMessage(chatId, "The battle creator cannot join as their own opponent.");
    return;
  }
  if (battle.playerTwoId !== null && battle.playerTwoId !== user.id) {
    await resultBot.sendMessage(
      chatId,
      "This PVP challenge was sent to another player.",
    );
    return;
  }
  const player = await ensurePlayer(user);
  const wallet = await ensureWallet(player.id, parseCurrency(battle.currency, "USD"));
  if (wallet.balanceMinor < battle.stakeMinor) {
    await resultBot.sendMessage(chatId, "You do not have enough balance to join this battle.");
    return;
  }
  const [claimedBattle] = await db
    .update(casinoChallengesTable)
    .set({ playerTwoId: player.id, status: "running" })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "open"),
      ),
    )
    .returning();
  if (!claimedBattle) {
    await resultBot.sendMessage(chatId, "Another player joined this battle first.");
    return;
  }
  await resultBot.sendMessage(
    chatId,
    `PVP battle #${battle.id} is starting. ${
      battle.targetWins
        ? `First to ${battle.targetWins} round wins`
        : `${battle.rounds} rounds`
    } × ${battle.rollsPerRound} rolls.`,
  );
  const [startedBattle] = await db
    .update(casinoChallengesTable)
    .set({
      status: "awaiting_player_one",
      turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
    })
    .where(eq(casinoChallengesTable.id, claimedBattle.id))
    .returning();
  if (startedBattle) {
    if (startedBattle.gameType === "coin") {
      await resultBot.sendMessage(
        chatId,
        [
          `<b>🪙 Coin Flip Room #${String(startedBattle.id).padStart(4, "0")}</b>`,
          `Stake: ${formatMoney(startedBattle.stakeMinor, parseCurrency(startedBattle.currency, "USD"))}`,
          "Accepter, choose Heads or Tails. The challenger receives the other side automatically.",
        ].join("\n"),
        {
          inline_keyboard: [[
            { text: "Heads", callback_data: `coin:choose:${startedBattle.id}:HEADS` },
            { text: "Tails", callback_data: `coin:choose:${startedBattle.id}:TAILS` },
          ]],
        },
      );
      scheduleBattleTimeout(resultBot, startedBattle.id);
      return;
    }
    await promptPvpTurn(resultBot, startedBattle);
    scheduleBattleTimeout(resultBot, startedBattle.id);
  }
}

async function declineBattle(
  resultBot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  battleId: number,
): Promise<void> {
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(eq(casinoChallengesTable.id, battleId))
    .limit(1);
  if (!battle || battle.mode !== "pvp" || battle.status !== "open") {
    await resultBot.sendMessage(chatId, "That PVP battle is no longer open.");
    return;
  }
  if (battle.playerTwoId !== null && battle.playerTwoId !== user.id) {
    await resultBot.sendMessage(chatId, "This PVP challenge was sent to another player.");
    return;
  }
  if (battle.playerTwoId === null) {
    if (battle.creatorPlayerId !== user.id) {
      await resultBot.sendMessage(chatId, "Only the challenge maker can cancel this open PVP room.");
      return;
    }
  }
  const [cancelled] = await db
    .update(casinoChallengesTable)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "open"),
        or(
          eq(casinoChallengesTable.creatorPlayerId, user.id),
          eq(casinoChallengesTable.playerTwoId, user.id),
        ),
      ),
    )
    .returning();
  await resultBot.sendMessage(
    chatId,
    cancelled
      ? "PVP challenge declined. No balance was changed."
      : "That PVP challenge was already accepted or cancelled.",
  );
}

async function confirmPvbBattle(
  resultBot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  battleId: number,
): Promise<void> {
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(eq(casinoChallengesTable.id, battleId))
    .limit(1);
  if (
    !battle ||
    battle.mode !== "pvb" ||
    battle.status !== "pending_confirmation"
  ) {
    await resultBot.sendMessage(chatId, "That PVB room is no longer waiting for confirmation.");
    return;
  }
  const [creator] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
    .limit(1);
  if (!creator || creator.telegramUserId !== user.id) {
    await resultBot.sendMessage(chatId, "Only the player who created this PVB room can confirm it.");
    return;
  }
  const wallet = await ensureWallet(creator.id, parseCurrency(battle.currency, "USD"));
  if (wallet.balanceMinor < battle.stakeMinor) {
    await resultBot.sendMessage(chatId, "Your balance is no longer sufficient for this battle.");
    return;
  }
  const deadline = new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS);
  const [startedBattle] = await db
    .update(casinoChallengesTable)
    .set({ status: "running", turnDeadlineAt: deadline })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "pending_confirmation"),
      ),
    )
    .returning();
  if (!startedBattle) {
    await resultBot.sendMessage(chatId, "That PVB room was already started or cancelled.");
    return;
  }
  await resultBot.sendMessage(
    chatId,
    `✅ PVB room #${battle.id} confirmed. Send ${battle.emoji} directly to play round 1.`,
  );
  await promptPvbRound(resultBot, startedBattle);
}

async function cancelPvbBattle(
  resultBot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  battleId: number,
): Promise<void> {
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(eq(casinoChallengesTable.id, battleId))
    .limit(1);
  if (
    !battle ||
    battle.mode !== "pvb" ||
    battle.status !== "pending_confirmation"
  ) {
    await resultBot.sendMessage(chatId, "That PVB room is no longer waiting for confirmation.");
    return;
  }
  const [creator] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
    .limit(1);
  if (!creator || creator.telegramUserId !== user.id) {
    await resultBot.sendMessage(chatId, "Only the player who created this PVB room can cancel it.");
    return;
  }
  const [cancelled] = await db
    .update(casinoChallengesTable)
    .set({ status: "cancelled", turnDeadlineAt: null, completedAt: new Date() })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "pending_confirmation"),
      ),
    )
    .returning();
  clearBattleTimeout(battle.id);
  await resultBot.sendMessage(
    chatId,
    cancelled ? "PVB room cancelled. No balance was changed." : "That PVB room was already closed.",
  );
}

async function handleCoinChoice(
  resultBot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  battleId: number,
  pickedSide: "HEADS" | "TAILS",
): Promise<void> {
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(eq(casinoChallengesTable.id, battleId))
    .limit(1);
  if (
    !battle ||
    battle.gameType !== "coin" ||
    battle.mode !== "pvp" ||
    battle.status !== "coin_choice"
  ) {
    await resultBot.sendMessage(chatId, "That coin room is no longer waiting for a choice.");
    return;
  }
  if (battle.playerTwoId !== user.id) {
    await resultBot.sendMessage(chatId, "Only the accepted opponent can choose the coin side.");
    return;
  }
  const [claimedBattle] = await db
    .update(casinoChallengesTable)
    .set({ status: "coin_flipping", turnDeadlineAt: null })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "coin_choice"),
        eq(casinoChallengesTable.playerTwoId, user.id),
      ),
    )
    .returning();
  if (!claimedBattle) {
    await resultBot.sendMessage(chatId, "Another choice was already submitted.");
    return;
  }
  const challengerSide = pickedSide === "HEADS" ? "TAILS" : "HEADS";
  await resultBot.sendMessage(
    chatId,
    `🪙 ${casinoPlayerLabel(await db.select().from(casinoPlayersTable).where(eq(casinoPlayersTable.id, battle.playerTwoId)).limit(1).then(([row]) => row), "Opponent")} picked ${pickedSide}.`,
  );
  await resultBot.sendMessage(chatId, "🪙 Coin in the air... 1... 2... 3...");
  await wait(3_000);
  const landedSide = randomInt(0, 2) === 0 ? "HEADS" : "TAILS";
  const playerOneWon = challengerSide === landedSide;
  const settled = await settleBattle({
    battleId: battle.id,
    chatId: battle.chatId,
    playerOneId: battle.creatorPlayerId,
    playerTwoId: battle.playerTwoId,
    mode: "pvp",
    gameType: "coin",
    currency: parseCurrency(battle.currency, "USD"),
    stakeMinor: battle.stakeMinor,
    playerOneScore: playerOneWon ? 1 : 0,
    playerTwoScore: playerOneWon ? 0 : 1,
    playerOneWon,
    fairId: battle.fairId ?? createFairId(),
  });
  const [challenger, opponent] = await Promise.all([
    db.select().from(casinoPlayersTable).where(eq(casinoPlayersTable.id, battle.creatorPlayerId)).limit(1).then(([row]) => row),
    db.select().from(casinoPlayersTable).where(eq(casinoPlayersTable.id, battle.playerTwoId)).limit(1).then(([row]) => row),
  ]);
  const winner = playerOneWon ? challenger : opponent;
  await resultBot.sendMessage(
    chatId,
    [
      `🪙 <b>Coin Flip #${String(battle.id).padStart(4, "0")} — Result</b>`,
      "",
      `Coin landed on: <b>${landedSide}</b>`,
      `${casinoPlayerLabel(opponent, "Opponent")}: ${pickedSide}`,
      `${casinoPlayerLabel(challenger, "Challenger")}: ${challengerSide}`,
      "",
      `🏆 Winner: ${casinoPlayerLabel(winner, "Player")}`,
      `🏦 Prize: ${formatMoney(Math.round(battle.stakeMinor * 1.92), parseCurrency(battle.currency, "USD"))} credited`,
      `Fair ID: <code>${settled.fairId}</code>`,
    ].join("\n"),
  );
}

async function promptPvpTurn(
  resultBot: TelegramBot,
  battle: typeof casinoChallengesTable.$inferSelect,
): Promise<void> {
  if (
    battle.status !== "awaiting_player_one" &&
    battle.status !== "awaiting_player_two"
  ) {
    return;
  }
  const expectedPlayerId =
    battle.status === "awaiting_player_two"
      ? battle.playerTwoId
      : battle.creatorPlayerId;
  if (!expectedPlayerId) return;
  const [expectedPlayer] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, expectedPlayerId))
    .limit(1);
  const rows = await db
    .select()
    .from(casinoChallengeRollsTable)
    .where(
      and(
        eq(casinoChallengeRollsTable.challengeId, battle.id),
        eq(casinoChallengeRollsTable.playerId, expectedPlayerId),
      ),
    );
  const latestRound = rows.reduce((latest, row) => Math.max(latest, row.round), 0);
  const latestRoundCount = rows.filter((row) => row.round === latestRound).length;
  const round =
    battle.status === "awaiting_player_one" &&
    latestRound > 0 &&
    latestRoundCount >= battle.rollsPerRound
      ? latestRound + 1
      : latestRound || 1;
  const rollIndex =
    rows.filter((row) => row.round === round).length + 1;
  const remaining = Math.max(1, battle.rollsPerRound - rollIndex + 1);
  const label = casinoPlayerLabel(expectedPlayer, "Player");
  await resultBot.sendMessage(
    battle.chatId,
    [
      `<b>Room #${String(battle.id).padStart(4, "0")} — PVP</b>`,
      `${label}, you throw first in this turn.`,
      `Round ${round}/${battle.targetWins ? `${battle.targetWins} wins` : battle.rounds} · Throw ${remaining} more`,
      `Required emoji: <b>${battle.emoji}</b>`,
      "Send the emoji directly from Telegram. Forwarded, stale, wrong-game, and duplicate rolls are rejected.",
    ].join("\n"),
  );
}

function pvpRoundScores(
  rows: Array<typeof casinoChallengeRollsTable.$inferSelect>,
  rounds: number,
  playerOneId: number,
  playerTwoId: number,
): BattleRoundScore[] {
  return Array.from({ length: rounds }, (_, index) => {
    const round = index + 1;
    const playerOneScore = rows
      .filter(
        (row) =>
          row.actorType === "player" &&
          row.playerId === playerOneId &&
          row.round === round,
      )
      .reduce((total, row) => total + row.value, 0);
    const playerTwoScore = rows
      .filter(
        (row) =>
          row.actorType === "player" &&
          row.playerId === playerTwoId &&
          row.round === round,
      )
      .reduce((total, row) => total + row.value, 0);
    return { playerOneScore, playerTwoScore };
  });
}

async function handlePlayerPvpRoll(
  resultBot: TelegramBot,
  message: TelegramMessage,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<boolean> {
  if (!message.dice || !isGroupChat(message.chat)) return false;
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(
      and(
        eq(casinoChallengesTable.chatId, message.chat.id),
        eq(casinoChallengesTable.mode, "pvp"),
        inArray(casinoChallengesTable.status, [
          "awaiting_player_one",
          "awaiting_player_two",
          "rolling",
        ]),
        or(
          eq(casinoChallengesTable.creatorPlayerId, player.id),
          eq(casinoChallengesTable.playerTwoId, player.id),
        ),
      ),
    )
    .limit(1);
  if (!battle) return false;
  if (battle.status === "rolling") {
    await resultBot.sendMessage(
      message.chat.id,
      "⏳ Your previous PVP roll is still being processed. Please wait for the round result.",
    );
    return true;
  }
  if (battle.turnDeadlineAt && battle.turnDeadlineAt.getTime() <= Date.now()) {
    await expirePvpBattle(resultBot, battle.id);
    return true;
  }
  const expectedPlayerId =
    battle.status === "awaiting_player_two"
      ? battle.playerTwoId
      : battle.creatorPlayerId;
  if (expectedPlayerId !== player.id) {
    await resultBot.sendMessage(message.chat.id, "It is not your turn in this PVP room.");
    return true;
  }
  if (!isFreshDirectDiceMessage(message, battle.emoji)) {
    await resultBot.sendMessage(
      message.chat.id,
      `❌ Invalid emoji message. Send the required ${battle.emoji} directly, not as a forward or another game emoji.`,
    );
    return true;
  }
  const existingRows = await db
    .select()
    .from(casinoChallengeRollsTable)
    .where(
      and(
        eq(casinoChallengeRollsTable.challengeId, battle.id),
        eq(casinoChallengeRollsTable.actorType, "player"),
      ),
    );
  if (existingRows.some((row) => row.messageId === message.message_id)) {
    await resultBot.sendMessage(message.chat.id, "That emoji message was already counted.");
    return true;
  }
  const claimedBattle = await db
    .update(casinoChallengesTable)
    .set({ status: "rolling", turnDeadlineAt: null })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, battle.status),
      ),
    )
    .returning();
  if (!claimedBattle[0]) {
    await resultBot.sendMessage(
      message.chat.id,
      "⏳ That PVP turn is already being processed. Please wait for the result.",
    );
    return true;
  }
  const latestRound = existingRows.reduce(
    (latest, row) => Math.max(latest, row.round),
    0,
  );
  const currentPlayerRoundCount = existingRows.filter(
    (row) => row.playerId === expectedPlayerId && row.round === latestRound,
  ).length;
  const round =
    battle.status === "awaiting_player_one" &&
    latestRound > 0 &&
    currentPlayerRoundCount >= battle.rollsPerRound
      ? latestRound + 1
      : latestRound || 1;
  const rollIndex =
    existingRows.filter(
      (row) => row.playerId === expectedPlayerId && row.round === round,
    ).length + 1;
  const [storedRoll] = await db
    .insert(casinoChallengeRollsTable)
    .values({
      challengeId: battle.id,
      actorType: "player",
      actorKey: String(player.id),
      playerId: player.id,
      round,
      rollIndex,
      emoji: message.dice.emoji,
      value: message.dice.value,
      messageId: message.message_id,
    })
    .onConflictDoNothing()
    .returning();
  if (!storedRoll) {
    const deadline = new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS);
    await db
      .update(casinoChallengesTable)
      .set({
        status: battle.status,
        turnDeadlineAt: deadline,
      })
      .where(
        and(
          eq(casinoChallengesTable.id, battle.id),
          eq(casinoChallengesTable.status, "rolling"),
        ),
      );
    scheduleBattleTimeout(resultBot, battle.id);
    await resultBot.sendMessage(
      message.chat.id,
      "That roll slot was already recorded. Send only the next requested emoji.",
    );
    return true;
  }
  if (rollIndex < battle.rollsPerRound) {
    const nextStatus = battle.status;
    await db
      .update(casinoChallengesTable)
      .set({ turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS) })
      .where(
        and(
          eq(casinoChallengesTable.id, battle.id),
          eq(casinoChallengesTable.status, "rolling"),
        ),
      );
    await db
      .update(casinoChallengesTable)
      .set({ status: nextStatus })
      .where(
        and(
          eq(casinoChallengesTable.id, battle.id),
          eq(casinoChallengesTable.status, "rolling"),
        ),
      );
    await promptPvpTurn(resultBot, {
      ...battle,
      status: nextStatus,
      turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
    });
    return true;
  }
  if (battle.status === "awaiting_player_one") {
    const nextBattle = {
      ...battle,
      status: "awaiting_player_two",
      turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
    };
    await db
      .update(casinoChallengesTable)
      .set({
        status: nextBattle.status,
        turnDeadlineAt: nextBattle.turnDeadlineAt,
      })
      .where(
        and(
          eq(casinoChallengesTable.id, battle.id),
          eq(casinoChallengesTable.status, "rolling"),
        ),
      );
    await promptPvpTurn(resultBot, nextBattle);
    return true;
  }

  const allRows = await db
    .select()
    .from(casinoChallengeRollsTable)
    .where(
      and(
        eq(casinoChallengeRollsTable.challengeId, battle.id),
        eq(casinoChallengeRollsTable.actorType, "player"),
      ),
    );
  const playerIds = [battle.creatorPlayerId, battle.playerTwoId].filter(
    (id): id is number => id !== null,
  );
  const playerOneRound = allRows
    .filter(
      (row) =>
        row.playerId === playerIds[0] &&
        row.round === round,
    )
    .reduce((total, row) => total + row.value, 0);
  const playerTwoRound = allRows
    .filter(
      (row) =>
        row.playerId === playerIds[1] &&
        row.round === round,
    )
    .reduce((total, row) => total + row.value, 0);
  const [playerOne, playerTwo] = await Promise.all([
    db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
      .limit(1)
      .then(([row]) => row),
    battle.playerTwoId
      ? db
          .select()
          .from(casinoPlayersTable)
          .where(eq(casinoPlayersTable.id, battle.playerTwoId))
          .limit(1)
          .then(([row]) => row)
      : Promise.resolve(undefined),
  ]);
  const roundResult = scoreBattleRound(
    [playerOneRound],
    [playerTwoRound],
    battle.resultRule === "crazy" ? "crazy" : "high",
  );
  const playerOneScore =
    battle.playerOneScore + (roundResult.playerOneWon ? 1 : 0);
  const playerTwoScore =
    battle.playerTwoScore + (roundResult.playerTwoWon ? 1 : 0);
  await resultBot.sendMessage(
    message.chat.id,
    [
      `🏆 Round ${round}: ${
        roundResult.playerOneScore === roundResult.playerTwoScore
          ? "Tie"
          : roundResult.playerOneWon
            ? casinoPlayerLabel(playerOne, "Challenger")
            : casinoPlayerLabel(playerTwo, "Opponent")
      } ${roundResult.playerOneScore === roundResult.playerTwoScore ? "🤝" : "✅"} (${playerOneRound}-${playerTwoRound})`,
    ].join("\n"),
  );
  const complete = battle.targetWins
    ? playerOneScore >= battle.targetWins || playerTwoScore >= battle.targetWins
    : round >= battle.rounds;
  if (complete) {
    clearBattleTimeout(battle.id);
    const matchTie = playerOneScore === playerTwoScore;
    const playerOneWon = playerOneScore > playerTwoScore;
    const settled = await settleBattle({
      battleId: battle.id,
      chatId: battle.chatId,
      playerOneId: battle.creatorPlayerId,
      playerTwoId: battle.playerTwoId,
      mode: "pvp",
      gameType: battle.gameType,
      currency: parseCurrency(battle.currency, "USD"),
      stakeMinor: battle.stakeMinor,
      playerOneScore,
      playerTwoScore,
      playerOneWon,
      fairId: battle.fairId ?? createFairId(),
    });
    const [playerOne, playerTwo] = await Promise.all([
      db.select().from(casinoPlayersTable).where(eq(casinoPlayersTable.id, battle.creatorPlayerId)).limit(1).then(([row]) => row),
      battle.playerTwoId
        ? db.select().from(casinoPlayersTable).where(eq(casinoPlayersTable.id, battle.playerTwoId)).limit(1).then(([row]) => row)
        : Promise.resolve(undefined),
    ]);
    await resultBot.sendMessage(
      message.chat.id,
      battleResultText({
        battleId: battle.id,
        gameType: battle.gameType,
        mode: "pvp",
        playerOneLabel: casinoPlayerLabel(playerOne, "Player 1"),
        playerTwoLabel: casinoPlayerLabel(playerTwo, "Player 2"),
        rounds: pvpRoundScores(
          allRows,
          round,
          battle.creatorPlayerId,
          battle.playerTwoId as number,
        ),
        playerOneWon,
        crazyMode: battle.resultRule === "crazy",
        tie: matchTie,
        payoutMinor: matchTie ? 0 : Math.round(battle.stakeMinor * 1.92),
        currency: parseCurrency(battle.currency, "USD"),
        fairId: settled.fairId,
      }),
    );
    return true;
  }
  const nextBattle = {
    ...battle,
    playerOneScore,
    playerTwoScore,
    status: "awaiting_player_one",
    turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
  };
  await db
    .update(casinoChallengesTable)
    .set({
      playerOneScore,
      playerTwoScore,
      status: nextBattle.status,
      turnDeadlineAt: nextBattle.turnDeadlineAt,
    })
    .where(eq(casinoChallengesTable.id, battle.id));
  await promptPvpTurn(resultBot, nextBattle);
  return true;
}

async function promptPvbRound(
  resultBot: TelegramBot,
  battle: typeof casinoChallengesTable.$inferSelect,
): Promise<void> {
  const [creator] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
    .limit(1);
  const playerRows = await db
    .select()
    .from(casinoChallengeRollsTable)
    .where(
      and(
        eq(casinoChallengeRollsTable.challengeId, battle.id),
        eq(casinoChallengeRollsTable.actorType, "player"),
      ),
    );
  let round = 1;
  let rollCount = 0;
  if (battle.targetWins) {
    const latestRound = playerRows.reduce(
      (latest, row) => Math.max(latest, row.round),
      0,
    );
    const latestCount = playerRows.filter((row) => row.round === latestRound).length;
    round = latestRound === 0 || latestCount >= battle.rollsPerRound
      ? latestRound + 1
      : latestRound;
    rollCount = latestRound === 0 || latestCount >= battle.rollsPerRound
      ? 0
      : latestCount;
  } else {
    for (let candidate = 1; candidate <= battle.rounds; candidate += 1) {
      const count = playerRows.filter((row) => row.round === candidate).length;
      if (count < battle.rollsPerRound) {
        round = candidate;
        rollCount = count;
        break;
      }
    }
    if (round > battle.rounds) return;
  }
  const remaining = battle.rollsPerRound - rollCount;
  const creatorLabel = creator?.username
    ? `@${creator.username}`
    : creator?.displayName ?? "Player";
  await db
    .update(casinoChallengesTable)
    .set({
      status: "running",
      turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
    })
    .where(eq(casinoChallengesTable.id, battle.id));
  scheduleBattleTimeout(resultBot, battle.id);
  await resultBot.sendMessage(
    battle.chatId,
    [
      `<b>Round ${round}</b> · ${escapeTelegramText(creatorLabel)}`,
      `Send ${battle.emoji} directly in this group.`,
      `${remaining} ${remaining === 1 ? "emoji" : "emojis"} remaining. You have 60 seconds.`,
    ].join("\n"),
  );
}

function buildPvbRoundScores(
  rows: Array<typeof casinoChallengeRollsTable.$inferSelect>,
  helpers: TelegramBot[],
  rounds: number,
): BattleRoundScore[] {
  return Array.from({ length: rounds }, (_, index) => {
    const round = index + 1;
    const playerValues = rows
      .filter((row) => row.actorType === "player" && row.round === round)
      .sort((left, right) => left.rollIndex - right.rollIndex)
      .map((row) => row.value);
    const helperValues = rows
      .filter((row) => row.actorType === "helper" && row.round === round)
      .sort((left, right) => left.rollIndex - right.rollIndex)
      .map((row) => row.value);
    return {
      playerOneScore: playerValues.reduce((total, value) => total + value, 0),
      playerTwoScore: helperValues.reduce((total, value) => total + value, 0),
    };
  });
}

function isFreshDirectDiceMessage(
  message: TelegramMessage,
  expectedEmoji: string,
): boolean {
  if (
    !message.dice ||
    message.dice.emoji !== expectedEmoji ||
    message.forward_from ||
    message.forward_origin ||
    message.is_automatic_forward
  ) {
    return false;
  }
  if (message.date) {
    const ageSeconds = Math.floor(Date.now() / 1000) - message.date;
    if (ageSeconds > 120 || ageSeconds < -10) return false;
  }
  return true;
}

async function sendVerifiedBotDice(
  helper: TelegramBot,
  fallback: TelegramBot,
  chatId: number,
  expectedEmoji: string,
  battleId: number,
): Promise<{ roll: TelegramMessage; actorKey: string }> {
  const candidates = helper === fallback ? [helper] : [helper, fallback];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const roll = await candidate.sendDice(chatId, expectedEmoji);
      if (
        roll.chat.id !== chatId ||
        !roll.dice ||
        roll.dice.emoji !== expectedEmoji ||
        !Number.isFinite(roll.dice.value)
      ) {
        lastError = new Error(
          `${candidate.label} returned an unexpected ${expectedEmoji} result for battle ${battleId}`,
        );
        continue;
      }
      return { roll, actorKey: candidate.label };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`No verified helper result for battle ${battleId}`);
}

async function runPvbRound(
  resultBot: TelegramBot,
  helperBots: Map<string, TelegramBot>,
  battle: typeof casinoChallengesTable.$inferSelect,
  round: number,
): Promise<void> {
  const selectedHelper =
    helperBots.get(battle.gameType) ??
    helperBots.get("dice") ??
    Array.from(new Set(helperBots.values()))[0] ??
    resultBot;
  const helpers = [selectedHelper];

  for (let rollIndex = 1; rollIndex <= battle.rollsPerRound; rollIndex += 1) {
    const helper = helpers[(rollIndex - 1) % helpers.length];
    const verified = await sendVerifiedBotDice(
      helper,
      resultBot,
      battle.chatId,
      battle.emoji,
      battle.id,
    );
    const roll = verified.roll;
    const verifiedDice = roll.dice;
    if (!verifiedDice) {
      throw new Error(`Verified helper result did not include dice for battle ${battle.id}`);
    }
    await db
      .insert(casinoChallengeRollsTable)
      .values({
        challengeId: battle.id,
        actorType: "helper",
        actorKey: verified.actorKey,
        playerId: null,
        round,
        rollIndex,
        emoji: verifiedDice.emoji,
        value: verifiedDice.value,
        messageId: roll.message_id,
      })
      .onConflictDoNothing();
  }

  const rows = await db
    .select()
    .from(casinoChallengeRollsTable)
    .where(eq(casinoChallengeRollsTable.challengeId, battle.id));
  const [creator] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
    .limit(1);
  const creatorLabel = creator?.username
    ? `@${creator.username}`
    : creator?.displayName ?? "Player";
  const botLabel = resultBot.botUsername ? `@${resultBot.botUsername}` : "RolexCasino";
  const playerRoundValues = rows
    .filter((row) => row.actorType === "player" && row.round === round)
    .sort((left, right) => left.rollIndex - right.rollIndex)
    .map((row) => row.value);
  const playerRound = sumBattleRolls(playerRoundValues);
  const helperRoundValues = rows
    .filter((row) => row.actorType === "helper" && row.round === round)
    .sort((left, right) => left.rollIndex - right.rollIndex)
    .map((row) => row.value);
  const houseRound = helperRoundValues.reduce((total, value) => total + value, 0);
  const helperExpression = helperRoundValues.join("+");
  const playerExpression = playerRoundValues.join("+");
  const crazyMode = battle.resultRule === "crazy";
  const roundResult = scoreBattleRound(
    [playerRound],
    [houseRound],
    crazyMode ? "crazy" : "high",
  );
  const playerWinsRound = roundResult.playerOneWon;
  const houseWinsRound = roundResult.playerTwoWon;
  await resultBot.sendMessage(
    battle.chatId,
    [
      `🏆 Round ${round}: ${playerWinsRound ? creatorLabel : houseWinsRound ? botLabel : "Tie"} ${
        playerWinsRound || houseWinsRound ? "✅" : "🤝"
      } (${houseRound} - ${playerRound})`,
      `${creatorLabel}: ${playerRound} · ${botLabel}: ${houseRound}`,
    ].join("\n"),
  );

  if (battle.targetWins) {
    const playerWins = battle.playerOneScore + (playerWinsRound ? 1 : 0);
    const botWins = battle.playerTwoScore + (houseWinsRound ? 1 : 0);
    const roundScores = buildPvbRoundScores(rows, helpers, round);
    const matchFinished =
      playerWins >= battle.targetWins || botWins >= battle.targetWins;

    if (matchFinished) {
      clearBattleTimeout(battle.id);
      const playerOneWon = playerWins > botWins;
      const tie = playerWins === botWins;
      await settleBattle({
        battleId: battle.id,
        chatId: battle.chatId,
        playerOneId: battle.creatorPlayerId,
        playerTwoId: null,
        mode: "pvb",
        gameType: battle.gameType,
        currency: parseCurrency(battle.currency, "USD"),
        stakeMinor: battle.stakeMinor,
        playerOneScore: playerWins,
        playerTwoScore: botWins,
        playerOneWon,
        fairId: battle.fairId ?? createFairId(),
      });
      if (playerOneWon) {
        await broadcastPlayerWin(
          resultBot,
          battle.creatorPlayerId,
          battle.gameType,
          Math.round(battle.stakeMinor * 1.92),
          parseCurrency(battle.currency, "USD"),
        );
      }
      await resultBot.sendMessage(
        battle.chatId,
        battleResultText({
          battleId: battle.id,
          gameType: battle.gameType,
          mode: "pvb",
          playerOneLabel: creatorLabel,
          playerTwoLabel: botLabel,
          rounds: roundScores,
          playerOneWon,
          crazyMode,
          tie,
          payoutMinor: tie || !playerOneWon ? 0 : Math.round(battle.stakeMinor * 1.92),
          currency: parseCurrency(battle.currency, "USD"),
          fairId: battle.fairId ?? "legacy",
        }),
        creator ? pvbRematchKeyboard(battle, creator) : undefined,
      );
      return;
    }

    await db
      .update(casinoChallengesTable)
      .set({
        playerOneScore: playerWins,
        playerTwoScore: botWins,
        status: "running",
      })
      .where(eq(casinoChallengesTable.id, battle.id));
    await promptPvbRound(resultBot, {
      ...battle,
      playerOneScore: playerWins,
      playerTwoScore: botWins,
      status: "running",
    });
    return;
  }

  if (round >= battle.rounds) {
     const roundScores = Array.from({ length: battle.rounds }, (_, index) => index + 1).map(
      (roundNumber) => {
        const playerValues = rows
          .filter((row) => row.actorType === "player" && row.round === roundNumber)
          .sort((left, right) => left.rollIndex - right.rollIndex)
          .map((row) => row.value);
         const helperValues = rows
           .filter((row) => row.actorType === "helper" && row.round === roundNumber)
           .sort((left, right) => left.rollIndex - right.rollIndex)
           .map((row) => row.value);
        return {
          playerScore: playerValues.reduce((total, value) => total + value, 0),
          houseScore: helperValues.reduce((total, value) => total + value, 0),
          playerValues,
          helperValues,
        };
      },
    );
     const playerScore = roundScores.filter((score) =>
       crazyMode ? score.playerScore < score.houseScore : score.playerScore > score.houseScore,
     ).length;
     const houseScore = roundScores.filter((score) =>
       crazyMode ? score.houseScore < score.playerScore : score.houseScore > score.playerScore,
     ).length;
     const playerOneWon = playerScore > houseScore;
     const tie = playerScore === houseScore;
    await settleBattle({
      battleId: battle.id,
      chatId: battle.chatId,
      playerOneId: battle.creatorPlayerId,
      playerTwoId: null,
      mode: "pvb",
      gameType: battle.gameType,
      currency: parseCurrency(battle.currency, "USD"),
      stakeMinor: battle.stakeMinor,
         playerOneScore: playerScore,
         playerTwoScore: houseScore,
      playerOneWon,
      fairId: battle.fairId ?? createFairId(),
    });
    if (playerOneWon) {
      await broadcastPlayerWin(
        resultBot,
        battle.creatorPlayerId,
        battle.gameType,
        Math.round(battle.stakeMinor * 1.92),
        parseCurrency(battle.currency, "USD"),
      );
    }
    await resultBot.sendMessage(
      battle.chatId,
      battleResultText({
        battleId: battle.id,
        gameType: battle.gameType,
        mode: "pvb",
        playerOneLabel: creatorLabel,
        playerTwoLabel: botLabel,
        rounds: roundScores.map((score) => ({
          playerOneScore: score.playerScore,
          playerTwoScore: score.houseScore,
        })),
        playerOneWon,
        crazyMode,
        tie,
        payoutMinor: tie || !playerOneWon ? 0 : Math.round(battle.stakeMinor * 1.92),
        currency: parseCurrency(battle.currency, "USD"),
        fairId: battle.fairId ?? "legacy",
      }),
      creator ? pvbRematchKeyboard(battle, creator) : undefined,
    );
    return;
  }

  await promptPvbRound(resultBot, {
    ...battle,
    status: "awaiting_player",
  });
}
async function handlePlayerPvbRoll(
  resultBot: TelegramBot,
  message: TelegramMessage,
  player: typeof casinoPlayersTable.$inferSelect,
  helperBots: Map<string, TelegramBot>,
): Promise<boolean> {
  if (!message.dice) return false;
  if (!isGroupChat(message.chat)) return false;
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(
      and(
        eq(casinoChallengesTable.chatId, message.chat.id),
        eq(casinoChallengesTable.creatorPlayerId, player.id),
        eq(casinoChallengesTable.mode, "pvb"),
        eq(casinoChallengesTable.status, "running"),
      ),
    )
    .limit(1);
  if (!battle) return false;
  if (battle.turnDeadlineAt && battle.turnDeadlineAt.getTime() <= Date.now()) {
    await expirePvbBattle(resultBot, battle.id);
    return true;
  }
  if (!isFreshDirectDiceMessage(message, battle.emoji)) {
    await resultBot.sendMessage(
      message.chat.id,
      `❌ Invalid ${battle.emoji} message. Send the fresh emoji directly, not a forward or a different game emoji.`,
    );
    return true;
  }

  const playerRows = await db
    .select()
    .from(casinoChallengeRollsTable)
    .where(
      and(
        eq(casinoChallengeRollsTable.challengeId, battle.id),
        eq(casinoChallengeRollsTable.actorType, "player"),
      ),
    );
  if (playerRows.some((row) => row.messageId === message.message_id)) {
    await resultBot.sendMessage(message.chat.id, "That emoji message was already counted for this room.");
    return true;
  }
  let round = 1;
  let rollIndex = 1;
  if (battle.targetWins) {
    const latestRound = playerRows.reduce(
      (latest, row) => Math.max(latest, row.round),
      0,
    );
    const latestCount = playerRows.filter((row) => row.round === latestRound).length;
    if (latestRound > 0 && latestCount < battle.rollsPerRound) {
      round = latestRound;
      rollIndex = latestCount + 1;
    } else {
      round = latestRound + 1;
      rollIndex = 1;
    }
  } else {
    for (let candidate = 1; candidate <= battle.rounds; candidate += 1) {
      const count = playerRows.filter((row) => row.round === candidate).length;
      if (count < battle.rollsPerRound) {
        round = candidate;
        rollIndex = count + 1;
        break;
      }
    }
  }
  if (round > battle.rounds) {
    await resultBot.sendMessage(message.chat.id, "This PVB room has already completed its rounds.");
    return true;
  }
  if (
    playerRows.some(
      (row) => row.round === round && row.rollIndex === rollIndex,
    )
  ) {
    await resultBot.sendMessage(
      message.chat.id,
      `Round ${round} roll ${rollIndex} is already recorded. Wait for the bot result.`,
    );
    return true;
  }
  const [claimedBattle] = await db
    .update(casinoChallengesTable)
    .set({ status: "rolling", turnDeadlineAt: null })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "running"),
      ),
    )
    .returning();
  if (!claimedBattle) {
    await resultBot.sendMessage(message.chat.id, "That roll is already being processed. Please wait for the round result.");
    return true;
  }
  clearBattleTimeout(battle.id);
  const [storedRoll] = await db
    .insert(casinoChallengeRollsTable)
    .values({
      challengeId: battle.id,
      actorType: "player",
      actorKey: String(player.id),
      playerId: player.id,
      round,
      rollIndex,
      emoji: message.dice.emoji,
      value: message.dice.value,
      messageId: message.message_id,
    })
    .onConflictDoNothing()
    .returning();
  if (!storedRoll) {
    const deadline = new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS);
    await db
      .update(casinoChallengesTable)
      .set({ status: "running", turnDeadlineAt: deadline })
      .where(
        and(
          eq(casinoChallengesTable.id, battle.id),
          eq(casinoChallengesTable.status, "rolling"),
        ),
      );
    scheduleBattleTimeout(resultBot, battle.id);
    await resultBot.sendMessage(
      message.chat.id,
      "That roll was already counted. Send only the next requested emoji.",
    );
    return true;
  }

  if (rollIndex < battle.rollsPerRound) {
    await db
      .update(casinoChallengesTable)
      .set({
        turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
      })
      .where(eq(casinoChallengesTable.id, battle.id));
    scheduleBattleTimeout(resultBot, battle.id);
    await resultBot.sendMessage(
      message.chat.id,
      `✅ Throw ${rollIndex}/${battle.rollsPerRound} received for round ${round}. Throw ${battle.rollsPerRound - rollIndex} more ${battle.emoji}.`,
    );
    return true;
  }

  try {
    await runPvbRound(resultBot, helperBots, claimedBattle, round);
  } catch (error) {
    logger.error({ err: error, battleId: battle.id, round }, "Verified PvB helper result failed");
    await db
      .delete(casinoChallengeRollsTable)
      .where(
        and(
          eq(casinoChallengeRollsTable.challengeId, battle.id),
          eq(casinoChallengeRollsTable.actorType, "player"),
          eq(casinoChallengeRollsTable.messageId, message.message_id),
        ),
      );
    const deadline = new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS);
    await db
      .update(casinoChallengesTable)
      .set({ status: "running", turnDeadlineAt: deadline })
      .where(eq(casinoChallengesTable.id, battle.id));
    scheduleBattleTimeout(resultBot, battle.id);
    await resultBot.sendMessage(
      message.chat.id,
      `⚠️ The ${battle.gameType} bot result could not be verified. Please send ${battle.emoji} again for this round.`,
    );
    return true;
  }
  if (round < battle.rounds && battle.status !== "completed") {
    await db
      .update(casinoChallengesTable)
      .set({ status: "running" })
      .where(eq(casinoChallengesTable.id, battle.id));
  }
  return true;
}

async function playSimpleMainGame(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  gameType: string,
  amountMinor: number | null,
  currency: Currency,
  choice?: string,
  rollerBot: TelegramBot = bot,
  allIn = false,
): Promise<void> {
  if (!amountMinor && !allIn) {
    await bot.sendMessage(chatId, `Usage: /${gameType} ${choice ? `${choice} ` : ""}AMOUNT INR|USD`);
    return;
  }
  const player = await ensurePlayer(user);
  const wallet = await ensureWallet(player.id, currency);
  const stakeMinor = allIn ? wallet.balanceMinor : amountMinor;
  if (
    !stakeMinor ||
    !(await betInRange(stakeMinor, currency, gameType))
  ) {
    await bot.sendMessage(
      chatId,
      await configuredBetLimitText(currency, gameType),
    );
    return;
  }
  if (wallet.balanceMinor < stakeMinor) {
    await bot.sendMessage(chatId, `Insufficient balance. Your ${currency} balance is ${formatMoney(wallet.balanceMinor, currency)}.`);
    return;
  }

  let rollValue: number;
  const rollValues: number[] = [];
  let outcome: GameResult;
  if (gameType === "coin") {
      rollValue = randomInt(0, 2);
      outcome = { outcome: rollValue === 1 ? "HEADS" : "TAILS", multiplier: 1.92 };
    } else {
    let roll: TelegramMessage;
    try {
        roll = await rollerBot.sendDice(chatId, "🎲");
    } catch (error) {
      logger.warn(
        { err: error, roller: rollerBot.label, gameType },
        "Game roller failed; using the main bot fallback",
      );
      roll = await bot.sendDice(chatId, "🎲");
    }
      rollValue = roll.dice?.value ?? 0;
      rollValues.push(rollValue);
      if (gameType === "7up") {
        let secondRoll: TelegramMessage;
        try {
          secondRoll = await rollerBot.sendDice(chatId, "🎲");
        } catch (error) {
          logger.warn(
            { err: error, roller: rollerBot.label },
            "Second 7up die failed; using the main bot fallback",
          );
          secondRoll = await bot.sendDice(chatId, "🎲");
        }
        const secondValue = secondRoll.dice?.value ?? 0;
        rollValues.push(secondValue);
        rollValue += secondValue;
      }
    const wins =
      gameType === "7up"
          ? (choice === "up" && rollValue >= 7) || (choice === "down" && rollValue <= 6)
        : (choice === "high" && rollValue >= 4) ||
          (choice === "low" && rollValue <= 3) ||
          (choice === "odd" && rollValue % 2 === 1) ||
          (choice === "even" && rollValue % 2 === 0);
    outcome = {
      outcome: wins ? "WIN" : "NO WIN",
        multiplier:
          gameType === "7up"
            ? sevenUpMultiplier(rollValue, choice === "up" ? "up" : "down")
            : wins
              ? 1.92
              : 0,
    };
  }

  try {
    const settled = await settleGame({
      playerId: player.id,
      helperBot: rollerBot.label,
      gameType,
      currency,
      stakeMinor,
      rollValue,
      result: outcome,
    });
    const payoutMinor = Math.round(stakeMinor * outcome.multiplier);
    if (outcome.multiplier > 0) {
      await broadcastPlayerWin(bot, player.id, gameType, payoutMinor, currency);
    }
    await bot.sendMessage(
      chatId,
      [
        `${outcome.outcome === "WIN" ? "🏆🎉" : "❌"} ${gameType === "7up" ? "7UP PVB" : gameType.toUpperCase()} ${outcome.outcome}`,
        gameType === "coin"
          ? `Result: ${outcome.outcome}`
          : gameType === "7up"
            ? `House dice: ${rollValues.join(" + ")} = ${rollValue}`
            : `Result: ${rollValue}`,
        gameType === "7up"
          ? `Selection: ${choice?.toUpperCase()} · Multiplier: ${outcome.multiplier.toFixed(2)}×`
          : "",
        `Stake: ${formatMoney(stakeMinor, currency)}`,
        `Payout: ${formatMoney(payoutMinor, currency)}`,
        `Balance: ${formatMoney(settled.balanceMinor, currency)}`,
        `Fair ID: <code>${settled.fairId}</code>`,
      ].join("\n"),
    );
    await auditTransaction(
      bot,
      [
        "Type: game settlement",
        `Player: ${player.telegramUserId}`,
        `Game: ${gameType}`,
        `Stake: ${formatMoney(stakeMinor, currency)}`,
        `Payout: ${formatMoney(payoutMinor, currency)}`,
        `Fair ID: <code>${settled.fairId}</code>`,
        `Outcome: ${outcome.outcome}`,
      ].join("\n"),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      await bot.sendMessage(chatId, "The round was not accepted because your balance changed.");
      return;
    }
    throw error;
  }
}

async function handleTip(
  bot: TelegramBot,
  chatId: number,
  message: TelegramMessage,
  player: typeof casinoPlayersTable.$inferSelect,
  args: string[],
): Promise<void> {
  const replyTarget = message.reply_to_message?.from;
  const mentionTarget = args[0]?.startsWith("@") ? normalizeUsername(args[0]) : null;
  const amountArg = replyTarget ? args[0] : args[1];
  const currencyArg = replyTarget ? args[1] : args[2];
  const amountMinor = parseMoney(amountArg);
  if (!amountMinor || (!replyTarget && !mentionTarget)) {
    await bot.sendMessage(chatId, "Usage: reply /tip 100 INR or /tip @username 100 INR");
    return;
  }

  let targetPlayer: typeof casinoPlayersTable.$inferSelect | undefined;
  if (replyTarget) {
    targetPlayer = await ensurePlayer(replyTarget);
  } else if (mentionTarget) {
    [targetPlayer] =
      (await db
        .select()
        .from(casinoPlayersTable)
        .where(eq(casinoPlayersTable.username, mentionTarget))
        .limit(1)) ?? [];
  }
  if (!targetPlayer) {
    await bot.sendMessage(chatId, "That player must open RolexCasino with /start before receiving a tip.");
    return;
  }
  const currency = parseCurrency(currencyArg, parseCurrency(player.preferredCurrency, "USD"));
  if (convertMinor(amountMinor, currency, "INR") > TIP_CONFIRMATION_THRESHOLD_INR_MINOR) {
    await bot.sendMessage(
      chatId,
      [
        "<b>⚠️ TIP CONFIRMATION REQUIRED</b>",
        "",
        `Recipient: <b>${escapeTelegramText(targetPlayer.displayName)}</b>`,
        `Amount: <b>${formatMoney(amountMinor, currency)}</b>`,
        "Tips above ₹50 require explicit confirmation.",
      ].join("\n"),
      {
        inline_keyboard: [[
          {
            text: "Confirm tip",
            callback_data: `tip:confirm:${player.id}:${targetPlayer.id}:${amountMinor}:${currency}`,
          },
          { text: "Cancel", callback_data: `tip:cancel:${player.id}` },
        ]],
      },
    );
    return;
  }
  try {
    const balance = await tipPlayer({
      fromPlayerId: player.id,
      toPlayerId: targetPlayer.id,
      amountMinor,
      currency,
    });
    await bot.sendMessage(
      chatId,
      [
        "<b>✅ TIP SENT SUCCESSFULLY</b>",
        "",
        `To: <b>${escapeTelegramText(targetPlayer.displayName)}</b>`,
        `Amount: <b>${formatMoney(amountMinor, currency)}</b>`,
        `Your new balance: <b>${formatMoney(balance.balanceMinor, currency)}</b>`,
        `Fair ID: <code>${balance.fairId}</code>`,
      ].join("\n"),
    );
    await notifyTipRecipient(bot, targetPlayer, player, amountMinor, currency);
    await auditTransaction(
      bot,
      [
        "Type: tip",
        `From: ${player.telegramUserId}`,
        `To: ${targetPlayer.telegramUserId}`,
        `Amount: ${formatMoney(amountMinor, currency)}`,
        `Fair ID: <code>${balance.fairId}</code>`,
      ].join("\n"),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      await bot.sendMessage(chatId, "Tip rejected because your balance is too low.");
    } else if (error instanceof Error && error.message === "SELF_TIP") {
      await bot.sendMessage(chatId, "You cannot tip yourself.");
    } else {
      throw error;
    }
  }
}

async function notifyTipRecipient(
  bot: TelegramBot,
  recipient: typeof casinoPlayersTable.$inferSelect,
  sender: typeof casinoPlayersTable.$inferSelect,
  amountMinor: number,
  currency: Currency,
): Promise<void> {
  try {
    await bot.sendMessage(
      recipient.telegramUserId,
      [
        "<b>💸 YOU RECEIVED A TIP</b>",
        "",
        `From: <b>${escapeTelegramText(sender.displayName)}</b>`,
        `Amount: <b>${formatMoney(amountMinor, currency)}</b>`,
        "The funds have been added to your wallet.",
      ].join("\n"),
    );
  } catch (error) {
    logger.warn(
      { err: error, recipientId: recipient.telegramUserId },
      "Tip completed but recipient notification could not be delivered",
    );
  }
}

async function handleTipCallback(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
  action: string,
): Promise<void> {
  const parts = action.split(":");
  const verb = parts[1];
  const senderPlayerId = Number(parts[2]);
  if (!Number.isSafeInteger(senderPlayerId) || senderPlayerId !== player.id) {
    await bot.sendMessage(chatId, "Only the player who created this tip can confirm or cancel it.");
    return;
  }
  if (verb === "cancel") {
    await bot.sendMessage(chatId, "Tip cancelled. No balance was changed.");
    return;
  }
  if (verb !== "confirm") return;
  const targetPlayerId = Number(parts[3]);
  const amountMinor = Number(parts[4]);
  const currency = parseCurrency(parts[5], "USD");
  if (
    !Number.isSafeInteger(targetPlayerId) ||
    targetPlayerId <= 0 ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0
  ) {
    await bot.sendMessage(chatId, "This tip confirmation is invalid or expired.");
    return;
  }
  const [targetPlayer] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, targetPlayerId))
    .limit(1);
  if (!targetPlayer) {
    await bot.sendMessage(chatId, "The tip recipient is no longer available.");
    return;
  }
  try {
    const balance = await tipPlayer({
      fromPlayerId: player.id,
      toPlayerId: targetPlayer.id,
      amountMinor,
      currency,
    });
    await bot.sendMessage(
      chatId,
      [
        "<b>✅ TIP SENT SUCCESSFULLY</b>",
        "",
        `To: <b>${escapeTelegramText(targetPlayer.displayName)}</b>`,
        `Amount: <b>${formatMoney(amountMinor, currency)}</b>`,
        `Your new balance: <b>${formatMoney(balance.balanceMinor, currency)}</b>`,
        `Fair ID: <code>${balance.fairId}</code>`,
      ].join("\n"),
    );
    await notifyTipRecipient(bot, targetPlayer, player, amountMinor, currency);
    await auditTransaction(
      bot,
      [
        "Type: tip",
        `From: ${player.telegramUserId}`,
        `To: ${targetPlayer.telegramUserId}`,
        `Amount: ${formatMoney(amountMinor, currency)}`,
        `Fair ID: <code>${balance.fairId}</code>`,
      ].join("\n"),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      await bot.sendMessage(chatId, "Tip rejected because your balance is too low.");
    } else if (error instanceof Error && error.message === "SELF_TIP") {
      await bot.sendMessage(chatId, "You cannot tip yourself.");
    } else {
      throw error;
    }
  }
}

async function handleClaim(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
  code: string | undefined,
): Promise<void> {
  if (!code) {
    await bot.sendMessage(chatId, "Usage: /claim PROMO_CODE");
    return;
  }
  try {
    const claimed = await claimPromo(player.id, code);
    await bot.sendMessage(chatId, `Promo claimed: ${formatMoney(claimed.amountMinor, claimed.currency)} added to your balance.`);
  } catch (error) {
    const reason =
      error instanceof Error && error.message === "PROMO_ALREADY_CLAIMED"
        ? "You already claimed that promo."
        : "That promo code is invalid, inactive, or fully claimed.";
    await bot.sendMessage(chatId, reason);
  }
}

async function sendHistory(bot: TelegramBot, chatId: number, playerId: number): Promise<void> {
  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, playerId))
    .limit(1);
  const [rounds, battles] = await Promise.all([
    db
      .select()
      .from(casinoGameRoundsTable)
      .where(eq(casinoGameRoundsTable.playerId, playerId)),
    db
      .select()
      .from(casinoChallengesTable)
      .where(
        and(
          eq(casinoChallengesTable.status, "completed"),
          or(
            eq(casinoChallengesTable.creatorPlayerId, playerId),
            eq(casinoChallengesTable.playerTwoId, playerId),
          ),
        ),
      ),
  ]);
  const history: GameHistoryCardItem[] = [
    ...rounds.map((round) => ({
      gameType: round.gameType,
      currency: round.currency,
      stakeMinor: round.stakeMinor,
      outcome: round.outcome === "WIN" ? "WIN" as const : "LOSS" as const,
      createdAt: round.createdAt,
    })),
    ...battles.map((battle) => {
      const isCreator = battle.creatorPlayerId === playerId;
      const playerWon = battle.winnerPlayerId === playerId;
      const isTie =
        battle.winnerPlayerId == null &&
        battle.playerOneScore === battle.playerTwoScore;
      return {
        gameType: `${battle.gameType} ${battle.mode.toUpperCase()}`,
        currency: battle.currency,
        stakeMinor: battle.stakeMinor,
        outcome: isTie ? "TIE" as const : playerWon ? "WIN" as const : "LOSS" as const,
        createdAt: battle.completedAt ?? battle.createdAt,
      };
    }),
  ]
    .sort((left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    )
    .slice(0, 10);
  if (history.length === 0) {
    await bot.sendMessage(chatId, "📭 No game rounds yet. Open /games to start.");
    return;
  }
  const image = await gameHistoryCardPng(
    player?.displayName ?? "Player",
    history,
  );
  await bot.sendPhoto(
    chatId,
    image,
    `<b>📜 ${escapeTelegramText(player?.displayName ?? "Player")} — latest 10 games</b>`,
  );
}

async function sendLeaderboard(bot: TelegramBot, chatId: number): Promise<void> {
  const wallets = await db
    .select()
    .from(casinoWalletsTable)
    .where(gte(casinoWalletsTable.balanceMinor, 0))
    .orderBy(desc(casinoWalletsTable.balanceMinor))
    .limit(10);
  const playerIds = wallets.map((wallet) => wallet.playerId);
  const players =
    playerIds.length > 0
      ? await db
          .select()
          .from(casinoPlayersTable)
          .where(inArray(casinoPlayersTable.id, playerIds))
      : [];
  const names = new Map(players.map((player) => [player.id, player.displayName]));
  await bot.sendMessage(
    chatId,
    [
      "🏆 RolexCasino leaderboard",
      "",
      ...(wallets.length > 0
        ? wallets.map(
            (wallet, index) =>
              `${index + 1}. ${escapeTelegramText(names.get(wallet.playerId) ?? "Player")} — ${formatMoney(wallet.balanceMinor, wallet.currency as Currency)}`,
          )
        : ["No funded player wallets yet."]),
    ].join("\n"),
  );
}

async function sendGames(
  bot: TelegramBot,
  chatId: number,
  helperLinks: Map<string, string>,
  ownerTelegramUserId: number,
): Promise<void> {
  const configuredLimits = await Promise.all(
    ["dice", "darts", "basketball", "football", "bowling", "slots"].map(
      async (gameType) => [
        gameType,
        await configuredBetLimitText("INR", gameType),
      ] as const,
    ),
  );
  const limitByGame = new Map(configuredLimits);
  await bot.sendMessage(
    chatId,
    [
      "<b>🤍 AVAILABLE GAMES</b>",
      "",
      "🤑 <b>Coin Flip</b>",
      "💕 <b>Dice</b>",
      "😳 <b>Darts</b>",
      "🏀 <b>Basketball</b>",
      "⚽️ <b>Football</b>",
      "6️⃣ <b>Bowling</b>",
      "🎰 <b>Slots</b>",
      "🎲 <b>Dice Rush (dr)</b>",
      "🎲 <b>7up</b>",
      "",
      "<b>Reply to a player for PVP, or use PVB to play against the bot.</b>",
      "",
      `Game minimums: ${[
        ["Dice", "dice"],
        ["Darts", "darts"],
        ["Basketball", "basketball"],
        ["Football", "football"],
        ["Bowling", "bowling"],
        ["Slots", "slots"],
      ].map(([label, gameType]) => `${label}: ${limitByGame.get(gameType)}`).join("\n")}`,
    ].join("\n"),
    {
      inline_keyboard: [[
        { text: "Currency", callback_data: ownedCallback("main:currency", ownerTelegramUserId) },
        { text: "Support", callback_data: ownedCallback("main:support", ownerTelegramUserId) },
      ]],
    },
  );
}

async function getAdminStats(
  playerId: number,
): Promise<CasinoStatsSummary> {
  const [rounds, battles] = await Promise.all([
    db
      .select()
      .from(casinoGameRoundsTable)
      .where(eq(casinoGameRoundsTable.playerId, playerId)),
    db
      .select()
      .from(casinoChallengesTable)
      .where(
        and(
          eq(casinoChallengesTable.status, "completed"),
          or(
            eq(casinoChallengesTable.creatorPlayerId, playerId),
            eq(casinoChallengesTable.playerTwoId, playerId),
          ),
        ),
    ),
  ]);
  return summarizeCasinoStats(playerId, rounds, battles);
}

async function resolveAdminTarget(
  message: TelegramMessage,
  args: string[],
): Promise<
  | { kind: "found"; player: typeof casinoPlayersTable.$inferSelect }
  | { kind: "ambiguous_username" }
  | undefined
> {
  const target = parseAdminTarget({
    replyFromId: message.reply_to_message?.from?.id,
    args,
  });
  if (!target) return undefined;
  if (target.kind === "reply") {
    const replyFrom = message.reply_to_message?.from;
    return replyFrom
      ? { kind: "found", player: await ensurePlayer(replyFrom) }
      : undefined;
  }
  if (target.kind === "telegram_id") {
    const [player] = await db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.telegramUserId, target.telegramUserId))
      .limit(1);
    return player ? { kind: "found", player } : undefined;
  }
  const players = await db
    .select()
    .from(casinoPlayersTable)
    .where(sql`lower(${casinoPlayersTable.username}) = ${target.username}`)
    .limit(2);
  if (players.length > 1) return { kind: "ambiguous_username" };
  const player = selectUniqueUsernameMatch(players);
  return player ? { kind: "found", player } : undefined;
}

async function sendAdminUserStats(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  const stats = await getAdminStats(player.id);
  await bot.sendMessage(chatId, formatAdminUserStats(player, stats));
}

async function sendAdminUserBalance(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  const wallets = await db
    .select()
    .from(casinoWalletsTable)
    .where(eq(casinoWalletsTable.playerId, player.id));
  await bot.sendMessage(chatId, formatAdminUserBalance(player, wallets));
}

async function sendAdminUserInfo(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  const [stats, wallets, referrals, cashRequests, escrows] = await Promise.all([
    getAdminStats(player.id),
    db.select().from(casinoWalletsTable).where(eq(casinoWalletsTable.playerId, player.id)),
    db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.referredByPlayerId, player.id)),
    db
      .select()
      .from(casinoCashRequestsTable)
      .where(eq(casinoCashRequestsTable.playerId, player.id)),
    db
      .select()
      .from(casinoEscrowsTable)
      .where(
        or(
          eq(casinoEscrowsTable.senderPlayerId, player.id),
          eq(casinoEscrowsTable.recipientPlayerId, player.id),
        ),
      ),
  ]);
  const inr = wallets.find((wallet) => wallet.currency === "INR")?.balanceMinor ?? 0;
  const usd = wallets.find((wallet) => wallet.currency === "USD")?.balanceMinor ?? 0;
  const currencyStats = stats.currencies
    .map(
      (item) =>
        `${item.currency}: ${item.rounds} rounds · Wager ${formatMoney(item.wagerMinor, item.currency)} · Profit ${formatMoney(item.profitMinor, item.currency)}`,
    )
    .join("\n");
  await bot.sendMessage(
    chatId,
    [
      "🛡️ Admin complete user information",
      "",
      `Player ID: ${player.id}`,
      `Telegram ID: ${player.telegramUserId}`,
      `Name: ${escapeTelegramText(player.displayName)}`,
      `Username: ${player.username ? `@${escapeTelegramText(player.username)}` : "not set"}`,
      `Joined: ${new Date(player.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
      `Preferred currency: ${player.preferredCurrency}`,
      `Category: ${stats.category}`,
      "",
      `INR balance: ${formatMoney(inr, "INR")}`,
      `USD balance: ${formatMoney(usd, "USD")}`,
      `Total INR equivalent: ${formatMoney(inr + convertMinor(usd, "USD", "INR"), "INR")}`,
      `Payout wallet: ${maskPayoutWallet(player.payoutWallet)}`,
      `Payout type: ${player.payoutWalletType ?? "not set"}`,
      "",
      `Referral code: ${player.referralCode ?? "not set"}`,
      `Referred users: ${referrals.length}`,
      `Referral earnings: ${formatMoney(player.referralEarningsMinor, parseCurrency(player.preferredCurrency, "USD"))}`,
      "",
      currencyStats,
      `Total wager equivalent: ${formatMoney(stats.wagerInrMinor, "INR")}`,
      `Cash requests: ${cashRequests.length}`,
      `Escrows sent/received: ${escrows.length}`,
    ].join("\n"),
  );
}

async function handlePowerCommand(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  args: string[],
): Promise<boolean> {
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, "This command is restricted to RolexCasino administrators.");
    return true;
  }

  const action = args[0]?.toLowerCase();
  if (!action || action === "status") {
    await bot.sendMessage(
      chatId,
      casinoPowerOn
        ? "🟢 RolexCasino is currently ON."
        : "🔴 RolexCasino is currently OFF for maintenance.",
    );
    return true;
  }

  if (action !== "on" && action !== "off") {
    await bot.sendMessage(chatId, "Usage: /power on | /power off | /power status");
    return true;
  }

  casinoPowerOn = action === "on";
  await bot.sendMessage(
    chatId,
    casinoPowerOn
      ? "🟢 RolexCasino is now ON. Users can use the bot and games again."
      : "🔴 RolexCasino is now OFF. Temporary maintenance mode is active; only admins can use commands.",
  );
  return true;
}

async function sendHouseBalance(
  bot: TelegramBot,
  chatId: number,
  _userId: number,
): Promise<void> {
  const wallets = await db
    .select()
    .from(casinoHouseWalletsTable)
    .orderBy(casinoHouseWalletsTable.currency);
  await bot.sendMessage(
    chatId,
    [
      "<b>🏦 House totals</b>",
      "",
      ...(["INR", "USD"] as Currency[]).map((currency) => {
        const wallet = wallets.find((item) => item.currency === currency);
        return `${currency}: <b>${formatMoney(wallet?.balanceMinor ?? 0, currency)}</b>`;
      }),
      "",
      "PvB losses add the full stake. Winning PvB rounds record the 0.8× house portion.",
    ].join("\n"),
  );
}

async function sendDailyBonusSettings(
  bot: TelegramBot,
  chatId: number,
): Promise<void> {
  const [settings] = await db
    .select()
    .from(casinoDailyBonusSettingsTable)
    .limit(1);
  if (!settings || settings.amountMinor <= 0 || settings.eligibleUsers <= 0) {
    await bot.sendMessage(chatId, "Daily bonus is not configured yet. Use /setdaily AMOUNT USERS INR|USD.");
    return;
  }
  await bot.sendMessage(
    chatId,
    [
      "<b>🎁 Daily bonus configured</b>",
      "",
      `Amount: <b>${formatMoney(settings.amountMinor, parseCurrency(settings.currency, "INR"))}</b>`,
      `Eligible users: <b>${settings.eligibleUsers}</b>`,
      "This configuration is stored for the daily bonus distribution.",
    ].join("\n"),
  );
}

async function handleAdminCommand(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  command: string,
  args: string[],
  message: TelegramMessage,
): Promise<boolean> {
  if (command === "balanceadd") command = "credit";
  if (command === "balancededuct") command = "debit";

  if (command === "hb") {
    await sendHouseBalance(bot, chatId, userId);
    return true;
  }

  if (command === "setdaily") {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const amountMinor = parseMoney(args[0]);
    const eligibleUsers = Number(args[1]);
    const currencyToken = args[2]?.toUpperCase();
    const currency = parseCurrency(currencyToken, "INR");
    if (
      !amountMinor ||
      !Number.isInteger(eligibleUsers) ||
      eligibleUsers <= 0 ||
      (currencyToken !== undefined && !isSupportedCurrency(currencyToken))
    ) {
      await bot.sendMessage(chatId, "Usage: /setdaily AMOUNT USERS INR|USD\nExample: /setdaily 25 100 INR");
      return true;
    }
    await db
      .insert(casinoDailyBonusSettingsTable)
      .values({
        id: 1,
        amountMinor,
        currency,
        eligibleUsers,
        updatedByTelegramUserId: userId,
      })
      .onConflictDoUpdate({
        target: casinoDailyBonusSettingsTable.id,
        set: {
          amountMinor,
          currency,
          eligibleUsers,
          updatedByTelegramUserId: userId,
          updatedAt: new Date(),
        },
      });
    await bot.sendMessage(
      chatId,
      `✅ Daily bonus saved: ${formatMoney(amountMinor, currency)} for ${eligibleUsers} eligible users.`,
    );
    return true;
  }

  if (
    command === "set" ||
    normalizeConfigurableGameType(command.slice(3)) !== null
  ) {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const gameToken = command === "set" ? args[0] : command.slice(3);
    const gameType = normalizeConfigurableGameType(gameToken);
    const valueArgs = command === "set" ? args.slice(1) : args;
    const amountMinor = parseMoney(valueArgs[0]);
    const currencyToken = valueArgs[1]?.toUpperCase();
    const currency = parseCurrency(currencyToken, "INR");
    if (
      !gameType ||
      !amountMinor ||
      (currencyToken !== undefined && !isSupportedCurrency(currencyToken)) ||
      amountMinor > (currency === "INR"
        ? MAX_BET_INR_MINOR
        : Math.floor(MAX_BET_INR_MINOR / INR_PER_USD))
    ) {
      await bot.sendMessage(
        chatId,
        "Usage: /set GAME AMOUNT INR|USD or /setdice AMOUNT INR|USD\nExample: /set dice 25 INR",
      );
      return true;
    }
    await db
      .insert(casinoGameBetSettingsTable)
      .values({
        gameType,
        currency,
        minimumBetMinor: amountMinor,
        updatedByTelegramUserId: userId,
      })
      .onConflictDoUpdate({
        target: [
          casinoGameBetSettingsTable.gameType,
          casinoGameBetSettingsTable.currency,
        ],
        set: {
          minimumBetMinor: amountMinor,
          updatedByTelegramUserId: userId,
          updatedAt: new Date(),
        },
      });
    await bot.sendMessage(
      chatId,
      `✅ ${gameType} minimum bet saved: ${formatMoney(amountMinor, currency)}.`,
    );
    return true;
  }

  if (command === "users") {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const players = await db
      .select()
      .from(casinoPlayersTable)
      .orderBy(desc(casinoPlayersTable.createdAt))
      .limit(20);
    await bot.sendMessage(
      chatId,
      [
        "<b>👥 Recent RolexCasino users</b>",
        "",
        ...(players.length
          ? players.map(
              (item, index) =>
                `${index + 1}. ${item.username ? `@${item.username}` : item.displayName} · <code>${item.telegramUserId}</code>`,
            )
          : ["No users have opened the bot yet."]),
      ].join("\n"),
    );
    return true;
  }

  if (command === "rain") {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const amountMinor = parseMoney(args[0]);
    const currency = parseCurrency(args[1], "INR");
    if (!amountMinor || !isSupportedCurrency(currency)) {
      await bot.sendMessage(chatId, "Usage: /rain AMOUNT INR|USD");
      return true;
    }
    const players = await db.select({ telegramUserId: casinoPlayersTable.telegramUserId }).from(casinoPlayersTable);
    let credited = 0;
    for (const target of players) {
      await adjustBalance({
        adminId: userId,
        telegramUserId: target.telegramUserId,
        amountMinor,
        currency,
        entryType: "admin_credit",
        description: `Rain bonus ${formatMoney(amountMinor, currency)}`,
      });
      credited += 1;
    }
    await bot.sendMessage(
      chatId,
      `<b>🌧 Rain complete</b>\nCredited ${formatMoney(amountMinor, currency)} to ${credited} users.`,
    );
    return true;
  }

  if (command === "admin") {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    await bot.sendMessage(
      chatId,
      [
        "Admin accounting commands",
        "",
        "/credit USER_ID AMOUNT INR|USD",
        "/debit USER_ID AMOUNT INR|USD",
        "/resolve ESCROW_CODE buyer|seller",
        "/userstats USER_ID|@username",
        "/userbalance USER_ID|@username",
        "/userinfo USER_ID|@username",
        "You can also reply to a user's message instead of providing an ID.",
        "/power on|off|status",
        "",
        "/balanceadd USER_ID AMOUNT INR|USD",
        "/balancededuct USER_ID AMOUNT INR|USD",
        "/rain AMOUNT INR|USD — credit every registered user",
        "/setdaily AMOUNT USERS INR|USD — save daily bonus configuration",
        "/set GAME AMOUNT INR|USD or /setdice AMOUNT — set a game minimum",
        "/users — list recent registered users",
      ].join("\n"),
    );
    return true;
  }

  if (USER_INSPECTION_COMMANDS.has(command)) {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const targetResult = await resolveAdminTarget(message, args);
    if (targetResult?.kind === "ambiguous_username") {
      await bot.sendMessage(
        chatId,
        "That username matches multiple player records. Inspection was not performed.",
      );
      return true;
    }
    const target = targetResult?.player;
    if (!target) {
      await bot.sendMessage(
        chatId,
        `Usage: /${command} USER_ID|@username\nOr reply to a user's message with /${command}`,
      );
      return true;
    }
    if (command === "userstats" || command === "checkstats") {
      await sendAdminUserStats(bot, chatId, target);
    } else if (command === "userbalance" || command === "checkbalance") {
      await sendAdminUserBalance(bot, chatId, target);
    } else {
      await sendAdminUserInfo(bot, chatId, target);
    }
    return true;
  }

  if (command === "resolve") {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const code = args[0]?.toUpperCase();
    const decision = args[1]?.toLowerCase();
    if (!code || (decision !== "buyer" && decision !== "seller")) {
      await bot.sendMessage(chatId, "Usage: /resolve ESCROW_CODE buyer|seller");
      return true;
    }
    try {
      const escrow = decision === "seller"
        ? await releaseEscrow(code)
        : await cancelEscrowImmediately(code);
      await refreshEscrowCard(bot, escrow, true);
      const currency = parseCurrency(escrow.currency, "USD");
      await bot.sendMessage(
        chatId,
        decision === "seller"
          ? `✅ Admin resolution complete: ${escrow.code} released to the accepting buyer. ${formatMoney(escrow.amountMinor, currency)} credited and the completed card remains pinned.`
          : `✅ Admin resolution complete: ${escrow.code} cancelled. ${formatMoney(escrow.amountMinor, currency)} refunded to the seller; the completed card remains pinned.`,
      );
      await auditTransaction(
        bot,
        [
          "Type: admin escrow resolution",
          `Code: ${escrow.code}`,
          `Fair ID: <code>${escrow.fairId ?? "legacy"}</code>`,
          `Decision: ${decision}`,
          `Amount: ${formatMoney(escrow.amountMinor, currency)}`,
          `Admin: ${userId}`,
        ].join("\n"),
      );
    } catch (error) {
      await bot.sendMessage(chatId, escrowErrorText(error));
    }
    return true;
  }

  if (command !== "credit" && command !== "debit") return false;
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
    return true;
  }

  const targetId = Number(args[0]);
  const amountMinor = parseMoney(args[1]);
  const currency = parseCurrency(args[2], "USD");
  if (!Number.isSafeInteger(targetId) || targetId <= 0 || !amountMinor || !isSupportedCurrency(currency)) {
    await bot.sendMessage(chatId, `Usage: /${command} USER_ID AMOUNT INR|USD`);
    return true;
  }

  try {
    const result = await adjustBalance({
      adminId: userId,
      telegramUserId: targetId,
      amountMinor,
      currency,
      entryType: command === "credit" ? "admin_credit" : "admin_debit",
      description: `${command} ${formatMoney(amountMinor, currency)}`,
    });
    await bot.sendMessage(
      chatId,
       `${command === "credit" ? "Credited" : "Debited"} ${formatMoney(amountMinor, currency)}.\nNew balance: ${formatMoney(result.balanceMinor, currency)}.\nFair ID: ${result.fairId}`,
    );
    await auditTransaction(
      bot,
      [
        `Type: admin ${command}`,
        `Admin: ${userId}`,
        `Player: ${targetId}`,
        `Amount: ${formatMoney(amountMinor, currency)}`,
        `Fair ID: <code>${result.fairId}</code>`,
        `New balance: ${formatMoney(result.balanceMinor, currency)}`,
      ].join("\n"),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      await bot.sendMessage(chatId, "Debit rejected because the player balance is too low.");
    } else {
      throw error;
    }
  }
  return true;
}

async function beginDeposit(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  if (!isPrivateChat({ id: chatId, type: "private" })) return;
  pendingDeposits.set(player.telegramUserId, { stage: "amount" });
  await bot.sendMessage(
    chatId,
    [
      "<b>💳 Deposit</b>",
      "",
      "Enter the amount followed by the currency.",
      "Examples: <code>500 INR</code> or <code>10 USD</code>",
      "INR: ₹50.00–₹5,000.00",
      "USD: $0.50–$50.00",
    ].join("\n"),
  );
}

async function beginWithdrawal(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  pendingWithdrawals.set(player.telegramUserId, { stage: "amount" });
  await bot.sendMessage(
    chatId,
    [
      "<b>💸 Withdrawal</b>",
      "",
      "Enter the amount followed by the currency.",
      "Example: <code>1000 INR</code>",
      "The available balance, minimum amount, and wagering requirement will be checked before confirmation.",
    ].join("\n"),
  );
}

async function showDepositNetworks(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
  amountMinor: number,
  currency: Currency,
): Promise<void> {
  const request = await createDepositRequest(player.id, amountMinor, currency);
  const networks = DEPOSIT_NETWORKS.filter((network) =>
    networkSupportsCurrency(network, currency),
  );
  pendingDeposits.set(player.telegramUserId, {
    stage: "network",
    amountMinor,
    currency,
    requestId: request.id,
  });
  await bot.sendMessage(
    chatId,
    [
      `<b>Deposit ${formatMoney(amountMinor, currency)}</b>`,
      "",
      "Choose your payment network:",
      currency === "INR"
        ? "UPI is available for INR."
        : "BTC, BSC, Solana, and Ethereum are available for USD/USDT.",
    ].join("\n"),
    {
      inline_keyboard: [
        ...networks.map((network) => [{
          text: networkLabel(network),
          callback_data: ownedCallback(
            `deposit:network:${request.id}:${network}`,
            player.telegramUserId,
          ),
        }]),
        [{
          text: "Cancel",
          callback_data: ownedCallback(
            `deposit:cancel:${request.id}`,
            player.telegramUserId,
          ),
        }],
      ],
    },
  );
}

async function selectDepositNetwork(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  requestId: number,
  network: DepositNetwork,
): Promise<void> {
  const pending = pendingDeposits.get(user.id);
  const player = await ensurePlayer(user);
  const [request] = await db
    .select()
    .from(casinoCashRequestsTable)
    .where(
      and(
        eq(casinoCashRequestsTable.id, requestId),
        eq(casinoCashRequestsTable.playerId, player.id),
        eq(casinoCashRequestsTable.requestType, "deposit"),
        eq(casinoCashRequestsTable.status, "created"),
      ),
    )
    .limit(1);
  if (!pending || pending.requestId !== requestId || !request || !pending.currency || !pending.amountMinor) {
    await bot.sendMessage(chatId, "That deposit session has expired. Please send /deposit again.");
    return;
  }
  const currency = pending.currency;
  const address = paymentAddress(network);
  if (!networkSupportsCurrency(network, currency) || !address) {
    await bot.sendMessage(chatId, "That payment network is not available for this currency.");
    return;
  }
  await db
    .update(casinoCashRequestsTable)
    .set({
      status: "awaiting_payment",
      note: noteForCashRequest({
        kind: "deposit",
        stage: "paid",
        network,
        paymentAddress: address,
      }),
    })
    .where(
      and(
        eq(casinoCashRequestsTable.id, requestId),
        eq(casinoCashRequestsTable.playerId, player.id),
        eq(casinoCashRequestsTable.status, "created"),
      ),
    );
  pendingDeposits.set(user.id, {
    ...pending,
    stage: "paid",
    network,
    address,
  });
  await bot.sendMessage(
    chatId,
    [
      "<b>Payment details</b>",
      "",
      `Currency: <b>${currency}</b>`,
      `Exact amount: <b>${formatMoney(pending.amountMinor, currency)}</b>`,
      `Network: <b>${networkLabel(network)}</b>`,
      `Payment address: <code>${address}</code>`,
      "",
      "Send the exact amount, then tap the button below.",
    ].join("\n"),
    {
      inline_keyboard: [[
        {
          text: "I have paid",
          callback_data: ownedCallback(
            `deposit:paid:${requestId}`,
            user.id,
          ),
        },
      ], [
        {
          text: "Cancel",
          callback_data: ownedCallback(
            `deposit:cancel:${requestId}`,
            user.id,
          ),
        },
      ]],
    },
  );
}

async function askForDepositProof(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  requestId: number,
): Promise<void> {
  const pending = pendingDeposits.get(userId);
  if (!pending || pending.requestId !== requestId || !pending.network) {
    await bot.sendMessage(chatId, "That deposit session has expired. Please send /deposit again.");
    return;
  }
  pendingDeposits.set(userId, { ...pending, stage: "utr" });
  await bot.sendMessage(
    chatId,
    pending.network === "upi"
      ? "<b>Step 1/2 — UTR</b>\n\nSend your exactly 12-digit UPI UTR."
      : "<b>Step 1/2 — Transaction ID</b>\n\nSend your crypto transaction ID. It must contain at least 60 characters.",
  );
}

async function handleDepositUtr(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  value: string,
): Promise<void> {
  const pending = pendingDeposits.get(userId);
  if (!pending || pending.stage !== "utr" || !pending.requestId || !pending.network) return;
  if (!proofIsValid(pending.network, value)) {
    await bot.sendMessage(
      chatId,
      pending.network === "upi"
        ? "UPI UTR must contain exactly 12 digits."
        : "Transaction ID must be at least 60 characters and contain only letters, numbers, dots, underscores, colons, or hyphens.",
    );
    return;
  }
  const [player] = await db
    .select({ id: casinoPlayersTable.id })
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.telegramUserId, userId))
    .limit(1);
  const [request] = await db
    .select()
    .from(casinoCashRequestsTable)
    .where(
      and(
        eq(casinoCashRequestsTable.id, pending.requestId),
        eq(casinoCashRequestsTable.playerId, player?.id ?? -1),
        eq(casinoCashRequestsTable.status, "awaiting_payment"),
      ),
    )
    .limit(1);
  if (!request) {
    await bot.sendMessage(chatId, "That deposit request has expired or belongs to another player.");
    pendingDeposits.delete(userId);
    return;
  }
  const activeProofRequests = await db
    .select({ note: casinoCashRequestsTable.note })
    .from(casinoCashRequestsTable)
    .where(
      and(
        eq(casinoCashRequestsTable.requestType, "deposit"),
        inArray(casinoCashRequestsTable.status, ["awaiting_proof", "submitted", "completed"]),
      ),
    );
  if (
    activeProofRequests.some(
      (candidate) => cashRequestNote(candidate.note).utr === value.trim(),
    )
  ) {
    await bot.sendMessage(
      chatId,
      "That UTR or transaction ID has already been submitted. Send the payment ID for this deposit only.",
    );
    return;
  }
  const [updated] = await db
    .update(casinoCashRequestsTable)
    .set({
      status: "awaiting_proof",
      note: noteForCashRequest({
        kind: "deposit",
        stage: "screenshot",
        network: pending.network,
        paymentAddress: pending.address,
        utr: value.trim(),
      }),
    })
    .where(
      and(
        eq(casinoCashRequestsTable.id, request.id),
        eq(casinoCashRequestsTable.playerId, request.playerId),
        eq(casinoCashRequestsTable.status, "awaiting_payment"),
      ),
    )
    .returning({ id: casinoCashRequestsTable.id });
  if (!updated) {
    await bot.sendMessage(chatId, "That deposit request was already submitted.");
    pendingDeposits.delete(userId);
    return;
  }
  pendingDeposits.set(userId, { ...pending, stage: "screenshot", utr: value.trim() });
  await bot.sendMessage(
    chatId,
    [
      "✅ <b>UTR submitted successfully</b>",
      `Amount: <b>${formatMoney(pending.amountMinor ?? 0, pending.currency ?? "USD")}</b>`,
      `UTR / transaction ID: <code>${escapeTelegramText(value.trim())}</code>`,
      "",
      "<b>Step 2/2 — Payment screenshot</b>",
      "",
      "Now send the screenshot of your payment. Your balance will not be credited until an administrator approves it.",
    ].join("\n"),
  );
  const [storedRequest] = await db
    .select()
    .from(casinoCashRequestsTable)
    .where(eq(casinoCashRequestsTable.id, request.id))
    .limit(1);
  if (storedRequest) {
    await auditTransaction(
      bot,
      [
        "Type: deposit proof",
        `Request: #${request.id}`,
        `Player: ${userId}`,
        `Amount: ${formatMoney(storedRequest.amountMinor, parseCurrency(storedRequest.currency, "USD"))}`,
        `Network: ${networkLabel(pending.network)}`,
        `Fair ID: <code>${storedRequest.fairId ?? "pending"}</code>`,
        "Status: UTR received; screenshot pending",
      ].join("\n"),
    );
  }
}

async function handleDepositScreenshot(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  fileId: string,
): Promise<void> {
  const pending = pendingDeposits.get(user.id);
  if (!pending || pending.stage !== "screenshot" || !pending.requestId || !pending.network) return;
  const [request] = await db
    .select()
    .from(casinoCashRequestsTable)
    .where(
      and(
        eq(casinoCashRequestsTable.id, pending.requestId),
        eq(casinoCashRequestsTable.playerId, (await ensurePlayer(user)).id),
        eq(casinoCashRequestsTable.status, "awaiting_proof"),
      ),
    )
    .limit(1);
  if (!request) {
    await bot.sendMessage(chatId, "That deposit request has expired or was already submitted.");
    pendingDeposits.delete(user.id);
    return;
  }
  const note = noteForCashRequest({
    kind: "deposit",
    stage: "submitted",
    network: pending.network,
    paymentAddress: pending.address,
    utr: pending.utr,
    proofFileId: fileId,
  });
  await db
    .update(casinoCashRequestsTable)
    .set({ status: "submitted", note })
    .where(
      and(
        eq(casinoCashRequestsTable.id, request.id),
        eq(casinoCashRequestsTable.status, "awaiting_proof"),
      ),
    );
  pendingDeposits.delete(user.id);
  const reviewMarkup = {
    inline_keyboard: [[
      { text: "Approve deposit", callback_data: `cash:approve:deposit:${request.id}` },
      { text: "Reject deposit", callback_data: `cash:reject:deposit:${request.id}` },
    ]],
  };
  const currency = parseCurrency(request.currency, "USD");
  const reviewText = [
    "<b>🔔 New deposit proof</b>",
    `Request: #${request.id}`,
    `Player: ${user.id}`,
    `Amount: ${formatMoney(request.amountMinor, currency)}`,
    `Network: ${networkLabel(pending.network)}`,
    `UTR / transaction ID: <code>${pending.utr ?? "attached"}</code>`,
    "Approve only after verifying the payment.",
  ].join("\n");
  for (const adminId of adminTelegramIds()) {
    try {
      await bot.sendPhotoFileId(adminId, fileId, reviewText, reviewMarkup);
    } catch (error) {
      logger.warn({ err: error, adminId, requestId: request.id }, "Deposit review notification failed");
    }
  }
  await bot.sendMessage(
    chatId,
    [
      "✅ <b>Deposit proof submitted successfully.</b>",
      "Your deposit is under review.",
      `Request: #${request.id}`,
      "You will be notified after administrator approval.",
    ].join("\n"),
  );
  await auditTransaction(
    bot,
    [
      "Type: deposit submitted",
      `Request: #${request.id}`,
      `Player: ${user.id}`,
      `Amount: ${formatMoney(request.amountMinor, currency)}`,
      `Network: ${networkLabel(pending.network)}`,
      `Fair ID: <code>${request.fairId ?? "pending"}</code>`,
      "Status: awaiting administrator review",
    ].join("\n"),
  );
}

async function showWithdrawalNetworks(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  currency: Currency,
): Promise<void> {
  const networks = DEPOSIT_NETWORKS.filter((network) =>
    networkSupportsCurrency(network, currency),
  );
  pendingWithdrawals.set(userId, {
    ...(pendingWithdrawals.get(userId) ?? {}),
    stage: "network",
    currency,
  });
  await bot.sendMessage(
    chatId,
    [
      "<b>Choose your payout network</b>",
      "",
      currency === "INR"
        ? "UPI is available for INR withdrawals."
        : "BTC, BSC, Solana, and Ethereum are available for USD withdrawals.",
    ].join("\n"),
    {
      inline_keyboard: [
        ...networks.map((network) => [{
          text: networkLabel(network),
          callback_data: ownedCallback(
            `withdraw:network:${userId}:${network}`,
            userId,
          ),
        }]),
        [{ text: "Cancel", callback_data: ownedCallback("withdraw:cancel", userId) }],
      ],
    },
  );
}

async function showWithdrawalSummary(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  playerId: number,
  amountMinor: number,
  currency: Currency,
  network: DepositNetwork,
  address: string,
): Promise<void> {
  const feeMinor = withdrawalFeeMinor(amountMinor);
  const token = randomUUID();
  withdrawalConfirmations.set(token, {
    userId,
    playerId,
    amountMinor,
    feeMinor,
    currency,
    network,
    address,
  });
  await bot.sendMessage(
    chatId,
    [
      "<b>Confirm withdrawal</b>",
      "",
      `Currency: <b>${currency}</b>`,
      `Requested amount: <b>${formatMoney(amountMinor, currency)}</b>`,
      `Withdrawal fee: ${formatMoney(feeMinor, currency)} — 4%`,
      `You will receive: <b>${formatMoney(amountMinor - feeMinor, currency)}</b>`,
      `Network: ${networkLabel(network)}`,
      `Destination: <code>${maskedDestination(address)}</code>`,
      "",
      "No balance is changed until you press Confirm.",
    ].join("\n"),
    {
      inline_keyboard: [[
        {
          text: "Confirm",
          callback_data: ownedCallback(`withdraw:confirm:${token}`, userId),
        },
        {
          text: "Cancel",
          callback_data: ownedCallback(`withdraw:cancel:${token}`, userId),
        },
      ]],
    },
  );
}

async function handleWithdrawalAmount(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
  value: string,
): Promise<void> {
  const parsed = parseAmountAndCurrency(value, parseCurrency(player.preferredCurrency, "USD"));
  if (!parsed.amountMinor || !isSupportedCurrency(parsed.currency)) {
    await bot.sendMessage(
      chatId,
      [
        "❌ Enter one exact withdrawal amount.",
        "A range such as <code>100-200</code> is not a valid amount.",
        "Example: <code>1000 INR</code> or <code>10 USD</code>.",
      ].join("\n"),
      {
        inline_keyboard: [[
          { text: "Cancel withdrawal", callback_data: ownedCallback("withdraw:cancel", player.telegramUserId) },
        ]],
      },
    );
    return;
  }
  const { amountMinor, currency } = parsed;
  if (amountMinor < MIN_WITHDRAWAL_MINOR[currency]) {
    await bot.sendMessage(chatId, `Minimum withdrawal is ${formatMoney(MIN_WITHDRAWAL_MINOR[currency], currency)}.`);
    return;
  }
  const wallet = await ensureWallet(player.id, currency);
  const remaining = await wagerRemaining(player.id, currency);
  if (remaining > 0) {
    await bot.sendMessage(
      chatId,
      `Withdrawal unavailable. Complete ${formatMoney(remaining, currency)} of wagering first. Use /wagerstatus to track it.`,
    );
    return;
  }
  if (wallet.balanceMinor < amountMinor) {
    await bot.sendMessage(
      chatId,
      `Insufficient ${currency} balance. Available: ${formatMoney(wallet.balanceMinor, currency)}.`,
    );
    return;
  }
  pendingWithdrawals.set(player.telegramUserId, { stage: "address", amountMinor, currency });
  const savedNetwork = player.payoutWalletType as DepositNetwork | null;
  if (
    player.payoutWallet &&
    savedNetwork &&
    DEPOSIT_NETWORKS.includes(savedNetwork) &&
    networkSupportsCurrency(savedNetwork, currency) &&
    payoutAddressIsValid(savedNetwork, player.payoutWallet)
  ) {
    await showWithdrawalSummary(
      bot,
      chatId,
      player.telegramUserId,
      player.id,
      amountMinor,
      currency,
      savedNetwork,
      player.payoutWallet,
    );
    return;
  }
  await showWithdrawalNetworks(bot, chatId, player.telegramUserId, currency);
}

async function handleWithdrawalAddress(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  playerId: number,
  value: string,
): Promise<void> {
  const pending = pendingWithdrawals.get(userId);
  if (!pending || pending.stage !== "address" || !pending.amountMinor || !pending.currency || !pending.network) return;
  if (!payoutAddressIsValid(pending.network, value)) {
    await bot.sendMessage(chatId, `That ${networkLabel(pending.network)} payout destination is invalid. Send the complete value without spaces.`);
    return;
  }
  const address = value.trim();
  await savePayoutDestination(playerId, pending.network, address);
  pendingWithdrawals.delete(userId);
  await showWithdrawalSummary(
    bot,
    chatId,
    userId,
    playerId,
    pending.amountMinor,
    pending.currency,
    pending.network,
    address,
  );
}

async function selectWithdrawalNetwork(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  network: DepositNetwork,
): Promise<void> {
  const pending = pendingWithdrawals.get(userId);
  if (!pending || pending.stage !== "network" || !pending.amountMinor || !pending.currency) {
    await bot.sendMessage(chatId, "That withdrawal session has expired. Please send /withdraw again.");
    return;
  }
  if (!networkSupportsCurrency(network, pending.currency)) {
    await bot.sendMessage(chatId, "That payout network is not available for this currency.");
    return;
  }
  pendingWithdrawals.set(userId, { ...pending, stage: "address", network });
  await bot.sendMessage(
    chatId,
    [
      `<b>${networkLabel(network)} payout destination</b>`,
      "",
      network === "upi"
        ? "Send your UPI ID, for example <code>name@bank</code>."
        : `Send your complete ${networkLabel(network)} address without spaces.`,
    ].join("\n"),
  );
}

async function beginWalletSetup(
  bot: TelegramBot,
  chatId: number,
  userId: number,
): Promise<void> {
  pendingWalletSetups.delete(userId);
  await bot.sendMessage(
    chatId,
    "<b>👨‍💻 Save Your Wallet</b>\n\nChoose the payout wallet type:",
    {
      inline_keyboard: [[
        {
          text: "UPI (INR)",
          callback_data: ownedCallback(`wallet:select:${userId}:upi`, userId),
        },
        {
          text: "Crypto",
          callback_data: ownedCallback(`wallet:crypto:${userId}`, userId),
        },
      ]],
    },
  );
}

async function selectWalletSetupNetwork(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  network: DepositNetwork,
): Promise<void> {
  if (network === "upi" || network === "btc" || network === "bsc" || network === "solana" || network === "ethereum") {
    pendingWalletSetups.set(userId, network);
    await bot.sendMessage(
      chatId,
      `<b>Save ${networkLabel(network)}</b>\n\nSend your complete payout destination without spaces.`,
    );
  }
}

async function handleWalletSetupAddress(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  playerId: number,
  value: string,
): Promise<void> {
  const network = pendingWalletSetups.get(userId);
  if (!network) return;
  if (!payoutAddressIsValid(network, value)) {
    await bot.sendMessage(
      chatId,
      `That ${networkLabel(network)} destination is invalid. Send the complete value without spaces.`,
    );
    return;
  }
  const address = value.trim();
  await savePayoutDestination(playerId, network, address);
  pendingWalletSetups.delete(userId);
  await bot.sendMessage(
    chatId,
    `<b>✅ Wallet saved</b>\n\nNetwork: <b>${networkLabel(network)}</b>\nDestination: <code>${maskedDestination(address)}</code>\n\nThis destination will be reused for future withdrawals.`,
  );
}

async function confirmWithdrawal(
  bot: TelegramBot,
  chatId: number,
  callback: TelegramCallbackQuery,
  token: string,
): Promise<void> {
  const pending = withdrawalConfirmations.get(token);
  if (!pending || pending.userId !== callback.from.id) {
    await bot.sendMessage(chatId, "That withdrawal confirmation is invalid or expired.");
    return;
  }
  withdrawalConfirmations.delete(token);
  try {
    const result = await submitWithdrawalRequest(pending);
    await bot.sendMessage(
      chatId,
      [
        "✅ <b>Withdrawal request submitted</b>",
        `Request: #${result.requestId}`,
        `Requested: ${formatMoney(pending.amountMinor, pending.currency)}`,
        `Fee: ${formatMoney(pending.feeMinor, pending.currency)} (4%)`,
        `Net payout: ${formatMoney(pending.amountMinor - pending.feeMinor, pending.currency)}`,
        `Fair ID: <code>${result.fairId}</code>`,
        `Destination: <code>${maskedDestination(pending.address)}</code>`,
        "Admins will review and process the net payout.",
      ].join("\n"),
    );
    await notifyAdmins(
      bot,
      [
        "<b>🔔 New withdrawal request</b>",
        `Request: #${result.requestId}`,
        `Player: ${callback.from.id}`,
        `Requested: ${formatMoney(pending.amountMinor, pending.currency)}`,
        `Fee: ${formatMoney(pending.feeMinor, pending.currency)} (4%)`,
        `Net payout: ${formatMoney(pending.amountMinor - pending.feeMinor, pending.currency)}`,
        `Fair ID: <code>${result.fairId}</code>`,
        `Network: ${networkLabel(pending.network)}`,
        `Destination: <code>${pending.address}</code>`,
      ].join("\n"),
      {
        inline_keyboard: [[
          { text: "Approve withdrawal", callback_data: `cash:approve:withdrawal:${result.requestId}` },
          { text: "Reject withdrawal", callback_data: `cash:reject:withdrawal:${result.requestId}` },
        ]],
      },
    );
    await auditTransaction(
      bot,
      [
        "Type: withdrawal submitted",
        `Request: #${result.requestId}`,
        `Player: ${callback.from.id}`,
        `Requested: ${formatMoney(pending.amountMinor, pending.currency)}`,
        `Fee: ${formatMoney(pending.feeMinor, pending.currency)} (4%)`,
        `Net payout: ${formatMoney(pending.amountMinor - pending.feeMinor, pending.currency)}`,
        `Network: ${networkLabel(pending.network)}`,
        `Fair ID: <code>${result.fairId}</code>`,
        "Status: pending administrator review",
      ].join("\n"),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      await bot.sendMessage(chatId, "Withdrawal rejected because your balance changed. No amount was held.");
      return;
    }
    throw error;
  }
}

async function handleCashCallback(
  bot: TelegramBot,
  chatId: number,
  callback: TelegramCallbackQuery,
  action: string,
): Promise<void> {
  const [, operation, kind, rawId] = action.split(":");
  const requestId = Number(rawId);
  if (!Number.isSafeInteger(requestId)) return;
  let result: string;
  if (kind === "deposit") {
    result = operation === "approve"
      ? await approveCashRequest(bot, requestId, callback.from.id)
      : await rejectCashRequest(bot, requestId, callback.from.id);
  } else {
    result = operation === "approve"
      ? await approveWithdrawal(bot, requestId, callback.from.id)
      : await rejectWithdrawal(bot, requestId, callback.from.id);
  }
  await bot.sendMessage(
    chatId,
    result === "unavailable"
      ? "This request is unavailable, already processed, or you are not an administrator."
      : `Request #${requestId} ${result}.`,
  );
}

async function handlePrivateConversation(
  bot: TelegramBot,
  message: TelegramMessage,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<boolean> {
  if (!isPrivateChat(message.chat) || !message.from) return false;
  const userId = message.from.id;
  const deposit = pendingDeposits.get(userId);
  if (message.photo?.length && deposit?.stage === "screenshot") {
    await handleDepositScreenshot(bot, message.chat.id, message.from, message.photo.at(-1)?.file_id ?? "");
    return true;
  }
  if (!message.text) {
    if (deposit?.stage === "screenshot") {
      await bot.sendMessage(message.chat.id, "Please send the payment screenshot as a photo.");
      return true;
    }
    return false;
  }
  if (deposit?.stage === "amount") {
    const parsed = parseAmountAndCurrency(message.text, parseCurrency(player.preferredCurrency, "USD"));
    if (!parsed.amountMinor || !depositAmountIsValid(parsed.amountMinor, parsed.currency)) {
      await bot.sendMessage(message.chat.id, depositLimitText(parsed.currency));
      return true;
    }
    await showDepositNetworks(bot, message.chat.id, player, parsed.amountMinor, parsed.currency);
    return true;
  }
  if (deposit?.stage === "utr") {
    await handleDepositUtr(bot, message.chat.id, userId, message.text);
    return true;
  }
  if (deposit?.stage === "screenshot") {
    await bot.sendMessage(message.chat.id, "Please send the payment screenshot as a photo.");
    return true;
  }
  const withdrawal = pendingWithdrawals.get(userId);
  if (withdrawal?.stage === "amount") {
    await handleWithdrawalAmount(bot, message.chat.id, player, message.text);
    return true;
  }
  if (withdrawal?.stage === "address") {
    await handleWithdrawalAddress(bot, message.chat.id, userId, player.id, message.text);
    return true;
  }
  if (pendingWalletSetups.has(userId)) {
    await handleWalletSetupAddress(bot, message.chat.id, userId, player.id, message.text);
    return true;
  }
  return false;
}

async function handleMainUpdate(
  bot: TelegramBot,
  update: TelegramUpdate,
  helperLinks: Map<string, string>,
  helperBots: Map<string, TelegramBot>,
): Promise<void> {
  if (update.callback_query) {
    await bot.answerCallback(update.callback_query.id);
    const callback = update.callback_query;
    const chatId = callback.message?.chat.id;
    if (!chatId) return;
    if (!casinoPowerOn && !isAdmin(callback.from.id)) {
      await bot.sendMessage(chatId, MAINTENANCE_MESSAGE);
      return;
    }
    const player = await ensurePlayer(callback.from);
    const rawAction = callback.data ?? "";
    const action = resolveCallbackOwner(rawAction, callback.from.id);
    if (action === null) {
      await bot.sendMessage(chatId, "This button belongs to another player.");
      return;
    }
    if (action.startsWith("cash:")) {
      await handleCashCallback(bot, chatId, callback, action);
    } else if (action.startsWith("deposit:network:")) {
      const [, , rawRequestId, rawNetwork] = action.split(":");
      if (DEPOSIT_NETWORKS.includes(rawNetwork as DepositNetwork)) {
        await selectDepositNetwork(
          bot,
          chatId,
          callback.from,
          Number(rawRequestId),
          rawNetwork as DepositNetwork,
        );
      }
    } else if (action.startsWith("deposit:paid:")) {
      await askForDepositProof(bot, chatId, callback.from.id, Number(action.split(":")[2]));
    } else if (action.startsWith("deposit:cancel:")) {
      const requestId = Number(action.split(":")[2]);
      pendingDeposits.delete(callback.from.id);
      if (Number.isSafeInteger(requestId)) {
        await db
          .update(casinoCashRequestsTable)
          .set({ status: "cancelled", reviewedAt: new Date() })
          .where(
            and(
              eq(casinoCashRequestsTable.id, requestId),
              eq(casinoCashRequestsTable.playerId, player.id),
              inArray(casinoCashRequestsTable.status, ["created", "awaiting_payment", "awaiting_proof"]),
            ),
          );
      }
      await bot.sendMessage(chatId, "Deposit cancelled. No balance was changed.");
    } else if (action.startsWith("withdraw:network:")) {
      const [, , rawUserId, rawNetwork] = action.split(":");
      if (Number(rawUserId) === callback.from.id && DEPOSIT_NETWORKS.includes(rawNetwork as DepositNetwork)) {
        await selectWithdrawalNetwork(bot, chatId, callback.from.id, rawNetwork as DepositNetwork);
      }
    } else if (action.startsWith("wallet:crypto:")) {
      const userId = Number(action.split(":")[2]);
      if (userId === callback.from.id) {
        await bot.sendMessage(
          chatId,
          "<b>Choose your crypto payout network</b>",
          {
            inline_keyboard: [
              [{
                text: "BTC",
                callback_data: ownedCallback(`wallet:select:${userId}:btc`, userId),
              }],
              [{
                text: "BSC (BEP20)",
                callback_data: ownedCallback(`wallet:select:${userId}:bsc`, userId),
              }],
              [{
                text: "Solana",
                callback_data: ownedCallback(`wallet:select:${userId}:solana`, userId),
              }],
              [{
                text: "Ethereum",
                callback_data: ownedCallback(`wallet:select:${userId}:ethereum`, userId),
              }],
            ],
          },
        );
      }
    } else if (action.startsWith("wallet:select:")) {
      const [, , rawUserId, rawNetwork] = action.split(":");
      const userId = Number(rawUserId);
      if (userId === callback.from.id && DEPOSIT_NETWORKS.includes(rawNetwork as DepositNetwork)) {
        await selectWalletSetupNetwork(bot, chatId, userId, rawNetwork as DepositNetwork);
      }
    } else if (action === "withdraw:cancel") {
      pendingWithdrawals.delete(callback.from.id);
      await bot.sendMessage(chatId, "Withdrawal cancelled. No balance was changed.");
    } else if (action.startsWith("withdraw:confirm:")) {
      await confirmWithdrawal(bot, chatId, callback, action.split(":")[2] ?? "");
    } else if (action.startsWith("withdraw:cancel:")) {
      withdrawalConfirmations.delete(action.split(":")[2] ?? "");
      pendingWithdrawals.delete(callback.from.id);
      await bot.sendMessage(chatId, "Withdrawal cancelled. No balance was changed.");
    } else if (action === "main:deposit") {
      if (isPrivateChat(callback.message?.chat ?? { id: chatId, type: "private" })) {
        await beginDeposit(bot, chatId, player);
      } else {
        await bot.sendMessage(chatId, "Deposits are available only in private chat.", privateOnlyKeyboard(bot, "deposit"));
      }
    } else if (action === "main:withdraw") {
      if (isPrivateChat(callback.message?.chat ?? { id: chatId, type: "private" })) {
        await beginWithdrawal(bot, chatId, player);
      } else {
        await bot.sendMessage(chatId, "Withdrawals are available only in private chat.", privateOnlyKeyboard(bot, "withdraw"));
      }
    } else if (action === "main:currency") {
      await bot.sendMessage(
        chatId,
        `<b>🔄 Display Currency — ${parseCurrency(player.preferredCurrency, "USD")}</b>\n\nChoose the currency shown for your wallet and new bets.`,
        currencyKeyboard(
          parseCurrency(player.preferredCurrency, "USD"),
          player.telegramUserId,
        ),
      );
    } else if (action === "main:support") {
      await sendSupport(bot, chatId);
    } else if (action.startsWith("currency:set:")) {
      const currency = parseCurrency(action.split(":")[2], "USD");
      await changePlayerCurrency(player.id, currency);
      await bot.sendMessage(
        chatId,
        `<b>✅ Currency updated</b>\n\nDisplay currency: <b>${currency}</b>\n\n${await balanceText(player.id, currency)}`,
        currencyKeyboard(currency, player.telegramUserId),
      );
    } else if (action.startsWith("tip:")) {
      await handleTipCallback(bot, chatId, player, action);
    } else if (action.startsWith("escrow:")) {
      await handleEscrowCallback(bot, chatId, player, action);
    } else if (action.startsWith("battle:pvb:play:")) {
      const battleId = Number(action.split(":")[3]);
      if (Number.isInteger(battleId)) {
        await confirmPvbBattle(bot, chatId, callback.from, battleId);
      }
    } else if (action.startsWith("battle:pvb:cancel:")) {
      const battleId = Number(action.split(":")[3]);
      if (Number.isInteger(battleId)) {
        await cancelPvbBattle(bot, chatId, callback.from, battleId);
      }
    } else if (action.startsWith("battle:rematch:")) {
      const [, , rawBattleId, multiplier] = action.split(":");
      const battleId = Number(rawBattleId);
      if (
        Number.isInteger(battleId) &&
        (multiplier === "again" || multiplier === "double")
      ) {
        await createPvbRematch(
          bot,
          chatId,
          callback.from,
          battleId,
          multiplier,
        );
      }
    } else if (action.startsWith("battle:join:")) {
      if (!callback.message || !isOfficialGameChat(callback.message.chat)) {
        await bot.sendMessage(chatId, "Battles can only be joined in the official RolexCasino group.");
        return;
      }
      const battleId = Number(action.split(":")[2]);
      if (Number.isInteger(battleId)) {
        await joinBattle(bot, helperBots, chatId, callback.from, battleId);
      }
    } else if (action.startsWith("battle:decline:")) {
      if (!callback.message || !isOfficialGameChat(callback.message.chat)) {
        await bot.sendMessage(chatId, "Battles can only be declined in the official RolexCasino group.");
        return;
      }
      const battleId = Number(action.split(":")[2]);
      if (Number.isInteger(battleId)) {
        await declineBattle(bot, chatId, callback.from, battleId);
      }
    } else if (action.startsWith("jackpot:join:")) {
      if (!callback.message || !isOfficialGameChat(callback.message.chat)) {
        await bot.sendMessage(chatId, "Jackpot entries are available only in the official RolexCasino group.");
        return;
      }
      const currency = parseCurrency(action.split(":")[2], "INR");
      await joinJackpot(bot, chatId, callback.from, currency);
    } else if (action === "jackpot:how") {
      await bot.sendMessage(
        chatId,
        "Join INR or USD once per day. After joining, 0.5% of each eligible bet is added to that currency's pool. The pool is drawn automatically at 23:59 Asia/Calcutta and resets for the next day.",
      );
    } else if (action === "main:balance") {
      await bot.sendMessage(
        chatId,
        `Your RolexCasino balances\n\n${await balanceText(player.id, parseCurrency(player.preferredCurrency, "USD"))}`,
      );
    } else if (action === "main:profile") {
      await sendProfile(bot, chatId, player);
    } else if (action === "main:games") {
       await sendGames(bot, chatId, helperLinks, player.telegramUserId);
    } else if (action === "main:history") {
      await sendHistory(bot, chatId, player.id);
    } else if (action.startsWith("coin:choose:")) {
      const [, , rawBattleId, rawSide] = action.split(":");
      const battleId = Number(rawBattleId);
      if (
        Number.isInteger(battleId) &&
        (rawSide === "HEADS" || rawSide === "TAILS")
      ) {
        await handleCoinChoice(
          bot,
          chatId,
          callback.from,
          battleId,
          rawSide,
        );
      }
    }
    return;
  }

  const message = update.message;
  if (!message?.from) return;
  const chatId = message.chat.id;
  if (message.dice) {
    if (!casinoPowerOn && !isAdmin(message.from.id)) {
      await bot.sendMessage(chatId, MAINTENANCE_MESSAGE);
      return;
    }
    const player = await ensurePlayer(message.from);
    if (await handlePlayerPvpRoll(bot, message, player)) return;
    await handlePlayerPvbRoll(bot, message, player, helperBots);
    return;
  }
  if (
    message.photo ||
    (message.text && !message.text.trim().startsWith("/"))
  ) {
    const player = await ensurePlayer(message.from);
    if (await handlePrivateConversation(bot, message, player)) return;
  }
  if (!message.text) return;
  if (!message.text.trim().startsWith("/")) return;
  const { command, args } = commandFrom(message.text);

  if (command === "power") {
    await handlePowerCommand(bot, chatId, message.from.id, args);
    return;
  }
  if (!casinoPowerOn && !isAdmin(message.from.id)) {
    await bot.sendMessage(chatId, MAINTENANCE_MESSAGE);
    return;
  }
  const player = await ensurePlayer(message.from);
  if (await handleAdminCommand(bot, chatId, message.from.id, command, args, message)) return;
  const isGameplayCommand =
    Boolean(battleGameMap[command]) ||
    command === "coin" ||
    command === "7up" ||
    command === "dr" ||
    command === "jackpot";
  if (isGameplayCommand && !isOfficialGameChat(message.chat)) {
    await bot.sendMessage(
      chatId,
        "Games are available only in the official RolexCasino group.",
        officialGroupKeyboard(),
    );
    return;
  }
    if (command === "start") {
    const referralArg = args[0]?.startsWith("ref_") ? args[0].slice(4) : null;
    if (referralArg && player.referredByPlayerId == null) {
      const [referrer] = await db
        .select()
        .from(casinoPlayersTable)
        .where(eq(casinoPlayersTable.referralCode, referralArg))
        .limit(1);
      if (referrer && referrer.id !== player.id) {
        const rewarded = await rewardSuccessfulReferral(referrer, player.id);
        if (rewarded) {
          await bot.sendMessage(
            chatId,
            "✅ Verified referral! The referrer received ₹5.00 + $0.50.",
          );
          await auditTransaction(
            bot,
            [
              "Type: verified referral",
              `Referrer: ${referrer.telegramUserId}`,
              `Referred player: ${player.telegramUserId}`,
              "Bonus: ₹5.00 + $0.50",
            ].join("\n"),
          );
        }
      }
    }
    await sendMainWelcome(
      bot,
      chatId,
      helperLinks,
      player.displayName,
      isPrivateChat(message.chat),
      player.telegramUserId,
    );
      if (isPrivateChat(message.chat) && args[0] === "deposit") {
        await beginDeposit(bot, chatId, player);
      } else if (isPrivateChat(message.chat) && args[0] === "withdraw") {
        await beginWithdrawal(bot, chatId, player);
      }
  } else if (command === "help" || command === "support") {
    await sendMainHelp(bot, chatId, player.telegramUserId);
    if (command === "support") await sendSupport(bot, chatId);
  } else if (command === "balance" || command === "wallet" || command === "bal" || command === "wal") {
    const currency = parseCurrency(args[0], parseCurrency(player.preferredCurrency, "USD"));
    await sendWallet(bot, chatId, { ...player, preferredCurrency: currency });
  } else if (command === "profile") {
    await sendProfile(bot, chatId, player);
  } else if (command === "currency" || command === "changecurrency") {
    const currency = args[0]?.toUpperCase();
    if (!currency || !isSupportedCurrency(currency)) {
      await bot.sendMessage(
        chatId,
        `<b>🔄 Display Currency — ${parseCurrency(player.preferredCurrency, "USD")}</b>\n\nChoose your wallet display currency.`,
          currencyKeyboard(
            parseCurrency(player.preferredCurrency, "USD"),
            player.telegramUserId,
          ),
      );
    } else {
      await changePlayerCurrency(player.id, currency);
      await bot.sendMessage(
        chatId,
        `<b>✅ Currency updated</b>\n\nDisplay currency: <b>${currency}</b>\n\n${await balanceText(player.id, currency)}`,
          currencyKeyboard(currency, player.telegramUserId),
      );
    }
  } else if (command === "setwallet" && args.length === 0) {
    await beginWalletSetup(bot, chatId, message.from.id);
  } else if (command === "setwallet" || command === "saveupi") {
    const value = command === "saveupi" ? args[0] : args.join("");
    if (!value) {
      await bot.sendMessage(chatId, "Usage: /setwallet UPI_ID_OR_CRYPTO_ADDRESS");
    } else {
      try {
        const walletType = await savePayoutWallet(player.id, value);
        await bot.sendMessage(chatId, `Payout ${walletType} saved. It is masked in your profile until withdrawals are enabled.`);
      } catch {
        await bot.sendMessage(chatId, "That payout address is invalid. Use one value without spaces.");
      }
    }
  } else if (command === "refer" || command === "referral" || command === "referrals") {
    await sendReferral(bot, chatId, player);
  } else if (command === "jackpot") {
    await sendJackpot(bot, chatId, player.telegramUserId);
  } else if (command === "escrow") {
    await handleEscrowCommand(bot, chatId, message, player, args);
  } else if (command === "mystats" || command === "wager") {
    await sendMyStats(bot, chatId, player);
  } else if (command === "stats") {
    await sendMyStats(bot, chatId, player);
  } else if (command === "rank" || command === "leaderboard") {
    await sendLeaderboard(bot, chatId);
  } else if (command === "reflead" || command === "referralleaderboard") {
    await sendReferralLeaderboard(bot, chatId);
  } else if (command === "wagerstatus") {
    await sendWagerStatus(
      bot,
      chatId,
      player.id,
      parseCurrency(player.preferredCurrency, "USD"),
    );
  } else if (command === "tip") {
    await handleTip(bot, chatId, message, player, args);
  } else if (command === "claim") {
    await handleClaim(bot, chatId, player, args[0]);
  } else if (command === "games") {
    await sendGames(bot, chatId, helperLinks, player.telegramUserId);
  } else if (command === "history" || command === "mygames" || command === "mygame") {
    await sendHistory(bot, chatId, player.id);
  } else if (battleGameMap[command]) {
    const game = battleGameMap[command];
    const explicitMode = args[0]?.toLowerCase();
    const battleInput = parseBattleArguments(
      args,
      parseCurrency(player.preferredCurrency, "USD"),
    );
    const repliedUser = message.reply_to_message?.from;
    const invitedPlayer =
      repliedUser && explicitMode !== "pvb"
        ? await ensurePlayer(repliedUser)
        : undefined;
    const effectiveBattleInput = invitedPlayer
      ? { ...battleInput, mode: "pvp" as const }
      : battleInput;
    await createBattle(
      bot,
      chatId,
      message.from,
      game,
      effectiveBattleInput,
      invitedPlayer,
    );
  } else if (command === "coin") {
    const coinArgs = args[0]?.toLowerCase() === "pvp" ? args.slice(1) : args;
    const repliedUser = message.reply_to_message?.from;
    if (!repliedUser) {
      await bot.sendMessage(chatId, "Reply to a player with /coin AMOUNT INR|USD to create a coin PVP room.");
    } else {
      const amountMinor = parseMoney(coinArgs[0]);
      const currency = parseCurrency(
        coinArgs[1],
        parseCurrency(player.preferredCurrency, "USD"),
      );
      const invitedPlayer = await ensurePlayer(repliedUser);
      await createBattle(
        bot,
        chatId,
        message.from,
        { gameType: "coin", emoji: "🪙" },
        {
          mode: "pvp",
          amountMinor,
          rounds: 1,
          rollsPerRound: 1,
          targetWins: null,
          currency,
          resultRule: "high",
        },
        invitedPlayer,
      );
    }
  } else if (command === "7up") {
    const choice = args[0]?.toLowerCase();
    const amountMinor = parseMoney(args[1]);
    const currency = parseCurrency(args[2], parseCurrency(player.preferredCurrency, "USD"));
    if (choice !== "up" && choice !== "down") {
      await bot.sendMessage(chatId, "Usage: /7up up AMOUNT INR or /7up down AMOUNT USD");
    } else {
      await playSimpleMainGame(
        bot,
        chatId,
        message.from,
        "7up",
        amountMinor,
        currency,
        choice,
        helperBots.get("dice") ?? bot,
      );
    }
  } else if (command === "dr") {
    const supportedChoices = new Set(["high", "low", "odd", "even"]);
    const firstArg = args[0]?.toLowerCase();
    const secondArg = args[1]?.toLowerCase();
    const choice = supportedChoices.has(firstArg ?? "")
      ? firstArg
      : supportedChoices.has(secondArg ?? "")
        ? secondArg
        : undefined;
    const allIn = firstArg === "all" || secondArg === "all";
    const amountMinor = allIn ? null : parseMoney(choice === firstArg ? args[1] : args[0]);
    const currency = parseCurrency(args[2], parseCurrency(player.preferredCurrency, "USD"));
    if (!choice) {
      await bot.sendMessage(chatId, "Usage: /dr AMOUNT odd|even|high|low INR|USD");
    } else {
      await playSimpleMainGame(
        bot,
        chatId,
        message.from,
        "dr",
        amountMinor,
        currency,
        choice,
        helperBots.get("dice") ?? bot,
        allIn,
      );
    }
  } else if (command === "deposit" || command === "withdraw") {
    if (!isPrivateChat(message.chat)) {
      await bot.sendMessage(
        chatId,
        command === "deposit"
          ? "Deposits are available only in private chat.\nTap below to continue securely."
          : "Withdrawals are available only in private chat.\nTap below to continue securely.",
        privateOnlyKeyboard(bot, command),
      );
    } else if (command === "deposit") {
      await beginDeposit(bot, chatId, player);
    } else {
      if (args.length > 0) {
        pendingWithdrawals.set(player.telegramUserId, { stage: "amount" });
        await handleWithdrawalAmount(bot, chatId, player, args.join(" "));
      } else {
        await beginWithdrawal(bot, chatId, player);
      }
    }
  } else {
    await bot.sendMessage(chatId, "Use /help to see the RolexCasino player commands.");
  }
}

async function playHelperGame(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  stakeMinor: number,
  currency: Currency,
): Promise<void> {
  if (!bot.gameType) return;
  const player = await ensurePlayer(user);
  const wallet = await ensureWallet(player.id, currency);
  if (wallet.balanceMinor < stakeMinor) {
    await bot.sendMessage(
      chatId,
      `Insufficient ${currency} balance. Your balance is ${formatMoney(wallet.balanceMinor, currency)}.\nAsk an administrator to review a balance credit.`,
    );
    return;
  }

  const roll = await bot.sendDice(chatId);
  const rollValue = roll.dice?.value ?? 0;
  const result = evaluateRoll(bot.gameType, rollValue);
  try {
    const settled = await settleGame({
      playerId: player.id,
      helperBot: bot.label,
      gameType: bot.gameType,
      currency,
      stakeMinor,
      rollValue,
      result,
    });
    const payoutMinor = Math.floor(stakeMinor * result.multiplier);
    if (result.multiplier > 0) {
      await broadcastPlayerWin(bot, player.id, bot.gameType, payoutMinor, currency);
    }
    await bot.sendMessage(
      chatId,
      [
        `${result.outcome}`,
        `Roll: ${rollValue}`,
        `Stake: ${formatMoney(stakeMinor, currency)}`,
        `Payout: ${formatMoney(payoutMinor, currency)}`,
        `Balance: ${formatMoney(settled.balanceMinor, currency)}`,
        `Fair ID: <code>${settled.fairId}</code>`,
      ].join("\n"),
      {
        inline_keyboard: [
          [{ text: "Roll again", callback_data: `roll:${stakeMinor}:${currency}` }],
        ],
      },
    );
    await auditTransaction(
      bot,
      [
        "Type: helper game settlement",
        `Player: ${player.telegramUserId}`,
        `Game: ${bot.gameType}`,
        `Stake: ${formatMoney(stakeMinor, currency)}`,
        `Payout: ${formatMoney(payoutMinor, currency)}`,
        `Fair ID: <code>${settled.fairId}</code>`,
        `Outcome: ${result.outcome}`,
      ].join("\n"),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      await bot.sendMessage(chatId, "The round was not accepted because your balance changed. Check /balance and try again.");
      return;
    }
    throw error;
  }
}

async function handleHelperUpdate(bot: TelegramBot, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await bot.answerCallback(update.callback_query.id);
    const callback = update.callback_query;
    const chatId = callback.message?.chat.id;
    if (!chatId) return;
    if (!casinoPowerOn && !isAdmin(callback.from.id)) {
      await bot.sendMessage(chatId, MAINTENANCE_MESSAGE);
      return;
    }
    if (!callback.message || !isOfficialGameChat(callback.message.chat)) {
      await bot.sendMessage(
        chatId,
        "Games are available only in the official RolexCasino group.",
        officialGroupKeyboard(),
      );
      return;
    }
    if (callback.data?.startsWith("roll:")) {
      const [, rawStake, rawCurrency] = callback.data.split(":");
      const stakeMinor = Number(rawStake);
      const currency = parseCurrency(rawCurrency, "USD");
      if (Number.isInteger(stakeMinor) && stakeMinor > 0) {
        await playHelperGame(bot, chatId, callback.from, stakeMinor, currency);
      }
    }
    return;
  }

  const message = update.message;
  if (!message?.from || !message.text) return;
  const { command, args } = commandFrom(message.text);
  if (!casinoPowerOn && !isAdmin(message.from.id)) {
    await bot.sendMessage(message.chat.id, MAINTENANCE_MESSAGE);
    return;
  }
  if (command === "start" || command === "help" || command === "balance" || command === "profile") {
    return;
  }
  if (!isOfficialGameChat(message.chat)) {
    await bot.sendMessage(
      message.chat.id,
      "Games are available only in the official RolexCasino group.",
      officialGroupKeyboard(),
    );
    return;
  }
  if (command === "roll" || command === "play") {
    const amountMinor = parseMoney(args[0]);
    const player = await ensurePlayer(message.from);
    const currency = parseCurrency(args[1], parseCurrency(player.preferredCurrency, "USD"));
    if (!amountMinor) {
      await bot.sendMessage(message.chat.id, "Usage: /roll 100 INR or /roll 10.50 USD");
      return;
    }
    await playHelperGame(bot, message.chat.id, message.from, amountMinor, currency);
    return;
  }
}

export async function startRolexCasinoBots(): Promise<void> {
  const mainToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!mainToken) {
    logger.warn("TELEGRAM_BOT_TOKEN is not configured; RolexCasino bots are disabled");
    return;
  }

  const mainBot = new TelegramBot({ label: "main-bot", token: mainToken });
  const helpers = helperConfigs
    .filter((config) => config.token)
    .map((config) => new TelegramBot(config));

  try {
    await mainBot.initialize();
    for (const helper of helpers) {
      await helper.initialize();
    }
  await loadPremiumEmojiPack(mainBot);
  } catch (error) {
    logger.error({ err: error }, "RolexCasino bot initialization failed");
    return;
  }

  const helperLinks = new Map<string, string>();
  const helperBotsByGame = new Map<string, TelegramBot>();
  for (const helper of helpers) {
    if (helper.botUsername) {
      helperLinks.set(helper.label, `https://t.me/${helper.botUsername}`);
    }
    if (helper.gameType) {
      helperBotsByGame.set(helper.gameType, helper);
      if (helper.gameType === "dice") {
        for (const alias of ["bowling", "basketball", "football"]) {
          helperBotsByGame.set(alias, helper);
        }
      }
    }
  }
  await recoverPvbBattleTimeouts(mainBot);
  void drawDueJackpots(mainBot).catch((error) => {
    logger.error({ err: error }, "Daily jackpot draw failed");
  });
  setInterval(() => {
    void drawDueJackpots(mainBot).catch((error) => {
      logger.error({ err: error }, "Daily jackpot draw failed");
    });
  }, 30_000);

  void mainBot.start((bot, update) =>
    handleMainUpdate(bot, update, helperLinks, helperBotsByGame),
  );
  for (const helper of helpers) {
    void helper.start(handleHelperUpdate);
  }

  logger.info(
    { helpers: helpers.map((helper) => helper.label) },
    "RolexCasino main and helper polling started",
  );
}