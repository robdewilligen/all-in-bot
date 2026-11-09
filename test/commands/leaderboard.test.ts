import { Colors } from 'discord.js';
import { describe, expect, it } from 'vitest';
import leaderboard from '../../src/commands/economy/leaderboard.js';
import type { LeaderboardEntry, LeaderboardPage } from '../../src/core/wallet.js';
import { fakeContext } from '../helpers/context.js';
import {
  GUILD_ID,
  USER_ID,
  embedsOf,
  fakeChatInput,
  isEphemeral,
  textOf,
} from '../helpers/discord.js';

function entry(rank: number, displayName: string, balance: number): LeaderboardEntry {
  return { rank, userId: `2${String(rank).padStart(17, '0')}`, displayName, balance };
}

function page(
  entries: LeaderboardEntry[],
  overrides: Partial<LeaderboardPage> = {},
): LeaderboardPage {
  return { entries, page: 1, pageCount: 1, playerCount: entries.length, ...overrides };
}

describe('/leaderboard', () => {
  it("asks for the requested page and the caller's standing", async () => {
    const context = fakeContext();
    context.wallet.leaderboard.mockResolvedValue(page([entry(1, 'Alice', 100)]));
    context.wallet.standingOf.mockResolvedValue({ balance: 100, rank: 1 });
    const { interaction } = fakeChatInput('leaderboard', { integers: { page: 9 } });

    await leaderboard.execute(interaction, context);

    expect(context.wallet.leaderboard.mock.calls).toEqual([[GUILD_ID, 9]]);
    expect(context.wallet.standingOf.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: USER_ID }],
    ]);
  });

  it('asks for page 1 without a page option', async () => {
    const context = fakeContext();
    context.wallet.leaderboard.mockResolvedValue(page([entry(1, 'Alice', 100)]));
    context.wallet.standingOf.mockResolvedValue({ balance: 100, rank: 1 });
    const { interaction } = fakeChatInput('leaderboard');

    await leaderboard.execute(interaction, context);

    expect(context.wallet.leaderboard.mock.calls).toEqual([[GUILD_ID, 1]]);
  });

  it('lists rank, name and balance publicly in gold, with markdown in names escaped', async () => {
    const context = fakeContext();
    context.wallet.leaderboard.mockResolvedValue(
      page([
        entry(1, 'Alice', 12_345),
        entry(2, '**Bob**', 10_000),
        entry(3, '_under_score_', 10_000),
        entry(4, '[free coins](https://example.com)', 900),
      ]),
    );
    context.wallet.standingOf.mockResolvedValue({ balance: 12_345, rank: 1 });
    const { interaction, calls } = fakeChatInput('leaderboard');

    await leaderboard.execute(interaction, context);

    expect(calls.map((call) => call.method)).toEqual(['reply']);
    const options = calls[0]?.options;
    expect(isEphemeral(options)).toBe(false);
    const [embed] = embedsOf(options);
    expect(embed?.color).toBe(Colors.Gold);
    expect(embed?.description).toBe(
      [
        '**#1** Alice · 🪙 12,345',
        '**#2** \\*\\*Bob\\*\\* · 🪙 10,000',
        '**#3** \\_under\\_score\\_ · 🪙 10,000',
        '**#4** \\[free coins](https://example.com) · 🪙 900',
      ].join('\n'),
    );
  });

  it("shows the page the wallet returned, the number of players and the caller's rank", async () => {
    const context = fakeContext();
    const lastPage = [1_021, 1_022, 1_023, 1_024, 1_025].map((rank) =>
      entry(rank, `Player ${rank}`, 2_000 - rank),
    );
    context.wallet.leaderboard.mockResolvedValue(
      page(lastPage, { page: 103, pageCount: 103, playerCount: 1_025 }),
    );
    context.wallet.standingOf.mockResolvedValue({ balance: 40_000, rank: 4 });
    const { interaction, calls } = fakeChatInput('leaderboard', { integers: { page: 500 } });

    await leaderboard.execute(interaction, context);

    expect(embedsOf(calls[0]?.options)[0]?.footer?.text).toBe(
      'Page 103/103 · Players: 1,025 · Your rank: #4',
    );
  });

  it('shows the caller as unranked in the footer', async () => {
    const context = fakeContext();
    context.wallet.leaderboard.mockResolvedValue(page([entry(1, 'Alice', 100)]));
    context.wallet.standingOf.mockResolvedValue({ balance: 0, rank: null });
    const { interaction, calls } = fakeChatInput('leaderboard');

    await leaderboard.execute(interaction, context);

    expect(embedsOf(calls[0]?.options)[0]?.footer?.text).toBe(
      'Page 1/1 · Players: 1 · Your rank: unranked',
    );
  });

  it('gives an ephemeral notice instead of an empty list when nobody has coins', async () => {
    const context = fakeContext();
    context.wallet.leaderboard.mockResolvedValue(page([]));
    context.wallet.standingOf.mockResolvedValue({ balance: 0, rank: null });
    const { interaction, calls } = fakeChatInput('leaderboard');

    await leaderboard.execute(interaction, context);

    expect(calls.map((call) => call.method)).toEqual(['reply']);
    const options = calls[0]?.options;
    expect(isEphemeral(options)).toBe(true);
    expect(embedsOf(options)).toEqual([]);
    expect(textOf(options)).toBe(
      'Nobody is on the leaderboard yet. Claim your first coins with `/dailygift`!',
    );
  });
});
