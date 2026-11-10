import type { RouletteBet, SettledBet } from './types.js';
import { isPocket } from './wheel.js';

/** Settles each bet against the result: every winning chip returns stake × 36 / n, stake included. */
export function settle(bets: readonly RouletteBet[], result: number): SettledBet[] {
  if (!isPocket(result)) throw new RangeError(`${result} is not a roulette number`);
  return bets.map((bet) => {
    const winners = bet.chips.filter((chip) => chip.numbers.includes(result));
    // 36 / n on every bet leaves the house the single zero's edge of 1/37, whatever the bet.
    const payout = winners.reduce(
      (sum, chip) => sum + Math.floor((chip.amount * 36) / chip.numbers.length),
      0,
    );
    return { bet, won: winners.length > 0, payout };
  });
}
