import { Colors } from 'discord.js';
import { describe, expect, it } from 'vitest';
import balance from '../../src/commands/economy/balance.js';
import type { Wallet } from '../../src/core/wallet.js';
import { fakeContext, type FakeContext } from '../helpers/context.js';
import {
  GUILD_ID,
  USER_ID,
  embedsOf,
  fakeChatInput,
  fakeUser,
  isEphemeral,
  textOf,
} from '../helpers/discord.js';

const OTHER_ID = '200000000000000002';

function calledWalletMethods(context: FakeContext): (keyof Wallet)[] {
  return (Object.keys(context.wallet) as (keyof Wallet)[]).filter(
    (method) => context.wallet[method].mock.calls.length > 0,
  );
}

describe('/balance', () => {
  it("shows the caller's balance and rank publicly in blurple", async () => {
    const context = fakeContext();
    context.wallet.standingOf.mockResolvedValue({ balance: 5_400, rank: 4 });
    const { interaction, calls } = fakeChatInput('balance');

    await balance.execute(interaction, context);

    expect(context.wallet.standingOf.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: USER_ID }],
    ]);
    expect(calls.map((call) => call.method)).toEqual(['reply']);
    const options = calls[0]?.options;
    expect(isEphemeral(options)).toBe(false);
    expect(embedsOf(options).map((embed) => embed.color)).toEqual([Colors.Blurple]);
    expect(textOf(options)).toMatch(
      /^<@200000000000000001> has \*\*🪙 5,400\*\* and is \*\*#4\*\* on the leaderboard\.$/m,
    );
  });

  it('looks up another player as a mention, without writing anything for them', async () => {
    const context = fakeContext();
    context.wallet.standingOf.mockResolvedValue({ balance: 1_234_567, rank: 1 });
    const { interaction, calls } = fakeChatInput('balance', {
      users: { player: fakeUser(OTHER_ID, 'bob') },
    });

    await balance.execute(interaction, context);

    expect(context.wallet.standingOf.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: OTHER_ID }],
    ]);
    expect(calledWalletMethods(context)).toEqual(['standingOf']);
    expect(textOf(calls[0]?.options)).toMatch(
      /^<@200000000000000002> has \*\*🪙 1,234,567\*\* and is \*\*#1\*\* on the leaderboard\.$/m,
    );
  });

  it('shows a player without a rank as unranked', async () => {
    const context = fakeContext();
    context.wallet.standingOf.mockResolvedValue({ balance: 0, rank: null });
    const { interaction, calls } = fakeChatInput('balance', {
      users: { player: fakeUser(OTHER_ID, 'bob') },
    });

    await balance.execute(interaction, context);

    const text = textOf(calls[0]?.options);
    expect(text).toMatch(/^<@200000000000000002> has \*\*🪙 0\*\* and is unranked\.$/m);
    expect(text).not.toMatch(/#/);
  });
});
