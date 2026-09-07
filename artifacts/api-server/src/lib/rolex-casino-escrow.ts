import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  casinoEscrowsTable,
  casinoHouseWalletsTable,
  casinoLedgerEntriesTable,
  casinoWalletsTable,
  db,
} from "@workspace/db";
import type { Currency } from "./rolex-casino-stats.ts";

const ESCROW_FEE_RATE = 0.002;

function formatMoney(amountMinor: number, currency: Currency): string {
  const amount = (amountMinor / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "INR" ? `₹${amount}` : `$${amount}`;
}

function escrowFeeMinor(amountMinor: number): number {
  return Math.max(1, Math.ceil(amountMinor * ESCROW_FEE_RATE));
}

class EscrowInsufficientBalanceError extends Error {
  readonly currency: Currency;
  readonly balanceMinor: number;
  readonly amountMinor: number;
  readonly feeMinor: number;

  constructor(
    currency: Currency,
    balanceMinor: number,
    amountMinor: number,
    feeMinor: number,
  ) {
    super("INSUFFICIENT_BALANCE");
    this.name = "EscrowInsufficientBalanceError";
    this.currency = currency;
    this.balanceMinor = balanceMinor;
    this.amountMinor = amountMinor;
    this.feeMinor = feeMinor;
  }
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
  if (!wallet) throw new Error("Could not create casino house wallet");
  return wallet;
}

function escrowCode(): string {
  return `RX-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

function escrowFairId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789_-";
  const seed = randomUUID().replace(/-/g, "");
  let value = "PF_";
  for (let index = 0; value.length < 24; index += 1) {
    value += alphabet[Number.parseInt(seed[index % seed.length] ?? "0", 16) % alphabet.length];
  }
  return value;
}

export async function createEscrow(input: {
  sellerPlayerId: number;
  buyerPlayerId: number;
  amountMinor: number;
  currency: Currency;
  chatId: number;
}): Promise<typeof casinoEscrowsTable.$inferSelect> {
  if (input.sellerPlayerId === input.buyerPlayerId) {
    throw new Error("SELF_ESCROW");
  }
  const feeMinor = escrowFeeMinor(input.amountMinor);
  const requiredMinor = input.amountMinor + feeMinor;
  const sellerWallet = await ensureWallet(input.sellerPlayerId, input.currency);
  const houseWallet = await ensureHouseWallet(input.currency);
  const transactionId = randomUUID();
  return db.transaction(async (tx) => {
    const [seller] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} - ${requiredMinor}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(casinoWalletsTable.id, sellerWallet.id),
          gte(casinoWalletsTable.balanceMinor, requiredMinor),
        ),
      )
      .returning();
    if (!seller) {
      const [currentWallet] = await tx
        .select({ balanceMinor: casinoWalletsTable.balanceMinor })
        .from(casinoWalletsTable)
        .where(eq(casinoWalletsTable.id, sellerWallet.id))
        .limit(1);
      throw new EscrowInsufficientBalanceError(
        input.currency,
        currentWallet?.balanceMinor ?? sellerWallet.balanceMinor,
        input.amountMinor,
        feeMinor,
      );
    }

    await tx.insert(casinoLedgerEntriesTable).values([
      {
        walletId: sellerWallet.id,
        transactionId,
        entryType: "escrow_hold",
        amountMinor: -input.amountMinor,
        description: "Escrow amount held",
      },
      {
        walletId: sellerWallet.id,
        transactionId,
        entryType: "escrow_fee",
        amountMinor: -feeMinor,
        description: "Escrow service fee (0.2%)",
      },
    ]);
    await tx
      .update(casinoHouseWalletsTable)
      .set({
        balanceMinor: sql`${casinoHouseWalletsTable.balanceMinor} + ${feeMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoHouseWalletsTable.id, houseWallet.id));

    const [escrow] = await tx
      .insert(casinoEscrowsTable)
      .values({
        code: escrowCode(),
        fairId: escrowFairId(),
        senderPlayerId: input.sellerPlayerId,
        recipientPlayerId: input.buyerPlayerId,
        currency: input.currency,
        amountMinor: input.amountMinor,
        feeMinor,
        chatId: input.chatId,
        status: "pending",
      })
      .returning();
    if (!escrow) throw new Error("ESCROW_CREATE_FAILED");
    return escrow;
  });
}

