import {
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ActionRowBuilder,
  type APIButtonComponentWithCustomId,
  type ButtonBuilder,
  type ModalBuilder,
  type ModalSubmitInteraction,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveTable } from '../../../src/bot/tables/registry.js';
import {
  createTableHosts,
  type PlayInteraction,
  type TableHost,
} from '../../../src/bot/tables/table.js';
import type { TableParent } from '../../../src/bot/tables/thread.js';
import type { AppContext } from '../../../src/bot/types.js';
import { gameConfig } from '../../../src/config/game.js';
import { PlayerError } from '../../../src/core/errors.js';
import type { TableGame } from '../../../src/core/wallet.js';
import {
  captureLogs,
  fakeContext,
  FIXED_NOW,
  type FakeWallet,
  type LogCapture,
} from '../../helpers/context.js';
import {
  CHANNEL_ID,
  contentOf,
  discordError,
  FakeChannel,
  fakeButton,
  fakeModalSubmit,
  fakeUser,
  GUILD_ID,
  isEphemeral,
  textOf,
  type FakeCollector,
  type FakeMessage,
  type FakeThread,
  type FakeUser,
  type ResponseCall,
} from '../../helpers/discord.js';

type Play = (interaction: PlayInteraction, text: string, context: AppContext) => Promise<void>;

const { playRoulette, playBlackjack } = vi.hoisted(() => ({
  playRoulette: vi.fn<Play>(() => Promise.resolve()),
  playBlackjack: vi.fn<Play>(() => Promise.resolve()),
}));

vi.mock('../../../src/bot/tables/roulette-table.js', () => ({ playRoulette }));
vi.mock('../../../src/bot/tables/blackjack-table.js', () => ({ playBlackjack }));

const ALICE = fakeUser('200000000000000001', 'alice', 'Alice');
const BOB = fakeUser('200000000000000002', 'bob', 'Bob');
const LOBBY_MS = gameConfig.tables.lobbyMinutes * 60_000;

interface Harness {
  readonly context: AppContext;
  readonly channel: FakeChannel;
  readonly next: ReturnType<typeof vi.fn<(guildId: string) => Promise<number>>>;
  readonly logs: LogCapture;
  /** Moves the context's clock; timers move with vi.advanceTimersByTimeAsync. */
  readonly later: (minutes: number) => void;
}

function setUp(): Harness {
  let count = 0;
  let now = FIXED_NOW;
  const next = vi.fn<(guildId: string) => Promise<number>>(() => Promise.resolve((count += 1)));
  const logs = captureLogs();
  const base = fakeContext({ logger: logs.logger, clock: () => now });
  const context: AppContext = { ...base, hosts: createTableHosts({ next }) };
  const later = (minutes: number): void => {
    now = now.add({ minutes });
  };
  return { context, channel: new FakeChannel(), next, logs, later };
}

interface Opened {
  readonly host: TableHost;
  readonly thread: FakeThread;
}

async function openTable(h: Harness, game: TableGame | null = null, user = ALICE): Promise<Opened> {
  const host = await h.context.hosts.open({
    context: h.context,
    parent: h.channel as unknown as TableParent,
    game,
    locale: 'en-US',
    userId: user.id,
  });
  const thread = h.channel.threadsStarted.at(-1);
  if (thread === undefined) throw new Error('no thread was started');
  return { host, thread };
}

