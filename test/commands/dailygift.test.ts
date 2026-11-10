import { Colors } from 'discord.js';
import { describe, expect, it } from 'vitest';
import dailygift from '../../src/commands/economy/dailygift.js';
import { FIXED_NOW, fakeContext } from '../helpers/context.js';
import {
  GUILD_ID,
  USER_ID,
  embedsOf,
  fakeChatInput,
  isEphemeral,
  textOf,
} from '../helpers/discord.js';

// Midnight in Amsterdam after FIXED_NOW.
const NEXT_RESET = Temporal.Instant.from('2026-11-09T23:00:00Z');
const RESET_TIMESTAMP = '<t:1794265200:R>';

describe('/dailygift', () => {
  it('claims for the caller, with their display name, at the current time', async () => {
    const context = fakeContext();
    context.wallet.claimDaily.mockResolvedValue({
      status: 'claimed',
      amount: 1_000,
      streak: 1,
      balance: 1_000,
      nextReset: NEXT_RESET,
    });
    const { interaction } = fakeChatInput('dailygift', { displayName: 'Alice' });

    await dailygift.execute(interaction, context);

    expect(context.wallet.claimDaily.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: USER_ID, displayName: 'Alice' }, FIXED_NOW],
    ]);
  });

  it('shows a claim publicly in gold: amount, streak, new balance and the next reset', async () => {
    const context = fakeContext();
    context.wallet.claimDaily.mockResolvedValue({
      status: 'claimed',
      amount: 1_200,
      streak: 3,
      balance: 5_400,
      nextReset: NEXT_RESET,
    });
    const { interaction, calls } = fakeChatInput('dailygift');

    await dailygift.execute(interaction, context);

    expect(calls.map((call) => call.method)).toEqual(['reply']);
    const options = calls[0]?.options;
    expect(isEphemeral(options)).toBe(false);
    expect(embedsOf(options).map((embed) => embed.color)).toEqual([Colors.Gold]);
    const text = textOf(options);
    expect(text).toMatch(/^<@200000000000000001> claimed \*\*🪙 1,200\*\*\.$/m);
    expect(text).toMatch(/^Streak\nDay 3$/m);
    expect(text).toMatch(/^Balance\n🪙 5,400$/m);
    expect(text).toMatch(/^Next gift\n<t:1794265200:R>$/m);
  });

  it('answers a second claim on the same day ephemerally with the next reset, not as a gift', async () => {
    const context = fakeContext();
    context.wallet.claimDaily.mockResolvedValue({
      status: 'alreadyClaimed',
      nextReset: NEXT_RESET,
    });
    const { interaction, calls } = fakeChatInput('dailygift');

    await dailygift.execute(interaction, context);

    expect(calls.map((call) => call.method)).toEqual(['reply']);
    const options = calls[0]?.options;
    expect(isEphemeral(options)).toBe(true);
    expect(embedsOf(options)).toEqual([]);
    expect(textOf(options)).toBe(
      `You've already claimed today's gift. Your next gift is ready ${RESET_TIMESTAMP}.`,
    );
  });
});
