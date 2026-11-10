import { ChannelType, Colors, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUND_RETRY_MS } from '../../../src/bot/tables/refunds.js';
import type { LiveTable } from '../../../src/bot/tables/registry.js';
import {
  placeRouletteBets,
  playRoulette,
  RouletteTable,
  type Placement,
  type RouletteContext,
} from '../../../src/bot/tables/roulette-table.js';
import type { PlayInteraction } from '../../../src/bot/tables/table.js';
import type { TableParent } from '../../../src/bot/tables/thread.js';
import { gameConfig } from '../../../src/config/game.js';
import { PlayerError } from '../../../src/core/errors.js';
import { TableRoundClosedError, type SettledRound } from '../../../src/core/wallet.js';
import { parseBets } from '../../../src/games/roulette/index.js';
import { formatCoins } from '../../../src/i18n/format.js';
import { t, translate } from '../../../src/i18n/index.js';
import { captureLogs, fakeContext, FIXED_NOW, type FakeContext } from '../../helpers/context.js';
import {
  CHANNEL_ID,
  discordError,
  embedsOf,
  FakeChannel,
  fakeChatInput,
  fakeModalSubmit,
  fakeUser,
  GUILD_ID,
  isEphemeral,
  textOf,
  type Fake,
  type FakeMessage,
  type FakeUser,
  type ResponseCall,
} from '../../helpers/discord.js';
import type { FakeHost } from '../../helpers/tables.js';

const { bettingSeconds, maxBetsPerSpin, maxPlayers, revealDelayMs } = gameConfig.roulette;
const COUNTDOWN_MS = bettingSeconds * 1_000;
const BALANCE = 5_000_000;
const TABLE_ROUND = 7;
const OTHER_CHANNEL = '300000000000000002';
const SPINS_AT = `<t:${FIXED_NOW.epochMilliseconds / 1_000 + bettingSeconds}:R>`;
const BETTING = 'Place your bets with `/roulette`!';
const ROLLING = 'The ball is rolling…';
const CLOSED =
  'This table closed because the bot is restarting. Its stakes are refunded when the bot starts again.';
const BETTING_CLOSED =
  'Betting on this spin has closed. Wait for the result, then bet on the next spin.';

interface Player {
  readonly user: FakeUser;
  readonly name: string;
}

function player(n: number, name = `Player ${String(n)}`): Player {
  return { user: fakeUser(`2000000000000000${String(n).padStart(2, '0')}`, `p${String(n)}`), name };
}

const alice = player(1, 'Alice');
const bob = player(2, 'Bob');
const cleo = player(3, 'Cleo');

interface Harness {
  readonly context: FakeContext & RouletteContext;
  readonly logs: Record<string, unknown>[];
  /** Where the wheel lands, spin by spin. */
  readonly draws: number[];
}

/** A wallet that keeps each round's stake, so raises and settlements report real totals. */
function harness(): Harness {
  const { logger, lines } = captureLogs();
  const base = fakeContext({ logger });
  const { wallet } = base;
  const draws: number[] = [];
  const rounds = new Map<number, { userId: string; stake: number }>();
  let nextTableRound = TABLE_ROUND;
  wallet.openTableRound.mockImplementation(() => Promise.resolve(nextTableRound++));
  wallet.openRound.mockImplementation((who, _tableRoundId, stake) => {
    const roundId = 100 + rounds.size;
    rounds.set(roundId, { userId: who.userId, stake });
    return Promise.resolve({ roundId, stake, balance: BALANCE - stake });
  });
  wallet.raiseRound.mockImplementation((roundId, amount) => {
    const round = rounds.get(roundId);
    if (round === undefined) return Promise.reject(new Error(`no round ${String(roundId)}`));
    round.stake += amount;
    return Promise.resolve({ roundId, stake: round.stake, balance: BALANCE - round.stake });
  });
  wallet.settleTableRound.mockImplementation((_tableRoundId, _outcome, settlements) =>
    Promise.resolve(
      settlements.map(({ roundId, payout }): SettledRound => {
        const round = rounds.get(roundId) ?? { userId: 'nobody', stake: 0 };
        const balance = BALANCE - round.stake + payout;
        return { roundId, userId: round.userId, stake: round.stake, payout, balance };
      }),
    ),
  );
  wallet.refundTableRound.mockResolvedValue({ rounds: 0, tableRounds: 1, coins: 0 });
  wallet.balanceOf.mockResolvedValue(BALANCE);
  const context = {
    ...base,
    draw: (max: number): number => {
      const drawn = draws.shift();
      if (drawn === undefined || drawn >= max) throw new Error('the test set no draw');
      return drawn;
    },
  };
  return { context, logs: lines, draws };
}

type Interaction = ChatInputCommandInteraction<'cached'>;

interface Attempt {
  readonly calls: ResponseCall[];
  readonly placement: Placement | undefined;
  readonly error: unknown;
}

interface AttemptOptions {
  readonly prepare?: (interaction: Interaction) => void;
  readonly hiddenChannels?: readonly string[];
}

