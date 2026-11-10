/** Every symbol on the reels, from the most to the least common (SPEC §8). */
export const SYMBOLS = ['cherry', 'lemon', 'orange', 'grape', 'bell', 'diamond', 'seven'] as const;

export type SlotSymbol = (typeof SYMBOLS)[number];

/** How many stops of each reel show the symbol. */
export type ReelWeights = Readonly<Record<SlotSymbol, number>>;

/** A reel's stops in order; after the last stop comes the first again. */
export type Reel = readonly SlotSymbol[];

export type Reels = readonly [Reel, Reel, Reel];

/**
 * One strip with the symbols spread evenly: every stop takes the symbol that is furthest behind its
 * share of the stops so far (smooth weighted round-robin), the earlier one in SYMBOLS on a tie.
 */
export function buildStrip(weights: ReelWeights): Reel {
  const total = SYMBOLS.reduce((sum, symbol) => sum + weights[symbol], 0);
  const placed = new Map<SlotSymbol, number>();
  const strip: SlotSymbol[] = [];
  for (let stop = 1; stop <= total; stop += 1) {
    let next: SlotSymbol = SYMBOLS[0];
    let mostBehind = -Infinity;
    for (const symbol of SYMBOLS) {
      // How far behind its share the symbol is, times total, so it stays a whole number.
      const behind = stop * weights[symbol] - total * (placed.get(symbol) ?? 0);
      if (behind > mostBehind) {
        mostBehind = behind;
        next = symbol;
      }
    }
    placed.set(next, (placed.get(next) ?? 0) + 1);
    strip.push(next);
  }
  return strip;
}

function rotate(strip: Reel, offset: number): Reel {
  return [...strip.slice(offset), ...strip.slice(0, offset)];
}

/** Three reels of the same strip, each rotated a third further, so they don't line up stop by stop. */
export function buildReels(weights: ReelWeights): Reels {
  const strip = buildStrip(weights);
  const third = Math.floor(strip.length / 3);
  return [strip, rotate(strip, third), rotate(strip, 2 * third)];
}
