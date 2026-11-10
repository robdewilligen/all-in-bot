import type { AnnouncedBetKind } from './types.js';
import { neighboursOf } from './wheel.js';

/** An announced bet's layout: the numbers under each of its chips. */
export interface AnnouncedBet {
  readonly kind: AnnouncedBetKind;
  readonly label: string;
  /** One entry per chip, so voisins lists 0/2/3 twice. */
  readonly chips: readonly (readonly number[])[];
}

const NAMED: readonly AnnouncedBet[] = [
  {
    kind: 'voisins',
    label: 'voisins',
    chips: [
      [0, 2, 3],
      [0, 2, 3],
      [4, 7],
      [12, 15],
      [18, 21],
      [19, 22],
      [32, 35],
      [25, 26, 28, 29],
      [25, 26, 28, 29],
    ],
  },
  {
    kind: 'tiers',
    label: 'tiers',
    chips: [
      [5, 8],
      [10, 11],
      [13, 16],
      [23, 24],
      [27, 30],
      [33, 36],
    ],
  },
  {
    kind: 'orphelins',
    label: 'orphelins',
    chips: [[1], [6, 9], [14, 17], [17, 20], [31, 34]],
  },
  {
    kind: 'jeuZero',
    label: 'jeu0',
    chips: [[0, 3], [12, 15], [26], [32, 35]],
  },
];

const byLabel: ReadonlyMap<string, AnnouncedBet> = new Map(NAMED.map((bet) => [bet.label, bet]));

/** Voisins, tiers, orphelins or jeu zéro by its label (`jeu0` for jeu zéro). */
export function announcedBetByLabel(label: string): AnnouncedBet | undefined {
  return byLabel.get(label);
}

/** Neighbours `nX`: X and the two numbers on each side of it on the wheel, straight up. */
export function neighbours(n: number): AnnouncedBet {
  return {
    kind: 'neighbours',
    label: `n${n}`,
    chips: neighboursOf(n, 2).map((pocket) => [pocket]),
  };
}