/** What /roulette does once the bets parse: defer the reply, then seat the player and bet. */
async function attempt(
  h: Harness,
  who: Player,
  input: string,
  channel: FakeChannel,
  { prepare, hiddenChannels }: AttemptOptions = {},
): Promise<Attempt> {
  const { interaction, calls } = fakeChatInput('roulette', {
    strings: { bets: input },
    user: who.user,
    displayName: who.name,
    channel,
    ...(hiddenChannels === undefined ? {} : { hiddenChannels }),
  });
  prepare?.(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const parsed = parseBets(input, { balance: BALANCE, max: gameConfig.stakes.max }, maxBetsPerSpin);
  if (!parsed.ok) throw new Error(`"${input}" should parse`);
  try {
    const placement = await placeRouletteBets({ interaction, bets: parsed.bets }, h.context);
    return { calls, placement, error: undefined };
  } catch (error) {
    return { calls, placement: undefined, error };
  }
}

async function place(
  h: Harness,
  who: Player,
  input: string,
  channel: FakeChannel,
  options?: AttemptOptions,
): Promise<Placement & { readonly calls: ResponseCall[] }> {
  const { calls, placement, error } = await attempt(h, who, input, channel, options);
  if (placement === undefined) throw new Error(`"${input}" was refused: ${String(error)}`);
  return { ...placement, calls };
}

/** The text of the PlayerError that refused the bets. */
async function refusal(
  h: Harness,
  who: Player,
  input: string,
  channel: FakeChannel,
): Promise<string> {
  const { error } = await attempt(h, who, input, channel);
  if (!(error instanceof PlayerError))
    throw new Error(`expected a PlayerError, got ${String(error)}`);
  return translate('en-US', error.userMessage);
}

function followUps(calls: readonly ResponseCall[]): ResponseCall[] {
  return calls.filter((call) => call.method === 'followUp');
}

/** The first line of a table message's description: what the table is doing. */
function status(payload: unknown): string | undefined {
  return embedsOf(payload)[0]?.description?.split('\n')[0];
}

/** The game's message in the thread of the channel's n-th table. */
function tableMessage(channel: FakeChannel, index = 0): FakeMessage {
  const message = channel.threadsStarted[index]?.messages[0];
  if (message === undefined) throw new Error(`no table message in thread ${String(index)}`);
  return message;
}

function hostAt(h: Harness, index = 0): FakeHost {
  const host = h.context.hosts.opened[index];
  if (host === undefined) throw new Error(`no table ${String(index)}`);
  return host;
}

/** A table opened by /create-table: its thread shows the lobby, so it has no game. */
async function lobbyIn(h: Harness, channel: FakeChannel): Promise<FakeHost> {
  await h.context.hosts.open({
    context: h.context,
    parent: channel as unknown as TableParent,
    game: null,
    locale: 'en-US',
    userId: alice.user.id,
  });
  h.context.hosts.open.mockClear();
  const host = h.context.hosts.opened.at(-1);
  if (host === undefined) throw new Error('no lobby opened');
  return host;
}

/** The next table that opens gets a thread that refuses the table message. */
function failNextTableMessage(h: Harness, error: Error): void {
  const open = h.context.hosts.open.getMockImplementation();
  if (open === undefined) throw new Error('fakeHosts().open has no implementation');
  h.context.hosts.open.mockImplementationOnce(async (options) => {
    const host = await open(options);
    const opened = h.context.hosts.opened.at(-1);
    if (opened === undefined) throw new Error('no table opened');
    opened.thread.sendError = error;
    return host;
  });
}

function blackjackAt(host: FakeHost): LiveTable {
  return {
    id: 't-99',
    game: 'blackjack',
    guildId: host.guildId,
    channelId: host.channelId,
    hasRoom: () => true,
    close: () => Promise.resolve(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening a table (SPEC §4)', () => {
  it('debits the first bets, then opens a thread for the table and posts the table message there', async () => {
    const h = harness();
    const channel = new FakeChannel();

    const placement = await place(h, alice, '10:17, 20:red', channel);

    const { wallet, tables, hosts } = h.context;
    expect(wallet.openTableRound.mock.calls).toEqual([[GUILD_ID, 'roulette']]);
    expect(wallet.openRound.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: alice.user.id, displayName: 'Alice' }, TABLE_ROUND, 30],
    ]);
    expect(hosts.open.mock.calls).toEqual([
      [
        expect.objectContaining({
          parent: channel,
          game: 'roulette',
          locale: 'en-US',
          userId: alice.user.id,
        }),
      ],
    ]);
    expect(wallet.openRound.mock.invocationCallOrder[0]).toBeLessThan(
      hosts.open.mock.invocationCallOrder[0] ?? 0,
    );
    expect(channel.messages).toEqual([]);
    expect(channel.threadsStarted.map((thread) => thread.name)).toEqual(['Table #1 (Roulette)']);
    const message = tableMessage(channel);
    const text = textOf(message.sent);
    expect(isEphemeral(message.sent)).toBe(false);
    expect(text).toMatch(/^\*\*Alice\*\* · 🪙 30 · 2 bets$/m);
    expect(text).toMatch(/^Players\n1\/20$/m);
    expect(text).toContain(`Wheel spins\n${SPINS_AT}`);
    expect(placement).toMatchObject({
      stake: 30,
      count: 2,
      url: message.url,
      channelId: CHANNEL_ID,
    });
    expect(placement.spinsAt.epochMilliseconds).toBe(
      FIXED_NOW.add({ seconds: 30 }).epochMilliseconds,
    );
    expect(placement.bets.map((bet) => bet.label)).toEqual(['17', 'red']);
    const table = tables.tableOf('roulette', GUILD_ID, alice.user.id);
    expect(table).toBeInstanceOf(RouletteTable);
    expect(table?.id).toBe('t-1');
    expect(tables.all()).toEqual([table]);
    const host = hostAt(h);
    expect(host.begun).toEqual([table]);
    expect(host.game).toBe(table);
    expect([...host.players]).toEqual([alice.user.id]);
  });

  it('opens no table thread when the first bets are refused, and refunds the empty table round', async () => {
    const h = harness();
    const channel = new FakeChannel();
    const short = new PlayerError('errors.insufficientFunds', {
      needed: formatCoins(30),
      balance: formatCoins(5),
    });
    h.context.wallet.openRound.mockRejectedValueOnce(short);

    const { error } = await attempt(h, alice, '10:17, 20:red', channel);

    expect(error).toBe(short);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[TABLE_ROUND]]);
    expect(h.context.hosts.open.mock.calls).toEqual([]);
    expect(channel.threadsStarted).toEqual([]);
    expect(channel.allMessages).toEqual([]);
    expect(h.context.tables.all()).toEqual([]);
    expect(h.context.tables.tableOf('roulette', GUILD_ID, alice.user.id)).toBeUndefined();
  });

  it('refunds and closes the new table when the table message cannot be sent', async () => {
    const h = harness();
    const channel = new FakeChannel();
    failNextTableMessage(h, new Error('Missing Access'));

    const { error } = await attempt(h, alice, '10:17', channel);

    expect(error).toEqual(new Error('Missing Access'));
    expect(h.context.wallet.openRound.mock.calls).toHaveLength(1);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[TABLE_ROUND]]);
    const host = hostAt(h);
    expect(host.closeCalls).toBe(1);
    expect(host.thread.archived).toBe(true);
    expect(h.context.tables.allHosts()).toEqual([]);
    expect(h.context.tables.all()).toEqual([]);
    expect(h.context.tables.tableOf('roulette', GUILD_ID, alice.user.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2 * COUNTDOWN_MS);
    expect(h.context.wallet.settleTableRound.mock.calls).toEqual([]);
  });

  it('refuses a channel without threads before any coins move', async () => {
    class VoiceChat extends FakeChannel {
      override readonly type = ChannelType.GuildVoice;
    }
    const h = harness();

    expect(await refusal(h, alice, '10:17', new VoiceChat())).toBe(t('en-US', 'errors.noThreads'));
    expect(h.context.wallet.openTableRound.mock.calls).toEqual([]);
    expect(h.context.hosts.open.mock.calls).toEqual([]);
  });
});

