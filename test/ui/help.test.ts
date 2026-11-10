import { describe, expect, it, vi } from 'vitest';
import { helpReply } from '../../src/ui/help.js';
import { textOf } from '../helpers/discord.js';

vi.mock('../../src/config/game.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/game.js')>();
  return {
    gameConfig: {
      ...real.gameConfig,
      stakes: { min: 25, max: 50_000 },
      daily: { base: 2_000, streakBonus: 250, maxStreakBonus: 1_000 },
    },
  };
});

describe('economy help', () => {
  it('takes every amount, day and limit from the game config', () => {
    const text = textOf(helpReply('en', 'economy'));

    expect(text).toMatch(/gives you \*\*🪙 2,000\*\* once a day/);
    expect(text).toMatch(/adds \*\*🪙 250\*\* to your gift, up to \*\*🪙 1,000\*\* extra/);
    expect(text).toMatch(/from day 5 on you get \*\*🪙 3,000\*\* a day/);
    expect(text).toMatch(/at least \*\*🪙 25\*\* and at most \*\*🪙 50,000\*\* per round/);
  });
});