/** Lets every queued press, post and edit run, without moving the clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function lobbyOf(thread: FakeThread, index = -1): FakeMessage {
  const message = thread.messages.at(index);
  if (message === undefined) throw new Error('the thread has no lobby');
  return message;
}

function collectorOf(message: FakeMessage): FakeCollector {
  const collector = message.collectors.at(-1);
  if (collector === undefined) throw new Error('the lobby has no collector');
  return collector;
}

function buttonsOf(payload: unknown): APIButtonComponentWithCustomId[] {
  const { components = [] } = payload as {
    components?: readonly ActionRowBuilder<ButtonBuilder>[];
  };
  return components.flatMap((row) =>
    row.toJSON().components.flatMap((component) => ('custom_id' in component ? [component] : [])),
  );
}

function customIdOf(payload: unknown, action: string): string {
  const button = buttonsOf(payload).find(
    (candidate) => candidate.custom_id.split(':')[2] === action,
  );
  if (button === undefined) throw new Error(`the lobby has no ${action} button`);
  return button.custom_id;
}

function titleOf(message: FakeMessage): string {
  return textOf(message.latest).split('\n')[0] ?? '';
}

const methods = (calls: readonly ResponseCall[]): string[] => calls.map((call) => call.method);

function ephemeral(calls: readonly ResponseCall[]): string[] {
  return calls
    .filter((call) => isEphemeral(call.options))
    .map((call) => contentOf(call.options) ?? '');
}

async function pressButton(
  message: FakeMessage,
  user: FakeUser,
  customId: string,
): Promise<ResponseCall[]> {
  const { interaction, calls } = fakeButton(customId, { message, user });
  collectorOf(message).collect(interaction);
  await flush();
  return calls;
}

const press = (message: FakeMessage, user: FakeUser, action: string): Promise<ResponseCall[]> =>
  pressButton(message, user, customIdOf(message.latest, action));

interface FormRun {
  readonly button: ResponseCall[];
  /** The response calls on the submitted form; empty when it was never submitted. */
  readonly form: ResponseCall[];
  readonly modal: ReturnType<ModalBuilder['toJSON']> | null;
  readonly submit: ModalSubmitInteraction<'cached'> | null;
  readonly filter: (candidate: unknown) => boolean;
  readonly time: number | null;
}

/**
 * Presses a game button and submits the form it shows with `text`, as Discord would; with
 * `submit: 'never'` the form times out, and with a promise it is submitted once that resolves.
 */
async function pickGame(
  message: FakeMessage,
  user: FakeUser,
  game: TableGame,
  text: string,
  when: 'now' | 'never' | Promise<void> = 'now',
): Promise<FormRun> {
  const { interaction, calls } = fakeButton(customIdOf(message.latest, game), { message, user });
  let run: Omit<FormRun, 'button'> = {
    form: [],
    modal: null,
    submit: null,
    filter: () => false,
    time: null,
  };
  Object.assign(interaction, {
    awaitModalSubmit: async (options: {
      filter: (candidate: unknown) => boolean;
      time: number;
    }) => {
      const shown = calls.find((call) => call.method === 'showModal')?.options as ModalBuilder;
      const modal = shown.toJSON();
      const field = game === 'roulette' ? 'bets' : 'bet';
      const submitted = fakeModalSubmit(modal.custom_id, { user, fields: { [field]: text } });
      run = {
        form: submitted.calls,
        modal,
        submit: submitted.interaction,
        filter: options.filter,
        time: options.time,
      };
      if (when === 'never')
        throw new Error('Collector received no interactions before ending with reason: time');
      if (when !== 'now') await when;
      if (!options.filter(submitted.interaction)) throw new Error('the filter refused the form');
      return submitted.interaction;
    },
  });
  collectorOf(message).collect(interaction);
  await flush();
  return { button: calls, ...run };
}

function fakeGame(game: TableGame, id = `${game}-1`): LiveTable & { closeCalls: number } {
  const table = {
    id,
    game,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    closeCalls: 0,
    hasRoom: () => true,
    close: () => {
      table.closeCalls += 1;
      return Promise.resolve();
    },
  };
  return table;
}

/** Plays one game at the table: it begins, then ends as `reason`. */
async function playOnce(
  host: TableHost,
  game: TableGame,
  reason: 'over' | 'lost' = 'over',
): Promise<LiveTable> {
  const table = fakeGame(game);
  host.begin(table);
  await flush();
  host.end(table, reason);
  await flush();
  return table;
}

function warnings(logs: LogCapture): unknown[] {
  return logs.lines.filter((line) => line.level === 40).map((line) => line.msg);
}

