import assert from "node:assert/strict";
import test from "node:test";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  casinoEscrowsTable,
  casinoHouseWalletsTable,
  casinoLedgerEntriesTable,
  casinoPlayersTable,
  casinoWalletsTable,
  db,
} from "@workspace/db";
import {
  createEscrow,
  escrowErrorText,
  releaseEscrow,
} from "./rolex-casino-escrow.ts";

let fixtureSequence = 0;

async function createFixture({ inrBalance, usdBalance }) {
  const telegramId = 900_000_000_000_000 + process.pid * 10 + fixtureSequence++;
  const [seller, buyer] = await db
    .insert(casinoPlayersTable)
    .values([
      {
        telegramUserId: telegramId,
        displayName: "Escrow regression seller",
        preferredCurrency: "INR",
      },
      {
        telegramUserId: telegramId + 1,
        displayName: "Escrow regression buyer",
        preferredCurrency: "INR",
      },
    ])
    .returning({ id: casinoPlayersTable.id });

  const wallets = await db
    .insert(casinoWalletsTable)
    .values([
      {
        playerId: seller.id,
        currency: "INR",
        balanceMinor: inrBalance,
      },
      {
        playerId: seller.id,
        currency: "USD",
        balanceMinor: usdBalance,
      },
    ])
    .returning({ id: casinoWalletsTable.id });

  return {
    playerIds: [seller.id, buyer.id],
    sellerId: seller.id,
    buyerId: buyer.id,
    walletIds: wallets.map((wallet) => wallet.id),
    telegramId,
  };
}

async function cleanupFixture(fixture) {
  const fixtureWallets = await db
    .select({ id: casinoWalletsTable.id })
    .from(casinoWalletsTable)
    .where(inArray(casinoWalletsTable.playerId, fixture.playerIds));
  const walletIds = fixtureWallets.map((wallet) => wallet.id);
  await db
    .delete(casinoLedgerEntriesTable)
    .where(inArray(casinoLedgerEntriesTable.walletId, walletIds));
  await db
    .delete(casinoEscrowsTable)
    .where(
      or(
        inArray(casinoEscrowsTable.senderPlayerId, fixture.playerIds),
        inArray(casinoEscrowsTable.recipientPlayerId, fixture.playerIds),
      ),
    );
  await db.delete(casinoWalletsTable).where(inArray(casinoWalletsTable.playerId, fixture.playerIds));
  await db
    .delete(casinoPlayersTable)
    .where(inArray(casinoPlayersTable.id, fixture.playerIds));
}

