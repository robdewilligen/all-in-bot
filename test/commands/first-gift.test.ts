import { Colors, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import firstGift from '../../src/commands/economy/first-gift.js';
import { fakeContext } from '../helpers/context.js';
import {
  GUILD_ID,
  USER_ID,
  embedsOf,
  fakeChatInput,
  isEphemeral,
  textOf,
} from '../helpers/discord.js';

describe('/first-gift', () => {
  it('claims for the caller in this server, with their display name', async () => {
    const context = fakeContext();
    context.wallet.claimFirstGift.mockResolvedValue({
      status: 'claimed',
      amount: 1_000,
      balance: 1_250,
    });
    const { interaction } = fakeChatInput('first-gift', { displayName: 'Alice' });

    await firstGift.execute(interaction, context);

    expect(context.wallet.claimFirstGift.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: USER_ID, displayName: 'Alice' }],
    ]);
  });

  it('shows a claim publicly in gold, with the amount and the new balance', async () => {
    const context = fakeContext();
    context.wallet.claimFirstGift.mockResolvedValue({
      status: 'claimed',
      amount: 1_000,
      balance: 1_250,
    });
    const { interaction, calls } = fakeChatInput('first-gift');

    await firstGift.execute(interaction, context);

    expect(calls.map((call) => call.method)).toEqual(['reply']);
    const options = calls[0]?.options;
    expect(isEphemeral(options)).toBe(false);
    expect(embedsOf(options).map((embed) => embed.color)).toEqual([Colors.Gold]);
    const text = textOf(options);
    expect(text).toMatch(/^🎁 First gift$/m);
    expect(text).toMatch(/^<@200000000000000001> got a head start of \*\*🪙 1,000\*\*\.$/m);
    expect(text).toMatch(/^Balance\n🪙 1,250$/m);
  });

  it('tells only the player that they already got it in this server', async () => {
    const context = fakeContext();
    context.wallet.claimFirstGift.mockResolvedValue({ status: 'alreadyClaimed' });
    const { interaction, calls } = fakeChatInput('first-gift');

    await firstGift.execute(interaction, context);

    expect(calls).toEqual([
      {
        method: 'reply',
        options: {
          content:
            'You already got your first gift in this server. `/dailygift` gives you more every day.',
          flags: MessageFlags.Ephemeral,
        },
      },
    ]);
  });
});
