import { Colors } from 'discord.js';
import { describe, expect, it } from 'vitest';
import help from '../../src/commands/general/help.js';
import { embedsOf, fakeChatInput, isEphemeral, textOf } from '../helpers/discord.js';

async function helpFor(topic?: string): Promise<{ options: unknown; methods: string[] }> {
  const { interaction, calls } = fakeChatInput(
    'help',
    topic === undefined ? {} : { strings: { topic } },
  );
  await help.execute(interaction);
  return { options: calls[0]?.options, methods: calls.map((call) => call.method) };
}

function expectOverview(text: string): void {
  expect(text).toMatch(/^`\/dailygift` · Claim today's coins$/m);
  expect(text).toMatch(/^`\/balance` · Balance and leaderboard position$/m);
  expect(text).toMatch(/^`\/leaderboard` · Players with the most coins in this server$/m);
  expect(text).toMatch(/^`\/help` · Rules, notation and payouts$/m);
  expect(text).toMatch(/^`\/help topic:economy` · Daily gift, streaks, limits and amounts$/m);
}

describe('/help', () => {
  it('gives an ephemeral overview of the commands without a topic', async () => {
    const { options, methods } = await helpFor();

    expect(methods).toEqual(['reply']);
    expect(isEphemeral(options)).toBe(true);
    expect(embedsOf(options).map((embed) => embed.color)).toEqual([Colors.Blurple]);
    expectOverview(textOf(options));
  });

  it('explains the economy ephemerally, with the daily amounts and stake limits', async () => {
    const { options, methods } = await helpFor('economy');

    expect(methods).toEqual(['reply']);
    expect(isEphemeral(options)).toBe(true);
    expect(embedsOf(options).map((embed) => embed.color)).toEqual([Colors.Blurple]);
    const text = textOf(options);
    expect(text).toMatch(/gives you \*\*🪙 1,000\*\* once a day/);
    expect(text).toMatch(/starts at midnight/);
    expect(text).toMatch(/adds \*\*🪙 100\*\* to your gift, up to \*\*🪙 700\*\* extra/);
    expect(text).toMatch(/from day 8 on you get \*\*🪙 1,700\*\* a day/);
    expect(text).toMatch(/Miss a day and your streak starts over/);
    expect(text).toMatch(/at least \*\*🪙 10\*\* and at most \*\*🪙 1,000,000\*\* per round/);
    expect(text).toMatch(/`1\.5k`, `1,5k`, `2k`, `1m`/);
    expect(text).toMatch(/`all` \(or `all-in`, `allin`, `alles`\)/);
    expect(text).toMatch(/`max` bets your balance up to the maximum stake/);
    expect(text).toMatch(/`half` \(or `helft`\) bets half your balance, rounded down/);
  });

  it('falls back to the overview for a topic this version does not know', async () => {
    const { options } = await helpFor('roulette');

    expect(isEphemeral(options)).toBe(true);
    expectOverview(textOf(options));
  });
});
