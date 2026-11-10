import { describe, expect, it } from 'vitest';
import { gameConfig } from '../../../src/config/game.js';
import {
  createSlotMachine,
  SYMBOLS,
  type Draw,
  type Reel,
  type Row,
  type SlotSymbol,
  type Stops,
} from '../../../src/games/slots/index.js';

const machine = createSlotMachine(gameConfig.slots);
const [left, middle, right] = machine.reels;

const SPEC_WEIGHTS: Readonly<Record<SlotSymbol, number>> = {
  cherry: 10,
  lemon: 7,
  orange: 6,
  grape: 4,
  bell: 3,
  diamond: 1,
  seven: 1,
};

const SPEC_THREE_OF_A_KIND: Readonly<Record<SlotSymbol, number>> = {
  seven: 100,
  diamond: 50,
  bell: 25,
  grape: 15,
  orange: 10,
  lemon: 8,
  cherry: 5,
};

interface ScriptedDraw extends Draw {
  readonly bounds: number[];
}

/** Returns the given stops in order and records every bound it was asked for. */
function scripted(...stops: number[]): ScriptedDraw {
  const bounds: number[] = [];
  const draw = (max: number): number => {
    bounds.push(max);
    const stop = stops.shift();
    if (stop === undefined) throw new Error('the scripted draw ran out of stops');
    return stop;
  };
  return Object.assign(draw, { bounds });
}

function stopOf(reel: Reel, symbol: SlotSymbol): number {
  const stop = reel.indexOf(symbol);
  if (stop === -1) throw new Error(`no ${symbol} on the reel`);
  return stop;
}

function symbolOn(reel: Reel, stop: number): SlotSymbol {
  const symbol = reel[stop];
  if (symbol === undefined) throw new Error(`no stop ${stop} on the reel`);
  return symbol;
}

/** The SPEC §8 paytable, written out independently of the machine. */
function specMultiplier(line: Row): number {
  const [a, b, c] = line;
  if (a === b && b === c) return SPEC_THREE_OF_A_KIND[a];
  return line.filter((symbol) => symbol === 'cherry').length === 2 ? 3 : 0;
}

function* everyLine(): Generator<Row> {
  for (const a of SYMBOLS) for (const b of SYMBOLS) for (const c of SYMBOLS) yield [a, b, c];
}

/** The distances from each copy of `symbol` to the next one, going round the reel. */
function gapsBetween(reel: Reel, symbol: SlotSymbol): number[] {
  const stops = reel.flatMap((at, stop) => (at === symbol ? [stop] : []));
  return stops.map((stop, index) => {
    const next = stops[(index + 1) % stops.length] ?? stop;
    return next > stop ? next - stop : next + reel.length - stop;
  });
}

describe('reels (SPEC §8)', () => {
  it('has three reels of 32 stops, each with every symbol as often as its weight', () => {
    expect(machine.reels).toHaveLength(3);
    for (const reel of machine.reels) {
      expect(reel).toHaveLength(32);
      const counts = Object.fromEntries(
        SYMBOLS.map((symbol) => [symbol, reel.filter((at) => at === symbol).length]),
      );
      expect(counts).toEqual(SPEC_WEIGHTS);
    }
  });

  it('spreads every symbol around the reel: each gap is less than 3 stops off an even spacing', () => {
    for (const reel of machine.reels) {
      for (const symbol of SYMBOLS) {
        const evenSpacing = 32 / SPEC_WEIGHTS[symbol];
        for (const gap of gapsBetween(reel, symbol)) {
          expect(Math.abs(gap - evenSpacing), `${symbol} gap ${gap}`).toBeLessThan(3);
        }
      }
    }
  });

  it('rotates each reel differently: the same strip, starting at a different stop', () => {
    // The single diamond pins down how far each reel is turned.
    const offsets = machine.reels.map(
      (reel) => (stopOf(left, 'diamond') - stopOf(reel, 'diamond') + 32) % 32,
    );
    expect(new Set(offsets).size).toBe(3);
    machine.reels.forEach((reel, index) => {
      const offset = offsets[index] ?? 0;
      expect(reel).toEqual([...left.slice(offset), ...left.slice(0, offset)]);
    });
  });
});

describe('paytable (SPEC §8)', () => {
  it.each(SYMBOLS.map((symbol) => ({ symbol, multiplier: SPEC_THREE_OF_A_KIND[symbol] })))(
    'pays three of $symbol $multiplier×, stake included',
    ({ symbol, multiplier }) => {
      expect(machine.winOf([symbol, symbol, symbol])).toEqual({ symbol, count: 3, multiplier });
    },
  );

  it('pays 3× for exactly two cherries anywhere on the line', () => {
    for (const other of SYMBOLS.filter((symbol) => symbol !== 'cherry')) {
      const lines: Row[] = [
        ['cherry', 'cherry', other],
        ['cherry', other, 'cherry'],
        [other, 'cherry', 'cherry'],
      ];
      for (const line of lines) {
        expect(machine.winOf(line)).toEqual({ symbol: 'cherry', count: 2, multiplier: 3 });
      }
    }
  });

  it('pays exactly the SPEC paytable for all 343 symbol lines, and nothing else', () => {
    let paying = 0;
    for (const line of everyLine()) {
      const multiplier = specMultiplier(line);
      expect(machine.winOf(line)?.multiplier ?? 0, line.join(' ')).toBe(multiplier);
      if (multiplier > 0) paying += 1;
    }
    // 7 three-of-a-kind lines and 3 × 6 lines with two cherries.
    expect(paying).toBe(25);
  });
});

