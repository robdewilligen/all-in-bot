import { Collection, MessageFlags } from 'discord.js';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { Cooldowns } from '../../src/bot/cooldowns.js';
import type { Command } from '../../src/bot/types.js';
import { PlayerError } from '../../src/core/errors.js';
import interactionCreate from '../../src/events/interaction-create.js';
import { t } from '../../src/i18n/index.js';
import { captureLogs, fakeContext, FIXED_NOW } from '../helpers/context.js';
import {
  fakeAutocomplete,
  fakeButton,
  fakeChatInput,
  fakeModalSubmit,
  fakeUser,
  GUILD_ID,
  USER_ID,
} from '../helpers/discord.js';

type Autocomplete = NonNullable<Command['autocomplete']>;

interface TestCommand extends Command {
  readonly execute: Mock<Command['execute']>;
}

function testCommand(
  name: string,
  extra: Partial<Pick<Command, 'cooldown' | 'autocomplete'>> = {},
): TestCommand {
  return {
    data: { name, toJSON: () => ({ name, description: `The ${name} command` }) },
    execute: vi.fn<Command['execute']>(() => Promise.resolve()),
    ...extra,
  };
}

function commandsOf(...commands: Command[]): Collection<string, Command> {
  return new Collection(commands.map((command) => [command.data.name, command]));
}

function ephemeral(content: string): { content: string; flags: MessageFlags.Ephemeral } {
  return { content, flags: MessageFlags.Ephemeral };
}

describe('chat input commands', () => {
  it('refreshes the player with their display name before running the command', async () => {
    const order: string[] = [];
    const ping = testCommand('ping');
    ping.execute.mockImplementation(() => {
      order.push('execute');
      return Promise.resolve();
    });
    const context = fakeContext();
    context.wallet.touchPlayer.mockImplementation(() => {
      order.push('touchPlayer');
      return Promise.resolve();
    });
    const { interaction } = fakeChatInput('ping', {
      commands: commandsOf(ping),
      displayName: 'Ace of Spades',
    });

    await interactionCreate.execute(context, interaction);

    expect(context.wallet.touchPlayer.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: USER_ID, displayName: 'Ace of Spades' }],
    ]);
    expect(ping.execute).toHaveBeenCalledExactlyOnceWith(interaction, context);
    expect(order).toEqual(['touchPlayer', 'execute']);
  });

  it('does not run the command when refreshing the player fails', async () => {
    const ping = testCommand('ping');
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    context.wallet.touchPlayer.mockRejectedValue(new Error('database down'));
    const { interaction, calls } = fakeChatInput('ping', { commands: commandsOf(ping) });

    await interactionCreate.execute(context, interaction);

    expect(ping.execute).not.toHaveBeenCalled();
    expect(calls).toEqual([{ method: 'reply', options: ephemeral(t('en-US', 'errors.generic')) }]);
    expect(lines).toEqual([
      expect.objectContaining({ level: 50, msg: 'interaction failed', command: 'ping' }),
    ]);
  });

  it('shows a PlayerError from the command as its own ephemeral message', async () => {
    const spin = testCommand('spin');
    spin.execute.mockRejectedValue(
      new PlayerError('errors.insufficientFunds', { needed: '🪙 50', balance: '🪙 20' }),
    );
    const { interaction, calls } = fakeChatInput('spin', { commands: commandsOf(spin) });

    await interactionCreate.execute(fakeContext(), interaction);

    expect(calls).toEqual([
      {
        method: 'reply',
        options: ephemeral(
          t('en-US', 'errors.insufficientFunds', { needed: '🪙 50', balance: '🪙 20' }),
        ),
      },
    ]);
  });

  it('logs an unexpected error after a defer and follows up with the generic message', async () => {
    const ping = testCommand('ping');
    ping.execute.mockImplementation(async (interaction) => {
      await interaction.deferReply();
      throw new Error('boom');
    });
    const { logger, lines } = captureLogs();
    const { interaction, calls } = fakeChatInput('ping', { commands: commandsOf(ping) });

    await interactionCreate.execute(fakeContext({ logger }), interaction);

    expect(calls).toEqual([
      { method: 'deferReply', options: undefined },
      { method: 'followUp', options: ephemeral(t('en-US', 'errors.generic')) },
    ]);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'interaction failed',
        guildId: GUILD_ID,
        userId: USER_ID,
        command: 'ping',
        err: expect.objectContaining({ message: 'boom' }) as unknown,
      }),
    ]);
  });

  it('answers an unknown command with the generic message and logs a warning', async () => {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    const { interaction, calls } = fakeChatInput('gone', { commands: commandsOf() });

    await interactionCreate.execute(context, interaction);

    expect(calls).toEqual([{ method: 'reply', options: ephemeral(t('en-US', 'errors.generic')) }]);
    expect(lines).toEqual([
      expect.objectContaining({ level: 40, msg: 'unknown command', command: 'gone' }),
    ]);
    expect(context.wallet.touchPlayer.mock.calls).toEqual([]);
  });

  it('tells the player that commands only work in servers', async () => {
    const ping = testCommand('ping');
    const context = fakeContext();
    const { interaction, calls } = fakeChatInput('ping', { commands: commandsOf(ping) });
    Object.assign(interaction, { inCachedGuild: () => false });

    await interactionCreate.execute(context, interaction);

    expect(calls).toEqual([
      { method: 'reply', options: ephemeral(t('en-US', 'errors.guildOnly')) },
    ]);
    expect(context.wallet.touchPlayer.mock.calls).toEqual([]);
    expect(ping.execute).not.toHaveBeenCalled();
  });
});

