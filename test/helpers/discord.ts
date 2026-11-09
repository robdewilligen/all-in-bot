import {
  ApplicationCommandOptionType,
  Collection,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  MessageFlagsBitField,
  PermissionFlagsBits,
  PermissionsBitField,
  type APIEmbed,
  type AutocompleteInteraction,
  type BitFieldResolvable,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageFlagsString,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Command } from '../../src/bot/types.js';

export const GUILD_ID = '100000000000000001';
export const USER_ID = '200000000000000001';
export const CHANNEL_ID = '300000000000000001';
export const MESSAGE_ID = '500000000000000001';
export const BOT_ID = '900000000000000001';

/** What a table needs in its channel (SPEC §4); fakes have these unless a test says otherwise. */
export const TABLE_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks;

export type ResponseMethod =
  | 'reply'
  | 'deferReply'
  | 'editReply'
  | 'followUp'
  | 'deleteReply'
  | 'update'
  | 'deferUpdate'
  | 'showModal'
  | 'respond';

export interface ResponseCall {
  readonly method: ResponseMethod;
  readonly options: unknown;
}

/** A fake interaction plus every response call made on it, in order. */
export interface Fake<T> {
  readonly interaction: T;
  readonly calls: ResponseCall[];
}

export interface FakeUser {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly bot: boolean;
}

export interface FakeOptions {
  readonly guildId?: string;
  readonly channelId?: string;
  readonly user?: FakeUser;
  /** The member's display name; defaults to the user's global name or username. */
  readonly displayName?: string;
  readonly locale?: string;
  /** The app's permission bits in the channel; defaults to TABLE_PERMISSIONS. */
  readonly appPermissions?: bigint;
  readonly inThread?: boolean;
  readonly commands?: Collection<string, Command>;
}

export interface ChatInputOptions extends FakeOptions {
  readonly users?: Readonly<Record<string, FakeUser>>;
  readonly integers?: Readonly<Record<string, number>>;
  readonly strings?: Readonly<Record<string, string>>;
}

export interface AutocompleteOptions extends ChatInputOptions {
  readonly focused: { readonly name: string; readonly value: string };
}

export interface ModalOptions extends FakeOptions {
  readonly fields?: Readonly<Record<string, string>>;
}

export function fakeUser(
  id: string,
  username = 'alice',
  globalName: string | null = null,
): FakeUser {
  return { id, username, globalName, bot: false };
}

type Kind = 'chatInput' | 'autocomplete' | 'button' | 'modal';

// Like discord.js, response methods reject instead of throwing.
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work());
  });
}

function optionsObject(payload: unknown): Readonly<Record<string, unknown>> {
  if (typeof payload === 'string') return { content: payload };
  if (typeof payload === 'object' && payload !== null) return payload as Record<string, unknown>;
  return {};
}

function fakeMessage(guildId: string, channelId: string): { id: string; url: string } {
  return {
    id: MESSAGE_ID,
    url: `https://discord.com/channels/${guildId}/${channelId}/${MESSAGE_ID}`,
  };
}

function getter<T>(
  values: Readonly<Record<string, T>> | undefined,
): (name: string, required?: boolean) => T | null {
  return (name, required = false) => {
    const value = values?.[name];
    if (value !== undefined) return value;
    if (required) throw new TypeError(`Option "${name}" not found.`);
    return null;
  };
}

function base(kind: Kind, options: FakeOptions, calls: ResponseCall[]): object {
  const guildId = options.guildId ?? GUILD_ID;
  const channelId = options.channelId ?? CHANNEL_ID;
  const user = options.user ?? fakeUser(USER_ID);
  const message = fakeMessage(guildId, channelId);
  const state = { replied: false, deferred: false, ephemeral: null as boolean | null };

  const first = (
    method: ResponseMethod,
    payload: unknown,
    becomes: 'replied' | 'deferred',
  ): void => {
    if (state.replied || state.deferred) {
      throw new Error(
        `${method}: the reply to this interaction has already been sent or deferred.`,
      );
    }
    state[becomes] = true;
    state.ephemeral = isEphemeral(payload);
    calls.push({ method, options: payload });
  };
  const later = (method: ResponseMethod, payload: unknown): void => {
    if (!state.replied && !state.deferred) {
      throw new Error(`${method}: the reply to this interaction has not been sent or deferred.`);
    }
    calls.push({ method, options: payload });
  };
  const response = (payload: unknown): unknown =>
    optionsObject(payload).withResponse === true ? { resource: { message } } : undefined;

  return {
    id: '400000000000000001',
    applicationId: BOT_ID,
    guildId,
    channelId,
    locale: options.locale ?? 'en-US',
    guildLocale: 'en-US',
    user,
    member: {
      id: user.id,
      user,
      displayName: options.displayName ?? user.globalName ?? user.username,
    },
    guild: { id: guildId, name: 'Test Server' },
    channel: { id: channelId, isThread: () => options.inThread ?? false },
    client: {
      commands: options.commands ?? new Collection<string, Command>(),
      user: { id: BOT_ID },
    },
    appPermissions: new PermissionsBitField(options.appPermissions ?? TABLE_PERMISSIONS),
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    get ephemeral() {
      return state.ephemeral;
    },
    inGuild: () => true,
    inCachedGuild: () => true,
    inRawGuild: () => false,
    isRepliable: () => kind !== 'autocomplete',
    isCommand: () => kind === 'chatInput',
    isChatInputCommand: () => kind === 'chatInput',
    isContextMenuCommand: () => false,
    isPrimaryEntryPointCommand: () => false,
    isAutocomplete: () => kind === 'autocomplete',
    isMessageComponent: () => kind === 'button',
    isButton: () => kind === 'button',
    isAnySelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => kind === 'modal',
    reply: (payload: unknown) =>
      settle(() => {
        first('reply', payload, 'replied');
        return response(payload);
      }),
    deferReply: (payload?: unknown) =>
      settle(() => {
        first('deferReply', payload, 'deferred');
        return response(payload);
      }),
    editReply: (payload: unknown) =>
      settle(() => {
        later('editReply', payload);
        state.replied = true;
        return message;
      }),
    followUp: (payload: unknown) =>
      settle(() => {
        later('followUp', payload);
        return message;
      }),
    deleteReply: () =>
      settle(() => {
        later('deleteReply', undefined);
      }),
    update: (payload: unknown) =>
      settle(() => {
        first('update', payload, 'replied');
        return response(payload);
      }),
    deferUpdate: (payload?: unknown) =>
      settle(() => {
        first('deferUpdate', payload, 'deferred');
        return response(payload);
      }),
    showModal: (modal: unknown) =>
      settle(() => {
        first('showModal', modal, 'replied');
      }),
  };
}

