import { describe, expect, it } from 'vitest';
import type { AmountContext } from '../../../src/core/amount.js';
import { announcedBetByLabel, neighbours } from '../../../src/games/roulette/announced.js';
import { parseBets, WHEEL_ORDER, type RouletteBet } from '../../../src/games/roulette/index.js';
import { tableBetFor } from '../../../src/games/roulette/table.js';
import type { Message } from '../../../src/i18n/index.js';

const CONTEXT: AmountContext = { balance: 10_000, max: 1_000_000 };
const ALL = Array.from({ length: 37 }, (_, i) => i);

function bets(input: string, context: AmountContext = CONTEXT): RouletteBet[] {
  const result = parseBets(input, context);
  if (!result.ok) throw new Error(`${input} was rejected: ${JSON.stringify(result.error)}`);
  return result.bets;
}

function rejection(input: string, context: AmountContext = CONTEXT): Message {
  const result = parseBets(input, context);
  if (result.ok) throw new Error(`${input} was accepted`);
  return result.error;
}

function layout(label: string): string[] {
  const bet = announcedBetByLabel(label);
  if (bet === undefined) throw new Error(`No announced bet ${label}`);
  return bet.chips.map((numbers) => numbers.join('/'));
}

const covered = (chips: readonly string[]): number[] =>
  [...new Set(chips.flatMap((chip) => chip.split('/').map(Number)))].toSorted((a, b) => a - b);

/** The numbers from `from` to `to`, clockwise round the wheel. */
function sector(from: number, to: number): number[] {
  const start = WHEEL_ORDER.indexOf(from);
  const length = ((WHEEL_ORDER.indexOf(to) - start + 37) % 37) + 1;
  return Array.from({ length }, (_, i) => WHEEL_ORDER[(start + i) % 37] ?? -1).toSorted(
    (a, b) => a - b,
  );
}

describe('the announced bets', () => {
  it('have the chip layouts from the spec', () => {
    expect(layout('voisins').toSorted()).toEqual(
      [
        '0/2/3',
        '0/2/3',
        '4/7',
        '12/15',
        '18/21',
        '19/22',
        '32/35',
        '25/26/28/29',
        '25/26/28/29',
      ].toSorted(),
    );
    expect(layout('tiers').toSorted()).toEqual(
      ['5/8', '10/11', '13/16', '23/24', '27/30', '33/36'].toSorted(),
    );
    expect(layout('orphelins').toSorted()).toEqual(
      ['1', '6/9', '14/17', '17/20', '31/34'].toSorted(),
    );
    expect(layout('jeu0').toSorted()).toEqual(['0/3', '12/15', '26', '32/35'].toSorted());
  });

  it('cover exactly their sectors of the wheel', () => {
    const voisins = sector(22, 25);
    const tiers = sector(27, 33);
    expect(voisins).toHaveLength(17);
    expect(voisins).toContain(0);
    expect(tiers).toHaveLength(12);
    expect(covered(layout('voisins'))).toEqual(voisins);
    expect(covered(layout('tiers'))).toEqual(tiers);
    expect(covered(layout('jeu0'))).toEqual(sector(12, 15));
    const rest = ALL.filter((n) => !voisins.includes(n) && !tiers.includes(n));
    expect(rest).toHaveLength(8);
    expect(covered(layout('orphelins'))).toEqual(rest);
  });

  it('only put chips on legal bets', () => {
    const all = ['voisins', 'tiers', 'orphelins', 'jeu0'].map((label) =>
      announcedBetByLabel(label),
    );
    for (const bet of [...all, ...ALL.map((n) => neighbours(n))]) {
      if (bet === undefined) throw new Error('an announced bet is missing');
      for (const chip of bet.chips) {
        expect(tableBetFor(chip)?.numbers, `${bet.label}: ${chip.join('/')}`).toEqual(chip);
      }
    }
  });

  it('put neighbours nX straight up on X and the two numbers on each side of it', () => {
    expect(neighbours(17).chips).toEqual([[2], [25], [17], [34], [6]]);
    expect(neighbours(0).chips).toEqual([[3], [26], [0], [32], [15]]);
    expect(neighbours(26).chips).toEqual([[35], [3], [26], [0], [32]]);
    expect(neighbours(32).chips).toEqual([[26], [0], [32], [15], [19]]);
    for (const n of ALL) {
      const numbers = neighbours(n).chips.flat();
      const start = WHEEL_ORDER.indexOf(numbers[0] ?? -1);
      expect(numbers[2], `n${n}`).toBe(n);
      expect(numbers, `n${n}`).toEqual(
        [0, 1, 2, 3, 4].map((offset) => WHEEL_ORDER[(start + offset) % WHEEL_ORDER.length]),
      );
    }
  });
});

