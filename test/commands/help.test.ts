import { Colors } from 'discord.js';
import { describe, expect, it } from 'vitest';
import help from '../../src/commands/general/help.js';
import { t } from '../../src/i18n/index.js';
import { blackjackHelpEmbed } from '../../src/ui/blackjack.js';
import { rouletteHelpEmbed } from '../../src/ui/roulette.js';
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
  const lines = text.split('\n');
  expect(lines).toContain(`\`/roulette\` · ${t('en-US', 'roulette.command.description')}`);
  expect(lines).toContain(`\`/blackjack\` · ${t('en-US', 'blackjack.command.description')}`);
  expect(lines).toContain(`\`/create-table\` · ${t('en-US', 'tables.command.description')}`);
  expect(text).toMatch(/^`\/help topic:economy` · Daily gift, streaks, limits and amounts$/m);
  expect(text).toMatch(/^`\/help topic:roulette` · /m);
  expect(text).toMatch(/^`\/help topic:blackjack` · /m);
  expect(text).toMatch(/each table is a thread/);
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
    const { options } = await helpFor('poker');

    expect(isEphemeral(options)).toBe(true);
    expectOverview(textOf(options));
  });

  it('shows the roulette and blackjack topics ephemerally', async () => {
    const roulette = await helpFor('roulette');
    const blackjack = await helpFor('blackjack');

    expect([roulette, blackjack].map(({ options }) => isEphemeral(options))).toEqual([true, true]);
    expect(embedsOf(roulette.options)[0]?.title).toBe(rouletteHelpEmbed('en-US').toJSON().title);
    expect(embedsOf(blackjack.options)[0]?.title).toBe(blackjackHelpEmbed('en-US').toJSON().title);
  });
});