describe('cooldowns', () => {
  function setup(...commands: TestCommand[]) {
    let now = FIXED_NOW;
    const context = fakeContext({ cooldowns: new Cooldowns(), clock: () => now });
    const collection = commandsOf(...commands);
    return {
      context,
      advance: (seconds: number): void => {
        now = now.add({ seconds });
      },
      use: async (name: string, options: Parameters<typeof fakeChatInput>[1] = {}) => {
        const fake = fakeChatInput(name, { commands: collection, ...options });
        await interactionCreate.execute(context, fake.interaction);
        return fake.calls;
      },
    };
  }

  const nowSeconds = FIXED_NOW.epochMilliseconds / 1000;

  it('answers a second use within the cooldown with an ephemeral relative timestamp', async () => {
    const ping = testCommand('ping');
    const { context, advance, use } = setup(ping);

    await use('ping');
    advance(2);
    const calls = await use('ping');

    expect(ping.execute).toHaveBeenCalledOnce();
    expect(context.wallet.touchPlayer.mock.calls).toHaveLength(1);
    expect(calls).toEqual([
      {
        method: 'reply',
        options: ephemeral(
          t('en-US', 'errors.cooldown', { command: 'ping', time: `<t:${nowSeconds + 3}:R>` }),
        ),
      },
    ]);
  });

  it('does not hold back other users, servers or commands', async () => {
    const ping = testCommand('ping');
    const pong = testCommand('pong');
    const { use } = setup(ping, pong);

    await use('ping');
    await use('ping', { user: fakeUser('200000000000000002', 'bob') });
    await use('ping', { guildId: '100000000000000002' });
    await use('pong');

    expect(ping.execute).toHaveBeenCalledTimes(3);
    expect(pong.execute).toHaveBeenCalledOnce();
  });

  it('lets the player use the command again once the cooldown has passed', async () => {
    const ping = testCommand('ping');
    const { advance, use } = setup(ping);

    await use('ping');
    advance(3);
    const calls = await use('ping');

    expect(ping.execute).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
  });

  it("uses the command's own cooldown when it sets one", async () => {
    const leaderboard = testCommand('leaderboard', { cooldown: 5 });
    const { advance, use } = setup(leaderboard);

    await use('leaderboard');
    advance(4);
    const blocked = await use('leaderboard');
    advance(1);
    await use('leaderboard');

    expect(blocked).toEqual([
      {
        method: 'reply',
        options: ephemeral(
          t('en-US', 'errors.cooldown', {
            command: 'leaderboard',
            time: `<t:${nowSeconds + 5}:R>`,
          }),
        ),
      },
    ]);
    expect(leaderboard.execute).toHaveBeenCalledTimes(2);
  });
});