beforeEach(() => {
  vi.useFakeTimers();
  playRoulette.mockReset().mockResolvedValue(undefined);
  playBlackjack.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening a table (SPEC §4)', () => {
  it('starts a thread "Table #N" with a lobby, and posts nothing in the channel', async () => {
    const h = setUp();

    const { host, thread } = await openTable(h);

    expect(h.channel.messages).toEqual([]);
    expect(h.next.mock.calls).toEqual([[GUILD_ID]]);
    expect(thread.name).toBe('Table #1');
    expect(thread.autoArchiveDuration).toBe(ThreadAutoArchiveDuration.OneDay);
    expect(thread.messages).toHaveLength(1);
    const lobby = lobbyOf(thread);
    expect(titleOf(lobby)).toBe('Table #1 · pick a game');
    expect(textOf(lobby.latest)).toMatch(new RegExp(`^<@${ALICE.id}>$`, 'm'));
    expect(buttonsOf(lobby.latest).map((button) => button.custom_id)).toEqual([
      'tb:t-1:roulette:1',
      'tb:t-1:blackjack:1',
      'tb:t-1:leave:1',
    ]);
    expect(host).toMatchObject({
      id: 't-1',
      number: 1,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      threadId: thread.id,
      url: thread.url,
      game: null,
      closed: false,
    });
    expect(h.context.tables.hostIn(GUILD_ID, thread.id)).toBe(host);
    expect(h.context.tables.owns(GUILD_ID, 'tb:t-1:leave:1')).toBe(true);
  });

  it('numbers the next table on from the last one', async () => {
    const h = setUp();
    await openTable(h);

    const { host, thread } = await openTable(h, null, BOB);

    expect(host.number).toBe(2);
    expect(thread.name).toBe('Table #2');
  });

  it('names a table opened for a game after it, and posts no lobby before that game ends', async () => {
    const h = setUp();

    const { host, thread } = await openTable(h, 'roulette');
    await host.send({ content: 'the roulette table' });

    expect(thread.name).toBe('Table #1 (Roulette)');
    expect(thread.messages.map((message) => contentOf(message.sent))).toEqual([
      'the roulette table',
    ]);
  });

  it('leaves no table when the lobby cannot be posted', async () => {
    const h = setUp();
    const failure = discordError(50013, 403);
    const create = h.channel.threads.create;
    h.channel.threads.create = async (options) => {
      const thread = await create(options);
      thread.sendError = failure;
      return thread;
    };

    await expect(openTable(h)).rejects.toBe(failure);

    const [thread] = h.channel.threadsStarted;
    expect(thread?.archived).toBe(true);
    expect(h.context.tables.allHosts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves nothing when the thread cannot be started', async () => {
    const h = setUp();
    const failure = discordError(50013, 403);
    h.channel.threadError = failure;

    await expect(openTable(h)).rejects.toBe(failure);

    expect(h.context.tables.allHosts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the bet forms', () => {
  it('Roulette shows a form for the bets, and waits for it as long as the config says', async () => {
    const h = setUp();
    const { thread } = await openTable(h);

    const run = await pickGame(lobbyOf(thread), BOB, 'roulette', '10:red', 'never');

    expect(methods(run.button)).toEqual(['showModal']);
    expect(run.modal?.custom_id).toBe('tb:t-1:form-roulette:1');
    expect(run.modal?.title).toBe('🎡 Roulette');
    expect(JSON.stringify(run.modal?.components)).toContain('"max_length":500');
    expect(run.time).toBe(gameConfig.tables.formSeconds * 1000);
    expect(playRoulette).not.toHaveBeenCalled();
  });

  it('a submitted roulette form plays roulette with the typed bets', async () => {
    const h = setUp();
    const { thread } = await openTable(h);

    const run = await pickGame(lobbyOf(thread), BOB, 'roulette', '10:red, 5:d1');

    expect(playRoulette.mock.calls).toEqual([[run.submit, '10:red, 5:d1', h.context]]);
    expect(playBlackjack).not.toHaveBeenCalled();
  });

  it('a submitted blackjack form plays blackjack with the typed amount', async () => {
    const h = setUp();
    const { thread } = await openTable(h);

    const run = await pickGame(lobbyOf(thread), ALICE, 'blackjack', '1.5k');

    expect(run.modal?.custom_id).toBe('tb:t-1:form-blackjack:1');
    expect(playBlackjack.mock.calls).toEqual([[run.submit, '1.5k', h.context]]);
    expect(playRoulette).not.toHaveBeenCalled();
  });

  it('acknowledges a form and refreshes the player, as interactionCreate does for a command', async () => {
    const h = setUp();
    const { thread } = await openTable(h);

    const run = await pickGame(lobbyOf(thread), BOB, 'roulette', '10:red');

    expect(run.form[0]).toEqual({
      method: 'deferReply',
      options: { flags: MessageFlags.Ephemeral },
    });
    const touches = (h.context.wallet as FakeWallet).touchPlayer.mock;
    expect(touches.calls).toEqual([
      [{ guildId: GUILD_ID, userId: BOB.id, displayName: expect.any(String) as string }],
    ]);
    const touched = touches.invocationCallOrder[0] ?? Infinity;
    expect(touched).toBeLessThan(playRoulette.mock.invocationCallOrder[0] ?? -Infinity);
  });

  it("tells the player privately why the game refused the form's bet", async () => {
    const h = setUp();
    const { thread } = await openTable(h);
    playRoulette.mockRejectedValueOnce(new PlayerError('amount.noCoins'));

    const run = await pickGame(lobbyOf(thread), BOB, 'roulette', '10:red');

    expect(methods(run.form)).toEqual(['deferReply', 'followUp']);
    expect(ephemeral(run.form)).toEqual([
      '',
      'You have no coins to bet. Claim your daily gift with `/dailygift`.',
    ]);
  });

  it('logs an unexpected failure and gives the player the generic message', async () => {
    const h = setUp();
    const { thread } = await openTable(h);
    playBlackjack.mockRejectedValueOnce(new Error('the database is gone'));

    const run = await pickGame(lobbyOf(thread), BOB, 'blackjack', '100');

    expect(ephemeral(run.form)).toEqual([
      '',
      'Something went wrong on our side. Please try again in a moment.',
    ]);
    expect(h.logs.lines.filter((line) => line.level === 50).map((line) => line.msg)).toEqual([
      'interaction failed',
    ]);
  });

  it('leaves a form submitted after the wait ran out to interactionCreate, buttons and all', async () => {
    const h = setUp();
    const { thread } = await openTable(h);
    const lobby = lobbyOf(thread);

    const run = await pickGame(lobby, BOB, 'roulette', '10:red', 'never');
    const formId = run.modal?.custom_id ?? '';

    expect(h.context.tables.owns(GUILD_ID, formId)).toBe(false);
    expect(h.context.tables.isLive(GUILD_ID, formId)).toBe(true);
    expect(h.context.tables.owns(GUILD_ID, customIdOf(lobby.latest, 'blackjack'))).toBe(true);
  });

  it("waits only for this player's own form", async () => {
    const h = setUp();
    const { thread } = await openTable(h);

    const run = await pickGame(lobbyOf(thread), BOB, 'roulette', '10:red', 'never');

    const customId = run.modal?.custom_id ?? '';
    expect(run.filter(fakeModalSubmit(customId, { user: BOB }).interaction)).toBe(true);
    expect(run.filter(fakeModalSubmit(customId, { user: ALICE }).interaction)).toBe(false);
    expect(run.filter(fakeModalSubmit('tb:t-1:form-roulette:2', { user: BOB }).interaction)).toBe(
      false,
    );
  });

  it('plays nothing for a form submitted after the table closed', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    let submit = (): void => undefined;
    const submitted = new Promise<void>((resolve) => {
      submit = resolve;
    });
    const run = await pickGame(lobbyOf(thread), BOB, 'roulette', '10:red', submitted);

    await host.close();
    submit();
    await flush();

    expect(playRoulette).not.toHaveBeenCalled();
    expect(run.form).toEqual([]);
  });

  it('only acknowledges a lobby button pressed after the game started', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const lobby = lobbyOf(thread);
    host.begin(fakeGame('roulette'));
    await flush();

    const calls = await pressButton(lobby, BOB, customIdOf(lobby.sent, 'blackjack'));

    expect(methods(calls)).toEqual(['deferUpdate']);
  });
});

describe('playing a game', () => {
  it('renames the thread to the game and takes the buttons off the lobby', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const game = fakeGame('roulette');

    host.begin(game);
    await flush();

    expect(host.game).toBe(game);
    expect(thread.renames).toEqual(['Table #1 (Roulette)']);
    expect(thread.name).toBe('Table #1 (Roulette)');
    const lobby = lobbyOf(thread);
    expect(titleOf(lobby)).toBe('Table #1 · playing Roulette');
    expect(buttonsOf(lobby.latest)).toEqual([]);
  });

  it('refuses a second game while one runs, and any game once closed', async () => {
    const h = setUp();
    const { host } = await openTable(h);
    host.begin(fakeGame('roulette'));

    expect(() => {
      host.begin(fakeGame('blackjack'));
    }).toThrow(/already plays roulette/);
    await host.close();
    // A first bet that raced the table closing: the player gets a clear message, not "went wrong".
    expect(() => {
      host.begin(fakeGame('blackjack'));
    }).toThrow(new PlayerError('errors.tableClosed'));
  });

  it('posts a new lobby at the bottom of the thread when the game is over, with every player', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const game = fakeGame('roulette');
    host.begin(game);
    host.addPlayer(BOB.id);
    await flush();

    host.end(game, 'over');
    await flush();

    expect(host.game).toBeNull();
    expect(thread.messages).toHaveLength(2);
    expect(titleOf(lobbyOf(thread, 0))).toBe('Table #1 · playing Roulette');
    expect(collectorOf(lobbyOf(thread, 0)).ended).toBe(true);
    const lobby = lobbyOf(thread);
    expect(titleOf(lobby)).toBe('Table #1 · pick a game');
    expect(textOf(lobby.latest)).toMatch(new RegExp(`^<@${ALICE.id}>, <@${BOB.id}>$`, 'm'));
    const run = await pickGame(lobby, BOB, 'blackjack', '100');
    expect(playBlackjack.mock.calls).toEqual([[run.submit, '100', h.context]]);
  });

  it("ignores the end of a game that isn't the current one", async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const game = fakeGame('roulette');
    host.begin(game);

    host.end(fakeGame('roulette', 'roulette-2'), 'lost');
    await flush();

    expect(host.game).toBe(game);
    expect(host.closed).toBe(false);
    expect(thread.messages).toHaveLength(1);
  });

  it('renames only when the game changes, at most twice in 10 minutes', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);

    await playOnce(host, 'roulette');
    await playOnce(host, 'roulette');
    await playOnce(host, 'blackjack');
    await playOnce(host, 'roulette');

    expect(thread.renames).toEqual(['Table #1 (Roulette)', 'Table #1 (Blackjack)']);
    expect(thread.name).toBe('Table #1 (Blackjack)');

    h.later(9);
    await playOnce(host, 'roulette');
    expect(thread.renames).toHaveLength(2);

    h.later(1);
    await playOnce(host, 'roulette');
    expect(thread.renames).toEqual([
      'Table #1 (Roulette)',
      'Table #1 (Blackjack)',
      'Table #1 (Roulette)',
    ]);
  });

  it('only logs a failed rename, and tries again at the next game', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    thread.renameError = discordError(50013, 403);

    await playOnce(host, 'roulette');
    thread.renameError = undefined;
    await playOnce(host, 'roulette');

    expect(warnings(h.logs)).toEqual(['could not rename a table thread']);
    expect(thread.renames).toEqual(['Table #1 (Roulette)', 'Table #1 (Roulette)']);
    expect(thread.name).toBe('Table #1 (Roulette)');
  });

  it('closes the table when a new lobby cannot be posted', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const game = fakeGame('roulette');
    host.begin(game);
    await flush();
    thread.sendError = discordError(50083, 400);

    host.end(game, 'over');
    await flush();

    expect(host.closed).toBe(true);
    expect(thread.archived).toBe(true);
    expect(h.context.tables.allHosts()).toEqual([]);
  });
});