test("creates an escrow in the selected currency and debits amount plus fee", async () => {
  const fixture = await createFixture({
    inrBalance: 6_000,
    usdBalance: 12_345,
  });

  try {
    const escrow = await createEscrow({
      sellerPlayerId: fixture.sellerId,
      buyerPlayerId: fixture.buyerId,
      amountMinor: 5_000,
      currency: "INR",
      chatId: fixture.telegramId,
    });

    assert.equal(escrow.currency, "INR");
    assert.equal(escrow.amountMinor, 5_000);
    assert.equal(escrow.feeMinor, 10);

    const wallets = await db
      .select({
        currency: casinoWalletsTable.currency,
        balanceMinor: casinoWalletsTable.balanceMinor,
      })
      .from(casinoWalletsTable)
      .where(eq(casinoWalletsTable.playerId, fixture.sellerId));
    assert.deepEqual(
      wallets.sort((left, right) => left.currency.localeCompare(right.currency)),
      [
        { currency: "INR", balanceMinor: 990 },
        { currency: "USD", balanceMinor: 12_345 },
      ],
    );

    const ledgerEntries = await db
      .select({
        entryType: casinoLedgerEntriesTable.entryType,
        amountMinor: casinoLedgerEntriesTable.amountMinor,
      })
      .from(casinoLedgerEntriesTable)
      .where(
        inArray(casinoLedgerEntriesTable.walletId, fixture.walletIds),
      );
    assert.deepEqual(
      ledgerEntries.sort((left, right) =>
        left.entryType.localeCompare(right.entryType),
      ),
      [
        { entryType: "escrow_fee", amountMinor: -10 },
        { entryType: "escrow_hold", amountMinor: -5_000 },
      ],
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("does not use an aggregate balance from another currency for escrow", async () => {
  const fixture = await createFixture({
    inrBalance: 100,
    usdBalance: 50_000,
  });

  try {
    let error;
    try {
      await createEscrow({
        sellerPlayerId: fixture.sellerId,
        buyerPlayerId: fixture.buyerId,
        amountMinor: 5_000,
        currency: "INR",
        chatId: fixture.telegramId,
      });
      assert.fail("Expected escrow creation to reject an insufficient INR wallet");
    } catch (caught) {
      error = caught;
    }

    assert.equal(error?.message, "INSUFFICIENT_BALANCE");
    assert.equal(error?.currency, "INR");
    assert.equal(error?.balanceMinor, 100);
    assert.equal(error?.amountMinor, 5_000);
    assert.equal(error?.feeMinor, 10);
    assert.equal(
      escrowErrorText(error),
      [
        "Escrow rejected in INR.",
        "Current seller balance: ₹1.00",
        "Escrow amount: ₹50.00",
        "Service fee (0.2%): ₹0.10",
        "Total required: ₹50.10",
      ].join("\n"),
    );

    const wallets = await db
      .select({
        currency: casinoWalletsTable.currency,
        balanceMinor: casinoWalletsTable.balanceMinor,
      })
      .from(casinoWalletsTable)
      .where(eq(casinoWalletsTable.playerId, fixture.sellerId));
    assert.deepEqual(
      wallets.sort((left, right) => left.currency.localeCompare(right.currency)),
      [
        { currency: "INR", balanceMinor: 100 },
        { currency: "USD", balanceMinor: 50_000 },
      ],
    );

    const escrows = await db
      .select({ id: casinoEscrowsTable.id })
      .from(casinoEscrowsTable)
      .where(
        and(
          eq(casinoEscrowsTable.senderPlayerId, fixture.sellerId),
          eq(casinoEscrowsTable.recipientPlayerId, fixture.buyerId),
        ),
      );
    assert.deepEqual(escrows, []);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("releasing escrow credits the buyer, routes the fee to house, and is idempotent", async () => {
  const fixture = await createFixture({
    inrBalance: 10_000,
    usdBalance: 12_345,
  });
  const [houseBefore] = await db
    .select({ balanceMinor: casinoHouseWalletsTable.balanceMinor })
    .from(casinoHouseWalletsTable)
    .where(eq(casinoHouseWalletsTable.currency, "INR"));

  try {
    const escrow = await createEscrow({
      sellerPlayerId: fixture.sellerId,
      buyerPlayerId: fixture.buyerId,
      amountMinor: 5_000,
      currency: "INR",
      chatId: fixture.telegramId,
    });

    await db
      .update(casinoEscrowsTable)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(casinoEscrowsTable.id, escrow.id));

    const released = await releaseEscrow(escrow.code, fixture.sellerId);
    assert.equal(released.status, "released");

    const wallets = await db
      .select({
        walletId: casinoWalletsTable.id,
        playerId: casinoWalletsTable.playerId,
        currency: casinoWalletsTable.currency,
        balanceMinor: casinoWalletsTable.balanceMinor,
      })
      .from(casinoWalletsTable)
      .where(inArray(casinoWalletsTable.playerId, fixture.playerIds));
    assert.deepEqual(
      wallets
        .filter((wallet) => wallet.currency === "INR")
        .sort((left, right) => left.playerId - right.playerId)
        .map(({ walletId, ...wallet }) => wallet),
      [
        { playerId: fixture.sellerId, currency: "INR", balanceMinor: 4_990 },
        { playerId: fixture.buyerId, currency: "INR", balanceMinor: 5_000 },
      ],
    );

    const [houseAfter] = await db
      .select({ balanceMinor: casinoHouseWalletsTable.balanceMinor })
      .from(casinoHouseWalletsTable)
      .where(eq(casinoHouseWalletsTable.currency, "INR"));
    assert.equal(
      (houseAfter?.balanceMinor ?? 0) - (houseBefore?.balanceMinor ?? 0),
      10,
    );

    const releaseEntries = await db
      .select({
        entryType: casinoLedgerEntriesTable.entryType,
        amountMinor: casinoLedgerEntriesTable.amountMinor,
      })
      .from(casinoLedgerEntriesTable)
      .where(inArray(casinoLedgerEntriesTable.walletId, wallets.map((wallet) => wallet.walletId)));
    assert.ok(
      releaseEntries.some(
        (entry) => entry.entryType === "escrow_release" && entry.amountMinor === 5_000,
      ),
    );

    await assert.rejects(
      () => releaseEscrow(escrow.code, fixture.sellerId),
      (error) => error?.message === "ESCROW_ALREADY_COMPLETED",
    );
  } finally {
    await cleanupFixture(fixture);
  }
});