describe('autocomplete', () => {
  const focused = { name: 'bet', value: '1k' };

  it("passes autocomplete to the command's handler", async () => {
    const autocomplete = vi.fn<Autocomplete>((interaction) =>
      interaction.respond([{ name: '🪙 1,000', value: '1k' }]),
    );
    const spin = testCommand('spin', { autocomplete });
    const context = fakeContext();
    const { interaction, calls } = fakeAutocomplete('spin', {
      focused,
      commands: commandsOf(spin),
    });

    await interactionCreate.execute(context, interaction);

    expect(autocomplete).toHaveBeenCalledExactlyOnceWith(interaction, context);
    expect(calls).toEqual([{ method: 'respond', options: [{ name: '🪙 1,000', value: '1k' }] }]);
    expect(context.wallet.touchPlayer.mock.calls).toEqual([]);
  });

  it('answers with no choices and logs it when the handler throws', async () => {
    const spin = testCommand('spin', {
      autocomplete: () => Promise.reject(new Error('balance lookup failed')),
    });
    const { logger, lines } = captureLogs();
    const { interaction, calls } = fakeAutocomplete('spin', {
      focused,
      commands: commandsOf(spin),
    });

    await expect(
      interactionCreate.execute(fakeContext({ logger }), interaction),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([{ method: 'respond', options: [] }]);
    expect(lines).toEqual([
      expect.objectContaining({ level: 50, msg: 'autocomplete failed', command: 'spin' }),
    ]);
  });

  it('does not answer twice when the handler throws after responding', async () => {
    const spin = testCommand('spin', {
      autocomplete: async (interaction) => {
        await interaction.respond([{ name: 'All-in', value: 'all' }]);
        throw new Error('late failure');
      },
    });
    const { logger, lines } = captureLogs();
    const { interaction, calls } = fakeAutocomplete('spin', {
      focused,
      commands: commandsOf(spin),
    });

    await expect(
      interactionCreate.execute(fakeContext({ logger }), interaction),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([{ method: 'respond', options: [{ name: 'All-in', value: 'all' }] }]);
    expect(lines.map((line) => line.msg)).toEqual(['autocomplete failed']);
  });

  it('survives a respond that fails as well', async () => {
    const spin = testCommand('spin', { autocomplete: () => Promise.reject(new Error('boom')) });
    const { logger, lines } = captureLogs();
    const { interaction } = fakeAutocomplete('spin', { focused, commands: commandsOf(spin) });
    Object.assign(interaction, {
      respond: () => Promise.reject(new Error('Unknown interaction')),
    });

    await expect(
      interactionCreate.execute(fakeContext({ logger }), interaction),
    ).resolves.toBeUndefined();

    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      [50, 'autocomplete failed'],
      [40, 'could not answer autocomplete'],
    ]);
  });

  it('answers with no choices when the command has no autocomplete', async () => {
    const { interaction, calls } = fakeAutocomplete('ping', {
      focused,
      commands: commandsOf(testCommand('ping')),
    });

    await interactionCreate.execute(fakeContext(), interaction);

    expect(calls).toEqual([{ method: 'respond', options: [] }]);
  });
});

describe('stale buttons and modals', () => {
  const closed = ephemeral(t('en-US', 'errors.tableClosed'));

  it('removes the buttons of a table that no longer exists and says it closed', async () => {
    const { interaction, calls } = fakeButton('bj:7:hit:3');

    await interactionCreate.execute(fakeContext(), interaction);

    expect(calls).toEqual([
      { method: 'update', options: { components: [] } },
      { method: 'followUp', options: closed },
    ]);
  });

  it('does the same for a modal submitted from a table message', async () => {
    const { interaction, calls } = fakeModalSubmit('bj:7:bet:2', { fields: { amount: '100' } });

    await interactionCreate.execute(fakeContext(), interaction);

    expect(calls).toEqual([
      { method: 'update', options: { components: [] } },
      { method: 'followUp', options: closed },
    ]);
  });

  it('answers a modal that is not attached to a message with an ephemeral notice', async () => {
    const { interaction, calls } = fakeModalSubmit('rl:4:bets:1');
    Object.assign(interaction, { isFromMessage: () => false });

    await interactionCreate.execute(fakeContext(), interaction);

    expect(calls).toEqual([{ method: 'reply', options: closed }]);
  });
});
