export type BattleResultRule = "high" | "crazy";

export type BattleRound = {
  playerOneScore: number;
  playerTwoScore: number;
};

export type BattleRoundResult = BattleRound & {
  playerOneWon: boolean;
  playerTwoWon: boolean;
};

export type BattleResolution = {
  rounds: BattleRound[];
  playerOneScore: number;
  playerTwoScore: number;
  playerOneWins: number;
  playerTwoWins: number;
  playerOneWon: boolean;
  tie: boolean;
  complete: boolean;
};

export function sumBattleRolls(rolls: readonly number[]): number {
  return rolls.reduce((total, value) => total + value, 0);
}

export function sevenUpMultiplier(
  total: number,
  choice: "up" | "down",
): number {
  const wins =
    choice === "up"
      ? total >= 7
      : total <= 6;
  if (!wins) return 0;
  return total === 7 ? 5.22 : 1.92;
}

export function scoreBattleRound(
  playerOneRolls: readonly number[],
  playerTwoRolls: readonly number[],
  resultRule: BattleResultRule = "high",
): BattleRoundResult {
  const playerOneScore = sumBattleRolls(playerOneRolls);
  const playerTwoScore = sumBattleRolls(playerTwoRolls);
  const playerOneWon =
    resultRule === "crazy"
      ? playerOneScore < playerTwoScore
      : playerOneScore > playerTwoScore;
  const playerTwoWon =
    resultRule === "crazy"
      ? playerTwoScore < playerOneScore
      : playerTwoScore > playerOneScore;

  return { playerOneScore, playerTwoScore, playerOneWon, playerTwoWon };
}

export function resolveBattleRounds(
  rounds: readonly BattleRound[],
  options: {
    fixedRounds: number;
    targetWins: number | null;
    resultRule?: BattleResultRule;
  },
): BattleResolution {
  const resultRule = options.resultRule ?? "high";
  const playedRounds: BattleRound[] = [];
  let playerOneWins = 0;
  let playerTwoWins = 0;
  let complete = false;

  for (const round of rounds) {
    if (options.targetWins === null && playedRounds.length >= options.fixedRounds) {
      break;
    }

    playedRounds.push(round);
    const scored = scoreBattleRound(
      [round.playerOneScore],
      [round.playerTwoScore],
      resultRule,
    );
    if (scored.playerOneWon) playerOneWins += 1;
    if (scored.playerTwoWon) playerTwoWins += 1;

    complete =
      options.targetWins !== null
        ? playerOneWins >= options.targetWins ||
          playerTwoWins >= options.targetWins
        : playedRounds.length >= options.fixedRounds;
    if (complete) break;
  }

  const playerOneScore =
    options.targetWins === null
      ? sumBattleRolls(playedRounds.map((round) => round.playerOneScore))
      : playerOneWins;
  const playerTwoScore =
    options.targetWins === null
      ? sumBattleRolls(playedRounds.map((round) => round.playerTwoScore))
      : playerTwoWins;
  const playerOneWon =
    options.targetWins === null
      ? resultRule === "crazy"
        ? playerOneScore < playerTwoScore
        : playerOneScore > playerTwoScore
      : playerOneWins > playerTwoWins;

  return {
    rounds: playedRounds,
    playerOneScore,
    playerTwoScore,
    playerOneWins,
    playerTwoWins,
    playerOneWon,
    tie: playerOneScore === playerTwoScore,
    complete,
  };
}

export function calculateBattlePayouts(input: {
  stakeMinor: number;
  playerOneScore: number;
  playerTwoScore: number;
  playerOneWon: boolean;
  hasPlayerTwo: boolean;
}): {
  payoutMinor: number;
  playerOnePayout: number;
  playerTwoPayout: number;
  tie: boolean;
} {
  const payoutMinor = Math.round(input.stakeMinor * 1.92);
  const tie = input.playerOneScore === input.playerTwoScore;
  return {
    payoutMinor,
    playerOnePayout: tie
      ? input.stakeMinor
      : input.playerOneWon
        ? payoutMinor
        : 0,
    playerTwoPayout:
      input.hasPlayerTwo && !tie && !input.playerOneWon
        ? payoutMinor
        : tie && input.hasPlayerTwo
          ? input.stakeMinor
          : 0,
    tie,
  };
}

export const BATTLE_TURN_TIMEOUT_MS = 120_000;

export function isBattleTurnExpired(
  deadline: Date | null | undefined,
  now = Date.now(),
): boolean {
  return Boolean(deadline && deadline.getTime() <= now);
}

export function battleTimeoutOutcome(stakeMinor: number): {
  status: "cancelled";
  refundMinor: number;
} {
  return { status: "cancelled", refundMinor: stakeMinor };
}