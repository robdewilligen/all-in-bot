import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  userMention,
} from 'discord.js';
import { gameConfig } from '../config/game.js';
import type { TableGame } from '../core/wallet.js';
import { discordTimestamp, formatCount } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { colors } from './colors.js';

/** The lobby buttons, the third part of `tb:<hostId>:<action>:<step>`. */
export const LOBBY_ACTIONS = [
  'roulette',
  'blackjack',
  'leave',
] as const satisfies readonly string[];

export type LobbyAction = (typeof LOBBY_ACTIONS)[number];

export function isLobbyAction(value: string): value is LobbyAction {
  return (LOBBY_ACTIONS as readonly string[]).includes(value);
}

/** The text field of each bet form: the bets as /roulette takes them, or one blackjack amount. */
export const FORM_FIELDS = {
  roulette: 'bets',
  blackjack: 'bet',
} as const satisfies Readonly<Record<TableGame, string>>;

/** The same limit as the /roulette bets option (SPEC §3). */
export const ROULETTE_FORM_MAX_LENGTH = 500;
const BLACKJACK_FORM_MAX_LENGTH = 32;

/** `lost`: the thread or the game's message is gone, or the bot can no longer use it. */
export type LobbyClosedReason = 'empty' | 'idle' | 'restart' | 'lost';

/** What a table's lobby message shows, as plain data. */
export type LobbyView =
  | {
      readonly state: 'open';
      readonly number: number;
      /** User IDs, in the order they joined. */
      readonly players: readonly string[];
      /** When the table closes unless a game starts. */
      readonly closesAt: Temporal.Instant;
      readonly customId: (action: LobbyAction) => string;
    }
  | { readonly state: 'playing'; readonly number: number; readonly game: TableGame }
  | { readonly state: 'closed'; readonly number: number; readonly reason: LobbyClosedReason };

export interface LobbyMessage {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

const FIELD_VALUE_LIMIT = 1024;

/** "Table #12", or "Table #12 (Roulette)" for a table that plays a game (SPEC §4). */
export function threadName(locale: string, number: number, game: TableGame | null): string {
  // A plain number, as Rob asked: "Table #1234", not "Table #1,234".
  const table = String(number);
  if (game === null) return t(locale, 'tables.thread.name', { number: table });
  return t(locale, 'tables.thread.withGame', {
    number: table,
    game: t(locale, `tables.games.${game}`),
  });
}

/** Mentions render as names and ping nobody; past the field limit the rest is a count. */
function playerList(locale: string, players: readonly string[]): string {
  const mentions = players.map((id) => userMention(id));
  for (let shown = mentions.length; shown > 0; shown -= 1) {
    const parts: string[] = mentions.slice(0, shown);
    const rest = mentions.length - shown;
    if (rest > 0) parts.push(t(locale, 'tables.lobby.morePlayers', { count: formatCount(rest) }));
    const text = parts.join(', ');
    if (text.length <= FIELD_VALUE_LIMIT) return text;
  }
  return t(locale, 'tables.lobby.morePlayers', { count: formatCount(mentions.length) });
}

function closedText(locale: string, reason: LobbyClosedReason): string {
  switch (reason) {
    case 'empty':
      return t(locale, 'tables.lobby.closedEmpty');
    case 'idle':
      return t(locale, 'tables.lobby.closedIdle', {
        minutes: formatCount(gameConfig.tables.lobbyMinutes),
      });
    case 'restart':
      return t(locale, 'tables.lobby.closedRestart');
    case 'lost':
      return t(locale, 'tables.lobby.closedLost');
  }
}

function lobbyButtons(
  locale: string,
  customId: (action: LobbyAction) => string,
): ActionRowBuilder<ButtonBuilder> {
  const button = (action: LobbyAction, label: string, style: ButtonStyle): ButtonBuilder =>
    new ButtonBuilder().setCustomId(customId(action)).setLabel(label).setStyle(style);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('roulette', t(locale, 'tables.buttons.roulette'), ButtonStyle.Primary),
    button('blackjack', t(locale, 'tables.buttons.blackjack'), ButtonStyle.Primary),
    button('leave', t(locale, 'tables.buttons.leave'), ButtonStyle.Secondary),
  );
}

/** The lobby between games; while a game runs and once closed it has no buttons. */
export function lobbyMessage(locale: string, view: LobbyView): LobbyMessage {
  const number = String(view.number);
  const embed = new EmbedBuilder();
  switch (view.state) {
    case 'open': {
      embed
        .setColor(colors.info)
        .setTitle(t(locale, 'tables.lobby.title', { number }))
        .setDescription(t(locale, 'tables.lobby.pick', { time: discordTimestamp(view.closesAt) }));
      if (view.players.length > 0) {
        embed.addFields({
          name: t(locale, 'tables.lobby.players'),
          value: playerList(locale, view.players),
        });
      }
      return { embeds: [embed], components: [lobbyButtons(locale, view.customId)] };
    }
    case 'playing':
      embed
        .setColor(colors.inProgress)
        .setTitle(
          t(locale, 'tables.lobby.playingTitle', {
            number,
            game: t(locale, `tables.games.${view.game}`),
          }),
        )
        .setDescription(t(locale, 'tables.lobby.playing'));
      return { embeds: [embed], components: [] };
    case 'closed':
      embed
        .setColor(colors.breakEven)
        .setTitle(t(locale, 'tables.lobby.closedTitle', { number }))
        .setDescription(closedText(locale, view.reason));
      return { embeds: [embed], components: [] };
  }
}

/** The bet form a lobby's game button opens: one text field, as the game's command takes it. */
export function betForm(locale: string, game: TableGame, customId: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(FORM_FIELDS[game])
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(game === 'roulette' ? ROULETTE_FORM_MAX_LENGTH : BLACKJACK_FORM_MAX_LENGTH)
    .setPlaceholder(t(locale, `tables.forms.${game}.placeholder`));
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(t(locale, `tables.forms.${game}.title`))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(t(locale, `tables.forms.${game}.label`))
        .setTextInputComponent(input),
    );
}

/** The ephemeral answer to /create-table, with a link to the new thread. */
export function tableCreatedReply(locale: string, number: number, url: string): string {
  return t(locale, 'tables.created', { number: String(number), url });
}