export async function releaseEscrow(
  code: string,
  actorPlayerId?: number,
): Promise<typeof casinoEscrowsTable.$inferSelect> {
  const [escrow] = await db
    .select()
    .from(casinoEscrowsTable)
    .where(eq(casinoEscrowsTable.code, code.toUpperCase()))
    .limit(1);
  if (!escrow) throw new Error("ESCROW_NOT_FOUND");
  if (actorPlayerId != null && escrow.senderPlayerId !== actorPlayerId) {
    throw new Error("ESCROW_NOT_SELLER");
  }
  if (
    actorPlayerId != null &&
    (escrow.status === "released" || escrow.status === "cancelled")
  ) {
    throw new Error("ESCROW_ALREADY_COMPLETED");
  }
  if (escrow.status !== "accepted" && actorPlayerId != null) {
    throw new Error("ESCROW_NOT_ACCEPTED");
  }
  const currency = escrow.currency as Currency;
  const recipientWallet = await ensureWallet(escrow.recipientPlayerId, currency);
  const transactionId = randomUUID();
  return db.transaction(async (tx) => {
    const [completed] = await tx
      .update(casinoEscrowsTable)
      .set({ status: "released", completedAt: new Date() })
      .where(
        and(
          eq(casinoEscrowsTable.id, escrow.id),
          actorPlayerId == null
            ? inArray(casinoEscrowsTable.status, ["pending", "accepted"])
            : eq(casinoEscrowsTable.status, "accepted"),
        ),
      )
      .returning();
    if (!completed) throw new Error("ESCROW_ALREADY_COMPLETED");

    const [recipient] = await tx
      .update(casinoWalletsTable)
      .set({
        balanceMinor: sql`${casinoWalletsTable.balanceMinor} + ${escrow.amountMinor}`,
        updatedAt: new Date(),
      })
      .where(eq(casinoWalletsTable.id, recipientWallet.id))
      .returning();
    if (!recipient) throw new Error("ESCROW_RELEASE_FAILED");
    await tx.insert(casinoLedgerEntriesTable).values({
      walletId: recipientWallet.id,
      transactionId,
      entryType: "escrow_release",
      amountMinor: escrow.amountMinor,
      description: `Escrow ${escrow.code} released to accepting buyer`,
    });
    return completed;
  });
}

export function escrowErrorText(error: unknown): string {
  if (error instanceof EscrowInsufficientBalanceError) {
    const totalRequired = error.amountMinor + error.feeMinor;
    return [
      `Escrow rejected in ${error.currency}.`,
      `Current seller balance: ${formatMoney(error.balanceMinor, error.currency)}`,
      `Escrow amount: ${formatMoney(error.amountMinor, error.currency)}`,
      `Service fee (0.2%): ${formatMoney(error.feeMinor, error.currency)}`,
      `Total required: ${formatMoney(totalRequired, error.currency)}`,
    ].join("\n");
  }
  const reason = error instanceof Error ? error.message : "";
  if (reason === "INSUFFICIENT_BALANCE") {
    return "Escrow rejected because your selected-currency balance is too low for the amount plus 0.2% fee.";
  }
  if (reason === "SELF_ESCROW") return "You cannot create an escrow with yourself.";
  if (reason === "ESCROW_NOT_FOUND") return "That escrow code was not found.";
  if (reason === "ESCROW_NOT_SELLER") return "Only the seller can release this escrow.";
  if (reason === "ESCROW_NOT_SENDER") return "Only the buyer can reject a pending escrow.";
  if (reason === "ESCROW_NOT_ACCEPTED") return "The buyer must accept the escrow before releasing it.";
  if (reason === "ESCROW_CANCEL_REQUIRES_MUTUAL") {
    return "Accepted escrows require both parties to request cancellation.";
  }
  if (reason === "ESCROW_NOT_ACCEPTABLE") return "This escrow is no longer waiting for that buyer, or it has already been completed.";
  if (reason === "ESCROW_ALREADY_COMPLETED") return "That escrow is already completed.";
  return "The escrow action could not be completed.";
}