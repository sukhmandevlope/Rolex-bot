import assert from "node:assert/strict";
import test from "node:test";
import {
  BATTLE_TURN_TIMEOUT_MS,
  battleTimeoutOutcome,
  calculateBattlePayouts,
  isBattleTurnExpired,
  resolveBattleRounds,
  scoreBattleRound,
  sevenUpMultiplier,
} from "./rolex-casino-battle-rules.ts";

test("7up pays 5.22x only when the two dice total exactly seven", () => {
  assert.equal(sevenUpMultiplier(7, "up"), 5.22);
  assert.equal(sevenUpMultiplier(8, "up"), 1.92);
  assert.equal(sevenUpMultiplier(6, "down"), 1.92);
  assert.equal(sevenUpMultiplier(7, "down"), 0);
});

test("scores all three rolls in a single battle round", () => {
  assert.deepEqual(
    scoreBattleRound([6, 5, 4], [1, 2, 3]),
    {
      playerOneScore: 15,
      playerTwoScore: 6,
      playerOneWon: true,
      playerTwoWon: false,
    },
  );
});

test("3d3w continues through draws and non-winning rounds until a side reaches three wins", () => {
  const resolution = resolveBattleRounds(
    [
      { playerOneScore: 10, playerTwoScore: 10 },
      { playerOneScore: 3, playerTwoScore: 5 },
      { playerOneScore: 6, playerTwoScore: 2 },
      { playerOneScore: 8, playerTwoScore: 8 },
      { playerOneScore: 7, playerTwoScore: 1 },
      { playerOneScore: 9, playerTwoScore: 4 },
      { playerOneScore: 100, playerTwoScore: 0 },
    ],
    { fixedRounds: 3, targetWins: 3 },
  );

  assert.equal(resolution.rounds.length, 6);
  assert.equal(resolution.playerOneWins, 3);
  assert.equal(resolution.playerTwoWins, 1);
  assert.equal(resolution.playerOneScore, 3);
  assert.equal(resolution.playerTwoScore, 1);
  assert.equal(resolution.playerOneWon, true);
  assert.equal(resolution.tie, false);
  assert.equal(resolution.complete, true);
});

test("an expired inactive battle is cancelled and refunds its stake", () => {
  assert.equal(BATTLE_TURN_TIMEOUT_MS, 60_000);
  const deadline = new Date("2026-09-07T12:00:00.000Z");

  assert.equal(isBattleTurnExpired(deadline, deadline.getTime() - 1), false);
  assert.equal(isBattleTurnExpired(deadline, deadline.getTime()), true);
  assert.deepEqual(battleTimeoutOutcome(2_500), {
    status: "cancelled",
    refundMinor: 2_500,
  });
});

test("legacy fixed-round battles still play exactly three rounds", () => {
  const resolution = resolveBattleRounds(
    [
      { playerOneScore: 10, playerTwoScore: 8 },
      { playerOneScore: 2, playerTwoScore: 2 },
      { playerOneScore: 7, playerTwoScore: 9 },
      { playerOneScore: 100, playerTwoScore: 0 },
    ],
    { fixedRounds: 3, targetWins: null },
  );

  assert.equal(resolution.rounds.length, 3);
  assert.equal(resolution.playerOneScore, 19);
  assert.equal(resolution.playerTwoScore, 19);
  assert.equal(resolution.tie, true);
  assert.equal(resolution.complete, true);
});

test("battle payouts return 1.92x to the winner and refund ties", () => {
  assert.deepEqual(
    calculateBattlePayouts({
      stakeMinor: 1_000,
      playerOneScore: 3,
      playerTwoScore: 1,
      playerOneWon: true,
      hasPlayerTwo: true,
    }),
    {
      payoutMinor: 1_920,
      playerOnePayout: 1_920,
      playerTwoPayout: 0,
      tie: false,
    },
  );
  assert.deepEqual(
    calculateBattlePayouts({
      stakeMinor: 1_000,
      playerOneScore: 2,
      playerTwoScore: 2,
      playerOneWon: false,
      hasPlayerTwo: true,
    }),
    {
      payoutMinor: 1_920,
      playerOnePayout: 1_000,
      playerTwoPayout: 1_000,
      tie: true,
    },
  );
});