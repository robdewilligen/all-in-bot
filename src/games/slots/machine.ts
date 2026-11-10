import { buildReels, type Reel, type Reels, type ReelWeights, type SlotSymbol } from './reels.js';

/** Returns a whole number from 0 to max - 1. The bot passes crypto.randomInt. */
export type Draw = (max: number) => number;

/** Exactly `count` of `symbol` anywhere on the payline pays `multiplier` × stake, stake included. */
export interface PaytableLine {
  readonly symbol: SlotSymbol;
  readonly count: number;
  readonly multiplier: number;
}

export interface SlotSettings {
  readonly weights: ReelWeights;
  readonly paytable: readonly PaytableLine[];
}

type Triple<T> = readonly [T, T, T];

/** Per reel, from left to right, the stop on the payline. */
export type Stops = Triple<number>;

export type Row = Triple<SlotSymbol>;

/** The rows from top to bottom; the middle one is the payline. */
export type SlotWindow = readonly [Row, Row, Row];

export const PAYLINE_ROW = 1;

export interface SlotSpin {
  readonly stops: Stops;
  readonly line: Row;
  readonly win: PaytableLine | null;
  /** The payout per coin staked, stake included; 0 without a win. */
  readonly multiplier: number;
}

/** Totals over every stop combination, each played once. */
export interface ExactRtp {
  readonly combinations: number;
  /** All payouts together, in stakes. */
  readonly returned: number;
  /** Combinations that pay. */
  readonly wins: number;
}

export interface SlotMachine {
  readonly reels: Reels;
  readonly paytable: readonly PaytableLine[];
  spin(draw: Draw): SlotSpin;
  /** The best-paying paytable line on this payline, or null. */
  winOf(line: Row): PaytableLine | null;
  window(stops: Stops): SlotWindow;
  /** The window while the reels stop: the first `stopped` show `stops`, the others a random stop. */
  frame(stops: Stops, stopped: number, draw: Draw): SlotWindow;
  exactRtp(): ExactRtp;
}

function assertWhole(value: number, min: number, max: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${what} must be a whole number from ${min} to ${max}, got ${value}`);
  }
}

function eachReel<T, U>([a, b, c]: Triple<T>, map: (value: T, reel: number) => U): Triple<U> {
  return [map(a, 0), map(b, 1), map(c, 2)];
}

function zip<A, B>([a1, a2, a3]: Triple<A>, [b1, b2, b3]: Triple<B>): Triple<readonly [A, B]> {
  return [
    [a1, b1],
    [a2, b2],
    [a3, b3],
  ];
}

function assertStop(reel: Reel, stop: number): void {
  assertWhole(stop, 0, reel.length - 1, `A stop on a reel of ${reel.length}`);
}

/** The symbol `offset` stops past `stop`, going round the reel. */
function symbolAt(reel: Reel, stop: number, offset: number): SlotSymbol {
  const symbol = reel[(stop + offset + reel.length) % reel.length];
  if (symbol === undefined) throw new RangeError(`A reel of ${reel.length} has no stop ${stop}`);
  return symbol;
}

function drawStop(reel: Reel, draw: Draw): number {
  const stop = draw(reel.length);
  assertStop(reel, stop);
  return stop;
}

export function createSlotMachine(settings: SlotSettings): SlotMachine {
  for (const [symbol, weight] of Object.entries(settings.weights)) {
    assertWhole(weight, 1, Number.MAX_SAFE_INTEGER, `The weight of ${symbol}`);
  }
  for (const { symbol, count, multiplier } of settings.paytable) {
    assertWhole(count, 1, 3, `The count of the ${symbol} line`);
    // Whole multipliers keep every payout a whole number of coins.
    assertWhole(multiplier, 1, Number.MAX_SAFE_INTEGER, `The multiplier of the ${symbol} line`);
  }
  const reels = buildReels(settings.weights);
  const { paytable } = settings;

  const rowAt = (stops: Stops, offset: number): Row =>
    eachReel(zip(reels, stops), ([reel, stop]) => symbolAt(reel, stop, offset));

  const window = (stops: Stops): SlotWindow => {
    for (const [reel, stop] of zip(reels, stops)) assertStop(reel, stop);
    return [rowAt(stops, -1), rowAt(stops, 0), rowAt(stops, 1)];
  };

  const winOf = (line: Row): PaytableLine | null => {
    let best: PaytableLine | null = null;
    for (const pay of paytable) {
      let count = 0;
      for (const symbol of line) if (symbol === pay.symbol) count += 1;
      if (count === pay.count && (best === null || pay.multiplier > best.multiplier)) best = pay;
    }
    return best === null
      ? null
      : { symbol: best.symbol, count: best.count, multiplier: best.multiplier };
  };

  return {
    reels,
    paytable,
    winOf,
    window,

    spin(draw) {
      const stops = eachReel(reels, (reel) => drawStop(reel, draw));
      const line = rowAt(stops, 0);
      const win = winOf(line);
      return { stops, line, win, multiplier: win?.multiplier ?? 0 };
    },

    frame(stops, stopped, draw) {
      return window(
        eachReel(zip(reels, stops), ([reel, stop], index) =>
          index < stopped ? stop : drawStop(reel, draw),
        ),
      );
    },

    exactRtp() {
      const [left, middle, right] = reels;
      let returned = 0;
      let wins = 0;
      for (const a of left) {
        for (const b of middle) {
          for (const c of right) {
            const win = winOf([a, b, c]);
            if (win !== null) {
              returned += win.multiplier;
              wins += 1;
            }
          }
        }
      }
      return { combinations: left.length * middle.length * right.length, returned, wins };
    },
  };
}
