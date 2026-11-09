const coins = new Intl.NumberFormat('en-US');

/** Coins as shown everywhere: `🪙 1,234`. */
export function formatCoins(amount: number): string {
  return `🪙 ${coins.format(amount)}`;
}

/** A Discord timestamp, which every user sees in their own time zone and language. */
export function discordTimestamp(
  instant: Temporal.Instant,
  style: 'R' | 't' | 'T' | 'd' | 'D' | 'f' | 'F' = 'R',
): string {
  return `<t:${Math.floor(instant.epochMilliseconds / 1000)}:${style}>`;
}
