import {
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  Collection,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BALANCE_TIMEOUT_MS } from '../../src/bot/bet-autocomplete.js';
import type { TableParent } from '../../src/bot/tables/thread.js';
import type { Command } from '../../src/bot/types.js';
import roulette from '../../src/commands/games/roulette.js';
import { gameConfig } from '../../src/config/game.js';
import { PlayerError } from '../../src/core/errors.js';
import interactionCreate from '../../src/events/interaction-create.js';
import { parseBets } from '../../src/games/roulette/index.js';
import { formatCoins } from '../../src/i18n/format.js';
import { t, translate } from '../../src/i18n/index.js';
import { captureLogs, fakeContext, FIXED_NOW, type FakeContext } from '../helpers/context.js';
import {
  embedsOf,
  FakeChannel,
  fakeAutocomplete,
  fakeChatInput,
  fakeUser,
  GUILD_ID,
  isEphemeral,
  TABLE_PERMISSIONS,
  textOf,
  USER_ID,
  type ChatInputOptions,
  type ResponseCall,
} from '../helpers/discord.js';

// The numbers crypto.randomInt hands out, in order; real draws once they run out.
const { draws } = vi.hoisted(() => ({ draws: [] as number[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomInt: (max: number) => draws.shift() ?? crypto.randomInt(max) };
});

const commands = new Collection<string, Command>([['roulette', roulette]]);
const { bettingSeconds, revealDelayMs } = gameConfig.roulette;
const BALANCE = 10_000;
const TABLE_ROUND = 7;
const SPINS_AT = `<t:${FIXED_NOW.epochMilliseconds / 1_000 + bettingSeconds}:R>`;
const bob = fakeUser('200000000000000002', 'bob');

/** A wallet that opens table round 7 and keeps each round's stake. */
function bettingContext(logger = captureLogs().logger): FakeContext {
  const context = fakeContext({ logger });
  const { wallet } = context;
  const stakes = new Map<number, number>();
  wallet.balanceOf.mockResolvedValue(BALANCE);
  wallet.openTableRound.mockResolvedValue(TABLE_ROUND);
  wallet.openRound.mockImplementation((_player, _tableRoundId, stake) => {
    const roundId = 100 + stakes.size;
    stakes.set(roundId, stake);
    return Promise.resolve({ roundId, stake, balance: BALANCE - stake });
  });
  wallet.raiseRound.mockImplementation((roundId, amount) => {
    const stake = (stakes.get(roundId) ?? 0) + amount;
    stakes.set(roundId, stake);
    return Promise.resolve({ roundId, stake, balance: BALANCE - stake });
  });
  wallet.settleTableRound.mockImplementation((_tableRoundId, _outcome, settlements) =>
    Promise.resolve(
      settlements.map(({ roundId, payout }) => {
        const stake = stakes.get(roundId) ?? 0;
        return { roundId, userId: USER_ID, stake, payout, balance: BALANCE - stake + payout };
      }),
    ),
  );
  wallet.refundTableRound.mockResolvedValue({ rounds: 0, tableRounds: 1, coins: 0 });
  return context;
}

async function run(
  context: FakeContext,
  bets: string,
  options: ChatInputOptions = {},
): Promise<ResponseCall[]> {
  const { interaction, calls } = fakeChatInput('roulette', {
    strings: { bets },
    commands,
    displayName: 'Alice',
    channel: new FakeChannel(),
    ...options,
  });
  await interactionCreate.execute(context, interaction);
  return calls;
}

function ephemeral(content: string): { content: string; flags: MessageFlags.Ephemeral } {
  return { content, flags: MessageFlags.Ephemeral };
}

function descriptionLines(payload: unknown): string[] {
  return embedsOf(payload)[0]?.description?.split('\n') ?? [];
}

const deferred = { method: 'deferReply', options: { flags: MessageFlags.Ephemeral } };

beforeEach(() => {
  vi.useFakeTimers();
  draws.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/roulette data (SPEC §3)', () => {
  const json = roulette.data.toJSON();

  it('is a server-only command with a required bets option of at most 500 characters', () => {
    expect(json.name).toBe('roulette');
    expect(json.description).toMatch(/^.{1,100}$/su);
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
    expect(json.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
    expect(json.options).toEqual([
      expect.objectContaining({
        type: ApplicationCommandOptionType.String,
        name: 'bets',
        required: true,
        max_length: 500,
        autocomplete: true,
        description: expect.stringMatching(/^.{1,100}$/su) as unknown,
      }),
    ]);
  });

  it('keeps the default cooldown', () => {
    expect('cooldown' in roulette).toBe(false);
  });
});

describe('/roulette (SPEC §6)', () => {
  it('refuses bets that do not parse, ephemerally, before any coins move', async () => {
    const context = bettingContext();
    const parsed = parseBets('10:1/3', { balance: BALANCE, max: gameConfig.stakes.max });
    if (parsed.ok) throw new Error('"10:1/3" should not parse');

    const calls = await run(context, '10:17, 10:1/3');

    expect(calls).toEqual([
      deferred,
      { method: 'followUp', options: ephemeral(translate('en-US', parsed.error)) },
    ]);
    expect(context.wallet.openTableRound.mock.calls).toEqual([]);
  });

  it('defers before it reads the balance, so a refused read still arrives ephemerally', async () => {
    const context = bettingContext();
    context.wallet.balanceOf.mockRejectedValueOnce(new PlayerError('errors.restarting'));

    const calls = await run(context, '10:red');

    expect(calls).toEqual([
      deferred,
      { method: 'followUp', options: ephemeral(t('en-US', 'errors.restarting')) },
    ]);
    expect(context.wallet.openTableRound.mock.calls).toEqual([]);
  });

  it('resolves keywords against the live balance', async () => {
    const context = bettingContext();

    await run(context, 'half:red');

    expect(context.wallet.balanceOf.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: USER_ID, displayName: 'Alice' }],
    ]);
    expect(context.wallet.openRound.mock.calls[0]?.[2]).toBe(BALANCE / 2);
  });

  it('confirms the bets ephemerally, with the total, the countdown and a link to the table', async () => {
    const context = bettingContext();
    const channel = new FakeChannel();

    const calls = await run(context, '10:17, 20:red', { channel });

    expect(channel.messages).toEqual([]);
    const [table] = channel.allMessages;
    expect(table?.channelId).toBe(channel.threadsStarted[0]?.id);
    expect(calls.map((call) => call.method)).toEqual(['deferReply', 'editReply']);
    expect(calls[0]).toEqual(deferred);
    expect(descriptionLines(calls[1]?.options)).toEqual([
      '🪙 10 on `17`',
      '🪙 20 on `red`',
      '',
      'Total: **🪙 30** on 2 bets',
      `The wheel spins ${SPINS_AT}.`,
      `[Go to the table](${table?.url ?? 'no table'})`,
    ]);
    expect(textOf(table?.sent)).toMatch(/^\*\*Alice\*\* · 🪙 30 · 2 bets$/m);
  });

  it('tells a player who joins a table in another channel where it is', async () => {
    const context = bettingContext();
    const here = new FakeChannel();
    const there = new FakeChannel('300000000000000002');
    await run(context, '10:17', { channel: here });

    const calls = await run(context, '10:red', { channel: there, user: bob, displayName: 'Bob' });

    expect(there.allMessages).toEqual([]);
    expect(descriptionLines(calls.at(-1)?.options).at(-1)).toBe(
      `This table is in another channel: [go to the table](${here.allMessages[0]?.url ?? 'none'}).`,
    );
  });

  it("starts roulette in a table's lobby, and tells a player when the table plays blackjack", async () => {
    const context = bettingContext();
    const channel = new FakeChannel();
    const parent = channel as unknown as TableParent;
    const where = { context, parent, game: null, locale: 'en-US', userId: USER_ID };
    await context.hosts.open(where);
    await context.hosts.open(where);
    const [lobby, busy] = context.hosts.opened;
    if (lobby === undefined || busy === undefined) throw new Error('no tables opened');
    busy.begin({
      id: 't-99',
      game: 'blackjack',
      guildId: GUILD_ID,
      channelId: channel.id,
      hasRoom: () => true,
      close: () => Promise.resolve(),
    });

    const started = await run(context, '10:red', { channel: lobby.thread });
    const refused = await run(context, '10:red', {
      channel: busy.thread,
      user: bob,
      displayName: 'Bob',
    });

    expect(lobby.begun).toHaveLength(1);
    expect(descriptionLines(started.at(-1)?.options).at(-1)).toBe(
      `[Go to the table](${lobby.thread.messages[0]?.url ?? 'none'})`,
    );
    expect(refused).toEqual([
      deferred,
      {
        method: 'followUp',
        options: ephemeral(
          'Table #2 is playing Blackjack right now. Wait for this game to end, or use `/roulette` outside this thread.',
        ),
      },
    ]);
    expect(context.wallet.openRound.mock.calls.map(([who]) => who.userId)).toEqual([USER_ID]);
    expect(busy.thread.messages).toEqual([]);
  });

  it("adds a player's next /roulette to their bets on this spin", async () => {
    const context = bettingContext();
    const channel = new FakeChannel();
    await run(context, '10:17', { channel });

    const calls = await run(context, '20:red', { channel });

    expect(context.wallet.raiseRound.mock.calls).toEqual([[100, 20]]);
    expect(descriptionLines(calls.at(-1)?.options).slice(0, 4)).toEqual([
      '🪙 10 on `17`',
      '🪙 20 on `red`',
      '',
      'Total: **🪙 30** on 2 bets',
    ]);
  });

  it('names a missing permission and moves no coins', async () => {
    const context = bettingContext();

    const calls = await run(context, '10:red', {
      appPermissions: TABLE_PERMISSIONS & ~PermissionFlagsBits.EmbedLinks,
    });

    expect(calls).toEqual([
      deferred,
      {
        method: 'followUp',
        options: ephemeral("I can't open a table in this channel. I'm missing: Embed Links."),
      },
    ]);
    const { wallet } = context;
    expect([
      wallet.openTableRound.mock.calls,
      wallet.openRound.mock.calls,
      wallet.refundTableRound.mock.calls,
    ]).toEqual([[], [], []]);
  });

  it('shows "not enough coins" ephemerally and leaves no table behind', async () => {
    const context = bettingContext();
    const channel = new FakeChannel();
    const short = new PlayerError('errors.insufficientFunds', {
      needed: formatCoins(500),
      balance: formatCoins(120),
    });
    context.wallet.openRound.mockRejectedValueOnce(short);

    const calls = await run(context, '500:red', { channel });

    expect(calls).toEqual([
      deferred,
      { method: 'followUp', options: ephemeral(translate('en-US', short.userMessage)) },
    ]);
    expect(context.wallet.refundTableRound.mock.calls).toEqual([[TABLE_ROUND]]);
    expect(channel.threadsStarted).toEqual([]);
    expect(channel.allMessages).toEqual([]);
    expect(context.tables.all()).toEqual([]);
  });

  it('logs a confirmation that cannot be sent, and the bets stand', async () => {
    const { logger, lines } = captureLogs();
    const context = bettingContext(logger);
    const { interaction, calls } = fakeChatInput('roulette', {
      strings: { bets: '10:red' },
      commands,
      channel: new FakeChannel(),
    });
    vi.spyOn(interaction, 'editReply').mockRejectedValueOnce(new Error('Unknown Webhook'));

    await interactionCreate.execute(context, interaction);

    expect(calls).toEqual([deferred]);
    expect(context.tables.all()).toHaveLength(1);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'could not confirm roulette bets',
        userId: USER_ID,
      }),
    ]);
  });

  it('plays a whole spin: crypto.randomInt picks the number, and the result follows up', async () => {
    const context = bettingContext();
    const channel = new FakeChannel();
    draws.push(0);
    const calls = await run(context, '10:0, 10:red', { channel });

    await vi.advanceTimersByTimeAsync(bettingSeconds * 1_000 + revealDelayMs);

    expect(draws).toEqual([]);
    expect(context.wallet.settleTableRound.mock.calls[0]?.[1]).toEqual({ number: 0 });
    expect(descriptionLines(channel.allMessages[0]?.latest)[0]).toBe('🟢 **0** Green');
    const result = calls.at(-1);
    expect(result?.method).toBe('followUp');
    expect(isEphemeral(result?.options)).toBe(true);
    expect(descriptionLines(result?.options)).toEqual([
      '🟢 **0** Green',
      '',
      '✅ `0` · 🪙 10 → 🪙 360',
      '❌ `red` · 🪙 10 → 🪙 0',
    ]);
  });
});

