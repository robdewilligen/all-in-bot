import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ClientEvents,
  Collection,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Logger } from '../core/logger.js';
import type { Wallet } from '../core/wallet.js';

export interface CooldownKey {
  readonly guildId: string;
  readonly userId: string;
  readonly command: string;
}

export interface CooldownTracker {
  /** Starts the cooldown and returns null, or returns when the running one ends (epoch ms). */
  hit(key: CooldownKey, seconds: number, nowMs: number): number | null;
}

/** Services created once in index.ts and passed to every command and event. */
export interface AppContext {
  readonly wallet: Wallet;
  readonly logger: Logger;
  /** The current time; tests pass a fixed clock. */
  readonly clock: () => Temporal.Instant;
  readonly cooldowns: CooldownTracker;
}

export interface CommandData {
  readonly name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
}

/** The default export of every file in src/commands/<group>/. */
export interface Command {
  readonly data: CommandData;
  /** Seconds; without it the default cooldown applies. */
  readonly cooldown?: number;
  execute(interaction: ChatInputCommandInteraction<'cached'>, context: AppContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction<'cached'>, context: AppContext): Promise<void>;
}

/** The default export of every file in src/events/. */
export interface BotEvent<K extends keyof ClientEvents = keyof ClientEvents> {
  readonly name: K;
  readonly once?: boolean;
  execute(context: AppContext, ...args: ClientEvents[K]): Promise<void> | void;
}

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
  }
}