describe('spin', () => {
  it('draws one stop per reel, left to right, and pays the middle row', () => {
    const stops = [stopOf(left, 'bell'), stopOf(middle, 'bell'), stopOf(right, 'bell')];
    const draw = scripted(...stops);

    const spin = machine.spin(draw);

    expect(draw.bounds).toEqual([32, 32, 32]);
    expect(spin).toEqual({
      stops,
      line: ['bell', 'bell', 'bell'],
      win: { symbol: 'bell', count: 3, multiplier: 25 },
      multiplier: 25,
    });
  });

  it('pays nothing without a winning line', () => {
    const stops = [stopOf(left, 'cherry'), stopOf(middle, 'lemon'), stopOf(right, 'seven')];

    const spin = machine.spin(scripted(...stops));

    expect(spin.line).toEqual(['cherry', 'lemon', 'seven']);
    expect(spin.win).toBeNull();
    expect(spin.multiplier).toBe(0);
  });

  it.each([-1, 32, 1.5, Number.NaN])('rejects a drawn stop of %s', (stop) => {
    expect(() => machine.spin(scripted(0, stop, 0))).toThrow(RangeError);
  });
});

describe('window', () => {
  it('shows the stops above and below the payline, going round the reel', () => {
    expect(machine.window([0, 31, 5])).toEqual([
      [symbolOn(left, 31), symbolOn(middle, 30), symbolOn(right, 4)],
      [symbolOn(left, 0), symbolOn(middle, 31), symbolOn(right, 5)],
      [symbolOn(left, 1), symbolOn(middle, 0), symbolOn(right, 6)],
    ]);
  });

  it.each([-1, 32, 0.5])('rejects a stop of %s', (stop) => {
    expect(() => machine.window([0, stop, 0])).toThrow(RangeError);
  });

  it('shows the result on the reels that stopped and a random stop on the others', () => {
    const stops: Stops = [3, 14, 25];
    const result = machine.window(stops);
    const draw = scripted(7, 9);

    const frame = machine.frame(stops, 1, draw);

    expect(draw.bounds).toEqual([32, 32]);
    const randomStops = machine.window([3, 7, 9]);
    expect(frame).toEqual(randomStops);
    expect(frame.map((row) => row[0])).toEqual(result.map((row) => row[0]));
  });

  it('shows the result without drawing once every reel stopped', () => {
    const stops: Stops = [3, 14, 25];
    const draw = scripted();

    expect(machine.frame(stops, 3, draw)).toEqual(machine.window(stops));
    expect(draw.bounds).toEqual([]);
  });
});

describe('return to player (SPEC §8)', () => {
  const exact = machine.exactRtp();

  it('returns exactly 31,489 stakes over all 32,768 stop combinations: 96.10%', () => {
    expect(exact.combinations).toBe(32_768);
    expect(exact.returned).toBe(31_489);
    const rtp = exact.returned / exact.combinations;
    expect(rtp).toBeGreaterThanOrEqual(0.95);
    expect(rtp).toBeLessThanOrEqual(0.97);
    expect((rtp * 100).toFixed(2)).toBe('96.10');
  });

  it('wins on 8,252 of the 32,768 stop combinations: 25.18%', () => {
    expect(exact.wins).toBe(8_252);
    expect(((exact.wins / exact.combinations) * 100).toFixed(2)).toBe('25.18');
  });

  it('agrees with spin() played once on every stop combination', () => {
    let returned = 0;
    let wins = 0;
    for (let a = 0; a < 32; a += 1) {
      for (let b = 0; b < 32; b += 1) {
        for (let c = 0; c < 32; c += 1) {
          const { multiplier } = machine.spin(scripted(a, b, c));
          returned += multiplier;
          if (multiplier > 0) wins += 1;
        }
      }
    }
    expect({ returned, wins }).toEqual({ returned: exact.returned, wins: exact.wins });
  });
});

describe('settings', () => {
  const { weights, paytable } = gameConfig.slots;

  it.each([
    [
      'a fractional multiplier',
      { weights, paytable: [{ symbol: 'cherry', count: 2, multiplier: 2.5 }] },
    ],
    ['a multiplier of 0', { weights, paytable: [{ symbol: 'cherry', count: 2, multiplier: 0 }] }],
    ['a count above 3', { weights, paytable: [{ symbol: 'cherry', count: 4, multiplier: 3 }] }],
    ['a weight of 0', { weights: { ...weights, seven: 0 }, paytable }],
  ] as const)('rejects %s', (_, settings) => {
    expect(() => createSlotMachine(settings)).toThrow(RangeError);
  });
});
