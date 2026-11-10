import { Colors, type EmbedBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { gameConfig } from '../../src/config/game.js';
import type { InstantResult } from '../../src/core/wallet.js';
import {
  createSlotMachine,
  type Row,
  type SlotSpin,
  type Stops,
} from '../../src/games/slots/index.js';
import { t } from '../../src/i18n/index.js';
import { slotsHelpEmbed, slotsResultEmbed, slotsSpinningEmbed } from '../../src/ui/slots.js';
import { textOf } from '../helpers/discord.js';

const machine = createSlotMachine(gameConfig.slots);

function stopsShowing([a, b, c]: Row): Stops {
  const [left, middle, right] = machine.reels;
  return [left.indexOf(a), middle.indexOf(b), right.indexOf(c)];
}

/** A spin whose payline shows `line`, settled as the wallet hands it back. */
function settled(line: Row, stake: number, balanceBefore: number): InstantResult<SlotSpin> {
  const stops = [...stopsShowing(line)];
  const details = machine.spin(() => stops.shift() ?? -1);
  const payout = stake * details.multiplier;
  return { roundId: 7, stake, payout, balance: balanceBefore - stake + payout, details };
}

function view(embed: EmbedBuilder): { color: number | undefined; text: string } {
  return { color: embed.toJSON().color, text: textOf({ embeds: [embed] }) };
}

function resultView(
  line: Row,
  stake = 100,
  balanceBefore = 10_000,
): { color: number | undefined; text: string } {
  const result = settled(line, stake, balanceBefore);
  return view(slotsResultEmbed('en-US', machine.window(result.details.stops), result));
}

describe('the result (SPEC §8)', () => {
  it('shows the payline, the combination and the numbers, in green for a win', () => {
    const { color, text } = resultView(['bell', 'bell', 'bell']);

    expect(color).toBe(Colors.Green);
    expect(text).toMatch(/^🔔 🔔 🔔 ⬅️$/m);
    expect(text).toMatch(/^\*\*3× 🔔 pays 25×\*\*$/m);
    expect(text).not.toMatch(/JACKPOT/);
    expect(text).toMatch(/^Bet\n🪙 100$/m);
    expect(text).toMatch(/^Winnings\n🪙 2,500$/m);
    expect(text).toMatch(/^Balance\n🪙 12,400$/m);
    expect(text).toMatch(/^Net result\n\+🪙 2,400$/m);
  });

  it('shows exactly two cherries as a 3× win', () => {
    const { color, text } = resultView(['cherry', 'lemon', 'cherry'], 50, 1_000);

    expect(color).toBe(Colors.Green);
    expect(text).toMatch(/^🍒 🍋 🍒 ⬅️$/m);
    expect(text).toMatch(/^\*\*2× 🍒 pays 3×\*\*$/m);
    expect(text).toMatch(/^Winnings\n🪙 150$/m);
    expect(text).toMatch(/^Net result\n\+🪙 100$/m);
  });

  it.each([
    ['diamond', '💎', '50'],
    ['seven', '7️⃣', '100'],
  ] as const)('calls three of %s a JACKPOT, from 50× up', (symbol, emoji, multiplier) => {
    const { text } = resultView([symbol, symbol, symbol]);

    expect(text).toMatch(
      new RegExp(`^🎉 \\*\\*JACKPOT!\\*\\* 3× ${emoji} pays ${multiplier}×$`, 'mu'),
    );
  });

  it('shows a loss in red, with what it cost', () => {
    const { color, text } = resultView(['cherry', 'lemon', 'seven'], 250, 1_000);

    expect(color).toBe(Colors.Red);
    expect(text).toMatch(/^🍒 🍋 7️⃣ ⬅️$/mu);
    expect(text).toMatch(/^No win this time\.$/m);
    expect(text).toMatch(/^Bet\n🪙 250$/m);
    expect(text).toMatch(/^Winnings\n🪙 0$/m);
    expect(text).toMatch(/^Balance\n🪙 750$/m);
    expect(text).toMatch(/^Net result\n-🪙 250$/m);
  });

  it('shows break-even in grey', () => {
    const stops: Stops = [0, 0, 0];
    const result: InstantResult<SlotSpin> = {
      roundId: 7,
      stake: 100,
      payout: 100,
      balance: 1_000,
      details: {
        stops,
        line: machine.window(stops)[1],
        win: { symbol: 'lemon', count: 2, multiplier: 1 },
        multiplier: 1,
      },
    };

    const { color, text } = view(slotsResultEmbed('en-US', machine.window(stops), result));

    expect(color).toBe(Colors.Grey);
    expect(text).toMatch(/^Net result\n🪙 0$/m);
  });
});

describe('the reveal', () => {
  it('shows the reels spinning in blurple, with the bet', () => {
    const window = machine.window([0, 10, 20]);
    const rows = window.map((row) =>
      row.map((symbol) => t('en-US', `slots.symbols.${symbol}`)).join(' '),
    );

    const { color, text } = view(slotsSpinningEmbed('en-US', window, 1_500));

    expect(color).toBe(Colors.Blurple);
    expect(text.split('\n').slice(1, 4)).toEqual([rows[0], `${rows[1] ?? ''} ⬅️`, rows[2]]);
    expect(text).toMatch(/^Spinning…$/m);
    expect(text).toMatch(/^Bet\n🪙 1,500$/m);
  });
});

describe('help (SPEC §9)', () => {
  it('lists the paytable and the exact payout percentage', () => {
    const text = textOf({ embeds: [slotsHelpEmbed('en-US')] });

    expect(text).toContain(
      [
        'Paytable',
        '7️⃣ 7️⃣ 7️⃣ · **100×**',
        '💎 💎 💎 · **50×**',
        '🔔 🔔 🔔 · **25×**',
        '🍇 🍇 🍇 · **15×**',
        '🍊 🍊 🍊 · **10×**',
        '🍋 🍋 🍋 · **8×**',
        '🍒 🍒 🍒 · **5×**',
        '🍒 🍒 anywhere on the payline · **3×**',
      ].join('\n'),
    );
    expect(text).toMatch(/pays back \*\*96\.10%\*\* of all bets, and \*\*25\.18%\*\* of spins win/);
  });

  it('works the payout percentage out from the configured machine', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/game.js', () => ({
      gameConfig: {
        ...gameConfig,
        slots: { ...gameConfig.slots, paytable: [{ symbol: 'cherry', count: 3, multiplier: 5 }] },
      },
    }));
    try {
      const fresh = await import('../../src/ui/slots.js');
      const text = textOf({ embeds: [fresh.slotsHelpEmbed('en-US')] });

      // 10 × 10 × 10 lines of three cherries, each paying 5: 5,000 of 32,768 stakes.
      expect(text).toMatch(/^🍒 🍒 🍒 · \*\*5×\*\*$/m);
      expect(text).not.toMatch(/7️⃣/u);
      expect(text).toMatch(
        /pays back \*\*15\.26%\*\* of all bets, and \*\*3\.05%\*\* of spins win/,
      );
    } finally {
      vi.doUnmock('../../src/config/game.js');
      vi.resetModules();
    }
  });
});
