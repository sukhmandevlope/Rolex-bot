import assert from "node:assert/strict";
import test from "node:test";
import {
  INR_PER_USD,
  VIP_WAGER_THRESHOLD_INR_MINOR,
  summarizeCasinoStats,
} from "./rolex-casino-stats.ts";

const playerId = 42;

test("combines simple-game rounds with PvB and PvP battles", () => {
  const stats = summarizeCasinoStats(
    playerId,
    [
      { currency: "INR", stakeMinor: 200, payoutMinor: 400 },
      { currency: "INR", stakeMinor: 300, payoutMinor: 0 },
    ],
    [
      { currency: "INR", stakeMinor: 500, winnerPlayerId: playerId },
      { currency: "INR", stakeMinor: 200, winnerPlayerId: 99 },
    ],
  );

  assert.equal(stats.wagerInrMinor, 1_200);
  assert.deepEqual(stats.currencies.find((item) => item.currency === "INR"), {
    currency: "INR",
    rounds: 4,
    wins: 2,
    wagerMinor: 1_200,
    profitMinor: 160,
  });
});

test("counts wins, losses, and ties with the correct profit", () => {
  const stats = summarizeCasinoStats(
    playerId,
    [{ currency: "INR", stakeMinor: 100, payoutMinor: 100 }],
    [
      { currency: "INR", stakeMinor: 250, winnerPlayerId: playerId },
      { currency: "INR", stakeMinor: 250, winnerPlayerId: 99 },
      { currency: "INR", stakeMinor: 250, winnerPlayerId: null },
    ],
  );

  assert.deepEqual(stats.currencies.find((item) => item.currency === "INR"), {
    currency: "INR",
    rounds: 4,
    wins: 1,
    wagerMinor: 850,
    profitMinor: -20,
  });
});

test("marks exactly ₹1,00,000 of INR-equivalent wagers as VIP", () => {
  const atBoundary = summarizeCasinoStats(
    playerId,
    [{ currency: "INR", stakeMinor: VIP_WAGER_THRESHOLD_INR_MINOR, payoutMinor: 0 }],
    [],
  );
  const belowBoundary = summarizeCasinoStats(
    playerId,
    [{ currency: "INR", stakeMinor: VIP_WAGER_THRESHOLD_INR_MINOR - 1, payoutMinor: 0 }],
    [],
  );

  assert.equal(atBoundary.category, "VIP");
  assert.equal(belowBoundary.category, "NORMAL");
});

test("converts USD wagers with the configured INR rate", () => {
  const usdStakeMinor = Math.ceil(VIP_WAGER_THRESHOLD_INR_MINOR / INR_PER_USD);
  const stats = summarizeCasinoStats(
    playerId,
    [{ currency: "USD", stakeMinor: usdStakeMinor, payoutMinor: 0 }],
    [{ currency: "USD", stakeMinor: 1_000, winnerPlayerId: 99 }],
  );

  assert.equal(
    stats.wagerInrMinor,
    (usdStakeMinor + 1_000) * INR_PER_USD,
  );
  assert.equal(stats.category, "VIP");
  assert.equal(
    stats.currencies.find((item) => item.currency === "USD")?.wagerMinor,
    usdStakeMinor + 1_000,
  );
});