describe("in a table's thread (SPEC §4)", () => {
  it('starts roulette at a table in its lobby, even with another table open in the channel', async () => {
    const h = harness();
    const channel = new FakeChannel();
    await place(h, alice, '10:17', channel);
    const lobby = await lobbyIn(h, channel);

    const started = await place(h, bob, '20:red', lobby.thread);
    const joined = await place(h, cleo, '30:d1', lobby.thread);

    expect(h.context.hosts.open.mock.calls).toEqual([]);
    expect(h.context.wallet.openTableRound.mock.calls).toHaveLength(2);
    const game = h.context.tables.tableOf('roulette', GUILD_ID, bob.user.id);
    expect(lobby.begun).toEqual([game]);
    expect([...lobby.players]).toEqual([alice.user.id, bob.user.id, cleo.user.id]);
    expect(h.context.tables.tableOf('roulette', GUILD_ID, cleo.user.id)).toBe(game);
    const message = lobby.thread.messages[0];
    expect([started.url, joined.url]).toEqual([message?.url, message?.url]);
    expect(started.channelId).toBe(CHANNEL_ID);
    expect(channel.messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(textOf(message?.latest)).toMatch(/^Players\n2\/20$/m);
  });

  it('refunds and hands the table back to its lobby when the game message cannot be sent', async () => {
    const h = harness();
    const lobby = await lobbyIn(h, new FakeChannel());
    lobby.thread.sendError = new Error('Missing Access');

    const { error } = await attempt(h, bob, '10:17', lobby.thread);

    expect(error).toEqual(new Error('Missing Access'));
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[TABLE_ROUND]]);
    expect(lobby.begun).toHaveLength(1);
    expect(lobby.ends).toEqual([{ game: lobby.begun[0], reason: 'over' }]);
    expect(lobby.closeCalls).toBe(0);
    expect(h.context.tables.allHosts()).toEqual([lobby]);
    expect(h.context.tables.all()).toEqual([]);
    expect(h.context.tables.tableOf('roulette', GUILD_ID, bob.user.id)).toBeUndefined();
  });

  it('refunds and lets the table close when its thread is gone', async () => {
    const h = harness();
    const lobby = await lobbyIn(h, new FakeChannel());
    const gone = discordError(10003);
    lobby.thread.sendError = gone;

    const { error } = await attempt(h, bob, '10:17', lobby.thread);

    expect(error).toBe(gone);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[TABLE_ROUND]]);
    expect(lobby.ends.map((end) => end.reason)).toEqual(['lost']);
  });

  it('opens a new table in the channel from the thread of a table that has closed', async () => {
    const h = harness();
    const channel = new FakeChannel();
    const closed = await lobbyIn(h, channel);
    closed.closed = true;

    const placement = await place(h, bob, '10:red', closed.thread);

    expect(closed.begun).toEqual([]);
    expect(channel.threadsStarted.map((thread) => thread.name)).toEqual([
      'Table #1',
      'Table #2 (Roulette)',
    ]);
    expect(placement).toMatchObject({ channelId: CHANNEL_ID, url: tableMessage(channel, 1).url });
  });

  it('refuses roulette where the table plays blackjack, and moves no coins', async () => {
    const h = harness();
    const channel = new FakeChannel();
    const host = await lobbyIn(h, channel);
    host.begin(blackjackAt(host));

    expect(await refusal(h, bob, '10:red', host.thread)).toBe(
      'Table #1 is playing Blackjack right now. Wait for this game to end, or use `/roulette` outside this thread.',
    );
    const { wallet } = h.context;
    expect([wallet.openTableRound.mock.calls, wallet.openRound.mock.calls]).toEqual([[], []]);
    expect(h.context.hosts.open.mock.calls).toEqual([]);
    expect(host.thread.messages).toEqual([]);
  });

  it('says the table is full, and once the ball rolls that betting closed', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17);
    for (let n = 1; n <= maxPlayers; n += 1) await place(h, player(n), '10:red', channel);
    const { thread } = hostAt(h);

    expect(await refusal(h, player(21), '10:red', thread)).toBe(
      'Table #1 has no room. Use `/roulette` outside this thread to find another table.',
    );
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    expect(await refusal(h, player(22), '10:red', thread)).toBe(BETTING_CLOSED);
    expect(h.context.wallet.openRound.mock.calls).toHaveLength(maxPlayers);
    expect(h.context.hosts.open.mock.calls).toHaveLength(1);
  });
});

