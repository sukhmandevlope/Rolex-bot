import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  bigint,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const casinoPlayersTable = pgTable("casino_players", {
  id: serial("id").primaryKey(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" })
    .notNull()
    .unique(),
    isBot: boolean("is_bot").notNull().default(false),
    language: varchar("language", { length: 8 }).notNull().default("en"),
  username: text("username").unique(),
  displayName: text("display_name").notNull(),
  preferredCurrency: varchar("preferred_currency", { length: 3 })
    .notNull()
    .default("USD"),
    payoutWallet: text("payout_wallet"),
    payoutWalletType: varchar("payout_wallet_type", { length: 20 }),
    referralCode: varchar("referral_code", { length: 40 }),
    referredByPlayerId: integer("referred_by_player_id"),
    referralEarningsMinor: integer("referral_earnings_minor")
      .notNull()
      .default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const casinoDailyBonusSettingsTable = pgTable(
  "casino_daily_bonus_settings",
  {
    id: serial("id").primaryKey(),
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("INR"),
    eligibleUsers: integer("eligible_users").notNull().default(0),
    updatedByTelegramUserId: bigint("updated_by_telegram_user_id", {
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    nextDistributionAt: timestamp("next_distribution_at", {
      withTimezone: true,
    }),
  },
);

export const casinoWeeklyBonusSettingsTable = pgTable(
  "casino_weekly_bonus_settings",
  {
    id: serial("id").primaryKey(),
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("INR"),
    eligibleUsers: integer("eligible_users").notNull().default(0),
    updatedByTelegramUserId: bigint("updated_by_telegram_user_id", {
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    nextDistributionAt: timestamp("next_distribution_at", {
      withTimezone: true,
    }),
  },
);

export const casinoGiveawaySettingsTable = pgTable(
  "casino_giveaway_settings",
  {
    id: serial("id").primaryKey(),
    kind: varchar("kind", { length: 24 }).notNull().unique(),
    announcementChatId: bigint("announcement_chat_id", { mode: "number" }),
    announcementMessageId: integer("announcement_message_id"),
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("INR"),
    maxWinners: integer("max_winners").notNull().default(1),
    minWagerMinor: integer("min_wager_minor").notNull().default(0),
    minReferralCount: integer("min_referral_count").notNull().default(0),
    periodDays: integer("period_days").notNull().default(1),
    enabled: boolean("enabled").notNull().default(false),
    updatedByTelegramUserId: bigint("updated_by_telegram_user_id", {
      mode: "number",
    }),
    nextDrawAt: timestamp("next_draw_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export const casinoGiveawayClaimsTable = pgTable(
  "casino_giveaway_claims",
  {
    id: serial("id").primaryKey(),
    kind: varchar("kind", { length: 24 }).notNull(),
    periodKey: varchar("period_key", { length: 80 }).notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    selected: boolean("selected").notNull().default(false),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    giveawayPlayerPeriodUnique: unique("casino_giveaway_claim_player_period_unique").on(
      table.kind,
      table.periodKey,
      table.playerId,
    ),
  }),
);

export const casinoHouseRoyalesTable = pgTable(
  "casino_house_royales",
  {
    id: serial("id").primaryKey(),
    chatId: bigint("chat_id", { mode: "number" }),
    announcementMessageId: integer("announcement_message_id"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    entryAmountMinor: integer("entry_amount_minor").notNull(),
    maxPlayers: integer("max_players").notNull(),
    prizePoolMinor: integer("prize_pool_minor").notNull(),
    minWagerMinor: integer("min_wager_minor").notNull(),
    wagerPeriodDays: integer("wager_period_days").notNull().default(30),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    joinDeadlineAt: timestamp("join_deadline_at", { withTimezone: true }),
    bracketState: text("bracket_state"),
    createdByTelegramUserId: bigint("created_by_telegram_user_id", {
      mode: "number",
    }).notNull(),
    fairId: varchar("fair_id", { length: 80 }).notNull(),
    winnerOneMinor: integer("winner_one_minor").notNull().default(0),
    winnerTwoMinor: integer("winner_two_minor").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    drawnAt: timestamp("drawn_at", { withTimezone: true }),
  },
);

export const casinoHouseRoyalePlayersTable = pgTable(
  "casino_house_royale_players",
  {
    id: serial("id").primaryKey(),
    royaleId: integer("royale_id")
      .notNull()
      .references(() => casinoHouseRoyalesTable.id),
    dmChatId: bigint("dm_chat_id", { mode: "number" }),
    dmMessageId: integer("dm_message_id"),
    eligibilityConfirmedAt: timestamp("eligibility_confirmed_at", {
      withTimezone: true,
    }),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    entryAmountMinor: integer("entry_amount_minor").notNull(),
    selected: boolean("selected").notNull().default(false),
    placement: integer("placement"),
    payoutMinor: integer("payout_minor").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    royalePlayerUnique: unique("casino_house_royale_player_unique").on(
      table.royaleId,
      table.playerId,
    ),
  }),
);

export const casinoBonusClaimsTable = pgTable(
  "casino_bonus_claims",
  {
    id: serial("id").primaryKey(),
    kind: varchar("kind", { length: 10 }).notNull(),
    periodKey: varchar("period_key", { length: 80 }).notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    currency: varchar("currency", { length: 3 }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    selected: boolean("selected").notNull().default(false),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    bonusPlayerPeriodUnique: unique("casino_bonus_claim_player_period_unique").on(
      table.kind,
      table.periodKey,
      table.playerId,
    ),
  }),
);

export const casinoGameBetSettingsTable = pgTable(
  "casino_game_bet_settings",
  {
    id: serial("id").primaryKey(),
    gameType: varchar("game_type", { length: 40 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    minimumBetMinor: integer("minimum_bet_minor").notNull(),
    updatedByTelegramUserId: bigint("updated_by_telegram_user_id", {
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    gameCurrencyUnique: unique("casino_game_bet_setting_game_currency_unique").on(
      table.gameType,
      table.currency,
    ),
  }),
);

export const casinoWalletsTable = pgTable(
  "casino_wallets",
  {
    id: serial("id").primaryKey(),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    currency: varchar("currency", { length: 3 }).notNull(),
    balanceMinor: integer("balance_minor").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    playerCurrencyUnique: unique("casino_wallet_player_currency_unique").on(
      table.playerId,
      table.currency,
    ),
  }),
);

export const casinoHouseWalletsTable = pgTable(
  "casino_house_wallets",
  {
    id: serial("id").primaryKey(),
    currency: varchar("currency", { length: 3 }).notNull(),
    balanceMinor: integer("balance_minor").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    currencyUnique: unique("casino_house_wallet_currency_unique").on(
      table.currency,
    ),
  }),
);

export const casinoLedgerEntriesTable = pgTable("casino_ledger_entries", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id")
    .notNull()
    .references(() => casinoWalletsTable.id),
  transactionId: text("transaction_id").notNull(),
  entryType: varchar("entry_type", { length: 40 }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const casinoGameRoundsTable = pgTable("casino_game_rounds", {
  id: serial("id").primaryKey(),
  playerId: integer("player_id")
    .notNull()
    .references(() => casinoPlayersTable.id),
  helperBot: varchar("helper_bot", { length: 40 }).notNull(),
  gameType: varchar("game_type", { length: 40 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  stakeMinor: integer("stake_minor").notNull(),
  rollValue: integer("roll_value").notNull(),
  outcome: varchar("outcome", { length: 40 }).notNull(),
  payoutMinor: integer("payout_minor").notNull().default(0),
  fairId: varchar("fair_id", { length: 24 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const casinoDailyLossRewardsTable = pgTable(
  "casino_daily_loss_rewards",
  {
    id: serial("id").primaryKey(),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    dayKey: varchar("day_key", { length: 10 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    lossMinor: integer("loss_minor").notNull().default(0),
    rewardMinor: integer("reward_minor").notNull().default(0),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    playerDayCurrencyUnique: unique(
      "casino_daily_loss_reward_player_day_currency_unique",
    ).on(table.playerId, table.dayKey, table.currency),
  }),
);

export const casinoCashRequestsTable = pgTable("casino_cash_requests", {
  id: serial("id").primaryKey(),
  playerId: integer("player_id")
    .notNull()
    .references(() => casinoPlayersTable.id),
  requestType: varchar("request_type", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  feeMinor: integer("fee_minor").notNull().default(0),
  fairId: varchar("fair_id", { length: 24 }),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

export const casinoCryptoTipsTable = pgTable("casino_crypto_tips", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  transactionId: text("transaction_id").notNull().unique(),
  playerId: integer("player_id")
    .notNull()
    .references(() => casinoPlayersTable.id),
  senderTelegramUserId: bigint("sender_telegram_user_id", { mode: "number" }).notNull(),
  senderUsername: text("sender_username"),
  recipientUsername: text("recipient_username").notNull(),
  token: varchar("token", { length: 24 }).notNull(),
  network: varchar("network", { length: 24 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  grossAmountMinor: integer("gross_amount_minor").notNull(),
  feeMinor: integer("fee_minor").notNull().default(0),
  creditedAmountMinor: integer("credited_amount_minor").notNull(),
  confirmations: integer("confirmations").notNull().default(0),
  isRisky: boolean("is_risky").notNull().default(false),
  flashDetected: boolean("flash_detected").notNull().default(false),
  status: varchar("status", { length: 20 }).notNull().default("credited"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export const casinoWagerRequirementsTable = pgTable(
  "casino_wager_requirements",
  {
    id: serial("id").primaryKey(),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    currency: varchar("currency", { length: 3 }).notNull(),
    requiredMinor: integer("required_minor").notNull().default(0),
    completedMinor: integer("completed_minor").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    playerCurrencyUnique: unique("casino_wager_player_currency_unique").on(
      table.playerId,
      table.currency,
    ),
  }),
);

export const casinoEscrowsTable = pgTable("casino_escrows", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 24 }).notNull().unique(),
  fairId: varchar("fair_id", { length: 24 }),
  senderPlayerId: integer("sender_player_id")
    .notNull()
    .references(() => casinoPlayersTable.id),
  recipientPlayerId: integer("recipient_player_id")
    .notNull()
    .references(() => casinoPlayersTable.id),
  currency: varchar("currency", { length: 3 }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  feeMinor: integer("fee_minor").notNull(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  messageId: integer("message_id"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  senderCancelRequestedAt: timestamp("sender_cancel_requested_at", {
    withTimezone: true,
  }),
  recipientCancelRequestedAt: timestamp("recipient_cancel_requested_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const casinoPromoCodesTable = pgTable("casino_promo_codes", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  currency: varchar("currency", { length: 3 }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  maxClaims: integer("max_claims").notNull().default(1),
  claimedCount: integer("claimed_count").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const casinoPromoClaimsTable = pgTable(
  "casino_promo_claims",
  {
    id: serial("id").primaryKey(),
    promoCodeId: integer("promo_code_id")
      .notNull()
      .references(() => casinoPromoCodesTable.id),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    playerPromoUnique: unique("casino_promo_claim_player_unique").on(
      table.promoCodeId,
      table.playerId,
    ),
  }),
);

export const casinoChallengesTable = pgTable("casino_challenges", {
  id: serial("id").primaryKey(),
  creatorPlayerId: integer("creator_player_id")
    .notNull()
    .references(() => casinoPlayersTable.id),
  mode: varchar("mode", { length: 10 }).notNull().default("pvb"),
  playerTwoId: integer("player_two_id"),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  messageId: integer("message_id"),
  gameType: varchar("game_type", { length: 40 }).notNull(),
  emoji: varchar("emoji", { length: 8 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  stakeMinor: integer("stake_minor").notNull(),
  rounds: integer("rounds").notNull().default(1),
  rollsPerRound: integer("rolls_per_round").notNull().default(1),
  targetWins: integer("target_wins"),
  resultRule: varchar("result_rule", { length: 12 }).notNull().default("high"),
  fairId: varchar("fair_id", { length: 24 }),
  playerOneScore: integer("player_one_score").notNull().default(0),
  playerTwoScore: integer("player_two_score").notNull().default(0),
  winnerPlayerId: integer("winner_player_id"),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  turnDeadlineAt: timestamp("turn_deadline_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const casinoChallengeRollsTable = pgTable(
  "casino_challenge_rolls",
  {
    id: serial("id").primaryKey(),
    challengeId: integer("challenge_id")
      .notNull()
      .references(() => casinoChallengesTable.id),
    actorType: varchar("actor_type", { length: 20 }).notNull(),
    actorKey: varchar("actor_key", { length: 40 }).notNull(),
    playerId: integer("player_id").references(() => casinoPlayersTable.id),
    round: integer("round").notNull(),
    rollIndex: integer("roll_index").notNull(),
    emoji: varchar("emoji", { length: 8 }).notNull(),
    value: integer("value").notNull(),
    messageId: integer("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    challengeActorRollUnique: unique(
      "casino_challenge_actor_roll_unique",
    ).on(
      table.challengeId,
      table.actorType,
      table.actorKey,
      table.round,
      table.rollIndex,
    ),
  }),
);

export const casinoChallengeParticipantsTable = pgTable(
  "casino_challenge_participants",
  {
    id: serial("id").primaryKey(),
    challengeId: integer("challenge_id")
      .notNull()
      .references(() => casinoChallengesTable.id),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    roundsPlayed: integer("rounds_played").notNull().default(0),
    totalPayoutMinor: integer("total_payout_minor").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    challengePlayerUnique: unique("casino_challenge_player_unique").on(
      table.challengeId,
      table.playerId,
    ),
  }),
);

export const casinoJackpotsTable = pgTable(
  "casino_jackpots",
  {
    id: serial("id").primaryKey(),
    dayKey: varchar("day_key", { length: 10 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    poolMinor: integer("pool_minor").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    winnerPlayerId: integer("winner_player_id"),
    drawAt: timestamp("draw_at", { withTimezone: true }).notNull(),
    drawnAt: timestamp("drawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dayCurrencyUnique: unique("casino_jackpot_day_currency_unique").on(
      table.dayKey,
      table.currency,
    ),
  }),
);

export const casinoJackpotParticipantsTable = pgTable(
  "casino_jackpot_participants",
  {
    id: serial("id").primaryKey(),
    jackpotId: integer("jackpot_id")
      .notNull()
      .references(() => casinoJackpotsTable.id),
    playerId: integer("player_id")
      .notNull()
      .references(() => casinoPlayersTable.id),
    contributionMinor: integer("contribution_minor").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    jackpotPlayerUnique: unique("casino_jackpot_player_unique").on(
      table.jackpotId,
      table.playerId,
    ),
  }),
);

export const insertCasinoPlayerSchema = createInsertSchema(
  casinoPlayersTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCasinoPlayer = z.infer<typeof insertCasinoPlayerSchema>;
export type CasinoPlayer = typeof casinoPlayersTable.$inferSelect;
export type CasinoWallet = typeof casinoWalletsTable.$inferSelect;
export type CasinoLedgerEntry = typeof casinoLedgerEntriesTable.$inferSelect;
export type CasinoGameRound = typeof casinoGameRoundsTable.$inferSelect;
export type CasinoDailyLossReward =
  typeof casinoDailyLossRewardsTable.$inferSelect;
export type CasinoCashRequest = typeof casinoCashRequestsTable.$inferSelect;
export type CasinoCryptoTip = typeof casinoCryptoTipsTable.$inferSelect;
export type CasinoWagerRequirement =
  typeof casinoWagerRequirementsTable.$inferSelect;
export type CasinoEscrow = typeof casinoEscrowsTable.$inferSelect;
export type CasinoPromoCode = typeof casinoPromoCodesTable.$inferSelect;
export type CasinoChallenge = typeof casinoChallengesTable.$inferSelect;
export type CasinoChallengeRoll = typeof casinoChallengeRollsTable.$inferSelect;