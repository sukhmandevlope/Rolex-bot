export const INR_PER_USD = 98;
export const VIP_WAGER_THRESHOLD_INR_MINOR = 10_000_000;

const SUPPORTED_CURRENCIES = ["INR", "USD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export type CasinoStatsRound = {
  currency: string;
  stakeMinor: number;
  payoutMinor: number;
};

export type CasinoStatsBattle = {
  currency: string;
  stakeMinor: number;
  winnerPlayerId: number | null;
};

export type CasinoStatsCurrency = {
  currency: Currency;
  rounds: number;
  wins: number;
  wagerMinor: number;
  profitMinor: number;
};

export type CasinoStatsSummary = {
  currencies: CasinoStatsCurrency[];
  category: "VIP" | "NORMAL";
  wagerInrMinor: number;
};

/**
 * Summarize completed game activity only. Escrows are transfers, not wagers,
 * so callers should not include them in these inputs.
 */
export function summarizeCasinoStats(
  playerId: number,
  rounds: readonly CasinoStatsRound[],
  battles: readonly CasinoStatsBattle[],
): CasinoStatsSummary {
  const wagerInrMinor =
    rounds.reduce(
      (total, round) =>
        total + round.stakeMinor * (round.currency === "USD" ? INR_PER_USD : 1),
      0,
    ) +
    battles.reduce(
      (total, battle) =>
        total + battle.stakeMinor * (battle.currency === "USD" ? INR_PER_USD : 1),
      0,
    );

  const currencies = SUPPORTED_CURRENCIES.map((currency) => {
    const currencyRounds = rounds.filter((round) => round.currency === currency);
    const currencyBattles = battles.filter((battle) => battle.currency === currency);
    const wagerMinor =
      currencyRounds.reduce((total, round) => total + round.stakeMinor, 0) +
      currencyBattles.reduce((total, battle) => total + battle.stakeMinor, 0);
    const battleProfit = currencyBattles.reduce((total, battle) => {
      const payout =
        battle.winnerPlayerId === null
          ? battle.stakeMinor
          : battle.winnerPlayerId === playerId
            ? Math.round(battle.stakeMinor * 1.92)
            : 0;
      return total + payout - battle.stakeMinor;
    }, 0);
    const profitMinor =
      currencyRounds.reduce(
        (total, round) => total + round.payoutMinor - round.stakeMinor,
        0,
      ) + battleProfit;
    const wins =
      currencyRounds.filter((round) => round.payoutMinor > round.stakeMinor).length +
      currencyBattles.filter((battle) => battle.winnerPlayerId === playerId).length;

    return {
      currency,
      rounds: currencyRounds.length + currencyBattles.length,
      wins,
      wagerMinor,
      profitMinor,
    };
  });

  return {
    currencies,
    wagerInrMinor,
    category: wagerInrMinor >= VIP_WAGER_THRESHOLD_INR_MINOR ? "VIP" : "NORMAL",
  };
}