export function fakeChatInput(
  commandName: string,
  options: ChatInputOptions = {},
): Fake<ChatInputCommandInteraction<'cached'>> {
  const calls: ResponseCall[] = [];
  const interaction = Object.assign(base('chatInput', options, calls), {
    commandName,
    commandId: '600000000000000001',
    options: {
      getUser: getter(options.users),
      getInteger: getter(options.integers),
      getString: getter(options.strings),
    },
  });
  return { interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>, calls };
}

export function fakeAutocomplete(
  commandName: string,
  options: AutocompleteOptions,
): Fake<AutocompleteInteraction<'cached'>> {
  const calls: ResponseCall[] = [];
  const { focused } = options;
  let responded = false;
  const interaction = Object.assign(base('autocomplete', options, calls), {
    commandName,
    commandId: '600000000000000001',
    options: {
      getFocused: (full = false) =>
        full
          ? { ...focused, type: ApplicationCommandOptionType.String, focused: true }
          : focused.value,
      getUser: getter(options.users),
      getInteger: getter(options.integers),
      getString: getter({ ...options.strings, [focused.name]: focused.value }),
    },
    respond: (choices: unknown) =>
      settle(() => {
        if (responded) throw new Error('respond: this autocomplete was already answered.');
        responded = true;
        calls.push({ method: 'respond', options: choices });
      }),
  });
  Object.defineProperty(interaction, 'responded', { get: () => responded });
  return { interaction: interaction as unknown as AutocompleteInteraction<'cached'>, calls };
}

export function fakeButton(
  customId: string,
  options: FakeOptions = {},
): Fake<ButtonInteraction<'cached'>> {
  const calls: ResponseCall[] = [];
  const interaction = Object.assign(base('button', options, calls), {
    customId,
    componentType: ComponentType.Button,
    message: fakeMessage(options.guildId ?? GUILD_ID, options.channelId ?? CHANNEL_ID),
  });
  return { interaction: interaction as unknown as ButtonInteraction<'cached'>, calls };
}

export function fakeModalSubmit(
  customId: string,
  options: ModalOptions = {},
): Fake<ModalSubmitInteraction<'cached'>> {
  const calls: ResponseCall[] = [];
  const interaction = Object.assign(base('modal', options, calls), {
    customId,
    fields: {
      getTextInputValue: (name: string): string => {
        const value = options.fields?.[name];
        if (value === undefined) throw new TypeError(`Field "${name}" not found.`);
        return value;
      },
    },
    isFromMessage: () => true,
    message: fakeMessage(options.guildId ?? GUILD_ID, options.channelId ?? CHANNEL_ID),
  });
  return { interaction: interaction as unknown as ModalSubmitInteraction<'cached'>, calls };
}

/** Whether a response's options carry the Ephemeral flag. */
export function isEphemeral(payload: unknown): boolean {
  const flags = optionsObject(payload).flags;
  if (flags === undefined || flags === null) return false;
  return new MessageFlagsBitField(flags as BitFieldResolvable<MessageFlagsString, number>).has(
    MessageFlags.Ephemeral,
  );
}

export function contentOf(payload: unknown): string | undefined {
  const content = optionsObject(payload).content;
  return typeof content === 'string' ? content : undefined;
}

/** The embeds of a response's options, as API JSON. */
export function embedsOf(payload: unknown): APIEmbed[] {
  const embeds = optionsObject(payload).embeds;
  if (!Array.isArray(embeds)) return [];
  return embeds.map((embed: unknown) =>
    embed instanceof EmbedBuilder ? embed.toJSON() : (embed as APIEmbed),
  );
}

/** All visible text of a response (content and embeds), for assertions with a regex. */
export function textOf(payload: unknown): string {
  const parts = [contentOf(payload) ?? ''];
  for (const embed of embedsOf(payload)) {
    parts.push(embed.author?.name ?? '', embed.title ?? '', embed.description ?? '');
    for (const field of embed.fields ?? []) parts.push(field.name, field.value);
    parts.push(embed.footer?.text ?? '');
  }
  return parts.filter((part) => part !== '').join('\n');
}
