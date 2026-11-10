const coins = new Intl.NumberFormat('en-US');
const counts = new Intl.NumberFormat('en-US');

/** Coins as shown everywhere: `🪙 1,234`. */
export function formatCoins(amount: number): string {
  return `🪙 ${coins.format(amount)}`;
}

/** A count with thousands separators, such as a number of players: `1,234`. */
export function formatCount(count: number): string {
  return counts.format(count);
}

/** A leaderboard rank: `#4`. */
export function formatRank(rank: number): string {
  return `#${formatCount(rank)}`;
}

/** A Discord timestamp, which every user sees in their own time zone and language. */
export function discordTimestamp(
  instant: Temporal.Instant,
  style: 'R' | 't' | 'T' | 'd' | 'D' | 'f' | 'F' = 'R',
): string {
  return `<t:${Math.floor(instant.epochMilliseconds / 1000)}:${style}>`;
}
