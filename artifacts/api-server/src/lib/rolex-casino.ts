import { randomInt, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  casinoChallengeParticipantsTable,
  casinoChallengeRollsTable,
  casinoChallengesTable,
  casinoBonusClaimsTable,
  casinoCashRequestsTable,
  casinoCryptoTipsTable,
  casinoDailyBonusSettingsTable,
  casinoDailyLossRewardsTable,
  casinoWeeklyBonusSettingsTable,
  casinoEscrowsTable,
  casinoGameBetSettingsTable,
  casinoGameRoundsTable,
  casinoGiveawayClaimsTable,
  casinoGiveawaySettingsTable,
  casinoHouseWalletsTable,
  casinoHouseRoyalePlayersTable,
  casinoHouseRoyalesTable,
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
  ccApiRequestSignature,
  isAcceptedVerificationResponse,
  isBep20Network,
  normalizeCcUsername,
  usdAmountMinor,
  verifyCcWebhookSignature,
} from "./rolex-casino-ccpayment";
import type {
  CcPaymentTipData,
  CcPaymentWebhook,
} from "./rolex-casino-ccpayment";
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
import {
  blackjackCardLabel,
  blackjackHandValue,
  blackjackHit,
  blackjackMultiplier,
  blackjackStand,
  createBlackjackGame,
} from "./rolex-casino-blackjack";
import type { BlackjackGame, BlackjackStatus } from "./rolex-casino-blackjack";

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  language_code?: string;
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
  parameters?: {
    retry_after?: number;
  };
};

type TelegramUserProfilePhotos = {
  total_count: number;
  photos: Array<Array<{ file_id: string; width: number; height: number }>>;
};

type TelegramFile = {
  file_path?: string;
};

type TelegramSticker = {
  file_id?: string;
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
  customEmojiId?: string;
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
  "limbo",
  "mines",
  "bj",
  "roulette",
]);
const LIMBO_MIN_BET_INR_MINOR = 2_000;
const MIN_DEPOSIT_MINOR: Record<Currency, number> = { INR: 5_000, USD: 50 };
const MAX_DEPOSIT_MINOR: Record<Currency, number> = { INR: 500_000, USD: 5_000 };
const DEPOSIT_FEE_RATE: Record<Currency, number> = { INR: 0.01, USD: 0.03 };
const MIN_WITHDRAWAL_MINOR: Record<Currency, number> = {
  INR: 10_000,
  USD: 100,
};
const TIP_CONFIRMATION_THRESHOLD_INR_MINOR = 5_000;
const WITHDRAWAL_FEE_RATE = 0.04;
const REFERRAL_BONUS_MINOR: Record<Currency, number> = { INR: 500, USD: 5 };
const JACKPOT_CONTRIBUTION_RATE = 0.005;
const DEPOSIT_NETWORKS = ["upi", "btc", "bsc", "solana", "ethereum"] as const;
type DepositNetwork = (typeof DEPOSIT_NETWORKS)[number];

const DEPOSIT_QR_ASSET_PATHS: Record<DepositNetwork, string> = {
  upi: new URL("../assets/deposit-upi.png", import.meta.url).pathname,
  btc: new URL("../assets/deposit-btc.png", import.meta.url).pathname,
  solana: new URL("../assets/deposit-solana.png", import.meta.url).pathname,
  ethereum: new URL("../assets/deposit-ethereum.png", import.meta.url).pathname,
  bsc: new URL("../assets/deposit-bsc.png", import.meta.url).pathname,
};

const depositQrCache = new Map<DepositNetwork, Buffer>();

async function depositQrImage(network: DepositNetwork): Promise<Buffer | null> {
  const cached = depositQrCache.get(network);
  if (cached) return cached;
  try {
    const image = await readFile(DEPOSIT_QR_ASSET_PATHS[network]);
    depositQrCache.set(network, image);
    return image;
  } catch (error) {
    logger.error({ err: error, network }, "Deposit QR asset could not be loaded");
    return null;
  }
}
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
type MinesGame = {
  fairId: string;
  userId: number;
  playerId: number;
  chatId: number;
  amountMinor: number;
  currency: Currency;
  mines: number;
  jackpotMinor: number;
  bombs: Set<number>;
  revealed: Set<number>;
  multiplier: number;
  status: "active" | "lost" | "cashed_out";
  autoMode?: boolean;
  autoRunning?: boolean;
  messageId?: number;
};

const activeMinesGames = new Map<string, MinesGame>();
const minesFairRecords = new Map<string, MinesGame>();
const settlingMinesGames = new Set<string>();
const clientSeeds = new Map<number, string>();
const currencyMenuMessages = new Map<number, { chatId: number; messageId: number }>();
const DEAL_CARD_TTL_MS = 2 * 60 * 1_000;
const dealCardDeletionTimers = new Map<string, ReturnType<typeof setTimeout>>();
let rouletteStickerIds: string[] = [];
const rouletteStickerIdsByNumber = new Map<number, string>();
let activeMainBot: TelegramBot | null = null;
let activeGiveawayBot: TelegramBot | null = null;
type BlackjackRoom = {
  roomId: string;
  userId: number;
  playerLabel: string;
  playerId: number;
  chatId: number;
  amountMinor: number;
  currency: Currency;
  fairId: string;
  game: BlackjackGame;
  messageId?: number;
};

const activeBlackjackRooms = new Map<string, BlackjackRoom>();
const blackjackActionsInFlight = new Set<string>();
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
  "🚧 RolexCasino is under maintenance. Please try again!";
const BUTTON_NOT_FOR_YOU_MESSAGE = "This button is not for you!!!";

const helperConfigs: BotConfig[] = [
  {
    label: "slots-helper",
    token: process.env.TELEGRAM_HELPER_BOT_1_TOKEN ?? "",
    gameType: "slots",
    emoji: "🎰",
    customEmojiId: "6249287461332062273",
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

const PVP_RESULT_DELAY_MS = 3_000;

async function sendDelayedGameResult(
  bot: TelegramBot,
  chatId: number,
  text: string,
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
  options?: PremiumEmojiOptions,
): Promise<TelegramMessage> {
  await wait(PVP_RESULT_DELAY_MS);
  return bot.sendMessage(chatId, text, replyMarkup, options);
}

async function sendPvpMessage(
  bot: TelegramBot,
  chatId: number,
  text: string,
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
): Promise<TelegramMessage> {
  return bot.sendMessage(chatId, text, replyMarkup);
}

async function sendDelayedPvpResult(
  bot: TelegramBot,
  chatId: number,
  text: string,
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
): Promise<TelegramMessage> {
  await wait(PVP_RESULT_DELAY_MS);
  return sendPvpMessage(bot, chatId, text, replyMarkup);
}

function escapeTelegramText(value: string): string {
  return value.replace(/[&<>]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    return "&gt;";
  });
}

const premiumEmojiByUnicode = new Map<string, string>();

type PremiumEmojiOptions = {
  copyableCode?: string;
  emojiOverrides?: Record<string, string>;
};

const SLOT_PREMIUM_EMOJI_OPTIONS: PremiumEmojiOptions = {
  emojiOverrides: { "🎰": "6249287461332062273" },
};

const ROULETTE_PREMIUM_EMOJI_OPTIONS: PremiumEmojiOptions = {
  emojiOverrides: { "🎰": "5017339507666584402" },
};

function premiumEmojiOptionsForGame(gameType?: string): PremiumEmojiOptions | undefined {
  if (gameType === "slots") return SLOT_PREMIUM_EMOJI_OPTIONS;
  if (gameType === "roulette") return ROULETTE_PREMIUM_EMOJI_OPTIONS;
  return undefined;
}

const requestedPremiumEmojiOverrides: Record<string, string> = {
  "✅": "5938109560249127910",
  "❌": "5938290000415167172",
  "💰": "5864068125112144897",
  "🚀": "6262728561484894770",
  "⚠️": "5938167138580741203",
  "💵": "5938026800524301051",
  "📢": "5935759787936453301",
  "📌": "5938027397524754858",
  "🎲": "4918297527461086252",
  "🎯": "5350460637182993292",
  "🎳": "5120769733267817374",
  "🏆": "6321227987446404067",
  "🖤": "5348576757152759323",
  "❤️": "5938543334766153912",
  "💯": "5341498088408234504",
  "🤩": "5303479226882603449",
  "🏳️": "5460755126761312667",
  "🎉": "5436040291507247633",
  "💣": "5469654973308476699",
  "⚽": "5123352773844271919",
  "🏀": "5120609599707153336",
};

for (const [unicode, customEmojiId] of Object.entries(requestedPremiumEmojiOverrides)) {
  premiumEmojiByUnicode.set(unicode, customEmojiId);
}

function applyPremiumEmojis(
  text: string,
  options?: PremiumEmojiOptions,
): {
  text: string;
  parseMode?: "HTML";
} {
  const copyableCode = options?.copyableCode
    ? escapeTelegramText(options.copyableCode)
    : null;
  const hasHtmlMarkup = /<\/?(?:b|strong|code|i|u|blockquote)>/.test(text);
  let formatted = escapeTelegramText(text);
  if (hasHtmlMarkup) {
    formatted = formatted.replace(
      /&lt;(\/?(?:b|strong|code|i|u|blockquote))&gt;/g,
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
    const resolvedCustomEmojiId = options?.emojiOverrides?.[unicode] ?? customEmojiId;
    const token = `\uE000${replacementIndex}\uE001`;
    formatted = formatted.split(unicode).join(token);
    replacements.push({
      token,
      tag: `<tg-emoji emoji-id="${resolvedCustomEmojiId}">${unicode}</tg-emoji>`,
    });
    replacementIndex += 1;
  }
  for (const replacement of replacements) {
    formatted = formatted.split(replacement.token).join(replacement.tag);
  }
  if (codeToken && copyableCode) {
    formatted = formatted
      .split(codeToken)
      .join(`<code>${copyableCode}</code>`);
  }
  return {
    text: `<b>${formatted}</b>`,
    parseMode: "HTML",
  };
}

function playerName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "Player";
}

function parseCurrency(value: string | undefined, fallback: Currency): Currency {
  const normalized = value?.toUpperCase();
  return normalized === "INR" || normalized === "USD" ? normalized : fallback;
}

type DisplayCurrency =
  | Currency
  | "JPY"
  | "CNY"
  | "KRW"
  | "SGD"
  | "HKD"
  | "THB"
  | "MYR"
  | "IDR"
  | "PHP"
  | "BDT";

const DISPLAY_CURRENCIES: Array<{
  code: DisplayCurrency;
  name: string;
}> = [
  { code: "USD", name: "US Dollar" },
  { code: "INR", name: "Indian Rupee" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "KRW", name: "Korean Won" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "THB", name: "Thai Baht" },
  { code: "MYR", name: "Malaysian Ringgit" },
  { code: "IDR", name: "Indonesian Rupiah" },
  { code: "PHP", name: "Philippine Peso" },
  { code: "BDT", name: "Bangladeshi Taka" },
];

const FALLBACK_INR_RATES: Record<DisplayCurrency, number> = {
  INR: 1,
  USD: 1 / INR_PER_USD,
  JPY: 1.62,
  CNY: 0.073,
  KRW: 15.1,
  SGD: 0.0138,
  HKD: 0.093,
  THB: 0.37,
  MYR: 0.050,
  IDR: 191.5,
  PHP: 0.68,
  BDT: 1.42,
};

let displayRatesInr = { ...FALLBACK_INR_RATES };

function parseDisplayCurrency(
  value: string | undefined,
  fallback: DisplayCurrency,
): DisplayCurrency {
  const normalized = value?.toUpperCase() as DisplayCurrency | undefined;
  return DISPLAY_CURRENCIES.some((item) => item.code === normalized)
    ? normalized as DisplayCurrency
    : fallback;
}

function displayCurrencyLabel(currency: DisplayCurrency): string {
  return DISPLAY_CURRENCIES.find((item) => item.code === currency)?.name ?? currency;
}

function formatDisplayAmount(inrMinor: number, currency: DisplayCurrency): string {
  const amount = (inrMinor / 100) * (displayRatesInr[currency] ?? 1);
  const digits = currency === "JPY" || currency === "KRW" || currency === "IDR" ? 0 : 2;
  const formatted = amount.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const symbol: Record<DisplayCurrency, string> = {
    INR: "₹",
    USD: "$",
    JPY: "¥",
    CNY: "¥",
    KRW: "₩",
    SGD: "S$",
    HKD: "HK$",
    THB: "฿",
    MYR: "RM",
    IDR: "Rp",
    PHP: "₱",
    BDT: "৳",
  };
  return `${symbol[currency]}${formatted}`;
}

async function refreshDisplayRates(): Promise<void> {
  let progressUpdated = false;
  try {
    const response = await fetch(
      "https://open.er-api.com/v6/latest/INR",
      { signal: AbortSignal.timeout(4_000) },
    );
    if (!response.ok) return;
    const payload = await response.json() as { rates?: Record<string, number> };
    const next = { ...displayRatesInr };
    for (const item of DISPLAY_CURRENCIES) {
      const rate = payload.rates?.[item.code];
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
        next[item.code] = rate;
      }
    }
    displayRatesInr = next;
  } catch (error) {
    logger.warn({ err: error }, "Live display currency rates unavailable; using fallback rates");
  }
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
  if (setting) {
    return gameType === "limbo"
      ? Math.max(
          setting.minimumBetMinor,
          currency === "INR"
            ? LIMBO_MIN_BET_INR_MINOR
            : Math.ceil(LIMBO_MIN_BET_INR_MINOR / INR_PER_USD),
        )
      : setting.minimumBetMinor;
  }
  if (gameType === "limbo") {
    return currency === "INR"
      ? LIMBO_MIN_BET_INR_MINOR
      : Math.ceil(LIMBO_MIN_BET_INR_MINOR / INR_PER_USD);
  }
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
  return `<b>Minimum bet is ${min} ✔️</b>\nMaximum bet: ${max} (1 USD = ₹${INR_PER_USD}).`;
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
    limbo: "limbo",
    bj: "bj",
    blackjack: "bj",
    roul: "roulette",
    roulette: "roulette",
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

function parseCompactMinimumCommand(command: string): {
  gameToken: string;
  amountToken: string;
  currencyToken?: string;
} | null {
  const match = command.match(
    /^set([a-z0-9]+?)(\d+(?:\.\d{1,2})?)(inr|usd)?$/i,
  );
  if (!match) return null;
  return {
    gameToken: match[1],
    amountToken: match[2],
    currencyToken: match[3]?.toUpperCase(),
  };
}

function parseCompactRewardCommand(
  command: string,
  kind: "daily" | "weekly",
): { amountToken: string; currencyToken?: string } | null {
  const match = command.match(
    new RegExp(`^set${kind}(\\d+(?:\\.\\d{1,2})?)(inr|usd)?$`, "i"),
  );
  if (!match) return null;
  return {
    amountToken: match[1],
    currencyToken: match[2]?.toUpperCase(),
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

const CLIENT_SEED_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789_-!@#$%";

function createClientSeed(): string {
  let seed = "";
  while (seed.length < 32) {
    seed += CLIENT_SEED_ALPHABET[randomInt(CLIENT_SEED_ALPHABET.length)];
  }
  return seed;
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

function depositFeeMinor(amountMinor: number, currency: Currency): number {
  return Math.max(1, Math.ceil(amountMinor * DEPOSIT_FEE_RATE[currency]));
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
  private readonly profilePhotoCache = new Map<
    number,
    { expiresAt: number; dataUri: string | null }
  >();

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

  async call<T>(
    method: string,
    body?: Record<string, unknown>,
    options?: { timeoutMs?: number; maxAttempts?: number },
  ): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? 3;
    const timeoutMs = options?.timeoutMs ?? 15_000;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(
          `https://api.telegram.org/bot${this.config.token}/${method}`,
          {
            method: body ? "POST" : "GET",
            headers: body ? { "content-type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(timeout);
      }
      const payload = (await response.json()) as TelegramResponse<T>;
      if (response.ok && payload.ok) return payload.result;
      if (response.status === 429 && attempt < maxAttempts - 1) {
        const retryAfterSeconds = Math.max(
          1,
          Math.min(payload.parameters?.retry_after ?? 1, 10),
        );
        await wait(retryAfterSeconds * 1_000);
        continue;
      }
      throw new Error(
        `${this.config.label} ${method} failed: ${payload.description ?? response.statusText}`,
      );
    }
    throw new Error(`${this.config.label} ${method} failed after retries`);
  }

  async initialize(): Promise<void> {
    const me = await this.call<TelegramUser>("getMe");
    this.username = me.username ?? "";
    logger.info(
      { bot: this.config.label, username: this.username },
      "RolexCasino Telegram bot connected",
    );
  }

  async setCommands(
    commands: Array<{ command: string; description: string }>,
  ): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  async preparePolling(): Promise<void> {
    try {
      await this.call(
        "deleteWebhook",
        { drop_pending_updates: false },
        { timeoutMs: 5_000, maxAttempts: 1 },
      );
    } catch (error) {
      logger.warn(
        { err: error, bot: this.config.label },
        "Telegram webhook cleanup timed out; continuing with polling setup",
      );
    }
  }

  async getStickerSet(name: string): Promise<TelegramStickerSet> {
    return this.call<TelegramStickerSet>("getStickerSet", { name });
  }

  async getUserProfilePhoto(userId: number): Promise<string | null> {
    const cached = this.profilePhotoCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.dataUri;
    try {
      const photos = await this.call<TelegramUserProfilePhotos>(
        "getUserProfilePhotos",
        { user_id: userId, limit: 1 },
        { timeoutMs: 8_000, maxAttempts: 1 },
      );
      const fileId = photos.photos[0]?.[0]?.file_id;
      if (!fileId) {
        this.profilePhotoCache.set(userId, { expiresAt: Date.now() + 300_000, dataUri: null });
        return null;
      }
      const file = await this.call<TelegramFile>(
        "getFile",
        { file_id: fileId },
        { timeoutMs: 8_000, maxAttempts: 1 },
      );
      if (!file.file_path) return null;
      const response = await fetch(
        `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!response.ok) throw new Error(`profile photo download returned ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const extension = file.file_path.split(".").pop()?.toLowerCase();
      const mime = extension === "png" ? "image/png" : "image/jpeg";
      const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
      this.profilePhotoCache.set(userId, { expiresAt: Date.now() + 300_000, dataUri });
      return dataUri;
    } catch (error) {
      logger.debug({ err: error, userId, bot: this.config.label }, "Telegram profile photo unavailable");
      this.profilePhotoCache.set(userId, { expiresAt: Date.now() + 60_000, dataUri: null });
      return null;
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: {
      inline_keyboard: InlineKeyboardButton[][];
    },
    options?: PremiumEmojiOptions,
  ): Promise<TelegramMessage> {
    const formatted = applyPremiumEmojis(text, options);
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: formatted.text,
      ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
    options?: PremiumEmojiOptions,
  ): Promise<TelegramMessage> {
    const formatted = applyPremiumEmojis(text, options);
    return this.call<TelegramMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: formatted.text,
      ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async editMessageCaption(
    chatId: number,
    messageId: number,
    caption: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
  ): Promise<TelegramMessage> {
    const formatted = applyPremiumEmojis(caption);
    return this.call<TelegramMessage>("editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: formatted.text,
      ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async editReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: { inline_keyboard: InlineKeyboardButton[][] },
  ): Promise<void> {
    await this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
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

  async sendSticker(chatId: number, sticker: string): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendSticker", {
      chat_id: chatId,
      sticker,
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

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call("deleteMessage", {
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

  async answerCallback(id: string, text?: string, showAlert = false): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text, show_alert: showAlert } : {}),
    });
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
      if (
        sticker.emoji &&
        sticker.emoji !== "🎰" &&
        sticker.custom_emoji_id &&
        !premiumEmojiByUnicode.has(sticker.emoji)
      ) {
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

async function loadRouletteStickerPack(bot: TelegramBot): Promise<void> {
  try {
    let stickerSet: TelegramStickerSet | null = null;
    let packName = "roulete";
    for (const candidate of ["roulete", "roulette"]) {
      try {
        stickerSet = await bot.getStickerSet(candidate);
        packName = candidate;
        break;
      } catch {
        // Support both the legacy pack name and its correctly-spelled alias.
      }
    }
    if (!stickerSet) throw new Error("ROULETTE_STICKER_SET_NOT_FOUND");
    rouletteStickerIds = [];
    rouletteStickerIdsByNumber.clear();
    const usesRouletePackLayout =
      packName === "roulete" && stickerSet.stickers.length === 38;
    for (const [index, sticker] of stickerSet.stickers.entries()) {
      if (!sticker.file_id) continue;
      rouletteStickerIds.push(sticker.file_id);
      const number =
        rouletteStickerNumber(sticker.emoji) ??
        rouletteStickerNumberFromRouletePackIndex(
          index,
          stickerSet.stickers.length,
        );
      if (number !== null) {
        rouletteStickerIdsByNumber.set(number, sticker.file_id);
      }
    }
    logger.info(
      {
        packName,
        stickerCount: rouletteStickerIds.length,
        numberedStickerCount: rouletteStickerIdsByNumber.size,
        mapping: usesRouletePackLayout ? "roulete-pack-layout" : "metadata-only",
      },
      "RolexCasino roulette sticker pack loaded",
    );
  } catch (error) {
    logger.warn({ err: error }, "Roulette sticker pack unavailable at startup");
  }
}

function rouletteStickerNumber(emoji?: string): number | null {
  if (!emoji) return null;
  if (emoji.includes("🔟")) return 10;
  const digits = emoji.match(/\d/g)?.join("") ?? "";
  if (!digits) return null;
  const number = Number(digits);
  return Number.isInteger(number) && number >= 1 && number <= 36
    ? number
    : null;
}

function rouletteStickerNumberFromRouletePackIndex(
  index: number,
  stickerCount: number,
): number | null {
  // The linked `roulete` pack contains, in order, two non-playable entries
  // (00 and 0), followed by the 1–36 result animations. Telegram exposes all
  // of them with the same 🎰 emoji and no numeric metadata, so the pack's
  // documented artwork layout is the only reliable mapping for this pack.
  if (stickerCount !== 38) return null;
  const number = index - 1;
  return number >= 1 && number <= 36 ? number : null;
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
      `✅ ${gameType.toUpperCase()} ${winnerName} WON ${formatMoney(payoutMinor, currency)} (${time})`,
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
      isBot: Boolean(user.is_bot),
      language: "en",
      username,
      displayName: playerName(user),
      referralCode: referralCodeFor(user.id),
    })
    .onConflictDoUpdate({
      target: casinoPlayersTable.telegramUserId,
      set: {
        username,
        displayName: playerName(user),
        isBot: Boolean(user.is_bot),
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

type CcWebhookResult = {
  httpStatus: number;
  body: {
    status: "success" | "error";
    code: number;
    message: string;
  };
};

function ccResult(
  status: "success" | "error",
  code: number,
  message: string,
  httpStatus = code,
): CcWebhookResult {
  return { httpStatus, body: { status, code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ccTelegramUserId(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function ccTipPayload(value: unknown): CcPaymentWebhook | null {
  if (!isRecord(value)) return null;
  const dataValue = value.data;
  if (
    typeof value.event_id !== "string" ||
    !value.event_id.trim() ||
    typeof value.event_type !== "string" ||
    typeof value.timestamp !== "number" ||
    !Number.isSafeInteger(value.timestamp) ||
    !isRecord(dataValue)
  ) {
    return null;
  }
  const sender = dataValue.sender;
  const recipient = dataValue.recipient;
  const confirmations = dataValue.confirmations;
  if (
    typeof dataValue.transaction_id !== "string" ||
    !dataValue.transaction_id.trim() ||
    typeof dataValue.token !== "string" ||
    !dataValue.token.trim() ||
    typeof dataValue.network !== "string" ||
    !dataValue.network.trim() ||
    typeof dataValue.amount !== "string" ||
    !isRecord(sender) ||
    !isRecord(recipient) ||
    typeof dataValue.status !== "string" ||
    typeof confirmations !== "number" ||
    !Number.isSafeInteger(confirmations) ||
    typeof dataValue.is_flagged_as_risky !== "boolean" ||
    typeof dataValue.flash_usdt_detected !== "boolean"
  ) {
    return null;
  }
  const senderUserId = ccTelegramUserId(sender.user_id);
  if (senderUserId === null) return null;
  if (typeof recipient.username !== "string") return null;

  return {
    event_id: value.event_id.trim(),
    event_type: value.event_type.trim(),
    timestamp: value.timestamp as number,
    data: {
      transaction_id: dataValue.transaction_id.trim(),
      token: dataValue.token.trim(),
      network: dataValue.network.trim(),
      amount: dataValue.amount.trim(),
      sender: {
        user_id: senderUserId,
        ...(typeof sender.username === "string"
          ? { username: sender.username.trim() }
          : {}),
      },
      recipient: {
        ...(typeof recipient.user_id === "string" ||
        typeof recipient.user_id === "number"
          ? { user_id: recipient.user_id }
          : {}),
        username: recipient.username.trim(),
        ...(typeof recipient.address === "string"
          ? { address: recipient.address.trim() }
          : {}),
      },
      status: dataValue.status.trim().toLowerCase(),
      confirmations: confirmations as number,
      is_flagged_as_risky: dataValue.is_flagged_as_risky,
      flash_usdt_detected: dataValue.flash_usdt_detected,
      ...(typeof dataValue.usd_amount === "string" ||
      typeof dataValue.usd_amount === "number"
        ? { usd_amount: dataValue.usd_amount }
        : {}),
      ...(typeof dataValue.amount_usd === "string" ||
      typeof dataValue.amount_usd === "number"
        ? { amount_usd: dataValue.amount_usd }
        : {}),
      ...(typeof dataValue.fiat_amount_usd === "string" ||
      typeof dataValue.fiat_amount_usd === "number"
        ? { fiat_amount_usd: dataValue.fiat_amount_usd }
        : {}),
    },
  };
}

async function verifyCcTipWithProvider(
  webhook: CcPaymentWebhook,
): Promise<boolean> {
  const apiKey = process.env.CC_PAYMENT_API_KEY?.trim();
  const secret = process.env.CC_PAYMENT_API_SECRET?.trim();
  if (!apiKey || !secret) {
    logger.error("CCPayment verification is unavailable because credentials are missing");
    return false;
  }

  const body = JSON.stringify({
    event_id: webhook.event_id,
    transaction_id: webhook.data.transaction_id,
    sender_user_id: webhook.data.sender.user_id,
    recipient_username: webhook.data.recipient.username,
    recipient_address: webhook.data.recipient.address,
    token: webhook.data.token,
    network: webhook.data.network,
    amount: webhook.data.amount,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const endpoint =
    process.env.CC_PAYMENT_VERIFY_ENDPOINT?.trim() ||
    "https://api.ccpayment.com/v2/wallet/verify-tip";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-CC-API-Key": apiKey,
        "X-CC-Timestamp": timestamp,
        "X-CC-Signature": ccApiRequestSignature(timestamp, body, secret),
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    const responseBody = (await response.json().catch(() => null)) as unknown;
    return isAcceptedVerificationResponse(response.status, responseBody);
  } catch (error) {
    logger.error(
      { err: error, transactionId: webhook.data.transaction_id },
      "CCPayment verification request failed",
    );
    return false;
  }
}

async function creditVerifiedCcTip(
  webhook: CcPaymentWebhook,
  player: typeof casinoPlayersTable.$inferSelect,
  grossAmountMinor: number,
): Promise<
  | { kind: "credited"; balanceMinor: number; feeMinor: number; creditedAmountMinor: number }
  | { kind: "duplicate" }
> {
  const feeMinor = Math.floor(grossAmountMinor * 0.02);
  const creditedAmountMinor = grossAmountMinor - feeMinor;
  if (creditedAmountMinor <= 0) throw new Error("CC_TIP_AMOUNT_TOO_SMALL");

  const wallet = await ensureWallet(player.id, "USD");
  const houseWallet = await ensureHouseWallet("USD");
  const data = webhook.data;
  return db.transaction(async (tx) => {
    const [tip] = await tx
      .insert(casinoCryptoTipsTable)
      .values({
        eventId: webhook.event_id,
        transactionId: data.transaction_id,
        playerId: player.id,
        senderTelegramUserId: Number(data.sender.user_id),
        senderUsername: data.sender.username
          ? normalizeCcUsername(data.sender.username)
          : null,
        recipientUsername: normalizeCcUsername(data.recipient.username),
        token: data.token.toUpperCase(),
        network: data.network.toUpperCase(),
        currency: "USD",
        grossAmountMinor,
        feeMinor,
        creditedAmountMinor,
        confirmations: data.confirmations,
        isRisky: data.is_flagged_as_risky,
        flashDetected: data.flash_usdt_detected,
        status: "credited",
        processedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: casinoCryptoTipsTable.id });
    if (!tip) return { kind: "duplicate" as const };

    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${creditedAmountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, wallet.id))
      .returning();
    if (!updatedWallet) throw new Error("CC_TIP_CREDIT_FAILED");

    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId: data.transaction_id,
      entryType: "cc_tip_credit",
      amountMinor: creditedAmountMinor,
      description: `Verified ${data.token.toUpperCase()} BEP20 tip; 2% fee retained by HB`,
    });
    await tx
      .update(casinoHouseWalletsTable)
      .set({
        balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} + ${feeMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoHouseWalletsTable.id, houseWallet.id));

    await tx
      .insert(casinoWagerRequirementsTable)
      .values({
        playerId: player.id,
        currency: "USD",
        requiredMinor: creditedAmountMinor,
        completedMinor: 0,
      })
      .onConflictDoUpdate({
        target: [
          casinoWagerRequirementsTable.playerId,
          casinoWagerRequirementsTable.currency,
        ],
        set: {
          requiredMinor: sql`${casinoWagerRequirementsTable.requiredMinor} + ${creditedAmountMinor}`,
          updatedAt: new Date(),
        },
      });

    return {
      kind: "credited" as const,
      balanceMinor: updatedWallet.balanceMinor,
      feeMinor,
      creditedAmountMinor,
    };
  });
}

export async function processCcPaymentWebhook(input: {
  payload: unknown;
  rawBody: Buffer;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
}): Promise<CcWebhookResult> {
  const secret = process.env.CC_PAYMENT_API_SECRET?.trim();
  if (!secret) {
    return ccResult("error", 503, "CCPayment verification is not configured.", 503);
  }
  if (
    !verifyCcWebhookSignature({
      rawBody: input.rawBody,
      timestampHeader: input.timestampHeader,
      signatureHeader: input.signatureHeader,
      secret,
    })
  ) {
    return ccResult("error", 401, "Invalid CCPayment webhook signature.", 401);
  }

  const webhook = ccTipPayload(input.payload);
  if (!webhook) {
    return ccResult("error", 400, "Invalid CCPayment webhook payload.", 400);
  }
  const data = webhook.data;
  if (webhook.event_type !== "tip.received") {
    return ccResult("success", 200, "Webhook ignored because it is not a tip event.");
  }
  if (normalizeCcUsername(data.recipient.username) !== "lucifer_1205") {
    return ccResult("success", 200, "Tip ignored because the recipient is not authorized.");
  }
  const configuredAddress = process.env.CC_PAYMENT_BEP20_ADDRESS?.trim().toLowerCase();
  if (configuredAddress && data.recipient.address?.trim().toLowerCase() !== configuredAddress) {
    return ccResult("success", 200, "Tip ignored because the BEP20 address does not match.");
  }
  if (!isBep20Network(data.network)) {
    return ccResult("success", 200, "Tip ignored because only BEP20 is supported.");
  }
  if (data.status !== "confirmed" || data.confirmations < 1) {
    return ccResult("success", 200, "Tip received but is not confirmed yet; no funds were credited.");
  }
  if (data.is_flagged_as_risky || data.flash_usdt_detected) {
    return ccResult("success", 200, "Tip rejected by CCPayment risk checks; no funds were credited.");
  }
  const grossAmountMinor = usdAmountMinor(data);
  if (grossAmountMinor === null) {
    return ccResult(
      "success",
      200,
      "Tip rejected because CCPayment did not provide a verifiable USD value for this token.",
    );
  }
  if (!(await verifyCcTipWithProvider(webhook))) {
    return ccResult(
      "success",
      200,
      "Tip verification is pending or failed; no funds were credited.",
    );
  }

  const senderUserId = Number(data.sender.user_id);
  const player = await ensurePlayer({
    id: senderUserId,
    first_name: data.sender.username
      ? `@${normalizeCcUsername(data.sender.username)}`
      : `Telegram ${senderUserId}`,
    ...(data.sender.username ? { username: normalizeCcUsername(data.sender.username) } : {}),
  });
  const result = await creditVerifiedCcTip(webhook, player, grossAmountMinor);
  if (result.kind === "duplicate") {
    return ccResult("success", 200, "Webhook already processed; no duplicate credit was made.");
  }

  const bot = activeMainBot;
  if (bot) {
    const playerLabel = player.username ? `@${player.username}` : player.displayName;
    await Promise.allSettled([
      bot.sendMessage(
        player.telegramUserId,
        [
          "<b>✅ CC TIP VERIFIED AND CREDITED</b>",
          "",
          `Transaction: <code>${escapeTelegramText(data.transaction_id)}</code>`,
          `Amount: <b>$${(grossAmountMinor / 100).toFixed(2)}</b>`,
          `Token: <b>${escapeTelegramText(data.token.toUpperCase())}</b>`,
          "Network: <b>BEP20</b>",
          `Fee (2%): <b>$${(result.feeMinor / 100).toFixed(2)}</b>`,
          `Credited to your USD wallet: <b>$${(result.creditedAmountMinor / 100).toFixed(2)}</b>`,
          `Updated balance: <b>$${(result.balanceMinor / 100).toFixed(2)}</b>`,
          `Wager rule: <b>1× ($${(result.creditedAmountMinor / 100).toFixed(2)})</b>`,
          "",
          "Your CC tip has been verified by CCPayment and credited successfully.",
        ].join("\n"),
        officialGroupKeyboard(),
      ),
      notifyAdmins(
        bot,
        [
          "<b>🧾 CC WALLET RECHARGE VERIFIED</b>",
          "",
          `User: <b>${escapeTelegramText(playerLabel)}</b>`,
          `Telegram ID: <code>${player.telegramUserId}</code>`,
          `Token: <b>${escapeTelegramText(data.token.toUpperCase())}</b>`,
          "Network: <b>BEP20</b>",
          `Gross amount: <b>$${(grossAmountMinor / 100).toFixed(2)}</b>`,
          `Fee to HB (2%): <b>$${(result.feeMinor / 100).toFixed(2)}</b>`,
          `Credited: <b>$${(result.creditedAmountMinor / 100).toFixed(2)}</b>`,
          `Transaction: <code>${escapeTelegramText(data.transaction_id)}</code>`,
          `Event: <code>${escapeTelegramText(webhook.event_id)}</code>`,
          "API verification: <b>success</b>",
        ].join("\n"),
      ),
      auditTransaction(
        bot,
        [
          "Type: CCPayment verified tip",
          `Player: ${player.telegramUserId}`,
          `Transaction: ${data.transaction_id}`,
          `Gross: $${(grossAmountMinor / 100).toFixed(2)}`,
          `Fee: $${(result.feeMinor / 100).toFixed(2)}`,
          `Credited: $${(result.creditedAmountMinor / 100).toFixed(2)}`,
        ].join("\n"),
      ),
    ]);
  } else {
    logger.warn(
      { transactionId: data.transaction_id, playerId: player.id },
      "CCPayment credit completed before the main Telegram bot was ready",
    );
  }

  return ccResult("success", 200, "Webhook processed, funds credited to user wallet.");
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

async function balanceText(
  playerId: number,
  preferredCurrency: DisplayCurrency,
): Promise<string> {
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
  return [
    `💰 Selected currency: <b>${preferredCurrency} ${formatDisplayAmount(totalInrMinor, preferredCurrency)}</b>`,
    `💵 USD value: <b>${formatDisplayAmount(totalInrMinor, "USD")}</b>`,
  ].join("\n");
}

async function changePlayerCurrency(
  playerId: number,
  preferredCurrency: DisplayCurrency,
): Promise<void> {
  await db
    .update(casinoPlayersTable)
    .set({ preferredCurrency, updatedAt: new Date() })
    .where(eq(casinoPlayersTable.id, playerId));
}

async function settleGame(input: {
  playerId: number;
  helperBot: string;
  gameType: string;
  currency: Currency;
  stakeMinor: number;
  rollValue: number;
  result: GameResult;
  fairId?: string;
}): Promise<{ balanceMinor: number; fairId: string }> {
  const wallet = await ensureWallet(input.playerId, input.currency);
  const payoutMinor = Math.floor(input.stakeMinor * input.result.multiplier);
  const transactionId = randomUUID();
  const fairId = input.fairId ?? createFairId();
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

    await recordDailyLoss(
      tx,
      input.playerId,
      input.currency,
      Math.max(0, totalDebit - payoutMinor),
    );

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
    if (input.entryType === "admin_credit") {
      await tx
        .insert(casinoWagerRequirementsTable)
        .values({
          playerId: player.id,
          currency: input.currency,
          requiredMinor: input.amountMinor,
          completedMinor: 0,
        })
        .onConflictDoUpdate({
          target: [
            casinoWagerRequirementsTable.playerId,
            casinoWagerRequirementsTable.currency,
          ],
          set: {
            requiredMinor: sql`${casinoWagerRequirementsTable.requiredMinor} + ${input.amountMinor}`,
            updatedAt: new Date(),
          },
        });
    }
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
  const feeMinor = depositFeeMinor(amountMinor, currency);
  const [request] = await db
    .insert(casinoCashRequestsTable)
    .values({
      playerId,
      requestType: "deposit",
      currency,
      amountMinor,
      feeMinor,
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
    const creditedAmountMinor = Math.max(
      0,
      request.amountMinor - request.feeMinor,
    );
    const [updatedWallet] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${creditedAmountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, wallet.id))
      .returning();
    if (!updatedWallet) throw new Error("DEPOSIT_CREDIT_FAILED");
    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId: randomUUID(),
      entryType: "deposit_credit",
      amountMinor: creditedAmountMinor,
      description: `Verified ${currency} deposit #${requestId}`,
    });
    await tx
      .insert(casinoHouseWalletsTable)
      .values({ currency })
      .onConflictDoNothing();
    const [houseWallet] = await tx
      .select()
      .from(casinoHouseWalletsTable)
      .where(eq(casinoHouseWalletsTable.currency, currency))
      .limit(1);
    if (!houseWallet) throw new Error("HOUSE_WALLET_NOT_FOUND");
    if (request.feeMinor > 0) {
      await tx
        .update(casinoHouseWalletsTable)
        .set({
          balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} + ${request.feeMinor}`,
          updatedAt: new Date(),
        })
        .where(eq(casinoHouseWalletsTable.id, houseWallet.id));
    }
    await tx
      .insert(casinoWagerRequirementsTable)
      .values({
        playerId: request.playerId,
        currency,
        requiredMinor: creditedAmountMinor,
        completedMinor: 0,
      })
      .onConflictDoUpdate({
        target: [
          casinoWagerRequirementsTable.playerId,
          casinoWagerRequirementsTable.currency,
        ],
        set: {
          requiredMinor: sql`${casinoWagerRequirementsTable.requiredMinor} + ${creditedAmountMinor}`,
          updatedAt: new Date(),
        },
      });
    return {
      balanceMinor: updatedWallet.balanceMinor,
      creditedAmountMinor,
      feeMinor: request.feeMinor,
    };
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
        `Deposit amount: ${formatMoney(request.amountMinor, currency)}`,
        `Fee: ${formatMoney(result.feeMinor, currency)} (${currency === "USD" ? "3%" : "1%"})`,
        `Credited: ${formatMoney(result.creditedAmountMinor, currency)}`,
        `Balance: ${formatMoney(result.balanceMinor, currency)}`,
        `Fair ID: <code>${request.fairId ?? "legacy"}</code>`,
        `Wager requirement added: ${formatMoney(result.creditedAmountMinor, currency)} (1×)`,
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
      `Fee: ${formatMoney(result.feeMinor, currency)} (${currency === "USD" ? "3%" : "1%"})`,
      `Credited: ${formatMoney(result.creditedAmountMinor, currency)}`,
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
): Promise<"approved" | "insufficient_house" | "unavailable"> {
  if (!isAdmin(adminId)) return "unavailable";
  let approval: {
    request: typeof casinoCashRequestsTable.$inferSelect;
    requestedMinor: number;
    payoutMinor: number;
    houseBalanceMinor: number;
  } | null;
  try {
    approval = await db.transaction(async (tx) => {
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

      const note = cashRequestNote(request.note);
      const payoutMinor = Number(note.payoutMinor) || request.amountMinor;
      const requestedMinor =
        Number(note.requestedMinor) || request.amountMinor + request.feeMinor;
      const [updated] = await tx
        .update(casinoCashRequestsTable)
        .set({ status: "completed", reviewedAt: new Date() })
        .where(
          and(
            eq(casinoCashRequestsTable.id, requestId),
            eq(casinoCashRequestsTable.status, "pending"),
          ),
        )
        .returning();
      if (!updated) return null;

      const currency = parseCurrency(request.currency, "USD");
      await tx
        .insert(casinoHouseWalletsTable)
        .values({ currency })
        .onConflictDoNothing();
      const [houseWallet] = await tx
        .select()
        .from(casinoHouseWalletsTable)
        .where(eq(casinoHouseWalletsTable.currency, currency))
        .limit(1);
      if (!houseWallet) throw new Error("HOUSE_WALLET_NOT_FOUND");
      const [updatedHouse] = await tx
        .update(casinoHouseWalletsTable)
        .set({
          balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} - ${requestedMinor}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(casinoHouseWalletsTable.id, houseWallet.id),
            gte(casinoHouseWalletsTable.balanceMinor, requestedMinor),
          ),
        )
        .returning();
      if (!updatedHouse) throw new Error("INSUFFICIENT_HOUSE_BALANCE");

      return {
        request: updated,
        requestedMinor,
        payoutMinor,
        houseBalanceMinor: updatedHouse.balanceMinor,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_HOUSE_BALANCE") {
      return "insufficient_house";
    }
    throw error;
  }
  if (!approval) return "unavailable";
  const { request, requestedMinor, payoutMinor, houseBalanceMinor } = approval;
  const currency = parseCurrency(request.currency, "USD");
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
        `Requested: ${formatMoney(requestedMinor, currency)}`,
        `Fee: ${formatMoney(request.feeMinor, currency)} (4%)`,
        `Payout: ${formatMoney(payoutMinor, currency)}`,
        `House balance after approval: ${formatMoney(houseBalanceMinor, currency)}`,
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
      `Requested: ${formatMoney(requestedMinor, currency)}`,
      `Fee: ${formatMoney(request.feeMinor, currency)}`,
      `Payout: ${formatMoney(payoutMinor, currency)}`,
      `House balance after approval: ${formatMoney(houseBalanceMinor, currency)}`,
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
      { text: "Language", callback_data: ownedCallback("main:language", ownerTelegramUserId) },
    ],
    [
      { text: "Support", callback_data: ownedCallback("main:support", ownerTelegramUserId) },
      { text: "🎁 Giveaways", callback_data: ownedCallback("main:giveaway", ownerTelegramUserId) },
    ],
    [
      { text: "❔ How to play", callback_data: ownedCallback("main:how", ownerTelegramUserId) },
      { text: "📜 Terms", callback_data: ownedCallback("main:terms", ownerTelegramUserId) },
    ],
  ];
  return { inline_keyboard: keyboard };
}

const BOT_LANGUAGES: Array<{ code: string; label: string; flag: string }> = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "hi", label: "हिन्दी", flag: "🇮🇳" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "ru", label: "Русский", flag: "🇷🇺" },
  { code: "bn", label: "বাংলা", flag: "🇧🇩" },
  { code: "ar", label: "العربية", flag: "🇸🇦" },
  { code: "ta", label: "தமிழ்", flag: "🇮🇳" },
  { code: "te", label: "తెలుగు", flag: "🇮🇳" },
];

const MAIN_BOT_COMMANDS = [
  ["start", "Open the RolexCasino menu"],
  ["help", "Show all bot commands"],
  ["wallet", "View wallet balances"],
  ["deposit", "Deposit funds privately"],
  ["withdraw", "Withdraw funds privately"],
  ["games", "View available games"],
  ["dice", "Play Dice"],
  ["slots", "Play Slots"],
  ["darts", "Play Darts"],
  ["coin", "Play Coin Flip"],
  ["7up", "Play 7 Up"],
  ["limbo", "Play Limbo"],
  ["mines", "Play Mines"],
  ["blackjack", "Play Blackjack"],
  ["pvp", "Create a player battle"],
  ["pvb", "Create a bot battle"],
  ["global", "Global wager leaderboard"],
  ["weekly", "Weekly wager leaderboard"],
  ["monthly", "Monthly wager leaderboard"],
  ["rank", "Show global rankings"],
  ["stats", "View your stats"],
  ["refer", "View referral rewards"],
  ["daily", "View daily bonus"],
  ["rackback", "View daily loss rebate"],
  ["weeklybonus", "View weekly bonus"],
  ["giveaway", "View latest giveaway"],
  ["join", "Join latest giveaway"],
  ["giveawayrank", "View the giveaway leaderboard"],
  ["cancelgiveaway", "Cancel an active giveaway (admins only, private DM)"],
  ["editgiveaway", "Edit an active giveaway (admins only, private DM)"],
  ["hrinfo", "View House Royale players and chances"],
  ["rates", "View live currency rates"],
  ["currency", "Choose display currency"],
  ["language", "Choose bot language"],
  ["support", "Contact support"],
].map(([command, description]) => ({ command, description }));

const RACKBACK_RATE_BPS = 100;
const RACKBACK_TIMEZONE = "Asia/Calcutta";
type CasinoDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function rackbackLocalParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: RACKBACK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function rackbackDayKey(date: Date): string {
  const parts = rackbackLocalParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function rackbackLocalMidnight(date: Date, dayOffset = 0): Date {
  const parts = rackbackLocalParts(date);
  // Asia/Calcutta is UTC+05:30 and has no daylight-saving transitions.
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset) -
      5.5 * 60 * 60 * 1_000,
  );
}

function rackbackPreviousDayKey(date: Date): string {
  return rackbackDayKey(new Date(rackbackLocalMidnight(date).getTime() - 1));
}

function rackbackClaimWindowOpen(date: Date): boolean {
  const midnight = rackbackLocalMidnight(date);
  return date.getTime() >= midnight.getTime() &&
    date.getTime() < midnight.getTime() + 60_000;
}

function rackbackNextClaimAt(date: Date): Date {
  return rackbackLocalMidnight(date, 1);
}

function rackbackCountdown(date: Date, target: Date): string {
  const totalMinutes = Math.max(
    0,
    Math.ceil((target.getTime() - date.getTime()) / 60_000),
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

async function recordDailyLoss(
  tx: CasinoDbTransaction,
  playerId: number,
  currency: Currency,
  lossMinor: number,
  createdAt = new Date(),
): Promise<void> {
  if (lossMinor <= 0) return;
  const dayKey = rackbackDayKey(createdAt);
  await tx
    .insert(casinoDailyLossRewardsTable)
    .values({
      playerId,
      dayKey,
      currency,
      lossMinor,
      rewardMinor: 0,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [
        casinoDailyLossRewardsTable.playerId,
        casinoDailyLossRewardsTable.dayKey,
        casinoDailyLossRewardsTable.currency,
      ],
      set: {
        lossMinor: sql`${casinoDailyLossRewardsTable.lossMinor} + ${lossMinor}`,
        updatedAt: createdAt,
      },
    });
}

async function distributeDueDailyLossRewards(): Promise<void> {
  const now = new Date();
  if (!rackbackClaimWindowOpen(now)) return;
  const previousDayKey = rackbackPreviousDayKey(now);
  const pendingRows = await db
    .select()
    .from(casinoDailyLossRewardsTable)
    .where(
      and(
        eq(casinoDailyLossRewardsTable.dayKey, previousDayKey),
        eq(casinoDailyLossRewardsTable.status, "pending"),
      ),
    );

  for (const row of pendingRows) {
    const currency = parseCurrency(row.currency, "INR");
    const rewardMinor = Math.floor(
      (row.lossMinor * RACKBACK_RATE_BPS) / 10_000,
    );
    const wallet = await ensureWallet(row.playerId, currency);
    try {
      await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(casinoDailyLossRewardsTable)
          .set({
            rewardMinor,
            status: "claimed",
            claimedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(casinoDailyLossRewardsTable.id, row.id),
              eq(casinoDailyLossRewardsTable.status, "pending"),
            ),
          )
          .returning();
        if (!claimed) return;
        const [updatedWallet] = await tx
          .update(casinoWalletsTable)
          .set({
            balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${rewardMinor}`,
            updatedAt: now,
          })
          .where(eq(casinoWalletsTable.id, wallet.id))
          .returning();
        if (!updatedWallet) throw new Error("RACKBACK_WALLET_UPDATE_FAILED");
        if (rewardMinor > 0) {
          await tx.insert(casinoLedgerEntriesTable).values({
            walletId: wallet.id,
            transactionId: randomUUID(),
            entryType: "rakeback_reward",
            amountMinor: rewardMinor,
            description: `1% daily loss rebate for ${row.dayKey}`,
          });
        }
      });
    } catch (error) {
      logger.error(
        { err: error, playerId: row.playerId, dayKey: row.dayKey },
        "Daily loss rebate distribution failed",
      );
    }
  }
}

type RackbackCardData = {
  name: string;
  inrLoss: string;
  usdLoss: string;
  inrReward: string;
  usdReward: string;
  status: string;
  nextReward: string;
  hoursLeft: string;
};

function applyRolexGoldBlackTheme(svg: string): string {
  const rolexPalette = new Set([
    "#050505", "#080604", "#0a0704", "#0a0805", "#120d08", "#17100a",
    "#1b1007", "#1d1007", "#211408", "#2a1707", "#8a5b16", "#a66d18",
    "#a8731d", "#b6791f", "#b8862e", "#b99650", "#c4a76a", "#c58e2e",
    "#c59437", "#c99b3b", "#d09a2f", "#d1a84f", "#d2b66d", "#d3b468",
    "#d6b86b", "#d99862", "#d29a35", "#e0bd6c", "#e5ad43", "#e5c45f",
    "#e6ad42", "#e7ad42", "#ecd080", "#f0d78d", "#f1b83d", "#f2c95d",
    "#f3cf69", "#f4b72b", "#f5d477", "#f6a91a", "#f6c453", "#f7d66b",
    "#ffe29a", "#ffe38a", "#ffe6a1", "#ffe7a5", "#ffe9a2", "#ffe9a6",
  ]);
  const toRolexColor = (raw: string): string => {
    const normalized = raw.toLowerCase();
    if (rolexPalette.has(normalized)) return normalized;
    const hex = normalized.length === 4
      ? normalized.slice(1).split("").map((digit) => digit + digit).join("")
      : normalized.slice(1);
    const red = Number.parseInt(hex.slice(0, 2), 16);
    const green = Number.parseInt(hex.slice(2, 4), 16);
    const blue = Number.parseInt(hex.slice(4, 6), 16);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    if (luminance < 0.14) return "#050505";
    if (luminance < 0.3) return "#17100a";
    if (luminance < 0.5) return "#8a5b16";
    if (luminance < 0.68) return "#b8862e";
    if (luminance < 0.84) return "#d6b86b";
    return "#fff0bd";
  };
  return svg.replace(/#[0-9a-f]{6}|#[0-9a-f]{3}(?![0-9a-f])/gi, toRolexColor);
}

function rackbackCardSvg(data: RackbackCardData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="820" viewBox="0 0 1200 820">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10182e"/><stop offset="1" stop-color="#183b45"/></linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e5ad43"/><stop offset="1" stop-color="#ffe6a1"/></linearGradient>
  </defs>
  <rect width="1200" height="820" rx="42" fill="url(#bg)"/>
  <circle cx="1080" cy="80" r="210" fill="#f6c453" opacity=".12"/>
  <circle cx="100" cy="760" r="180" fill="#2563eb" opacity=".12"/>
  <rect x="42" y="42" width="1116" height="736" rx="32" fill="none" stroke="#f6c453" stroke-opacity=".38" stroke-width="2"/>
  <text x="86" y="108" fill="#f6c453" font-size="28" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="170" fill="#ffffff" font-size="48" font-family="DejaVu Sans" font-weight="bold">DAILY LOSS REBATE</text>
  <text x="86" y="208" fill="#9db0cb" font-size="22" font-family="DejaVu Sans">1% BACK ON NET LOSS · ${escapeXml(data.name)}</text>
  <rect x="70" y="250" width="500" height="178" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".1"/>
  <rect x="630" y="250" width="500" height="178" rx="24" fill="#f6c453" fill-opacity=".07" stroke="#f6c453" stroke-opacity=".32"/>
  <text x="104" y="296" fill="#8da2bd" font-size="21" font-family="DejaVu Sans" font-weight="bold">TODAY'S LOSS RECORDED</text>
  <text x="104" y="350" fill="#ffffff" font-size="31" font-family="DejaVu Sans" font-weight="bold">INR ${escapeXml(data.inrLoss)}</text>
  <text x="104" y="394" fill="#ffffff" font-size="31" font-family="DejaVu Sans" font-weight="bold">USD ${escapeXml(data.usdLoss)}</text>
  <text x="664" y="296" fill="#8da2bd" font-size="21" font-family="DejaVu Sans" font-weight="bold">LAST DAILY REWARD</text>
  <text x="664" y="350" fill="url(#gold)" font-size="31" font-family="DejaVu Sans" font-weight="bold">INR ${escapeXml(data.inrReward)}</text>
  <text x="664" y="394" fill="url(#gold)" font-size="31" font-family="DejaVu Sans" font-weight="bold">USD ${escapeXml(data.usdReward)}</text>
  <line x1="86" y1="468" x2="1114" y2="468" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="86" y="526" fill="#8da2bd" font-size="22" font-family="DejaVu Sans" font-weight="bold">STATUS</text>
  <text x="310" y="526" fill="#76e3a3" font-size="28" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.status)}</text>
  <text x="86" y="584" fill="#8da2bd" font-size="22" font-family="DejaVu Sans" font-weight="bold">NEXT REWARD</text>
  <text x="310" y="584" fill="#ffffff" font-size="25" font-family="DejaVu Sans">${escapeXml(data.nextReward)}</text>
  <text x="86" y="640" fill="#8da2bd" font-size="22" font-family="DejaVu Sans" font-weight="bold">TIME LEFT</text>
  <text x="310" y="640" fill="#f6c453" font-size="31" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.hoursLeft)}</text>
  <text x="86" y="714" fill="#9db0cb" font-size="18" font-family="DejaVu Sans">Losses record from 00:01 through 23:59. Rewards credit during the 00:00 claim window.</text>
  <text x="86" y="744" fill="#7185a3" font-size="17" font-family="DejaVu Sans">Claim cycle resets daily at 00:01 · Settlement wallets remain separate.</text>
</svg>`;
}

async function rackbackCardPng(data: RackbackCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render daily loss rebate image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(rackbackCardSvg(data)));
  });
}

async function sendRackbackStatus(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  await distributeDueDailyLossRewards();
  const now = new Date();
  const currentDayKey = rackbackDayKey(now);
  const previousDayKey = rackbackPreviousDayKey(now);
  const rows = await db
    .select()
    .from(casinoDailyLossRewardsTable)
    .where(
      and(
        eq(casinoDailyLossRewardsTable.playerId, player.id),
        inArray(casinoDailyLossRewardsTable.dayKey, [
          currentDayKey,
          previousDayKey,
        ]),
      ),
    );
  const currentRows = rows.filter((row) => row.dayKey === currentDayKey);
  const previousRows = rows.filter((row) => row.dayKey === previousDayKey);
  const currentLoss = (currency: Currency): number =>
    currentRows
      .filter((row) => parseCurrency(row.currency, "INR") === currency)
      .reduce((total, row) => total + row.lossMinor, 0);
  const previousReward = (currency: Currency): number =>
    previousRows
      .filter((row) => parseCurrency(row.currency, "INR") === currency)
      .reduce(
        (total, row) =>
          total +
          (row.rewardMinor > 0
            ? row.rewardMinor
            : Math.floor((row.lossMinor * RACKBACK_RATE_BPS) / 10_000)),
        0,
      );
  const claimWindowOpen = rackbackClaimWindowOpen(now);
  const nextClaimAt = rackbackNextClaimAt(now);
  const image = await rackbackCardPng({
    name: player.username ? `@${player.username}` : player.displayName,
    inrLoss: formatMoney(currentLoss("INR"), "INR"),
    usdLoss: formatMoney(currentLoss("USD"), "USD"),
    inrReward: formatMoney(previousReward("INR"), "INR"),
    usdReward: formatMoney(previousReward("USD"), "USD"),
    status: claimWindowOpen ? "CLAIM WINDOW OPEN" : "RECORDING TODAY'S LOSSES",
    nextReward: claimWindowOpen
      ? "Now (00:00–00:01)"
      : nextClaimAt.toLocaleString("en-IN", {
          timeZone: RACKBACK_TIMEZONE,
          dateStyle: "medium",
          timeStyle: "short",
        }),
    hoursLeft: claimWindowOpen
      ? "Open now"
      : rackbackCountdown(now, nextClaimAt),
  });
  await bot.sendPhoto(
    chatId,
    image,
    "<b>💰 Daily loss rebate</b>\n1% of net daily losses is credited automatically at 00:00.",
  );
}

async function sendCurrencyRates(bot: TelegramBot, chatId: number): Promise<void> {
  await refreshDisplayRates();
  const lines = DISPLAY_CURRENCIES.map((item) => {
    const inrPerUnit = 1 / (displayRatesInr[item.code] ?? 1);
    const usdPerUnit = inrPerUnit / INR_PER_USD;
    return `<b>${item.code}</b> — 1 ${item.code} ≈ ₹${inrPerUnit.toFixed(item.code === "IDR" ? 4 : 2)} / $${usdPerUnit.toFixed(4)}`;
  });
  await bot.sendMessage(
    chatId,
    [
      "<b>💱 LIVE CURRENCY RATES</b>",
      "",
      "Reference: 1 unit of each currency compared with INR and USD.",
      "",
      ...lines,
      "",
      "<i>Rates refresh automatically every hour.</i>",
    ].join("\n"),
  );
}

function languageKeyboard(
  selectedLanguage: string,
  ownerTelegramUserId: number,
): { inline_keyboard: InlineKeyboardButton[][] } {
  const rows: InlineKeyboardButton[][] = [];
  for (let index = 0; index < BOT_LANGUAGES.length; index += 2) {
    rows.push(
      BOT_LANGUAGES.slice(index, index + 2).map((language) => ({
        text: `${language.flag} ${language.label}${selectedLanguage === language.code ? " ✓" : ""}`,
        callback_data: ownedCallback(`language:set:${language.code}`, ownerTelegramUserId),
      })),
    );
  }
  return { inline_keyboard: rows };
}

function currencyKeyboard(
  preferredCurrency: DisplayCurrency,
  ownerTelegramUserId: number,
): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  const rows: InlineKeyboardButton[][] = [];
  for (let index = 0; index < DISPLAY_CURRENCIES.length; index += 3) {
    rows.push(
      DISPLAY_CURRENCIES.slice(index, index + 3).map((item) => ({
        text: `${item.code}${preferredCurrency === item.code ? " ✅" : ""}`,
        callback_data: ownedCallback(`currency:set:${item.code}`, ownerTelegramUserId),
      })),
    );
  }
  return {
    inline_keyboard: rows,
  };
}

function currencyMenuText(
  currency: DisplayCurrency,
  balance?: string,
): string {
  return [
    `<b>🔄 Display Currency — ${currency}</b>`,
    `✅ Selected: <b>${currency}</b>`,
    "",
    "Choose the currency shown for your wallet and new bets.",
    "INR and USD remain the only settlement wallets; other currencies are display-only.",
    "",
    balance ?? "",
  ].filter(Boolean).join("\n");
}

async function openCurrencyMenu(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
  currency: DisplayCurrency,
  messageId?: number,
): Promise<void> {
  const keyboard = currencyKeyboard(currency, player.telegramUserId);
  const text = currencyMenuText(currency, await balanceText(player.id, currency));
  if (isPrivateChat({ id: chatId, type: "private" })) {
    if (messageId) {
      await bot.editMessageText(chatId, messageId, text, keyboard);
      currencyMenuMessages.set(player.telegramUserId, { chatId, messageId });
      return;
    }
    const sent = await bot.sendMessage(chatId, text, keyboard);
    currencyMenuMessages.set(player.telegramUserId, {
      chatId,
      messageId: sent.message_id,
    });
    return;
  }

  const existing = currencyMenuMessages.get(player.telegramUserId);
  if (existing) {
    try {
      await bot.editMessageText(existing.chatId, existing.messageId, text, keyboard);
      return;
    } catch (error) {
      logger.debug(
        { err: error, userId: player.telegramUserId },
        "Currency DM menu was not editable; creating a replacement",
      );
      currencyMenuMessages.delete(player.telegramUserId);
    }
  }
  try {
    const sent = await bot.sendMessage(player.telegramUserId, text, keyboard);
    currencyMenuMessages.set(player.telegramUserId, {
      chatId: player.telegramUserId,
      messageId: sent.message_id,
    });
  } catch (error) {
    logger.warn(
      { err: error, userId: player.telegramUserId },
      "Could not deliver currency menu in private chat",
    );
  }
}

async function sendMainWelcome(
  bot: TelegramBot,
  chatId: number,
  helperLinks: Map<string, string>,
  displayName: string,
  privateChat: boolean,
  ownerTelegramUserId: number,
): Promise<void> {
  const caption = [
    `<b>Hey ${escapeTelegramText(displayName)}, welcome to Rolex Casino!</b>`,
    "",
    "Send /help for commands.",
  ].join("\n");
  const menu = mainMenu(helperLinks, ownerTelegramUserId);
  try {
    await bot.sendPhoto(
      chatId,
      await welcomeCardPng({
        name: displayName,
        privateChat,
      }),
      caption,
      menu,
    );
  } catch (error) {
    logger.warn({ err: error, chatId }, "Welcome image delivery failed; sending text fallback");
    await bot.sendMessage(chatId, caption, menu);
  }
}

type WelcomeCardData = {
  name: string;
  privateChat: boolean;
};

function welcomeCardSvg(data: WelcomeCardData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <defs>
    <linearGradient id="welcome-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#050505"/><stop offset=".55" stop-color="#17100a"/><stop offset="1" stop-color="#2a1707"/>
    </linearGradient>
    <linearGradient id="welcome-gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#a66d18"/><stop offset=".5" stop-color="#ffe29a"/><stop offset="1" stop-color="#c58e2e"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="760" rx="42" fill="url(#welcome-bg)"/>
  <circle cx="1050" cy="80" r="230" fill="#d29a35" opacity=".13"/>
  <circle cx="120" cy="700" r="220" fill="#8a5b16" opacity=".14"/>
  <rect x="42" y="42" width="1116" height="676" rx="32" fill="none" stroke="#c59437" stroke-opacity=".7" stroke-width="2"/>
  <path d="M600 88l18 38 42 6-30 29 7 42-37-20-37 20 7-42-30-29 42-6z" fill="#f6c453" opacity=".9"/>
  <text x="600" y="225" text-anchor="middle" fill="#f6c453" font-size="30" font-family="DejaVu Sans" font-weight="bold" letter-spacing="6">ROLEXCASINO</text>
  <text x="600" y="310" text-anchor="middle" fill="#ffffff" font-size="50" font-family="DejaVu Sans" font-weight="bold">WELCOME TO THE TABLE</text>
  <text x="600" y="372" text-anchor="middle" fill="url(#welcome-gold)" font-size="42" font-family="DejaVu Sans" font-weight="bold">${escapeXml(svgLabel(data.name, 26))}</text>
  <line x1="245" y1="418" x2="955" y2="418" stroke="#c59437" stroke-opacity=".55"/>
  <text x="600" y="482" text-anchor="middle" fill="#f0d78d" font-size="30" font-family="DejaVu Sans" font-weight="bold">PLAY DICE · DARTS · SLOTS · BLACKJACK</text>
  <text x="600" y="540" text-anchor="middle" fill="#d6b86b" font-size="24" font-family="DejaVu Sans">${data.privateChat ? "Your private wallet and account center is ready." : "Games are available in the official RolexCasino group."}</text>
  <rect x="350" y="590" width="500" height="66" rx="33" fill="#f6c453" fill-opacity=".14" stroke="#f6c453" stroke-opacity=".8"/>
  <text x="600" y="632" text-anchor="middle" fill="#ffe29a" font-size="26" font-family="DejaVu Sans" font-weight="bold">SEND /HELP FOR COMMANDS</text>
</svg>`;
}

async function welcomeCardPng(data: WelcomeCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render welcome image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(welcomeCardSvg(data)));
  });
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
      "<b>/rates</b> — compare all supported currencies with INR and USD",
      "<b>/language</b> — choose English, हिन्दी, Español, Русский, বাংলা, العربية, தமிழ், or తెలుగు",
      "<b>/setwallet</b> — save a payout destination",
      "<b>/refer</b> — get your verified referral link and rewards",
      "<b>/daily</b> — check your bot-selected daily bonus result",
      "<b>/rackback</b> — view your daily loss rebate status",
      "<b>/weeklybonus</b> — check your bot-selected weekly bonus result",
      "<b>/global</b> — all-time top 10 by wager",
      "<b>/weekly</b> — top 10 by wager in the last 7 days",
      "<b>/monthly</b> — top 10 by wager in the last 30 days",
      "<b>/giveaway</b> — see the latest giveaway and giveaway-bot commands",
      "<b>/mygames</b> — view your latest 10 rounds",
      "<b>/stats</b> — view your performance card",
      "",
      "<b>Games:</b> /dice /slots /darts /basket /bowling /football /basketball /coin /roul /7up /limbo /mines /minesauto /blackjack",
      "<b>Battles:</b> use a game command with <b>pvp</b> or <b>pvb</b>, for example <code>/dice pvp 1d1w 10 USD</code>.",
      "",
      `<b>Game minimums:</b> Dice ${diceMinimum}; Slots ${slotsMinimum}. Use /games for every game.`,
      "<b>Battle format:</b> 1d1w, 2d2w, or 3d3w = game emojis per round and round wins. Add <b>crazy</b> for lowest-score-wins.",
      "",
      "Use the buttons below or send a command to continue.",
    ].join("\n"),
    {
      inline_keyboard: [[
        { text: "🎮 Games", callback_data: ownedCallback("main:games", ownerTelegramUserId) },
        { text: "🎧 Support", callback_data: ownedCallback("main:support", ownerTelegramUserId) },
      ], [
        { text: "❔ How to play", callback_data: ownedCallback("main:how", ownerTelegramUserId) },
        { text: "📜 Terms", callback_data: ownedCallback("main:terms", ownerTelegramUserId) },
      ]],
    },
  );
}

async function sendHowToPlay(bot: TelegramBot, chatId: number): Promise<void> {
  await bot.sendMessage(
    chatId,
    [
      "<b>❔ HOW TO PLAY</b>",
      "",
      "<b>1.</b> Fund your wallet privately with /deposit or receive a verified CC Wallet tip.",
      "<b>2.</b> Open /games and choose a supported game in the official RolexCasino group.",
      "<b>3.</b> Use a supported amount and currency, then follow the game buttons or prompts.",
      "<b>4.</b> Payouts and wager progress are settled automatically. Use /wagerstatus for your card.",
      "<b>5.</b> For PVP, reply to a player. For PVB, choose the bot mode where available.",
      "",
      "<b>Fairness:</b> Every completed result includes a Fair ID that can be checked with /fair.",
    ].join("\n"),
  );
}

async function sendGameTerms(bot: TelegramBot, chatId: number): Promise<void> {
  await bot.sendMessage(
    chatId,
    [
      "<b>📜 ROLEXCASINO TERMS</b>",
      "",
      "<b>•</b> Games are available only in the official RolexCasino group.",
      "<b>•</b> Never share your wallet destination, screenshots, or private account details in public chats.",
      "<b>•</b> A withdrawal may remain locked until the displayed 1× wagering requirement is complete.",
      "<b>•</b> Results are final after settlement. Duplicate, replayed, or invalid game messages are rejected.",
      "<b>•</b> PVP/PVB rooms must be completed before stakes are settled; expired rooms follow the displayed cancellation rules.",
      "<b>•</b> Play responsibly and only use funds you can afford to lose.",
    ].join("\n"),
  );
}

async function sendProfile(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  const [inrWallet, usdWallet] = await Promise.all([
    ensureWallet(player.id, "INR"),
    ensureWallet(player.id, "USD"),
  ]);
  const avatarDataUri = await bot.getUserProfilePhoto(player.telegramUserId);
  const image = await profileCardPng({
    name: player.displayName,
    username: player.username ? `@${player.username}` : "not set",
    playerId: String(player.telegramUserId),
    preferredCurrency: parseDisplayCurrency(player.preferredCurrency, "USD"),
    payoutWallet: maskPayoutWallet(player.payoutWallet),
    referralCode: player.referralCode ?? "not set",
    inrBalance: formatMoney(inrWallet.balanceMinor, "INR"),
    usdBalance: formatMoney(usdWallet.balanceMinor, "USD"),
    avatarDataUri,
  });
  await bot.sendPhoto(
    chatId,
    image,
    `👤 ${escapeTelegramText(player.username ? `@${player.username}` : player.displayName)} · Profile`,
  );
}

type ProfileCardData = {
  name: string;
  username: string;
  playerId: string;
  preferredCurrency: DisplayCurrency;
  payoutWallet: string;
  referralCode: string;
  inrBalance: string;
  usdBalance: string;
  avatarDataUri: string | null;
};

function profileCardSvg(data: ProfileCardData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <defs>
    <linearGradient id="profile-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#080d19"/><stop offset=".55" stop-color="#151a2c"/><stop offset="1" stop-color="#252b43"/>
    </linearGradient>
    <linearGradient id="profile-gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e7ad42"/><stop offset="1" stop-color="#ffe6a1"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="760" rx="42" fill="url(#profile-bg)"/>
  <circle cx="1080" cy="80" r="210" fill="#6e83ff" opacity=".16"/>
  <circle cx="70" cy="730" r="250" fill="#f6c453" opacity=".08"/>
  <rect x="42" y="42" width="1116" height="676" rx="32" fill="none" stroke="#7184cf" stroke-opacity=".6" stroke-width="2"/>
  <text x="86" y="112" fill="#8ea6ff" font-size="28" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  ${svgAvatar(data.avatarDataUri, 150, 188, 82, data.name, "#7184cf")}
  <text x="275" y="178" fill="#ffffff" font-size="52" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(svgLabel(data.name, 22))}</text>
  <text x="275" y="220" fill="#aeb9df" font-size="25" font-family="DejaVu Sans, sans-serif" letter-spacing="2">PLAYER PROFILE · ACCOUNT CARD</text>
  <rect x="900" y="182" width="205" height="46" rx="23" fill="#70e59a" fill-opacity=".16" stroke="#70e59a" stroke-opacity=".7"/>
  <text x="1002" y="212" text-anchor="middle" fill="#70e59a" font-size="18" font-family="DejaVu Sans, sans-serif" font-weight="bold">ACCOUNT ACTIVE</text>
  <rect x="900" y="88" width="205" height="70" rx="35" fill="#f6c453" fill-opacity=".18" stroke="#f6c453" stroke-opacity=".8" stroke-width="2"/>
  <text x="1002" y="133" text-anchor="middle" fill="#f6c453" font-size="27" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.preferredCurrency)}</text>
  <line x1="86" y1="276" x2="1114" y2="276" stroke="#7184cf" stroke-opacity=".35"/>
  <text x="86" y="326" fill="#8da2bd" font-size="21" font-family="DejaVu Sans, sans-serif" font-weight="bold">USERNAME</text>
  <text x="86" y="364" fill="#ffffff" font-size="28" font-family="DejaVu Sans, sans-serif">${escapeXml(svgLabel(data.username, 30))}</text>
  <text x="510" y="326" fill="#8da2bd" font-size="21" font-family="DejaVu Sans, sans-serif" font-weight="bold">PLAYER ID</text>
  <text x="510" y="364" fill="#ffffff" font-size="28" font-family="DejaVu Sans, sans-serif">${escapeXml(svgLabel(data.playerId, 22))}</text>
  <rect x="70" y="410" width="500" height="150" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#7184cf" stroke-opacity=".55"/>
  <rect x="626" y="410" width="500" height="150" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#7184cf" stroke-opacity=".55"/>
  <rect x="70" y="410" width="500" height="8" rx="4" fill="#7184cf"/>
  <rect x="626" y="410" width="500" height="8" rx="4" fill="#e56d86"/>
  <text x="104" y="456" fill="#8da2bd" font-size="22" font-family="DejaVu Sans, sans-serif" font-weight="bold">INR WALLET</text>
  <text x="104" y="516" fill="url(#profile-gold)" font-size="42" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.inrBalance)}</text>
  <text x="660" y="456" fill="#8da2bd" font-size="22" font-family="DejaVu Sans, sans-serif" font-weight="bold">USD WALLET</text>
  <text x="660" y="516" fill="url(#profile-gold)" font-size="42" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.usdBalance)}</text>
  <text x="86" y="612" fill="#8da2bd" font-size="21" font-family="DejaVu Sans, sans-serif" font-weight="bold">REFERRAL CODE</text>
  <text x="86" y="650" fill="#ffffff" font-size="27" font-family="DejaVu Sans, sans-serif">${escapeXml(svgLabel(data.referralCode, 30))}</text>
  <text x="510" y="612" fill="#8da2bd" font-size="21" font-family="DejaVu Sans, sans-serif" font-weight="bold">PAYOUT WALLET</text>
  <text x="510" y="650" fill="#ffffff" font-size="27" font-family="DejaVu Sans, sans-serif">${escapeXml(svgLabel(data.payoutWallet, 32))}</text>
  <text x="86" y="692" fill="#7185a3" font-size="18" font-family="DejaVu Sans, sans-serif">INR and USD are settlement wallets · balances shown separately for clarity</text>
</svg>`;
}

async function profileCardPng(data: ProfileCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render profile image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(profileCardSvg(data)));
  });
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
  const preferredCurrency = parseDisplayCurrency(player.preferredCurrency, "USD");
  await bot.sendMessage(
    chatId,
    [
      "<b>🏦 Your Wallet</b>",
      "",
      await balanceText(player.id, preferredCurrency),
      "",
      `👨‍💻 Payout wallet: ${maskPayoutWallet(player.payoutWallet)}`,
      "⚠️ Promo Lock: wagering must be completed before withdrawal.",
      "📈 Use /wagerstatus to track your remaining wager.",
      "Minimum withdrawal: ₹100 or $1.00",
    ].join("\n"),
    currencyKeyboard(
      preferredCurrency,
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
  const lossRate = currencyStats.rounds
    ? Math.round((currencyStats.losses / currencyStats.rounds) * 100)
    : 0;
  const gameTypes = [...new Set([
    ...rounds
      .filter((round) => round.currency === currency)
      .map((round) => round.gameType.toUpperCase()),
    ...battles
      .filter((battle) => battle.currency === currency)
      .map((battle) => battle.gameType.toUpperCase()),
  ])].sort().join(", ") || "—";
  const joined = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeZone: "Asia/Kolkata",
  }).format(new Date(player.createdAt));
  const image = await statsCardPng({
    name: player.username ? `@${player.username}` : player.displayName,
    joined,
    currency,
    totalWager: formatMoney(currencyStats.wagerMinor, currency),
    totalProfit: formatMoney(currencyStats.profitMinor, currency),
    category: stats.category,
    rounds: currencyStats.rounds,
    winRate,
    lossRate,
    gameTypes,
  });
  await bot.sendPhoto(
    chatId,
    image,
    `📊 ${player.username ? `@${player.username}` : player.displayName} · ${stats.category} · Total wager ${formatMoney(currencyStats.wagerMinor, currency)}`,
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
  lossRate: number;
  gameTypes: string;
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

function svgLabel(value: string, maxLength = 24): string {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(1, maxLength - 1))}…`
    : value;
}

function svgAvatar(
  dataUri: string | null | undefined,
  cx: number,
  cy: number,
  radius: number,
  fallback: string,
  stroke: string,
): string {
  const safeFallback = escapeXml(svgLabel(fallback.trim().slice(0, 2).toUpperCase() || "?", 2));
  const fallbackMarkup = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#c3e9ee"/><text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="#07505b" font-size="${Math.round(radius * 0.72)}" font-family="DejaVu Sans" font-weight="bold">${safeFallback}</text>`;
  const imageMarkup = dataUri
    ? `<clipPath id="avatar-clip-${cx}-${cy}"><circle cx="${cx}" cy="${cy}" r="${radius - 3}"/></clipPath><image href="${escapeXml(dataUri)}" x="${cx - radius + 3}" y="${cy - radius + 3}" width="${(radius - 3) * 2}" height="${(radius - 3) * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip-${cx}-${cy})"/>`
    : fallbackMarkup;
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#c3e9ee" stroke="${stroke}" stroke-width="5"/>${imageMarkup}`;
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
  <text x="86" y="112" fill="#f6c453" font-size="28" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="184" fill="#ffffff" font-size="54" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(svgLabel(data.name, 22))}</text>
  <text x="86" y="226" fill="#9db0cb" font-size="25" font-family="DejaVu Sans, sans-serif" letter-spacing="2">PLAYER PROFILE · PERFORMANCE</text>
  <rect x="900" y="88" width="205" height="70" rx="35" fill="${categoryColor}" fill-opacity=".18" stroke="${categoryColor}" stroke-opacity=".8" stroke-width="2"/>
  <text x="1002" y="133" text-anchor="middle" fill="${categoryColor}" font-size="28" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.category)}</text>
  <text x="86" y="286" fill="#8da2bd" font-size="23" font-family="DejaVu Sans, sans-serif" font-weight="bold">MEMBER SINCE</text>
  <text x="86" y="326" fill="#ffffff" font-size="30" font-family="DejaVu Sans, sans-serif">${escapeXml(data.joined)}</text>
  <line x1="86" y1="362" x2="1114" y2="362" stroke="#ffffff" stroke-opacity=".14"/>
  <rect x="70" y="382" width="500" height="180" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".1"/>
  <rect x="626" y="382" width="500" height="180" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".1"/>
  <text x="104" y="428" fill="#8da2bd" font-size="22" font-family="DejaVu Sans, sans-serif" font-weight="bold">TOTAL WAGER · ${data.currency}</text>
  <text x="104" y="492" fill="url(#accent)" font-size="48" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.totalWager)}</text>
  <text x="660" y="428" fill="#8da2bd" font-size="22" font-family="DejaVu Sans, sans-serif" font-weight="bold">TOTAL PROFIT · ${data.currency}</text>
  <text x="660" y="492" fill="#76e3a3" font-size="48" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.totalProfit)}</text>
  <text x="104" y="542" fill="#8da2bd" font-size="21" font-family="DejaVu Sans, sans-serif">MATCHES <tspan fill="#ffffff" font-size="30" font-weight="bold">${data.rounds}</tspan> · WIN <tspan fill="#76e3a3" font-size="30" font-weight="bold">${data.winRate}%</tspan> · LOSS <tspan fill="#ff8d9b" font-size="30" font-weight="bold">${data.lossRate}%</tspan></text>
  <text x="104" y="600" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif">GAME TYPES · <tspan fill="#ffffff">${escapeXml(svgLabel(data.gameTypes, 76))}</tspan></text>
  <text x="86" y="640" fill="#7185a3" font-size="18" font-family="DejaVu Sans, sans-serif">VIP category starts at ₹1,00,000 total wager equivalent · RolexCasino player profile</text>
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
    process.stdin.end(applyRolexGoldBlackTheme(statsCardSvg(data)));
  });
}

type WagerStatusCardData = {
  name: string;
  currency: Currency;
  required: string;
  completed: string;
  remaining: string;
  progressPercent: number;
  isComplete: boolean;
};

function wagerStatusCardSvg(data: WagerStatusCardData): string {
  const statusColor = data.isComplete ? "#76e3a3" : "#f6c453";
  const progressWidth = Math.round(880 * (data.progressPercent / 100));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <defs>
    <linearGradient id="wager-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1428"/><stop offset="1" stop-color="#1a2d4d"/>
    </linearGradient>
    <linearGradient id="wager-gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e6ad42"/><stop offset="1" stop-color="#ffe7a5"/>
    </linearGradient>
    <linearGradient id="wager-progress" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#d99b32"/><stop offset="1" stop-color="${statusColor}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="760" rx="44" fill="url(#wager-bg)"/>
  <circle cx="1060" cy="86" r="210" fill="#f6c453" opacity=".09"/>
  <circle cx="82" cy="710" r="230" fill="#3b82f6" opacity=".11"/>
  <rect x="38" y="38" width="1124" height="684" rx="34" fill="none" stroke="#ffffff" stroke-opacity=".15"/>
  <text x="84" y="112" fill="#f6c453" font-size="28" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="84" y="184" fill="#ffffff" font-size="54" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(svgLabel(data.name, 24))}</text>
  <text x="84" y="226" fill="#9db0cb" font-size="24" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="2">WITHDRAWAL WAGER STATUS · ${data.currency}</text>
  <rect x="906" y="88" width="208" height="72" rx="36" fill="${statusColor}" fill-opacity=".16" stroke="${statusColor}" stroke-opacity=".9" stroke-width="2"/>
  <text x="1010" y="134" text-anchor="middle" fill="${statusColor}" font-size="26" font-family="DejaVu Sans, sans-serif" font-weight="bold">${data.isComplete ? "COMPLETE" : `${data.progressPercent}% DONE`}</text>
  <line x1="84" y1="278" x2="1116" y2="278" stroke="#ffffff" stroke-opacity=".14"/>
  <rect x="72" y="312" width="1056" height="152" rx="26" fill="#ffffff" fill-opacity=".05" stroke="#ffffff" stroke-opacity=".1"/>
  <text x="108" y="358" fill="#8da2bd" font-size="22" font-family="DejaVu Sans, sans-serif" font-weight="bold">PROGRESS</text>
  <rect x="108" y="386" width="880" height="28" rx="14" fill="#07101f" stroke="#ffffff" stroke-opacity=".12"/>
  <rect x="108" y="386" width="${progressWidth}" height="28" rx="14" fill="url(#wager-progress)"/>
  <text x="1020" y="409" text-anchor="end" fill="#ffffff" font-size="24" font-family="DejaVu Sans, sans-serif" font-weight="bold">${data.progressPercent}%</text>
  <rect x="72" y="500" width="324" height="142" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".1"/>
  <rect x="438" y="500" width="324" height="142" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".1"/>
  <rect x="804" y="500" width="324" height="142" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".1"/>
  <text x="108" y="544" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">REQUIRED · 1×</text>
  <text x="108" y="600" fill="url(#wager-gold)" font-size="34" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.required)}</text>
  <text x="474" y="544" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">COMPLETED</text>
  <text x="474" y="600" fill="#76e3a3" font-size="34" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.completed)}</text>
  <text x="840" y="544" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">REMAINING</text>
  <text x="840" y="600" fill="${statusColor}" font-size="34" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.remaining)}</text>
  <text x="84" y="690" fill="#7185a3" font-size="18" font-family="DejaVu Sans, sans-serif">${data.isComplete ? "Your wallet is eligible for withdrawal review." : "Play eligible casino rounds to complete the requirement before withdrawal."}</text>
</svg>`;
}

async function wagerStatusCardPng(data: WagerStatusCardData): Promise<Buffer> {
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
        reject(
          new Error(
            `Could not render wager status image: ${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
      }
    });
    process.stdin.end(applyRolexGoldBlackTheme(wagerStatusCardSvg(data)));
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
  const wins = rounds.filter((round) => round.outcome === "WIN").length;
  const losses = rounds.filter((round) => round.outcome === "LOSS").length;
  const ties = rounds.filter((round) => round.outcome === "TIE").length;
  const rows = rounds
    .map((round, index) => {
      const color =
        round.outcome === "WIN"
          ? "#f6c453"
          : round.outcome === "TIE"
            ? "#d6b86b"
            : "#ff8291";
      const date = new Date(round.createdAt).toLocaleDateString("en-IN");
      const y = 350 + index * 53;
      return [
        `<rect x="56" y="${y - 31}" width="1088" height="44" rx="14" fill="#ffffff" fill-opacity=".045" stroke="#c59437" stroke-opacity=".16"/>`,
        `<text x="82" y="${y}" fill="#ffffff" font-size="23" font-family="DejaVu Sans, sans-serif" font-weight="bold">${index + 1}. ${escapeXml(svgLabel(round.gameType.toUpperCase(), 15))}</text>`,
        `<text x="390" y="${y}" fill="#d6b86b" font-size="21" font-family="DejaVu Sans, sans-serif">${escapeXml(round.currency)} ${escapeXml(formatMoney(round.stakeMinor, round.currency as Currency))}</text>`,
        `<rect x="650" y="${y - 24}" width="128" height="31" rx="15" fill="${color}" fill-opacity=".15" stroke="${color}" stroke-opacity=".55"/>`,
        `<text x="714" y="${y - 2}" text-anchor="middle" fill="${color}" font-size="18" font-family="DejaVu Sans, sans-serif" font-weight="bold">${round.outcome}</text>`,
        `<text x="840" y="${y}" fill="#c4a76a" font-size="20" font-family="DejaVu Sans, sans-serif">${escapeXml(date)}</text>`,
      ].join("");
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="920" viewBox="0 0 1200 920">
  <defs><linearGradient id="historyBg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#050505"/><stop offset=".6" stop-color="#17100a"/><stop offset="1" stop-color="#2a1707"/>
  </linearGradient></defs>
  <rect width="1200" height="920" rx="42" fill="url(#historyBg)"/>
  <circle cx="1080" cy="90" r="220" fill="#d29a35" opacity=".1"/>
  <circle cx="90" cy="850" r="180" fill="#8a5b16" opacity=".12"/>
  <rect x="42" y="42" width="1116" height="836" rx="32" fill="none" stroke="#c59437" stroke-opacity=".62"/>
  <text x="70" y="105" fill="#f6c453" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="4">ROLEXCASINO</text>
  <text x="70" y="164" fill="#ffffff" font-size="48" font-family="DejaVu Sans, sans-serif" font-weight="bold">GAME HISTORY</text>
  <text x="70" y="207" fill="#d6b86b" font-size="23" font-family="DejaVu Sans, sans-serif">${escapeXml(svgLabel(name, 28))} · LAST ${rounds.length} RESULTS</text>
  <rect x="70" y="232" width="1030" height="58" rx="18" fill="#f6c453" fill-opacity=".08" stroke="#c59437" stroke-opacity=".32"/>
  <text x="110" y="269" fill="#ffe29a" font-size="20" font-family="DejaVu Sans, sans-serif" font-weight="bold">WINS ${wins}</text>
  <text x="380" y="269" fill="#d6b86b" font-size="20" font-family="DejaVu Sans, sans-serif" font-weight="bold">TIES ${ties}</text>
  <text x="650" y="269" fill="#c4a76a" font-size="20" font-family="DejaVu Sans, sans-serif" font-weight="bold">LOSSES ${losses}</text>
  <text x="82" y="322" fill="#b99650" font-size="18" font-family="DejaVu Sans, sans-serif" font-weight="bold">GAME</text>
  <text x="390" y="322" fill="#b99650" font-size="18" font-family="DejaVu Sans, sans-serif" font-weight="bold">STAKE</text>
  <text x="650" y="322" fill="#b99650" font-size="18" font-family="DejaVu Sans, sans-serif" font-weight="bold">RESULT</text>
  <text x="840" y="322" fill="#b99650" font-size="18" font-family="DejaVu Sans, sans-serif" font-weight="bold">DATE</text>
  ${rows}
  <text x="70" y="870" fill="#8f713d" font-size="17" font-family="DejaVu Sans, sans-serif">RolexCasino verified game activity · All amounts shown in settlement currency</text>
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
    process.stdin.end(applyRolexGoldBlackTheme(gameHistoryCardSvg(name, rounds)));
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
        const y = 286 + index * 50;
        return [
          `<rect x="60" y="${y - 32}" width="1080" height="42" rx="14" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".08"/>`,
          `<text x="86" y="${y}" fill="#f6c453" font-size="27" font-family="DejaVu Sans, sans-serif" font-weight="bold">${item.rank}</text>`,
          `<text x="165" y="${y}" fill="#ffffff" font-size="27" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(svgLabel(item.name, 25))}</text>`,
          `<text x="800" y="${y}" text-anchor="end" fill="#76e3a3" font-size="26" font-family="DejaVu Sans, sans-serif" font-weight="bold">${item.referrals}</text>`,
          `<text x="1100" y="${y}" text-anchor="end" fill="#dbe7f5" font-size="24" font-family="DejaVu Sans, sans-serif">${escapeXml(item.earnings)}</text>`,
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
  <text x="78" y="174" fill="#ffffff" font-size="46" font-family="DejaVu Sans, sans-serif" font-weight="bold">REFERRAL LEADERBOARD</text>
  <text x="78" y="214" fill="#9db0cb" font-size="23" font-family="DejaVu Sans, sans-serif" letter-spacing="2">VERIFIED INVITES · TOP 10 PLAYERS</text>
  <text x="165" y="252" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">PLAYER</text>
  <text x="800" y="252" text-anchor="end" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">REFERRALS</text>
  <text x="1100" y="252" text-anchor="end" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">EARNED (INR)</text>
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
    process.stdin.end(applyRolexGoldBlackTheme(referralLeaderboardSvg(items)));
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
  const referralLink = privateBotUrl(
    bot,
    `ref_${player.referralCode ?? referralCodeFor(player.telegramUserId)}`,
  );
  await bot.sendMessage(
    chatId,
    [
      "<b>🤝 ROLEXCASINO REFERRAL CENTER</b>",
      "",
      `Hey <b>${escapeTelegramText(player.username ? `@${player.username}` : player.displayName)}</b>, welcome to your referral center.`,
      "",
      `<b>Your verified referral link:</b>\n${referralLink}`,
      "",
      "<b>Rewards per verified referral</b>",
      "• ₹5.00 credited to your INR wallet",
      "• $0.05 credited to your USD wallet",
      "",
      `Verified referrals: <b>${referrals.length}</b>`,
      `INR referral earnings: <b>₹${(player.referralEarningsMinor / 100).toFixed(2)}</b>`,
      "<i>Your reward is released automatically when a new user opens the bot through this link for the first time.</i>",
    ].join("\n"),
  );
}

async function rewardSuccessfulReferral(
  referrer: typeof casinoPlayersTable.$inferSelect,
  referredPlayerId: number,
): Promise<
  | false
  | {
      inrBalanceMinor: number;
      usdBalanceMinor: number;
    }
> {
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
        description: `Verified referral bonus $0.05 from ${referrer.id}`,
      },
    ]);
    for (const [wallet, amountMinor] of [
      [inrWallet, REFERRAL_BONUS_MINOR.INR],
      [usdWallet, REFERRAL_BONUS_MINOR.USD],
    ] as const) {
      await tx
        .insert(casinoWagerRequirementsTable)
        .values({
          playerId: referrer.id,
          currency: wallet.currency,
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
    await tx
      .update(casinoPlayersTable)
      .set({
        referralEarningsMinor: sql`${casinoPlayersTable.referralEarningsMinor} + ${REFERRAL_BONUS_MINOR.INR}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoPlayersTable.id, referrer.id));
    return {
      inrBalanceMinor: updatedInr.balanceMinor,
      usdBalanceMinor: updatedUsd.balanceMinor,
    };
  });
}

type JackpotCardParticipant = {
  username: string;
  contributionMinor: number;
  chancePercent: number;
};

type JackpotCardData = {
  currency: Currency;
  pool: string;
  totalContribution: string;
  participantCount: number;
  drawAt: string;
  participants: JackpotCardParticipant[];
};

function jackpotCardSvg(data: JackpotCardData): string {
  const rows = data.participants
    .slice(0, 10)
    .map((participant, index) => {
      const y = 425 + index * 35;
      return [
        `<rect x="74" y="${y - 27}" width="1052" height="38" rx="13" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".08"/>`,
        `<text x="98" y="${y}" fill="#ffffff" font-size="22" font-family="DejaVu Sans, sans-serif" font-weight="bold">${index + 1}. ${escapeXml(participant.username)}</text>`,
        `<text x="720" y="${y}" text-anchor="end" fill="#f6c453" font-size="21" font-family="DejaVu Sans, sans-serif">${escapeXml(formatMoney(participant.contributionMinor, data.currency))}</text>`,
        `<text x="1095" y="${y}" text-anchor="end" fill="#76e3a3" font-size="21" font-family="DejaVu Sans, sans-serif" font-weight="bold">${participant.chancePercent.toFixed(1)}%</text>`,
      ].join("");
    })
    .join("");
  const footer = data.participantCount > data.participants.length
    ? `+ ${data.participantCount - data.participants.length} more participants`
    : `Draw: ${data.drawAt}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="860" viewBox="0 0 1200 860">
  <defs>
    <linearGradient id="jackpot-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101a31"/><stop offset="1" stop-color="#281b42"/>
    </linearGradient>
    <linearGradient id="jackpot-gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e5ad43"/><stop offset="1" stop-color="#ffe6a1"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="860" rx="42" fill="url(#jackpot-bg)"/>
  <circle cx="1060" cy="80" r="190" fill="#f6c453" opacity=".12"/>
  <circle cx="90" cy="790" r="200" fill="#7c3aed" opacity=".14"/>
  <rect x="42" y="42" width="1116" height="776" rx="32" fill="none" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="86" y="108" fill="#f6c453" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="172" fill="#ffffff" font-size="46" font-family="DejaVu Sans, sans-serif" font-weight="bold">${data.currency} DAILY JACKPOT</text>
  <text x="86" y="218" fill="#9db0cb" font-size="22" font-family="DejaVu Sans, sans-serif" letter-spacing="1">BOT-SELECTED WINNER · CONTRIBUTION-WEIGHTED CHANCES</text>
  <rect x="70" y="242" width="430" height="100" rx="22" fill="#f6c453" fill-opacity=".08" stroke="#f6c453" stroke-opacity=".35"/>
  <text x="96" y="278" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">CURRENT POOL</text>
  <text x="96" y="322" fill="url(#jackpot-gold)" font-size="43" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.pool)}</text>
  <text x="560" y="274" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">TOTAL CONTRIBUTION</text>
  <text x="560" y="320" fill="#ffffff" font-size="31" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(data.totalContribution)}</text>
  <text x="900" y="274" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">PLAYERS</text>
  <text x="900" y="320" fill="#ffffff" font-size="31" font-family="DejaVu Sans, sans-serif" font-weight="bold">${data.participantCount}</text>
  <line x1="86" y1="344" x2="1114" y2="344" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="98" y="390" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">JOINED USERNAME</text>
  <text x="720" y="390" text-anchor="end" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">CONTRIBUTION</text>
  <text x="1095" y="390" text-anchor="end" fill="#8da2bd" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">WIN CHANCE</text>
  ${rows}
  <text x="92" y="780" fill="#9db0cb" font-size="17" font-family="DejaVu Sans, sans-serif">${escapeXml(footer)}</text>
  <text x="92" y="805" fill="#7185a3" font-size="15" font-family="DejaVu Sans, sans-serif">Every eligible bet adds 0.5%. The winner is chosen by the bot at the scheduled draw.</text>
</svg>`;
}

async function jackpotCardPng(data: JackpotCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render jackpot image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(jackpotCardSvg(data)));
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
  const lines = [
    "✨ <b>ROLEXCASINO DAILY JACKPOT</b> ✨",
    "",
    "The bot selects the winner automatically. Users and admins cannot choose the winner.",
    "",
  ];
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
    const totalContribution = participants.reduce(
      (total, participant) => total + participant.contributionMinor,
      0,
    );
    const cardParticipants = participants
      .map((participant) => ({
        username: playerNames.get(participant.playerId) ?? "Player",
        contributionMinor: participant.contributionMinor,
        chancePercent: totalContribution > 0
          ? (participant.contributionMinor / totalContribution) * 100
          : participants.length > 0 ? 100 / participants.length : 0,
      }))
      .sort((left, right) => right.contributionMinor - left.contributionMinor);
    try {
      const image = await jackpotCardPng({
        currency: jackpot.currency as Currency,
        pool: formatMoney(jackpot.poolMinor, jackpot.currency as Currency),
        totalContribution: formatMoney(totalContribution, jackpot.currency as Currency),
        participantCount: participants.length,
        drawAt: jackpot.drawAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        participants: cardParticipants,
      });
      await bot.sendPhoto(
        chatId,
        image,
        `<b>${jackpot.currency} jackpot details</b>\nPool: <b>${formatMoney(jackpot.poolMinor, jackpot.currency as Currency)}</b>\nJoined players: <b>${participants.length}</b>`,
      );
    } catch (error) {
      logger.error({ err: error, currency: jackpot.currency }, "Jackpot image generation failed");
      await bot.sendMessage(
        chatId,
        `<b>${jackpot.currency} jackpot details</b>\nImage generation is temporarily unavailable; the full participant and chance details are shown in the summary below.`,
      );
    }
    lines.push(
      `<b>${jackpot.currency}</b>`,
      `💰 Current Pool: <b>${formatMoney(jackpot.poolMinor, jackpot.currency as Currency)}</b>`,
      `🎁 Players: ${participants.length}`,
      `📊 Total contribution: <b>${formatMoney(totalContribution, jackpot.currency as Currency)}</b>`,
      "📊 Each eligible bet contributes 0.5%",
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

function selectJackpotWinner(
  participants: Array<{ playerId: number; contributionMinor: number }>,
): { playerId: number } {
  const totalContribution = participants.reduce(
    (total, participant) => total + Math.max(0, participant.contributionMinor),
    0,
  );
  if (totalContribution <= 0) {
    return participants[randomInt(participants.length)];
  }
  let ticket = randomInt(totalContribution) + 1;
  for (const participant of participants) {
    ticket -= Math.max(0, participant.contributionMinor);
    if (ticket <= 0) return participant;
  }
  return participants.at(-1) ?? participants[0];
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
    const winner = selectJackpotWinner(participants);
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
      "🎉 <b>DAILY JACKPOT WINNER</b>",
      `Currency: ${jackpot.currency}`,
      `Prize: <b>${formatMoney(jackpot.poolMinor, jackpot.currency as Currency)}</b>`,
      `Winner: <b>${escapeTelegramText(winnerPlayer?.username ? `@${winnerPlayer.username}` : winnerPlayer?.displayName ?? "Player")}</b>`,
      "The winner was selected automatically by the bot.",
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
  const [[requirement], [player]] = await Promise.all([
    db
      .select()
      .from(casinoWagerRequirementsTable)
      .where(
        and(
          eq(casinoWagerRequirementsTable.playerId, playerId),
          eq(casinoWagerRequirementsTable.currency, currency),
        ),
      )
      .limit(1),
    db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.id, playerId))
      .limit(1),
  ]);
  const remaining = requirement
    ? Math.max(0, requirement.requiredMinor - requirement.completedMinor)
    : 0;
  const requiredMinor = requirement?.requiredMinor ?? 0;
  const completedMinor = requirement?.completedMinor ?? 0;
  const progressPercent =
    requiredMinor > 0
      ? Math.min(100, Math.round((completedMinor / requiredMinor) * 100))
      : 100;
  const image = await wagerStatusCardPng({
    name: player?.username ? `@${player.username}` : player?.displayName ?? "Player",
    currency,
    required: formatMoney(requiredMinor, currency),
    completed: formatMoney(completedMinor, currency),
    remaining: formatMoney(remaining, currency),
    progressPercent,
    isComplete: remaining <= 0,
  });
  await bot.sendPhoto(
    chatId,
    image,
    `<b>🎯 WAGER STATUS · ${currency}</b>\n${remaining > 0 ? "Complete gameplay wagering before requesting a withdrawal." : "No active wagering restriction for this currency."}`,
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

type TipCardData = {
  status: string;
  from: string;
  to: string;
  amount: string;
  currency: Currency;
  balance: string;
  fairId: string;
  note: string;
};

function tipCardSvg(data: TipCardData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <defs>
    <linearGradient id="tip-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#050505"/><stop offset=".55" stop-color="#17100a"/><stop offset="1" stop-color="#2a1707"/></linearGradient>
    <linearGradient id="tip-gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b6791f"/><stop offset=".5" stop-color="#ffe29a"/><stop offset="1" stop-color="#c58e2e"/></linearGradient>
  </defs>
  <rect width="1200" height="760" rx="42" fill="url(#tip-bg)"/>
  <circle cx="1080" cy="80" r="220" fill="#d29a35" opacity=".12"/><circle cx="90" cy="710" r="210" fill="#8a5b16" opacity=".14"/>
  <rect x="42" y="42" width="1116" height="676" rx="32" fill="none" stroke="#c59437" stroke-opacity=".7" stroke-width="2"/>
  <text x="86" y="108" fill="#f6c453" font-size="28" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="180" fill="#ffffff" font-size="54" font-family="DejaVu Sans" font-weight="bold">PLAYER TIP</text>
  <rect x="842" y="82" width="270" height="58" rx="29" fill="#f6c453" fill-opacity=".16" stroke="#f6c453" stroke-opacity=".8"/>
  <text x="977" y="120" text-anchor="middle" fill="#ffe29a" font-size="21" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.status)}</text>
  <line x1="86" y1="230" x2="1114" y2="230" stroke="#c59437" stroke-opacity=".45"/>
  <text x="86" y="286" fill="#b99650" font-size="20" font-family="Deja Vu Sans" font-weight="bold">FROM</text>
  <text x="86" y="326" fill="#ffffff" font-size="30" font-family="DejaVu Sans" font-weight="bold">${escapeXml(svgLabel(data.from, 30))}</text>
  <text x="650" y="286" fill="#b99650" font-size="20" font-family="Deja Vu Sans" font-weight="bold">TO</text>
  <text x="650" y="326" fill="#ffffff" font-size="30" font-family="DejaVu Sans" font-weight="bold">${escapeXml(svgLabel(data.to, 30))}</text>
  <rect x="70" y="376" width="500" height="154" rx="24" fill="#ffffff" fill-opacity=".055" stroke="#c59437" stroke-opacity=".45"/>
  <rect x="626" y="376" width="500" height="154" rx="24" fill="#f6c453" fill-opacity=".09" stroke="#f6c453" stroke-opacity=".6"/>
  <text x="104" y="424" fill="#b99650" font-size="20" font-family="DejaVu Sans" font-weight="bold">TIP AMOUNT</text>
  <text x="104" y="486" fill="url(#tip-gold)" font-size="44" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.amount)}</text>
  <text x="660" y="424" fill="#b99650" font-size="20" font-family="DejaVu Sans" font-weight="bold">SENDER BALANCE</text>
  <text x="660" y="486" fill="#ffffff" font-size="38" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.balance)}</text>
  <text x="86" y="594" fill="#b99650" font-size="20" font-family="DejaVu Sans" font-weight="bold">FAIR ID</text>
  <text x="86" y="630" fill="#f0d78d" font-size="22" font-family="DejaVu Sans">${escapeXml(svgLabel(data.fairId, 48))}</text>
  <text x="1114" y="594" text-anchor="end" fill="#d6b86b" font-size="20" font-family="DejaVu Sans">${escapeXml(svgLabel(data.note, 38))}</text>
  <text x="86" y="684" fill="#8f713d" font-size="17" font-family="DejaVu Sans">RolexCasino wallet transfer · ${escapeXml(data.currency)} settlement</text>
</svg>`;
}

async function tipCardPng(data: TipCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render tip image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(tipCardSvg(data)));
  });
}

function scheduleDealCardDeletion(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  label: "tip" | "escrow",
  delayMs = DEAL_CARD_TTL_MS,
  unpin = false,
): void {
  const key = `${chatId}:${messageId}`;
  if (dealCardDeletionTimers.has(key)) return;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        if (unpin) {
          try {
            await bot.unpinChatMessage(chatId, messageId);
          } catch (error) {
            logger.debug({ err: error, chatId, messageId, label }, "Deal card unpin skipped during cleanup");
          }
        }
        await bot.deleteMessage(chatId, messageId);
        logger.info({ chatId, messageId, label }, "Deal card automatically deleted");
      } catch (error) {
        logger.debug({ err: error, chatId, messageId, label }, "Deal card cleanup skipped");
      } finally {
        dealCardDeletionTimers.delete(key);
      }
    })();
  }, Math.max(0, delayMs));
  dealCardDeletionTimers.set(key, timer);
}

async function recoverRecentEscrowCardDeletions(bot: TelegramBot): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - DEAL_CARD_TTL_MS);
    const recentEscrows = await db
      .select({
        chatId: casinoEscrowsTable.chatId,
        messageId: casinoEscrowsTable.messageId,
        createdAt: casinoEscrowsTable.createdAt,
      })
      .from(casinoEscrowsTable)
      .where(
        and(
          isNotNull(casinoEscrowsTable.messageId),
          gte(casinoEscrowsTable.createdAt, cutoff),
        ),
      );
    for (const escrow of recentEscrows) {
      if (!escrow.messageId) continue;
      scheduleDealCardDeletion(
        bot,
        escrow.chatId,
        escrow.messageId,
        "escrow",
        DEAL_CARD_TTL_MS - (Date.now() - escrow.createdAt.getTime()),
        true,
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "Recent escrow card cleanup recovery failed");
  }
}

async function sendTipCard(
  bot: TelegramBot,
  chatId: number,
  data: TipCardData,
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
  messageId?: number,
): Promise<void> {
  const image = await tipCardPng(data);
  const caption = `<b>${escapeTelegramText(data.status)}</b>\n${escapeTelegramText(data.note)}`;
  if (messageId) {
    try {
      await bot.editPhoto(chatId, messageId, image, caption, replyMarkup);
      scheduleDealCardDeletion(bot, chatId, messageId, "tip");
      return;
    } catch (error) {
      logger.warn({ err: error, chatId, messageId }, "Tip live card update failed; sending replacement");
      scheduleDealCardDeletion(bot, chatId, messageId, "tip");
    }
  }
  const sent = await bot.sendPhoto(chatId, image, caption, replyMarkup);
  scheduleDealCardDeletion(bot, chatId, sent.message_id, "tip");
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
  buyerAvatarDataUri: string | null;
  sellerAvatarDataUri: string | null;
  amount: string;
  fee: string;
  status: string;
  cancelStatus: string;
};

function escrowCardSvg(data: EscrowCardData): string {
  const statusColor = data.status === "COMPLETED"
    ? "#70e59a"
    : data.status === "CANCELLED"
      ? "#ff8a9a"
      : "#f5d477";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="860" viewBox="0 0 1200 860">
  <defs>
    <linearGradient id="escrow-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#052b35"/><stop offset=".55" stop-color="#0b5360"/><stop offset="1" stop-color="#07303c"/></linearGradient>
    <linearGradient id="escrow-gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f4b72b"/><stop offset=".5" stop-color="#ffe38a"/><stop offset="1" stop-color="#f6a91a"/></linearGradient>
    <linearGradient id="escrow-card" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eefcff"/><stop offset="1" stop-color="#c6edf2"/></linearGradient>
  </defs>
  <rect width="1200" height="860" rx="40" fill="url(#escrow-bg)"/>
  <circle cx="1040" cy="55" r="270" fill="#55d3d5" opacity=".12"/><circle cx="120" cy="820" r="260" fill="#f4b72b" opacity=".08"/>
  <rect x="28" y="28" width="1144" height="804" rx="32" fill="none" stroke="#9be7ea" stroke-opacity=".7" stroke-width="3"/>
  <text x="72" y="90" fill="#72e4e5" font-size="24" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="72" y="142" fill="#ffffff" font-size="43" font-family="DejaVu Sans" font-weight="bold">PROTECTED ESCROW</text>
  <rect x="910" y="62" width="220" height="52" rx="26" fill="${statusColor}" fill-opacity=".18" stroke="${statusColor}" stroke-width="2"/>
  <text x="1020" y="96" text-anchor="middle" fill="${statusColor}" font-size="18" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.status)}</text>
  <text x="72" y="184" fill="#a9d9df" font-size="19" font-family="DejaVu Sans">ESCROW ID</text><text x="210" y="184" fill="#ffffff" font-size="24" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.code)}</text>
  <rect x="48" y="220" width="1104" height="190" rx="26" fill="#e3f8fa" stroke="#5ccbd1" stroke-width="2"/>
  <rect x="70" y="242" width="300" height="44" rx="22" fill="#f4b72b"/><text x="220" y="271" text-anchor="middle" fill="#143641" font-size="16" font-family="DejaVu Sans" font-weight="bold">SELLER / FUNDS</text>
  <rect x="830" y="242" width="300" height="44" rx="22" fill="#1ab0bd"/><text x="980" y="271" text-anchor="middle" fill="#ffffff" font-size="16" font-family="DejaVu Sans" font-weight="bold">BUYER / RECEIVES</text>
  ${svgAvatar(data.sellerAvatarDataUri, 220, 340, 42, data.seller, "#f4b72b")}
  ${svgAvatar(data.buyerAvatarDataUri, 980, 340, 42, data.buyer, "#1ab0bd")}
  <text x="220" y="398" text-anchor="middle" fill="#07505b" font-size="23" font-family="DejaVu Sans" font-weight="bold">${escapeXml(svgLabel(data.seller, 18))}</text>
  <text x="980" y="398" text-anchor="middle" fill="#07505b" font-size="23" font-family="DejaVu Sans" font-weight="bold">${escapeXml(svgLabel(data.buyer, 18))}</text>
  <rect x="420" y="248" width="360" height="142" rx="22" fill="#07505b"/>
  <text x="600" y="284" text-anchor="middle" fill="#8be9eb" font-size="16" font-family="DejaVu Sans" font-weight="bold">PROTECTED VALUE</text>
  <text x="600" y="348" text-anchor="middle" fill="#ffffff" font-size="49" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.amount)}</text>
  <rect x="48" y="446" width="1104" height="118" rx="24" fill="url(#escrow-card)"/>
  <text x="82" y="482" fill="#47717a" font-size="16" font-family="DejaVu Sans" font-weight="bold">TOTAL</text><text x="82" y="530" fill="#073b45" font-size="31" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.amount)}</text>
  <text x="430" y="482" fill="#47717a" font-size="16" font-family="DejaVu Sans" font-weight="bold">SERVICE FEE</text><text x="430" y="530" fill="#073b45" font-size="31" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.fee)}</text>
  <text x="790" y="482" fill="#47717a" font-size="16" font-family="DejaVu Sans" font-weight="bold">SETTLEMENT</text><text x="790" y="530" fill="${statusColor}" font-size="25" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.cancelStatus)}</text>
  <text x="72" y="620" fill="#8be9eb" font-size="18" font-family="DejaVu Sans" font-weight="bold">ESCROW FLOW</text>
  <rect x="48" y="648" width="330" height="72" rx="18" fill="#d5f4da" stroke="#70e59a" stroke-width="2"/><text x="76" y="676" fill="#3d7761" font-size="14" font-family="DejaVu Sans">01</text><text x="76" y="700" fill="#17553e" font-size="19" font-family="DejaVu Sans" font-weight="bold">CREATED</text><text x="332" y="696" text-anchor="end" fill="#45bd73" font-size="28">✓</text>
  <rect x="435" y="648" width="330" height="72" rx="18" fill="#d5f4da" stroke="#70e59a" stroke-width="2"/><text x="463" y="676" fill="#3d7761" font-size="14" font-family="DejaVu Sans">02</text><text x="463" y="700" fill="#17553e" font-size="19" font-family="DejaVu Sans" font-weight="bold">ACCEPTED</text><text x="719" y="696" text-anchor="end" fill="#45bd73" font-size="28">✓</text>
  <rect x="822" y="648" width="330" height="72" rx="18" fill="${statusColor}" fill-opacity=".25" stroke="${statusColor}" stroke-width="2"/><text x="850" y="676" fill="#d9fff0" font-size="14" font-family="DejaVu Sans">03</text><text x="850" y="700" fill="#ffffff" font-size="19" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.status === "COMPLETED" ? "RELEASED" : "PENDING")}</text>
  <text x="72" y="780" fill="#9bcfd5" font-size="17" font-family="DejaVu Sans">Buyer accepts · seller releases · both parties can request mutual cancellation</text>
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
    process.stdin.end(applyRolexGoldBlackTheme(escrowCardSvg(data)));
  });
}

async function sendEscrowCard(
  bot: TelegramBot,
  escrow: typeof casinoEscrowsTable.$inferSelect,
  buyer: typeof casinoPlayersTable.$inferSelect,
  seller: typeof casinoPlayersTable.$inferSelect,
  pin = true,
  messageIdOverride?: number,
): Promise<void> {
  const currency = parseCurrency(escrow.currency, "USD");
  const [sellerAvatarDataUri, buyerAvatarDataUri] = await Promise.all([
    bot.getUserProfilePhoto(seller.telegramUserId),
    bot.getUserProfilePhoto(buyer.telegramUserId),
  ]);
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
    buyer: buyer.username ? `@${buyer.username}` : buyer.displayName,
    seller: seller.username ? `@${seller.username}` : seller.displayName,
    buyerAvatarDataUri,
    sellerAvatarDataUri,
    amount: formatMoney(escrow.amountMinor, currency),
    fee: formatMoney(escrow.feeMinor, currency),
    status: escrow.status.toUpperCase(),
    cancelStatus,
  });
  const caption = [
    `<b>🔐 PROTECTED ESCROW · ${escrow.code}</b>`,
    `<b>Buyer:</b> ${escapeTelegramText(buyer.username ? `@${buyer.username}` : buyer.displayName)}`,
    `<b>Seller:</b> ${escapeTelegramText(seller.username ? `@${seller.username}` : seller.displayName)}`,
    `<b>💰 Protected value:</b> ${formatMoney(escrow.amountMinor, currency)}`,
    `<b>Service fee:</b> ${formatMoney(escrow.feeMinor, currency)} (0.2%)`,
    `<b>Fair ID:</b> <code>${escrow.fairId ?? "legacy"}</code>`,
    `<b>Status:</b> ${escapeTelegramText(cancelStatus)}`,
    "All actions and status updates stay in this single card.",
  ].join("\n");
  const inlineKeyboard: InlineKeyboardButton[][] =
    escrow.status === "pending"
      ? [[
          { text: "✅ Accept deal", callback_data: `escrow:accept:${escrow.code}` },
          { text: "❌ Reject deal", callback_data: `escrow:reject:${escrow.code}` },
        ]]
      : escrow.status === "accepted"
        ? [[
            { text: "💰 Seller: release payment", callback_data: `escrow:release:${escrow.code}` },
            { text: "❌ Mutual cancel", callback_data: `escrow:cancel:${escrow.code}` },
          ]]
        : [];
  const liveMessageId = messageIdOverride ?? escrow.messageId;
  let storedMessageId = liveMessageId;
  if (liveMessageId) {
    await bot.editPhoto(
      escrow.chatId,
      liveMessageId,
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
    storedMessageId = sent.message_id;
  }
  if (storedMessageId && storedMessageId !== escrow.messageId) {
    await db
      .update(casinoEscrowsTable)
      .set({ messageId: storedMessageId })
      .where(eq(casinoEscrowsTable.id, escrow.id));
  }
  if (storedMessageId) {
    scheduleDealCardDeletion(
      bot,
      escrow.chatId,
      storedMessageId,
      "escrow",
      DEAL_CARD_TTL_MS,
      true,
    );
  }
  if (pin) {
    try {
      if (storedMessageId) await bot.pinChatMessage(escrow.chatId, storedMessageId);
    } catch (error) {
      logger.warn({ err: error, escrowCode: escrow.code }, "Escrow pin failed");
    }
  }
}

async function refreshEscrowCard(
  bot: TelegramBot,
  escrow: typeof casinoEscrowsTable.$inferSelect,
  pin = false,
  messageIdOverride?: number,
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
  await sendEscrowCard(bot, escrow, buyer, seller, pin, messageIdOverride);
}

async function handleEscrowCallback(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
  action: string,
  messageId?: number,
): Promise<void> {
  const [, verb, rawCode] = action.split(":");
  const code = rawCode?.toUpperCase();
  if (!code || !["accept", "reject", "release", "cancel"].includes(verb ?? "")) return;
  try {
    if (verb === "accept") {
      const escrow = await acceptEscrow(code, player.id);
      await refreshEscrowCard(bot, escrow, false, messageId);
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
      await refreshEscrowCard(bot, escrow, true, messageId);
      await unpinEscrow(bot, escrow);
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
      await refreshEscrowCard(bot, escrow, true, messageId);
      await unpinEscrow(bot, escrow);
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
        await refreshEscrowCard(bot, escrow, true, messageId);
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
        await refreshEscrowCard(bot, result.escrow, result.completed, messageId);
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
        await unpinEscrow(bot, escrow);
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
    await tx
      .insert(casinoWagerRequirementsTable)
      .values({
        playerId,
        currency: parseCurrency(promo.currency, "USD"),
        requiredMinor: promo.amountMinor,
        completedMinor: 0,
      })
      .onConflictDoUpdate({
        target: [
          casinoWagerRequirementsTable.playerId,
          casinoWagerRequirementsTable.currency,
        ],
        set: {
          requiredMinor: sql`${casinoWagerRequirementsTable.requiredMinor} + ${promo.amountMinor}`,
          updatedAt: new Date(),
        },
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

type BattleResultRule = "high" | "crazy" | "heads" | "tails";

function parseBattleArguments(args: string[], fallbackCurrency: Currency): {
  mode: "pvb" | "pvp";
  amountMinor: number | null;
  rounds: number;
  rollsPerRound: number;
  targetWins: number | null;
  currency: Currency;
  resultRule: BattleResultRule;
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
const battleTimeoutWarnings = new Set<number>();
const battleTimeoutWarningInFlight = new Set<number>();
const automaticPvpRollsInFlight = new Set<number>();

function clearBattleTimeout(battleId: number): void {
  const timeout = battleTimeouts.get(battleId);
  if (timeout) clearTimeout(timeout);
  battleTimeouts.delete(battleId);
}

const BATTLE_WARNING_GRACE_MS = 30_000;

async function sendBattleTimeoutWarning(
  resultBot: TelegramBot,
  battle: typeof casinoChallengesTable.$inferSelect,
  expectedLabel: string,
): Promise<boolean> {
  if (
    battleTimeoutWarnings.has(battle.id) ||
    battleTimeoutWarningInFlight.has(battle.id)
  ) {
    return false;
  }
  battleTimeoutWarningInFlight.add(battle.id);
  battleTimeoutWarnings.add(battle.id);
  try {
    const deadline = new Date(Date.now() + BATTLE_WARNING_GRACE_MS);
    await db
      .update(casinoChallengesTable)
      .set({ turnDeadlineAt: deadline })
      .where(
        and(
          eq(casinoChallengesTable.id, battle.id),
          eq(casinoChallengesTable.status, battle.status),
        ),
      );
    await resultBot.sendMessage(
      battle.chatId,
      [
        "⏰ <b>120 seconds are over.</b>",
        `<b>You have only 30 seconds</b> to send ${battle.emoji} ${expectedLabel}.`,
        "Otherwise the bot will roll it for you and calculate the result automatically.",
      ].join("\n"),
      undefined,
      premiumEmojiOptionsForGame(battle.gameType),
    );
    scheduleBattleTimeout(resultBot, battle.id, BATTLE_WARNING_GRACE_MS);
    return true;
  } catch (error) {
    battleTimeoutWarnings.delete(battle.id);
    throw error;
  } finally {
    battleTimeoutWarningInFlight.delete(battle.id);
  }
}

async function autoRollPvbTurn(
  resultBot: TelegramBot,
  battle: typeof casinoChallengesTable.$inferSelect,
): Promise<void> {
  const [claimed] = await db
    .update(casinoChallengesTable)
    .set({ status: "rolling", turnDeadlineAt: null })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "running"),
      ),
    )
    .returning();
  if (!claimed) return;
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
  }
  try {
    for (let rollIndex = rollCount + 1; rollIndex <= battle.rollsPerRound; rollIndex += 1) {
      const verified = await sendVerifiedBotDice(
        resultBot,
        resultBot,
        battle.chatId,
        battle.emoji,
        battle.id,
      );
      await db
        .insert(casinoChallengeRollsTable)
        .values({
          challengeId: battle.id,
          actorType: "player",
          actorKey: `timeout-player:${battle.id}`,
          playerId: battle.creatorPlayerId,
          round,
          rollIndex,
          emoji: verified.roll.dice?.emoji ?? battle.emoji,
          value: verified.roll.dice?.value ?? 1,
          messageId: verified.roll.message_id,
        })
        .onConflictDoNothing();
    }
    await runPvbRound(resultBot, new Map(), claimed, round);
  } catch (error) {
    logger.error({ err: error, battleId: battle.id }, "Automatic PVB roll failed");
    await db
      .update(casinoChallengesTable)
      .set({ status: "cancelled", turnDeadlineAt: null, completedAt: new Date() })
      .where(eq(casinoChallengesTable.id, battle.id));
    await resultBot.sendMessage(
      battle.chatId,
      "❌ The automatic roll could not be verified. This PVB room was cancelled without settling a second time.",
    );
  }
}

async function autoRollPvpTurn(
  resultBot: TelegramBot,
  battle: typeof casinoChallengesTable.$inferSelect,
): Promise<void> {
  if (battle.status !== "awaiting_player_one" && battle.status !== "awaiting_player_two") return;
  if (automaticPvpRollsInFlight.has(battle.id)) return;
  automaticPvpRollsInFlight.add(battle.id);
  const expectedPlayerId =
    battle.status === "awaiting_player_two"
      ? battle.playerTwoId
      : battle.creatorPlayerId;
  try {
    if (!expectedPlayerId) return;
    const [expectedPlayer] = await db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.id, expectedPlayerId))
      .limit(1);
    if (!expectedPlayer) return;
    const verified = await sendVerifiedBotDice(
      resultBot,
      resultBot,
      battle.chatId,
      battle.emoji,
      battle.id,
    );
    battleTimeoutWarnings.delete(battle.id);
    await handlePlayerPvpRoll(resultBot, verified.roll, expectedPlayer);
  } catch (error) {
    logger.error({ err: error, battleId: battle.id }, "Automatic PVP roll failed");
    await db
      .update(casinoChallengesTable)
      .set({ status: "cancelled", turnDeadlineAt: null, completedAt: new Date() })
      .where(
        and(
          eq(casinoChallengesTable.id, battle.id),
          inArray(casinoChallengesTable.status, [
            "awaiting_player_one",
            "awaiting_player_two",
          ]),
        ),
      );
    await resultBot.sendMessage(
      battle.chatId,
      "❌ The automatic roll could not be verified. This PVP room was cancelled without settling a second time.",
    );
  } finally {
    automaticPvpRollsInFlight.delete(battle.id);
  }
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
      !["pending_confirmation", "running", "rolling", "roulette_choice"].includes(battle.status)
  ) {
    clearBattleTimeout(battleId);
    battleTimeoutWarnings.delete(battleId);
    return;
  }
  if (battle.turnDeadlineAt && !isBattleTurnExpired(battle.turnDeadlineAt)) {
    scheduleBattleTimeout(resultBot, battle.id, battle.turnDeadlineAt.getTime() - Date.now());
    return;
  }

  if (battle.status === "running") {
    if (battleTimeoutWarningInFlight.has(battle.id)) return;
    if (await sendBattleTimeoutWarning(resultBot, battle, "for your PVB turn")) return;
    battleTimeoutWarnings.delete(battle.id);
    await autoRollPvbTurn(resultBot, battle);
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
        inArray(casinoChallengesTable.status, [
          "pending_confirmation",
          "running",
          "rolling",
          "roulette_choice",
        ]),
      ),
    )
    .returning();
  clearBattleTimeout(battleId);
  battleTimeoutWarnings.delete(battleId);
  if (!cancelledBattle) return;

  const timeoutOutcome = battleTimeoutOutcome(battle.stakeMinor);
  await resultBot.sendMessage(
    battle.chatId,
    battle.status === "pending_confirmation"
      ? "⏰ PVB room expired because Play was not confirmed in time. No balance was changed."
      : [
          "⏰ Time expired.",
          "The player did not finish the required action within 120 seconds.",
          `The stake ${formatMoney(timeoutOutcome.refundMinor, parseCurrency(battle.currency, "USD"))} was refunded.`,
          "Challenge cancelled automatically.",
        ].join("\n"),
  );
}

async function expirePvpBattle(
  resultBot: TelegramBot,
  battleId: number,
): Promise<void> {
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(eq(casinoChallengesTable.id, battleId))
    .limit(1);
  if (!battle) {
    clearBattleTimeout(battleId);
    battleTimeoutWarnings.delete(battleId);
    return;
  }
  if (
    battle.status === "awaiting_player_one" ||
    battle.status === "awaiting_player_two"
  ) {
    if (battleTimeoutWarningInFlight.has(battle.id)) return;
    const [expectedPlayer] = await db
      .select()
      .from(casinoPlayersTable)
      .where(
        eq(
          casinoPlayersTable.id,
          battle.status === "awaiting_player_two"
            ? battle.playerTwoId as number
            : battle.creatorPlayerId,
        ),
      )
      .limit(1);
    const warned = await sendBattleTimeoutWarning(
      resultBot,
      battle,
      `for ${casinoPlayerLabel(expectedPlayer, "the expected player")}'s PVP turn`,
    );
    if (warned) return;
    battleTimeoutWarnings.delete(battle.id);
    await autoRollPvpTurn(resultBot, battle);
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
        eq(casinoChallengesTable.id, battleId),
        eq(casinoChallengesTable.mode, "pvp"),
        inArray(casinoChallengesTable.status, [
          "open",
          "coin_choice",
          "awaiting_player_one",
          "awaiting_player_two",
          "rolling",
        ]),
      ),
    )
    .returning();
  clearBattleTimeout(battleId);
  battleTimeoutWarnings.delete(battleId);
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
        "open",
        "pending_confirmation",
        "running",
          "rolling",
        "coin_choice",
        "awaiting_player_one",
        "awaiting_player_two",
          "roulette_choice",
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
  payoutMultiplier?: number;
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

    const tie = input.playerOneScore === input.playerTwoScore;
    const playerOneWon = tie ? false : input.playerOneWon;
    const { tie: payoutTie } = calculateBattlePayouts({
      stakeMinor: input.stakeMinor,
      playerOneScore: input.playerOneScore,
      playerTwoScore: input.playerTwoScore,
      playerOneWon,
      hasPlayerTwo: Boolean(input.playerTwoId),
    });
    if (payoutTie !== tie) {
      throw new Error("BATTLE_TIE_STATE_MISMATCH");
    }
    const customMultiplier =
      input.payoutMultiplier !== undefined && Number.isFinite(input.payoutMultiplier)
        ? Math.max(0, input.payoutMultiplier)
        : null;
    const playerOnePayout = customMultiplier === null
      ? calculateBattlePayouts({
          stakeMinor: input.stakeMinor,
          playerOneScore: input.playerOneScore,
          playerTwoScore: input.playerTwoScore,
          playerOneWon,
          hasPlayerTwo: Boolean(input.playerTwoId),
        }).playerOnePayout
      : tie
        ? input.stakeMinor
        : playerOneWon
          ? Math.round(input.stakeMinor * customMultiplier)
          : 0;
    const playerTwoPayout = customMultiplier === null
      ? calculateBattlePayouts({
          stakeMinor: input.stakeMinor,
          playerOneScore: input.playerOneScore,
          playerTwoScore: input.playerTwoScore,
          playerOneWon,
          hasPlayerTwo: Boolean(input.playerTwoId),
        }).playerTwoPayout
      : tie && input.playerTwoId
        ? input.stakeMinor
        : input.playerTwoId && !playerOneWon
          ? Math.round(input.stakeMinor * customMultiplier)
          : 0;

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
      const houseAmount = playerOneWon
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
        description: `${input.gameType} battle ${tie ? "refund" : "payout"}${customMultiplier === null ? " at 1.92x" : ` at ${customMultiplier}x`}; fair ${input.fairId}`,
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
          description: `${input.gameType} battle ${tie ? "refund" : "payout"}${customMultiplier === null ? " at 1.92x" : ` at ${customMultiplier}x`}; fair ${input.fairId}`,
        });
      }
    }

    await recordDailyLoss(
      tx,
      input.playerOneId,
      input.currency,
      Math.max(0, playerOneDebit - playerOnePayout),
    );
    if (input.playerTwoId) {
      await recordDailyLoss(
        tx,
        input.playerTwoId,
        input.currency,
        Math.max(0, playerTwoDebit - playerTwoPayout),
      );
    }

    await tx
      .update(casinoChallengesTable)
      .set({
        playerOneScore: input.playerOneScore,
        playerTwoScore: input.playerTwoScore,
        winnerPlayerId: tie ? null : playerOneWon ? input.playerOneId : input.playerTwoId,
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
  stakeMinor: number;
  payoutMinor: number;
  currency: Currency;
  fairId: string;
}): string {
  const roundLines = options.rounds.map(
    (round, index) =>
      `<b>ROUND ${index + 1}: ${round.playerOneScore}–${round.playerTwoScore}</b>`,
  );
  const winnerLabel = options.playerOneWon
    ? options.playerOneLabel
    : options.playerTwoLabel;
  const stakeLabel = formatMoney(options.stakeMinor, options.currency);
  const winAmountMinor = options.tie
    ? options.stakeMinor
    : options.playerOneWon
      ? options.payoutMinor
      : options.stakeMinor;
  const winAmountLabel = formatMoney(winAmountMinor, options.currency);
  const gameEmoji = battleGameMap[options.gameType]?.emoji ?? "🎮";
  const versusLabel = options.mode === "pvb" ? "VS BOT" : "VS PLAYER";
  const creditedLine = options.tie
    ? `<b>✅ PUSH — ${stakeLabel} returned to your wallet.</b>`
    : options.mode === "pvb"
      ? options.playerOneWon
        ? `<b>✅ WIN — ${formatMoney(options.payoutMinor, options.currency)} credited to your wallet.</b>`
        : `<b>❌ LOSS — ${stakeLabel} goes to @Rolex_C_BOT.</b>`
      : options.playerOneWon
        ? `<b>✅ WIN — ${winAmountLabel} ${winnerLabel} takes the round.</b>`
        : `<b>❌ LOSS — ${winnerLabel} wins ${winAmountLabel}.</b>`;
  return [
    "<blockquote>",
    `<b>${gameEmoji} ${options.gameType.toUpperCase()}–${versusLabel}</b>`,
    `<b>ID #${options.battleId}</b>`,
    `<b>STAKED AMOUNT: ${stakeLabel}</b>`,
    `<b>WIN AMOUNT: ${winAmountLabel}</b>`,
    "",
    ...roundLines,
    "",
    `<b>${options.tie ? "✅ DRAW" : options.playerOneWon ? "✅ WINNER" : "❌ WINNER"} — ${options.tie ? "Both players" : winnerLabel}</b>`,
    "",
    creditedLine,
    "",
    `<b>Fair ID: ${options.fairId}</b>`,
    "</blockquote>",
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
  await sendDelayedPvpResult(
    resultBot,
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
      stakeMinor: battle.stakeMinor,
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
      [
        "<b>Battle format</b>",
        "<code>/dice pvb 100 2d2w INR</code>",
        "",
        "<b>2d2w</b> = 2 game emojis per round, first to 2 round wins.",
        "<b>1d1w</b>, <b>2d2w</b>, and <b>3d3w</b> are supported.",
        "Add <b>crazy</b> for lowest-score-wins mode. Normal mode is highest-score-wins.",
      ].join("\n"),
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
      status: input.mode === "pvp" ? "open" : "pending_confirmation",
      turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
    })
    .returning();
  if (!battle) throw new Error("Could not create battle");

  if (input.mode === "pvp") {
    const sent = await sendPvpMessage(
      resultBot,
      chatId,
      [
        `<b>⚔️ ${game.emoji} ${game.gameType.toUpperCase()} PVP ROOM CREATED</b>`,
        "",
        `Stake: <b>${formatMoney(input.amountMinor, input.currency)}</b>`,
        input.targetWins
          ? `<b>${input.rollsPerRound}</b> game emojis per round · first to <b>${input.targetWins}</b> round wins`
          : `<b>${input.rounds}</b> rounds · <b>${input.rollsPerRound}</b> game emojis per round`,
        input.resultRule === "crazy"
          ? "<b>🧠 Crazy mode:</b> lowest total wins."
          : "<b>🎯 Normal mode:</b> highest total wins.",
        invitedPlayer
          ? `Challenge for <b>${escapeTelegramText(invitedPlayer.displayName)}</b>.`
          : "Another player can accept below. Both players must have enough balance when the battle starts.",
      ].join("\n"),
      {
        inline_keyboard: [[
          { text: "✅ Accept battle", callback_data: `battle:join:${battle.id}` },
          { text: "❌ Reject", callback_data: `battle:decline:${battle.id}` },
        ]],
      },
    );
    await db
      .update(casinoChallengesTable)
      .set({ messageId: sent.message_id })
      .where(eq(casinoChallengesTable.id, battle.id));
    scheduleBattleTimeout(resultBot, battle.id);
    return;
  }

  const sent = await resultBot.sendMessage(
    chatId,
    [
      `<b>🤖 ${game.emoji} ${game.gameType.toUpperCase()} — PLAYER VS BOT</b>`,
      "",
      `Stake: <b>${formatMoney(input.amountMinor, input.currency)}</b>`,
      input.targetWins
        ? `<b>${input.rollsPerRound}</b> game emojis per round · first to <b>${input.targetWins}</b> round wins`
        : `<b>${input.rounds}</b> rounds · <b>${input.rollsPerRound}</b> game emojis per round`,
      input.resultRule === "crazy"
        ? "<b>🧠 Crazy mode:</b> lowest score wins each round."
        : "<b>🎯 Normal mode:</b> highest score wins each round.",
      "",
      "Press <b>Play with Bot</b> to confirm, or Cancel to close this room.",
    ].join("\n"),
    {
      inline_keyboard: [[
        {
          text: "✅ Play with Bot",
          callback_data: ownedCallback(`battle:pvb:play:${battle.id}`, player.telegramUserId),
        },
        {
          text: "❌ Cancel",
          callback_data: ownedCallback(`battle:pvb:cancel:${battle.id}`, player.telegramUserId),
        },
      ]],
    },
  );
  await db
    .update(casinoChallengesTable)
    .set({ messageId: sent.message_id })
    .where(eq(casinoChallengesTable.id, battle.id));
  scheduleBattleTimeout(resultBot, battle.id);
}

type RouletteChoice =
  | "odd"
  | "even"
  | "1-8"
  | "9-18"
  | "19-25"
  | "26-35"
  | `number:${number}`;

function rouletteChoiceLabel(choice: RouletteChoice): string {
  if (choice.startsWith("number:")) return `Number ${choice.slice(7)}`;
  if (choice === "odd") return "Odd";
  if (choice === "even") return "Even";
  return choice;
}

function rouletteChoiceMatches(choice: RouletteChoice, result: number): boolean {
  if (choice === "odd") return result % 2 === 1;
  if (choice === "even") return result % 2 === 0;
  if (choice === "1-8") return result >= 1 && result <= 8;
  if (choice === "9-18") return result >= 9 && result <= 18;
  if (choice === "19-25") return result >= 19 && result <= 25;
  if (choice === "26-35") return result >= 26 && result <= 35;
  return result === Number(choice.slice(7));
}

function isRouletteChoice(value: string): value is RouletteChoice {
  return (
    value === "odd" ||
    value === "even" ||
    value === "1-8" ||
    value === "9-18" ||
    value === "19-25" ||
    value === "26-35" ||
    /^number:(?:[1-9]|[12]\d|3[0-6])$/.test(value)
  );
}

function rouletteKeyboard(
  ownerTelegramUserId: number,
  battleId: number,
  numberMode = false,
): { inline_keyboard: InlineKeyboardButton[][] } {
  if (numberMode) {
    const rows: InlineKeyboardButton[][] = [];
    for (let number = 1; number <= 36; number += 6) {
      rows.push(
        Array.from({ length: 6 }, (_, index) => number + index)
          .filter((value) => value <= 36)
          .map((value) => ({
            text: String(value),
            callback_data: ownedCallback(
              `roulette:choose:${battleId}:number:${value}`,
              ownerTelegramUserId,
            ),
          })),
      );
    }
    rows.push([{
      text: "↩️ Back to bets",
      callback_data: ownedCallback(`roulette:menu:${battleId}`, ownerTelegramUserId),
    }]);
    return { inline_keyboard: rows };
  }
  return {
    inline_keyboard: [
      [
        { text: "Odd", callback_data: ownedCallback(`roulette:choose:${battleId}:odd`, ownerTelegramUserId) },
        { text: "Even", callback_data: ownedCallback(`roulette:choose:${battleId}:even`, ownerTelegramUserId) },
      ],
      [
        { text: "1–8", callback_data: ownedCallback(`roulette:choose:${battleId}:1-8`, ownerTelegramUserId) },
        { text: "9–18", callback_data: ownedCallback(`roulette:choose:${battleId}:9-18`, ownerTelegramUserId) },
      ],
      [
        { text: "19–25", callback_data: ownedCallback(`roulette:choose:${battleId}:19-25`, ownerTelegramUserId) },
        { text: "26–35", callback_data: ownedCallback(`roulette:choose:${battleId}:26-35`, ownerTelegramUserId) },
      ],
      [{
        text: "🔢 Number 1–36",
        callback_data: ownedCallback(`roulette:numbers:${battleId}`, ownerTelegramUserId),
      }],
    ],
  };
}

async function sendRouletteSticker(
  bot: TelegramBot,
  chatId: number,
  result: number,
): Promise<boolean> {
  if (rouletteStickerIds.length === 0) await loadRouletteStickerPack(bot);
  // Sticker-set order is not a roulette result mapping. Only use a sticker
  // whose own emoji metadata identifies this exact number; otherwise omit the
  // animation instead of showing a visually contradictory result.
  const stickerId = rouletteStickerIdsByNumber.get(result);
  if (!stickerId) return false;
  await bot.sendSticker(chatId, stickerId);
  return true;
}

async function startRoulette(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  amountMinor: number | null,
  currency: Currency,
): Promise<void> {
  if (!amountMinor) {
    await bot.sendMessage(chatId, "<b>Usage:</b> <code>/roul AMOUNT INR|USD</code>\nExample: <code>/roul 30 INR</code>");
    return;
  }
  if (!(await betInRange(amountMinor, currency, "roulette"))) {
    await bot.sendMessage(chatId, await configuredBetLimitText(currency, "roulette"));
    return;
  }
  const player = await ensurePlayer(user);
  const wallet = await ensureWallet(player.id, currency);
  const jackpot = await ensureJackpot(currency);
  const [participant] = await db
    .select()
    .from(casinoJackpotParticipantsTable)
    .where(
      and(
        eq(casinoJackpotParticipantsTable.jackpotId, jackpot.id),
        eq(casinoJackpotParticipantsTable.playerId, player.id),
      ),
    )
    .limit(1);
  const jackpotMinor = jackpotContribution(amountMinor, Boolean(participant));
  if (wallet.balanceMinor < amountMinor + jackpotMinor) {
    await bot.sendMessage(chatId, `<b>❌ Insufficient balance</b>\nAvailable: <b>${formatMoney(wallet.balanceMinor, currency)}</b>`);
    return;
  }
  const [battle] = await db
    .insert(casinoChallengesTable)
    .values({
      creatorPlayerId: player.id,
      mode: "pvb",
      playerTwoId: null,
      chatId,
      gameType: "roulette",
      emoji: "🎰",
      currency,
      stakeMinor: amountMinor,
      rounds: 1,
      rollsPerRound: 1,
      targetWins: null,
      resultRule: "high",
      fairId: createFairId(),
      status: "roulette_choice",
      turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
    })
    .returning();
  if (!battle) throw new Error("Could not create roulette room");
  const sent = await bot.sendMessage(
    chatId,
    [
      "<b>🎰 ROULETTE–VS BOT ROOM</b>",
      "",
      `<b>ROOM ID #${battle.id}</b>`,
      `<b>PLAYER:</b> ${casinoPlayerLabel(player, "Player")}`,
      `<b>STAKED AMOUNT:</b> ${formatMoney(amountMinor, currency)}`,
      "<b>GROUP BETS PAY 1.92× · NUMBER BETS PAY 36×</b>",
      "",
      "Choose a side below:",
    ].join("\n"),
    rouletteKeyboard(player.telegramUserId, battle.id),
    ROULETTE_PREMIUM_EMOJI_OPTIONS,
  );
  await db
    .update(casinoChallengesTable)
    .set({ messageId: sent.message_id })
    .where(eq(casinoChallengesTable.id, battle.id));
  scheduleBattleTimeout(bot, battle.id);
}

async function handleRouletteChoice(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  battleId: number,
  choice: RouletteChoice,
): Promise<void> {
  const [battle] = await db
    .select()
    .from(casinoChallengesTable)
    .where(eq(casinoChallengesTable.id, battleId))
    .limit(1);
  if (!battle || battle.mode !== "pvb" || battle.gameType !== "roulette" || battle.status !== "roulette_choice") {
    await bot.sendMessage(
      chatId,
      "That roulette room is no longer waiting for a choice.",
      undefined,
      ROULETTE_PREMIUM_EMOJI_OPTIONS,
    );
    return;
  }
  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
    .limit(1);
  if (!player || player.telegramUserId !== user.id) return;
  const [claimed] = await db
    .update(casinoChallengesTable)
    .set({ status: "roulette_spinning", resultRule: choice, turnDeadlineAt: null })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "roulette_choice"),
      ),
    )
    .returning();
  if (!claimed) return;
  clearBattleTimeout(battle.id);
  try {
    if (battle.messageId) {
      await bot.editMessageText(
        chatId,
        battle.messageId,
        `<b>🎰 ROULETTE–VS BOT #${battle.id}</b>\n\nSelection: <b>${rouletteChoiceLabel(choice)}</b>\n\n<b>Wheel spinning…</b>`,
        { inline_keyboard: [] },
        ROULETTE_PREMIUM_EMOJI_OPTIONS,
      );
    }
  } catch (error) {
    logger.warn({ err: error, battleId: battle.id }, "Roulette room update failed");
  }
  const result = randomInt(1, 37);
  await wait(PVP_RESULT_DELAY_MS);
  const stickerSent = await sendRouletteSticker(bot, chatId, result);
  await wait(PVP_RESULT_DELAY_MS);
  const won = rouletteChoiceMatches(choice, result);
  const numericChoice = choice.startsWith("number:");
  const payoutMultiplier = numericChoice ? 36 : 1.92;
  let settled: Awaited<ReturnType<typeof settleBattle>>;
  try {
    settled = await settleBattle({
      battleId: battle.id,
      chatId: battle.chatId,
      playerOneId: battle.creatorPlayerId,
      playerTwoId: null,
      mode: "pvb",
      gameType: "roulette",
      currency: parseCurrency(battle.currency, "USD"),
      stakeMinor: battle.stakeMinor,
      playerOneScore: won ? 1 : 0,
      playerTwoScore: won ? 0 : 1,
      playerOneWon: won,
      payoutMultiplier: won ? payoutMultiplier : 0,
      fairId: battle.fairId ?? createFairId(),
    });
  } catch (error) {
    logger.error({ err: error, battleId: battle.id }, "Roulette settlement failed");
    await db
      .update(casinoChallengesTable)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(casinoChallengesTable.id, battle.id));
    await bot.sendMessage(
      chatId,
      "Roulette could not settle this room. Please contact support before playing again.",
      undefined,
      ROULETTE_PREMIUM_EMOJI_OPTIONS,
    );
    return;
  }
  if (won) {
    await broadcastPlayerWin(
      bot,
      player.id,
      "roulette",
      Math.round(battle.stakeMinor * payoutMultiplier),
      parseCurrency(battle.currency, "USD"),
    );
  }
  await bot.sendMessage(
    chatId,
    [
      "<b>🎰 ROULETTE–VS BOT RESULT</b>",
      "",
      `<b>Room:</b> #${battle.id}`,
      `<b>Your selection:</b> ${rouletteChoiceLabel(choice)}`,
      `<b>Verified roulette result:</b> <b>Number ${result}</b> · ${result % 2 === 0 ? "Even" : "Odd"}${stickerSent ? "" : " · animation unavailable"}`,
      won
        ? `<b>✅ WIN — ${formatMoney(Math.round(battle.stakeMinor * payoutMultiplier), parseCurrency(battle.currency, "USD"))} credited (${payoutMultiplier}×).</b>`
        : `<b>❌ LOSS — ${formatMoney(battle.stakeMinor, parseCurrency(battle.currency, "USD"))} went to the house.</b>`,
      `<b>Balance:</b> ${formatMoney(settled.playerOneBalance, parseCurrency(battle.currency, "USD"))}`,
      `<b>Fair ID:</b> <code>${settled.fairId}</code>`,
    ].join("\n"),
    undefined,
    ROULETTE_PREMIUM_EMOJI_OPTIONS,
  );
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
      resultRule:
        previousBattle.gameType === "coin" &&
        (previousBattle.resultRule === "heads" || previousBattle.resultRule === "tails")
          ? previousBattle.resultRule
          : previousBattle.resultRule === "crazy"
            ? "crazy"
            : "high",
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
  const player = await ensurePlayer(user);
  if (battle.creatorPlayerId === player.id) {
    await resultBot.sendMessage(chatId, "The battle creator cannot join as their own opponent.");
    return;
  }
  if (battle.playerTwoId !== null && battle.playerTwoId !== player.id) {
    await resultBot.sendMessage(
      chatId,
      "This PVP challenge was sent to another player.",
    );
    return;
  }
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
  let progressUpdated = false;
  try {
    if (battle.messageId) {
      await resultBot.editMessageText(
        chatId,
        battle.messageId,
        `<b>✅ BATTLE ACCEPTED</b>\n\nOpponent: ${casinoPlayerLabel(player, "Player")}\n\nThe game is starting.`,
        { inline_keyboard: [] },
      );
    }
  } catch (error) {
    logger.warn({ err: error, battleId: battle.id }, "Battle acceptance message update failed");
  }
  const isCoinBattle = claimedBattle.gameType === "coin";
  const [startedBattle] = await db
    .update(casinoChallengesTable)
    .set({
      status: isCoinBattle ? "coin_choice" : "awaiting_player_one",
      turnDeadlineAt: new Date(Date.now() + BATTLE_TURN_TIMEOUT_MS),
    })
    .where(eq(casinoChallengesTable.id, claimedBattle.id))
    .returning();
  if (startedBattle) {
    if (startedBattle.gameType === "coin") {
      const preselectedSide =
        startedBattle.resultRule === "heads" || startedBattle.resultRule === "tails"
          ? startedBattle.resultRule.toUpperCase() as "HEADS" | "TAILS"
          : null;
      if (preselectedSide) {
        await resolvePreselectedPvpCoin(
          resultBot,
          helperBots,
          chatId,
          startedBattle,
          preselectedSide,
        );
        return;
      }
      const [challenger, opponent] = await Promise.all([
        db
          .select()
          .from(casinoPlayersTable)
          .where(eq(casinoPlayersTable.id, startedBattle.creatorPlayerId))
          .limit(1)
          .then(([row]) => row),
        db
          .select()
          .from(casinoPlayersTable)
          .where(eq(casinoPlayersTable.id, startedBattle.playerTwoId as number))
          .limit(1)
          .then(([row]) => row),
      ]);
      await sendPvpMessage(
        resultBot,
        chatId,
        [
          `<b>🪙 Coin Flip Room #${String(startedBattle.id).padStart(4, "0")}</b>`,
          "",
          `Challenger: ${casinoPlayerLabel(challenger, "Challenger")}`,
          `Opponent: ${casinoPlayerLabel(opponent, "Opponent")}`,
          `Stake: ${formatMoney(startedBattle.stakeMinor, parseCurrency(startedBattle.currency, "USD"))}`,
          "Win: 1.92x",
          "",
          `${casinoPlayerLabel(opponent, "Opponent")}, choose your side:`,
          "The challenger receives the opposite side automatically.",
        ].join("\n"),
        {
          inline_keyboard: [[
            {
              text: "✅ Heads",
              callback_data: ownedCallback(
                `coin:choose:${startedBattle.id}:HEADS`,
                opponent?.telegramUserId ?? user.id,
              ),
            },
            {
              text: "✅ Tails",
              callback_data: ownedCallback(
                `coin:choose:${startedBattle.id}:TAILS`,
                opponent?.telegramUserId ?? user.id,
              ),
            },
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

async function handlePvbCoinChoice(
  resultBot: TelegramBot,
  helperBots: Map<string, TelegramBot>,
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
    battle.mode !== "pvb" ||
    battle.gameType !== "coin" ||
    battle.status !== "coin_choice"
  ) {
    await resultBot.sendMessage(chatId, "<b>❌ That coin VS Bot room is no longer waiting for a choice.</b>");
    return;
  }
  const [player] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
    .limit(1);
  if (!player || player.telegramUserId !== user.id) {
    return;
  }
  const [claimed] = await db
    .update(casinoChallengesTable)
    .set({ status: "coin_flipping", turnDeadlineAt: null })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "coin_choice"),
      ),
    )
    .returning();
  if (!claimed) return;
  let progressUpdated = false;
  try {
    if (battle.messageId) {
      await resultBot.editMessageText(
        chatId,
        battle.messageId,
        `<b>✅ ${escapeTelegramText(player.username ? `@${player.username}` : player.displayName)} chose ${pickedSide}.</b>\n\n<b>Coin in the air... 1... 2... 3...</b>`,
        { inline_keyboard: [] },
      );
      progressUpdated = true;
    }
  } catch (error) {
    logger.warn({ err: error, battleId: battle.id }, "Coin choice message update failed");
  }
  if (!progressUpdated) {
    await resultBot.sendMessage(
      chatId,
      `<b>🪙 ${escapeTelegramText(player.username ? `@${player.username}` : player.displayName)} chose ${pickedSide}.</b>\n\n<b>Coin in the air... 1... 2... 3...</b>`,
    );
  }
  const coinBot =
    helperBots.get("coin") ??
    helperBots.get("dice") ??
    Array.from(new Set(helperBots.values()))[0] ??
    resultBot;
  await wait(3_000);
  const landedSide = randomInt(0, 2) === 0 ? "HEADS" : "TAILS";
  await coinBot.sendSticker(
    chatId,
    landedSide === "HEADS"
      ? "CAACAgUAAxkBAAFTwsdqoCIDn3aYNkEzBzK4bgaG_1nKTQACNiAAAqKnAAFVo9ol5MRo_sE9BA"
      : "CAACAgUAAxkBAAFTwshqoCIEvo5YGjBgGT068tbqlGtqqwAC1CEAAhR4AAFVY1ajxrKoHbg9BA",
  );
  await wait(PVP_RESULT_DELAY_MS);
  const playerWon = pickedSide === landedSide;
  const settled = await settleBattle({
    battleId: battle.id,
    chatId: battle.chatId,
    playerOneId: battle.creatorPlayerId,
    playerTwoId: null,
    mode: "pvb",
    gameType: "coin",
    currency: parseCurrency(battle.currency, "USD"),
    stakeMinor: battle.stakeMinor,
    playerOneScore: playerWon ? 1 : 0,
    playerTwoScore: playerWon ? 0 : 1,
    playerOneWon: playerWon,
    fairId: battle.fairId ?? createFairId(),
  });
  await resultBot.sendMessage(
    chatId,
    [
      `<b>🪙 COIN VS BOT RESULT</b>`,
      "",
      `<b>Your choice:</b> ${pickedSide}`,
      `<b>Coin landed:</b> ${landedSide}`,
      playerWon
        ? `<b>✅ WIN — ${formatMoney(Math.round(battle.stakeMinor * 1.92), parseCurrency(battle.currency, "USD"))} credited to your wallet.</b>`
        : `<b>❌ LOSS — ${formatMoney(battle.stakeMinor, parseCurrency(battle.currency, "USD"))} went to the house.</b>`,
      `<b>Wallet balance:</b> ${formatMoney(settled.playerOneBalance, parseCurrency(battle.currency, "USD"))}`,
      `<b>Fair ID:</b> <code>${settled.fairId}</code>`,
    ].join("\n"),
  );
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
  const player = await ensurePlayer(user);
  if (battle.playerTwoId !== null && battle.playerTwoId !== player.id) {
    await resultBot.sendMessage(chatId, "This PVP challenge was sent to another player.");
    return;
  }
  if (battle.playerTwoId === null) {
    if (battle.creatorPlayerId !== player.id) {
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
          eq(casinoChallengesTable.creatorPlayerId, player.id),
          eq(casinoChallengesTable.playerTwoId, player.id),
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

async function resolvePreselectedPvpCoin(
  resultBot: TelegramBot,
  helperBots: Map<string, TelegramBot>,
  chatId: number,
  battle: typeof casinoChallengesTable.$inferSelect,
  pickedSide: "HEADS" | "TAILS",
): Promise<void> {
  const [challenger, opponent] = await Promise.all([
    db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
      .limit(1)
      .then(([row]) => row),
    db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.id, battle.playerTwoId as number))
      .limit(1)
      .then(([row]) => row),
  ]);
  if (!challenger || !opponent || !battle.playerTwoId) return;
  const [claimed] = await db
    .update(casinoChallengesTable)
    .set({ status: "coin_flipping", turnDeadlineAt: null })
    .where(
      and(
        eq(casinoChallengesTable.id, battle.id),
        eq(casinoChallengesTable.status, "coin_choice"),
      ),
    )
    .returning();
  if (!claimed) return;
  await sendPvpMessage(
    resultBot,
    chatId,
    `<b>🪙 ${casinoPlayerLabel(challenger, "Challenger")} selected ${pickedSide}.</b>\n\n<b>Coin in the air... 1... 2... 3...</b>`,
  );
  await wait(3_000);
  const landedSide = randomInt(0, 2) === 0 ? "HEADS" : "TAILS";
  const coinBot =
    helperBots.get("coin") ??
    helperBots.get("dice") ??
    Array.from(new Set(helperBots.values()))[0] ??
    resultBot;
  await coinBot.sendSticker(
    chatId,
    landedSide === "HEADS"
      ? "CAACAgUAAxkBAAFTwsdqoCIDn3aYNkEzBzK4bgaG_1nKTQACNiAAAqKnAAFVo9ol5MRo_sE9BA"
      : "CAACAgUAAxkBAAFTwshqoCIEvo5YGjBgGT068tbqlGtqqwAC1CEAAhR4AAFVY1ajxrKoHbg9BA",
  );
  await wait(PVP_RESULT_DELAY_MS);
  const challengerWon = pickedSide === landedSide;
  const settled = await settleBattle({
    battleId: battle.id,
    chatId: battle.chatId,
    playerOneId: battle.creatorPlayerId,
    playerTwoId: battle.playerTwoId,
    mode: "pvp",
    gameType: "coin",
    currency: parseCurrency(battle.currency, "USD"),
    stakeMinor: battle.stakeMinor,
    playerOneScore: challengerWon ? 1 : 0,
    playerTwoScore: challengerWon ? 0 : 1,
    playerOneWon: challengerWon,
    fairId: battle.fairId ?? createFairId(),
  });
  const winner = challengerWon ? challenger : opponent;
  const loser = challengerWon ? opponent : challenger;
  await sendPvpMessage(
    resultBot,
    chatId,
    [
      `<b>🪙 COIN FLIP #${String(battle.id).padStart(4, "0")} — RESULT</b>`,
      "",
      `<b>Selected side:</b> ${pickedSide}`,
      `<b>Coin landed:</b> ${landedSide}`,
      "",
      challengerWon
        ? `<b>✅ ${casinoPlayerLabel(winner, "Player")} won.</b>`
        : `<b>❌ ${casinoPlayerLabel(loser, "Player")} lost.</b>`,
      `<b>Winner:</b> ${casinoPlayerLabel(winner, "Player")}`,
      `<b>Loser:</b> ${casinoPlayerLabel(loser, "Player")}`,
      `Prize: <b>${formatMoney(Math.round(battle.stakeMinor * 1.92), parseCurrency(battle.currency, "USD"))}</b>`,
      `Fair ID: <code>${settled.fairId}</code>`,
    ].join("\n"),
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
    if (battle) {
      const [creator] = await db
        .select()
        .from(casinoPlayersTable)
        .where(eq(casinoPlayersTable.id, battle.creatorPlayerId))
        .limit(1);
      await resultBot.sendMessage(
        chatId,
        [
          `<b>🤖 ${escapeTelegramText(battle.gameType.toUpperCase())} VS BOT</b>`,
          "",
          `<b>${escapeTelegramText(creator?.username ? `@${creator.username}` : creator?.displayName ?? "Player")} ${escapeTelegramText(battle.emoji)} — send now!</b>`,
          "",
          "<b>This room is already active or completed.</b>",
        ].join("\n"),
        undefined,
        premiumEmojiOptionsForGame(battle.gameType),
      );
    } else {
      await resultBot.sendMessage(chatId, "<b>❌ This PVB room was not found.</b>");
    }
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
  if (startedBattle.gameType === "coin") {
    await db
      .update(casinoChallengesTable)
      .set({ status: "coin_choice", turnDeadlineAt: deadline })
      .where(eq(casinoChallengesTable.id, startedBattle.id));
    const preselectedSide =
      startedBattle.resultRule === "heads" || startedBattle.resultRule === "tails"
        ? startedBattle.resultRule.toUpperCase() as "HEADS" | "TAILS"
        : null;
    if (preselectedSide) {
      await handlePvbCoinChoice(
        resultBot,
        new Map<string, TelegramBot>(),
        chatId,
        user,
        startedBattle.id,
        preselectedSide,
      );
      return;
    }
    const coinChoiceText = [
        `<b>✅ COIN–VS BOT CONFIRMED</b>`,
        "",
        `<b>ID #${startedBattle.id}</b>`,
        `<b>STAKED AMOUNT: ${formatMoney(startedBattle.stakeMinor, parseCurrency(startedBattle.currency, "USD"))}</b>`,
        `<b>WIN AMOUNT: ${formatMoney(Math.round(startedBattle.stakeMinor * 1.92), parseCurrency(startedBattle.currency, "USD"))}</b>`,
        "",
        `<b>${casinoPlayerLabel(creator, "Player")}, choose Heads or Tails:</b>`,
        "<b>The bot will send the random result sticker after your choice.</b>",
      ].join("\n");
    const coinChoiceKeyboard = {
        inline_keyboard: [[
          {
            text: "✅ Heads",
            callback_data: ownedCallback(
              `coin:pvb:choose:${startedBattle.id}:HEADS`,
              creator.telegramUserId,
            ),
          },
          {
            text: "✅ Tails",
            callback_data: ownedCallback(
              `coin:pvb:choose:${startedBattle.id}:TAILS`,
              creator.telegramUserId,
            ),
          },
        ]],
      };
    try {
      if (battle.messageId) {
        await resultBot.editMessageText(
          chatId,
          battle.messageId,
          coinChoiceText,
          coinChoiceKeyboard,
        );
      } else {
        await resultBot.sendMessage(chatId, coinChoiceText, coinChoiceKeyboard);
      }
    } catch (error) {
      logger.warn({ err: error, battleId: battle.id }, "PVB coin choice message update failed");
      if (battle.messageId) {
        await resultBot.sendMessage(chatId, coinChoiceText, coinChoiceKeyboard);
      }
    }
    scheduleBattleTimeout(resultBot, startedBattle.id);
    return;
  }
  await resultBot.sendMessage(
    chatId,
    [
      `<b>✅ ${battle.gameType.toUpperCase()}–VS BOT CONFIRMED</b>`,
      "",
      `<b>ID #${battle.id}</b>`,
      `<b>STAKED AMOUNT: ${formatMoney(battle.stakeMinor, parseCurrency(battle.currency, "USD"))}</b>`,
      `<b>WIN AMOUNT: ${formatMoney(Math.round(battle.stakeMinor * 1.92), parseCurrency(battle.currency, "USD"))}</b>`,
      `<b>ROUNDS: ${battle.rounds}× · ${battle.rollsPerRound} ${battle.emoji} per round</b>`,
      "",
      `<b>${battle.emoji} NOW — send it to begin Round 1/${battle.rounds}</b>`,
      "Your result will be verified and revealed after the 3-second game reveal delay.",
      "",
      "<i>Good luck — play fair, play smart.</i>",
    ].join("\n"),
    undefined,
    premiumEmojiOptionsForGame(battle.gameType),
  );
  await promptPvbRound(resultBot, startedBattle, battle.messageId);
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
  helperBots: Map<string, TelegramBot>,
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
  const [opponentPlayer] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.telegramUserId, user.id))
    .limit(1);
  if (!opponentPlayer || battle.playerTwoId !== opponentPlayer.id) {
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
        eq(casinoChallengesTable.playerTwoId, opponentPlayer.id),
      ),
    )
    .returning();
  if (!claimedBattle) {
    await resultBot.sendMessage(chatId, "Another choice was already submitted.");
    return;
  }
  const challengerSide = pickedSide === "HEADS" ? "TAILS" : "HEADS";
  try {
    if (battle.messageId) {
      await resultBot.editMessageText(
        chatId,
        battle.messageId,
        `<b>✅ ${casinoPlayerLabel(opponentPlayer, "Opponent")} picked ${pickedSide}.</b>\n\n<b>Coin in the air... 1... 2... 3...</b>`,
        { inline_keyboard: [] },
      );
    }
  } catch (error) {
    logger.warn({ err: error, battleId: battle.id }, "Coin PVP choice message update failed");
  }
  await sendPvpMessage(
    resultBot,
    chatId,
    `🪙 ${casinoPlayerLabel(opponentPlayer, "Opponent")} picked ${pickedSide}.`,
  );
  await sendPvpMessage(
    resultBot,
    chatId,
    "🪙 Coin in the air... 1... 2... 3...",
  );
  await wait(3_000);
  const coinBot =
    helperBots.get("coin") ??
    helperBots.get("dice") ??
    Array.from(new Set(helperBots.values()))[0] ??
    resultBot;
  const landedSide = randomInt(0, 2) === 0 ? "HEADS" : "TAILS";
  await coinBot.sendSticker(
    chatId,
    landedSide === "HEADS"
      ? "CAACAgUAAxkBAAFTwsdqoCIDn3aYNkEzBzK4bgaG_1nKTQACNiAAAqKnAAFVo9ol5MRo_sE9BA"
      : "CAACAgUAAxkBAAFTwshqoCIEvo5YGjBgGT068tbqlGtqqwAC1CEAAhR4AAFVY1ajxrKoHbg9BA",
  );
  await wait(PVP_RESULT_DELAY_MS);
  const chosenPlayerWon = pickedSide === landedSide;
  const playerOneWon = !chosenPlayerWon;
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
  const winner = chosenPlayerWon ? opponent : challenger;
  await sendPvpMessage(
    resultBot,
    chatId,
    [
      `🪙 <b>Coin Flip #${String(battle.id).padStart(4, "0")} — Result</b>`,
      "",
      `Coin landed on: <b>${landedSide}</b>`,
      `<b>Chosen side:</b> ${pickedSide}`,
      `<b>Chosen player:</b> ${casinoPlayerLabel(opponent, "Opponent")}`,
      `${casinoPlayerLabel(challenger, "Challenger")}: ${challengerSide}`,
      "",
      chosenPlayerWon
        ? `<b>🏆 ${casinoPlayerLabel(opponent, "Player")} chose ${pickedSide} and WON.</b>`
        : `<b>❌ ${casinoPlayerLabel(opponent, "Player")} chose ${pickedSide} and LOST.</b>`,
      `<b>Winner: ${casinoPlayerLabel(winner, "Player")}</b>`,
      `<b>Loser: ${casinoPlayerLabel(winner === opponent ? challenger : opponent, "Player")}</b>`,
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
  await sendPvpMessage(
    resultBot,
    battle.chatId,
    [
      `<b>⚔️ PVP ROOM #${String(battle.id).padStart(4, "0")} IS LIVE</b>`,
      "",
      `<b>🎯 ${label}</b>, it is your turn.`,
      `Round ${round}/${battle.targetWins ? `${battle.targetWins} wins` : battle.rounds} · ${remaining} ${remaining === 1 ? "throw" : "throws"} remaining`,
      "",
      `<b>Send ${battle.emoji} directly now.</b>`,
      "<i>Forwarded, stale, duplicate, or incorrect game emojis are rejected for fairness.</i>",
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
  battleTimeoutWarnings.delete(battle.id);
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
  await sendDelayedPvpResult(
    resultBot,
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
    await sendDelayedPvpResult(
      resultBot,
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
        stakeMinor: battle.stakeMinor,
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
  existingMessageId?: number | null,
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
  const text = [
      `<b>${battle.emoji} ${battle.gameType.toUpperCase()}–VS BOT · ROUND ${round}/${battle.rounds}</b>`,
      `<b>ID #${battle.id} · STAKE ${formatMoney(battle.stakeMinor, parseCurrency(battle.currency, "USD"))} · WIN ${formatMoney(Math.round(battle.stakeMinor * 1.92), parseCurrency(battle.currency, "USD"))}</b>`,
      "",
      `<b>🎯 ${escapeTelegramText(creatorLabel)}</b>, send <b>${battle.emoji}</b> directly in this group.`,
      `<b>${remaining}</b> ${remaining === 1 ? "emoji" : "emojis"} remaining in this round · 120 seconds`,
      "",
      "<i>Send only the fresh Telegram game emoji. Forwarded or duplicate rolls are rejected.</i>",
    ].join("\n");
  if (existingMessageId) {
    try {
      await resultBot.editMessageText(
        battle.chatId,
        existingMessageId,
        text,
        { inline_keyboard: [] },
        premiumEmojiOptionsForGame(battle.gameType),
      );
      return;
    } catch (error) {
      logger.warn({ err: error, battleId: battle.id }, "PVB prompt message update failed");
    }
  }
  await resultBot.sendMessage(
    battle.chatId,
    text,
    undefined,
    premiumEmojiOptionsForGame(battle.gameType),
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

function normalizeGameEmoji(value: string): string {
  return value.replace(/\uFE0F/g, "");
}

function isFreshDirectDiceMessage(
  message: TelegramMessage,
  expectedEmoji: string,
): boolean {
  if (
    !message.dice ||
    normalizeGameEmoji(message.dice.emoji) !== normalizeGameEmoji(expectedEmoji) ||
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
        normalizeGameEmoji(roll.dice.emoji) !== normalizeGameEmoji(expectedEmoji) ||
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
  await sendDelayedGameResult(
    resultBot,
    battle.chatId,
    [
      `<b>🏆 ${battle.gameType.toUpperCase()} ROUND ${round} RESULT</b>`,
      `${playerWinsRound ? creatorLabel : houseWinsRound ? botLabel : "Tie"} ${
        playerWinsRound || houseWinsRound ? "✅" : "🤝"
      } (${playerRound} - ${houseRound})`,
      `<b>${creatorLabel}:</b> ${playerRound} · <b>${botLabel}:</b> ${houseRound}`,
    ].join("\n"),
    undefined,
    premiumEmojiOptionsForGame(battle.gameType),
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
      await sendDelayedGameResult(
        resultBot,
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
          stakeMinor: battle.stakeMinor,
          payoutMinor: tie || !playerOneWon ? 0 : Math.round(battle.stakeMinor * 1.92),
          currency: parseCurrency(battle.currency, "USD"),
          fairId: battle.fairId ?? "legacy",
        }),
        creator ? pvbRematchKeyboard(battle, creator) : undefined,
        premiumEmojiOptionsForGame(battle.gameType),
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
    await sendDelayedGameResult(
      resultBot,
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
        stakeMinor: battle.stakeMinor,
        payoutMinor: tie || !playerOneWon ? 0 : Math.round(battle.stakeMinor * 1.92),
        currency: parseCurrency(battle.currency, "USD"),
        fairId: battle.fairId ?? "legacy",
      }),
      creator ? pvbRematchKeyboard(battle, creator) : undefined,
      premiumEmojiOptionsForGame(battle.gameType),
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
  battleTimeoutWarnings.delete(battle.id);
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
    await sendDelayedGameResult(
      bot,
      chatId,
      simpleGameResultText({
        gameType,
        choice,
        rollValues,
        rollValue,
        outcome,
        stakeMinor,
        payoutMinor,
        currency,
        balanceMinor: settled.balanceMinor,
        fairId: settled.fairId,
      }),
      undefined,
      premiumEmojiOptionsForGame(gameType),
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

function limboCardSvg(data: {
  player: string;
  bet: string;
  target: string;
  result: string;
  won: boolean;
}): string {
  const status = data.won ? "WINNER" : "BUSTED";
  const statusColor = data.won ? "#65e572" : "#ff477e";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="650" viewBox="0 0 1200 650">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#16072f"/><stop offset="1" stop-color="#35105b"/>
    </linearGradient>
    <linearGradient id="rocket" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#e9d5ff"/><stop offset="1" stop-color="#8d36ca"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="650" rx="30" fill="url(#bg)"/>
  <circle cx="100" cy="100" r="3" fill="#fff"/><circle cx="270" cy="210" r="4" fill="#f9d5ff"/>
  <circle cx="930" cy="120" r="3" fill="#fff"/><circle cx="1060" cy="260" r="4" fill="#f9d5ff"/>
  <text x="55" y="65" fill="#f7d66b" font-size="28" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO · LIMBO</text>
  <text x="55" y="112" fill="${statusColor}" font-size="34" font-family="DejaVu Sans" font-weight="bold">${status}!</text>
  <text x="55" y="190" fill="#fff" font-size="116" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.result)}x</text>
  <text x="60" y="235" fill="#d9c8ef" font-size="27" font-family="DejaVu Sans">Target multiplier: ${escapeXml(data.target)}x</text>
  <g transform="translate(845 75) rotate(16)">
    <path d="M120 15 C188 70 193 180 120 255 C47 180 52 70 120 15Z" fill="url(#rocket)" stroke="#b04ce2" stroke-width="6"/>
    <circle cx="120" cy="112" r="28" fill="#56d8e8" stroke="#793bb2" stroke-width="9"/>
    <path d="M58 178 L10 220 L30 153Z" fill="#8e35c8"/><path d="M182 178 L230 220 L210 153Z" fill="#8e35c8"/>
    <path d="M91 248 L76 320 L120 272 L164 320 L149 248Z" fill="#ffbd30"/>
    <path d="M101 260 L94 304 L120 276 L146 304 L139 260Z" fill="#ff5f2e"/>
  </g>
  <line x1="55" y1="305" x2="1145" y2="305" stroke="#ffffff" stroke-opacity=".16"/>
  <rect x="42" y="324" width="1116" height="210" rx="26" fill="#ffffff" fill-opacity=".06" stroke="#ffffff" stroke-opacity=".12"/>
  <text x="78" y="375" fill="#cdbce2" font-size="24" font-family="DejaVu Sans" font-weight="bold">PLAYER</text>
  <text x="78" y="422" fill="#fff" font-size="38" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.player)}</text>
  <text x="78" y="485" fill="#cdbce2" font-size="24" font-family="DejaVu Sans" font-weight="bold">BET</text>
  <text x="78" y="525" fill="#fff" font-size="36" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.bet)}</text>
  <text x="720" y="375" fill="#cdbce2" font-size="24" font-family="DejaVu Sans" font-weight="bold">STATUS</text>
  <text x="720" y="422" fill="${statusColor}" font-size="38" font-family="DejaVu Sans" font-weight="bold">${status}</text>
  <text x="55" y="605" fill="#b59acb" font-size="21" font-family="DejaVu Sans">FAIR RANDOM RESULT · PROVABLY GENERATED BY ROLEXCASINO</text>
</svg>`;
}

async function limboCardPng(data: {
  player: string;
  bet: string;
  target: string;
  result: string;
  won: boolean;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render limbo image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(limboCardSvg(data)));
  });
}

async function playLimbo(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  amountMinor: number | null,
  targetMultiplier: number | null,
  currency: Currency,
): Promise<void> {
  if (!amountMinor || !targetMultiplier || targetMultiplier < 1.01 || targetMultiplier > 100) {
    await bot.sendMessage(
      chatId,
      "<b>Usage:</b> /limbo AMOUNT TARGETx INR|USD\nExample: /limbo 30 1.93x INR",
    );
    return;
  }
  if (!(await betInRange(amountMinor, currency, "limbo"))) {
    await bot.sendMessage(chatId, await configuredBetLimitText(currency, "limbo"));
    return;
  }
  const player = await ensurePlayer(user);
  const wallet = await ensureWallet(player.id, currency);
  if (wallet.balanceMinor < amountMinor) {
    await bot.sendMessage(
      chatId,
      `<b>❌ Insufficient balance</b>\nAvailable: <b>${formatMoney(wallet.balanceMinor, currency)}</b>`,
    );
    return;
  }
  // Limbo intentionally resolves toward low multipliers. Results stay within
  // 1.50x–20x, with 2x–5x overwhelmingly more common and high results rare.
  // The distribution is independent of stake and target so every bet remains fair.
  const randomUnit = randomInt(1, 10_001) / 10_000;
  const resultMultiplier = Math.min(
    20,
    Number((1.5 + Math.pow(randomUnit, 6) * 18.5).toFixed(2)),
  );
  const resultCents = Math.round(resultMultiplier * 100);
  const won = resultMultiplier >= targetMultiplier;
  const settled = await settleGame({
    playerId: player.id,
    helperBot: "limbo-main",
    gameType: "limbo",
    currency,
    stakeMinor: amountMinor,
    rollValue: resultCents,
    result: {
      outcome: won ? "WIN" : "LOSS",
      multiplier: won ? targetMultiplier : 0,
    },
  });
  const payoutMinor = won ? Math.round(amountMinor * targetMultiplier) : 0;
  if (won) {
    await broadcastPlayerWin(bot, player.id, "limbo", payoutMinor, currency);
  }
  const image = await limboCardPng({
    player: player.username ? `@${player.username}` : player.displayName,
    bet: formatMoney(amountMinor, currency),
    target: targetMultiplier.toFixed(2),
    result: resultMultiplier.toFixed(2),
    won,
  });
  await wait(PVP_RESULT_DELAY_MS);
  await bot.sendPhoto(
    chatId,
    image,
    [
      "<b>🚀 ROLEXCASINO LIMBO</b>",
      "",
      `Player: <b>${escapeTelegramText(player.displayName)}</b>`,
      `Bet: <b>${formatMoney(amountMinor, currency)}</b>`,
      `Target: <b>${targetMultiplier.toFixed(2)}x</b>`,
      `Result: <b>${resultMultiplier.toFixed(2)}x</b>`,
      won
        ? `<b>✅ WIN — ${formatMoney(payoutMinor, currency)} (${targetMultiplier.toFixed(2)}x)</b>`
        : `<b>❌ LOSS — ${formatMoney(amountMinor, currency)}</b>`,
      `Balance: <b>${formatMoney(settled.balanceMinor, currency)}</b>`,
      `Fair ID: <code>${settled.fairId}</code>`,
    ].join("\n"),
  );
}

function minesBombPositions(fairId: string, mines: number): Set<number> {
  const cells = Array.from({ length: 16 }, (_, index) => index);
  let seed = 2_166_136_261;
  for (const character of fairId) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16_777_619) >>> 0;
  }
  for (let index = cells.length - 1; index > 0; index -= 1) {
    seed = Math.imul(seed ^ index, 16_777_619) >>> 0;
    const swapIndex = seed % (index + 1);
    [cells[index], cells[swapIndex]] = [cells[swapIndex], cells[index]];
  }
  return new Set(cells.slice(0, mines));
}

function minesMultiplier(mines: number, revealedCount: number): number {
  const tables: Record<number, number[]> = {
    1: [1.1, 1.2, 1.3, 1.5, 1.71, 2.0, 2.21, 2.41, 2.69, 3.1, 3.51, 4.1, 4.5, 5.51, 7.41, 10],
    2: [1.1, 1.31, 1.52, 2.1, 2.52, 3.48, 4.38, 5.69, 7.78, 9.28, 12.31, 15.12, 17.13, 19.23, 21.23, 25],
    3: [1.1, 1.25, 1.45, 1.75, 2.15, 2.7, 3.4, 4.25, 5.35, 6.75, 8.55, 10.8, 13.65, 17.25, 21.8, 27.5],
  };
  const table = tables[mines] ?? tables[3];
  return table[Math.min(Math.max(revealedCount - 1, 0), table.length - 1)] ?? 1;
}

function minesKeyboard(
  bot: TelegramBot,
  game: MinesGame,
): { inline_keyboard: InlineKeyboardButton[][] } {
  const finished = game.status !== "active";
  const rows: InlineKeyboardButton[][] = [];
  for (let row = 0; row < 4; row += 1) {
    rows.push(
      Array.from({ length: 4 }, (_, column) => {
        const cell = row * 4 + column;
        return {
          text: finished && game.bombs.has(cell)
            ? "💣"
            : game.revealed.has(cell)
              ? "💎"
              : "⬜",
          callback_data: ownedCallback(
            finished
              ? `mines:closed:${game.fairId}`
              : `mines:open:${game.fairId}:${cell}`,
            game.userId,
          ),
        };
      }),
    );
  }
  if (!finished) {
    if (game.autoMode && game.autoRunning) {
      rows.push([
        {
          text: "⏹ Stop Auto",
          callback_data: ownedCallback(`mines:auto:stop:${game.fairId}`, game.userId),
        },
        {
          text: `💰 Cash Out ${game.multiplier.toFixed(2)}×`,
          callback_data: ownedCallback(`mines:cashout:${game.fairId}`, game.userId),
        },
      ]);
    } else {
      rows.push([
        {
          text: `💰 Cash Out ${game.multiplier.toFixed(2)}×`,
          callback_data: ownedCallback(`mines:cashout:${game.fairId}`, game.userId),
        },
      ]);
    }
  }
  if (!finished && game.autoMode && !game.autoRunning) {
    rows.push([
      {
        text: "✅ Start Auto",
        callback_data: ownedCallback(`mines:auto:start:${game.fairId}`, game.userId),
      },
    ]);
  }
  rows.push([
    {
      text: "🔎 Verify Fairness",
      url: privateBotUrl(bot, `fair_${game.fairId}`),
    },
  ]);
  return { inline_keyboard: rows };
}

function minesBoardText(game: MinesGame, result?: string): string {
  const safeCount = game.revealed.size;
  return [
    "<b>💣 ROLEXCASINO MINES</b>",
    "",
    `Stake: <b>${formatMoney(game.amountMinor, game.currency)}</b>`,
    `Mines: <b>${game.mines}</b> · Safe clicks: <b>${safeCount}</b>`,
    `Current multiplier: <b>${game.multiplier.toFixed(2)}×</b>`,
    result ?? "<i>Choose a tile. One wrong click ends the round.</i>",
    "",
    `Fair ID: <code>${game.fairId}</code>`,
  ].join("\n");
}

async function reserveMinesStake(game: MinesGame): Promise<void> {
  const wallet = await ensureWallet(game.playerId, game.currency);
  const jackpot = await ensureJackpot(game.currency);
  const [participant] = await db
    .select()
    .from(casinoJackpotParticipantsTable)
    .where(
      and(
        eq(casinoJackpotParticipantsTable.jackpotId, jackpot.id),
        eq(casinoJackpotParticipantsTable.playerId, game.playerId),
      ),
    )
    .limit(1);
  const totalDebit = game.amountMinor + game.jackpotMinor;
  if (wallet.balanceMinor < totalDebit) throw new Error("INSUFFICIENT_BALANCE");
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} - ${totalDebit}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoWalletsTable.id, wallet.id),
          gte(casinoWalletsTable.balanceMinor, totalDebit),
        ),
      )
      .returning();
    if (!updated) throw new Error("INSUFFICIENT_BALANCE");
    const transactionId = randomUUID();
    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: wallet.id,
      transactionId,
      entryType: "game_stake",
      amountMinor: -game.amountMinor,
      description: `mines stake; fair ${game.fairId}`,
    });
    if (game.jackpotMinor > 0) {
      await tx.insert(casinoLedgerEntriesTable).values({
        walletId: wallet.id,
        transactionId,
        entryType: "jackpot_contribution",
        amountMinor: -game.jackpotMinor,
        description: `mines jackpot contribution; fair ${game.fairId}`,
      });
      if (participant) {
        await tx
          .update(casinoJackpotParticipantsTable)
          .set({
            contributionMinor: sql`${casinoJackpotParticipantsTable.contributionMinor} + ${game.jackpotMinor}`,
          })
          .where(eq(casinoJackpotParticipantsTable.id, participant.id));
      }
      await tx
        .update(casinoJackpotsTable)
        .set({ poolMinor: sql`${casinoJackpotsTable.poolMinor} + ${game.jackpotMinor}` })
        .where(eq(casinoJackpotsTable.id, jackpot.id));
    }
  });
}

async function completeMinesGame(
  game: MinesGame,
  outcome: "LOSS" | "CASHOUT",
): Promise<{ balanceMinor: number; payoutMinor: number }> {
  const wallet = await ensureWallet(game.playerId, game.currency);
  const house = await ensureHouseWallet(game.currency);
  const payoutMinor = outcome === "CASHOUT"
    ? Math.round(game.amountMinor * game.multiplier)
    : 0;
  const balance = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${payoutMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, wallet.id))
      .returning();
    if (!updated) throw new Error("MINES_SETTLEMENT_FAILED");
    const transactionId = randomUUID();
    if (payoutMinor > 0) {
      await tx.insert(casinoLedgerEntriesTable).values({
        walletId: wallet.id,
        transactionId,
        entryType: "game_payout",
        amountMinor: payoutMinor,
        description: `mines cash out at ${game.multiplier.toFixed(2)}x; fair ${game.fairId}`,
      });
    }
    await tx
      .update(casinoHouseWalletsTable)
      .set({
        balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} + ${houseContribution(game.amountMinor, payoutMinor)}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoHouseWalletsTable.id, house.id));
    await tx.insert(casinoGameRoundsTable).values({
      playerId: game.playerId,
      helperBot: "mines-main",
      gameType: "mines",
      currency: game.currency,
      stakeMinor: game.amountMinor,
      rollValue: game.revealed.size,
      outcome,
      payoutMinor,
      fairId: game.fairId,
    });
    await tx
      .insert(casinoWagerRequirementsTable)
      .values({
        playerId: game.playerId,
        currency: game.currency,
        requiredMinor: 0,
        completedMinor: game.amountMinor,
      })
      .onConflictDoUpdate({
        target: [
          casinoWagerRequirementsTable.playerId,
          casinoWagerRequirementsTable.currency,
        ],
        set: {
          completedMinor: sql`LEAST(${casinoWagerRequirementsTable.requiredMinor}, ${casinoWagerRequirementsTable.completedMinor} + ${game.amountMinor})`,
          updatedAt: new Date(),
        },
      });
    await recordDailyLoss(
      tx,
      game.playerId,
      game.currency,
      Math.max(0, game.amountMinor + game.jackpotMinor - payoutMinor),
    );
    return updated.balanceMinor;
  });
  return { balanceMinor: balance, payoutMinor };
}

async function sendMinesSelection(
  bot: TelegramBot,
  chatId: number,
  amountMinor: number,
  currency: Currency,
  userId: number,
): Promise<void> {
  const active = [...activeMinesGames.values()].find((game) => game.userId === userId);
  if (active) {
    await bot.sendMessage(chatId, "You already have an active Mines round. Finish it or cash out before starting another.");
    return;
  }
  await bot.sendMessage(
    chatId,
    [
      "<b>💣 MINES — CHOOSE YOUR DIFFICULTY</b>",
      "",
      `Stake: <b>${formatMoney(amountMinor, currency)}</b>`,
      "Choose how many hidden mines will be placed across 16 tiles.",
      "",
      "1 mine · 1.10× per safe click",
      "2 mines · 1.20× per safe click",
      "3 mines · 1.30× per safe click",
    ].join("\n"),
    {
      inline_keyboard: [[
        { text: "💣 1 Mine", callback_data: ownedCallback(`mines:select:${amountMinor}:${currency}:1`, userId) },
        { text: "💣 2 Mines", callback_data: ownedCallback(`mines:select:${amountMinor}:${currency}:2`, userId) },
        { text: "💣 3 Mines", callback_data: ownedCallback(`mines:select:${amountMinor}:${currency}:3`, userId) },
      ]],
    },
  );
}

async function startMinesGame(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  amountMinor: number,
  currency: Currency,
  mines: number,
  autoMode = false,
): Promise<void> {
  const player = await ensurePlayer(user);
  if (mines < 1 || mines > 3 || !(await betInRange(amountMinor, currency, "mines"))) {
    await bot.sendMessage(chatId, await configuredBetLimitText(currency, "mines"));
    return;
  }
  const wallet = await ensureWallet(player.id, currency);
  const jackpot = await ensureJackpot(currency);
  const [participant] = await db
    .select()
    .from(casinoJackpotParticipantsTable)
    .where(
      and(
        eq(casinoJackpotParticipantsTable.jackpotId, jackpot.id),
        eq(casinoJackpotParticipantsTable.playerId, player.id),
      ),
    )
    .limit(1);
  const jackpotMinor = jackpotContribution(amountMinor, Boolean(participant));
  if (wallet.balanceMinor < amountMinor + jackpotMinor) {
    await bot.sendMessage(chatId, `<b>❌ Insufficient balance</b>\nAvailable: <b>${formatMoney(wallet.balanceMinor, currency)}</b>`);
    return;
  }
  const game: MinesGame = {
    fairId: createFairId(),
    userId: user.id,
    playerId: player.id,
    chatId,
    amountMinor,
    currency,
    mines,
    jackpotMinor,
    bombs: new Set(),
    revealed: new Set(),
    multiplier: 1,
    status: "active",
    autoMode,
    autoRunning: false,
  };
  game.bombs = minesBombPositions(game.fairId, mines);
  await reserveMinesStake(game);
  activeMinesGames.set(game.fairId, game);
  minesFairRecords.set(game.fairId, game);
  const sent = await bot.sendMessage(chatId, minesBoardText(game), minesKeyboard(bot, game));
  game.messageId = sent.message_id;
}

async function handleMinesChoice(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  fairId: string,
  cell: number,
  internalAuto = false,
): Promise<void> {
  const game = activeMinesGames.get(fairId);
  if (!game || game.userId !== user.id || game.status !== "active") {
    if (!internalAuto) await bot.sendMessage(chatId, "That Mines round is no longer active.");
    return;
  }
  if (settlingMinesGames.has(fairId)) return;
  if (game.autoMode && game.autoRunning && !internalAuto) return;
  if (cell < 0 || cell >= 16 || game.revealed.has(cell)) return;
  if (game.bombs.has(cell)) {
    settlingMinesGames.add(fairId);
    game.status = "lost";
    await wait(PVP_RESULT_DELAY_MS);
    const settled = await completeMinesGame(game, "LOSS");
    activeMinesGames.delete(fairId);
    settlingMinesGames.delete(fairId);
    if (game.messageId) {
      await bot.editMessageText(
        chatId,
        game.messageId,
        minesBoardText(
          game,
          `<b>❌ LOSS — ${formatMoney(game.amountMinor, game.currency)}</b>\nBalance: <b>${formatMoney(settled.balanceMinor, game.currency)}</b>`,
        ),
          minesKeyboard(bot, game),
      );
    }
    return;
  }
  game.revealed.add(cell);
  game.multiplier = minesMultiplier(game.mines, game.revealed.size);
  if (game.revealed.size >= 16 - game.mines) {
    settlingMinesGames.add(fairId);
    game.status = "cashed_out";
    await wait(PVP_RESULT_DELAY_MS);
    const settled = await completeMinesGame(game, "CASHOUT");
    activeMinesGames.delete(fairId);
    settlingMinesGames.delete(fairId);
    if (game.messageId) {
      await bot.editMessageText(
        chatId,
        game.messageId,
        minesBoardText(
          game,
          `<b>✅ PERFECT CLEAR — CASHED OUT ${formatMoney(settled.payoutMinor, game.currency)}</b>\nBalance: <b>${formatMoney(settled.balanceMinor, game.currency)}</b>`,
        ),
          minesKeyboard(bot, game),
      );
    }
    return;
  }
  if (game.messageId) {
    await bot.editMessageText(chatId, game.messageId, minesBoardText(game), minesKeyboard(bot, game));
  }
}

async function runMinesAuto(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  fairId: string,
): Promise<void> {
  const game = activeMinesGames.get(fairId);
  if (!game || game.userId !== user.id || game.status !== "active" || !game.autoMode) return;
  if (game.autoRunning) return;
  game.autoRunning = true;
  if (game.messageId) {
    await bot.editMessageText(chatId, game.messageId, minesBoardText(game, "<b>✅ AUTO MODE RUNNING</b>\nCash out at any safe reveal."), minesKeyboard(bot, game));
  }
  for (let cell = 0; cell < 16; cell += 1) {
    if (!activeMinesGames.has(fairId) || game.status !== "active" || !game.autoRunning) return;
    if (game.revealed.has(cell)) continue;
    await wait(1_000);
    if (!activeMinesGames.has(fairId) || game.status !== "active" || !game.autoRunning) return;
    await handleMinesChoice(bot, chatId, user, fairId, cell, true);
  }
}

async function stopMinesAuto(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  fairId: string,
): Promise<void> {
  const game = activeMinesGames.get(fairId);
  if (!game || game.userId !== user.id || game.status !== "active") {
    await bot.sendMessage(chatId, "That Mines round is no longer active.");
    return;
  }
  game.autoRunning = false;
  if (game.messageId) {
    await bot.editMessageText(
      chatId,
      game.messageId,
      minesBoardText(game, "<b>⏹ AUTO MODE STOPPED</b>\nChoose a tile, start Auto again, or cash out."),
      minesKeyboard(bot, game),
    );
  }
}

async function cashOutMines(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  fairId: string,
): Promise<void> {
  const game = activeMinesGames.get(fairId);
  if (!game || game.userId !== user.id || game.status !== "active") {
    await bot.sendMessage(chatId, "That Mines round is no longer active.");
    return;
  }
  if (settlingMinesGames.has(fairId)) return;
  settlingMinesGames.add(fairId);
  game.status = "cashed_out";
  game.autoRunning = false;
  activeMinesGames.delete(fairId);
  if (game.messageId) {
    try {
      await bot.editMessageText(
        chatId,
        game.messageId,
        minesBoardText(
          game,
          "<b>⚡ CASH-OUT PROCESSING</b>\nYour payout is being settled now.",
        ),
        { inline_keyboard: [] },
      );
    } catch (error) {
      logger.debug(
        { err: error, fairId },
        "Mines cash-out processing message update failed",
      );
    }
  }
  let settled: { balanceMinor: number; payoutMinor: number };
  try {
    settled = await completeMinesGame(game, "CASHOUT");
  } finally {
    settlingMinesGames.delete(fairId);
  }
  if (game.messageId) {
    await bot.editMessageText(
      chatId,
      game.messageId,
      minesBoardText(
        game,
        `<b>🏆 MINES CASH-OUT SUCCESSFUL</b>\nPayout: <b>${formatMoney(settled.payoutMinor, game.currency)}</b>\nBalance: <b>${formatMoney(settled.balanceMinor, game.currency)}</b>`,
      ),
      minesKeyboard(bot, game),
    );
  }
}

async function sendFairVerification(
  bot: TelegramBot,
  chatId: number,
  fairId: string,
): Promise<void> {
  const game = minesFairRecords.get(fairId);
  if (!game) {
    await bot.sendMessage(
      chatId,
      `<b>🔎 Fairness verification</b>\n\nFair ID <code>${escapeTelegramText(fairId)}</code> was not found in the current verification cache.`,
    );
    return;
  }
  const bombs = [...game.bombs]
    .map((cell) => cell + 1)
    .sort((left, right) => left - right);
  const isFinished = game.status !== "active";
  await bot.sendMessage(
    chatId,
    [
      "<b>✅ PROVABLY FAIR MINES VERIFICATION</b>",
      "",
      `Fair ID: <code>${escapeTelegramText(game.fairId)}</code>`,
      `Status: <b>${isFinished ? "Verified — 100% fair" : "Committed — result sealed until the round ends"}</b>`,
      `Board: <b>4×4 (${game.mines} hidden mines)</b>`,
      isFinished
        ? `Bomb cells: <code>${bombs.join(", ")}</code>`
        : "Bomb cells: <i>sealed until the round ends</i>",
      "",
      "The mine positions were generated deterministically from the Fair ID before the first tile was opened.",
      isFinished
        ? "No result was changed after the round began."
        : "The sealed board cannot be changed while you play.",
    ].join("\n"),
  );
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
    await sendTipCard(
      bot,
      chatId,
      {
        status: "CONFIRMATION REQUIRED",
        from: player.displayName,
        to: targetPlayer.displayName,
        amount: formatMoney(amountMinor, currency),
        currency,
        balance: "Pending confirmation",
        fairId: "created after confirmation",
        note: "Tips above ₹50 require confirmation",
      },
      {
        inline_keyboard: [[
          {
            text: "Confirm tip",
            callback_data: `tip:confirm:${player.id}:${targetPlayer.id}:${amountMinor}:${currency}`,
          },
          {
            text: "Cancel",
            callback_data: `tip:cancel:${player.id}:${targetPlayer.id}:${amountMinor}:${currency}`,
          },
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
    await sendTipCard(
      bot,
      chatId,
      {
        status: "TIP SENT SUCCESSFULLY",
        from: player.displayName,
        to: targetPlayer.displayName,
        amount: formatMoney(amountMinor, currency),
        currency,
        balance: formatMoney(balance.balanceMinor, currency),
        fairId: balance.fairId,
        note: "Funds transferred successfully",
      },
      {
        inline_keyboard: [[
          { text: "View profile", callback_data: ownedCallback("main:profile", player.telegramUserId) },
          { text: "Play games", callback_data: ownedCallback("main:games", player.telegramUserId) },
        ]],
      },
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
    await sendTipCard(
      bot,
      recipient.telegramUserId,
      {
        status: "TIP RECEIVED",
        from: sender.displayName,
        to: recipient.displayName,
        amount: formatMoney(amountMinor, currency),
        currency,
        balance: "Credited to wallet",
        fairId: "completed transfer",
        note: "Funds added to your wallet",
      },
      {
        inline_keyboard: [[
          { text: "View profile", callback_data: ownedCallback("main:profile", recipient.telegramUserId) },
        ]],
      },
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
  messageId?: number,
): Promise<void> {
  const parts = action.split(":");
  const verb = parts[1];
  const senderPlayerId = Number(parts[2]);
  if (!Number.isSafeInteger(senderPlayerId) || senderPlayerId !== player.id) {
    await bot.sendMessage(chatId, "Only the player who created this tip can confirm or cancel it.");
    return;
  }
  const targetPlayerId = Number(parts[3]);
  const amountMinor = Number(parts[4]);
  const currency = parseCurrency(parts[5], "USD");
  if (verb === "cancel") {
    let targetName = "Unknown recipient";
    if (Number.isSafeInteger(targetPlayerId) && targetPlayerId > 0) {
      const [target] = await db
        .select()
        .from(casinoPlayersTable)
        .where(eq(casinoPlayersTable.id, targetPlayerId))
        .limit(1);
      if (target) targetName = target.displayName;
    }
    await sendTipCard(
      bot,
      chatId,
      {
        status: "TIP CANCELLED",
        from: player.displayName,
        to: targetName,
        amount: Number.isSafeInteger(amountMinor) && amountMinor > 0
          ? formatMoney(amountMinor, currency)
          : "Not processed",
        currency,
        balance: "No balance changed",
        fairId: "cancelled before transfer",
        note: "The confirmation was cancelled safely",
      },
      { inline_keyboard: [] },
      messageId,
    );
    return;
  }
  if (verb !== "confirm") return;
  if (
    !Number.isSafeInteger(targetPlayerId) ||
    targetPlayerId <= 0 ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0
  ) {
    await sendTipCard(
      bot,
      chatId,
      {
        status: "TIP FAILED",
        from: player.displayName,
        to: "Unknown recipient",
        amount: "Not processed",
        currency,
        balance: "No balance changed",
        fairId: "invalid confirmation",
        note: "This tip confirmation is invalid or expired",
      },
      { inline_keyboard: [] },
      messageId,
    );
    return;
  }
  const [targetPlayer] = await db
    .select()
    .from(casinoPlayersTable)
    .where(eq(casinoPlayersTable.id, targetPlayerId))
    .limit(1);
  if (!targetPlayer) {
    await sendTipCard(
      bot,
      chatId,
      {
        status: "TIP FAILED",
        from: player.displayName,
        to: "Unavailable recipient",
        amount: formatMoney(amountMinor, currency),
        currency,
        balance: "No balance changed",
        fairId: "recipient unavailable",
        note: "The recipient is no longer available",
      },
      { inline_keyboard: [] },
      messageId,
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
    await sendTipCard(
      bot,
      chatId,
      {
        status: "TIP SENT SUCCESSFULLY",
        from: player.displayName,
        to: targetPlayer.displayName,
        amount: formatMoney(amountMinor, currency),
        currency,
        balance: formatMoney(balance.balanceMinor, currency),
        fairId: balance.fairId,
        note: "Funds transferred successfully",
      },
      {
        inline_keyboard: [[
          { text: "View profile", callback_data: ownedCallback("main:profile", player.telegramUserId) },
          { text: "Play games", callback_data: ownedCallback("main:games", player.telegramUserId) },
        ]],
      },
      messageId,
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
      await sendTipCard(
        bot,
        chatId,
        {
          status: "TIP FAILED",
          from: player.displayName,
          to: targetPlayer.displayName,
          amount: formatMoney(amountMinor, currency),
          currency,
          balance: "No balance changed",
          fairId: "insufficient balance",
          note: "Tip rejected because your balance is too low",
        },
        { inline_keyboard: [] },
        messageId,
      );
    } else if (error instanceof Error && error.message === "SELF_TIP") {
      await sendTipCard(
        bot,
        chatId,
        {
          status: "TIP FAILED",
          from: player.displayName,
          to: targetPlayer.displayName,
          amount: formatMoney(amountMinor, currency),
          currency,
          balance: "No balance changed",
          fairId: "self-tip rejected",
          note: "You cannot tip yourself",
        },
        { inline_keyboard: [] },
        messageId,
      );
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
    player?.username ? `@${player.username}` : player?.displayName ?? "Player",
    history,
  );
  await bot.sendPhoto(
    chatId,
    image,
    `<b>📜 ${escapeTelegramText(player?.displayName ?? "Player")} — latest 10 games</b>`,
  );
}

async function sendLeaderboard(bot: TelegramBot, chatId: number): Promise<void> {
  await sendWagerLeaderboard(bot, chatId, "global");
}

type WagerLeaderboardMode = "global" | "weekly" | "monthly";

type WagerLeaderboardItem = {
  rank: number;
  name: string;
  wagerInrMinor: number;
  wagerLabel: string;
};

function leaderboardPeriod(mode: WagerLeaderboardMode): {
  title: string;
  subtitle: string;
  since: Date | null;
} {
  const now = Date.now();
  if (mode === "weekly") {
    return {
      title: "WEEKLY WAGER LEADERBOARD",
      subtitle: "HIGHEST WAGER · LAST 7 DAYS · TOP 10 PLAYERS",
      since: new Date(now - 7 * 24 * 60 * 60 * 1_000),
    };
  }
  if (mode === "monthly") {
    return {
      title: "MONTHLY WAGER LEADERBOARD",
      subtitle: "HIGHEST WAGER · LAST 30 DAYS · TOP 10 PLAYERS",
      since: new Date(now - 30 * 24 * 60 * 60 * 1_000),
    };
  }
  return {
    title: "GLOBAL WAGER LEADERBOARD",
    subtitle: "ALL-TIME WAGER · TOP 10 PLAYERS",
    since: null,
  };
}

function isLeaderboardBot(player: typeof casinoPlayersTable.$inferSelect): boolean {
  return Boolean(
      player.isBot ||
      /(?:^|[_\-\s])bot(?:$|[_\-\s])/i.test(player.username ?? "") ||
      /(?:^|\s)bot(?:$|\s)/i.test(player.displayName),
  );
}

function wagerLeaderboardSvg(
  mode: WagerLeaderboardMode,
  items: WagerLeaderboardItem[],
): string {
  const period = leaderboardPeriod(mode);
  const rows = items.length > 0
    ? items.map((item, index) => {
        const y = 296 + index * 54;
        const fill = index === 0 ? "#f6c453" : index === 1 ? "#cbd5e1" : index === 2 ? "#d99862" : "#ffffff";
        return [
          `<rect x="58" y="${y - 34}" width="1084" height="45" rx="14" fill="#ffffff" fill-opacity="${index < 3 ? ".09" : ".045"}" stroke="#ffffff" stroke-opacity=".08"/>`,
          `<text x="88" y="${y}" fill="${fill}" font-size="29" font-family="DejaVu Sans, sans-serif" font-weight="bold">${item.rank}</text>`,
          `<text x="172" y="${y}" fill="#ffffff" font-size="27" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(svgLabel(item.name, 28))}</text>`,
          `<text x="1100" y="${y}" text-anchor="end" fill="${index < 3 ? "#76e3a3" : "#dbe7f5"}" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(item.wagerLabel)}</text>`,
        ].join("");
      }).join("")
    : `<text x="600" y="350" text-anchor="middle" fill="#a9bad2" font-size="26" font-family="DejaVu Sans, sans-serif">No qualifying player wagers yet</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <defs><linearGradient id="wagerBg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0d172d"/><stop offset=".55" stop-color="#172b4b"/><stop offset="1" stop-color="#111a35"/>
  </linearGradient></defs>
  <rect width="1200" height="900" rx="42" fill="url(#wagerBg)"/>
  <circle cx="1080" cy="90" r="230" fill="#f6c453" opacity=".10"/>
  <circle cx="70" cy="830" r="230" fill="#3b82f6" opacity=".10"/>
  <rect x="42" y="42" width="1116" height="816" rx="32" fill="none" stroke="#ffffff" stroke-opacity=".15"/>
  <text x="78" y="112" fill="#f6c453" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="78" y="176" fill="#ffffff" font-size="45" font-family="DejaVu Sans, sans-serif" font-weight="bold">${period.title}</text>
  <text x="78" y="218" fill="#9db0cb" font-size="22" font-family="DejaVu Sans, sans-serif" letter-spacing="2">${period.subtitle}</text>
  <text x="172" y="266" fill="#8da2bd" font-size="18" font-family="DejaVu Sans, sans-serif" font-weight="bold">PLAYER</text>
  <text x="1100" y="266" text-anchor="end" fill="#8da2bd" font-size="18" font-family="DejaVu Sans, sans-serif" font-weight="bold">WAGERED (INR VALUE)</text>
  ${rows}
  <text x="78" y="825" fill="#7185a3" font-size="17" font-family="DejaVu Sans, sans-serif">Only verified human player accounts are shown. USD wagers are converted at the current platform rate.</text>
</svg>`;
}

async function wagerLeaderboardPng(
  mode: WagerLeaderboardMode,
  items: WagerLeaderboardItem[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render wager leaderboard image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(wagerLeaderboardSvg(mode, items)));
  });
}

async function sendWagerLeaderboard(
  bot: TelegramBot,
  chatId: number,
  mode: WagerLeaderboardMode,
): Promise<void> {
  const period = leaderboardPeriod(mode);
  const roundRows = await db
    .select({
      playerId: casinoGameRoundsTable.playerId,
      stakeMinor: casinoGameRoundsTable.stakeMinor,
      currency: casinoGameRoundsTable.currency,
    })
    .from(casinoGameRoundsTable)
    .where(period.since ? gte(casinoGameRoundsTable.createdAt, period.since) : undefined);
  const battleRows = await db
    .select({
      creatorPlayerId: casinoChallengesTable.creatorPlayerId,
      playerTwoId: casinoChallengesTable.playerTwoId,
      stakeMinor: casinoChallengesTable.stakeMinor,
      currency: casinoChallengesTable.currency,
      completedAt: casinoChallengesTable.completedAt,
    })
    .from(casinoChallengesTable)
    .where(
      and(
        eq(casinoChallengesTable.status, "completed"),
        ...(period.since ? [gte(casinoChallengesTable.completedAt, period.since)] : []),
      ),
    );
  const wagerByPlayer = new Map<number, number>();
  const addWager = (playerId: number | null, amountMinor: number, currency: string) => {
    if (playerId == null) return;
    const wagerInr = convertMinor(amountMinor, parseCurrency(currency, "USD"), "INR");
    wagerByPlayer.set(playerId, (wagerByPlayer.get(playerId) ?? 0) + wagerInr);
  };
  for (const row of roundRows) addWager(row.playerId, row.stakeMinor, row.currency);
  for (const row of battleRows) {
    addWager(row.creatorPlayerId, row.stakeMinor, row.currency);
    addWager(row.playerTwoId, row.stakeMinor, row.currency);
  }
  const playerIds = [...wagerByPlayer.keys()];
  const players = playerIds.length > 0
    ? await db.select().from(casinoPlayersTable).where(inArray(casinoPlayersTable.id, playerIds))
    : [];
  const playerById = new Map(players.map((player) => [player.id, player]));
  const items = playerIds
    .filter((playerId) => {
      const player = playerById.get(playerId);
      return Boolean(player && !isLeaderboardBot(player));
    })
    .sort((left, right) => (wagerByPlayer.get(right) ?? 0) - (wagerByPlayer.get(left) ?? 0))
    .slice(0, 10)
    .map((playerId, index) => {
      const player = playerById.get(playerId);
      const wagerInrMinor = wagerByPlayer.get(playerId) ?? 0;
      return {
        rank: index + 1,
        name: player?.username ? `@${player.username}` : player?.displayName ?? "Player",
        wagerInrMinor,
        wagerLabel: formatMoney(wagerInrMinor, "INR"),
      };
    });
  const image = await wagerLeaderboardPng(mode, items);
  const periodTitle = leaderboardPeriod(mode);
  await bot.sendPhoto(
    chatId,
    image,
    `<b>🏆 ${periodTitle.title}</b>\n${periodTitle.subtitle}\n\nOnly verified human player accounts are shown.`,
  );
}

async function sendGames(
  bot: TelegramBot,
  chatId: number,
  helperLinks: Map<string, string>,
  ownerTelegramUserId: number,
): Promise<void> {
  const configuredLimits = await Promise.all(
      ["dice", "darts", "basketball", "football", "bowling", "slots", "limbo", "mines", "roulette"].map(
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
      "🚀 <b>Limbo</b>",
      "🎡 <b>Roulette–VS Bot</b> — <code>/roul AMOUNT INR|USD</code>",
      "💣 <b>Mines</b>",
      "♠️ <b>Blackjack</b> — <code>/bj AMOUNT INR|USD</code>",
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
        ["Limbo", "limbo"],
        ["Roulette", "roulette"],
        ["Mines", "mines"],
        ["Blackjack", "bj"],
      ].map(([label, gameType]) => `${label}: ${limitByGame.get(gameType)}`).join("\n")}`,
    ].join("\n"),
    {
      inline_keyboard: [[
        { text: "Currency", callback_data: ownedCallback("main:currency", ownerTelegramUserId) },
        { text: "Support", callback_data: ownedCallback("main:support", ownerTelegramUserId) },
      ], [
        { text: "❔ How to play", callback_data: ownedCallback("main:how", ownerTelegramUserId) },
        { text: "📜 Terms", callback_data: ownedCallback("main:terms", ownerTelegramUserId) },
      ]],
    },
    SLOT_PREMIUM_EMOJI_OPTIONS,
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
  await Promise.all([ensureHouseWallet("INR"), ensureHouseWallet("USD")]);
  const wallets = await db.select().from(casinoHouseWalletsTable);
  const inrMinor = wallets.find((wallet) => wallet.currency === "INR")?.balanceMinor ?? 0;
  const usdMinor = wallets.find((wallet) => wallet.currency === "USD")?.balanceMinor ?? 0;
  const totalInrMinor =
    inrMinor + convertMinor(usdMinor, "USD", "INR");
  const totalUsdMinor =
    usdMinor + convertMinor(inrMinor, "INR", "USD");
  await bot.sendMessage(
    chatId,
    [
      "<b>🏦 HOUSE BALANCE (HB)</b>",
      "",
      `INR HB: <b>${formatMoney(inrMinor, "INR")}</b>`,
      `USDT HB: <b>${formatMoney(usdMinor, "USD")}</b>`,
      "",
      `Total INR value: <b>${formatMoney(totalInrMinor, "INR")}</b>`,
      `Total USDT value: <b>${formatMoney(totalUsdMinor, "USD")}</b>`,
      "",
      `Rate: 1 USDT = ₹${INR_PER_USD}`,
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
    await sendBonusCard(bot, chatId, {
      title: "DAILY BONUS",
      subtitle: "BOT-SELECTED REWARD",
      status: "NOT CONFIGURED",
      amount: "—",
      currency: "INR",
      winners: "—",
      next: "Ask an administrator to configure the draw",
    });
    return;
  }
  await sendBonusCard(bot, chatId, {
    title: "DAILY BONUS",
    subtitle: "BOT-SELECTED REWARD",
    status: "CONFIGURED",
    amount: formatMoney(settings.amountMinor, parseCurrency(settings.currency, "INR")),
    currency: parseCurrency(settings.currency, "INR"),
    winners: String(settings.eligibleUsers),
    next: settings.nextDistributionAt
      ? settings.nextDistributionAt.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" })
      : "Scheduled in 24 hours",
  });
}

type BonusCardData = {
  title: string;
  subtitle: string;
  status: string;
  amount: string;
  currency: Currency;
  winners: string;
  next: string;
};

function bonusCardSvg(data: BonusCardData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <defs>
    <linearGradient id="bonus-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10182e"/><stop offset="1" stop-color="#203d54"/></linearGradient>
    <linearGradient id="bonus-gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e5ad43"/><stop offset="1" stop-color="#ffe6a1"/></linearGradient>
  </defs>
  <rect width="1200" height="760" rx="42" fill="url(#bonus-bg)"/>
  <circle cx="1080" cy="90" r="220" fill="#f6c453" opacity=".12"/><circle cx="100" cy="720" r="230" fill="#3b82f6" opacity=".10"/>
  <rect x="42" y="42" width="1116" height="676" rx="32" fill="none" stroke="#ffffff" stroke-opacity=".15"/>
  <text x="86" y="112" fill="#f6c453" font-size="28" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="186" fill="#ffffff" font-size="54" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.title)}</text>
  <text x="86" y="228" fill="#9db0cb" font-size="24" font-family="DejaVu Sans" letter-spacing="2">${escapeXml(data.subtitle)}</text>
  <rect x="900" y="88" width="205" height="70" rx="35" fill="#f6c453" fill-opacity=".18" stroke="#f6c453" stroke-opacity=".8" stroke-width="2"/>
  <text x="1002" y="133" text-anchor="middle" fill="#f6c453" font-size="25" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.status)}</text>
  <line x1="86" y1="276" x2="1114" y2="276" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="86" y="332" fill="#8da2bd" font-size="22" font-family="DejaVu Sans" font-weight="bold">REWARD PER WINNER</text>
  <text x="86" y="400" fill="url(#bonus-gold)" font-size="54" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.amount)}</text>
  <text x="650" y="332" fill="#8da2bd" font-size="22" font-family="DejaVu Sans" font-weight="bold">MAXIMUM WINNERS</text>
  <text x="650" y="400" fill="#ffffff" font-size="54" font-family="Deja Vu Sans" font-weight="bold">${escapeXml(data.winners)}</text>
  <rect x="70" y="456" width="1060" height="150" rx="24" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".1"/>
  <text x="104" y="506" fill="#8da2bd" font-size="21" font-family="DejaVu Sans" font-weight="bold">NEXT BOT SELECTION</text>
  <text x="104" y="556" fill="#ffffff" font-size="27" font-family="DejaVu Sans">${escapeXml(svgLabel(data.next, 60))}</text>
  <text x="104" y="646" fill="#b6c7df" font-size="21" font-family="DejaVu Sans">Selection is automatic and rewards are credited to the ${data.currency} wallet.</text>
  <text x="86" y="692" fill="#7185a3" font-size="18" font-family="DejaVu Sans">Complete the displayed wagering rule before requesting a withdrawal.</text>
</svg>`;
}

async function bonusCardPng(data: BonusCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render bonus image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(bonusCardSvg(data)));
  });
}

async function sendBonusCard(
  bot: TelegramBot,
  chatId: number,
  data: BonusCardData,
): Promise<void> {
  await bot.sendPhoto(chatId, await bonusCardPng(data));
}

async function sendMonthlyBonusStatus(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<void> {
  const [settings] = await db
    .select()
    .from(casinoGiveawaySettingsTable)
    .where(eq(casinoGiveawaySettingsTable.kind, "monthly"))
    .limit(1);
  if (!settings || !settings.enabled || settings.amountMinor <= 0) {
    await sendBonusCard(bot, chatId, {
      title: "MONTHLY BONUS",
      subtitle: "BOT-SELECTED REWARD",
      status: "NOT CONFIGURED",
      amount: "—",
      currency: "INR",
      winners: "—",
      next: "Ask an administrator to configure the draw",
    });
    return;
  }
  const currency = parseCurrency(settings.currency, "INR");
  const periodKey = settings.nextDrawAt
    ? new Date(settings.nextDrawAt.getTime() - giveawayPeriodMs(settings)).toISOString()
    : null;
  const claim = periodKey
    ? (await db
        .select()
        .from(casinoGiveawayClaimsTable)
        .where(
          and(
            eq(casinoGiveawayClaimsTable.kind, "monthly"),
            eq(casinoGiveawayClaimsTable.periodKey, periodKey),
            eq(casinoGiveawayClaimsTable.playerId, player.id),
          ),
        )
        .limit(1))[0]
    : undefined;
  const wallet = claim?.selected
    ? await ensureWallet(player.id, currency)
    : undefined;
  await sendBonusCard(bot, chatId, {
    title: "MONTHLY BONUS",
    subtitle: claim?.selected ? "CONGRATULATIONS" : "BOT-SELECTED REWARD",
    status: claim?.selected ? "WINNER" : "ACTIVE",
    amount: claim?.selected
      ? formatMoney(claim.amountMinor, currency)
      : formatMoney(settings.amountMinor, currency),
    currency,
    winners: String(settings.maxWinners || "ALL"),
    next: claim?.selected
      ? `Balance ${formatMoney(wallet?.balanceMinor ?? 0, currency)}`
      : settings.nextDrawAt?.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" }) ?? "Scheduled soon",
  });
}

async function sendBonusWinnerCard(
  bot: TelegramBot,
  chatId: number,
  kind: string,
  amountMinor: number,
  currency: Currency,
  balanceMinor: number,
): Promise<void> {
  await sendBonusCard(bot, chatId, {
    title: `${kind.toUpperCase()} BONUS`,
    subtitle: "BOT-SELECTED WINNER",
    status: "WINNER",
    amount: formatMoney(amountMinor, currency),
    currency,
    winners: "CREDITED",
    next: `Updated balance ${formatMoney(balanceMinor, currency)}`,
  });
}

type BonusKind = "daily" | "weekly";

function bonusTable(kind: BonusKind) {
  return kind === "daily"
    ? casinoDailyBonusSettingsTable
    : casinoWeeklyBonusSettingsTable;
}

function bonusPeriodMs(kind: BonusKind): number {
  return kind === "daily"
    ? 24 * 60 * 60 * 1_000
    : 7 * 24 * 60 * 60 * 1_000;
}

function shufflePlayers<T>(players: T[]): T[] {
  const shuffled = [...players];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

async function distributeScheduledReward(
  bot: TelegramBot,
  kind: BonusKind,
): Promise<void> {
  const now = new Date();
  const periodMs = bonusPeriodMs(kind);
  const since = new Date(now.getTime() - periodMs);
  const table = bonusTable(kind);
  const [settings] = await db.select().from(table).limit(1);
  if (
    !settings ||
    settings.amountMinor <= 0 ||
    settings.eligibleUsers <= 0 ||
    settings.nextDistributionAt == null ||
    settings.nextDistributionAt > now
  ) {
    return;
  }
  const periodKey = settings.nextDistributionAt.toISOString();

  const rounds = await db
    .select({
      playerId: casinoGameRoundsTable.playerId,
      stakeMinor: casinoGameRoundsTable.stakeMinor,
    })
    .from(casinoGameRoundsTable)
    .where(gte(casinoGameRoundsTable.createdAt, since));
  const activeIds = new Set(rounds.map((round) => round.playerId));
  if (activeIds.size === 0) {
    await db
      .update(table)
      .set({ nextDistributionAt: new Date(now.getTime() + periodMs), updatedAt: now })
      .where(eq(table.id, settings.id));
    return;
  }

  const players = await db.select().from(casinoPlayersTable);
  const eligiblePlayers = shufflePlayers(
    players.filter((player) => activeIds.has(player.id)),
  );
  const recipients = eligiblePlayers.slice(0, settings.eligibleUsers);
  const currency = parseCurrency(settings.currency, "INR");
  const winners = new Set(recipients.slice(0, settings.eligibleUsers).map((player) => player.id));
  for (const recipient of eligiblePlayers) {
    const [claim] = await db
      .insert(casinoBonusClaimsTable)
      .values({
        kind,
        periodKey,
        playerId: recipient.id,
        currency,
        amountMinor: settings.amountMinor,
        selected: winners.has(recipient.id),
      })
      .onConflictDoNothing()
      .returning();
    if (claim?.selected) {
      const reward = await adjustBalance({
        adminId: settings.updatedByTelegramUserId ?? 0,
        telegramUserId: recipient.telegramUserId,
        amountMinor: settings.amountMinor,
        currency,
        entryType: "admin_credit",
        description: `${kind} bot-selected bonus`,
      });
      try {
        await sendBonusWinnerCard(
          bot,
          recipient.telegramUserId,
          kind,
          settings.amountMinor,
          currency,
          reward.balanceMinor,
        );
      } catch (error) {
        logger.warn(
          { err: error, playerId: recipient.id, rewardType: kind },
          "Scheduled bonus notification failed",
        );
      }
    }
  }
  await db
    .update(table)
    .set({ nextDistributionAt: new Date(now.getTime() + periodMs), updatedAt: now })
    .where(eq(table.id, settings.id));
}

async function sendBonusClaimStatus(
  bot: TelegramBot,
  chatId: number,
  player: typeof casinoPlayersTable.$inferSelect,
  kind: BonusKind,
): Promise<void> {
  await distributeScheduledReward(bot, kind);
  const table = bonusTable(kind);
  const [settings] = await db.select().from(table).limit(1);
  const label = kind === "daily" ? "daily" : "weekly";
  if (!settings || settings.amountMinor <= 0 || settings.eligibleUsers <= 0) {
    await sendBonusCard(bot, chatId, {
      title: `${label.toUpperCase()} BONUS`,
      subtitle: "BOT-SELECTED REWARD",
      status: "NOT CONFIGURED",
      amount: "—",
      currency: "INR",
      winners: "—",
      next: "Ask an administrator to configure the draw",
    });
    return;
  }
  const currency = parseCurrency(settings.currency, "INR");
  const periodMs = bonusPeriodMs(kind);
  const next = settings.nextDistributionAt;
  const lastPeriodKey = next
    ? new Date(next.getTime() - periodMs).toISOString()
    : null;
  const claim = lastPeriodKey
    ? (await db
        .select()
        .from(casinoBonusClaimsTable)
        .where(
          and(
            eq(casinoBonusClaimsTable.kind, kind),
            eq(casinoBonusClaimsTable.periodKey, lastPeriodKey),
            eq(casinoBonusClaimsTable.playerId, player.id),
          ),
        )
        .limit(1))[0]
    : undefined;
  if (claim?.selected) {
    const wallet = await ensureWallet(player.id, currency);
    await sendBonusWinnerCard(
      bot,
      chatId,
      label,
      claim.amountMinor,
      currency,
      wallet.balanceMinor,
    );
    return;
  }
  if (claim && !claim.selected) {
    await sendBonusCard(bot, chatId, {
      title: `${label.toUpperCase()} BONUS`,
      subtitle: "BOT-SELECTED REWARD",
      status: "NOT SELECTED",
      amount: formatMoney(settings.amountMinor, currency),
      currency,
      winners: String(settings.eligibleUsers),
      next: next?.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" }) ?? "Scheduled soon",
    });
    return;
  }
  await sendBonusCard(bot, chatId, {
    title: `${label.toUpperCase()} BONUS`,
    subtitle: "BOT-SELECTED REWARD",
    status: "ACTIVE",
    amount: formatMoney(settings.amountMinor, currency),
    currency,
    winners: String(settings.eligibleUsers),
    next: next?.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" }) ?? "Scheduled soon",
  });
}

async function distributeDueRewards(bot: TelegramBot): Promise<void> {
  try {
    await distributeDueDailyLossRewards();
  } catch (error) {
    logger.error({ err: error }, "Daily loss rebate distribution failed");
  }
  for (const kind of ["daily", "weekly"] as const) {
    try {
      await distributeScheduledReward(bot, kind);
    } catch (error) {
      logger.error({ err: error, rewardType: kind }, "Scheduled reward distribution failed");
    }
  }
  try {
    await distributeConfiguredGiveaways(bot);
  } catch (error) {
    logger.error({ err: error }, "Configured giveaway distribution failed");
  }
}

type GiveawayKind = "monthly" | "multi_day" | "referral" | "giveaway" | "rakeback";

type GiveawaySetting = typeof casinoGiveawaySettingsTable.$inferSelect;
type HouseRoyale = typeof casinoHouseRoyalesTable.$inferSelect;
type HouseRoyalePlayer = typeof casinoHouseRoyalePlayersTable.$inferSelect;

function officialGroupChatId(): number | null {
  const value = Number(process.env.CASINO_MAIN_GROUP_CHAT_ID ?? "");
  return Number.isSafeInteger(value) && value < 0 ? value : null;
}

type GiveawayDraftStep =
  | "amount"
  | "winners"
  | "referrals"
  | "wager"
  | "duration";

type GiveawayDraft = {
  step: GiveawayDraftStep;
  amountMinor?: number;
  currency?: Currency;
  maxWinners?: number;
  minReferralCount?: number;
  minWagerMinor?: number;
  periodDays?: number;
};

const giveawayDrafts = new Map<number, GiveawayDraft>();

type GiveawayEditStep = "name" | "pool" | "first" | "second" | "third";

type GiveawayEditDraft = {
  settingId: number;
  kind: string;
  currency: Currency;
  step: GiveawayEditStep;
  displayName?: string | null;
  amountMinor?: number;
  firstPrizeMinor?: number | null;
  secondPrizeMinor?: number | null;
  thirdPrizeMinor?: number | null;
};

const giveawayEditDrafts = new Map<number, GiveawayEditDraft>();

function isUserGiveawaySetting(settings: GiveawaySetting): boolean {
  return settings.kind === "giveaway" || /^giveaway_\d+$/.test(settings.kind);
}

async function activeGiveawaySettings(): Promise<GiveawaySetting[]> {
  const settings = await db
    .select()
    .from(casinoGiveawaySettingsTable)
    .where(eq(casinoGiveawaySettingsTable.enabled, true));
  return settings
    .filter(isUserGiveawaySetting)
    .sort((left, right) => left.id - right.id);
}

function giveawayLabel(settings: GiveawaySetting, index: number): string {
  return settings.displayName?.trim() || `GIVEAWAY ${index + 1}`;
}

function giveawayRankPrize(
  settings: GiveawaySetting,
  rank: number,
): number {
  if (rank === 0 && settings.firstPrizeMinor != null) return settings.firstPrizeMinor;
  if (rank === 1 && settings.secondPrizeMinor != null) return settings.secondPrizeMinor;
  if (rank === 2 && settings.thirdPrizeMinor != null) return settings.thirdPrizeMinor;
  return settings.amountMinor;
}

function giveawayPrizeSummary(
  settings: GiveawaySetting,
): string {
  const currency = parseCurrency(settings.currency, "INR");
  const prizes = [
    settings.firstPrizeMinor != null ? `1st ${formatMoney(settings.firstPrizeMinor, currency)}` : null,
    settings.secondPrizeMinor != null ? `2nd ${formatMoney(settings.secondPrizeMinor, currency)}` : null,
    settings.thirdPrizeMinor != null ? `3rd ${formatMoney(settings.thirdPrizeMinor, currency)}` : null,
  ].filter(Boolean);
  return prizes.length > 0
    ? prizes.join(" · ")
    : `Default reward ${formatMoney(settings.amountMinor, currency)}`;
}

function giveawayEditValueText(
  value: number | null | undefined,
  currency: Currency,
): string {
  return value == null ? "clear" : formatMoney(value, currency);
}

async function giveawayPlayerMetrics(
  playerId: number,
  settings: Pick<GiveawaySetting, "nextDrawAt" | "periodDays" | "currency">,
): Promise<{ wagerMinor: number; referrals: number; bets: number }> {
  const since = settings.nextDrawAt
    ? new Date(settings.nextDrawAt.getTime() - giveawayPeriodMs(settings))
    : new Date(0);
  const [rounds, battles, referrals] = await Promise.all([
    db
      .select()
      .from(casinoGameRoundsTable)
      .where(
        and(
          eq(casinoGameRoundsTable.playerId, playerId),
          eq(casinoGameRoundsTable.currency, parseCurrency(settings.currency, "INR")),
          gte(casinoGameRoundsTable.createdAt, since),
        ),
      ),
    db
      .select()
      .from(casinoChallengesTable)
      .where(
        and(
          eq(casinoChallengesTable.status, "completed"),
          eq(casinoChallengesTable.currency, parseCurrency(settings.currency, "INR")),
          gte(casinoChallengesTable.createdAt, since),
          or(
            eq(casinoChallengesTable.creatorPlayerId, playerId),
            eq(casinoChallengesTable.playerTwoId, playerId),
          ),
        ),
      ),
    db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.referredByPlayerId, playerId)),
  ]);
  return {
    wagerMinor:
      rounds.reduce((total, round) => total + round.stakeMinor, 0) +
      battles.reduce((total, battle) => total + battle.stakeMinor, 0),
    referrals: referrals.length,
    bets: rounds.length + battles.length,
  };
}

async function houseRoyaleWagerMinor(
  playerId: number,
  currency: Currency,
  periodDays: number,
): Promise<number> {
  const since = new Date(Date.now() - Math.max(1, periodDays) * 24 * 60 * 60 * 1_000);
  const [rounds, battles] = await Promise.all([
    db
      .select()
      .from(casinoGameRoundsTable)
      .where(
        and(
          eq(casinoGameRoundsTable.playerId, playerId),
          eq(casinoGameRoundsTable.currency, currency),
          gte(casinoGameRoundsTable.createdAt, since),
        ),
      ),
    db
      .select()
      .from(casinoChallengesTable)
      .where(
        and(
          eq(casinoChallengesTable.status, "completed"),
          eq(casinoChallengesTable.currency, currency),
          gte(casinoChallengesTable.createdAt, since),
          or(
            eq(casinoChallengesTable.creatorPlayerId, playerId),
            eq(casinoChallengesTable.playerTwoId, playerId),
          ),
        ),
      ),
  ]);
  return (
    rounds.reduce((total, round) => total + round.stakeMinor, 0) +
    battles.reduce((total, battle) => total + battle.stakeMinor, 0)
  );
}

function houseRoyalePayouts(prizePoolMinor: number): {
  winnerOneMinor: number;
  winnerTwoMinor: number;
} {
  return {
    winnerOneMinor: Math.floor(prizePoolMinor * 60 / 100),
    winnerTwoMinor: prizePoolMinor - Math.floor(prizePoolMinor * 60 / 100),
  };
}

type HouseRoyaleBracket = {
  rounds: Array<{
    label: string;
    matches: Array<{
      playerOneId: number;
      playerTwoId: number;
      playerOneRoll: number;
      playerTwoRoll: number;
      winnerId: number;
      loserId: number;
    }>;
  }>;
  firstPlaceId: number;
  secondPlaceId: number;
};

async function hasValidHouseRoyaleReferral(playerId: number): Promise<boolean> {
  const [referral] = await db
    .select({ id: casinoPlayersTable.id })
    .from(casinoPlayersTable)
    .where(
      and(
        eq(casinoPlayersTable.referredByPlayerId, playerId),
        eq(casinoPlayersTable.isBot, false),
      ),
    )
    .limit(1);
  return Boolean(referral);
}

function houseRoyaleDeadlineText(royale: HouseRoyale): string {
  return royale.joinDeadlineAt
    ? royale.joinDeadlineAt.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "when 8 players join";
}

async function activeHouseRoyale(): Promise<HouseRoyale | null> {
  const [royale] = await db
    .select()
    .from(casinoHouseRoyalesTable)
    .where(eq(casinoHouseRoyalesTable.status, "open"))
    .orderBy(desc(casinoHouseRoyalesTable.id))
    .limit(1);
  return royale ?? null;
}

async function houseRoyalePlayers(royaleId: number): Promise<HouseRoyalePlayer[]> {
  return db
    .select()
    .from(casinoHouseRoyalePlayersTable)
    .where(eq(casinoHouseRoyalePlayersTable.royaleId, royaleId))
    .orderBy(desc(casinoHouseRoyalePlayersTable.joinedAt));
}

function houseRoyaleAnnouncementSvg(data: {
  id: number;
  prizePool: string;
  winnerPrize: string;
  runnerPrize: string;
  registered: number;
  eligible: number;
  minWager: string;
  deadline: string;
}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="820" viewBox="0 0 1200 820">
  <defs>
    <linearGradient id="hr-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10162d"/><stop offset=".55" stop-color="#202b57"/><stop offset="1" stop-color="#3b2457"/></linearGradient>
    <linearGradient id="hr-gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f1b83d"/><stop offset="1" stop-color="#ffe9a6"/></linearGradient>
  </defs>
  <rect width="1200" height="820" rx="42" fill="url(#hr-bg)"/>
  <circle cx="1060" cy="90" r="230" fill="#8ea6ff" opacity=".14"/><circle cx="90" cy="780" r="250" fill="#f1b83d" opacity=".08"/>
  <rect x="34" y="34" width="1132" height="752" rx="32" fill="none" stroke="#879cff" stroke-opacity=".55" stroke-width="2"/>
  <text x="82" y="96" fill="#8ea6ff" font-size="26" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="82" y="158" fill="#ffffff" font-size="48" font-family="DejaVu Sans" font-weight="bold">👑 HOUSE ROYALE #${data.id}</text>
  <text x="82" y="195" fill="#bfc9ec" font-size="21" font-family="DejaVu Sans">FREE 8-PLAYER DICE TOURNAMENT · HOUSE-FUNDED PRIZE POOL</text>
  <rect x="82" y="232" width="1036" height="126" rx="25" fill="#ffffff" fill-opacity=".07" stroke="#f1b83d" stroke-opacity=".55"/>
  <text x="120" y="274" fill="#aab8e5" font-size="17" font-family="DejaVu Sans" font-weight="bold">PRIZE POOL</text>
  <text x="120" y="325" fill="url(#hr-gold)" font-size="43" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.prizePool)}</text>
  <text x="540" y="274" fill="#aab8e5" font-size="17" font-family="DejaVu Sans" font-weight="bold">1ST PLACE · 60%</text>
  <text x="540" y="325" fill="#ffffff" font-size="34" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.winnerPrize)}</text>
  <text x="860" y="274" fill="#aab8e5" font-size="17" font-family="DejaVu Sans" font-weight="bold">2ND PLACE · 40%</text>
  <text x="860" y="325" fill="#ffffff" font-size="34" font-family="DejaVu Sans" font-weight="bold">${escapeXml(data.runnerPrize)}</text>
  <rect x="82" y="390" width="500" height="150" rx="24" fill="#ffffff" fill-opacity=".06" stroke="#879cff" stroke-opacity=".55"/>
  <text x="116" y="430" fill="#9eafe3" font-size="17" font-family="DejaVu Sans" font-weight="bold">REGISTRATION</text>
  <text x="116" y="480" fill="#ffffff" font-size="31" font-family="DejaVu Sans" font-weight="bold">${data.registered}/8 REQUESTS · ${data.eligible}/8 ELIGIBLE</text>
  <text x="116" y="515" fill="#f1b83d" font-size="18" font-family="DejaVu Sans">Registration closes ${escapeXml(data.deadline)}</text>
  <rect x="618" y="390" width="500" height="150" rx="24" fill="#ffffff" fill-opacity=".06" stroke="#879cff" stroke-opacity=".55"/>
  <text x="652" y="430" fill="#9eafe3" font-size="17" font-family="DejaVu Sans" font-weight="bold">JOIN REQUIREMENTS</text>
  <text x="652" y="478" fill="#ffffff" font-size="22" font-family="DejaVu Sans">1 valid human referral</text>
  <text x="652" y="512" fill="#ffffff" font-size="22" font-family="DejaVu Sans">30-day INR wager ≥ ${escapeXml(data.minWager)}</text>
  <text x="82" y="590" fill="#8ea6ff" font-size="19" font-family="DejaVu Sans" font-weight="bold">TOURNAMENT FORMAT</text>
  <text x="82" y="625" fill="#dce3ff" font-size="22" font-family="DejaVu Sans">4 quarterfinals → 2 semifinals → 1 final · dice results are sent live in the group</text>
  <rect x="82" y="675" width="1036" height="68" rx="20" fill="#70e59a" fill-opacity=".18" stroke="#70e59a" stroke-opacity=".7"/>
  <text x="600" y="718" text-anchor="middle" fill="#9affba" font-size="25" font-family="DejaVu Sans" font-weight="bold">PRESS JOIN HOUSE ROYALE · CHECK YOUR DM FOR LIVE ELIGIBILITY</text>
</svg>`;
}

async function houseRoyaleAnnouncementPng(data: {
  id: number;
  prizePool: string;
  winnerPrize: string;
  runnerPrize: string;
  registered: number;
  eligible: number;
  minWager: string;
  deadline: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render House Royale image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(houseRoyaleAnnouncementSvg(data)));
  });
}

function houseRoyaleInfoSvg(data: {
  royale: HouseRoyale;
  players: Array<{
    name: string;
    eligible: boolean;
    winChance: number;
  }>;
}): string {
  const rows = data.players.length > 0
    ? data.players.slice(0, 8).map((player, index) => {
        const y = 260 + index * 68;
        const status = player.eligible ? "ELIGIBLE" : "PENDING";
        const statusColor = player.eligible ? "#76e3a3" : "#f6c453";
        return [
          `<rect x="70" y="${y - 38}" width="1260" height="52" rx="14" fill="#ffffff" fill-opacity="${index % 2 === 0 ? ".09" : ".045"}" stroke="#ffffff" stroke-opacity=".08"/>`,
          `<text x="102" y="${y}" fill="#f6c453" font-size="24" font-family="DejaVu Sans" font-weight="bold">${index + 1}</text>`,
          `<text x="170" y="${y}" fill="#ffffff" font-size="23" font-family="DejaVu Sans" font-weight="bold">${escapeXml(svgLabel(player.name, 28))}</text>`,
          `<text x="820" y="${y}" fill="#dbe7f5" font-size="21" font-family="DejaVu Sans">Win chance type ${player.winChance}/5</text>`,
          `<text x="1120" y="${y}" fill="${statusColor}" font-size="20" font-family="DejaVu Sans" font-weight="bold">${status}</text>`,
        ].join("");
      }).join("")
    : `<text x="700" y="410" text-anchor="middle" fill="#b6c7df" font-size="30" font-family="DejaVu Sans">No players have joined yet</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
  <defs><linearGradient id="hr-info-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10162d"/><stop offset=".55" stop-color="#202b57"/><stop offset="1" stop-color="#3b2457"/></linearGradient></defs>
  <rect width="1400" height="900" rx="42" fill="url(#hr-info-bg)"/>
  <circle cx="1280" cy="90" r="230" fill="#8ea6ff" opacity=".14"/><circle cx="90" cy="850" r="250" fill="#f1b83d" opacity=".08"/>
  <rect x="42" y="42" width="1316" height="816" rx="32" fill="none" stroke="#f1b83d" stroke-opacity=".55" stroke-width="2"/>
  <text x="86" y="110" fill="#f1b83d" font-size="29" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="172" fill="#ffffff" font-size="44" font-family="DejaVu Sans" font-weight="bold">HOUSE ROYALE #${data.royale.id} · JOINED PLAYERS</text>
  <text x="86" y="210" fill="#bfc9ec" font-size="21" font-family="DejaVu Sans">Status: ${escapeXml(data.royale.status.toUpperCase())} · Registered ${data.players.length}/${data.royale.maxPlayers} · Admin win-chance tier: 1–5</text>
  <text x="102" y="246" fill="#8da2bd" font-size="17" font-family="DejaVu Sans" font-weight="bold">#</text>
  <text x="170" y="246" fill="#8da2bd" font-size="17" font-family="DejaVu Sans" font-weight="bold">PLAYER</text>
  <text x="820" y="246" fill="#8da2bd" font-size="17" font-family="DejaVu Sans" font-weight="bold">CHANCE TYPE</text>
  <text x="1120" y="246" fill="#8da2bd" font-size="17" font-family="DejaVu Sans" font-weight="bold">ELIGIBILITY</text>
  ${rows}
  <text x="86" y="830" fill="#7185a3" font-size="18" font-family="DejaVu Sans">Only administrators can change chance tiers. Dice results remain visible in the official group.</text>
</svg>`;
}

async function houseRoyaleInfoPng(data: {
  royale: HouseRoyale;
  players: Array<{ name: string; eligible: boolean; winChance: number }>;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render House Royale info image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(houseRoyaleInfoSvg(data)));
  });
}

async function houseRoyaleInfo(
  bot: TelegramBot,
  chatId: number,
  viewerTelegramUserId: number,
): Promise<void> {
  const [royale] = await db
    .select()
    .from(casinoHouseRoyalesTable)
    .orderBy(desc(casinoHouseRoyalesTable.id))
    .limit(1);
  if (!royale) {
    await bot.sendMessage(chatId, "<b>👑 HOUSE ROYALE INFO</b>\n\nNo House Royale has been organized yet.");
    return;
  }
  const rows = await houseRoyalePlayers(royale.id);
  const players = await db.select().from(casinoPlayersTable);
  const playerById = new Map(players.map((player) => [player.id, player]));
  const infoPlayers = rows.map((row) => {
    const player = playerById.get(row.playerId);
    return {
      name: player?.username ? `@${player.username}` : player?.displayName ?? `Player ${row.playerId}`,
      eligible: Boolean(row.eligibilityConfirmedAt),
      winChance: Math.min(5, Math.max(1, row.winChance)),
    };
  });
  const image = await houseRoyaleInfoPng({ royale, players: infoPlayers });
  const keyboard: InlineKeyboardButton[][] = [];
  if (isAdmin(viewerTelegramUserId) && isPrivateChat({ id: chatId, type: "private" })) {
    for (const row of rows) {
      const player = playerById.get(row.playerId);
      const label = player?.username ? `@${player.username}` : player?.displayName ?? `Player ${row.playerId}`;
      keyboard.push([
        { text: `${svgLabel(label, 18)} · chance ${row.winChance}/5`, callback_data: `house:chance:${royale.id}:${row.playerId}:show` },
      ]);
      keyboard.push([1, 2, 3, 4, 5].map((chance) => ({
        text: chance === row.winChance ? `✅ ${chance}` : String(chance),
        callback_data: `house:chance:${royale.id}:${row.playerId}:${chance}`,
      })));
    }
    keyboard.push([{ text: "↻ Refresh /hrinfo", callback_data: `house:info:${royale.id}` }]);
  }
  await bot.sendPhoto(
    chatId,
    image,
    `<b>👑 HOUSE ROYALE #${royale.id}</b>\nJoined players are listed below. ${isAdmin(viewerTelegramUserId) ? "Choose a 1–5 chance tier for each player." : ""}`,
    keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
  );
}

async function setHouseRoyaleWinChance(
  bot: TelegramBot,
  callback: TelegramCallbackQuery,
  royaleId: number,
  playerId: number,
  chance: number,
): Promise<void> {
  if (!isAdmin(callback.from.id) || !callback.message || !isPrivateChat(callback.message.chat)) {
    await bot.sendMessage(callback.message?.chat.id ?? callback.from.id, ADMIN_RESTRICTED_MESSAGE);
    return;
  }
  if (!Number.isInteger(chance) || chance < 1 || chance > 5) return;
  const [updated] = await db
    .update(casinoHouseRoyalePlayersTable)
    .set({ winChance: chance })
    .where(and(
      eq(casinoHouseRoyalePlayersTable.royaleId, royaleId),
      eq(casinoHouseRoyalePlayersTable.playerId, playerId),
    ))
    .returning({ id: casinoHouseRoyalePlayersTable.id });
  if (!updated) {
    await bot.sendMessage(callback.message.chat.id, "That House Royale player is no longer registered.");
    return;
  }
  await bot.sendMessage(callback.message.chat.id, `✅ Player chance type updated to ${chance}/5.`);
  await houseRoyaleInfo(bot, callback.message.chat.id, callback.from.id);
}

async function sendHouseRoyale(
  bot: TelegramBot,
  chatId: number,
  royale: HouseRoyale | null,
  viewerTelegramUserId?: number,
): Promise<void> {
  if (!royale) {
    await bot.sendMessage(
      chatId,
      "<b>👑 HOUSE ROYALE</b>\n\nNo House Royale is open right now.",
    );
    return;
  }
  const players = await houseRoyalePlayers(royale.id);
  const eligiblePlayers = players.filter((player) => Boolean(player.eligibilityConfirmedAt));
  const currency = parseCurrency(royale.currency, "INR");
  const payouts = houseRoyalePayouts(royale.prizePoolMinor);
  const admin = viewerTelegramUserId !== undefined && isAdmin(viewerTelegramUserId);
  const keyboard: InlineKeyboardButton[][] = players.length < royale.maxPlayers
    ? [[{
        text: "👑 Join House Royale",
        callback_data: `house:join:${royale.id}`,
      }]]
    : [[{
        text: eligiblePlayers.length >= royale.maxPlayers
          ? "✅ 8/8 Players Eligible"
          : `⏳ ${eligiblePlayers.length}/${royale.maxPlayers} Eligible`,
        callback_data: `house:draw:${royale.id}`,
      }]];
  if (admin && isPrivateChat({ id: chatId, type: "private" })) {
    keyboard.push([
      { text: "🎲 Start 3-game bracket", callback_data: `house:draw:${royale.id}` },
      { text: "❌ Cancel", callback_data: `house:cancel:${royale.id}` },
    ]);
  }
  const image = await houseRoyaleAnnouncementPng({
    id: royale.id,
    prizePool: formatMoney(royale.prizePoolMinor, currency),
    winnerPrize: formatMoney(payouts.winnerOneMinor, currency),
    runnerPrize: formatMoney(payouts.winnerTwoMinor, currency),
    registered: players.length,
    eligible: eligiblePlayers.length,
    minWager: formatMoney(royale.minWagerMinor, "INR"),
    deadline: houseRoyaleDeadlineText(royale),
  });
  const caption = [
    `<b>👑 HOUSE ROYALE #${royale.id}</b>`,
    `<b>Players:</b> ${players.length}/${royale.maxPlayers} registered · ${eligiblePlayers.length}/${royale.maxPlayers} eligible`,
    `<b>Prize pool:</b> ${formatMoney(royale.prizePoolMinor, currency)} (house funded)`,
    "",
    "<b>Join requirements:</b>",
    "• At least 1 valid human referral",
    `• Minimum ${formatMoney(royale.minWagerMinor, "INR")} INR wager in the last 30 days`,
    `• Registration closes ${houseRoyaleDeadlineText(royale)}`,
    "",
    "Tap Join House Royale. The bot will message you privately and update your eligibility live.",
  ].join("\n");
  const groupId = officialGroupChatId();
  const isAnnouncement = groupId !== null && chatId === groupId;
  let sent: TelegramMessage;
  if (isAnnouncement && royale.announcementMessageId) {
    sent = await bot.editPhoto(chatId, royale.announcementMessageId, image, caption, {
      inline_keyboard: keyboard,
    });
  } else {
    sent = await bot.sendPhoto(chatId, image, caption, { inline_keyboard: keyboard });
  }
  if (isAnnouncement) {
    await db
      .update(casinoHouseRoyalesTable)
      .set({ announcementMessageId: sent.message_id })
      .where(eq(casinoHouseRoyalesTable.id, royale.id));
    try {
      await bot.pinChatMessage(chatId, sent.message_id);
    } catch (error) {
      logger.warn({ err: error, royaleId: royale.id }, "House Royale announcement pin failed");
    }
  }
}

async function joinHouseRoyaleLegacy(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  royaleId: number,
): Promise<void> {
  const [royale] = await db
    .select()
    .from(casinoHouseRoyalesTable)
    .where(eq(casinoHouseRoyalesTable.id, royaleId))
    .limit(1);
  if (!royale || royale.status !== "open") {
    await bot.sendMessage(chatId, "That House Royale is no longer open.");
    return;
  }
  const player = await ensurePlayer(user);
  if (player.isBot) {
    await bot.sendMessage(chatId, "Only human players can join House Royale.");
    return;
  }
  if (royale.joinDeadlineAt && royale.joinDeadlineAt.getTime() < Date.now()) {
    await bot.sendMessage(chatId, "<b>❌ House Royale registration is closed.</b>");
    return;
  }
  const validReferral = await hasValidHouseRoyaleReferral(player.id);
  const currency = parseCurrency(royale.currency, "INR");
  const wagerMinor = await houseRoyaleWagerMinor(
    player.id,
    "INR",
    30,
  );
  if (!validReferral || wagerMinor < royale.minWagerMinor) {
    await bot.sendMessage(
      chatId,
      [
        "<b>❌ You are not eligible for this House Royale.</b>",
        "",
        `Valid referral: <b>${validReferral ? "✅" : "❌"}</b> (1 required)`,
        `Your 30-day INR wager: <b>${formatMoney(wagerMinor, "INR")}</b>`,
        `Required wager: <b>${formatMoney(royale.minWagerMinor, "INR")}</b>`,
      ].join("\n"),
    );
    return;
  }
  let result: "joined" | "already" | "full";
  try {
    result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM casino_house_royales WHERE id = ${royale.id} FOR UPDATE`);
      const [lockedRoyale] = await tx
        .select()
        .from(casinoHouseRoyalesTable)
        .where(eq(casinoHouseRoyalesTable.id, royale.id))
        .limit(1);
      if (!lockedRoyale || lockedRoyale.status !== "open") return "full";
      const [existing] = await tx
        .select({ id: casinoHouseRoyalePlayersTable.id })
        .from(casinoHouseRoyalePlayersTable)
        .where(
          and(
            eq(casinoHouseRoyalePlayersTable.royaleId, royale.id),
            eq(casinoHouseRoyalePlayersTable.playerId, player.id),
          ),
        )
        .limit(1);
      if (existing) return "already";
      const currentPlayers = await tx
        .select({ id: casinoHouseRoyalePlayersTable.id })
        .from(casinoHouseRoyalePlayersTable)
        .where(eq(casinoHouseRoyalePlayersTable.royaleId, royale.id));
      if (currentPlayers.length >= lockedRoyale.maxPlayers) return "full";
      const [entry] = await tx
        .insert(casinoHouseRoyalePlayersTable)
        .values({
          royaleId: lockedRoyale.id,
          playerId: player.id,
          entryAmountMinor: lockedRoyale.entryAmountMinor,
        })
        .onConflictDoNothing()
        .returning();
      if (!entry) throw new Error("HOUSE_ROYALE_ALREADY_JOINED");
      return "joined";
    });
  } catch (error) {
    if (error instanceof Error && error.message === "HOUSE_ROYALE_ALREADY_JOINED") {
      result = "already";
    } else {
      logger.error({ err: error, royaleId, playerId: player.id }, "House Royale join failed");
      await bot.sendMessage(chatId, "House Royale could not process your entry. Please try again.");
      return;
    }
  }
  if (result === "already") {
    await bot.sendMessage(chatId, "ℹ️ You are already registered for this House Royale.");
    return;
  }
  if (result === "full") {
    await bot.sendMessage(chatId, "This House Royale is already full.");
    return;
  }
  const players = await houseRoyalePlayers(royale.id);
  await bot.sendMessage(
    chatId,
    `<b>✅ House Royale registration confirmed</b>\nPlayers: <b>${players.length}/8</b>\nNo entry fee — prize pool is funded by the house.`,
  );
  if (players.length >= royale.maxPlayers) {
    await drawHouseRoyale(bot, royale.id);
  }
}

async function houseRoyaleEligibility(
  playerId: number,
  royale: HouseRoyale,
): Promise<{ validReferral: boolean; wagerMinor: number; eligible: boolean }> {
  const [validReferral, wagerMinor] = await Promise.all([
    hasValidHouseRoyaleReferral(playerId),
    houseRoyaleWagerMinor(playerId, "INR", royale.wagerPeriodDays || 30),
  ]);
  return {
    validReferral,
    wagerMinor,
    eligible: validReferral && wagerMinor >= royale.minWagerMinor,
  };
}

function houseRoyaleRequirementText(
  royale: HouseRoyale,
  playerName: string,
  eligibility: { validReferral: boolean; wagerMinor: number; eligible: boolean },
  confirmed: boolean,
): string {
  return [
    `<b>👑 HOUSE ROYALE #${royale.id} PARTICIPATION</b>`,
    "",
    `Player: <b>${escapeTelegramText(playerName)}</b>`,
    `Prize pool: <b>${formatMoney(royale.prizePoolMinor, parseCurrency(royale.currency, "INR"))}</b>`,
    "",
    "<b>Your live requirements:</b>",
    `Referral: <b>${eligibility.validReferral ? "✅ 1 valid human referral" : "❌ Need 1 valid human referral"}</b>`,
    `30-day INR wager: <b>${formatMoney(eligibility.wagerMinor, "INR")}</b> / ${formatMoney(royale.minWagerMinor, "INR")}`,
    "",
    confirmed
      ? "<b>✅ You have successfully participated!</b>\nCheck /giveawayrank for your rank."
      : "Keep playing and referring. This message updates automatically when your requirements change.",
  ].join("\n");
}

async function updateHouseRoyalePlayerStatus(
  bot: TelegramBot,
  royale: HouseRoyale,
  row: HouseRoyalePlayer,
  player: typeof casinoPlayersTable.$inferSelect,
): Promise<{ row: HouseRoyalePlayer; eligible: boolean }> {
  const eligibility = await houseRoyaleEligibility(player.id, royale);
  let currentRow = row;
  const newlyConfirmed = eligibility.eligible && !row.eligibilityConfirmedAt;
  if (newlyConfirmed) {
    const [updated] = await db
      .update(casinoHouseRoyalePlayersTable)
      .set({ eligibilityConfirmedAt: new Date() })
      .where(eq(casinoHouseRoyalePlayersTable.id, row.id))
      .returning();
    if (updated) currentRow = updated;
  }
  if (!currentRow.dmChatId) return { row: currentRow, eligible: eligibility.eligible };
  const text = houseRoyaleRequirementText(
    royale,
    player.username ? `@${player.username}` : player.displayName,
    eligibility,
    Boolean(currentRow.eligibilityConfirmedAt),
  );
  if (currentRow.dmMessageId) {
    try {
      await bot.editMessageText(currentRow.dmChatId, currentRow.dmMessageId, text);
    } catch (error) {
      logger.debug({ err: error, royaleId: royale.id, playerId: player.id }, "House Royale DM update failed");
    }
  } else {
    const sent = await bot.sendMessage(currentRow.dmChatId, text);
    const [updated] = await db
      .update(casinoHouseRoyalePlayersTable)
      .set({ dmMessageId: sent.message_id })
      .where(eq(casinoHouseRoyalePlayersTable.id, currentRow.id))
      .returning();
    if (updated) currentRow = updated;
  }
  if (newlyConfirmed) {
    await bot.sendMessage(
      player.telegramUserId,
      "<b>✅ You have successfully participated in House Royale!</b>\nCheck /giveawayrank for your rank.",
    );
  }
  return { row: currentRow, eligible: eligibility.eligible };
}

async function joinHouseRoyale(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  royaleId: number,
): Promise<void> {
  const [royale] = await db
    .select()
    .from(casinoHouseRoyalesTable)
    .where(eq(casinoHouseRoyalesTable.id, royaleId))
    .limit(1);
  if (!royale || royale.status !== "open") {
    await bot.sendMessage(chatId, "That House Royale is no longer open.");
    return;
  }
  const player = await ensurePlayer(user);
  if (player.isBot) {
    await bot.sendMessage(chatId, "Only human players can join House Royale.");
    return;
  }
  if (royale.joinDeadlineAt && royale.joinDeadlineAt.getTime() < Date.now()) {
    await bot.sendMessage(chatId, "<b>❌ House Royale registration is closed.</b>");
    return;
  }
  let result: "joined" | "already" | "full";
  try {
    result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM casino_house_royales WHERE id = ${royale.id} FOR UPDATE`);
      const [lockedRoyale] = await tx
        .select()
        .from(casinoHouseRoyalesTable)
        .where(eq(casinoHouseRoyalesTable.id, royale.id))
        .limit(1);
      if (!lockedRoyale || lockedRoyale.status !== "open") return "full";
      const [existing] = await tx
        .select()
        .from(casinoHouseRoyalePlayersTable)
        .where(
          and(
            eq(casinoHouseRoyalePlayersTable.royaleId, royale.id),
            eq(casinoHouseRoyalePlayersTable.playerId, player.id),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(casinoHouseRoyalePlayersTable)
          .set({ dmChatId: user.id })
          .where(eq(casinoHouseRoyalePlayersTable.id, existing.id));
        return "already";
      }
      const currentPlayers = await tx
        .select({ id: casinoHouseRoyalePlayersTable.id })
        .from(casinoHouseRoyalePlayersTable)
        .where(eq(casinoHouseRoyalePlayersTable.royaleId, royale.id));
      if (currentPlayers.length >= lockedRoyale.maxPlayers) return "full";
      await tx.insert(casinoHouseRoyalePlayersTable).values({
        royaleId: lockedRoyale.id,
        playerId: player.id,
        entryAmountMinor: lockedRoyale.entryAmountMinor,
        dmChatId: user.id,
      });
      return "joined";
    });
  } catch (error) {
    logger.error({ err: error, royaleId, playerId: player.id }, "House Royale join failed");
    await bot.sendMessage(chatId, "House Royale could not process your participation request. Please try again.");
    return;
  }
  if (result === "full") {
    await bot.sendMessage(chatId, "This House Royale is already full.");
    return;
  }
  const [row] = await db
    .select()
    .from(casinoHouseRoyalePlayersTable)
    .where(
      and(
        eq(casinoHouseRoyalePlayersTable.royaleId, royale.id),
        eq(casinoHouseRoyalePlayersTable.playerId, player.id),
      ),
    )
    .limit(1);
  if (!row) return;
  await updateHouseRoyalePlayerStatus(bot, royale, row, player);
  if (isGroupChat({ id: chatId, type: "supergroup" })) {
    const notice = await bot.sendMessage(
      chatId,
      "<b>✅ Participation request received.</b>\nCheck your DM for House Royale requirements and live eligibility updates.",
    );
    setTimeout(() => {
      void bot.deleteMessage(chatId, notice.message_id).catch(() => undefined);
    }, 30 * 60 * 1_000);
  }
  const currentPlayers = await houseRoyalePlayers(royale.id);
  const groupId = officialGroupChatId();
  if (groupId !== null) {
    const [freshRoyale] = await db
      .select()
      .from(casinoHouseRoyalesTable)
      .where(eq(casinoHouseRoyalesTable.id, royale.id))
      .limit(1);
    if (freshRoyale) await sendHouseRoyale(bot, groupId, freshRoyale);
  }
  if (currentPlayers.filter((candidate) => candidate.eligibilityConfirmedAt).length >= royale.maxPlayers) {
    await drawHouseRoyale(bot, royale.id);
  }
}

async function syncOpenHouseRoyales(bot: TelegramBot): Promise<void> {
  const royales = await db
    .select()
    .from(casinoHouseRoyalesTable)
    .where(eq(casinoHouseRoyalesTable.status, "open"));
  for (const royale of royales) {
    if (royale.joinDeadlineAt && royale.joinDeadlineAt.getTime() <= Date.now()) {
      const [expired] = await db
        .update(casinoHouseRoyalesTable)
        .set({ status: "expired", drawnAt: new Date() })
        .where(
          and(
            eq(casinoHouseRoyalesTable.id, royale.id),
            eq(casinoHouseRoyalesTable.status, "open"),
          ),
        )
        .returning();
      if (expired && officialGroupChatId() !== null) {
        await bot.sendMessage(
          officialGroupChatId() as number,
          `<b>⏱ HOUSE ROYALE #${royale.id} REGISTRATION CLOSED</b>\nThe registration window ended before 8 eligible players joined.`,
        );
        if (royale.announcementMessageId) {
          try {
            await bot.unpinChatMessage(officialGroupChatId() as number, royale.announcementMessageId);
          } catch {
            // The message may no longer be pinned.
          }
        }
      }
      continue;
    }
    const rows = await houseRoyalePlayers(royale.id);
    let changed = false;
    for (const row of rows) {
      const [player] = await db
        .select()
        .from(casinoPlayersTable)
        .where(eq(casinoPlayersTable.id, row.playerId))
        .limit(1);
      if (!player) continue;
      const before = row.eligibilityConfirmedAt;
      const result = await updateHouseRoyalePlayerStatus(bot, royale, row, player);
      changed ||= Boolean(!before && result.row.eligibilityConfirmedAt);
    }
    const refreshedRows = await houseRoyalePlayers(royale.id);
    const eligibleCount = refreshedRows.filter((row) => row.eligibilityConfirmedAt).length;
    if (changed && officialGroupChatId() !== null) {
      const [freshRoyale] = await db
        .select()
        .from(casinoHouseRoyalesTable)
        .where(eq(casinoHouseRoyalesTable.id, royale.id))
        .limit(1);
      if (freshRoyale) await sendHouseRoyale(bot, officialGroupChatId() as number, freshRoyale);
    }
    if (eligibleCount >= royale.maxPlayers) await drawHouseRoyale(bot, royale.id);
  }
}

async function playHouseRoyaleMatch(
  bot: TelegramBot,
  chatId: number,
  roundLabel: string,
  playerOneId: number,
  playerTwoId: number,
): Promise<{
  playerOneId: number;
  playerTwoId: number;
  playerOneRoll: number;
  playerTwoRoll: number;
  winnerId: number;
  loserId: number;
}> {
  await bot.sendMessage(
    chatId,
    `<b>${roundLabel}</b>\n🎲 Player <code>${playerOneId}</code> vs Player <code>${playerTwoId}</code>`,
  );
  let playerOneRoll = 0;
  let playerTwoRoll = 0;
  for (let attempt = 0; attempt < 6 && playerOneRoll === playerTwoRoll; attempt += 1) {
    const first = await bot.sendDice(chatId, "🎲");
    const second = await bot.sendDice(chatId, "🎲");
    playerOneRoll = first.dice?.value ?? 0;
    playerTwoRoll = second.dice?.value ?? 0;
  }
  if (playerOneRoll === playerTwoRoll) {
    playerOneRoll = randomInt(1, 7);
    playerTwoRoll = playerOneRoll === 6 ? 5 : playerOneRoll + 1;
  }
  const winnerId = playerOneRoll > playerTwoRoll ? playerOneId : playerTwoId;
  const loserId = winnerId === playerOneId ? playerTwoId : playerOneId;
  await bot.sendMessage(
    chatId,
    `<b>${roundLabel} RESULT</b>\nPlayer <code>${playerOneId}</code>: <b>${playerOneRoll}</b>\nPlayer <code>${playerTwoId}</code>: <b>${playerTwoRoll}</b>\nWinner: <b>${winnerId}</b>`,
  );
  return {
    playerOneId,
    playerTwoId,
    playerOneRoll,
    playerTwoRoll,
    winnerId,
    loserId,
  };
}

async function drawHouseRoyale(
  bot: TelegramBot,
  royaleId: number,
): Promise<void> {
  const [royale] = await db
    .select()
    .from(casinoHouseRoyalesTable)
    .where(eq(casinoHouseRoyalesTable.id, royaleId))
    .limit(1);
  if (!royale || royale.status !== "open") return;
  const allPlayers = await houseRoyalePlayers(royale.id);
  const players = allPlayers.filter((player) => Boolean(player.eligibilityConfirmedAt));
  if (players.length !== royale.maxPlayers) {
    await bot.sendMessage(
      royale.chatId ?? royale.createdByTelegramUserId,
      `<b>❌ House Royale requires exactly ${royale.maxPlayers} eligible players before the dice bracket can start.</b>\nCurrent eligible players: ${players.length}/${royale.maxPlayers}`,
    );
    return;
  }
  const [claimed] = await db
    .update(casinoHouseRoyalesTable)
    .set({ status: "drawing" })
    .where(
      and(
        eq(casinoHouseRoyalesTable.id, royale.id),
        eq(casinoHouseRoyalesTable.status, "open"),
      ),
    )
    .returning();
  if (!claimed) return;

  const chatId = officialGroupChatId() ?? royale.chatId ?? royale.createdByTelegramUserId;
  const rounds: HouseRoyaleBracket["rounds"] = [];
  try {
    const firstRound: HouseRoyaleBracket["rounds"][number] = {
      label: "ROUND 1/3 · QUARTERFINALS",
      matches: [],
    };
    const firstRoundWinners: number[] = [];
    for (let index = 0; index < 8; index += 2) {
      const match = await playHouseRoyaleMatch(
        bot,
        chatId,
        `${firstRound.label} · MATCH ${index / 2 + 1}`,
        players[index].playerId,
        players[index + 1].playerId,
      );
      firstRound.matches.push(match);
      firstRoundWinners.push(match.winnerId);
    }
    rounds.push(firstRound);

    const secondRound: HouseRoyaleBracket["rounds"][number] = {
      label: "ROUND 2/3 · SEMIFINALS",
      matches: [],
    };
    const finalists: number[] = [];
    for (let index = 0; index < 4; index += 2) {
      const match = await playHouseRoyaleMatch(
        bot,
        chatId,
        `${secondRound.label} · MATCH ${index / 2 + 1}`,
        firstRoundWinners[index],
        firstRoundWinners[index + 1],
      );
      secondRound.matches.push(match);
      finalists.push(match.winnerId);
    }
    rounds.push(secondRound);

    const finalRound: HouseRoyaleBracket["rounds"][number] = {
      label: "ROUND 3/3 · FINAL",
      matches: [],
    };
    const finalMatch = await playHouseRoyaleMatch(
      bot,
      chatId,
      finalRound.label,
      finalists[0],
      finalists[1],
    );
    finalRound.matches.push(finalMatch);
    rounds.push(finalRound);

    const payouts = houseRoyalePayouts(royale.prizePoolMinor);
    const currency = parseCurrency(royale.currency, "INR");
    const winnerOneWallet = await ensureWallet(finalMatch.winnerId, currency);
    const winnerTwoWallet = await ensureWallet(finalMatch.loserId, currency);
    const houseWallet = await ensureHouseWallet(currency);
    await db.transaction(async (tx) => {
      const [updatedHouse] = await tx
        .update(casinoHouseWalletsTable)
        .set({
          balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} - ${royale.prizePoolMinor}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(casinoHouseWalletsTable.id, houseWallet.id),
            gte(casinoHouseWalletsTable.balanceMinor, royale.prizePoolMinor),
          ),
        )
        .returning();
      if (!updatedHouse) throw new Error("HOUSE_ROYALE_INSUFFICIENT_HOUSE_BALANCE");
      for (const [wallet, payoutMinor, placement] of [
        [winnerOneWallet, payouts.winnerOneMinor, 1],
        [winnerTwoWallet, payouts.winnerTwoMinor, 2],
      ] as const) {
        await tx
          .update(casinoWalletsTable)
          .set({
            balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${payoutMinor}`,
            updatedAt: new Date(),
          })
          .where(eq(casinoWalletsTable.id, wallet.id));
        await tx.insert(casinoLedgerEntriesTable).values({
          walletId: wallet.id,
          transactionId: `house-royale-${royale.id}-winner-${placement}`,
          entryType: "house_royale_prize",
          amountMinor: payoutMinor,
          description: `House Royale #${royale.id} ${placement === 1 ? "1st" : "2nd"} place prize`,
        });
        await tx
          .update(casinoHouseRoyalePlayersTable)
          .set({
            selected: true,
            placement,
            payoutMinor,
          })
          .where(
            and(
              eq(casinoHouseRoyalePlayersTable.royaleId, royale.id),
              eq(casinoHouseRoyalePlayersTable.playerId, placement === 1 ? finalMatch.winnerId : finalMatch.loserId),
            ),
          );
      }
      await tx
        .update(casinoHouseRoyalesTable)
        .set({
          status: "completed",
          winnerOneMinor: payouts.winnerOneMinor,
          winnerTwoMinor: payouts.winnerTwoMinor,
          bracketState: JSON.stringify({
            rounds,
            firstPlaceId: finalMatch.winnerId,
            secondPlaceId: finalMatch.loserId,
          } satisfies HouseRoyaleBracket),
          drawnAt: new Date(),
        })
        .where(eq(casinoHouseRoyalesTable.id, royale.id));
    });
    for (const [playerId, placement, payoutMinor] of [
      [finalMatch.winnerId, "1ST", payouts.winnerOneMinor],
      [finalMatch.loserId, "2ND", payouts.winnerTwoMinor],
    ] as const) {
      await bot.sendMessage(
        chatId,
        `<b>🏆 HOUSE ROYALE #${royale.id} · ${placement} PLACE</b>\nPlayer: <code>${playerId}</code>\nPrize credited: <b>${formatMoney(payoutMinor, currency)}</b>\nSplit: <b>60% / 40%</b>\nFair ID: <code>${royale.fairId}</code>`,
      );
    }
    await bot.sendMessage(
      chatId,
      `<b>✅ HOUSE ROYALE #${royale.id} COMPLETED</b>\nThree dice rounds finished. Prize pool split automatically 60% / 40%.`,
    );
  } catch (error) {
    await db
      .update(casinoHouseRoyalesTable)
      .set({ status: "open" })
      .where(eq(casinoHouseRoyalesTable.id, royale.id));
    logger.error({ err: error, royaleId }, "House Royale tournament failed");
    await bot.sendMessage(
      chatId,
      "<b>❌ House Royale could not complete safely.</b>\nNo prize was paid; an admin can start the full 8-player bracket again.",
    );
  }
}

async function drawHouseRoyaleLegacy(
  bot: TelegramBot,
  royaleId: number,
): Promise<void> {
  const [royale] = await db
    .select()
    .from(casinoHouseRoyalesTable)
    .where(eq(casinoHouseRoyalesTable.id, royaleId))
    .limit(1);
  if (!royale || royale.status !== "open") {
    if (royale?.createdByTelegramUserId) {
      await bot.sendMessage(royale.createdByTelegramUserId, "That House Royale is no longer open.");
    }
    return;
  }
  const players = await houseRoyalePlayers(royale.id);
  if (players.length < 2) {
    await bot.sendMessage(
      royale.createdByTelegramUserId,
      "House Royale needs at least 2 joined players before winners can be drawn.",
    );
    return;
  }
  const [claimed] = await db
    .update(casinoHouseRoyalesTable)
    .set({ status: "drawing" })
    .where(
      and(
        eq(casinoHouseRoyalesTable.id, royale.id),
        eq(casinoHouseRoyalesTable.status, "open"),
      ),
    )
    .returning();
  if (!claimed) return;
  const selected = shufflePlayers(players).slice(0, 2);
  const payouts = houseRoyalePayouts(royale.prizePoolMinor);
  const currency = parseCurrency(royale.currency, "USD");
  const winnerPayouts = [payouts.winnerOneMinor, payouts.winnerTwoMinor];
  try {
    const winnerWallets = await Promise.all(
      selected.map((player) => ensureWallet(player.playerId, currency)),
    );
    const houseWallet = await ensureHouseWallet(currency);
    await db.transaction(async (tx) => {
      const [updatedHouse] = await tx
        .update(casinoHouseWalletsTable)
        .set({
          balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} - ${royale.prizePoolMinor}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(casinoHouseWalletsTable.id, houseWallet.id),
            gte(casinoHouseWalletsTable.balanceMinor, royale.prizePoolMinor),
          ),
        )
        .returning();
      if (!updatedHouse) throw new Error("HOUSE_ROYALE_INSUFFICIENT_HOUSE_BALANCE");
      for (let index = 0; index < selected.length; index += 1) {
        const participant = selected[index];
        const payoutMinor = winnerPayouts[index];
        await tx
          .update(casinoWalletsTable)
          .set({
            balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${payoutMinor}`,
            updatedAt: new Date(),
          })
          .where(eq(casinoWalletsTable.id, winnerWallets[index].id));
        await tx.insert(casinoLedgerEntriesTable).values({
          walletId: winnerWallets[index].id,
          transactionId: `house-royale-${royale.id}-winner-${index + 1}`,
          entryType: "house_royale_prize",
          amountMinor: payoutMinor,
          description: `House Royale #${royale.id} ${index === 0 ? "1st" : "2nd"} place prize`,
        });
        await tx
          .update(casinoHouseRoyalePlayersTable)
          .set({
            selected: true,
            placement: index + 1,
            payoutMinor,
          })
          .where(eq(casinoHouseRoyalePlayersTable.id, participant.id));
      }
      await tx
        .update(casinoHouseRoyalesTable)
        .set({
          status: "completed",
          winnerOneMinor: payouts.winnerOneMinor,
          winnerTwoMinor: payouts.winnerTwoMinor,
          drawnAt: new Date(),
        })
        .where(eq(casinoHouseRoyalesTable.id, royale.id));
    });
  } catch (error) {
    await db
      .update(casinoHouseRoyalesTable)
      .set({ status: "open" })
      .where(eq(casinoHouseRoyalesTable.id, royale.id));
    if (error instanceof Error && error.message === "HOUSE_ROYALE_INSUFFICIENT_HOUSE_BALANCE") {
      await bot.sendMessage(
        royale.createdByTelegramUserId,
        `<b>❌ House Royale #${royale.id} could not draw.</b>\nHouse balance is below the ${formatMoney(royale.prizePoolMinor, currency)} prize pool.`,
      );
      return;
    }
    logger.error({ err: error, royaleId }, "House Royale draw failed");
    await bot.sendMessage(royale.createdByTelegramUserId, "House Royale draw failed and was left open.");
    return;
  }
  for (let index = 0; index < selected.length; index += 1) {
    const winner = await db
      .select()
      .from(casinoPlayersTable)
      .where(eq(casinoPlayersTable.id, selected[index].playerId))
      .limit(1);
    if (!winner[0]) continue;
    await bot.sendMessage(
      winner[0].telegramUserId,
      [
        `<b>🏆 HOUSE ROYALE #${royale.id} — ${index === 0 ? "1ST" : "2ND"} PLACE</b>`,
        "",
        `Prize credited: <b>${formatMoney(winnerPayouts[index], currency)}</b>`,
        `Prize pool: <b>${formatMoney(royale.prizePoolMinor, currency)}</b>`,
        `<b>Fair ID:</b> <code>${royale.fairId}</code>`,
      ].join("\n"),
    );
  }
  await bot.sendMessage(
    royale.createdByTelegramUserId,
    `<b>✅ House Royale #${royale.id} completed.</b>\n1st: <b>${formatMoney(payouts.winnerOneMinor, currency)}</b>\n2nd: <b>${formatMoney(payouts.winnerTwoMinor, currency)}</b>`,
  );
}

async function cancelHouseRoyale(
  bot: TelegramBot,
  chatId: number,
  royaleId: number,
): Promise<void> {
  const [royale] = await db
    .select()
    .from(casinoHouseRoyalesTable)
    .where(eq(casinoHouseRoyalesTable.id, royaleId))
    .limit(1);
  if (!royale || royale.status !== "open") {
    await bot.sendMessage(chatId, "That House Royale is no longer open.");
    return;
  }
  const [cancelled] = await db
    .update(casinoHouseRoyalesTable)
    .set({ status: "canceled", drawnAt: new Date() })
    .where(
      and(
        eq(casinoHouseRoyalesTable.id, royale.id),
        eq(casinoHouseRoyalesTable.status, "open"),
      ),
    )
    .returning();
  if (!cancelled) return;
  const players = await houseRoyalePlayers(royale.id);
  const currency = parseCurrency(royale.currency, "USD");
  const houseWallet = await ensureHouseWallet(currency);
  const wallets = await Promise.all(players.map((player) => ensureWallet(player.playerId, currency)));
  const totalRefund = players.reduce((total, player) => total + player.entryAmountMinor, 0);
  try {
    await db.transaction(async (tx) => {
      if (totalRefund > 0) {
        const [updatedHouse] = await tx
          .update(casinoHouseWalletsTable)
          .set({
            balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} - ${totalRefund}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(casinoHouseWalletsTable.id, houseWallet.id),
              gte(casinoHouseWalletsTable.balanceMinor, totalRefund),
            ),
          )
          .returning();
        if (!updatedHouse) throw new Error("HOUSE_ROYALE_REFUND_BALANCE");
      }
      for (let index = 0; index < players.length; index += 1) {
        const player = players[index];
        await tx
          .update(casinoWalletsTable)
          .set({
            balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${player.entryAmountMinor}`,
            updatedAt: new Date(),
          })
          .where(eq(casinoWalletsTable.id, wallets[index].id));
        await tx.insert(casinoLedgerEntriesTable).values({
          walletId: wallets[index].id,
          transactionId: `house-royale-${royale.id}-refund-${player.id}`,
          entryType: "house_royale_refund",
          amountMinor: player.entryAmountMinor,
          description: `House Royale #${royale.id} cancelled entry refund`,
        });
      }
    });
  } catch (error) {
    await db
      .update(casinoHouseRoyalesTable)
      .set({ status: "open", drawnAt: null })
      .where(eq(casinoHouseRoyalesTable.id, royale.id));
    logger.error({ err: error, royaleId }, "House Royale refund failed");
    await bot.sendMessage(chatId, "House Royale could not be cancelled safely; it remains open.");
    return;
  }
  await bot.sendMessage(
    chatId,
    `<b>✅ House Royale #${royale.id} cancelled.</b>\n${players.length} entry/refund(s) processed.`,
  );
}

async function createHouseRoyale(
  bot: TelegramBot,
  chatId: number,
  adminId: number,
  args: string[],
): Promise<void> {
  const prizePoolMinor = parseMoney(args[0]);
  const durationMinutes = Number(args[1]);
  const minWagerMinor = parseMoney(args[2]);
  const existing = await activeHouseRoyale();
  if (existing) {
    await bot.sendMessage(
      chatId,
      `<b>❌ House Royale #${existing.id} is already open.</b>\nClose or draw it before hosting another one.`,
    );
    return;
  }
  if (
    !prizePoolMinor ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 1 ||
    durationMinutes > 1_440 ||
    !minWagerMinor ||
    minWagerMinor < 0
  ) {
    await bot.sendMessage(
      chatId,
      [
        "<b>Usage:</b> <code>/organize PRIZEPOOL TIME MINWAGER</code>",
        "",
        "TIME is the registration window in minutes. House Royale always requires exactly 8 players.",
        "Every player needs at least 1 valid human referral and the configured INR wager in the last 30 days.",
        "Example: <code>/organize 5000 30 5000</code> → ₹5,000 prize pool, 30-minute registration, ₹5,000 minimum wager.",
      ].join("\n"),
    );
    return;
  }
  const joinDeadlineAt = new Date(Date.now() + durationMinutes * 60_000);
  const groupId = officialGroupChatId();
  const [royale] = await db
    .insert(casinoHouseRoyalesTable)
    .values({
      chatId: groupId ?? chatId,
      currency: "INR",
      entryAmountMinor: 0,
      maxPlayers: 8,
      prizePoolMinor,
      minWagerMinor,
      wagerPeriodDays: 30,
      createdByTelegramUserId: adminId,
      fairId: createFairId(),
      status: "open",
      joinDeadlineAt,
    })
    .returning();
  if (!royale) {
    await bot.sendMessage(chatId, "House Royale could not be created.");
    return;
  }
  await bot.sendMessage(
    chatId,
    `<b>✅ HOUSE ROYALE #${royale.id} ORGANIZED</b>\nPrize pool and registration time were set by admin only.\nThe bracket starts automatically at exactly 8 eligible players.`,
  );
  if (groupId !== null) {
    await sendHouseRoyale(bot, groupId, royale);
    await bot.sendMessage(
      chatId,
      `<b>📣 House Royale #${royale.id} posted in the official group and pinned.</b>\nPlayers can join from the group button and will receive live requirements in DM.`,
    );
  } else {
    await sendHouseRoyale(bot, chatId, royale, adminId);
  }
}

function giveawayOverviewSvg(
  settings: GiveawaySetting[],
  title: string,
  subtitle: string,
): string {
  const rows = settings.slice(0, 7).map((settingsRow, index) => {
    const currency = parseCurrency(settingsRow.currency, "INR");
    const y = 230 + index * 82;
    return [
      `<text x="86" y="${y}" fill="#f6c453" font-size="25" font-family="DejaVu Sans" font-weight="bold">${escapeXml(giveawayLabel(settingsRow, index))}</text>`,
      `<text x="420" y="${y}" fill="#ffffff" font-size="25" font-family="Deja Vu Sans" font-weight="bold">${escapeXml(formatMoney(settingsRow.amountMinor, currency))}</text>`,
      `<text x="680" y="${y}" fill="#b6c7df" font-size="20" font-family="Deja Sans">Wager ${escapeXml(formatMoney(settingsRow.minWagerMinor, currency))} · Referrals ${settingsRow.minReferralCount}</text>`,
      `<text x="420" y="${y + 30}" fill="#8da2bd" font-size="18" font-family="Deja Sans">Winners ${settingsRow.maxWinners || "all"} · Draw ${escapeXml(settingsRow.nextDrawAt?.toLocaleDateString("en-IN", { timeZone: "Asia/Calcutta" }) ?? "pending")}</text>`,
    ].join("");
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="820" viewBox="0 0 1400 820">
  <defs><linearGradient id="giveaway-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101a31"/><stop offset="1" stop-color="#183b45"/></linearGradient></defs>
  <rect width="1400" height="820" rx="42" fill="url(#giveaway-bg)"/><rect x="42" y="42" width="1316" height="736" rx="32" fill="none" stroke="#f6c453" stroke-opacity=".38" stroke-width="2"/>
  <text x="86" y="108" fill="#f6c453" font-size="30" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="164" fill="#ffffff" font-size="48" font-family="Deja Sans" font-weight="bold">${escapeXml(title)}</text>
  <text x="86" y="198" fill="#9db0cb" font-size="20" font-family="Deja Sans">${escapeXml(subtitle)}</text>
  ${rows || `<text x="700" y="360" text-anchor="middle" fill="#b6c7df" font-size="28" font-family="Deja Sans">No active giveaways</text>`}
  <text x="86" y="760" fill="#7185a3" font-size="18" font-family="Deja Sans">Eligibility is checked at join time and again before the draw.</text>
  </svg>`;
}

async function giveawayOverviewPng(
  settings: GiveawaySetting[],
  title: string,
  subtitle: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render giveaway image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(giveawayOverviewSvg(settings, title, subtitle)));
  });
}

function giveawayUserLabel(user: TelegramUser): string {
  return user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(" ") || `user ${user.id}`;
}

type GiveawayRequirementStatus = "review" | "not_eligible" | "joined";

function giveawayRequirementSvg(
  settings: GiveawaySetting,
  index: number,
  user: TelegramUser,
  metrics: { wagerMinor: number; referrals: number; bets: number },
  status: GiveawayRequirementStatus,
): string {
  const currency = parseCurrency(settings.currency, "INR");
  const statusText =
    status === "joined"
      ? "SUCCESSFULLY JOINED"
      : status === "not_eligible"
        ? "NOT ELIGIBLE YET"
        : metrics.wagerMinor >= settings.minWagerMinor &&
            metrics.referrals >= settings.minReferralCount
          ? "READY TO JOIN"
          : "CHECK REQUIREMENTS";
  const statusColor =
    status === "joined"
      ? "#76e3a3"
      : status === "not_eligible"
        ? "#f6c453"
        : "#9dd7ff";
  const userLabel = escapeXml(giveawayUserLabel(user));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="820" viewBox="0 0 1400 820">
  <defs><linearGradient id="giveaway-requirement-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101a31"/><stop offset="1" stop-color="#183b45"/></linearGradient></defs>
  <rect width="1400" height="820" rx="42" fill="url(#giveaway-requirement-bg)"/>
  <circle cx="1260" cy="110" r="230" fill="#eab308" opacity=".12"/>
  <circle cx="110" cy="760" r="210" fill="#2563eb" opacity=".11"/>
  <rect x="42" y="42" width="1316" height="736" rx="32" fill="none" stroke="#f6c453" stroke-opacity=".38" stroke-width="2"/>
  <text x="86" y="108" fill="#f6c453" font-size="30" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="166" fill="#ffffff" font-size="48" font-family="DejaVu Sans" font-weight="bold">${escapeXml(giveawayLabel(settings, index))}</text>
  <text x="1310" y="112" text-anchor="end" fill="${statusColor}" font-size="24" font-family="DejaVu Sans" font-weight="bold">${statusText}</text>
  <text x="86" y="218" fill="#9db0cb" font-size="22" font-family="DejaVu Sans">PLAYER</text>
  <text x="86" y="258" fill="#ffffff" font-size="34" font-family="DejaVu Sans" font-weight="bold">${userLabel}</text>
  <rect x="86" y="302" width="590" height="170" rx="24" fill="#ffffff" fill-opacity=".07" stroke="#ffffff" stroke-opacity=".1"/>
  <text x="122" y="346" fill="#8da2bd" font-size="19" font-family="DejaVu Sans" font-weight="bold">PRIZE</text>
  <text x="122" y="392" fill="#f6c453" font-size="34" font-family="DejaVu Sans" font-weight="bold">${escapeXml(formatMoney(settings.amountMinor, currency))}</text>
  <text x="122" y="434" fill="#b6c7df" font-size="20" font-family="DejaVu Sans">Winners: ${settings.maxWinners || "all eligible"} · Draw: ${escapeXml(settings.nextDrawAt?.toLocaleDateString("en-IN", { timeZone: "Asia/Calcutta" }) ?? "pending")}</text>
  <rect x="716" y="302" width="598" height="170" rx="24" fill="#ffffff" fill-opacity=".07" stroke="#ffffff" stroke-opacity=".1"/>
  <text x="752" y="346" fill="#8da2bd" font-size="19" font-family="DejaVu Sans" font-weight="bold">JOIN CONDITIONS</text>
  <text x="752" y="392" fill="#ffffff" font-size="23" font-family="DejaVu Sans">Wager: ${escapeXml(formatMoney(metrics.wagerMinor, currency))} / ${escapeXml(formatMoney(settings.minWagerMinor, currency))}</text>
  <text x="752" y="432" fill="#ffffff" font-size="23" font-family="DejaVu Sans">Referrals: ${metrics.referrals} / ${settings.minReferralCount}</text>
  <text x="86" y="554" fill="#8da2bd" font-size="19" font-family="DejaVu Sans" font-weight="bold">ACTIVITY</text>
  <text x="86" y="600" fill="#dbe7f5" font-size="27" font-family="DejaVu Sans">Messages / plays: ${metrics.bets}</text>
  <text x="86" y="662" fill="#b6c7df" font-size="21" font-family="DejaVu Sans">Minimum wager to join: ${escapeXml(formatMoney(settings.minWagerMinor, currency))}</text>
  <text x="86" y="700" fill="#b6c7df" font-size="21" font-family="DejaVu Sans">Minimum referrals to join: ${settings.minReferralCount}</text>
  <text x="1314" y="700" text-anchor="end" fill="${statusColor}" font-size="24" font-family="DejaVu Sans" font-weight="bold">${statusText}</text>
  <text x="86" y="760" fill="#7185a3" font-size="18" font-family="DejaVu Sans">Requirements are checked again when joining and before the draw.</text>
</svg>`;
}

async function giveawayRequirementPng(
  settings: GiveawaySetting,
  index: number,
  user: TelegramUser,
  metrics: { wagerMinor: number; referrals: number; bets: number },
  status: GiveawayRequirementStatus,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render giveaway requirements image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(giveawayRequirementSvg(settings, index, user, metrics, status)));
  });
}

type GiveawayRankingItem = {
  rank: number;
  name: string;
  wagerMinor: number;
  referrals: number;
  bets: number;
  messages: number;
  points: number;
  wagerEligible: boolean;
  referralEligible: boolean;
};

function giveawayRankingsSvg(
  setting: GiveawaySetting | null,
  items: GiveawayRankingItem[],
): string {
  const currency = parseCurrency(setting?.currency, "INR");
  const rankTitle = setting
    ? `${giveawayLabel(setting, 0)} RESULT · TOP 10 PLAYERS`
    : "GIVEAWAY RESULT · TOP 10 PLAYERS";
  const conditionHeader = setting
    ? `WAGER ${formatMoney(setting.minWagerMinor, currency)} MIN · ${setting.minReferralCount} REFERRALS MIN`
    : "NO ACTIVE GIVEAWAY · INFORMATIONAL SNAPSHOT";
  const rows = items.length > 0
    ? items.map((item, index) => {
        const y = 290 + index * 50;
        const eligible = Boolean(
          setting && item.wagerEligible && item.referralEligible,
        );
        const status = !setting ? "NO ACTIVE" : eligible ? "ELIGIBLE" : "NOT YET";
        const statusColor = eligible ? "#76e3a3" : "#f6c453";
        return [
          `<rect x="58" y="${y - 31}" width="1284" height="42" rx="13" fill="#ffffff" fill-opacity="${index < 3 ? ".09" : ".045"}" stroke="#ffffff" stroke-opacity=".08"/>`,
          `<text x="84" y="${y}" fill="#f6c453" font-size="25" font-family="DejaVu Sans, sans-serif" font-weight="bold">${item.rank}</text>`,
          `<text x="148" y="${y}" fill="#ffffff" font-size="23" font-family="DejaVu Sans, sans-serif" font-weight="bold">${escapeXml(svgLabel(item.name, 22))}</text>`,
          `<text x="470" y="${y}" text-anchor="end" fill="#dbe7f5" font-size="20" font-family="DejaVu Sans, sans-serif">${escapeXml(formatMoney(item.wagerMinor, currency))}</text>`,
          `<text x="650" y="${y}" text-anchor="end" fill="#dbe7f5" font-size="20" font-family="DejaVu Sans, sans-serif">${item.messages}</text>`,
          `<text x="780" y="${y}" text-anchor="end" fill="#dbe7f5" font-size="20" font-family="DejaVu Sans, sans-serif">${item.referrals}</text>`,
          `<text x="930" y="${y}" text-anchor="end" fill="#dbe7f5" font-size="20" font-family="DejaVu Sans, sans-serif" font-weight="bold">${item.points.toFixed(1)}</text>`,
          `<text x="1150" y="${y}" text-anchor="end" fill="${!setting ? "#8da2bd" : item.wagerEligible && item.referralEligible ? "#76e3a3" : "#f6c453"}" font-size="19" font-family="DejaVu Sans, sans-serif" font-weight="bold">${!setting ? "—" : `W${item.wagerEligible ? "✓" : "✗"} R${item.referralEligible ? "✓" : "✗"}`}</text>`,
          `<text x="1298" y="${y}" text-anchor="end" fill="${statusColor}" font-size="19" font-family="Deja Vu Sans, sans-serif" font-weight="bold">${status}</text>`,
        ].join("");
      }).join("")
    : `<text x="700" y="430" text-anchor="middle" fill="#b6c7df" font-size="28" font-family="Deja Sans">No wager or referral activity yet</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
  <defs><linearGradient id="giveaway-rank-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101a31"/><stop offset="1" stop-color="#183b45"/></linearGradient></defs>
  <rect width="1400" height="900" rx="42" fill="url(#giveaway-rank-bg)"/>
  <circle cx="1280" cy="90" r="220" fill="#eab308" opacity=".12"/>
  <circle cx="90" cy="840" r="220" fill="#2563eb" opacity=".11"/>
  <rect x="42" y="42" width="1316" height="816" rx="32" fill="none" stroke="#f6c453" stroke-opacity=".38" stroke-width="2"/>
  <text x="86" y="108" fill="#f6c453" font-size="29" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO</text>
  <text x="86" y="164" fill="#ffffff" font-size="42" font-family="DejaVu Sans" font-weight="bold">${escapeXml(rankTitle)}</text>
  <text x="86" y="199" fill="#9db0cb" font-size="20" font-family="Deja Sans">${escapeXml(conditionHeader)}</text>
  <text x="148" y="246" fill="#8da2bd" font-size="17" font-family="Deja Sans" font-weight="bold">PLAYER</text>
  <text x="470" y="246" text-anchor="end" fill="#8da2bd" font-size="17" font-family="Deja Sans" font-weight="bold">TOTAL WAGER</text>
  <text x="650" y="246" text-anchor="end" fill="#8da2bd" font-size="17" font-family="Deja Sans" font-weight="bold">MESSAGES</text>
  <text x="780" y="246" text-anchor="end" fill="#8da2bd" font-size="17" font-family="Deja Sans" font-weight="bold">REFERRALS</text>
  <text x="930" y="246" text-anchor="end" fill="#8da2bd" font-size="17" font-family="Deja Sans" font-weight="bold">POINTS</text>
  <text x="1150" y="246" text-anchor="end" fill="#8da2bd" font-size="17" font-family="Deja Sans" font-weight="bold">CONDITIONS</text>
  <text x="1298" y="246" text-anchor="end" fill="#8da2bd" font-size="17" font-family="Deja Sans" font-weight="bold">STATUS</text>
  ${rows}
  <text x="86" y="810" fill="#9db0cb" font-size="17" font-family="Deja Sans">Messages = completed game and battle entries recorded by RolexCasino. W✓/R✓ show each active condition.</text>
</svg>`;
}

async function giveawayRankingsPng(
  setting: GiveawaySetting | null,
  items: GiveawayRankingItem[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render giveaway rank image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(giveawayRankingsSvg(setting, items)));
  });
}

function giveawayOverviewKeyboard(
  settings: GiveawaySetting[],
): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: settings.flatMap((settingsRow, index) => [
      [
        {
          text: `Join ${index + 1}`,
          callback_data: `giveaway:select:${settingsRow.kind}`,
        },
        {
          text: `Rank ${index + 1}`,
          callback_data: `giveaway:rank:${settingsRow.kind}`,
        },
      ],
    ]),
  };
}

function giveawayRankSelectionKeyboard(
  settings: GiveawaySetting[],
): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: settings.map((settingsRow, index) => [{
      text: `🏆 ${giveawayLabel(settingsRow, index)} · ${formatMoney(settingsRow.amountMinor, parseCurrency(settingsRow.currency, "INR"))}`,
      callback_data: `giveaway:rank:${settingsRow.kind}`,
    }]),
  };
}

function giveawayPeriodMs(settings: {
  periodDays: number;
}): number {
  return Math.max(1, settings.periodDays) * 24 * 60 * 60 * 1_000;
}

async function sendGiveawaySettings(
  bot: TelegramBot,
  chatId: number,
  kind: string,
): Promise<void> {
  const [settings] = await db
    .select()
    .from(casinoGiveawaySettingsTable)
    .where(eq(casinoGiveawaySettingsTable.kind, kind))
    .limit(1);
  if (!settings || !settings.enabled) {
    await bot.sendMessage(chatId, `<b>🎁 ${kind.toUpperCase()} is not configured.</b>`);
    return;
  }
  const currency = parseCurrency(settings.currency, "INR");
  await bot.sendMessage(
    chatId,
    [
      `<b>🎁 ${kind.toUpperCase()} CONFIGURATION</b>`,
      "",
      `Reward: <b>${kind === "rakeback" ? `${(settings.amountMinor / 100).toFixed(2)}%` : formatMoney(settings.amountMinor, currency)}</b>`,
      `Name: <b>${escapeTelegramText(giveawayLabel(settings, 0))}</b>`,
      `Ranked prizes: <b>${escapeTelegramText(giveawayPrizeSummary(settings))}</b>`,
      `Maximum winners: <b>${settings.maxWinners || "all eligible"}</b>`,
      `Minimum wager: <b>${formatMoney(settings.minWagerMinor, currency)}</b>`,
      `Minimum referrals: <b>${settings.minReferralCount}</b>`,
      `Period: <b>${settings.periodDays} day(s)</b>`,
      `Next draw: <b>${settings.nextDrawAt?.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" }) ?? "not scheduled"}</b>`,
    ].join("\n"),
  );
}

async function publishGiveawayAnnouncement(
  bot: TelegramBot,
  settings: GiveawaySetting,
): Promise<void> {
  const announcementBot = activeGiveawayBot ?? bot;
  const groupId = officialGroupChatId();
  if (groupId === null) return;
  const image = await giveawayOverviewPng(
    [settings],
    giveawayLabel(settings, 0),
    "House-funded prize pool · requirements checked at join and again before the draw.",
  );
  const keyboard = {
    inline_keyboard: [
      [{
        text: "Join giveaway",
        callback_data: `giveaway:select:${settings.kind}`,
      }, {
        text: "🏆 View leaderboard",
        callback_data: `giveaway:rank:${settings.kind}`,
      }],
    ],
  };
  const caption = [
    `<b>🎁 ${giveawayLabel(settings, 0)}</b>`,
    `<b>Prize pool / default reward:</b> ${formatMoney(settings.amountMinor, parseCurrency(settings.currency, "INR"))}`,
    `<b>Ranked prizes:</b> ${giveawayPrizeSummary(settings)}`,
    `<b>Minimum wager:</b> ${formatMoney(settings.minWagerMinor, parseCurrency(settings.currency, "INR"))}`,
    `<b>Minimum referrals:</b> ${settings.minReferralCount}`,
    `<b>Draw:</b> ${settings.nextDrawAt?.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" }) ?? "scheduled soon"}`,
    "",
    "Tap Join giveaway. The bot will send your requirements in DM.",
  ].join("\n");
  let sent: TelegramMessage;
  if (settings.announcementMessageId && settings.announcementChatId === groupId) {
    sent = await announcementBot.editPhoto(groupId, settings.announcementMessageId, image, caption, keyboard);
  } else {
    sent = await announcementBot.sendPhoto(groupId, image, caption, keyboard);
  }
  await db
    .update(casinoGiveawaySettingsTable)
    .set({
      announcementChatId: groupId,
      announcementMessageId: sent.message_id,
    })
    .where(eq(casinoGiveawaySettingsTable.id, settings.id));
  try {
    await announcementBot.pinChatMessage(groupId, sent.message_id);
  } catch (error) {
    logger.warn({ err: error, kind: settings.kind }, "Giveaway announcement pin failed");
  }
}

async function configureGiveaway(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  kind: string,
  values: {
    amountMinor: number;
    currency: Currency;
    maxWinners: number;
    minWagerMinor: number;
    minReferralCount?: number;
    periodDays: number;
  },
): Promise<void> {
  const now = new Date();
  const [existing] = await db
    .select()
    .from(casinoGiveawaySettingsTable)
    .where(eq(casinoGiveawaySettingsTable.kind, kind))
    .limit(1);
  const nextDrawAt = existing?.nextDrawAt && existing.nextDrawAt > now
    ? existing.nextDrawAt
    : new Date(now.getTime() + values.periodDays * 24 * 60 * 60 * 1_000);
  if (existing) {
    await db
      .update(casinoGiveawaySettingsTable)
      .set({
        amountMinor: values.amountMinor,
        currency: values.currency,
        maxWinners: values.maxWinners,
        minWagerMinor: values.minWagerMinor,
        minReferralCount: values.minReferralCount ?? 0,
        periodDays: values.periodDays,
        enabled: true,
        updatedByTelegramUserId: userId,
        nextDrawAt,
        updatedAt: now,
      })
      .where(eq(casinoGiveawaySettingsTable.id, existing.id));
  } else {
    await db.insert(casinoGiveawaySettingsTable).values({
      kind,
      amountMinor: values.amountMinor,
      currency: values.currency,
      maxWinners: values.maxWinners,
      minWagerMinor: values.minWagerMinor,
      minReferralCount: values.minReferralCount ?? 0,
      periodDays: values.periodDays,
      enabled: true,
      updatedByTelegramUserId: userId,
      nextDrawAt,
    });
  }
  const [saved] = await db
    .select()
    .from(casinoGiveawaySettingsTable)
    .where(eq(casinoGiveawaySettingsTable.kind, kind))
    .limit(1);
  if (saved) await publishGiveawayAnnouncement(bot, saved);
  await bot.sendMessage(
    chatId,
    `<b>✅ ${kind.toUpperCase()} SAVED</b>\n\nNext draw: <b>${nextDrawAt.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" })}</b>`,
  );
}

async function distributeConfiguredGiveaways(bot: TelegramBot): Promise<void> {
  const now = new Date();
  const settingsRows = await db
    .select()
    .from(casinoGiveawaySettingsTable)
    .where(eq(casinoGiveawaySettingsTable.enabled, true));
  for (const settings of settingsRows) {
    if (!settings.nextDrawAt || settings.nextDrawAt > now) continue;
    const kind = settings.kind as GiveawayKind;
    const periodKey = settings.nextDrawAt.toISOString();
    const since = new Date(settings.nextDrawAt.getTime() - giveawayPeriodMs(settings));
    const players = await db.select().from(casinoPlayersTable);
    const referralCounts = new Map<number, number>();
    for (const player of players) {
      if (player.referredByPlayerId != null) {
        referralCounts.set(
          player.referredByPlayerId,
          (referralCounts.get(player.referredByPlayerId) ?? 0) + 1,
        );
      }
    }
    const rounds = await db
      .select()
      .from(casinoGameRoundsTable)
      .where(
        and(
          gte(casinoGameRoundsTable.createdAt, since),
          eq(casinoGameRoundsTable.currency, parseCurrency(settings.currency, "INR")),
        ),
      );
    const wagerByPlayer = new Map<number, number>();
    for (const round of rounds) {
      wagerByPlayer.set(round.playerId, (wagerByPlayer.get(round.playerId) ?? 0) + round.stakeMinor);
    }
    let eligible = players.filter(
      (player) =>
        (wagerByPlayer.get(player.id) ?? 0) >= settings.minWagerMinor &&
        (referralCounts.get(player.id) ?? 0) >= settings.minReferralCount,
    );
    if (kind === "referral") {
      eligible = players
        .filter((player) => player.referralEarningsMinor > 0)
        .sort((left, right) => right.referralEarningsMinor - left.referralEarningsMinor);
    } else if (kind !== "rakeback") {
      eligible = shufflePlayers(eligible);
    }
    const recipients = settings.maxWinners > 0
      ? eligible.slice(0, settings.maxWinners)
      : eligible;
    const recipientIds = new Set(recipients.map((recipient) => recipient.id));
    for (const recipient of eligible) {
      const rewardMinor = kind === "rakeback"
        ? Math.floor((wagerByPlayer.get(recipient.id) ?? 0) * settings.amountMinor / 10_000)
        : giveawayRankPrize(settings, eligible.indexOf(recipient));
      if (rewardMinor <= 0) continue;
      const [claim] = await db
        .insert(casinoGiveawayClaimsTable)
        .values({
          kind,
          periodKey,
          playerId: recipient.id,
          amountMinor: rewardMinor,
          currency: parseCurrency(settings.currency, "INR"),
          selected: recipientIds.has(recipient.id),
        })
        .onConflictDoNothing()
        .returning();
      if (!claim) continue;
      if (!claim.selected) continue;
      try {
        const reward = await adjustBalance({
          adminId: settings.updatedByTelegramUserId ?? 0,
          telegramUserId: recipient.telegramUserId,
          amountMinor: rewardMinor,
          currency: parseCurrency(settings.currency, "INR"),
          entryType: "admin_credit",
          description: `${kind} giveaway reward`,
        });
        if (kind === "monthly") {
          await sendBonusWinnerCard(
            bot,
            recipient.telegramUserId,
            "monthly",
            rewardMinor,
            parseCurrency(settings.currency, "INR"),
            reward.balanceMinor,
          );
        } else {
          await bot.sendMessage(
            recipient.telegramUserId,
            [
              `<b>🏆🎉 ${kind.toUpperCase()} WINNER</b>`,
              "",
              `Reward credited: <b>${formatMoney(rewardMinor, parseCurrency(settings.currency, "INR"))}</b>`,
              `Balance: <b>${formatMoney(reward.balanceMinor, parseCurrency(settings.currency, "INR"))}</b>`,
              "Withdrawal wagering rule: <b>1× the credited reward</b>.",
              "Use /wagerstatus to check progress.",
            ].join("\n"),
          );
        }
      } catch (error) {
        logger.warn({ err: error, playerId: recipient.id, kind }, "Giveaway reward notification failed");
      }
    }
    await db
      .update(casinoGiveawaySettingsTable)
      .set({
        nextDrawAt: new Date(settings.nextDrawAt.getTime() + giveawayPeriodMs(settings)),
        updatedAt: now,
      })
      .where(eq(casinoGiveawaySettingsTable.id, settings.id));
    const [rolledOver] = await db
      .select()
      .from(casinoGiveawaySettingsTable)
      .where(eq(casinoGiveawaySettingsTable.id, settings.id))
      .limit(1);
    if (rolledOver) await publishGiveawayAnnouncement(bot, rolledOver);
  }
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
  if (command === "balcredit") command = "credit";
  if (command === "baldebit") command = "debit";

  if (command === "hb") {
    await sendHouseBalance(bot, chatId, userId);
    return true;
  }

  const compactDaily = parseCompactRewardCommand(command, "daily");
  if (command === "setdaily" || compactDaily) {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const amountMinor = parseMoney(compactDaily?.amountToken ?? args[0]);
    const eligibleUsers = compactDaily ? Number(args[0] ?? 30) : Number(args[1]);
    const currencyToken = compactDaily?.currencyToken ?? args[2]?.toUpperCase();
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
        nextDistributionAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      })
      .onConflictDoUpdate({
        target: casinoDailyBonusSettingsTable.id,
        set: {
          amountMinor,
          currency,
          eligibleUsers,
          updatedByTelegramUserId: userId,
          nextDistributionAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
          updatedAt: new Date(),
        },
      });
    await sendBonusCard(bot, chatId, {
      title: "DAILY BONUS",
      subtitle: "BOT-SELECTED REWARD",
      status: "CONFIGURED",
      amount: formatMoney(amountMinor, currency),
      currency,
      winners: String(eligibleUsers),
      next: "Scheduled in 24 hours",
    });
    return true;
  }

  const compactWeekly = parseCompactRewardCommand(command, "weekly");
  if (command === "setweekly" || compactWeekly) {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const amountMinor = parseMoney(compactWeekly?.amountToken ?? args[0]);
    const eligibleUsers = compactWeekly ? Number(args[0] ?? 30) : Number(args[1]);
    const currencyToken = compactWeekly?.currencyToken ?? args[2]?.toUpperCase();
    const currency = parseCurrency(currencyToken, "INR");
    if (
      !amountMinor ||
      !Number.isInteger(eligibleUsers) ||
      eligibleUsers <= 0 ||
      (currencyToken !== undefined && !isSupportedCurrency(currencyToken))
    ) {
      await bot.sendMessage(chatId, "Usage: /setweekly AMOUNT USERS INR|USD\nExample: /setweekly 30 30 INR");
      return true;
    }
    await db
      .insert(casinoWeeklyBonusSettingsTable)
      .values({
        id: 1,
        amountMinor,
        currency,
        eligibleUsers,
        updatedByTelegramUserId: userId,
        nextDistributionAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
      })
      .onConflictDoUpdate({
        target: casinoWeeklyBonusSettingsTable.id,
        set: {
          amountMinor,
          currency,
          eligibleUsers,
          updatedByTelegramUserId: userId,
          nextDistributionAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
          updatedAt: new Date(),
        },
      });
    await sendBonusCard(bot, chatId, {
      title: "WEEKLY BONUS",
      subtitle: "BOT-SELECTED REWARD",
      status: "CONFIGURED",
      amount: formatMoney(amountMinor, currency),
      currency,
      winners: String(eligibleUsers),
      next: "Scheduled in 1 week",
    });
    return true;
  }

  if (
    command === "set" ||
    command === "setgameamount" ||
    normalizeConfigurableGameType(command.slice(3)) !== null ||
    parseCompactMinimumCommand(command) !== null
  ) {
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return true;
    }
    const compactSet = parseCompactMinimumCommand(command);
    const gameToken = command === "set" || command === "setgameamount"
      ? args[0]
      : compactSet?.gameToken ?? command.slice(3);
    const gameType = normalizeConfigurableGameType(gameToken);
    const valueArgs = command === "set" || command === "setgameamount"
      ? args.slice(1)
      : compactSet
        ? [compactSet.amountToken, ...args]
        : args;
    const amountMinor = parseMoney(valueArgs[0]);
    const requestedCurrencyToken =
      compactSet?.currencyToken ?? valueArgs[1]?.toUpperCase();
    const currencyToken = requestedCurrencyToken && isSupportedCurrency(requestedCurrencyToken)
      ? requestedCurrencyToken
      : compactSet
        ? undefined
        : requestedCurrencyToken;
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
         "Usage: /setgameamount GAME AMOUNT INR|USD\nExample: /setgameamount roulette 25 INR",
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
      `<b>✅ ${gameType.toUpperCase()} MINIMUM BET SET</b>\n\nMinimum bet: <b>${formatMoney(amountMinor, currency)}</b>\nCurrency: <b>${currency}</b> ✔️`,
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
    const requestedUsers = /^\d+$/.test(args[1] ?? "") ? Number(args[1]) : null;
    const currency = parseCurrency(
      requestedUsers === null ? args[1] : args[2],
      "INR",
    );
    if (!amountMinor || !isSupportedCurrency(currency)) {
      await bot.sendMessage(chatId, "Usage: /rain AMOUNT USERS INR|USD\nExample: /rain 100 10 INR");
      return true;
    }
    const allPlayers = await db
      .select({ telegramUserId: casinoPlayersTable.telegramUserId })
      .from(casinoPlayersTable);
    const players = allPlayers
      .map((player) => ({ player, sort: randomInt(0, 1_000_000_000) }))
      .sort((left, right) => left.sort - right.sort)
      .slice(0, requestedUsers ?? allPlayers.length)
      .map(({ player }) => player);
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
      `<b>🌧 RAIN COMPLETE</b>\n\nEach selected user received: <b>${formatMoney(amountMinor, currency)}</b>\nSelected users: <b>${credited}</b>\nCurrency: <b>${currency}</b>`,
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
         "/balcredit USER_ID AMOUNT INR|USD",
         "/baldebit USER_ID AMOUNT INR|USD",
        "/rain AMOUNT INR|USD — credit every registered user",
         "/setdaily AMOUNT MAX_WINNERS INR|USD — save daily bonus configuration",
         "/setweekly AMOUNT MAX_WINNERS INR|USD — save weekly bonus configuration",
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
      await unpinEscrow(bot, escrow);
      const currency = parseCurrency(escrow.currency, "USD");
      await bot.sendMessage(
        chatId,
        decision === "seller"
          ? `✅ Admin resolution complete: ${escrow.code} released to the accepting buyer. ${formatMoney(escrow.amountMinor, currency)} credited and the completed card was unpinned.`
          : `✅ Admin resolution complete: ${escrow.code} cancelled. ${formatMoney(escrow.amountMinor, currency)} refunded to the seller; the completed card was unpinned.`,
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
    const targetPlayer = await ensurePlayer({
      id: targetId,
      first_name: `Player ${targetId}`,
    });
    const result = await adjustBalance({
      adminId: userId,
      telegramUserId: targetId,
      amountMinor,
      currency,
      entryType: command === "credit" ? "admin_credit" : "admin_debit",
      description: `${command} ${formatMoney(amountMinor, currency)}`,
    });
    const amountText = formatMoney(amountMinor, currency);
    const balanceText = formatMoney(result.balanceMinor, currency);
    try {
      await bot.sendMessage(
        targetPlayer.telegramUserId,
        command === "credit"
          ? [
              "<b>✅ WALLET CREDITED BY ADMIN</b>",
              "",
              `Credited amount: <b>${amountText}</b>`,
              `Updated balance: <b>${balanceText}</b>`,
              `Withdrawal wagering: <b>1× ${amountText}</b> must be completed.`,
              "Use /wagerstatus to check your progress.",
            ].join("\n")
          : [
              "<b>⚠️ WALLET DEBITED BY ADMIN</b>",
              "",
              `Debited amount: <b>${amountText}</b>`,
              `Updated balance: <b>${balanceText}</b>`,
              "Send /support to contact admins if you have questions.",
            ].join("\n"),
      );
    } catch (error) {
      logger.warn(
        { err: error, targetId, entryType: command },
        "Could not notify player about admin balance adjustment",
      );
    }
    await bot.sendMessage(
      chatId,
       `${command === "credit" ? "Credited" : "Debited"} ${amountText}.\nNew balance: ${balanceText}.\nFair ID: ${result.fairId}`,
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
      `Fee: <b>${formatMoney(request.feeMinor, currency)}</b> (${currency === "USD" ? "3%" : "1%"})`,
      `Net credit after approval: <b>${formatMoney(amountMinor - request.feeMinor, currency)}</b>`,
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
  const paymentDetails = [
    "<b>Payment details</b>",
    "",
    `Currency: <b>${currency}</b>`,
    `Exact amount: <b>${formatMoney(pending.amountMinor, currency)}</b>`,
    `Deposit fee: <b>${formatMoney(depositFeeMinor(pending.amountMinor, currency), currency)}</b> (${currency === "USD" ? "3%" : "1%"})`,
    `Net credit after approval: <b>${formatMoney(pending.amountMinor - depositFeeMinor(pending.amountMinor, currency), currency)}</b>`,
    `Network: <b>${networkLabel(network)}</b>`,
    `Payment address: <code>${address}</code>`,
    "",
    "Scan the QR code or copy the address. Send the exact amount, then tap the button below.",
  ].join("\n");
  const paymentKeyboard = {
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
  };
  const qrImage = await depositQrImage(network);
  if (qrImage) {
    await bot.sendPhoto(chatId, qrImage, paymentDetails, paymentKeyboard);
  } else {
    await bot.sendMessage(chatId, paymentDetails, paymentKeyboard);
  }
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
  // Keep the owner-prefixed callback below Telegram's 64-byte limit.
  const token = createFairId();
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
      `Saved destination: <code>${escapeTelegramText(address)}</code>`,
      "",
      "<b>Review the amount, 4% fee, and saved destination before submitting.</b>",
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
      await bot.sendMessage(
        chatId,
        "<b>❌ Withdrawal not submitted</b>\n\nYour available balance changed before confirmation, so no amount was held. Please send /withdraw again.",
      );
      return;
    }
    logger.error({ err: error, userId: callback.from.id }, "Withdrawal submission failed");
    await bot.sendMessage(
      chatId,
      "<b>⚠️ Withdrawal could not be submitted</b>\n\nNo withdrawal was confirmed. Please try again in a moment or contact Support.",
    );
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
      : result === "insufficient_house"
        ? "Withdrawal was not approved because the HB balance is too low. Add house funds before approving this request."
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
      await bot.answerCallback(callback.id, BUTTON_NOT_FOR_YOU_MESSAGE, true);
      return;
    }
    await bot.answerCallback(callback.id);
    if (action.startsWith("giveaway:admin:")) {
      await handleGiveawayAdminAction(bot, callback);
      return;
    }
    if (action.startsWith("roll:")) {
      const [, rawStake, rawCurrency] = action.split(":");
      const rollBot = helperBots.get("dice");
      const stakeMinor = Number(rawStake);
      if (rollBot && Number.isInteger(stakeMinor) && stakeMinor > 0) {
        await playHelperGame(
          rollBot,
          bot,
          chatId,
          callback.from,
          stakeMinor,
          parseCurrency(rawCurrency, "USD"),
        );
      }
    } else if (action.startsWith("cash:")) {
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
      await openCurrencyMenu(
        bot,
        chatId,
        player,
        parseDisplayCurrency(player.preferredCurrency, "USD"),
        callback.message?.message_id,
      );
    } else if (action === "main:language") {
      await bot.sendMessage(
        chatId,
        "<b>🌐 Bot Language</b>\n\nChoose the language for your account menu.",
        languageKeyboard(player.language ?? "en", player.telegramUserId),
      );
    } else if (action === "main:giveaway") {
      await sendLatestGiveaway(bot, chatId);
      await bot.sendMessage(
        chatId,
        "<b>🎁 Giveaway bot commands</b>\n<code>/latest</code> — show the latest giveaway\n<code>/join</code> — join the latest giveaway",
      );
    } else if (action === "main:support") {
      await sendSupport(bot, chatId);
    } else if (action === "main:how") {
      await sendHowToPlay(bot, chatId);
    } else if (action === "main:terms") {
      await sendGameTerms(bot, chatId);
    } else if (action.startsWith("currency:set:")) {
      const currency = parseDisplayCurrency(action.split(":")[2], "USD");
      const currentCurrency = parseDisplayCurrency(player.preferredCurrency, "USD");
      if (currentCurrency === currency) return;
      await changePlayerCurrency(player.id, currency);
      const text = [
        `<b>✅ Currency updated — ${currency}</b>`,
        "",
        "Your display currency changed live. INR and USD remain the settlement wallets.",
        "",
        await balanceText(player.id, currency),
      ].join("\n");
      const keyboard = currencyKeyboard(currency, player.telegramUserId);
      const directMessage = callback.message &&
        isPrivateChat(callback.message.chat)
        ? { chatId: callback.message.chat.id, messageId: callback.message.message_id }
        : currencyMenuMessages.get(player.telegramUserId);
      if (directMessage) {
        try {
          await bot.editMessageText(
            directMessage.chatId,
            directMessage.messageId,
            text,
            keyboard,
          );
          currencyMenuMessages.set(player.telegramUserId, directMessage);
          return;
        } catch (error) {
          logger.debug(
            { err: error, userId: player.telegramUserId },
            "Currency menu message could not be edited; replacing it once",
          );
          currencyMenuMessages.delete(player.telegramUserId);
        }
      }
      await openCurrencyMenu(bot, chatId, player, currency);
    } else if (action.startsWith("language:set:")) {
      const language = action.split(":")[2] ?? "en";
      if (!BOT_LANGUAGES.some((item) => item.code === language)) return;
      await db
        .update(casinoPlayersTable)
        .set({ language, updatedAt: new Date() })
        .where(eq(casinoPlayersTable.id, player.id));
      const selected = BOT_LANGUAGES.find((item) => item.code === language) ?? BOT_LANGUAGES[0];
      await bot.sendMessage(
        chatId,
        `<b>✅ Language updated</b>\n\n${selected.flag} ${selected.label}`,
        languageKeyboard(language, player.telegramUserId),
      );
    } else if (action.startsWith("tip:")) {
      await handleTipCallback(bot, chatId, player, action, callback.message?.message_id);
    } else if (action.startsWith("escrow:")) {
      await handleEscrowCallback(bot, chatId, player, action, callback.message?.message_id);
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
    } else if (action.startsWith("bj:")) {
      if (!callback.message || !isOfficialGameChat(callback.message.chat)) {
        await bot.sendMessage(chatId, "Blackjack is available only in the official RolexCasino group.");
        return;
      }
      const [, rawAction, roomId] = action.split(":");
      if ((rawAction === "hit" || rawAction === "stand") && roomId) {
        await handleBlackjackAction(bot, chatId, callback.from, roomId, rawAction);
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
    } else if (action.startsWith("mines:select:")) {
      const [, , rawAmount, rawCurrency, rawMines] = action.split(":");
      const amountMinor = Number(rawAmount);
      const currency = parseCurrency(rawCurrency, parseCurrency(player.preferredCurrency, "USD"));
      const mines = Number(rawMines);
      if (Number.isSafeInteger(amountMinor) && Number.isInteger(mines)) {
        await startMinesGame(bot, chatId, callback.from, amountMinor, currency, mines);
      }
    } else if (action.startsWith("mines:auto:start:")) {
      void runMinesAuto(
        bot,
        chatId,
        callback.from,
        action.split(":")[3] ?? "",
      ).catch((error) => {
        logger.error({ err: error }, "Mines auto loop failed");
      });
    } else if (action.startsWith("mines:auto:stop:")) {
      await stopMinesAuto(bot, chatId, callback.from, action.split(":")[3] ?? "");
    } else if (action.startsWith("mines:open:")) {
      const [, , fairId, rawCell] = action.split(":");
      const cell = Number(rawCell);
      if (Number.isInteger(cell)) {
        await handleMinesChoice(bot, chatId, callback.from, fairId ?? "", cell);
      }
    } else if (action.startsWith("mines:closed:")) {
      await bot.sendMessage(chatId, "That Mines round is already closed.");
    } else if (action.startsWith("mines:cashout:")) {
      await cashOutMines(bot, chatId, callback.from, action.split(":")[2] ?? "");
    } else if (action.startsWith("roulette:menu:")) {
      const battleId = Number(action.split(":")[2]);
      if (Number.isInteger(battleId)) {
        const [battle] = await db
          .select()
          .from(casinoChallengesTable)
          .where(eq(casinoChallengesTable.id, battleId))
          .limit(1);
        if (
          battle &&
          battle.mode === "pvb" &&
          battle.gameType === "roulette" &&
          battle.status === "roulette_choice" &&
          battle.creatorPlayerId === player.id &&
          battle.messageId
        ) {
          await bot.editMessageText(
            chatId,
            battle.messageId,
            `<b>🎰 ROULETTE–VS BOT ROOM #${battle.id}</b>\n\nChoose a side below:`,
            rouletteKeyboard(player.telegramUserId, battle.id),
            ROULETTE_PREMIUM_EMOJI_OPTIONS,
          );
        }
      }
    } else if (action.startsWith("roulette:numbers:")) {
      const battleId = Number(action.split(":")[2]);
      if (Number.isInteger(battleId)) {
        const [battle] = await db
          .select()
          .from(casinoChallengesTable)
          .where(eq(casinoChallengesTable.id, battleId))
          .limit(1);
        if (
          battle &&
          battle.mode === "pvb" &&
          battle.gameType === "roulette" &&
          battle.status === "roulette_choice" &&
          battle.creatorPlayerId === player.id &&
          battle.messageId
        ) {
          await bot.editMessageText(
            chatId,
            battle.messageId,
            `<b>🎰 ROULETTE–VS BOT ROOM #${battle.id}</b>\n\nChoose a number from 1 to 36:`,
            rouletteKeyboard(player.telegramUserId, battle.id, true),
            ROULETTE_PREMIUM_EMOJI_OPTIONS,
          );
        }
      }
    } else if (action.startsWith("roulette:choose:")) {
      const [, , rawBattleId, firstChoice, rawNumber] = action.split(":");
      const choice = firstChoice === "number"
        ? `number:${rawNumber}` as RouletteChoice
        : firstChoice as RouletteChoice;
      const battleId = Number(rawBattleId);
      if (
        Number.isInteger(battleId) &&
        (choice === "odd" ||
          choice === "even" ||
          choice === "1-8" ||
          choice === "9-18" ||
          isRouletteChoice(choice))
      ) {
        await handleRouletteChoice(bot, chatId, callback.from, battleId, choice);
      }
    } else if (action.startsWith("coin:pvb:choose:")) {
      const [, , , rawBattleId, rawSide] = action.split(":");
      const battleId = Number(rawBattleId);
      if (
        Number.isInteger(battleId) &&
        (rawSide === "HEADS" || rawSide === "TAILS")
      ) {
        await handlePvbCoinChoice(
          bot,
          helperBots,
          chatId,
          callback.from,
          battleId,
          rawSide,
        );
      }
    } else if (action.startsWith("coin:choose:")) {
      const [, , rawBattleId, rawSide] = action.split(":");
      const battleId = Number(rawBattleId);
      if (
        Number.isInteger(battleId) &&
        (rawSide === "HEADS" || rawSide === "TAILS")
      ) {
        await handleCoinChoice(
          bot,
          helperBots,
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
  const parsedCommand = message.text ? commandFrom(message.text) : null;
  if (parsedCommand?.command === "power") {
    await handlePowerCommand(bot, chatId, message.from.id, parsedCommand.args);
    return;
  }
  if (!casinoPowerOn && !isAdmin(message.from.id)) {
    await bot.sendMessage(chatId, MAINTENANCE_MESSAGE);
    return;
  }
  if (message.dice) {
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
  if (isPrivateChat(message.chat) && message.text && !message.text.trim().startsWith("/")) {
    await bot.sendMessage(
      chatId,
      "<b>👋 I’m ready to help.</b>\n\nUse /help for commands, or choose Deposit, Withdraw, Games, or Support from the menu.",
    );
    return;
  }
  if (!message.text) return;
  if (!message.text.trim().startsWith("/")) return;
  const { command, args } = parsedCommand ?? commandFrom(message.text);
  if (command === "cancelgiveaway" || command === "editgiveaway") {
    if (!isPrivateChat(message.chat)) {
      await bot.sendMessage(
        chatId,
        "Giveaway admin controls are available only in a private DM.",
      );
      return;
    }
    if (!isAdmin(message.from.id)) {
      await bot.sendMessage(chatId, ADMIN_RESTRICTED_MESSAGE);
      return;
    }
    logger.info(
      { command, userId: message.from.id, chatId },
      "Giveaway admin command received by main bot",
    );
    const giveawayBot = activeGiveawayBot ?? bot;
    if (command === "cancelgiveaway") {
      await sendGiveawayCancelPanel(giveawayBot, chatId);
    } else {
      await sendGiveawayEditPanel(giveawayBot, chatId);
    }
    return;
  }
  const player = await ensurePlayer(message.from);
  if (await handleAdminCommand(bot, chatId, message.from.id, command, args, message)) return;
  const isGameplayCommand =
    Boolean(battleGameMap[command]) ||
    command === "coin" ||
    command === "7up" ||
    command === "dr" ||
    command === "limbo" ||
    command === "roul" ||
    command === "roulette" ||
    command === "mines" ||
    command === "minesauto" ||
    command === "bj" ||
    command === "blackjack" ||
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
    const fairArg = args[0]?.startsWith("fair_") ? args[0].slice(5) : null;
    if (fairArg) {
      await sendFairVerification(bot, chatId, fairArg);
      return;
    }
    const referralArg = args[0]?.startsWith("ref_") ? args[0].slice(4) : null;
    if (referralArg && player.referredByPlayerId == null) {
      const [referrer] = await db
        .select()
        .from(casinoPlayersTable)
        .where(eq(casinoPlayersTable.referralCode, referralArg))
        .limit(1);
      if (referrer && referrer.id !== player.id) {
        const reward = await rewardSuccessfulReferral(referrer, player.id);
        if (reward) {
          const referredLabel = player.username
            ? `@${player.username}`
            : player.displayName;
          await bot.sendMessage(
            referrer.telegramUserId,
            [
              "<b>🎉 VERIFIED REFERRAL SUCCESSFUL</b>",
              "",
              `Your referral of <b>${escapeTelegramText(referredLabel)}</b> has been verified.`,
              "",
              "<b>Reward credited as promised</b>",
              "• ₹5.00 to your INR wallet",
              "• $0.05 to your USD wallet",
              "",
              `Updated INR balance: <b>${formatMoney(reward.inrBalanceMinor, "INR")}</b>`,
              `Updated USD balance: <b>${formatMoney(reward.usdBalanceMinor, "USD")}</b>`,
              "",
              "<i>Keep sharing your verified referral link to earn more.</i>",
            ].join("\n"),
          );
          await bot.sendMessage(
            chatId,
            [
              "<b>✅ REFERRAL VERIFIED</b>",
              "",
              "Welcome to RolexCasino. Your referral was successfully verified.",
              "Your referrer has received ₹5.00 and $0.05 as promised.",
            ].join("\n"),
          );
          await auditTransaction(
            bot,
            [
              "Type: verified referral",
              `Referrer: ${referrer.telegramUserId}`,
              `Referred player: ${player.telegramUserId}`,
              "Bonus: ₹5.00 + $0.05",
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
  } else if (command === "fair") {
    await sendFairVerification(bot, chatId, args[0] ?? "");
  } else if (command === "help" || command === "support") {
    await sendMainHelp(bot, chatId, player.telegramUserId);
    if (command === "support") await sendSupport(bot, chatId);
  } else if (command === "language" || command === "lang") {
    await bot.sendMessage(
      chatId,
      "<b>🌐 Bot Language</b>\n\nChoose one of the available languages:",
      languageKeyboard(player.language ?? "en", player.telegramUserId),
    );
  } else if (command === "rates" || command === "exchange") {
    await sendCurrencyRates(bot, chatId);
  } else if (
    command === "giveawayrank" ||
    command === "givewayrank" ||
    command === "giveaway_rank"
  ) {
    await giveawayRankings(bot, chatId);
  } else if (command === "hrinfo") {
    await houseRoyaleInfo(bot, chatId, player.telegramUserId);
  } else if (command === "giveaway" || command === "latest") {
    await sendLatestGiveaway(bot, chatId);
    await bot.sendMessage(
      chatId,
      "<b>🎁 Giveaway bot commands</b>\n<code>/latest</code> — show the latest giveaway\n<code>/join</code> — join the latest giveaway",
    );
  } else if (command === "join") {
    const settings = await activeGiveawaySettings();
    if (settings[0]) await joinGiveaway(bot, chatId, message.from, settings[0]);
    else await bot.sendMessage(chatId, "<b>🎁 No active giveaway right now.</b>\nPlease check again soon.");
  } else if (command === "balance" || command === "wallet" || command === "bal" || command === "wal") {
    const currency = parseCurrency(args[0], parseCurrency(player.preferredCurrency, "USD"));
    await sendWallet(bot, chatId, { ...player, preferredCurrency: currency });
  } else if (command === "profile") {
    await sendProfile(bot, chatId, player);
  } else if (command === "currency" || command === "changecurrency") {
    const currency = args[0]?.toUpperCase() as DisplayCurrency | undefined;
    if (!currency || !DISPLAY_CURRENCIES.some((item) => item.code === currency)) {
      await openCurrencyMenu(
        bot,
        chatId,
        player,
        parseDisplayCurrency(player.preferredCurrency, "USD"),
      );
    } else {
      await changePlayerCurrency(player.id, currency);
      await openCurrencyMenu(
        bot,
        chatId,
        player,
        currency,
      );
    }
  } else if (command === "setwallet" || command === "saveupi") {
    if (!isPrivateChat(message.chat)) {
      await bot.sendMessage(chatId, "Wallet setup is available only in your private chat with RolexCasino.");
      return;
    }
    if (command === "setwallet" && args.length === 0) {
      await beginWalletSetup(bot, chatId, message.from.id);
      return;
    }
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
  } else if (command === "global" || command === "rank" || command === "leaderboard") {
    await sendWagerLeaderboard(bot, chatId, "global");
  } else if (command === "weekly") {
    await sendWagerLeaderboard(bot, chatId, "weekly");
  } else if (command === "monthly") {
    await sendWagerLeaderboard(bot, chatId, "monthly");
  } else if (command === "monthlybonus") {
    await sendMonthlyBonusStatus(bot, chatId, player);
  } else if (command === "weeklybonus") {
    await sendBonusClaimStatus(bot, chatId, player, "weekly");
  } else if (command === "rackback") {
    if (!isPrivateChat(message.chat)) {
      await bot.sendMessage(chatId, "Daily loss rebate details are available only in your private chat with RolexCasino.");
      return;
    }
    await sendRackbackStatus(bot, chatId, player);
  } else if (command === "reflead" || command === "referralleaderboard") {
    await sendReferralLeaderboard(bot, chatId);
  } else if (command === "wagerstatus") {
    await sendWagerStatus(
      bot,
      chatId,
      player.id,
      parseCurrency(player.preferredCurrency, "USD"),
    );
  } else if (command === "newclientseed") {
    const seed = createClientSeed();
    clientSeeds.set(player.telegramUserId, seed);
    await bot.sendMessage(
      chatId,
      `<b>✅ YOUR NEW CLIENT SEED</b>\n\n<b>Your client seed:</b> <code>${seed}</code>\n\n<b>${escapeTelegramText("Keep this seed private. It is used as your new fairness/cache seed.")}</b> ❌`,
    );
  } else if (command === "daily" || command === "dailybonus") {
    await sendBonusClaimStatus(bot, chatId, player, "daily");
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
    const requestedSide = coinArgs[0]?.toUpperCase();
    if (!repliedUser && (requestedSide === "HEADS" || requestedSide === "TAILS")) {
      const amountMinor = parseMoney(coinArgs[1]);
      const currency = parseCurrency(
        coinArgs[2],
        parseCurrency(player.preferredCurrency, "USD"),
      );
      await createBattle(
        bot,
        chatId,
        message.from,
        { gameType: "coin", emoji: "🪙" },
        {
          mode: "pvb",
          amountMinor,
          rounds: 1,
          rollsPerRound: 1,
          targetWins: null,
          currency,
          resultRule: requestedSide.toLowerCase() as "heads" | "tails",
        },
      );
    } else if (!repliedUser) {
      await bot.sendMessage(chatId, "<b>Usage:</b> <code>/coin heads AMOUNT INR|USD</code> for PVB, or reply to a player with <code>/coin AMOUNT INR|USD</code> for PVP.");
    } else {
      const pvpSide = requestedSide === "HEADS" || requestedSide === "TAILS"
        ? requestedSide
        : null;
      const amountMinor = parseMoney(pvpSide ? coinArgs[1] : coinArgs[0]);
      const currency = parseCurrency(
        pvpSide ? coinArgs[2] : coinArgs[1],
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
          resultRule: pvpSide ? pvpSide.toLowerCase() as "heads" | "tails" : "high",
        },
        invitedPlayer,
      );
    }
  } else if (command === "roul" || command === "roulette") {
    const amountMinor = parseMoney(args[0]);
    const currency = parseCurrency(
      args[1],
      parseCurrency(player.preferredCurrency, "USD"),
    );
    await startRoulette(bot, chatId, message.from, amountMinor, currency);
  } else if (command === "limbo") {
    const targetToken = args[1]?.toLowerCase().replace(/x$/, "");
    const targetMultiplier = targetToken ? Number(targetToken) : null;
    const amountMinor = parseMoney(args[0]);
    const currency = parseCurrency(args[2], parseCurrency(player.preferredCurrency, "USD"));
    await playLimbo(
      bot,
      chatId,
      message.from,
      amountMinor,
      Number.isFinite(targetMultiplier) ? targetMultiplier : null,
      currency,
    );
  } else if (command === "mines") {
    const amountMinor = parseMoney(args[0]);
    const currency = parseCurrency(args[1], parseCurrency(player.preferredCurrency, "USD"));
    if (!amountMinor) {
      await bot.sendMessage(chatId, "<b>Usage:</b> /mines AMOUNT INR|USD\n\nExample: <code>/mines 30 INR</code>");
    } else {
      await sendMinesSelection(bot, chatId, amountMinor, currency, player.telegramUserId);
    }
  } else if (command === "minesauto") {
    const mines = Number(args[0]);
    const amountMinor = parseMoney(args[1]);
    const currency = parseCurrency(args[2], parseCurrency(player.preferredCurrency, "USD"));
    if (!Number.isInteger(mines) || mines < 1 || mines > 3 || !amountMinor) {
      await bot.sendMessage(
        chatId,
        "<b>Usage:</b> <code>/minesauto BOMBS AMOUNT INR|USD</code>\n\n<b>Example:</b> <code>/minesauto 2 30 INR</code>",
      );
    } else {
      await startMinesGame(bot, chatId, message.from, amountMinor, currency, mines, true);
    }
  } else if (command === "bj" || command === "blackjack") {
    const amountMinor = parseMoney(args[0]);
    const currency = parseCurrency(args[1], parseCurrency(player.preferredCurrency, "USD"));
    await startBlackjack(bot, chatId, message.from, amountMinor, currency);
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
  rollBot: TelegramBot,
  resultBot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  stakeMinor: number,
  currency: Currency,
): Promise<void> {
  if (!rollBot.gameType) return;
  const player = await ensurePlayer(user);
  const wallet = await ensureWallet(player.id, currency);
  if (wallet.balanceMinor < stakeMinor) {
    await resultBot.sendMessage(
      chatId,
      `Insufficient ${currency} balance. Your balance is ${formatMoney(wallet.balanceMinor, currency)}.\nAsk an administrator to review a balance credit.`,
    );
    return;
  }

  const roll = await rollBot.sendDice(chatId);
  const rollValue = roll.dice?.value ?? 0;
  const result = evaluateRoll(rollBot.gameType, rollValue);
  try {
    const settled = await settleGame({
      playerId: player.id,
      helperBot: rollBot.label,
      gameType: rollBot.gameType,
      currency,
      stakeMinor,
      rollValue,
      result,
    });
    const payoutMinor = Math.floor(stakeMinor * result.multiplier);
    if (result.multiplier > 0) {
      await broadcastPlayerWin(resultBot, player.id, rollBot.gameType, payoutMinor, currency);
    }
    await sendDelayedGameResult(
      resultBot,
      chatId,
      [
        `<b>${rollBot.gameType === "slots" ? "🎰" : "🎲"} ${rollBot.gameType.toUpperCase()} RESULT</b>`,
        "",
        "<blockquote>",
        `<b>Roll:</b> ${rollValue}`,
        `<b>Multiplier:</b> <b>${result.multiplier.toFixed(2)}×</b>`,
        `<b>Bet:</b> <b>${formatMoney(stakeMinor, currency)} → ${formatMoney(payoutMinor, currency)}</b>`,
        `${rollBot.gameType === "slots" ? "🎰" : "🎲"} <b>Result:</b> ${result.outcome}`,
        "</blockquote>",
        result.multiplier > 0
          ? `<b>✅ WIN — YOU WON ${formatMoney(payoutMinor, currency)}</b>`
          : `<b>❌ LOSS — YOU LOST ${formatMoney(stakeMinor, currency)}</b>`,
        `Balance: <b>${formatMoney(settled.balanceMinor, currency)}</b>`,
        `Fair ID: <code>${settled.fairId}</code>`,
      ].join("\n"),
      {
        inline_keyboard: [
          [{
            text: "Roll again",
            callback_data: ownedCallback(`roll:${stakeMinor}:${currency}`, user.id),
          }],
        ],
      },
      premiumEmojiOptionsForGame(rollBot.gameType),
    );
    await auditTransaction(
      resultBot,
      [
        "Type: helper game settlement",
        `Player: ${player.telegramUserId}`,
        `Game: ${rollBot.gameType}`,
        `Stake: ${formatMoney(stakeMinor, currency)}`,
        `Payout: ${formatMoney(payoutMinor, currency)}`,
        `Fair ID: <code>${settled.fairId}</code>`,
        `Outcome: ${result.outcome}`,
      ].join("\n"),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      await resultBot.sendMessage(chatId, "The round was not accepted because your balance changed. Check /balance and try again.");
      return;
    }
    throw error;
  }
}

function dicePickLabel(choice: string | undefined): string {
  switch (choice) {
    case "high":
      return "4, 5, 6";
    case "low":
      return "1, 2, 3";
    case "odd":
      return "1, 3, 5";
    case "even":
      return "2, 4, 6";
    case "up":
      return "7–12";
    case "down":
      return "2–6";
    default:
      return choice?.toUpperCase() ?? "—";
  }
}

function simpleGameResultText(options: {
  gameType: string;
  choice?: string;
  rollValues: number[];
  rollValue: number;
  outcome: GameResult;
  stakeMinor: number;
  payoutMinor: number;
  currency: Currency;
  balanceMinor: number;
  fairId: string;
}): string {
  const isPredict = options.gameType === "dr";
  const title = isPredict ? "🎲 Predict (Dice)" : `${options.gameType.toUpperCase()} RESULT`;
  const rollLabel = options.gameType === "7up"
    ? `${options.rollValues.join(" + ")} = ${options.rollValue}`
    : String(options.rollValue);
  return [
    `<b>${options.outcome.multiplier > 0 ? "✅ WIN" : "❌ LOSS"} · ${title}</b>`,
    "",
    "<blockquote>",
    isPredict ? `<b>Your pick:</b> ${dicePickLabel(options.choice)}` : "",
    `<b>Multiplier:</b> <b>${options.outcome.multiplier.toFixed(2)}×</b>`,
    `<b>Bet:</b> <b>${formatMoney(options.stakeMinor, options.currency)} → ${formatMoney(options.payoutMinor, options.currency)}</b>`,
    `🎲 <b>Rolled value:</b> <b>${rollLabel}</b> ${options.outcome.multiplier > 0 ? "✅" : "❌"}`,
    "</blockquote>",
    options.outcome.multiplier > 0
      ? `<b>✅ YOU WON ${formatMoney(options.payoutMinor, options.currency)}</b>`
      : `<b>❌ YOU LOST ${formatMoney(options.stakeMinor, options.currency)}</b>`,
    `Balance: <b>${formatMoney(options.balanceMinor, options.currency)}</b>`,
    `Fair ID: <code>${options.fairId}</code>`,
  ].filter(Boolean).join("\n");
}

function blackjackCardsLabel(cards: import("./rolex-casino-blackjack").BlackjackCard[]): string {
  return cards.map(blackjackCardLabel).join("  ");
}

function blackjackStatusText(status: BlackjackStatus): string {
  switch (status) {
    case "player_blackjack":
      return "✅ BLACKJACK — YOU WIN";
    case "won":
      return "✅ YOU WIN";
    case "lost":
      return "❌ YOU LOSE — DEALER WINS";
    case "push":
      return "✅ PUSH — STAKE RETURNED";
    default:
      return "YOUR TURN";
  }
}

function blackjackCaption(
  room: BlackjackRoom,
  settled?: { balanceMinor: number; fairId: string },
): string {
  const { game } = room;
  const active = game.status === "active";
  const dealerCards = active
    ? `${blackjackCardLabel(game.dealerCards[0])}  🂠`
    : blackjackCardsLabel(game.dealerCards);
  const payoutMinor = Math.round(room.amountMinor * blackjackMultiplier(game.status));
  return [
    `<b>♠️ ROLEX-CASINO BLACKJACK · ROOM ${room.roomId}</b>`,
    "",
    `<b>Dealer:</b> ${dealerCards}${active ? "" : `  · <b>${blackjackHandValue(game.dealerCards)}</b>`}`,
    `<b>You:</b> ${blackjackCardsLabel(game.playerCards)}  · <b>${blackjackHandValue(game.playerCards)}</b>`,
    "",
    `<b>Bet:</b> <b>${formatMoney(room.amountMinor, room.currency)}</b>`,
    active
      ? "<i>Hit for another card or stand to reveal the dealer.</i>"
      : `<b>${blackjackStatusText(game.status)}</b> · <b>${formatMoney(payoutMinor, room.currency)}</b>`,
    settled ? `Balance: <b>${formatMoney(settled.balanceMinor, room.currency)}</b>` : "",
    `Fair ID: <code>${settled?.fairId ?? room.fairId}</code>`,
  ].filter(Boolean).join("\n");
}

function blackjackKeyboard(
  room: BlackjackRoom,
): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (room.game.status !== "active") return undefined;
  return {
    inline_keyboard: [[
      {
        text: "Hit",
        callback_data: ownedCallback(`bj:hit:${room.roomId}`, room.userId),
      },
      {
        text: "Stand",
        callback_data: ownedCallback(`bj:stand:${room.roomId}`, room.userId),
      },
    ]],
  };
}

function blackjackCardSvg(room: BlackjackRoom): string {
  const { game } = room;
  const dealerCards = game.status === "active"
    ? [game.dealerCards[0], null]
    : game.dealerCards;
  const cardWidth = 146;
  const cardHeight = 200;
  const handMarkup = (
    cards: (import("./rolex-casino-blackjack").BlackjackCard | null)[],
    y: number,
  ) => {
    const gap = 16;
    const totalWidth = cards.length * cardWidth + Math.max(0, cards.length - 1) * gap;
    const startX = 76 + Math.max(0, (700 - totalWidth) / 2);
    return cards.map((card, index) => {
      const x = startX + index * (cardWidth + gap);
      if (!card) {
        return `<g transform="translate(${x} ${y})"><rect width="${cardWidth}" height="${cardHeight}" rx="18" fill="#32146b" stroke="#46e7a0" stroke-width="4"/><rect x="12" y="12" width="${cardWidth - 24}" height="${cardHeight - 24}" rx="12" fill="none" stroke="#e5c45f" stroke-width="3" stroke-dasharray="9 6"/><text x="${cardWidth / 2}" y="122" text-anchor="middle" fill="#f5d477" font-size="58" font-family="DejaVu Sans" font-weight="bold">R</text></g>`;
      }
      const isRed = card.suit === "♥" || card.suit === "♦";
      const color = isRed ? "#c52258" : "#111827";
      const rankSize = card.rank === "10" ? 34 : 42;
      return `<g transform="translate(${x} ${y})"><rect width="${cardWidth}" height="${cardHeight}" rx="18" fill="#fbfcff" stroke="#46e7a0" stroke-width="4"/><text x="17" y="44" fill="${color}" font-size="${rankSize}" font-family="DejaVu Sans" font-weight="bold">${escapeXml(card.rank)}</text><text x="18" y="82" fill="${color}" font-size="34" font-family="DejaVu Sans" font-weight="bold">${escapeXml(card.suit)}</text><text x="${cardWidth / 2}" y="142" text-anchor="middle" fill="${color}" font-size="58" font-family="DejaVu Sans" font-weight="bold">${escapeXml(card.suit)}</text><text x="${cardWidth - 18}" y="${cardHeight - 17}" text-anchor="end" fill="${color}" font-size="${rankSize}" font-family="DejaVu Sans" font-weight="bold" transform="rotate(180 ${cardWidth - 18} ${cardHeight - 17})">${escapeXml(card.rank)}</text></g>`;
    }).join("");
  };
  const resultColor =
    game.status === "won" || game.status === "player_blackjack" ? "#70e59a" :
      game.status === "lost" ? "#ff7d91" : "#f3cf69";
  const result = game.status === "active" ? "YOUR TURN" : blackjackStatusText(game.status);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="820" viewBox="0 0 1400 820">
  <defs><linearGradient id="felt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#061d25"/><stop offset="1" stop-color="#123d3b"/></linearGradient><linearGradient id="gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#bb8a2d"/><stop offset=".5" stop-color="#ffe9a2"/><stop offset="1" stop-color="#c99b3b"/></linearGradient></defs>
  <rect width="1400" height="820" rx="38" fill="url(#felt)"/><circle cx="1210" cy="130" r="270" fill="#d0a848" opacity=".08"/><circle cx="220" cy="740" r="300" fill="#4fd1c5" opacity=".07"/><rect x="36" y="36" width="1328" height="748" rx="28" fill="none" stroke="#d9b55c" stroke-opacity=".38" stroke-width="2"/>
  <text x="76" y="102" fill="#f5d477" font-size="32" font-family="DejaVu Sans" font-weight="bold" letter-spacing="6">ROLEX-CASINO</text><text x="76" y="162" fill="#fff" font-size="58" font-family="DejaVu Sans" font-weight="bold">BLACKJACK</text><text x="1290" y="102" text-anchor="end" fill="#b7d8d0" font-size="25" font-family="DejaVu Sans">ROOM ${escapeXml(room.roomId)}</text><text x="1290" y="146" text-anchor="end" fill="#ffffff" font-size="32" font-family="DejaVu Sans" font-weight="bold">${escapeXml(room.playerLabel)}</text>
  <text x="76" y="222" fill="#9cc4bd" font-size="25" font-family="DejaVu Sans" font-weight="bold">DEALER · ${game.status === "active" ? "HIDDEN CARD" : `${blackjackHandValue(game.dealerCards)} POINTS`}</text>${handMarkup(dealerCards, 244)}
  <line x1="76" y1="492" x2="1290" y2="492" stroke="#d9b55c" stroke-opacity=".22"/><text x="76" y="536" fill="#9cc4bd" font-size="25" font-family="DejaVu Sans" font-weight="bold">PLAYER · ${blackjackHandValue(game.playerCards)} POINTS</text>${handMarkup(game.playerCards, 558)}
  <rect x="920" y="220" width="350" height="520" rx="24" fill="#071a25" stroke="#46e7a0" stroke-opacity=".45" stroke-width="2"/><text x="950" y="278" fill="#b7d8d0" font-size="23" font-family="DejaVu Sans" font-weight="bold">ROUND RESULT</text><text x="950" y="348" fill="${resultColor}" font-size="42" font-family="DejaVu Sans" font-weight="bold">${result}</text><text x="950" y="414" fill="#fff" font-size="29" font-family="DejaVu Sans">BET ${escapeXml(formatMoney(room.amountMinor, room.currency))}</text><text x="950" y="475" fill="#b7d8d0" font-size="24" font-family="DejaVu Sans">PLAYER SCORE</text><text x="950" y="525" fill="#fff" font-size="48" font-family="DejaVu Sans" font-weight="bold">${blackjackHandValue(game.playerCards)}</text><text x="950" y="586" fill="#b7d8d0" font-size="24" font-family="DejaVu Sans">DEALER SCORE</text><text x="950" y="636" fill="#fff" font-size="48" font-family="DejaVu Sans" font-weight="bold">${game.status === "active" ? "?" : blackjackHandValue(game.dealerCards)}</text><text x="950" y="694" fill="url(#gold)" font-size="22" font-family="DejaVu Sans">FAIR RANDOM RESULT</text>
  </svg>`;
}

async function blackjackCardPng(room: BlackjackRoom): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("convert", ["svg:-", "png:-"]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not render blackjack image: ${Buffer.concat(errors).toString("utf8")}`));
    });
    process.stdin.end(applyRolexGoldBlackTheme(blackjackCardSvg(room)));
  });
}

async function finishBlackjackRoom(bot: TelegramBot, room: BlackjackRoom): Promise<void> {
  if (blackjackActionsInFlight.has(room.roomId)) return;
  blackjackActionsInFlight.add(room.roomId);
  const payoutMultiplier = blackjackMultiplier(room.game.status);
  try {
    await wait(PVP_RESULT_DELAY_MS);
    const settled = await settleGame({
      playerId: room.playerId,
      helperBot: "blackjack-main",
      gameType: "bj",
      currency: room.currency,
      stakeMinor: room.amountMinor,
      rollValue: blackjackHandValue(room.game.playerCards),
      result: {
        outcome: room.game.status === "push" ? "PUSH" : payoutMultiplier > 0 ? "WIN" : "LOSS",
        multiplier: payoutMultiplier,
      },
      fairId: room.fairId,
    });
    activeBlackjackRooms.delete(room.roomId);
    const image = await blackjackCardPng(room);
    const caption = blackjackCaption(room, settled);
    if (room.messageId) {
      try {
        await bot.editPhoto(
          room.chatId,
          room.messageId,
          image,
          caption,
          { inline_keyboard: [] },
        );
      } catch (error) {
        logger.warn({ err: error, roomId: room.roomId }, "Blackjack result edit failed; sending result message");
        try {
          await bot.editReplyMarkup(room.chatId, room.messageId, { inline_keyboard: [] });
        } catch (markupError) {
          logger.warn({ err: markupError, roomId: room.roomId }, "Blackjack button cleanup failed");
        }
        await bot.sendPhoto(room.chatId, image, caption);
      }
    } else {
      const sent = await bot.sendPhoto(room.chatId, image, caption);
      room.messageId = sent.message_id;
    }
    if (payoutMultiplier > 0) {
      await broadcastPlayerWin(bot, room.playerId, "blackjack", Math.round(room.amountMinor * payoutMultiplier), room.currency);
    }
    await auditTransaction(
      bot,
      [
        "Type: blackjack settlement",
        `Player: ${room.userId}`,
        `Room: ${room.roomId}`,
        `Stake: ${formatMoney(room.amountMinor, room.currency)}`,
        `Payout: ${formatMoney(Math.round(room.amountMinor * payoutMultiplier), room.currency)}`,
        `Fair ID: <code>${room.fairId}</code>`,
        `Outcome: ${room.game.status}`,
      ].join("\n"),
    );
  } finally {
    blackjackActionsInFlight.delete(room.roomId);
  }
}

async function updateBlackjackRoom(bot: TelegramBot, room: BlackjackRoom): Promise<void> {
  const image = await blackjackCardPng(room);
  const caption = blackjackCaption(room);
  if (room.messageId) {
    await bot.editPhoto(room.chatId, room.messageId, image, caption, blackjackKeyboard(room));
  }
}

async function startBlackjack(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  amountMinor: number | null,
  currency: Currency,
): Promise<void> {
  if (!amountMinor) {
    await bot.sendMessage(chatId, "<b>Usage:</b> /bj AMOUNT INR|USD\n\nExample: <code>/bj 100 INR</code>");
    return;
  }
  const existing = [...activeBlackjackRooms.values()].find((room) => room.userId === user.id);
  if (existing) {
    await bot.sendMessage(chatId, `You already have an active Blackjack room <b>${existing.roomId}</b>. Finish it before starting another.`);
    return;
  }
  if (!(await betInRange(amountMinor, currency, "bj"))) {
    await bot.sendMessage(chatId, await configuredBetLimitText(currency, "bj"));
    return;
  }
  const player = await ensurePlayer(user);
  const wallet = await ensureWallet(player.id, currency);
  if (wallet.balanceMinor < amountMinor) {
    await bot.sendMessage(chatId, `<b>❌ Insufficient balance</b>\nAvailable: <b>${formatMoney(wallet.balanceMinor, currency)}</b>`);
    return;
  }
  const room: BlackjackRoom = {
    roomId: randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase(),
    userId: user.id,
    playerLabel: user.username
      ? `@${user.username}`
      : [user.first_name, user.last_name].filter(Boolean).join(" ") || "Player",
    playerId: player.id,
    chatId,
    amountMinor,
    currency,
    fairId: createFairId(),
    game: createBlackjackGame(() => randomInt(0, 1_000_000) / 1_000_000),
  };
  activeBlackjackRooms.set(room.roomId, room);
  try {
    const sent = await bot.sendPhoto(
      chatId,
      await blackjackCardPng(room),
      blackjackCaption(room),
      blackjackKeyboard(room),
    );
    room.messageId = sent.message_id;
    if (room.game.status !== "active") await finishBlackjackRoom(bot, room);
  } catch (error) {
    activeBlackjackRooms.delete(room.roomId);
    throw error;
  }
}

async function handleBlackjackAction(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  roomId: string,
  action: "hit" | "stand",
): Promise<void> {
  const room = activeBlackjackRooms.get(roomId);
  if (!room || room.userId !== user.id || room.chatId !== chatId || room.game.status !== "active") {
    return;
  }
  if (blackjackActionsInFlight.has(room.roomId)) return;
  blackjackActionsInFlight.add(room.roomId);
  try {
    if (action === "hit") blackjackHit(room.game);
    else blackjackStand(room.game);
    if (room.game.status === "active") {
      await updateBlackjackRoom(bot, room);
      blackjackActionsInFlight.delete(room.roomId);
    } else {
      blackjackActionsInFlight.delete(room.roomId);
      await finishBlackjackRoom(bot, room);
    }
  } catch (error) {
    blackjackActionsInFlight.delete(room.roomId);
    logger.error({ err: error, roomId: room.roomId, action }, "Blackjack action failed");
    await bot.sendMessage(chatId, "Blackjack could not finish this action. Please check the room result.");
  }
}

async function handleHelperUpdate(
  bot: TelegramBot,
  update: TelegramUpdate,
  resultBot: TelegramBot,
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
    const rawAction = callback.data ?? "";
    if (!rawAction.startsWith("owner:")) return;
    const action = resolveCallbackOwner(rawAction, callback.from.id);
    if (action === null) return;
    if (!callback.message || !isOfficialGameChat(callback.message.chat)) return;
    if (action.startsWith("roll:")) {
      const [, rawStake, rawCurrency] = action.split(":");
      const stakeMinor = Number(rawStake);
      const currency = parseCurrency(rawCurrency, "USD");
      if (Number.isInteger(stakeMinor) && stakeMinor > 0) {
        await playHelperGame(
          bot,
          resultBot,
          chatId,
          callback.from,
          stakeMinor,
          currency,
        );
      }
    }
    return;
  }

  const message = update.message;
  if (!message?.from || !message.text) return;
  if (!casinoPowerOn && !isAdmin(message.from.id)) {
    await bot.sendMessage(message.chat.id, MAINTENANCE_MESSAGE);
    return;
  }
  const { command, args } = commandFrom(message.text);
  if (isPrivateChat(message.chat) || !isOfficialGameChat(message.chat)) return;
  if (command === "roll" || command === "play") {
    const amountMinor = parseMoney(args[0]);
    const player = await ensurePlayer(message.from);
    const currency = parseCurrency(args[1], parseCurrency(player.preferredCurrency, "USD"));
    if (amountMinor) {
      await playHelperGame(
        bot,
        resultBot,
        message.chat.id,
        message.from,
        amountMinor,
        currency,
      );
    }
    return;
  }
}

async function sendLatestGiveaway(
  bot: TelegramBot,
  chatId: number,
): Promise<void> {
  const settings = await activeGiveawaySettings();
  const royale = await activeHouseRoyale();
  if (royale) await sendHouseRoyale(bot, chatId, royale);
  if (!settings.length) {
    if (!royale) {
      await bot.sendMessage(chatId, "<b>🎁 No active giveaway right now.</b>\nPlease check again soon.");
    }
    return;
  }
  const image = await giveawayOverviewPng(
    settings,
    "ACTIVE GIVEAWAYS",
    "Choose a giveaway to see your username, minimum wager, minimum referrals, and join status.",
  );
  await bot.sendPhoto(
    chatId,
    image,
    "<b>🎁 ACTIVE ROLEXCASINO GIVEAWAYS</b>\nTap a giveaway to view your requirements and join.",
    giveawayOverviewKeyboard(settings),
  );
}

async function sendGiveawayRequirements(
  bot: TelegramBot,
  chatId: number,
  settings: GiveawaySetting,
  index: number,
  user?: TelegramUser,
  sourceMessage?: TelegramMessage,
): Promise<void> {
  const currency = parseCurrency(settings.currency, "INR");
  const player = user ? await ensurePlayer(user) : null;
  const metrics = player ? await giveawayPlayerMetrics(player.id, settings) : null;
  const username = user
    ? user.username
      ? `@${user.username}`
      : [user.first_name, user.last_name].filter(Boolean).join(" ") || `user ${user.id}`
    : "your account";
  const text = [
    `<b>🎁 ${giveawayLabel(settings, index)}</b>`,
    "",
    `Player: <b>${escapeTelegramText(username)}</b>`,
    `Prize: <b>${formatMoney(settings.amountMinor, currency)}</b>`,
    `Winners: <b>${settings.maxWinners || "all eligible"}</b>`,
    `Minimum wager to join: <b>${formatMoney(settings.minWagerMinor, currency)}</b>`,
    `Your wager: <b>${formatMoney(metrics?.wagerMinor ?? 0, currency)}</b>`,
    `Minimum referrals to join: <b>${settings.minReferralCount}</b>`,
    `Your referrals: <b>${metrics?.referrals ?? 0}</b>`,
    `Your messages/plays: <b>${metrics?.bets ?? 0}</b>`,
    `Draw: <b>${settings.nextDrawAt?.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) ?? "scheduled soon"}</b>`,
    "",
    "Press Join giveaway. Your wager and referral conditions are checked again before entry.",
  ].join("\n");
  const keyboard = {
    inline_keyboard: [
      [{
        text: "Join giveaway",
        callback_data: `giveaway:join:${settings.kind}`,
      }],
      [{
        text: `🏆 ${giveawayLabel(settings, index)} result · Top 10`,
        callback_data: `giveaway:rank:${settings.kind}`,
      }],
    ],
  };
  if (sourceMessage) {
    try {
      if (sourceMessage.photo?.length) {
        if (!user || !metrics) throw new Error("Giveaway requirements image needs a user");
        const image = await giveawayRequirementPng(
          settings,
          index,
          user,
          metrics,
          "review",
        );
        await bot.editPhoto(
          chatId,
          sourceMessage.message_id,
          image,
          text,
          keyboard,
        );
      } else {
        await bot.editMessageText(chatId, sourceMessage.message_id, text, keyboard);
      }
      return;
    } catch (error) {
      logger.debug(
        { err: error, chatId, messageId: sourceMessage.message_id },
        "Giveaway requirements message could not be edited; sending a replacement",
      );
      if (sourceMessage.photo?.length) {
        try {
          await bot.editMessageCaption(chatId, sourceMessage.message_id, text, keyboard);
          return;
        } catch (captionError) {
          logger.debug(
            { err: captionError, chatId, messageId: sourceMessage.message_id },
            "Giveaway photo caption fallback also failed",
          );
        }
      }
    }
  }
  await bot.sendMessage(chatId, text, keyboard);
}

async function joinGiveaway(
  bot: TelegramBot,
  chatId: number,
  user: TelegramUser,
  settings: GiveawaySetting,
  index = 0,
  sourceMessage?: TelegramMessage,
): Promise<void> {
  const player = await ensurePlayer(user);
  const metrics = await giveawayPlayerMetrics(player.id, settings);
  const currency = parseCurrency(settings.currency, "INR");
  const username = user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(" ") || `user ${user.id}`;
  const editStatusMessage = async (
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
    status: GiveawayRequirementStatus = "joined",
  ): Promise<boolean> => {
    if (!sourceMessage) return false;
    try {
      if (sourceMessage.photo?.length) {
        const image = await giveawayRequirementPng(
          settings,
          index,
          user,
          metrics,
          status,
        );
        await bot.editPhoto(
          chatId,
          sourceMessage.message_id,
          image,
          text,
          replyMarkup,
        );
      } else {
        await bot.editMessageText(chatId, sourceMessage.message_id, text, replyMarkup);
      }
      return true;
    } catch (error) {
      logger.debug(
        { err: error, chatId, messageId: sourceMessage.message_id },
        "Giveaway join message could not be edited; sending a replacement",
      );
      if (sourceMessage.photo?.length) {
        try {
          await bot.editMessageCaption(chatId, sourceMessage.message_id, text, replyMarkup);
          return true;
        } catch (captionError) {
          logger.debug(
            { err: captionError, chatId, messageId: sourceMessage.message_id },
            "Giveaway join photo caption fallback also failed",
          );
        }
      }
      return false;
    }
  };
  if (
    metrics.wagerMinor < settings.minWagerMinor ||
    metrics.referrals < settings.minReferralCount
  ) {
    const text = [
      "<b>❌ You are not eligible yet.</b>",
      "",
      `Player: <b>${escapeTelegramText(username)}</b>`,
      `Wager: <b>${formatMoney(metrics.wagerMinor, currency)}</b> / <b>${formatMoney(settings.minWagerMinor, currency)}</b>`,
      `Referrals: <b>${metrics.referrals}</b> / <b>${settings.minReferralCount}</b>`,
      `Messages/plays: <b>${metrics.bets}</b>`,
      "",
      "Keep playing and referring players, then press Join giveaway again.",
    ].join("\n");
    const edited = await editStatusMessage(text, {
      inline_keyboard: [
        [{
          text: "Join giveaway",
          callback_data: `giveaway:join:${settings.kind}`,
        }],
        [{
          text: `🏆 ${giveawayLabel(settings, index)} result · Top 10`,
          callback_data: `giveaway:rank:${settings.kind}`,
        }],
      ],
    }, "not_eligible");
    if (!edited) await bot.sendMessage(chatId, text);
    return;
  }
  const periodKey = settings.nextDrawAt?.toISOString() ?? `${settings.updatedAt.toISOString()}:${settings.id}`;
  const [entry] = await db
    .insert(casinoGiveawayClaimsTable)
    .values({
      kind: settings.kind,
      periodKey,
      playerId: player.id,
      amountMinor: settings.amountMinor,
      currency: parseCurrency(settings.currency, "INR"),
      selected: false,
    })
    .onConflictDoNothing()
    .returning();
  const text = [
    entry ? "<b>✅ You have successfully joined the giveaway!</b>" : "<b>ℹ️ You are already registered for this giveaway.</b>",
    "",
    `Player: <b>${escapeTelegramText(username)}</b>`,
    `Minimum wager: <b>${formatMoney(settings.minWagerMinor, currency)}</b> · Your wager: <b>${formatMoney(metrics.wagerMinor, currency)}</b>`,
    `Minimum referrals: <b>${settings.minReferralCount}</b> · Your referrals: <b>${metrics.referrals}</b>`,
    `Messages/plays: <b>${metrics.bets}</b>`,
    "",
    "Use /giveawayrank to see your points and rank.",
  ].join("\n");
  const edited = await editStatusMessage(text, { inline_keyboard: [] });
  if (!edited) await bot.sendMessage(chatId, text);
}

function giveawayDraftLabel(draft: GiveawayDraft): string {
  const currency = draft.currency ?? "INR";
  return [
    `Amount: ${draft.amountMinor ? formatMoney(draft.amountMinor, currency) : "not selected"}`,
    `Currency: ${currency}`,
    `Winners: ${draft.maxWinners === 0 ? "all eligible users" : draft.maxWinners ?? "not selected"}`,
    `Minimum referrals: ${draft.minReferralCount ?? "not selected"}`,
    `Minimum wager: ${draft.minWagerMinor !== undefined ? formatMoney(draft.minWagerMinor, currency) : "not selected"}`,
    `Duration: ${draft.periodDays ? `${draft.periodDays} day(s)` : "not selected"}`,
  ].join("\n");
}

async function sendGiveawayAdminStep(
  bot: TelegramBot,
  chatId: number,
  adminId: number,
): Promise<void> {
  const draft = giveawayDrafts.get(adminId);
  if (!draft) return;
  const button = (text: string, data: string): InlineKeyboardButton => ({
    text,
    callback_data: `giveaway:admin:${data}`,
  });
  const currencySymbol = draft.currency === "USD" ? "$" : "₹";
  if (draft.step === "amount") {
    await bot.sendMessage(
      chatId,
      `<b>New giveaway</b>\n\n${escapeTelegramText(giveawayDraftLabel(draft))}\n\nChoose a currency and prize amount.`,
      {
        inline_keyboard: [
          [button(`${draft.currency === "INR" ? "✓ " : ""}INR`, "currency:INR"), button(`${draft.currency === "USD" ? "✓ " : ""}USD`, "currency:USD")],
          [button(`${currencySymbol}50`, "amount:50"), button(`${currencySymbol}100`, "amount:100"), button(`${currencySymbol}250`, "amount:250")],
          [button(`${currencySymbol}500`, "amount:500"), button(`${currencySymbol}1,000`, "amount:1000"), button("Enter amount", "amount:custom")],
          [button("Cancel", "cancel")],
        ],
      },
    );
    return;
  }
  if (draft.step === "winners") {
    await bot.sendMessage(
      chatId,
      `<b>Choose winner count</b>\n\n${escapeTelegramText(giveawayDraftLabel(draft))}`,
      {
        inline_keyboard: [
          [button("All eligible users", "winners:0"), button("Top 3", "winners:3")],
          [button("Top 10", "winners:10"), button("Enter manually", "winners:custom")],
          [button("Back to amount", "back:amount"), button("Cancel", "cancel")],
        ],
      },
    );
    return;
  }
  if (draft.step === "referrals") {
    await bot.sendMessage(
      chatId,
      `<b>Minimum referrals</b>\n\n${escapeTelegramText(giveawayDraftLabel(draft))}`,
      {
        inline_keyboard: [
          [button("No minimum", "referrals:0"), button("1 referral", "referrals:1"), button("3 referrals", "referrals:3")],
          [button("Enter manually", "referrals:custom")],
          [button("Back to winners", "back:winners"), button("Cancel", "cancel")],
        ],
      },
    );
    return;
  }
  if (draft.step === "wager") {
    await bot.sendMessage(
      chatId,
      `<b>Minimum wager</b>\n\n${escapeTelegramText(giveawayDraftLabel(draft))}`,
      {
        inline_keyboard: [
          [button("No minimum", "wager:0"), button(`${currencySymbol}100`, "wager:10000"), button(`${currencySymbol}500`, "wager:50000")],
          [button("Enter manually", "wager:custom")],
          [button("Back to referrals", "back:referrals"), button("Cancel", "cancel")],
        ],
      },
    );
    return;
  }
  await bot.sendMessage(
    chatId,
    `<b>Giveaway duration</b>\n\n${escapeTelegramText(giveawayDraftLabel(draft))}`,
    {
      inline_keyboard: [
        [button("1 day", "duration:1"), button("7 days", "duration:7"), button("30 days", "duration:30")],
        [button("Enter manually", "duration:custom")],
        [button("Back to wager", "back:wager"), button("Cancel", "cancel")],
      ],
    },
  );
}

async function sendGiveawayAdminReview(
  bot: TelegramBot,
  chatId: number,
  adminId: number,
): Promise<void> {
  const draft = giveawayDrafts.get(adminId);
  if (!draft) return;
  await bot.sendMessage(
    chatId,
    `<b>Review giveaway</b>\n\n${escapeTelegramText(giveawayDraftLabel(draft))}\n\nPress Create when everything is correct.`,
    {
      inline_keyboard: [
        [{ text: "Create giveaway", callback_data: "giveaway:admin:save" }],
        [{ text: "Edit amount", callback_data: "giveaway:admin:back:amount" }, { text: "Edit winners", callback_data: "giveaway:admin:back:winners" }],
        [{ text: "Edit referrals", callback_data: "giveaway:admin:back:referrals" }, { text: "Edit wager", callback_data: "giveaway:admin:back:wager" }],
        [{ text: "Edit duration", callback_data: "giveaway:admin:back:duration" }, { text: "Cancel", callback_data: "giveaway:admin:cancel" }],
      ],
    },
  );
}

async function handleGiveawayAdminText(
  bot: TelegramBot,
  message: TelegramMessage,
  text: string,
): Promise<boolean> {
  if (!message.from) return false;
  const telegramUserId = message.from.id;
  const draft = giveawayDrafts.get(telegramUserId);
  if (!draft) return false;
  if (text.trim().toLowerCase() === "/cancel") {
    giveawayDrafts.delete(telegramUserId);
    await bot.sendMessage(message.chat.id, "Giveaway setup cancelled.");
    return true;
  }
  if (text.trim().startsWith("/")) return false;
  const value = text.trim();
  if (draft.step === "amount") {
    const amountMinor = parseMoney(value);
    if (!amountMinor) {
      await bot.sendMessage(message.chat.id, "Enter a valid positive amount, for example 100.");
      return true;
    }
    draft.amountMinor = amountMinor;
    draft.step = "winners";
  } else if (draft.step === "winners") {
    const winners = value.toLowerCase() === "all" ? 0 : Number(value);
    if (!Number.isInteger(winners) || winners < 0) {
      await bot.sendMessage(message.chat.id, "Enter a whole number of winners, or type all.");
      return true;
    }
    draft.maxWinners = winners;
    draft.step = "referrals";
  } else if (draft.step === "referrals") {
    const referrals = Number(value);
    if (!Number.isInteger(referrals) || referrals < 0) {
      await bot.sendMessage(message.chat.id, "Enter a whole number of minimum referrals.");
      return true;
    }
    draft.minReferralCount = referrals;
    draft.step = "wager";
  } else if (draft.step === "wager") {
    const wager = parseMoney(value);
    if (value !== "0" && !wager) {
      await bot.sendMessage(message.chat.id, "Enter a wager amount, or type 0 for no minimum.");
      return true;
    }
    draft.minWagerMinor = wager ?? 0;
    draft.step = "duration";
  } else {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1) {
      await bot.sendMessage(message.chat.id, "Enter a whole number of days.");
      return true;
    }
    draft.periodDays = days;
  }
  if (draft.periodDays) await sendGiveawayAdminReview(bot, message.chat.id, telegramUserId);
  else await sendGiveawayAdminStep(bot, message.chat.id, telegramUserId);
  return true;
}

async function sendGiveawayEditPanel(
  bot: TelegramBot,
  chatId: number,
): Promise<void> {
  const settings = await activeGiveawaySettings();
  if (!settings.length) {
    await bot.sendMessage(chatId, "<b>🎁 No active giveaways are available to edit.</b>");
    return;
  }
  const image = await giveawayOverviewPng(
    settings,
    "EDIT GIVEAWAY",
    "Select a prize pool. The old group announcement will be replaced after saving.",
  );
  await bot.sendPhoto(
    chatId,
    image,
    "<b>✏️ EDIT GIVEAWAY</b>\nChoose a giveaway to update its name, default prize pool, and first/second/third prizes.",
    {
      inline_keyboard: settings.map((settingsRow, index) => [{
        text: `✏️ Edit ${index + 1} · ${formatMoney(settingsRow.amountMinor, parseCurrency(settingsRow.currency, "INR"))}`,
        callback_data: `giveaway:admin:edit:${settingsRow.kind}`,
      }]),
    },
  );
}

async function sendGiveawayEditStep(
  bot: TelegramBot,
  chatId: number,
  adminId: number,
): Promise<void> {
  const draft = giveawayEditDrafts.get(adminId);
  if (!draft) return;
  const currency = draft.currency;
  const prompt = draft.step === "name"
    ? "Send the new giveaway name (up to 80 characters). Send <code>/skip</code> to keep the current name or <code>/clear</code> to use the default."
    : draft.step === "pool"
      ? `Send the default prize pool/reward in ${currency}, for example <code>1000</code>.`
      : `Send the ${draft.step} prize in ${currency}, or <code>0</code> to clear it.`;
  await bot.sendMessage(
    chatId,
    `<b>✏️ Edit giveaway</b>\n\n${prompt}\n\nSend <code>/cancel</code> to stop editing.`,
  );
}

async function sendGiveawayEditReview(
  bot: TelegramBot,
  chatId: number,
  adminId: number,
): Promise<void> {
  const draft = giveawayEditDrafts.get(adminId);
  if (!draft) return;
  await bot.sendMessage(
    chatId,
    [
      "<b>Review giveaway changes</b>",
      "",
      `Name: <b>${escapeTelegramText(draft.displayName || "default giveaway name")}</b>`,
      `Default prize pool/reward: <b>${formatMoney(draft.amountMinor ?? 0, draft.currency)}</b>`,
      `1st prize: <b>${giveawayEditValueText(draft.firstPrizeMinor, draft.currency)}</b>`,
      `2nd prize: <b>${giveawayEditValueText(draft.secondPrizeMinor, draft.currency)}</b>`,
      `3rd prize: <b>${giveawayEditValueText(draft.thirdPrizeMinor, draft.currency)}</b>`,
    ].join("\n"),
    {
      inline_keyboard: [
        [{ text: "✅ Save and republish", callback_data: "giveaway:admin:editsave" }],
        [{ text: "Cancel", callback_data: "giveaway:admin:editcancel" }],
      ],
    },
  );
}

function nextGiveawayEditStep(
  draft: GiveawayEditDraft,
): GiveawayEditStep | null {
  return draft.step === "name"
    ? "pool"
    : draft.step === "pool"
      ? "first"
      : draft.step === "first"
        ? "second"
        : draft.step === "second"
          ? "third"
          : null;
}

async function handleGiveawayEditText(
  bot: TelegramBot,
  message: TelegramMessage,
  text: string,
): Promise<boolean> {
  if (!message.from) return false;
  const draft = giveawayEditDrafts.get(message.from.id);
  if (!draft) return false;
  const value = text.trim();
  if (value.toLowerCase() === "/cancel") {
    giveawayEditDrafts.delete(message.from.id);
    await bot.sendMessage(message.chat.id, "Giveaway editing cancelled.");
    return true;
  }
  if (value.startsWith("/") && value.toLowerCase() !== "/skip" && value.toLowerCase() !== "/clear") {
    return false;
  }
  if (draft.step === "name") {
    if (value.toLowerCase() === "/skip") {
      // Keep the current value.
    } else {
      draft.displayName = value.toLowerCase() === "/clear" ? null : value.slice(0, 80);
      if (!draft.displayName && value.toLowerCase() !== "/clear") {
        await bot.sendMessage(message.chat.id, "Send a non-empty name, /skip, or /clear.");
        return true;
      }
    }
  } else {
    const parsed = value === "0" && draft.step !== "pool" ? 0 : parseMoney(value);
    if (draft.step === "pool") {
      if (!parsed || parsed < 1) {
        await bot.sendMessage(message.chat.id, "Send a positive prize pool/reward amount.");
        return true;
      }
      draft.amountMinor = parsed;
    } else {
      if (value !== "0" && (!parsed || parsed < 1)) {
        await bot.sendMessage(message.chat.id, "Send a positive prize amount, or 0 to clear it.");
        return true;
      }
      const prize = parsed === 0 ? null : parsed;
      if (draft.step === "first") draft.firstPrizeMinor = prize;
      if (draft.step === "second") draft.secondPrizeMinor = prize;
      if (draft.step === "third") draft.thirdPrizeMinor = prize;
    }
  }
  const next = nextGiveawayEditStep(draft);
  if (next) {
    draft.step = next;
    await sendGiveawayEditStep(bot, message.chat.id, message.from.id);
  } else {
    await sendGiveawayEditReview(bot, message.chat.id, message.from.id);
  }
  return true;
}

async function sendGiveawayAdminPanel(
  bot: TelegramBot,
  chatId: number,
  admin: TelegramUser,
): Promise<void> {
  const settings = await activeGiveawaySettings();
  const [claims, players] = await Promise.all([
    db.select().from(casinoGiveawayClaimsTable),
    db.select().from(casinoPlayersTable),
  ]);
  const playerNames = new Map(players.map((player) => [player.id, player.username ? `@${player.username}` : player.displayName]));
  const winnerNames = claims
    .filter((claim) => claim.selected)
    .slice(-8)
    .map((claim) => playerNames.get(claim.playerId) ?? `Player ${claim.playerId}`)
    .join(", ") || "—";
  const now = new Date();
  const completed = settings.filter((settingsRow) => settingsRow.nextDrawAt && settingsRow.nextDrawAt <= now).length;
  const active = settings.length - completed;
  const subtitle = [
    `Admin: ${admin.first_name ?? ""} ${admin.last_name ?? ""}`.trim(),
    `Started ${settings.length} · Completed ${completed} · Active ${active}`,
    `Winners: ${winnerNames}`,
  ].join(" · ");
  const image = await giveawayOverviewPng(settings, "ADMIN GIVEAWAY PANEL", subtitle);
  const keyboard: InlineKeyboardButton[][] = [
    [{ text: "＋ Create giveaway", callback_data: "giveaway:admin:new" }],
    ...settings.map((settingsRow, index) => [
      { text: `Manage ${index + 1}`, callback_data: `giveaway:select:${settingsRow.kind}` },
      { text: `✏️ Edit ${index + 1}`, callback_data: `giveaway:admin:edit:${settingsRow.kind}` },
      { text: `Disable ${index + 1}`, callback_data: `giveaway:admin:disable:${settingsRow.kind}` },
    ]),
    [{ text: "✏️ Edit a giveaway", callback_data: "giveaway:admin:editpanel" }],
    [{ text: "↻ Refresh panel", callback_data: "giveaway:admin:refresh" }],
  ];
  await bot.sendPhoto(chatId, image, undefined, { inline_keyboard: keyboard });
}

async function sendGiveawayCancelPanel(
  bot: TelegramBot,
  chatId: number,
): Promise<void> {
  const settings = await activeGiveawaySettings();
  if (!settings.length) {
    await bot.sendMessage(chatId, "<b>🎁 No active giveaways are available to cancel.</b>");
    return;
  }
  const image = await giveawayOverviewPng(
    settings,
    "CANCEL GIVEAWAY",
    "Choose a giveaway to disable and remove from the official group.",
  );
  const keyboard = {
    inline_keyboard: settings.map((settingsRow, index) => [{
      text: `❌ Cancel ${index + 1} · ${formatMoney(settingsRow.amountMinor, parseCurrency(settingsRow.currency, "INR"))}`,
      callback_data: `giveaway:admin:cancel:${settingsRow.kind}`,
    }]),
  };
  await bot.sendPhoto(
    chatId,
    image,
    "<b>⚠️ CANCEL GIVEAWAY</b>\nSelect one prize pool. The group announcement will be deleted and a pinned cancellation notice will be posted.",
    keyboard,
  );
}

async function deleteGiveawayAnnouncement(
  bot: TelegramBot,
  settings: GiveawaySetting,
): Promise<void> {
  const groupId = settings.announcementChatId ?? officialGroupChatId();
  if (groupId === null || !settings.announcementMessageId) return;
  try {
    await bot.unpinChatMessage(groupId, settings.announcementMessageId);
  } catch {
    // The announcement may already be unpinned.
  }
  try {
    await bot.deleteMessage(groupId, settings.announcementMessageId);
  } catch (error) {
    logger.debug({ err: error, kind: settings.kind }, "Giveaway announcement deletion failed");
  }
}

async function cancelConfiguredGiveaway(
  bot: TelegramBot,
  adminChatId: number,
  kind: string,
): Promise<void> {
  const [settings] = await db
    .select()
    .from(casinoGiveawaySettingsTable)
    .where(and(eq(casinoGiveawaySettingsTable.kind, kind), eq(casinoGiveawaySettingsTable.enabled, true)))
    .limit(1);
  if (!settings) {
    await bot.sendMessage(adminChatId, "That giveaway is no longer active.");
    return;
  }
  await db
    .update(casinoGiveawaySettingsTable)
    .set({ enabled: false, announcementMessageId: null, updatedAt: new Date() })
    .where(eq(casinoGiveawaySettingsTable.id, settings.id));
  const groupId = settings.announcementChatId ?? officialGroupChatId();
  await deleteGiveawayAnnouncement(bot, settings);
  if (groupId !== null) {
    const notice = await bot.sendMessage(
      groupId,
      `<b>🛑 ${giveawayLabel(settings, 0)} HAS BEEN CANCELED</b>\nThis giveaway has been canceled by an administrator. Its group announcement and join flow are no longer active.`,
    );
    try {
      await bot.pinChatMessage(groupId, notice.message_id);
    } catch (error) {
      logger.warn({ err: error, kind }, "Giveaway cancellation pin failed");
    }
    setTimeout(() => {
      void (async () => {
        try {
          await bot.unpinChatMessage(groupId, notice.message_id);
        } catch {
          // The cancellation notice may already be unpinned.
        }
        try {
          await bot.deleteMessage(groupId, notice.message_id);
        } catch {
          // Telegram may reject deletion after an admin changed permissions.
        }
      })();
    }, 30 * 60 * 1_000);
  }
  await bot.sendMessage(
    adminChatId,
    `<b>✅ ${giveawayLabel(settings, 0)} canceled.</b>\nThe group announcement was removed and the cancellation notice was pinned for 30 minutes.`,
  );
}

async function giveawayRankings(
  bot: TelegramBot,
  chatId: number,
  requestedSetting?: GiveawaySetting,
): Promise<void> {
  const activeSettings = await activeGiveawaySettings();
  if (!requestedSetting) {
    if (!activeSettings.length) {
      await bot.sendMessage(chatId, "<b>🎁 No ongoing giveaways.</b>\nThere is no active giveaway ranking to show.");
      return;
    }
    const image = await giveawayOverviewPng(
      activeSettings,
      "ONGOING GIVEAWAYS",
      "Select a prize pool below to view its live Top 10 leaderboard.",
    );
    await bot.sendPhoto(
      chatId,
      image,
      "<b>🏆 ONGOING GIVEAWAYS</b>\nChoose Giveaway 1, Giveaway 2, or another active prize pool to see its leaderboard.",
      giveawayRankSelectionKeyboard(activeSettings),
    );
    return;
  }
  const [setting] = activeSettings;
  const selectedSetting = requestedSetting &&
    activeSettings.some((candidate) => candidate.id === requestedSetting.id)
    ? requestedSetting
    : setting;
  const metricSettings = selectedSetting ?? {
    currency: "INR" as Currency,
    nextDrawAt: null,
    periodDays: 30,
  };
  const players = (await db.select().from(casinoPlayersTable)).filter(
    (player) => !isLeaderboardBot(player),
  );
  const rows = (
    await Promise.all(
      players.map(async (player) => {
        const metrics = await giveawayPlayerMetrics(player.id, metricSettings);
        return {
          player,
          ...metrics,
          wagerEligible: Boolean(
            selectedSetting && metrics.wagerMinor >= selectedSetting.minWagerMinor,
          ),
          referralEligible: Boolean(
            selectedSetting && metrics.referrals >= selectedSetting.minReferralCount,
          ),
        };
      }),
    )
  )
    .sort(
      (left, right) =>
        right.wagerMinor - left.wagerMinor ||
        right.referrals - left.referrals ||
        right.bets - left.bets,
    )
    .slice(0, 10)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const image = await giveawayRankingsPng(
    selectedSetting,
    rows.map((row) => ({
      rank: row.rank,
      name: row.player.username ? `@${row.player.username}` : row.player.displayName,
      wagerMinor: row.wagerMinor,
      referrals: row.referrals,
      bets: row.bets,
      messages: row.bets,
      points: row.referrals + row.bets * 0.5,
      wagerEligible: row.wagerEligible,
      referralEligible: row.referralEligible,
    })),
  );
  await bot.sendPhoto(
    chatId,
    image,
    selectedSetting
      ? `<b>🏆 ${escapeTelegramText(giveawayLabel(selectedSetting, 0))} RESULT · TOP 10 PLAYERS</b>\nTotal wager, messages, referrals, points, and condition status.`
      : "<b>🏆 GIVEAWAY RESULT · TOP 10 PLAYERS</b>\nNo active giveaway is configured; showing the top 10 player activity records.",
  );
}

async function handleGiveawayAdminAction(
  bot: TelegramBot,
  callback: TelegramCallbackQuery,
): Promise<boolean> {
  const message = callback.message;
  if (!message) {
    await bot.sendMessage(callback.from.id, "Giveaway admin controls are available only in a private DM.");
    return true;
  }
  if (!isPrivateChat(message.chat)) {
    await bot.sendMessage(message.chat.id, "Giveaway admin controls are available only in a private DM.");
    return true;
  }
  if (!isAdmin(callback.from.id)) {
    await bot.sendMessage(message?.chat.id ?? callback.from.id, ADMIN_RESTRICTED_MESSAGE);
    return true;
  }
  const parts = (callback.data ?? "").split(":");
  const action = parts[2];
  const value = parts.slice(3).join(":");
  const chatId = message.chat.id;
  if (action === "editpanel") {
    await sendGiveawayEditPanel(bot, chatId);
    return true;
  }
  if (action === "edit") {
    const [selected] = await db
      .select()
      .from(casinoGiveawaySettingsTable)
      .where(and(
        eq(casinoGiveawaySettingsTable.kind, value),
        eq(casinoGiveawaySettingsTable.enabled, true),
      ))
      .limit(1);
    if (!selected) {
      await bot.sendMessage(chatId, "That giveaway is no longer active.");
      return true;
    }
    giveawayEditDrafts.set(callback.from.id, {
      settingId: selected.id,
      kind: selected.kind,
      currency: parseCurrency(selected.currency, "INR"),
      step: "name",
      displayName: selected.displayName,
      amountMinor: selected.amountMinor,
      firstPrizeMinor: selected.firstPrizeMinor,
      secondPrizeMinor: selected.secondPrizeMinor,
      thirdPrizeMinor: selected.thirdPrizeMinor,
    });
    await sendGiveawayEditStep(bot, chatId, callback.from.id);
    return true;
  }
  if (action === "editcancel") {
    giveawayEditDrafts.delete(callback.from.id);
    await bot.sendMessage(chatId, "Giveaway editing cancelled.");
    return true;
  }
  if (action === "editsave") {
    const draft = giveawayEditDrafts.get(callback.from.id);
    if (!draft?.amountMinor) {
      await bot.sendMessage(chatId, "The giveaway edit is incomplete. Start /editgiveaway again.");
      return true;
    }
    const [selected] = await db
      .select()
      .from(casinoGiveawaySettingsTable)
      .where(and(
        eq(casinoGiveawaySettingsTable.id, draft.settingId),
        eq(casinoGiveawaySettingsTable.enabled, true),
      ))
      .limit(1);
    if (!selected) {
      giveawayEditDrafts.delete(callback.from.id);
      await bot.sendMessage(chatId, "That giveaway is no longer active.");
      return true;
    }
    await deleteGiveawayAnnouncement(bot, selected);
    await db
      .update(casinoGiveawaySettingsTable)
      .set({
        displayName: draft.displayName,
        amountMinor: draft.amountMinor,
        firstPrizeMinor: draft.firstPrizeMinor,
        secondPrizeMinor: draft.secondPrizeMinor,
        thirdPrizeMinor: draft.thirdPrizeMinor,
        announcementChatId: null,
        announcementMessageId: null,
        updatedByTelegramUserId: callback.from.id,
        updatedAt: new Date(),
      })
      .where(eq(casinoGiveawaySettingsTable.id, selected.id));
    const [saved] = await db
      .select()
      .from(casinoGiveawaySettingsTable)
      .where(eq(casinoGiveawaySettingsTable.id, selected.id))
      .limit(1);
    if (saved) await publishGiveawayAnnouncement(bot, saved);
    giveawayEditDrafts.delete(callback.from.id);
    await bot.sendMessage(chatId, "✅ Giveaway updated. The old group announcement was removed and a new one was published.");
    await sendGiveawayEditPanel(bot, chatId);
    return true;
  }
  if (action === "cancelpanel") {
    await sendGiveawayCancelPanel(bot, chatId);
    return true;
  }
  if (action === "cancel" && value) {
    await cancelConfiguredGiveaway(bot, chatId, value);
    await sendGiveawayCancelPanel(bot, chatId);
    return true;
  }
  if (action === "new") {
    giveawayDrafts.set(callback.from.id, { step: "amount", currency: "INR" });
    await sendGiveawayAdminStep(bot, chatId, callback.from.id);
    return true;
  }
  if (action === "cancel") {
    giveawayDrafts.delete(callback.from.id);
    await bot.sendMessage(chatId, "Giveaway setup cancelled.");
    return true;
  }
  if (action === "refresh") {
    await sendGiveawayAdminPanel(bot, chatId, callback.from);
    return true;
  }
  if (action === "disable") {
    const [selected] = await db
      .select()
      .from(casinoGiveawaySettingsTable)
      .where(eq(casinoGiveawaySettingsTable.kind, value))
      .limit(1);
    if (!selected) {
      await bot.sendMessage(chatId, "That giveaway no longer exists.");
      return true;
    }
    await db
      .update(casinoGiveawaySettingsTable)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(casinoGiveawaySettingsTable.id, selected.id));
    await bot.sendMessage(chatId, "Giveaway disabled.");
    await sendGiveawayAdminPanel(bot, chatId, callback.from);
    return true;
  }
  const draft = giveawayDrafts.get(callback.from.id);
  if (!draft) {
    await bot.sendMessage(chatId, "Press Create giveaway to start a new setup.");
    return true;
  }
  if (action === "currency" && isSupportedCurrency(value)) {
    draft.currency = value;
    await sendGiveawayAdminStep(bot, chatId, callback.from.id);
    return true;
  }
  if (action === "amount") {
    if (value === "custom") {
      draft.step = "amount";
      await bot.sendMessage(chatId, `Send the prize amount in ${draft.currency ?? "INR"} (for example 100).`);
      return true;
    }
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) {
      draft.amountMinor = Math.round(amount * 100);
      draft.step = "winners";
      await sendGiveawayAdminStep(bot, chatId, callback.from.id);
    }
    return true;
  }
  if (action === "winners") {
    if (value === "custom") {
      draft.step = "winners";
      await bot.sendMessage(chatId, "Send the winner count, or type all for every eligible user.");
      return true;
    }
    const winners = Number(value);
    if (Number.isInteger(winners) && winners >= 0) {
      draft.maxWinners = winners;
      draft.step = "referrals";
      await sendGiveawayAdminStep(bot, chatId, callback.from.id);
    }
    return true;
  }
  if (action === "referrals") {
    if (value === "custom") {
      draft.step = "referrals";
      await bot.sendMessage(chatId, "Send the minimum referral count.");
      return true;
    }
    const referrals = Number(value);
    if (Number.isInteger(referrals) && referrals >= 0) {
      draft.minReferralCount = referrals;
      draft.step = "wager";
      await sendGiveawayAdminStep(bot, chatId, callback.from.id);
    }
    return true;
  }
  if (action === "wager") {
    if (value === "custom") {
      draft.step = "wager";
      await bot.sendMessage(chatId, `Send the minimum wager in ${draft.currency ?? "INR"}, or 0 for no minimum.`);
      return true;
    }
    const wager = Number(value);
    if (Number.isFinite(wager) && wager >= 0) {
      draft.minWagerMinor = Math.round(wager);
      draft.step = "duration";
      await sendGiveawayAdminStep(bot, chatId, callback.from.id);
    }
    return true;
  }
  if (action === "duration") {
    if (value === "custom") {
      draft.step = "duration";
      await bot.sendMessage(chatId, "Send the giveaway duration in whole days.");
      return true;
    }
    const days = Number(value);
    if (Number.isInteger(days) && days > 0) {
      draft.periodDays = days;
      await sendGiveawayAdminReview(bot, chatId, callback.from.id);
    }
    return true;
  }
  if (action === "back") {
    if (["amount", "winners", "referrals", "wager", "duration"].includes(value)) {
      draft.step = value as GiveawayDraftStep;
      await sendGiveawayAdminStep(bot, chatId, callback.from.id);
    }
    return true;
  }
  if (action === "save") {
    if (
      !draft.amountMinor ||
      draft.maxWinners === undefined ||
      draft.minReferralCount === undefined ||
      draft.minWagerMinor === undefined ||
      !draft.periodDays ||
      !draft.currency
    ) {
      await bot.sendMessage(chatId, "Complete every giveaway setting before creating it.");
      return true;
    }
    const allSettings = await db.select().from(casinoGiveawaySettingsTable);
    const nextNumber = allSettings.reduce((highest, row) => {
      const match = row.kind.match(/^giveaway_(\d+)$/);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, allSettings.some((row) => row.kind === "giveaway") ? 1 : 0) + 1;
    await configureGiveaway(bot, chatId, callback.from.id, `giveaway_${nextNumber}`, {
      amountMinor: draft.amountMinor,
      currency: draft.currency,
      maxWinners: draft.maxWinners,
      minWagerMinor: draft.minWagerMinor,
      minReferralCount: draft.minReferralCount,
      periodDays: draft.periodDays,
    });
    giveawayDrafts.delete(callback.from.id);
    await sendGiveawayAdminPanel(bot, chatId, callback.from);
    return true;
  }
  return true;
}

async function handleGiveawayUpdate(
  bot: TelegramBot,
  update: TelegramUpdate,
): Promise<void> {
  if (update.callback_query) {
    const callbackData = update.callback_query.data ?? "";
    const isPublicHouseAction =
      callbackData.startsWith("house:") &&
      update.callback_query.message &&
      isGroupChat(update.callback_query.message.chat);
    const isPublicGiveawayAction =
      callbackData.startsWith("giveaway:select:") ||
      callbackData.startsWith("giveaway:join:") ||
      callbackData.startsWith("giveaway:rank:");
    if (
      update.callback_query.message &&
      !isPrivateChat(update.callback_query.message.chat) &&
      !(isPublicHouseAction || (isPublicGiveawayAction && isGroupChat(update.callback_query.message.chat)))
    ) {
      return;
    }
    await bot.answerCallback(update.callback_query.id);
    const callback = update.callback_query;
    const message = callback.message;
    if (!message) return;
    const parts = (callback.data ?? "").split(":");
    if (parts[0] === "house") {
      const royaleId = Number(parts[2]);
      if (!Number.isInteger(royaleId) || royaleId <= 0) {
        await bot.sendMessage(message.chat.id, "That House Royale button is invalid.");
        return;
      }
      if (parts[1] === "join") {
        try {
          await joinHouseRoyale(bot, message.chat.id, callback.from, royaleId);
        } catch (error) {
          logger.error({ err: error, royaleId, userId: callback.from.id }, "House Royale join callback failed");
          await bot.sendMessage(
            message.chat.id,
            "House Royale could not process that join button. Please use /joinroyale in the giveaway bot.",
          );
        }
      } else if (parts[1] === "info") {
        await houseRoyaleInfo(bot, message.chat.id, callback.from.id);
      } else if (parts[1] === "chance") {
        const playerId = Number(parts[3]);
        const chance = Number(parts[4]);
        if (parts[4] !== "show") {
          await setHouseRoyaleWinChance(bot, callback, royaleId, playerId, chance);
        }
      } else if (parts[1] === "draw") {
        if (!isAdmin(callback.from.id)) {
          await bot.sendMessage(message.chat.id, ADMIN_RESTRICTED_MESSAGE);
          return;
        }
        await drawHouseRoyale(bot, royaleId);
      } else if (parts[1] === "cancel") {
        if (!isAdmin(callback.from.id)) {
          await bot.sendMessage(message.chat.id, ADMIN_RESTRICTED_MESSAGE);
          return;
        }
        await cancelHouseRoyale(bot, message.chat.id, royaleId);
      }
      return;
    }
    if (parts[0] !== "giveaway") return;
    if (parts[1] === "admin") {
      await handleGiveawayAdminAction(bot, callback);
      return;
    }
    const settings = await activeGiveawaySettings();
    const selectedKind = parts[2];
    const selected = settings.find((settingsRow) => settingsRow.kind === selectedKind);
    if (!selected) {
      await bot.sendMessage(message.chat.id, "That giveaway is no longer active.");
      return;
    }
    if (parts[1] === "rank") {
      await giveawayRankings(bot, message.chat.id, selected);
    } else if (parts[1] === "select") {
      await sendGiveawayRequirements(
        bot,
        message.chat.id,
        selected,
        Math.max(0, settings.indexOf(selected)),
        callback.from,
        message,
      );
    } else if (parts[1] === "join") {
      await joinGiveaway(
        bot,
        message.chat.id,
        callback.from,
        selected,
        Math.max(0, settings.indexOf(selected)),
        message,
      );
    }
    return;
  }
  const message = update.message;
  if (!message?.from || !message.text) return;
  if (!message.text.trim().startsWith("/")) return;
  const { command, args } = commandFrom(message.text);
  const giveawayCommands = new Set([
    "start",
    "help",
    "giveawayhelp",
    "join",
    "latest",
    "giveawayrank",
    "givewayrank",
    "rank",
    "giveaway_rank",
    "giveawayadd",
    "givewayadd",
    "giveawayoff",
    "cancelgiveaway",
    "editgiveaway",
    "hr",
    "royale",
    "houseroyale",
    "joinroyale",
    "hrinfo",
    "organize",
    "house",
    "hb",
  ]);
  if (!giveawayCommands.has(command)) return;
  const publicGiveawayCommands = new Set([
    "help",
    "giveawayhelp",
    "latest",
    "join",
    "giveawayrank",
    "givewayrank",
    "rank",
    "giveaway_rank",
    "hr",
    "royale",
    "houseroyale",
    "joinroyale",
    "hrinfo",
  ]);
  if (!isPrivateChat(message.chat) && !publicGiveawayCommands.has(command)) return;
  if (isPrivateChat(message.chat)) {
    if (await handleGiveawayEditText(bot, message, message.text)) return;
    if (await handleGiveawayAdminText(bot, message, message.text)) return;
  }
  if (command === "start" && isAdmin(message.from.id)) {
    await sendGiveawayAdminPanel(bot, message.chat.id, message.from);
    return;
  }
  if (command === "giveawayhelp" || command === "help" || command === "start") {
    await bot.sendMessage(
      message.chat.id,
      [
        "<b>🎁 GIVEAWAY BOT</b>",
        "",
        "<b>/latest</b> — show the latest giveaway",
        "<b>/join</b> — join the latest giveaway",
         "<b>/giveawayrank</b> or <b>/rank</b> — view the top 10 player ranking image with wager, messages, referrals, points, and conditions",
         "<b>/cancelgiveaway</b> — cancel an active giveaway (admins only, private DM)",
         "<b>/editgiveaway</b> — edit an active giveaway name and prize tiers (admins only, private DM)",
         "<b>/royale</b> — show the active House Royale",
         "<b>/joinroyale</b> — join the active House Royale",
         "<b>/hrinfo</b> — show the latest House Royale players and admin chance controls",
         "<b>/organize PRIZEPOOL TIME MINWAGER</b> — organize an 8-player House Royale (admins)",
        "",
        "Giveaway settings are managed from the main RolexCasino bot.",
      ].join("\n"),
    );
    return;
  }
  if (command === "latest") {
    await sendLatestGiveaway(bot, message.chat.id);
    return;
  }
  if (command === "organize" || command === "hr" || command === "royale" || command === "houseroyale") {
    if ((command === "organize" || command === "hr") && args.length > 0) {
      if (!isAdmin(message.from.id)) {
        await bot.sendMessage(message.chat.id, ADMIN_RESTRICTED_MESSAGE);
        return;
      }
      await createHouseRoyale(bot, message.chat.id, message.from.id, args);
      return;
    }
    await sendHouseRoyale(bot, message.chat.id, await activeHouseRoyale(), message.from.id);
    return;
  }
  if (command === "joinroyale") {
    const royale = await activeHouseRoyale();
    if (royale) {
      await joinHouseRoyale(bot, message.chat.id, message.from, royale.id);
    } else {
      await bot.sendMessage(message.chat.id, "No House Royale is open right now.");
    }
    return;
  }
  if (command === "hrinfo") {
    await houseRoyaleInfo(bot, message.chat.id, message.from.id);
    return;
  }
  if (command === "join") {
    const settings = await activeGiveawaySettings();
    if (settings[0]) await joinGiveaway(bot, message.chat.id, message.from, settings[0]);
    else await bot.sendMessage(message.chat.id, "<b>🎁 No active giveaway right now.</b>\nPlease check again soon.");
    return;
  }
  if (
    command === "giveawayrank" ||
    command === "givewayrank" ||
    command === "rank" ||
    command === "giveaway_rank"
  ) {
    await giveawayRankings(bot, message.chat.id);
    return;
  }
  if (command === "giveawayadd" || command === "givewayadd") {
    if (!isAdmin(message.from.id)) {
      await bot.sendMessage(message.chat.id, ADMIN_RESTRICTED_MESSAGE);
      return;
    }
    await sendGiveawayAdminPanel(bot, message.chat.id, message.from);
    return;
  }
  if (command === "giveawayoff") {
    if (!isAdmin(message.from.id)) {
      await bot.sendMessage(message.chat.id, ADMIN_RESTRICTED_MESSAGE);
      return;
    }
    await sendGiveawayAdminPanel(bot, message.chat.id, message.from);
    return;
  }
  if (command === "cancelgiveaway") {
    if (!isAdmin(message.from.id)) {
      await bot.sendMessage(message.chat.id, ADMIN_RESTRICTED_MESSAGE);
      return;
    }
    await sendGiveawayCancelPanel(bot, message.chat.id);
    return;
  }
  if (command === "editgiveaway") {
    if (!isAdmin(message.from.id)) {
      await bot.sendMessage(message.chat.id, ADMIN_RESTRICTED_MESSAGE);
      return;
    }
    await sendGiveawayEditPanel(bot, message.chat.id);
    return;
  }
  if (command === "houseroyale" || command === "house" || command === "hb") {
    await sendHouseBalance(bot, message.chat.id, message.from.id);
    return;
  }
  if (command === "setdaily" || command === "setweekly" || command === "setmin" || command === "setminimum") {
    await handleAdminCommand(bot, message.chat.id, message.from.id, command, args, message);
    return;
  }
  if (
    command === "monthlybonus" ||
    command === "multiday" ||
    command === "setmultiday" ||
    command === "rakeback" ||
    command === "setrefer" ||
    command === "setgiveway"
  ) {
    const requestedKind: GiveawayKind =
      command === "monthlybonus"
        ? "monthly"
        : command === "rakeback"
          ? "rakeback"
          : command === "setrefer"
            ? "referral"
            : command === "multiday" || command === "setmultiday"
              ? "multi_day"
              : "giveaway";
    if (args.length === 0) {
      if (requestedKind === "monthly") {
        await sendMonthlyBonusStatus(
          bot,
          message.chat.id,
          await ensurePlayer(message.from),
        );
      } else {
        await sendGiveawaySettings(bot, message.chat.id, requestedKind);
      }
      return;
    }
    if (!isAdmin(message.from.id)) {
      await bot.sendMessage(message.chat.id, ADMIN_RESTRICTED_MESSAGE);
      return;
    }
    const amountMinor = parseMoney(args[0]);
    if (requestedKind === "rakeback") {
      const rate = Number.parseFloat(args[0]?.replace("%", "") ?? "");
      const minWagerMinor = parseMoney(args[1]);
      const periodDays = Number(args[2]);
      const currency = parseCurrency(args[3], "INR");
      if (
        !Number.isFinite(rate) ||
        rate <= 0 ||
        rate > 100 ||
        !minWagerMinor ||
        !Number.isInteger(periodDays) ||
        periodDays < 1 ||
        !isSupportedCurrency(currency)
      ) {
        await bot.sendMessage(message.chat.id, "<b>Usage:</b> <code>/rakeback RATE% MIN_WAGER DAYS INR|USD</code>");
        return;
      }
      await configureGiveaway(bot, message.chat.id, message.from.id, requestedKind, {
        amountMinor: Math.round(rate * 100),
        currency,
        maxWinners: 0,
        minWagerMinor,
        periodDays,
      });
      return;
    }
    if (requestedKind === "referral") {
      const maxWinners = Number(args[0]);
      const referralAmountMinor = parseMoney(args[1]);
      const currency = parseCurrency(args[2], "INR");
      if (!Number.isInteger(maxWinners) || maxWinners < 1 || !referralAmountMinor || !isSupportedCurrency(currency)) {
        await bot.sendMessage(message.chat.id, "<b>Usage:</b> <code>/setrefer PLACE AMOUNT INR|USD</code>");
        return;
      }
      await configureGiveaway(bot, message.chat.id, message.from.id, requestedKind, {
        amountMinor: referralAmountMinor,
        currency,
        maxWinners,
        minWagerMinor: 0,
        periodDays: 30,
      });
      return;
    }
    const maxWinners = Number(args[1]);
    const daysIndex = requestedKind === "monthly" ? 2 : 2;
    const periodDays = Number(args[daysIndex]);
    const minWagerIndex = requestedKind === "monthly" ? 3 : 3;
    const maybeMinWager = requestedKind === "monthly" ? 0 : parseMoney(args[minWagerIndex]);
    const currency = parseCurrency(
      requestedKind === "monthly" ? args[3] : args[4],
      "INR",
    );
    if (
      !amountMinor ||
      !Number.isInteger(maxWinners) ||
      maxWinners < 1 ||
      !Number.isInteger(periodDays) ||
      periodDays < 1 ||
      (requestedKind !== "monthly" && !maybeMinWager) ||
      !isSupportedCurrency(currency)
    ) {
      await bot.sendMessage(
        message.chat.id,
        requestedKind === "monthly"
          ? "<b>Usage:</b> <code>/monthlybonus AMOUNT MAX_WINNERS DAYS INR|USD</code>"
          : "<b>Usage:</b> <code>/multiday AMOUNT MAX_WINNERS DAYS MIN_WAGER INR|USD</code>",
      );
      return;
    }
    await configureGiveaway(bot, message.chat.id, message.from.id, requestedKind, {
      amountMinor,
      currency,
      maxWinners,
      minWagerMinor: maybeMinWager ?? 0,
      periodDays,
    });
  }
}

export async function startRolexCasinoBots(): Promise<void> {
  const mainToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!mainToken) {
    logger.warn("TELEGRAM_BOT_TOKEN is not configured; RolexCasino bots are disabled");
    return;
  }
  void refreshDisplayRates();
  setInterval(() => {
    void refreshDisplayRates();
  }, 60 * 60 * 1_000);

  const mainBot = new TelegramBot({ label: "main-bot", token: mainToken });
  const helpers: TelegramBot[] = [];

  try {
    await mainBot.preparePolling();
    await mainBot.initialize();
    await mainBot.setCommands(MAIN_BOT_COMMANDS);
    await loadPremiumEmojiPack(mainBot);
    activeMainBot = mainBot;
    void recoverRecentEscrowCardDeletions(mainBot);
  } catch (error) {
    logger.error({ err: error }, "RolexCasino main bot initialization failed");
    return;
  }

  for (const config of helperConfigs.filter((candidate) => candidate.token)) {
    const helper = new TelegramBot(config);
    try {
      await helper.preparePolling();
      await helper.initialize();
      helpers.push(helper);
    } catch (error) {
      logger.error(
        { err: error, bot: config.label },
        "RolexCasino helper bot initialization failed; main bot will continue",
      );
    }
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
  logger.info("RolexCasino recovering active battle timers");
  await recoverPvbBattleTimeouts(mainBot);
  logger.info("RolexCasino active battle timers recovered");
  void drawDueJackpots(mainBot).catch((error) => {
    logger.error({ err: error }, "Daily jackpot draw failed");
  });
  setInterval(() => {
    void drawDueJackpots(mainBot).catch((error) => {
      logger.error({ err: error }, "Daily jackpot draw failed");
    });
  }, 30_000);
  void distributeDueRewards(mainBot);
  setInterval(() => {
    void distributeDueRewards(mainBot);
  }, 60_000);

  void mainBot.start((bot, update) =>
    handleMainUpdate(bot, update, helperLinks, helperBotsByGame),
  );
  for (const helper of helpers) {
    void helper.start((helperBot, update) =>
      handleHelperUpdate(helperBot, update, mainBot),
    );
  }

  const giveawayToken = process.env.TELEGRAM_GIVEAWAY_BOT_TOKEN ?? "";
  if (giveawayToken) {
    logger.info("RolexCasino starting giveaway bot");
    const giveawayBot = new TelegramBot({
      label: "giveaway-bot",
      token: giveawayToken,
    });
    void (async () => {
      try {
        await giveawayBot.initialize();
        activeGiveawayBot = giveawayBot;
        await Promise.race([
          giveawayBot.preparePolling(),
          wait(5_000).then(() => {
            throw new Error("giveaway webhook cleanup exceeded 5 seconds");
          }),
        ]).catch((error) => {
          logger.warn(
            { err: error, bot: "giveaway-bot" },
            "Giveaway webhook cleanup did not finish quickly; starting polling anyway",
          );
        });
        void syncOpenHouseRoyales(giveawayBot).catch((error) => {
          logger.error({ err: error }, "House Royale live eligibility sync failed");
        });
        setInterval(() => {
          void syncOpenHouseRoyales(giveawayBot).catch((error) => {
            logger.error({ err: error }, "House Royale live eligibility sync failed");
          });
        }, 60_000);
        await giveawayBot.setCommands([
          { command: "start", description: "Open the giveaway panel" },
          { command: "latest", description: "Show active giveaways" },
          { command: "join", description: "Join the latest giveaway" },
          { command: "giveawayrank", description: "Show top 10 player ranking image" },
          { command: "cancelgiveaway", description: "Cancel an active giveaway (admins)" },
          { command: "editgiveaway", description: "Edit an active giveaway (admins)" },
          { command: "royale", description: "Show the active House Royale" },
          { command: "joinroyale", description: "Join the active House Royale" },
          { command: "hrinfo", description: "Show latest House Royale players and chances" },
          { command: "organize", description: "Organize an 8-player House Royale (admins)" },
          { command: "hr", description: "Host House Royale (admins)" },
        ]);
        void giveawayBot.start(handleGiveawayUpdate);
      } catch (error) {
        logger.error(
          { err: error, bot: "giveaway-bot" },
          "RolexCasino giveaway bot initialization failed; main bot will continue",
        );
      }
    })();
  }

  logger.info(
    { helpers: helpers.map((helper) => helper.label) },
    "RolexCasino main and helper polling started",
  );
}