describe('joining a table (SPEC §4)', () => {
  it('seats a second player at the same table, and a player from another channel too', async () => {
    const h = harness();
    const here = new FakeChannel();
    const there = new FakeChannel(OTHER_CHANNEL);

    const first = await place(h, alice, '10:17', here);
    const second = await place(h, bob, '20:red', here);
    const third = await place(h, cleo, '30:d1', there);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.context.wallet.openTableRound.mock.calls).toHaveLength(1);
    expect(
      h.context.wallet.openRound.mock.calls.map(([who, tableRound, stake]) => [
        who.displayName,
        tableRound,
        stake,
      ]),
    ).toEqual([
      ['Alice', TABLE_ROUND, 10],
      ['Bob', TABLE_ROUND, 20],
      ['Cleo', TABLE_ROUND, 30],
    ]);
    expect(there.threadsStarted).toEqual([]);
    expect([second.url, third.url]).toEqual([first.url, first.url]);
    expect(third.channelId).toBe(CHANNEL_ID);
    expect([...hostAt(h).players]).toEqual([alice.user.id, bob.user.id, cleo.user.id]);
    const text = textOf(tableMessage(here).latest);
    expect(text).toContain(
      ['**Alice** · 🪙 10 · 1 bet', '**Bob** · 🪙 20 · 1 bet', '**Cleo** · 🪙 30 · 1 bet'].join(
        '\n',
      ),
    );
    expect(text).toMatch(/^Players\n3\/20$/m);
    expect(text).toMatch(/^Total stake\n🪙 60$/m);
  });

  it("never seats a player at a table in a channel they can't see", async () => {
    const h = harness();
    const here = new FakeChannel();
    const there = new FakeChannel(OTHER_CHANNEL);
    await place(h, alice, '10:17', here);

    const hidden = await place(h, bob, '20:red', there, { hiddenChannels: [CHANNEL_ID] });

    expect(h.context.wallet.openTableRound.mock.calls).toHaveLength(2);
    expect(there.threadsStarted.map((thread) => thread.name)).toEqual(['Table #2 (Roulette)']);
    expect(hidden).toMatchObject({ channelId: OTHER_CHANNEL, url: tableMessage(there).url });
  });

  it("adds a player's next /roulette to their round with a raise", async () => {
    const h = harness();
    const channel = new FakeChannel();
    await place(h, alice, '10:17', channel);

    const placement = await place(h, alice, '20:red, 9:voisins', channel);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.context.wallet.openRound.mock.calls).toHaveLength(1);
    expect(h.context.wallet.raiseRound.mock.calls).toEqual([[100, 29]]);
    expect(placement).toMatchObject({ stake: 39, count: 3 });
    expect(placement.bets.map((bet) => bet.label)).toEqual(['17', 'red', 'voisins']);
    expect(textOf(tableMessage(channel).latest)).toMatch(/^\*\*Alice\*\* · 🪙 39 · 3 bets$/m);
  });

  it('opens a new table for the 21st player, while seated players keep betting at theirs', async () => {
    const h = harness();
    const channel = new FakeChannel();
    for (let n = 1; n <= maxPlayers; n += 1) await place(h, player(n), '10:red', channel);

    const twentyFirst = await place(h, player(21), '10:red', channel);
    const seated = await place(h, player(1), '10:black', channel);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.context.wallet.openTableRound.mock.calls).toHaveLength(2);
    expect(channel.threadsStarted.map((thread) => thread.name)).toEqual([
      'Table #1 (Roulette)',
      'Table #2 (Roulette)',
    ]);
    expect(twentyFirst.url).toBe(tableMessage(channel, 1).url);
    expect(h.context.wallet.openRound.mock.calls.at(-1)?.[1]).toBe(TABLE_ROUND + 1);
    expect(seated.url).toBe(tableMessage(channel, 0).url);
    expect(textOf(tableMessage(channel, 0).latest)).toMatch(/^Players\n20\/20$/m);
  });
});

describe('per-spin limits (SPEC §4)', () => {
  const straights = (from: number, count: number): string =>
    Array.from({ length: count }, (_, i) => `10:${String(from + i)}`).join(' ');

  it(`allows ${String(maxBetsPerSpin)} bets per player across their commands, and no more`, async () => {
    const h = harness();
    const channel = new FakeChannel();
    await place(h, alice, straights(1, 10), channel);
    await place(h, alice, straights(11, 10), channel);
    await place(h, alice, straights(21, 9), channel);

    expect(await refusal(h, alice, '10:red, 10:black', channel)).toBe(
      "You have 29 of your 30 bets on this spin already, so 2 more won't fit.",
    );
    const last = await place(h, alice, '10:red', channel);

    expect(last.count).toBe(30);
    expect(h.context.wallet.raiseRound.mock.calls.map(([, amount]) => amount)).toEqual([
      100, 90, 10,
    ]);
  });

  it("keeps a player's total stake within the maximum across their commands", async () => {
    const h = harness();
    const channel = new FakeChannel();
    await place(h, alice, '600k:red', channel);

    expect(await refusal(h, alice, '400,001:black', channel)).toBe(
      'That would bring your bets on this spin to 🪙 1,000,001, over the maximum of 🪙 1,000,000. You have 🪙 600,000 on it already.',
    );
    const placement = await place(h, alice, '400k:black', channel);

    expect(placement.stake).toBe(1_000_000);
    expect(h.context.wallet.raiseRound.mock.calls).toEqual([[100, 400_000]]);
  });

  it('holds the first bets of a spin to the minimum and maximum, before any coins move', async () => {
    const h = harness();
    const channel = new FakeChannel();

    expect(await refusal(h, alice, '5:red', channel)).toBe(
      t('en-US', 'amount.belowMinimum', { stake: '🪙 5', min: '🪙 10' }),
    );
    expect(await refusal(h, alice, '1m:red, 10:black', channel)).toBe(
      t('en-US', 'amount.aboveMaximum', { stake: '🪙 1,000,010', max: '🪙 1,000,000' }),
    );
    expect(h.context.wallet.openTableRound.mock.calls).toEqual([]);
    expect(channel.threadsStarted).toEqual([]);

    await place(h, alice, '10:red', channel);
    expect(await refusal(h, bob, '9:red', channel)).toBe(
      t('en-US', 'amount.belowMinimum', { stake: '🪙 9', min: '🪙 10' }),
    );
    expect(h.context.wallet.openRound.mock.calls).toHaveLength(1);
    // The minimum is per player per spin, so a later bet may be smaller.
    expect((await place(h, alice, '5:black', channel)).stake).toBe(15);
  });
});

