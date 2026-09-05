import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
