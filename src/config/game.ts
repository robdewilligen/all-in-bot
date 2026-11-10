/** Game and economy settings (SPEC §11). Engines receive these as arguments, never by import. */
export const gameConfig = {
  stakes: { min: 10, max: 1_000_000 },
  daily: { base: 1_000, streakBonus: 100, maxStreakBonus: 700 },
  cooldowns: { defaultSeconds: 3, leaderboardSeconds: 5 },
  leaderboard: { pageSize: 10 },
  blackjack: {
    decks: 6,
    cutCardPercent: 75,
    dealerHitsSoft17: false,
    blackjackPays: { numerator: 3, denominator: 2 },
    maxHands: 4,
    doubleAfterSplit: true,
    lateSurrender: true,
  },
} as const;

export type GameConfig = typeof gameConfig;