describe('leaving the table', () => {
  it('the last player to leave closes the table and archives the thread', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const lobby = lobbyOf(thread);

    const calls = await press(lobby, ALICE, 'leave');

    expect(methods(calls)).toEqual(['update']);
    expect(titleOf(lobby)).toBe('Table #1 · closed');
    expect(textOf(lobby.latest)).toMatch(/^Everyone has left, so this table has closed\./m);
    expect(buttonsOf(lobby.latest)).toEqual([]);
    expect(host.closed).toBe(true);
    expect(thread.archived).toBe(true);
    expect(h.context.tables.hostIn(GUILD_ID, thread.id)).toBeUndefined();
    expect(h.context.tables.owns(GUILD_ID, 'tb:t-1:leave:1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes a leaving player off the list while others stay', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    host.addPlayer(BOB.id);
    const lobby = lobbyOf(thread);

    const calls = await press(lobby, BOB, 'leave');

    expect(methods(calls)).toEqual(['update']);
    expect(textOf(lobby.latest)).toMatch(new RegExp(`^<@${ALICE.id}>$`, 'm'));
    expect(host.closed).toBe(false);
    expect(thread.archived).toBe(false);
  });

  it('tells someone who is not a player that there is nothing to leave', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const lobby = lobbyOf(thread);

    const calls = await press(lobby, BOB, 'leave');

    expect(ephemeral(calls)).toEqual([
      "You aren't a player at this table, so there's nothing to leave.",
    ]);
    expect(lobby.edits).toEqual([]);
    expect(host.closed).toBe(false);
  });
});