describe('not enough coins', () => {
  const short = new PlayerError('errors.insufficientFunds', {
    needed: formatCoins(500),
    balance: formatCoins(40),
  });

  it('changes nothing when the wallet refuses a raise', async () => {
    const h = harness();
    const channel = new FakeChannel();
    await place(h, alice, '10:17', channel);
    await vi.advanceTimersByTimeAsync(0);
    const message = tableMessage(channel);
    const edits = message.edits.length;
    h.context.wallet.raiseRound.mockRejectedValueOnce(short);

    const { error } = await attempt(h, alice, '500:red', channel);
    await vi.advanceTimersByTimeAsync(0);

    expect(error).toBe(short);
    expect(message.edits).toHaveLength(edits);
    const placement = await place(h, alice, '10:black', channel);
    expect(placement).toMatchObject({ stake: 20, count: 2 });
    expect(placement.bets.map((bet) => bet.label)).toEqual(['17', 'black']);
  });

  it('does not seat a player whose first bets the wallet refuses', async () => {
    const h = harness();
    const channel = new FakeChannel();
    await place(h, alice, '10:17', channel);
    h.context.wallet.openRound.mockRejectedValueOnce(short);

    const { error } = await attempt(h, bob, '500:red', channel);
    await vi.advanceTimersByTimeAsync(0);

    expect(error).toBe(short);
    expect(h.context.tables.tableOf('roulette', GUILD_ID, bob.user.id)).toBeUndefined();
    expect([...hostAt(h).players]).toEqual([alice.user.id]);
    expect(textOf(tableMessage(channel).latest)).toMatch(/^Players\n1\/20$/m);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([]);
  });
});

