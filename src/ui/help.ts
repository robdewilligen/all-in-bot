import { EmbedBuilder, MessageFlags, type InteractionReplyOptions } from 'discord.js';
import { gameConfig } from '../config/game.js';
import { formatCoins } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { blackjackHelpEmbed } from './blackjack.js';
import { colors } from './colors.js';
import { rouletteHelpEmbed } from './roulette.js';
import { slotsHelpEmbed } from './slots.js';

/** The commands the overview lists, each with the key of its description. */
const commands = [
  ['first-gift', 'commands.firstgift.description'],
  ['dailygift', 'commands.dailygift.description'],
  ['balance', 'commands.balance.description'],
  ['leaderboard', 'commands.leaderboard.description'],
  ['roulette', 'roulette.command.description'],
  ['blackjack', 'blackjack.command.description'],
  ['spin', 'slots.command.description'],
  ['create-table', 'tables.command.description'],
  ['help', 'commands.help.description'],
] as const;

/** The topics of /help (SPEC §9), in the order its choices list them. */
export const helpTopics = ['economy', 'roulette', 'blackjack', 'slots'] as const;

export type HelpTopic = (typeof helpTopics)[number];

const topicEmbeds: Readonly<Record<HelpTopic, (locale: string) => EmbedBuilder>> = {
  economy: economyEmbed,
  roulette: rouletteHelpEmbed,
  blackjack: blackjackHelpEmbed,
  slots: slotsHelpEmbed,
};

function isHelpTopic(topic: string): topic is HelpTopic {
  return (helpTopics as readonly string[]).includes(topic);
}

/** The overview, or the topic's page; an unknown topic gets the overview. */
export function helpReply(locale: string, topic: string | null): InteractionReplyOptions {
  const build = topic !== null && isHelpTopic(topic) ? topicEmbeds[topic] : overviewEmbed;
  return { embeds: [build(locale)], flags: MessageFlags.Ephemeral };
}

function overviewEmbed(locale: string): EmbedBuilder {
  const lines = commands.map(([command, description]) =>
    t(locale, 'help.overview.command', { command, description: t(locale, description) }),
  );
  const topics = helpTopics.map((topic) => t(locale, `help.overview.${topic}`));
  return new EmbedBuilder()
    .setColor(colors.info)
    .setTitle(t(locale, 'help.overview.title'))
    .setDescription(t(locale, 'help.overview.description'))
    .addFields(
      { name: t(locale, 'help.overview.commands'), value: lines.join('\n') },
      { name: t(locale, 'help.overview.topics'), value: topics.join('\n') },
    );
}

function economyEmbed(locale: string): EmbedBuilder {
  const { daily, stakes } = gameConfig;
  const fullStreakDay = Math.ceil(daily.maxStreakBonus / daily.streakBonus) + 1;
  return new EmbedBuilder()
    .setColor(colors.info)
    .setTitle(t(locale, 'help.economy.title'))
    .setDescription(t(locale, 'help.economy.description'))
    .addFields(
      {
        name: t(locale, 'help.economy.firstGift'),
        value: t(locale, 'help.economy.firstGiftText', {
          amount: formatCoins(gameConfig.firstGift.amount),
        }),
      },
      {
        name: t(locale, 'help.economy.dailyGift'),
        value: t(locale, 'help.economy.dailyGiftText', { base: formatCoins(daily.base) }),
      },
      {
        name: t(locale, 'help.economy.streaks'),
        value: t(locale, 'help.economy.streaksText', {
          bonus: formatCoins(daily.streakBonus),
          maxBonus: formatCoins(daily.maxStreakBonus),
          fullDay: fullStreakDay,
          maxDaily: formatCoins(daily.base + daily.maxStreakBonus),
        }),
      },
      {
        name: t(locale, 'help.economy.limits'),
        value: t(locale, 'help.economy.limitsText', {
          min: formatCoins(stakes.min),
          max: formatCoins(stakes.max),
        }),
      },
      { name: t(locale, 'help.economy.amounts'), value: t(locale, 'help.economy.amountsText') },
    );
}