describe('closing the table', () => {
  it('closes when no game starts within the lobby time', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const lobby = lobbyOf(thread);
    expect(textOf(lobby.latest)).toContain(
      `closes <t:${String(FIXED_NOW.epochMilliseconds / 1000 + LOBBY_MS / 1000)}:R>`,
    );

    await vi.advanceTimersByTimeAsync(LOBBY_MS - 1);
    expect(thread.archived).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(host.closed).toBe(true);
    expect(thread.archived).toBe(true);
    expect(textOf(lobby.latest)).toMatch(
      new RegExp(
        `^No game started for ${String(gameConfig.tables.lobbyMinutes)} minutes, so this table has closed\\.`,
        'm',
      ),
    );
    expect(h.context.tables.allHosts()).toEqual([]);
  });

  it('stops the lobby timer while a game runs, and starts it again with the next lobby', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const game = fakeGame('blackjack');
    host.begin(game);

    await vi.advanceTimersByTimeAsync(LOBBY_MS * 2);
    expect(host.closed).toBe(false);

    host.end(game, 'over');
    await vi.advanceTimersByTimeAsync(LOBBY_MS);
    expect(host.closed).toBe(true);
    expect(thread.archived).toBe(true);
  });

  it('closes a table opened for a game that never begins', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h, 'roulette');

    await vi.advanceTimersByTimeAsync(LOBBY_MS);

    expect(host.closed).toBe(true);
    expect(thread.archived).toBe(true);
  });

  it('closes the table when its game is lost', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);

    await playOnce(host, 'roulette', 'lost');

    expect(host.closed).toBe(true);
    expect(host.game).toBeNull();
    expect(thread.archived).toBe(true);
    expect(thread.messages).toHaveLength(1);
    expect(textOf(lobbyOf(thread).latest)).toMatch(/^This table can't be played any more/m);
    expect(h.context.tables.allHosts()).toEqual([]);
  });

  it('close() archives the thread once, however often it is called', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);

    await host.close();
    await host.close();

    expect(thread.archiveCalls).toEqual([{ archived: true, reason: 'The All-in table closed' }]);
    expect(textOf(lobbyOf(thread).latest)).toMatch(
      /^This table closed because the bot is restarting\./m,
    );
    expect(h.context.tables.allHosts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close() during a game closes the lobby and leaves the game alone', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const game = fakeGame('roulette');
    host.begin(game);

    await host.close();

    expect(titleOf(lobbyOf(thread))).toBe('Table #1 · closed');
    expect(game.closeCalls).toBe(0);
    expect(host.game).toBeNull();
    expect(thread.archived).toBe(true);
  });

  it('only logs an archive that Discord refuses', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    thread.archiveError = discordError(50013, 403);

    await expect(host.close()).resolves.toBeUndefined();

    expect(thread.archiveCalls).toHaveLength(1);
    expect(warnings(h.logs)).toEqual(['could not archive a table thread']);
  });

  it('closes when its thread is deleted', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);

    collectorOf(lobbyOf(thread)).stop('threadDelete');
    await flush();

    expect(host.closed).toBe(true);
    expect(h.context.tables.allHosts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a new lobby that was still on its way when the table closed', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const game = fakeGame('roulette');
    host.begin(game);
    await flush();
    const send = thread.send.bind(thread);
    let arrive = (): void => undefined;
    thread.send = async (options) => {
      await new Promise<void>((resolve) => {
        arrive = resolve;
      });
      return send(options);
    };
    host.end(game, 'over');
    await flush();

    const closing = host.close();
    arrive();
    await closing;

    const lobby = lobbyOf(thread);
    expect(thread.messages).toHaveLength(2);
    expect(titleOf(lobby)).toBe('Table #1 · closed');
    expect(lobby.collectors).toEqual([]);
    expect(thread.archived).toBe(true);
  });

  it('at shutdown, a game that ends posts no new lobby, and the lobby says the table closed', async () => {
    const h = setUp();
    const { host, thread } = await openTable(h);
    const game = fakeGame('roulette');
    host.begin(game);
    game.close = () => {
      host.end(game, 'over');
      return Promise.resolve();
    };
    h.context.tables.add(game);

    expect(await h.context.tables.closeAll()).toEqual([]);
    await flush();

    expect(thread.messages).toHaveLength(1);
    expect(textOf(lobbyOf(thread).latest)).toMatch(
      /^This table closed because the bot is restarting\./m,
    );
    expect(thread.archived).toBe(true);
  });
});
