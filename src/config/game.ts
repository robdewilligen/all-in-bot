/** Game and economy settings (SPEC §11). Engines receive these as arguments, never by import. */
export const gameConfig = {
  stakes: { min: 10, max: 1_000_000 },
  daily: { base: 1_000, streakBonus: 100, maxStreakBonus: 700 },
  cooldowns: { defaultSeconds: 3, leaderboardSeconds: 5, createTableSeconds: 30 },
  leaderboard: { pageSize: 10 },
  /** Table threads (SPEC §4): a lobby without a new game closes; a bet form waits this long. */
  tables: { lobbyMinutes: 10, formSeconds: 300, renamesPerTenMinutes: 2 },
  roulette: { bettingSeconds: 30, maxPlayers: 20, maxBetsPerSpin: 30, revealDelayMs: 1_500 },
  blackjack: {
    decks: 6,
    cutCardPercent: 75,
    dealerHitsSoft17: false,
    blackjackPays: { numerator: 3, denominator: 2 },
    maxHands: 4,
    doubleAfterSplit: true,
    lateSurrender: true,
  },
  blackjackTable: {
    seats: 4,
    bettingSeconds: 20,
    insuranceSeconds: 20,
    turnSeconds: 45,
    maxSitOuts: 2,
    betModalSeconds: 300,
  },
  slots: {
    weights: { cherry: 10, lemon: 7, orange: 6, grape: 4, bell: 3, diamond: 1, seven: 1 },
    paytable: [
      { symbol: 'seven', count: 3, multiplier: 100 },
      { symbol: 'diamond', count: 3, multiplier: 50 },
      { symbol: 'bell', count: 3, multiplier: 25 },
      { symbol: 'grape', count: 3, multiplier: 15 },
      { symbol: 'orange', count: 3, multiplier: 10 },
      { symbol: 'lemon', count: 3, multiplier: 8 },
      { symbol: 'cherry', count: 3, multiplier: 5 },
      { symbol: 'cherry', count: 2, multiplier: 3 },
    ],
    jackpotFrom: 50,
    revealDelayMs: 700,
  },
} as const;

export type GameConfig = typeof gameConfig;