describe('placing an announced bet', () => {
  it('splits the amount evenly over its chips and counts as one bet', () => {
    const [voisins] = bets('18:voisins');
    expect(voisins).toEqual({
      label: 'voisins',
      kind: 'voisins',
      chips: layout('voisins').map((chip) => ({ numbers: chip.split('/').map(Number), amount: 2 })),
      amount: 18,
      countsAs: 1,
    });
    expect(bets('12:tiers')[0]).toMatchObject({ kind: 'tiers', amount: 12, countsAs: 1 });
    expect(bets('10:orphelins')[0]).toMatchObject({ kind: 'orphelins', amount: 10 });
    expect(bets('8:jeu0')[0]).toMatchObject({ kind: 'jeuZero', label: 'jeu0', amount: 8 });
    expect(bets('12:TIERS')).toEqual(bets('12:tiers'));
  });

  it('places neighbours nX for every number, 0 included', () => {
    for (const n of ALL) {
      const [bet] = bets(`10:n${n}`);
      expect(bet, `n${n}`).toEqual({
        label: `n${n}`,
        kind: 'neighbours',
        chips: neighbours(n).chips.map((numbers) => ({ numbers, amount: 2 })),
        amount: 10,
        countsAs: 1,
      });
    }
    expect(bets('10:N17')[0]?.label).toBe('n17');
  });

  it('rejects an explicit amount that does not divide by the number of chips', () => {
    expect(rejection('10:voisins')).toEqual([
      'rouletteNotation.announcedMultiple',
      { bet: 'voisins', chips: 9, example: 9 },
    ]);
    expect(rejection('100:voisins')).toEqual([
      'rouletteNotation.announcedMultiple',
      { bet: 'voisins', chips: 9, example: 99 },
    ]);
    expect(rejection('5:tiers')).toEqual([
      'rouletteNotation.announcedMultiple',
      { bet: 'tiers', chips: 6, example: 6 },
    ]);
    expect(rejection('12:orphelins')).toEqual([
      'rouletteNotation.announcedMultiple',
      { bet: 'orphelins', chips: 5, example: 10 },
    ]);
    expect(rejection('10:jeu0')).toEqual([
      'rouletteNotation.announcedMultiple',
      { bet: 'jeu0', chips: 4, example: 8 },
    ]);
    expect(rejection('12:n17')).toEqual([
      'rouletteNotation.announcedMultiple',
      { bet: 'n17', chips: 5, example: 10 },
    ]);
  });

  it('rounds a keyword amount down to a multiple of the number of chips', () => {
    const balance = (amount: number): AmountContext => ({ balance: amount, max: 1_000_000 });
    expect(bets('all:voisins', balance(1_000))[0]).toMatchObject({ amount: 999 });
    expect(bets('all:voisins', balance(1_000))[0]?.chips[0]).toMatchObject({ amount: 111 });
    expect(bets('half:tiers', balance(1_000))[0]).toMatchObject({ amount: 498 });
    expect(bets('max:orphelins', balance(1_003))[0]).toMatchObject({ amount: 1_000 });
    expect(bets('all:jeu0', balance(1_000))[0]).toMatchObject({ amount: 1_000 });
    expect(bets('all:n17', balance(14))[0]).toMatchObject({ amount: 10 });
    expect(bets('max:voisins', { balance: 5_000_000, max: 1_000_000 })[0]).toMatchObject({
      amount: 999_999,
    });
  });

  it('rejects a keyword amount that is too small for one coin per chip', () => {
    expect(rejection('all:voisins', { balance: 8, max: 1_000_000 })).toEqual([
      'rouletteNotation.announcedTooSmall',
      { amount: 'all', coins: '🪙 8', chips: 9, bet: 'voisins' },
    ]);
  });
});
