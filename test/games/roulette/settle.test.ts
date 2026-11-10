import { describe, expect, it } from 'vitest';
import {
  announcedBetByLabel,
  neighbours,
  type AnnouncedBet,
} from '../../../src/games/roulette/announced.js';
import { settle } from '../../../src/games/roulette/index.js';
import { TABLE_BETS, type TableBet } from '../../../src/games/roulette/table.js';
import type { RouletteBet, TableBetKind } from '../../../src/games/roulette/types.js';

const ALL = Array.from({ length: 37 }, (_, i) => i);

// The odds printed on the table (spec §6), independent of the 36 / n formula.
const ODDS: Record<TableBetKind, number> = {
  straight: 35,
  split: 17,
  street: 11,
  trio: 11,
  corner: 8,
  firstFour: 8,
  sixLine: 5,
  dozen: 2,
  column: 2,
  evenMoney: 1,
};

const onTable = (bet: TableBet, amount: number): RouletteBet => ({
  label: bet.label,
  kind: bet.kind,
  chips: [{ numbers: bet.numbers, amount }],
  amount,
  countsAs: 1,
});

const announced = (bet: AnnouncedBet, perChip: number): RouletteBet => ({
  label: bet.label,
  kind: bet.kind,
  chips: bet.chips.map((numbers) => ({ numbers, amount: perChip })),
  amount: perChip * bet.chips.length,
  countsAs: 1,
});

function named(label: string): AnnouncedBet {
  const bet = announcedBetByLabel(label);
  if (bet === undefined) throw new Error(`No announced bet ${label}`);
  return bet;
}

const payoutOn = (bet: RouletteBet, result: number): number =>
  settle([bet], result)[0]?.payout ?? -1;

const ANNOUNCED = [
  ...['voisins', 'tiers', 'orphelins', 'jeu0'].map(named),
  ...ALL.map((n) => neighbours(n)),
];

describe('settling table bets', () => {
  it('pays every bet its printed odds plus the stake when it wins, and nothing when it loses', () => {
    for (const bet of TABLE_BETS) {
      const placed = onTable(bet, 10);
      for (const result of ALL) {
        const [settled] = settle([placed], result);
        const wins = bet.numbers.includes(result);
        expect(settled, `${bet.label} on ${result}`).toEqual({
          bet: placed,
          won: wins,
          payout: wins ? 10 * (ODDS[bet.kind] + 1) : 0,
        });
      }
    }
  });

  it('gives every legal bet an expected return of 36/37 of the stake, a house edge of 1/37', () => {
    for (const bet of TABLE_BETS) {
      const placed = onTable(bet, 10);
      // Over the 37 equally likely results, 36 × the stake comes back.
      const returned = ALL.reduce((sum, result) => sum + payoutOn(placed, result), 0);
      expect(returned, bet.label).toBe(36 * placed.amount);
    }
  });

  it('settles several bets in the order they were placed', () => {
    const straight = TABLE_BETS.find((bet) => bet.label === '17');
    const red = TABLE_BETS.find((bet) => bet.label === 'red');
    if (straight === undefined || red === undefined) throw new Error('missing bet');
    const settled = settle([onTable(straight, 5), onTable(red, 20)], 17);
    expect(settled.map(({ bet, won, payout }) => [bet.label, won, payout])).toEqual([
      ['17', true, 180],
      ['red', false, 0],
    ]);
  });

  it('refuses a result that is not on the wheel', () => {
    for (const result of [-1, 37, 0.5]) expect(() => settle([], result)).toThrow(RangeError);
  });
});

describe('settling announced bets', () => {
  it('pays each winning chip 36 / n of its amount and adds them up', () => {
    const voisins = announced(named('voisins'), 2);
    expect(voisins.amount).toBe(18);
    expect(payoutOn(voisins, 0)).toBe(48);
    expect(payoutOn(voisins, 3)).toBe(48);
    expect(payoutOn(voisins, 26)).toBe(36);
    expect(payoutOn(voisins, 4)).toBe(36);
    expect(payoutOn(voisins, 1)).toBe(0);

    const orphelins = announced(named('orphelins'), 2);
    expect(payoutOn(orphelins, 17)).toBe(72);
    expect(payoutOn(orphelins, 1)).toBe(72);
    expect(payoutOn(orphelins, 6)).toBe(36);
    expect(payoutOn(orphelins, 0)).toBe(0);

    const tiers = announced(named('tiers'), 2);
    expect(payoutOn(tiers, 5)).toBe(36);
    expect(payoutOn(tiers, 0)).toBe(0);

    const jeuZero = announced(named('jeu0'), 2);
    expect(payoutOn(jeuZero, 0)).toBe(36);
    expect(payoutOn(jeuZero, 26)).toBe(72);
    expect(payoutOn(jeuZero, 2)).toBe(0);

    const n17 = announced(neighbours(17), 2);
    expect(payoutOn(n17, 17)).toBe(72);
    expect(payoutOn(n17, 6)).toBe(72);
    expect(payoutOn(n17, 27)).toBe(0);
  });

  it('marks an announced bet won when any of its chips wins', () => {
    const tiers = announced(named('tiers'), 1);
    expect(settle([tiers], 33)[0]).toMatchObject({ won: true, payout: 18 });
    expect(settle([tiers], 0)[0]).toMatchObject({ won: false, payout: 0 });
  });

  it('gives every announced bet the same 1/37 house edge', () => {
    for (const bet of ANNOUNCED) {
      const placed = announced(bet, 1);
      const returned = ALL.reduce((sum, result) => sum + payoutOn(placed, result), 0);
      expect(returned, bet.label).toBe(36 * placed.amount);
    }
  });
});
