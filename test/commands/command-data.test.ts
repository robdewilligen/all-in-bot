import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
} from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { Command } from '../../src/bot/types.js';
import balance from '../../src/commands/economy/balance.js';
import dailygift from '../../src/commands/economy/dailygift.js';
import leaderboard from '../../src/commands/economy/leaderboard.js';
import help from '../../src/commands/general/help.js';

const commands: Readonly<Record<string, Command>> = { dailygift, balance, leaderboard, help };

describe.each(Object.entries(commands))('/%s data', (name, command) => {
  const json = command.data.toJSON();
  const options = json.options ?? [];

  it('is a slash command named after its file: lowercase, at most 32 characters', () => {
    expect(json.type).toBe(ApplicationCommandType.ChatInput);
    expect(command.data.name).toBe(name);
    expect(json.name).toBe(name);
    expect(json.name).toMatch(/^[a-z0-9_-]{1,32}$/);
  });

  it('has option names that are lowercase and at most 32 characters', () => {
    for (const option of options) expect(option.name).toMatch(/^[a-z0-9_-]{1,32}$/);
  });

  it('has descriptions and choice names of 1 to 100 characters', () => {
    const texts = [
      json.description,
      ...options.flatMap((option) => [
        option.description,
        ...('choices' in option ? (option.choices ?? []).map((choice) => choice.name) : []),
      ]),
    ];
    for (const text of texts) expect(text).toMatch(/^.{1,100}$/su);
  });

  it('only works in servers, installed to the server', () => {
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
    expect(json.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
  });
});

describe('command options (SPEC §3)', () => {
  it('/dailygift has none', () => {
    expect(dailygift.data.toJSON().options).toEqual([]);
  });

  it('/balance has an optional user option "player"', () => {
    expect(balance.data.toJSON().options).toEqual([
      expect.objectContaining({
        type: ApplicationCommandOptionType.User,
        name: 'player',
        required: false,
      }),
    ]);
  });

  it('/leaderboard has an optional integer option "page" of at least 1', () => {
    expect(leaderboard.data.toJSON().options).toEqual([
      expect.objectContaining({
        type: ApplicationCommandOptionType.Integer,
        name: 'page',
        required: false,
        min_value: 1,
      }),
    ]);
  });

  it('/help has an optional string choice "topic" that offers only economy for now', () => {
    expect(help.data.toJSON().options).toEqual([
      expect.objectContaining({
        type: ApplicationCommandOptionType.String,
        name: 'topic',
        required: false,
        choices: [{ name: 'Economy', value: 'economy' }],
      }),
    ]);
  });
});

describe('cooldowns (SPEC §4)', () => {
  it('gives /leaderboard 5 seconds and leaves the others on the default', () => {
    expect(leaderboard.cooldown).toBe(5);
    expect([dailygift, balance, help].map((command) => 'cooldown' in command)).toEqual([
      false,
      false,
      false,
    ]);
  });
});
