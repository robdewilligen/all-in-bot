import {
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  Collection,
  Colors,
  InteractionContextType,
  MessageFlags,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { respondWithBetChoices } from '../../src/bot/bet-autocomplete.js';
import type { Command } from '../../src/bot/types.js';
import spin from '../../src/commands/games/spin.js';
import { gameConfig } from '../../src/config/game.js';
import { parseAmount, stakeLimitError } from '../../src/core/amount.js';
import { PlayerError } from '../../src/core/errors.js';
import type { InstantResult } from '../../src/core/wallet.js';
import interactionCreate from '../../src/events/interaction-create.js';
import {
  createSlotMachine,
  type Row,
  type SlotSpin,
  type Stops,
} from '../../src/games/slots/index.js';
import { formatCoins } from '../../src/i18n/format.js';
import { translate } from '../../src/i18n/index.js';
import { slotsResultEmbed, slotsSpinningEmbed } from '../../src/ui/slots.js';
import { captureLogs, fakeContext, type FakeContext } from '../helpers/context.js';
import {
  GUILD_ID,
  USER_ID,
  embedsOf,
  fakeChatInput,
  isEphemeral,
  textOf,
} from '../helpers/discord.js';

// The stops crypto.randomInt hands out, in order; it falls back to real draws when they run out.
const { draws } = vi.hoisted(() => ({ draws: [] as number[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomInt: (max: number) => draws.shift() ?? crypto.randomInt(max) };
});

const machine = createSlotMachine(gameConfig.slots);
const DELAY = gameConfig.slots.revealDelayMs;
const BALANCE = 10_000;
const ROUND_ID = 42;

function stopsShowing([a, b, c]: Row): Stops {
  const [left, middle, right] = machine.reels;
  return [left.indexOf(a), middle.indexOf(b), right.indexOf(c)];
}

/** The wallet settles for real: debit, then the command's own play(), then the payout. */
function settleInWallet(context: FakeContext): void {
  context.wallet.balanceOf.mockResolvedValue(BALANCE);
  context.wallet.playInstant.mockImplementation((_player, _game, stake, play) => {
    const { payout, details } = play();
    return Promise.resolve({
      roundId: ROUND_ID,
      stake,
      payout,
      balance: BALANCE - stake + payout,
      details,
    });
  });
}

function methods(calls: readonly { method: string }[]): string[] {
  return calls.map((call) => call.method);
}

beforeEach(() => {
  vi.useFakeTimers();
  draws.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/spin data (SPEC §3)', () => {
  const json = spin.data.toJSON();

  it('is a server-only slash command with a required bet option that autocompletes', () => {
    expect(json.name).toBe('spin');
    expect(json.description).toMatch(/^.{1,100}$/su);
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
    expect(json.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
    expect(json.options).toEqual([
      expect.objectContaining({
        type: ApplicationCommandOptionType.String,
        name: 'bet',
        required: true,
        autocomplete: true,
        description: expect.stringMatching(/^.{1,100}$/su) as unknown,
      }),
    ]);
  });

  it('answers autocomplete with the shared bet choices', () => {
    expect(spin.autocomplete).toBe(respondWithBetChoices);
  });

  it('keeps the default cooldown', () => {
    expect('cooldown' in spin).toBe(false);
  });
});

describe('/spin settles first (SPEC §4)', () => {
  it('stakes the parsed bet against the live balance, for the caller, as a slots round', async () => {
    const context = fakeContext();
    settleInWallet(context);
    const { interaction } = fakeChatInput('spin', {
      strings: { bet: 'half' },
      displayName: 'Alice',
    });

    const done = spin.execute(interaction, context);
    await vi.runAllTimersAsync();
    await done;

    const player = { guildId: GUILD_ID, userId: USER_ID, displayName: 'Alice' };
    expect(context.wallet.balanceOf.mock.calls).toEqual([[player]]);
    expect(context.wallet.playInstant.mock.calls).toEqual([
      [player, 'slots', BALANCE / 2, expect.any(Function)],
    ]);
  });

  it('shows nothing until the round is settled', async () => {
    const context = fakeContext();
    context.wallet.balanceOf.mockResolvedValue(BALANCE);
    const pending: { settle?: (fields: Omit<InstantResult<SlotSpin>, 'details'>) => void } = {};
    context.wallet.playInstant.mockImplementation(
      (_player, _game, _stake, play) =>
        new Promise((resolve) => {
          const { details } = play();
          pending.settle = (fields) => {
            resolve({ ...fields, details });
          };
        }),
    );
    const { interaction, calls } = fakeChatInput('spin', { strings: { bet: '100' } });

    const done = spin.execute(interaction, context);
    await vi.advanceTimersByTimeAsync(5 * DELAY);
    expect(context.wallet.playInstant.mock.calls).toHaveLength(1);
    expect(calls).toEqual([]);

    const { settle } = pending;
    if (settle === undefined) throw new Error('play() did not run inside playInstant');
    settle({ roundId: ROUND_ID, stake: 100, payout: 0, balance: BALANCE });
    await vi.advanceTimersByTimeAsync(0);
    expect(methods(calls)).toEqual(['reply']);
    await vi.runAllTimersAsync();
    await done;
  });

  it('pays the stake times the multiplier of the spin it settles', async () => {
    const context = fakeContext();
    settleInWallet(context);
    draws.push(...stopsShowing(['bell', 'bell', 'bell']));
    const { interaction } = fakeChatInput('spin', { strings: { bet: '1.5k' } });

    const done = spin.execute(interaction, context);
    await vi.runAllTimersAsync();
    await done;

    const settled = (await context.wallet.playInstant.mock.results[0]?.value) as unknown;
    expect(settled).toMatchObject({
      stake: 1_500,
      payout: 37_500,
      details: { line: ['bell', 'bell', 'bell'], multiplier: 25 },
    });
  });
});

describe('/spin reveal (SPEC §8)', () => {
  const bells = stopsShowing(['bell', 'bell', 'bell']);
  const [b0, b1, b2] = bells;

  async function playBells(): Promise<{
    calls: ReturnType<typeof fakeChatInput>['calls'];
    done: Promise<void>;
    result: InstantResult<SlotSpin>;
  }> {
    const context = fakeContext();
    settleInWallet(context);
    // The spin itself, then the random stops of the spinning reels: 3, 2 and 1 per frame.
    draws.push(...bells, 5, 6, 7, 8, 9, 10);
    const { interaction, calls } = fakeChatInput('spin', { strings: { bet: '100' } });
    const done = spin.execute(interaction, context);
    await vi.advanceTimersByTimeAsync(0);
    const result = (await context.wallet.playInstant.mock.results[0]?.value) as
      InstantResult<SlotSpin> | undefined;
    if (result === undefined) throw new Error('playInstant was not called');
    return { calls, done, result };
  }

  it('replies with every reel spinning, then stops one reel per edit, about 700 ms apart', async () => {
    const { calls, done } = await playBells();

    expect(methods(calls)).toEqual(['reply']);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(methods(calls)).toEqual(['reply']);
    await vi.advanceTimersByTimeAsync(1);
    expect(methods(calls)).toEqual(['reply', 'editReply']);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(methods(calls)).toEqual(['reply', 'editReply', 'editReply']);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(methods(calls)).toEqual(['reply', 'editReply', 'editReply', 'editReply']);
    await done;

    const frames = calls.map((call) => embedsOf(call.options));
    expect(frames.slice(0, 3)).toEqual([
      [slotsSpinningEmbed('en-US', machine.window([5, 6, 7]), 100).toJSON()],
      [slotsSpinningEmbed('en-US', machine.window([b0, 8, 9]), 100).toJSON()],
      [slotsSpinningEmbed('en-US', machine.window([b0, b1, 10]), 100).toJSON()],
    ]);
    expect(calls.map((call) => isEphemeral(call.options))).toEqual([false, false, false, false]);
  });

  it('ends on the result: combination, bet, winnings, new balance and net result, in green', async () => {
    const { calls, done, result } = await playBells();
    await vi.runAllTimersAsync();
    await done;

    const last = calls.at(-1)?.options;
    expect(embedsOf(last)).toEqual([
      slotsResultEmbed('en-US', machine.window([b0, b1, b2]), result).toJSON(),
    ]);
    expect(embedsOf(last).map((embed) => embed.color)).toEqual([Colors.Green]);
    const text = textOf(last);
    expect(text).toMatch(/^🔔 🔔 🔔 ⬅️$/m);
    expect(text).toMatch(/^\*\*3× 🔔 pays 25×\*\*$/m);
    expect(text).toMatch(/^Bet\n🪙 100$/m);
    expect(text).toMatch(/^Winnings\n🪙 2,500$/m);
    expect(text).toMatch(/^Balance\n🪙 12,400$/m);
    expect(text).toMatch(/^Net result\n\+🪙 2,400$/m);
  });

  it('ends a losing spin in red', async () => {
    const context = fakeContext();
    settleInWallet(context);
    draws.push(...stopsShowing(['cherry', 'lemon', 'seven']));
    const { interaction, calls } = fakeChatInput('spin', { strings: { bet: '250' } });

    const done = spin.execute(interaction, context);
    await vi.runAllTimersAsync();
    await done;

    const last = calls.at(-1)?.options;
    expect(embedsOf(last).map((embed) => embed.color)).toEqual([Colors.Red]);
    expect(textOf(last)).toMatch(/^Balance\n🪙 9,750$/m);
    expect(textOf(last)).toMatch(/^Net result\n-🪙 250$/m);
  });

  it('logs a failing edit and still shows the result', async () => {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    settleInWallet(context);
    const { interaction, calls } = fakeChatInput('spin', { strings: { bet: '100' } });
    const editReply = interaction.editReply.bind(interaction);
    vi.spyOn(interaction, 'editReply')
      .mockRejectedValueOnce(new Error('Unknown Message'))
      .mockImplementation(editReply);

    const done = spin.execute(interaction, context);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();

    expect(methods(calls)).toEqual(['reply', 'editReply', 'editReply']);
    expect(textOf(calls.at(-1)?.options)).toMatch(/^Net result\n/m);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'could not edit the slots reveal',
        roundId: ROUND_ID,
        userId: USER_ID,
      }),
    ]);
  });

  it('logs a failing first reply instead of answering with an error, and stops there', async () => {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    settleInWallet(context);
    const { interaction, calls } = fakeChatInput('spin', { strings: { bet: '100' } });
    vi.spyOn(interaction, 'reply').mockRejectedValueOnce(new Error('Unknown interaction'));

    const done = spin.execute(interaction, context);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'could not show a settled spin',
        roundId: ROUND_ID,
      }),
    ]);
  });
});

