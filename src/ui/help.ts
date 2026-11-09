import { EmbedBuilder, MessageFlags, type InteractionReplyOptions } from 'discord.js';
import { gameConfig } from '../config/game.js';
import { formatCoins } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { colors } from './colors.js';

const commands = ['dailygift', 'balance', 'leaderboard', 'help'] as const;

/** The overview, or the topic's page; an unknown topic gets the overview. */
export function helpReply(locale: string, topic: string | null): InteractionReplyOptions {
  const embed = topic === 'economy' ? economyEmbed(locale) : overviewEmbed(locale);
  return { embeds: [embed], flags: MessageFlags.Ephemeral };
}

function overviewEmbed(locale: string): EmbedBuilder {
  const lines = commands.map((command) =>
    t(locale, 'help.overview.command', {
      command,
      description: t(locale, `commands.${command}.description` as const),
    }),
  );
  return new EmbedBuilder()
    .setColor(colors.info)
    .setTitle(t(locale, 'help.overview.title'))
    .setDescription(t(locale, 'help.overview.description'))
    .addFields(
      { name: t(locale, 'help.overview.commands'), value: lines.join('\n') },
      { name: t(locale, 'help.overview.topics'), value: t(locale, 'help.overview.economy') },
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
