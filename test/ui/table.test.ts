import { ButtonStyle, ComponentType, type APIButtonComponentWithCustomId } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { gameConfig } from '../../src/config/game.js';
import { colors } from '../../src/ui/colors.js';
import {
  betForm,
  FORM_FIELDS,
  lobbyMessage,
  tableCreatedReply,
  threadName,
  type LobbyAction,
  type LobbyMessage,
  type LobbyView,
} from '../../src/ui/table.js';

const CLOSES_AT = Temporal.Instant.from('2026-11-09T12:10:00Z');
const ALICE = '200000000000000001';
const BOB = '200000000000000002';

function open(players: readonly string[] = [ALICE, BOB]): LobbyView {
  return {
    state: 'open',
    number: 12,
    players,
    closesAt: CLOSES_AT,
    customId: (action: LobbyAction) => `tb:t-1:${action}:3`,
  };
}

function embedOf(message: LobbyMessage): ReturnType<LobbyMessage['embeds'][number]['toJSON']> {
  const [embed] = message.embeds;
  if (embed === undefined) throw new Error('the lobby has no embed');
  return embed.toJSON();
}

function buttonsOf(message: LobbyMessage): APIButtonComponentWithCustomId[] {
  return message.components.flatMap((row) =>
    row.toJSON().components.flatMap((component) => ('custom_id' in component ? [component] : [])),
  );
}

describe('threadName (SPEC §4)', () => {
  it('names a table by its number, with the game it plays', () => {
    expect(threadName('en-US', 12, null)).toBe('Table #12');
    expect(threadName('en-US', 12, 'roulette')).toBe('Table #12 (Roulette)');
    expect(threadName('en-US', 1_234, 'blackjack')).toBe('Table #1234 (Blackjack)');
  });
});

describe('the lobby message', () => {
  it('asks to pick a game, says when the table closes and lists the players', () => {
    const message = lobbyMessage('en-US', open());
    const embed = embedOf(message);

    expect(embed.title).toBe('Table #12 · pick a game');
    expect(embed.description).toBe(
      'Pick the next game with a button below, or leave the table. Without a new game, this table closes <t:1794226200:R>.',
    );
    expect(embed.fields).toEqual([{ name: 'Players', value: `<@${ALICE}>, <@${BOB}>` }]);
    expect(embed.color).toBe(colors.info);
  });

  it('has the Roulette, Blackjack and Leave table buttons, with their custom IDs', () => {
    const buttons = buttonsOf(lobbyMessage('en-US', open()));

    expect(buttons.map((button) => [button.label, button.custom_id, button.style])).toEqual([
      ['🎡 Roulette', 'tb:t-1:roulette:3', ButtonStyle.Primary],
      ['🃏 Blackjack', 'tb:t-1:blackjack:3', ButtonStyle.Primary],
      ['👋 Leave table', 'tb:t-1:leave:3', ButtonStyle.Secondary],
    ]);
  });

  it('counts the players that do not fit in the field', () => {
    const many = Array.from({ length: 60 }, (_, index) => `2${String(index).padStart(17, '0')}`);
    const [field] = embedOf(lobbyMessage('en-US', open(many))).fields ?? [];
    const value = field?.value ?? '';

    expect(value.length).toBeLessThanOrEqual(1024);
    const shown = value.match(/<@\d+>/g)?.length ?? 0;
    expect(shown).toBeGreaterThan(40);
    expect(value).toMatch(new RegExp(`, and ${String(60 - shown)} more$`));
  });

  it('shows which game the table plays, without buttons', () => {
    const message = lobbyMessage('en-US', { state: 'playing', number: 12, game: 'blackjack' });
    const embed = embedOf(message);

    expect(embed.title).toBe('Table #12 · playing Blackjack');
    expect(embed.description).toBe(
      'The game is below this message. When it ends, a new lobby lets you pick the next game.',
    );
    expect(message.components).toEqual([]);
  });

  it.each([
    ['empty', 'Everyone has left, so this table has closed.'],
    [
      'idle',
      `No game started for ${String(gameConfig.tables.lobbyMinutes)} minutes, so this table has closed.`,
    ],
    ['restart', 'This table closed because the bot is restarting.'],
    ['lost', "This table can't be played any more, so it has closed."],
  ] as const)('says why it closed (%s), in grey and without buttons', (reason, text) => {
    const message = lobbyMessage('en-US', { state: 'closed', number: 12, reason });
    const embed = embedOf(message);

    expect(embed.title).toBe('Table #12 · closed');
    expect(embed.description?.startsWith(`${text} `)).toBe(true);
    expect(embed.color).toBe(colors.breakEven);
    expect(message.components).toEqual([]);
  });
});

describe('the bet forms', () => {
  function inputOf(game: 'roulette' | 'blackjack'): Record<string, unknown> {
    const modal = betForm('en-US', game, `tb:t-1:form-${game}:1`).toJSON();
    expect(modal.custom_id).toBe(`tb:t-1:form-${game}:1`);
    expect(modal.components).toHaveLength(1);
    const [label] = modal.components as unknown as {
      type: number;
      label: string;
      component: Record<string, unknown>;
    }[];
    if (label === undefined) throw new Error('the form has no field');
    expect(label.type).toBe(ComponentType.Label);
    return { title: modal.title, label: label.label, ...label.component };
  }

  it('asks for roulette bets in one field of up to 500 characters', () => {
    expect(inputOf('roulette')).toMatchObject({
      title: '🎡 Roulette',
      label: 'Your bets, as amount:spot',
      custom_id: FORM_FIELDS.roulette,
      required: true,
      max_length: 500,
      placeholder: '10:17, 10:red, 5:d1',
    });
  });

  it('asks for one blackjack amount', () => {
    expect(inputOf('blackjack')).toMatchObject({
      title: '🃏 Blackjack',
      label: 'Your bet',
      custom_id: FORM_FIELDS.blackjack,
      required: true,
      max_length: 32,
      placeholder: '250, 2,500, 1.5k, all, max or half',
    });
  });
});

describe('tableCreatedReply', () => {
  it('links to the new thread', () => {
    expect(tableCreatedReply('en-US', 7, 'https://discord.com/channels/1/2')).toBe(
      'Your table is open: [Table #7](https://discord.com/channels/1/2). Pick a game there.',
    );
  });
});
