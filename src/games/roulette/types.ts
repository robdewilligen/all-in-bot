/** The ten kinds among the 157 bets on the layout. */
export type TableBetKind =
  | 'straight'
  | 'split'
  | 'street'
  | 'trio'
  | 'corner'
  | 'firstFour'
  | 'sixLine'
  | 'dozen'
  | 'column'
  | 'evenMoney';

/** Announced bets: several chips on table bets, placed and settled as one bet. */
export type AnnouncedBetKind = 'voisins' | 'tiers' | 'orphelins' | 'jeuZero' | 'neighbours';

export type BetKind = TableBetKind | AnnouncedBetKind;

/** One chip on the layout. */
export interface Chip {
  /** The numbers it covers, ascending: always one of the 157 table bets. */
  readonly numbers: readonly number[];
  readonly amount: number;
}

/** One bet as the player placed it. */
export interface RouletteBet {
  /** Canonical notation for the result line: `17`, `17/20`, `13-15`, `red`, `d1`, `voisins`, `n17`. */
  readonly label: string;
  readonly kind: BetKind;
  /** One chip for a table bet; an announced bet has one per chip of its layout (voisins: 9). */
  readonly chips: readonly Chip[];
  /** The total stake: the sum of the chips. */
  readonly amount: number;
  /** What it counts toward the bet limit: 1, also for an announced bet. */
  readonly countsAs: number;
}

export type RouletteColor = 'red' | 'black' | 'green';

export interface SettledBet {
  readonly bet: RouletteBet;
  /** At least one chip covers the result. */
  readonly won: boolean;
  /** What the bet returns, stake included; 0 when it lost. */
  readonly payout: number;
}