describe('the spin (SPEC §6)', () => {
  /**
   * The ball lands on 17, black. Alice wins her straight and loses red. Bob's orphelins win on
   * both 14/17 and 17/20, and black wins. Cleo's first dozen loses.
   */
  async function threePlayers(h: Harness, channel: FakeChannel) {
    h.draws.push(17);
    const a = await place(h, alice, '10:17, 10:red', channel);
    const b = await place(h, bob, '50:orphelins, 20:black', channel);
    const c = await place(h, cleo, '30:d1', channel);
    return { alice: a.calls, bob: b.calls, cleo: c.calls };
  }

  it("settles every player in one call, with each bet's payout, when the countdown ends", async () => {
    const h = harness();
    await threePlayers(h, new FakeChannel());

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS - 1);
    expect(h.context.wallet.settleTableRound.mock.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(h.context.wallet.settleTableRound.mock.calls).toEqual([
      [
        TABLE_ROUND,
        { number: 17 },
        [
          {
            roundId: 100,
            payout: 360,
            details: [
              { bet: '17', amount: 10, payout: 360 },
              { bet: 'red', amount: 10, payout: 0 },
            ],
          },
          {
            roundId: 101,
            payout: 400,
            details: [
              { bet: 'orphelins', amount: 50, payout: 360 },
              { bet: 'black', amount: 20, payout: 40 },
            ],
          },
          { roundId: 102, payout: 0, details: [{ bet: 'd1', amount: 30, payout: 0 }] },
        ],
      ],
    ]);
    await vi.advanceTimersByTimeAsync(10 * revealDelayMs);
    expect(h.context.wallet.settleTableRound.mock.calls).toHaveLength(1);
  });

  it('shows nothing of the spin until it is settled', async () => {
    const h = harness();
    const channel = new FakeChannel();
    const calls = await threePlayers(h, channel);
    const settleForReal = h.context.wallet.settleTableRound.getMockImplementation();
    let release: () => void = () => undefined;
    h.context.wallet.settleTableRound.mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => {
            settleForReal?.(...args).then(resolve, reject);
          };
        }),
    );

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 10 * revealDelayMs);
    expect(h.context.wallet.settleTableRound.mock.calls).toHaveLength(1);
    expect(status(tableMessage(channel).latest)).toBe(BETTING);
    expect(followUps(calls.alice)).toEqual([]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(status(tableMessage(channel).latest)).toBe(ROLLING);
  });

  it('shows the ball rolling, then about 1.5 seconds later the result for every player', async () => {
    const h = harness();
    const channel = new FakeChannel();
    const calls = await threePlayers(h, channel);
    const message = tableMessage(channel);

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    expect(status(message.latest)).toBe(ROLLING);
    await vi.advanceTimersByTimeAsync(revealDelayMs - 1);
    expect(status(message.latest)).toBe(ROLLING);
    expect(followUps(calls.alice)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    const statuses = message.edits.map(status);
    expect(statuses.slice(-2)).toEqual([ROLLING, '⚫ **17** Black']);
    expect(statuses.slice(0, -2).every((line) => line === BETTING)).toBe(true);
    expect(embedsOf(message.latest)[0]?.description?.split('\n')).toEqual([
      '⚫ **17** Black',
      '',
      '**Alice** · stake 🪙 20 · payout 🪙 360 · net +🪙 340',
      '**Bob** · stake 🪙 70 · payout 🪙 400 · net +🪙 330',
      '**Cleo** · stake 🪙 30 · payout 🪙 0 · net -🪙 30',
    ]);
    expect(followUps(calls.alice)).toHaveLength(1);
  });

  it('sends each player their own result on their latest /roulette, with ✅ and ❌ per bet', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17);
    const earlier = await place(h, alice, '10:17', channel);
    const latest = await place(h, alice, '10:red', channel);
    const bobs = await place(h, bob, '50:orphelins, 20:black', channel);
    const cleos = await place(h, cleo, '30:d1', channel);

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + revealDelayMs);

    expect(followUps(earlier.calls)).toEqual([]);
    const [mine] = followUps(latest.calls);
    expect(isEphemeral(mine?.options)).toBe(true);
    expect(embedsOf(mine?.options).map((embed) => embed.color)).toEqual([Colors.Green]);
    const text = textOf(mine?.options);
    expect(text).toContain('✅ `17` · 🪙 10 → 🪙 360\n❌ `red` · 🪙 10 → 🪙 0');
    expect(text).toMatch(/^Total stake\n🪙 20$/m);
    expect(text).toMatch(/^Total payout\n🪙 360$/m);
    expect(text).toMatch(/^Balance\n🪙 5,000,340$/m);
    expect(text).toMatch(/^Net result\n\+🪙 340$/m);

    const [his] = followUps(bobs.calls);
    expect(textOf(his?.options)).toContain(
      '✅ Orphelins · 🪙 50 → 🪙 360\n✅ `black` · 🪙 20 → 🪙 40',
    );
    expect(textOf(his?.options)).toMatch(/^Net result\n\+🪙 330$/m);

    const [hers] = followUps(cleos.calls);
    expect(embedsOf(hers?.options).map((embed) => embed.color)).toEqual([Colors.Red]);
    expect(textOf(hers?.options)).toContain('❌ `d1` · 🪙 30 → 🪙 0');
    expect(textOf(hers?.options)).toMatch(/^Net result\n-🪙 30$/m);
  });

  it('ends the game after the result: the table gets its lobby back and the players are free', async () => {
    const h = harness();
    const channel = new FakeChannel();
    await threePlayers(h, channel);
    const [game] = h.context.tables.all();

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + revealDelayMs - 1);
    expect(hostAt(h).ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(hostAt(h).ends).toEqual([{ game, reason: 'over' }]);
    expect(hostAt(h).closeCalls).toBe(0);
    expect(h.context.tables.all()).toEqual([]);
    expect(h.context.tables.tableOf('roulette', GUILD_ID, alice.user.id)).toBeUndefined();
    const next = await place(h, alice, '10:red', channel);
    expect(h.context.wallet.openTableRound.mock.calls).toHaveLength(2);
    expect(next.url).toBe(tableMessage(channel, 1).url);
  });

  it('tells a player who bets while the ball rolls to wait for the next spin', async () => {
    const h = harness();
    const channel = new FakeChannel();
    await threePlayers(h, channel);
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);

    expect(await refusal(h, alice, '10:black', channel)).toBe(BETTING_CLOSED);
    expect(h.context.wallet.raiseRound.mock.calls).toEqual([]);
  });
});

describe('a spin that cannot be settled (SPEC §10)', () => {
  const REFUNDED = 'Something went wrong, so this spin was cancelled. Every stake was refunded.';
  const PENDING =
    'Something went wrong, so this spin was cancelled. Every stake comes back automatically shortly.';
  const SETTLED =
    'Something went wrong while showing this spin, but it went through. Check `/balance` for your coins.';

  it('refunds the table round, says the spin was cancelled and ends the game', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17);
    const { calls } = await place(h, alice, '10:17', channel);
    const [game] = h.context.tables.all();
    h.context.wallet.settleTableRound.mockRejectedValueOnce(new Error('deadlock detected'));

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + revealDelayMs);

    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[TABLE_ROUND]]);
    const message = tableMessage(channel);
    expect(status(message.latest)).toBe(REFUNDED);
    expect(message.edits.map(status)).not.toContain(ROLLING);
    expect(followUps(calls)).toEqual([]);
    expect(hostAt(h).ends).toEqual([{ game, reason: 'over' }]);
    expect(h.context.tables.all()).toEqual([]);
    expect(h.context.tables.tableOf('roulette', GUILD_ID, alice.user.id)).toBeUndefined();
    expect(h.logs).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'could not settle a roulette spin',
        tableRoundId: TABLE_ROUND,
        err: expect.objectContaining({ message: 'deadlock detected' }) as unknown,
      }),
    ]);
  });

  it('says the stakes come back shortly when the refund fails as well, and retries it', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17);
    await place(h, alice, '10:17', channel);
    h.context.wallet.settleTableRound.mockRejectedValueOnce(new Error('deadlock detected'));
    h.context.wallet.refundTableRound.mockRejectedValueOnce(new Error('connection lost'));

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);

    expect(status(tableMessage(channel).latest)).toBe(PENDING);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[TABLE_ROUND]]);
    expect(h.logs.map((line) => [line.level, line.msg])).toEqual([
      [50, 'could not settle a roulette spin'],
      [50, 'could not refund a table round'],
    ]);
    expect(h.context.tables.all()).toEqual([]);
    expect(hostAt(h).ends.map((end) => end.reason)).toEqual(['over']);

    await vi.advanceTimersByTimeAsync(REFUND_RETRY_MS[0] ?? 0);

    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[TABLE_ROUND], [TABLE_ROUND]]);
    expect(h.logs.at(-1)).toMatchObject({
      level: 30,
      msg: 'refunded a table round',
      result: 'refunded',
    });
  });

  it('says the spin went through when the refund finds the round settled after all', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17);
    await place(h, alice, '10:17', channel);
    h.context.wallet.settleTableRound.mockRejectedValueOnce(new Error('connection reset'));
    h.context.wallet.refundTableRound.mockRejectedValueOnce(
      new TableRoundClosedError(TABLE_ROUND, 'settled'),
    );

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    await vi.advanceTimersByTimeAsync(REFUND_RETRY_MS.reduce((sum, ms) => sum + ms, 0));

    expect(status(tableMessage(channel).latest)).toBe(SETTLED);
    expect(h.context.wallet.refundTableRound.mock.calls).toHaveLength(1);
    expect(hostAt(h).ends.map((end) => end.reason)).toEqual(['over']);
  });
});

