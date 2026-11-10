import { Colors, escapeMarkdown, type APIEmbed, type EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { gameConfig } from '../../src/config/game.js';
import { parseBets, settle, type RouletteBet } from '../../src/games/roulette/index.js';
import { t, translate } from '../../src/i18n/index.js';
import {
  rouletteBetsEmbed,
  rouletteBettingEmbed,
  rouletteCancelledEmbed,
  rouletteChoices,
  rouletteClosedEmbed,
  rouletteHelpEmbed,
  roulettePlayerResultEmbed,
  rouletteResultEmbed,
  rouletteRollingEmbed,
  type SeatView,
} from '../../src/ui/roulette.js';
import { textOf } from '../helpers/discord.js';

const SPINS_AT = Temporal.Instant.from('2026-11-09T12:00:30Z');
const COUNTDOWN = `<t:${SPINS_AT.epochMilliseconds / 1000}:R>`;
const URL = 'https://discord.com/channels/1/2/3';

function betsOf(input: string, balance = 10_000_000): RouletteBet[] {
  const parsed = parseBets(input, { balance, max: gameConfig.stakes.max });
  if (!parsed.ok) throw new Error(`"${input}" should parse: ${translate('en', parsed.error)}`);
  return parsed.bets;
}

function view(embed: EmbedBuilder): { color: number | undefined; text: string; json: APIEmbed } {
  const json = embed.toJSON();
  return { color: json.color, text: textOf({ embeds: [embed] }), json };
}

/** What Discord counts toward an embed's 6,000 characters. */
function embedLength(json: APIEmbed): number {
  const fields = (json.fields ?? []).reduce(
    (sum, field) => sum + field.name.length + field.value.length,
    0,
  );
  return (
    (json.title ?? '').length +
    (json.description ?? '').length +
    fields +
    (json.footer?.text ?? '').length +
    (json.author?.name ?? '').length
  );
}

function fieldValue(json: APIEmbed, name: string): string {
  const field = json.fields?.find((candidate) => candidate.name === name);
  if (field === undefined) throw new Error(`no field "${name}"`);
  return field.value;
}

const SEATS: SeatView[] = [
  { name: 'Alice', stake: 30, bets: 2 },
  { name: 'Bob', stake: 10, bets: 1 },
];

describe('the table message (SPEC §6)', () => {
  it('lists every player with their stake and bets, the total and the countdown, in blurple', () => {
    const { color, text } = view(rouletteBettingEmbed('en-US', SEATS, 20, SPINS_AT));

    expect(color).toBe(Colors.Blurple);
    expect(text).toMatch(/^Place your bets with `\/roulette`!$/m);
    expect(text).toMatch(/^\*\*Alice\*\* · 🪙 30 · 2 bets$/m);
    expect(text).toMatch(/^\*\*Bob\*\* · 🪙 10 · 1 bet$/m);
    expect(text).toMatch(/^Players\n2\/20$/m);
    expect(text).toMatch(/^Total stake\n🪙 40$/m);
    expect(text).toContain(`Wheel spins\n${COUNTDOWN}`);
  });

  it('escapes markdown in names, masked links included', () => {
    const name = '**Bob** [prize](https://example.com) `x`';
    const { text } = view(
      rouletteBettingEmbed('en-US', [{ name, stake: 10, bets: 1 }], 20, SPINS_AT),
    );

    expect(text).toContain(`**${escapeMarkdown(name, { maskedLink: true })}** · 🪙 10 · 1 bet`);
    expect(text).toContain('\\[prize](https://example.com)');
    expect(text).not.toMatch(/(?<!\\)\[prize\]/);
    expect(text).not.toContain('**Bob**');
  });

  it('shows the ball rolling with the players still listed', () => {
    const { color, text } = view(rouletteRollingEmbed('en-US', SEATS));

    expect(color).toBe(Colors.Blurple);
    expect(text).toMatch(/^The ball is rolling…$/m);
    expect(text).toMatch(/^\*\*Alice\*\* · 🪙 30 · 2 bets$/m);
    expect(text).toMatch(/^Total stake\n🪙 40$/m);
  });

  it("shows the result: the number in its colour, and each player's stake, payout and net", () => {
    const { text } = view(
      rouletteResultEmbed('en-US', 17, [
        { name: 'Alice', stake: 20, payout: 360 },
        { name: 'Bob', stake: 10, payout: 0 },
        { name: 'Cleo', stake: 18, payout: 18 },
      ]),
    );

    expect(text).toMatch(/^⚫ \*\*17\*\* Black$/mu);
    expect(text).toMatch(/^\*\*Alice\*\* · stake 🪙 20 · payout 🪙 360 · net \+🪙 340$/m);
    expect(text).toMatch(/^\*\*Bob\*\* · stake 🪙 10 · payout 🪙 0 · net -🪙 10$/m);
    expect(text).toMatch(/^\*\*Cleo\*\* · stake 🪙 18 · payout 🪙 18 · net 🪙 0$/m);
  });

  it.each([
    [0, '🟢 **0** Green'],
    [32, '🔴 **32** Red'],
    [26, '⚫ **26** Black'],
  ])('shows %i as %s', (result, line) => {
    const { text } = view(rouletteResultEmbed('en-US', result, []));

    expect(text.split('\n')).toContain(line);
  });

  it('says when a table closed for a restart', () => {
    expect(view(rouletteClosedEmbed('en-US', SEATS)).text).toMatch(
      /^This table closed because the bot is restarting\. Its stakes are refunded when the bot starts again\.$/m,
    );
  });

  it.each([
    ['refunded', 'Something went wrong, so this spin was cancelled. Every stake was refunded.'],
    [
      'pending',
      'Something went wrong, so this spin was cancelled. Every stake comes back automatically shortly.',
    ],
    [
      'settled',
      'Something went wrong while showing this spin, but it went through. Check `/balance` for your coins.',
    ],
  ] as const)('says what became of the stakes of a cancelled spin: %s', (refund, line) => {
    const { color, text } = view(rouletteCancelledEmbed('en-US', refund, SEATS));

    expect(color).toBe(Colors.Blurple);
    expect(text.split('\n')).toEqual([
      '🎡 Roulette',
      line,
      '',
      '**Alice** · 🪙 30 · 2 bets',
      '**Bob** · 🪙 10 · 1 bet',
    ]);
    expect(text).not.toMatch(/restart/);
  });
});

describe('embed limits', () => {
  // A 32-character display name of markdown characters doubles when escaped.
  const longest = '*_'.repeat(16);
  const seats = Array.from({ length: gameConfig.roulette.maxPlayers }, () => ({
    name: longest,
    stake: gameConfig.stakes.max,
    bets: gameConfig.roulette.maxBetsPerSpin,
  }));

  it('keeps every table message within Discord limits with 20 players at the maximum', () => {
    const results = seats.map(() => ({ name: longest, stake: 1_000_000, payout: 36_000_000 }));
    const embeds = [
      rouletteBettingEmbed('en-US', seats, 20, SPINS_AT),
      rouletteRollingEmbed('en-US', seats),
      rouletteResultEmbed('en-US', 36, results),
      rouletteClosedEmbed('en-US', seats),
      rouletteCancelledEmbed('en-US', 'settled', seats),
    ];

    for (const embed of embeds) {
      const { json, text } = view(embed);
      expect(json.description?.length).toBeLessThanOrEqual(4096);
      expect(embedLength(json)).toBeLessThanOrEqual(6000);
      expect(text.split('\n').filter((line) => line.startsWith('**'))).toHaveLength(20);
    }
  });

  it("keeps a player's confirmation and result within the limits with 30 of the longest bets", () => {
    const bets = betsOf(Array.from({ length: 30 }, () => '33,330:n36').join(' '));
    const settled = settle(bets, 36);
    const payout = settled.reduce((sum, bet) => sum + bet.payout, 0);
    const confirmation = view(
      rouletteBetsEmbed(
        'en-US',
        { bets, stake: 999_900, count: 30, spinsAt: SPINS_AT, url: URL },
        true,
      ),
    );
    const result = view(
      roulettePlayerResultEmbed('en-US', {
        result: 36,
        bets: settled,
        stake: 999_900,
        payout,
        balance: Number.MAX_SAFE_INTEGER,
      }),
    );

    for (const { json } of [confirmation, result]) {
      expect(json.description?.length).toBeLessThanOrEqual(4096);
      expect(embedLength(json)).toBeLessThanOrEqual(6000);
    }
    expect(result.text.match(/^✅ Neighbours of 36 · 🪙 33,330 → 🪙 239,976$/gmu)).toHaveLength(30);
  });
});

describe("a player's own result (SPEC §6)", () => {
  it('marks every bet won or lost with its payout, then the totals, balance and net, in green', () => {
    const settled = settle(betsOf('10:17, 10:red, 9:voisins, 5:n0, 50:orphelins'), 17);

    const { color, text } = view(
      roulettePlayerResultEmbed('en-US', {
        result: 17,
        bets: settled,
        stake: 84,
        payout: 720,
        balance: 10_636,
      }),
    );

    expect(color).toBe(Colors.Green);
    expect(text.split('\n').slice(1, 9)).toEqual([
      '⚫ **17** Black',
      '',
      '✅ `17` · 🪙 10 → 🪙 360',
      '❌ `red` · 🪙 10 → 🪙 0',
      '❌ Voisins du zéro · 🪙 9 → 🪙 0',
      '❌ Neighbours of 0 · 🪙 5 → 🪙 0',
      '✅ Orphelins · 🪙 50 → 🪙 360',
      'Total stake',
    ]);
    expect(text).toMatch(/^Total stake\n🪙 84$/m);
    expect(text).toMatch(/^Total payout\n🪙 720$/m);
    expect(text).toMatch(/^Balance\n🪙 10,636$/m);
    expect(text).toMatch(/^Net result\n\+🪙 636$/m);
  });

  it('shows a loss in red and break-even in grey', () => {
    const lost = view(
      roulettePlayerResultEmbed('en-US', {
        result: 0,
        bets: settle(betsOf('10:red'), 0),
        stake: 10,
        payout: 0,
        balance: 990,
      }),
    );
    const even = view(
      roulettePlayerResultEmbed('en-US', {
        result: 1,
        bets: settle(betsOf('10:red, 10:black'), 1),
        stake: 20,
        payout: 20,
        balance: 1_000,
      }),
    );

    expect(lost.color).toBe(Colors.Red);
    expect(lost.text).toMatch(/^Net result\n-🪙 10$/m);
    expect(even.color).toBe(Colors.Grey);
    expect(even.text).toMatch(/^Net result\n🪙 0$/m);
  });
});

describe('the confirmation (SPEC §6)', () => {
  const bets = betsOf('10:17, 2,500:red, 18:voisins, 6:tiers, 4:jeu0, 5:n17, 10:0-3');
  const placed = { bets, stake: 2_553, count: 7, spinsAt: SPINS_AT, url: URL };

  it('lists the bets so far by name, the total, the countdown and a link to the table', () => {
    const { color, json } = view(rouletteBetsEmbed('en-US', placed, false));

    expect(color).toBe(Colors.Blurple);
    expect(json.title).toBe('🎡 Your bets');
    expect(json.description?.split('\n')).toEqual([
      '🪙 10 on `17`',
      '🪙 2,500 on `red`',
      '🪙 18 on Voisins du zéro',
      '🪙 6 on Tiers du cylindre',
      '🪙 4 on Jeu zéro',
      '🪙 5 on Neighbours of 17',
      '🪙 10 on `0-3`',
      '',
      'Total: **🪙 2,553** on 7 bets',
      `The wheel spins ${COUNTDOWN}.`,
      `[Go to the table](${URL})`,
    ]);
  });

  it('says so when the table is in another channel', () => {
    const first = { ...placed, bets: bets.slice(0, 1), stake: 10, count: 1 };

    const { json } = view(rouletteBetsEmbed('en-US', first, true));

    expect(json.description?.split('\n')).toEqual([
      '🪙 10 on `17`',
      '',
      'Total: **🪙 10** on 1 bet',
      `The wheel spins ${COUNTDOWN}.`,
      `This table is in another channel: [go to the table](${URL}).`,
    ]);
  });
});

describe('the autocomplete preview (SPEC §6)', () => {
  const FAMILY = '👨‍👩‍👧‍👦';

  function refused(input: string, balance = 1_000): string {
    const parsed = parseBets(input, { balance, max: gameConfig.stakes.max });
    if (parsed.ok) throw new Error(`"${input}" should not parse`);
    return `✗ ${translate('en-US', parsed.error).replaceAll('`', '')}`;
  }

  it('previews the number of bets and their total, with the typed text as the value', () => {
    expect(rouletteChoices('10:5, 10:15, 10:20', 1_000, 'en-US')).toEqual([
      { name: '✓ 3 bets · total 🪙 30', value: '10:5, 10:15, 10:20' },
    ]);
    expect(rouletteChoices('  2,500:red  ', 1_000, 'en-US')).toEqual([
      { name: '✓ 1 bet · total 🪙 2,500', value: '2,500:red' },
    ]);
  });

  it('counts an announced bet as one and resolves keywords against the balance', () => {
    expect(rouletteChoices('half:red, 9:voisins', 1_000, 'en-US')).toEqual([
      { name: '✓ 2 bets · total 🪙 509', value: 'half:red, 9:voisins' },
    ]);
  });

  it('shows the parse error without markdown backticks', () => {
    const [choice] = rouletteChoices('10:17 10:1/3', 1_000, 'en-US');

    expect(refused('10:1/3')).toMatch(/^✗ 1\/3 isn't one bet on the table\./);
    expect(choice?.value).toBe('10:17 10:1/3');
    expect(choice?.name).not.toContain('`');
    expect(choice?.name).toBe(`${refused('10:1/3').slice(0, 99).trimEnd()}…`);
  });

  it('cuts a long name to 100 characters between emoji, never through one', () => {
    const typed = FAMILY.repeat(9);
    expect(typed).toHaveLength(99);

    const [choice] = rouletteChoices(typed, 1_000, 'en-US');

    expect(refused(typed).startsWith(`✗ ${typed} `)).toBe(true);
    expect(choice).toEqual({ name: `✗ ${FAMILY.repeat(8)}…`, value: typed });
  });

  it('offers text of 100 characters, and nothing for longer text', () => {
    const hundred = `10:${'1/'.repeat(48)}1`;
    expect(hundred).toHaveLength(100);

    expect(rouletteChoices(hundred, 1_000, 'en-US')).toEqual([
      { name: expect.stringMatching(/^✗ /) as unknown, value: hundred },
    ]);
    expect(rouletteChoices(`${hundred}0`, 1_000, 'en-US')).toEqual([]);
  });

  it('hints at the notation and /help topic:roulette for an empty field', () => {
    const hint = t('en-US', 'roulette.autocomplete.hint');

    expect(hint).toMatch(/\/help topic:roulette/);
    expect(hint.length).toBeLessThanOrEqual(100);
    expect(rouletteChoices('', 1_000, 'en-US')).toEqual([{ name: hint, value: 'help' }]);
    expect(rouletteChoices('   ', null, 'en-US')).toEqual([{ name: hint, value: 'help' }]);
  });

  it('without a balance, previews what does not need one and leaves keywords out', () => {
    expect(rouletteChoices('10:red', null, 'en-US')).toEqual([
      { name: '✓ 1 bet · total 🪙 10', value: '10:red' },
    ]);
    expect(rouletteChoices('10:red, half:black', null, 'en-US')).toEqual([]);
    expect(rouletteChoices('10:1/3, all:red', null, 'en-US')).toEqual([
      { name: expect.stringMatching(/^✗ 1\/3 isn't one bet/) as unknown, value: '10:1/3, all:red' },
    ]);
  });

  it('explains a keyword that the balance cannot cover', () => {
    expect(rouletteChoices('all:red', 0, 'en-US')).toEqual([
      { name: refused('all:red', 0), value: 'all:red' },
    ]);
  });
});

describe('help (SPEC §9)', () => {
  const { json, text } = view(rouletteHelpEmbed('en-US'));

  it('lists every bet with its notation and a payout that matches the engine', () => {
    const lines = fieldValue(json, 'Bets and payouts').split('\n');

    expect(lines).toHaveLength(10);
    for (const line of lines) {
      const notation = /`([^`]+)`/.exec(line)?.[1];
      const odds = /\*\*(\d+):1\*\*$/.exec(line)?.[1];
      if (notation === undefined || odds === undefined) throw new Error(`unexpected line: ${line}`);
      const [bet] = betsOf(`36:${notation}`);
      const covered = bet?.chips[0]?.numbers[0];
      if (bet === undefined || covered === undefined) throw new Error(`no bet in: ${line}`);
      const [settled] = settle([bet], covered);
      expect(settled?.payout, line).toBe(36 * (Number(odds) + 1));
    }
  });

  it('lists the announced bets with layouts that match the engine', () => {
    const lines = fieldValue(json, 'Announced bets').split('\n');

    for (const [label, name] of [
      ['voisins', 'Voisins du zéro'],
      ['tiers', 'Tiers du cylindre'],
      ['orphelins', 'Orphelins'],
      ['jeu0', 'Jeu zéro'],
    ] as const) {
      const line = lines.find((candidate) => candidate.startsWith(`\`${label}\` · ${name} · `));
      const chips = Number(/ (\d+) chips: /.exec(line ?? '')?.[1]);
      if (line === undefined || !Number.isInteger(chips)) throw new Error(`no line for ${label}`);
      const [bet] = betsOf(`${chips}:${label}`);

      expect(bet?.chips).toHaveLength(chips);
      for (const chip of bet?.chips ?? []) expect(line).toContain(chip.numbers.join('/'));
    }
    expect(lines.at(-1)).toMatch(
      /^`n17` · Neighbours · 5 chips: 17 and the two numbers on each side/,
    );
    expect(betsOf('5:n17')[0]?.chips).toHaveLength(5);
  });

  it('explains a betting round with the configured numbers', () => {
    const round = fieldValue(json, 'A betting round');

    expect(round).toMatch(/The first bets start a 30-second countdown\./);
    expect(round).toMatch(
      /up to 20 players a spin, and up to 30 bets and 🪙 10 to 🪙 1,000,000 per player/,
    );
    expect(text).toMatch(/French and Dutch names work too/);
  });

  it('explains that tables are threads, and the lobby with its bet form', () => {
    const round = fieldValue(json, 'A betting round');

    expect(round).toMatch(/^Every table is a thread, like \*\*Table #12 \(Roulette\)\*\*\. /);
    expect(round).toContain("In a table's thread, `/roulette` bets at that table.");
    expect(round).toContain(
      'the 🎡 Roulette button opens a bet form; `/create-table` opens a table',
    );
    expect(round).not.toMatch(/elsewhere in this server/);
  });

  it('keeps every part within the Discord limits', () => {
    for (const field of json.fields ?? []) expect(field.value.length).toBeLessThanOrEqual(1024);
    expect(embedLength(json)).toBeLessThanOrEqual(6000);
  });
});
