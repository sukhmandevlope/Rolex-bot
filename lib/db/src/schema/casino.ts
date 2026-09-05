import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const casinoUsers = pgTable("casino_users", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name").notNull(),
  balance: numeric("balance", { precision: 18, scale: 2 }).notNull().default("1000"),
  gamesPlayed: integer("games_played").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  totalWagered: numeric("total_wagered", { precision: 18, scale: 2 }).notNull().default("0"),
  banned: boolean("banned").notNull().default(false),
  referredBy: bigint("referred_by", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casinoLedger = pgTable("casino_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  type: text("type").notNull(),
  reference: text("reference"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casinoMatches = pgTable("casino_matches", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  creatorId: bigint("creator_id", { mode: "number" }).notNull(),
  opponentId: bigint("opponent_id", { mode: "number" }),
  game: text("game").notNull(),
  stake: numeric("stake", { precision: 18, scale: 2 }).notNull(),
  status: text("status").notNull().default("waiting"),
  winnerId: bigint("winner_id", { mode: "number" }),
  state: jsonb("state"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const operatorLicenses = pgTable("operator_licenses", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  jurisdiction: text("jurisdiction").notNull(),
  regulator: text("regulator").notNull(),
  licenseNumber: text("license_number").notNull(),
  licensedEntity: text("licensed_entity").notNull(),
  validFrom: date("valid_from", { mode: "string" }).notNull(),
  validUntil: date("valid_until", { mode: "string" }).notNull(),
  status: text("status").notNull().default("submitted"),
  verificationReference: text("verification_reference"),
  verifiedBy: bigint("verified_by", { mode: "number" }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playerCompliance = pgTable("player_compliance", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  countryCode: text("country_code"),
  regionCode: text("region_code"),
  ageVerified: boolean("age_verified").notNull().default(false),
  locationVerified: boolean("location_verified").notNull().default(false),
  kycStatus: text("kyc_status").notNull().default("not_started"),
  amlStatus: text("aml_status").notNull().default("not_started"),
  riskLevel: text("risk_level").notNull().default("unknown"),
  providerCustomerRef: text("provider_customer_ref"),
  selfExcludedUntil: timestamp("self_excluded_until", { withTimezone: true }),
  coolingOffUntil: timestamp("cooling_off_until", { withTimezone: true }),
  lastScreenedAt: timestamp("last_screened_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const responsibleGamblingLimits = pgTable("responsible_gambling_limits", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  dailyDepositLimit: numeric("daily_deposit_limit", { precision: 18, scale: 2 }).notNull().default("0"),
  weeklyDepositLimit: numeric("weekly_deposit_limit", { precision: 18, scale: 2 }).notNull().default("0"),
  monthlyDepositLimit: numeric("monthly_deposit_limit", { precision: 18, scale: 2 }).notNull().default("0"),
  dailyLossLimit: numeric("daily_loss_limit", { precision: 18, scale: 2 }).notNull().default("0"),
  sessionMinutesLimit: integer("session_minutes_limit").notNull().default(0),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: text("public_id").notNull(),
    telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
    direction: text("direction").notNull(),
    rail: text("rail").notNull(),
    provider: text("provider").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    providerReference: text("provider_reference"),
    destinationReference: text("destination_reference"),
    riskDecision: text("risk_decision"),
    reviewReason: text("review_reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata"),
    reviewedBy: bigint("reviewed_by", { mode: "number" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_transactions_public_id_uq").on(table.publicId),
    uniqueIndex("payment_transactions_idempotency_uq").on(table.idempotencyKey),
    uniqueIndex("payment_transactions_provider_ref_uq").on(table.provider, table.providerReference),
  ],
);

export const financialLedger = pgTable(
  "financial_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entryId: text("entry_id").notNull(),
    transactionPublicId: text("transaction_public_id").notNull(),
    telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
    account: text("account").notNull(),
    side: text("side").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    providerReference: text("provider_reference"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("financial_ledger_entry_id_uq").on(table.entryId),
    uniqueIndex("financial_ledger_transaction_entry_uq").on(table.transactionPublicId, table.entryId),
    check("financial_ledger_positive_amount", sql`${table.amount} > 0`),
    check("financial_ledger_valid_side", sql`${table.side} IN ('debit','credit')`),
  ],
);