describe('a lost table (its message or thread is gone)', () => {
  it('seats nobody new there, still spins and sends the results, then the table closes', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17, 17);
    const alices = await place(h, alice, '10:17', channel);
    const [lost] = h.context.tables.all();
    tableMessage(channel).editError = discordError(10008);
    const bobs = await place(h, bob, '10:red', channel);
    await vi.advanceTimersByTimeAsync(0);

    const cleos = await place(h, cleo, '10:black', channel);

    expect(cleos.url).toBe(tableMessage(channel, 1).url);
    expect(lost?.hasRoom()).toBe(false);
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + revealDelayMs);
    expect(
      h.context.wallet.settleTableRound.mock.calls.map(([tableRound, , settlements]) => [
        tableRound,
        settlements.map((settlement) => settlement.roundId),
      ]),
    ).toEqual([
      [TABLE_ROUND, [100, 101]],
      [TABLE_ROUND + 1, [102]],
    ]);
    expect(followUps(alices.calls)).toHaveLength(1);
    expect(followUps(bobs.calls)).toHaveLength(1);
    expect(hostAt(h, 0).ends).toEqual([{ game: lost, reason: 'lost' }]);
    expect(hostAt(h, 0).closeCalls).toBe(1);
    expect(hostAt(h, 1).ends.map((end) => end.reason)).toEqual(['over']);
    expect(h.logs.filter((line) => line.msg === 'could not edit a roulette table')).toEqual([
      expect.objectContaining({ level: 40, lost: true, tableId: lost?.id }),
    ]);
  });
});

describe('closing at shutdown', () => {
  it('opens no new table once the shutdown has started', async () => {
    const h = harness();
    await h.context.tables.closeAll();

    const text = await refusal(h, alice, '10:17', new FakeChannel());

    expect(text).toBe(t('en-US', 'errors.restarting'));
    expect(h.context.wallet.openTableRound.mock.calls).toEqual([]);
    expect(h.context.hosts.open.mock.calls).toEqual([]);
    expect(h.context.tables.all()).toEqual([]);
  });

  it('closes a table that opens while the shutdown waits, and turns away the /roulette after it', async () => {
    const h = harness();
    const channel = new FakeChannel();
    let openTableRound: (tableRoundId: number) => void = () => undefined;
    h.context.wallet.openTableRound.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          openTableRound = resolve;
        }),
    );
    const opening = attempt(h, alice, '10:17', channel);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.context.wallet.openTableRound.mock.calls).toHaveLength(1);

    const closing = h.context.tables.closeAll();
    const late = attempt(h, bob, '10:red', channel);
    openTableRound(TABLE_ROUND);
    const [opened, failures, turnedAway] = await Promise.all([opening, closing, late]);

    expect(failures).toEqual([]);
    expect(opened.placement?.url).toBe(tableMessage(channel).url);
    expect(status(tableMessage(channel).latest)).toBe(CLOSED);
    expect(hostAt(h).closeCalls).toBe(1);
    expect(h.context.tables.all()).toEqual([]);
    expect(h.context.tables.allHosts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(turnedAway.error).toEqual(new PlayerError('errors.restarting'));
    expect(h.context.wallet.openRound.mock.calls.map(([who]) => who.userId)).toEqual([
      alice.user.id,
    ]);
    expect(h.context.hosts.open.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * COUNTDOWN_MS);
    expect(h.context.wallet.settleTableRound.mock.calls).toEqual([]);
  });

  it('stops the countdown, so advancing time settles nothing, and says the stakes come back', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17);
    await place(h, alice, '10:17', channel);

    const failures = await h.context.tables.closeAll();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * COUNTDOWN_MS);

    expect(failures).toEqual([]);
    expect(h.context.wallet.settleTableRound.mock.calls).toEqual([]);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([]);
    expect(status(tableMessage(channel).latest)).toBe(CLOSED);
    expect(h.context.tables.all()).toEqual([]);
    expect(hostAt(h).ends).toEqual([]);
    expect(hostAt(h).closeCalls).toBe(1);
  });

  it('refuses bets at a table that has closed', async () => {
    const h = harness();
    const channel = new FakeChannel();
    await place(h, alice, '10:17', channel);
    const [table] = h.context.tables.all();

    await table?.close();

    expect(table?.hasRoom()).toBe(false);
    expect(await refusal(h, alice, '10:red', channel)).toBe(BETTING_CLOSED);
    expect(h.context.wallet.raiseRound.mock.calls).toEqual([]);
  });

  it('shows a settled spin at once instead of waiting for the reveal, and leaves the table to the shutdown', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17);
    const { calls } = await place(h, alice, '10:17', channel);
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    expect(status(tableMessage(channel).latest)).toBe(ROLLING);

    await h.context.tables.closeAll();

    expect(status(tableMessage(channel).latest)).toBe('⚫ **17** Black');
    expect(followUps(calls)).toHaveLength(1);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([]);
    expect(hostAt(h).ends).toEqual([]);
    expect(hostAt(h).closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('failures while revealing', () => {
  it('logs an edit or a follow-up that fails, and still shows the rest', async () => {
    const h = harness();
    const channel = new FakeChannel();
    h.draws.push(17);
    await place(h, alice, '10:17', channel, {
      prepare: (interaction) => {
        vi.spyOn(interaction, 'followUp').mockRejectedValue(new Error('Unknown Webhook'));
      },
    });
    const bobs = await place(h, bob, '10:red', channel);
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS - 1);
    const message = tableMessage(channel);
    vi.spyOn(message, 'edit').mockRejectedValueOnce(new Error('Unknown Message'));

    await vi.advanceTimersByTimeAsync(1 + revealDelayMs);

    expect(status(message.latest)).toBe('⚫ **17** Black');
    expect(message.edits.map(status)).not.toContain(ROLLING);
    expect(followUps(bobs.calls)).toHaveLength(1);
    expect(h.logs).toEqual([
      expect.objectContaining({ level: 40, msg: 'could not edit a roulette table', lost: false }),
      expect.objectContaining({
        level: 40,
        msg: 'could not send a roulette result',
        userId: alice.user.id,
      }),
    ]);
    expect(h.context.tables.all()).toEqual([]);
    expect(hostAt(h).ends.map((end) => end.reason)).toEqual(['over']);
  });
});