describe('/roulette autocomplete (SPEC §6)', () => {
  async function suggest(typed: string, balance: number | Error) {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    if (balance instanceof Error) context.wallet.balanceOf.mockRejectedValue(balance);
    else context.wallet.balanceOf.mockResolvedValue(balance);
    const { interaction, calls } = fakeAutocomplete('roulette', {
      focused: { name: 'bets', value: typed },
    });

    await expect(roulette.autocomplete(interaction, context)).resolves.toBeUndefined();

    return { calls, lines, context };
  }

  it('previews the typed bets against the live balance, keeping the text as the value', async () => {
    const { calls, context } = await suggest('half:red, 10:17', 1_000);

    expect(calls).toEqual([
      {
        method: 'respond',
        options: [{ name: '✓ 2 bets · total 🪙 510', value: 'half:red, 10:17' }],
      },
    ]);
    expect(context.wallet.balanceOf.mock.calls).toEqual([[{ guildId: GUILD_ID, userId: USER_ID }]]);
  });

  it('shows why the bets do not parse, without markdown', async () => {
    const { calls } = await suggest('10:1/3', 1_000);

    expect(calls).toEqual([
      {
        method: 'respond',
        options: [
          {
            name: expect.stringMatching(/^✗ 1\/3 isn't one bet on the table\. [^`]*…$/) as unknown,
            value: '10:1/3',
          },
        ],
      },
    ]);
  });

  it('hints at the notation and /help topic:roulette for an empty field', async () => {
    const { calls } = await suggest('', 1_000);

    expect(calls).toEqual([
      {
        method: 'respond',
        options: [{ name: t('en-US', 'roulette.autocomplete.hint'), value: 'help' }],
      },
    ]);
  });

  it('gives no suggestions for input over 100 characters', async () => {
    const { calls } = await suggest(`10:red ${'1'.repeat(94)}`, 1_000);

    expect(calls).toEqual([{ method: 'respond', options: [] }]);
  });

  it('without a balance, previews plain amounts, leaves keywords out and logs why', async () => {
    const plain = await suggest('10:red', new Error('database down'));
    const keyword = await suggest('half:red', new Error('database down'));

    expect(plain.calls).toEqual([
      { method: 'respond', options: [{ name: '✓ 1 bet · total 🪙 10', value: '10:red' }] },
    ]);
    expect(keyword.calls).toEqual([{ method: 'respond', options: [] }]);
    expect(keyword.lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'could not read the balance for autocomplete',
        command: 'roulette',
        err: expect.objectContaining({ message: 'database down' }) as unknown,
      }),
    ]);
  });

  it('answers in time without the balance when reading it is too slow, and logs it', async () => {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    context.wallet.balanceOf.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(1_000);
          }, 10_000);
        }),
    );
    const plain = fakeAutocomplete('roulette', { focused: { name: 'bets', value: '10:red' } });
    const keyword = fakeAutocomplete('roulette', { focused: { name: 'bets', value: 'half:red' } });

    const answering = Promise.all([
      roulette.autocomplete(plain.interaction, context),
      roulette.autocomplete(keyword.interaction, context),
    ]);
    await vi.advanceTimersByTimeAsync(BALANCE_TIMEOUT_MS - 1);
    expect([plain.calls, keyword.calls]).toEqual([[], []]);
    await vi.advanceTimersByTimeAsync(1);

    expect(BALANCE_TIMEOUT_MS).toBeLessThan(3_000);
    expect(plain.calls).toEqual([
      { method: 'respond', options: [{ name: '✓ 1 bet · total 🪙 10', value: '10:red' }] },
    ]);
    expect(keyword.calls).toEqual([{ method: 'respond', options: [] }]);
    expect(lines.map((line) => [line.level, line.msg, line.command])).toEqual([
      [40, 'reading the balance for autocomplete took too long', 'roulette'],
      [40, 'reading the balance for autocomplete took too long', 'roulette'],
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(answering).resolves.toEqual([undefined, undefined]);
  });

  it('survives a respond that fails, and logs it', async () => {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    context.wallet.balanceOf.mockResolvedValue(1_000);
    const { interaction } = fakeAutocomplete('roulette', {
      focused: { name: 'bets', value: '10:red' },
    });
    Object.assign(interaction, { respond: () => Promise.reject(new Error('Unknown interaction')) });

    await expect(roulette.autocomplete(interaction, context)).resolves.toBeUndefined();

    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      [40, 'could not answer autocomplete'],
    ]);
  });

  it('answers with no choices when building them fails, and logs it', async () => {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    const { interaction, calls } = fakeAutocomplete('roulette', {
      focused: { name: 'bets', value: '10:red' },
    });
    Object.assign(interaction.options, {
      getFocused: () => {
        throw new Error('no focused option');
      },
    });

    await expect(roulette.autocomplete(interaction, context)).resolves.toBeUndefined();

    expect(calls).toEqual([{ method: 'respond', options: [] }]);
    expect(lines).toEqual([
      expect.objectContaining({ level: 50, msg: 'autocomplete failed', command: 'roulette' }),
    ]);
  });
});