describe('/spin refusals', () => {
  const commands = new Collection<string, Command>([['spin', spin]]);

  async function run(bet: string, context: FakeContext): Promise<unknown[]> {
    const { interaction, calls } = fakeChatInput('spin', { strings: { bet }, commands });
    await interactionCreate.execute(context, interaction);
    await vi.advanceTimersByTimeAsync(5 * DELAY);
    return calls;
  }

  it('shows "not enough coins" from the wallet ephemerally, with no animation', async () => {
    const context = fakeContext();
    context.wallet.balanceOf.mockResolvedValue(BALANCE);
    const error = new PlayerError('errors.insufficientFunds', {
      needed: formatCoins(500),
      balance: formatCoins(120),
    });
    context.wallet.playInstant.mockRejectedValue(error);

    const calls = await run('500', context);

    expect(calls).toEqual([
      {
        method: 'reply',
        options: { content: translate('en-US', error.userMessage), flags: MessageFlags.Ephemeral },
      },
    ]);
  });

  it('refuses a bet that is not an amount before any coins move', async () => {
    const context = fakeContext();
    context.wallet.balanceOf.mockResolvedValue(BALANCE);
    const parsed = parseAmount('lots', { balance: BALANCE, max: gameConfig.stakes.max });
    if (parsed.ok) throw new Error('"lots" should not parse');

    const calls = await run('lots', context);

    expect(context.wallet.playInstant.mock.calls).toEqual([]);
    expect(calls).toEqual([
      {
        method: 'reply',
        options: { content: translate('en-US', parsed.error), flags: MessageFlags.Ephemeral },
      },
    ]);
  });

  it('refuses a bet below the minimum before any coins move', async () => {
    const context = fakeContext();
    context.wallet.balanceOf.mockResolvedValue(BALANCE);
    const limit = stakeLimitError(5, gameConfig.stakes);
    if (limit === null) throw new Error('5 should be below the minimum');

    const calls = await run('5', context);

    expect(context.wallet.playInstant.mock.calls).toEqual([]);
    expect(calls).toEqual([
      {
        method: 'reply',
        options: { content: translate('en-US', limit), flags: MessageFlags.Ephemeral },
      },
    ]);
  });
});