describe('playRoulette: /roulette and the bet form (SPEC §6)', () => {
  async function play(
    h: Harness,
    fake: Fake<PlayInteraction>,
    bets: string,
  ): Promise<ResponseCall[]> {
    await playRoulette(fake.interaction, bets, h.context);
    return fake.calls;
  }

  function descriptionLines(payload: unknown): string[] {
    return embedsOf(payload)[0]?.description?.split('\n') ?? [];
  }

  it('plays a bet form in a lobby exactly like /roulette there', async () => {
    const viaForm = harness();
    const viaCommand = harness();
    const formLobby = await lobbyIn(viaForm, new FakeChannel());
    const commandLobby = await lobbyIn(viaCommand, new FakeChannel());
    viaForm.draws.push(17);
    viaCommand.draws.push(17);
    const who = { user: bob.user, displayName: bob.name };

    const form = await play(
      viaForm,
      fakeModalSubmit('tb:h1:form-roulette:1', {
        ...who,
        channel: formLobby.thread,
        fields: { bets: '10:17, 20:red' },
      }),
      '10:17, 20:red',
    );
    const command = await play(
      viaCommand,
      fakeChatInput('roulette', {
        ...who,
        channel: commandLobby.thread,
        strings: { bets: '10:17, 20:red' },
      }),
      '10:17, 20:red',
    );

    expect(form.map((call) => call.method)).toEqual(['deferReply', 'editReply']);
    expect(form[0]).toEqual({ method: 'deferReply', options: { flags: MessageFlags.Ephemeral } });
    expect(form).toEqual(command);
    expect(descriptionLines(form[1]?.options)).toEqual([
      '🪙 10 on `17`',
      '🪙 20 on `red`',
      '',
      'Total: **🪙 30** on 2 bets',
      `The wheel spins ${SPINS_AT}.`,
      `[Go to the table](${formLobby.thread.messages[0]?.url ?? 'no table'})`,
    ]);
    expect(formLobby.begun).toHaveLength(1);
    expect(viaForm.context.wallet.openRound.mock.calls).toEqual(
      viaCommand.context.wallet.openRound.mock.calls,
    );

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + revealDelayMs);

    expect(form.map((call) => call.method)).toEqual(['deferReply', 'editReply', 'followUp']);
    expect(form.at(-1)).toEqual(command.at(-1));
    expect(isEphemeral(form.at(-1)?.options)).toBe(true);
    expect(formLobby.ends.map((end) => end.reason)).toEqual(['over']);
  });

  it('does not defer a second time when the caller deferred already', async () => {
    const h = harness();
    const lobby = await lobbyIn(h, new FakeChannel());
    const fake = fakeModalSubmit('tb:h1:form-roulette:1', {
      channel: lobby.thread,
      fields: { bets: '10:red' },
    });
    await fake.interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const calls = await play(h, fake, '10:red');

    expect(calls.map((call) => call.method)).toEqual(['deferReply', 'editReply']);
  });

  it('defers before it reads the balance, and leaves a refused read to the caller', async () => {
    const h = harness();
    const fake = fakeChatInput('roulette', {
      channel: new FakeChannel(),
      strings: { bets: '10:red' },
    });
    const down = new PlayerError('errors.restarting');
    h.context.wallet.balanceOf.mockImplementationOnce(() => {
      expect(fake.calls.map((call) => call.method)).toEqual(['deferReply']);
      return Promise.reject(down);
    });

    await expect(play(h, fake, '10:red')).rejects.toBe(down);

    expect(fake.calls).toEqual([
      { method: 'deferReply', options: { flags: MessageFlags.Ephemeral } },
    ]);
    expect(h.context.wallet.openTableRound.mock.calls).toEqual([]);
  });

  it('links the table without "another channel" when the player is in its thread', async () => {
    const h = harness();
    const channel = new FakeChannel();
    await place(h, alice, '10:17', channel);
    const { thread } = hostAt(h);

    const calls = await play(
      h,
      fakeChatInput('roulette', { user: bob.user, channel: thread, strings: { bets: '10:red' } }),
      '10:red',
    );

    expect(descriptionLines(calls.at(-1)?.options).at(-1)).toBe(
      `[Go to the table](${tableMessage(channel).url})`,
    );
  });
});
