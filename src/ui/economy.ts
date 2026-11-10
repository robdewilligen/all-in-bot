import {
  EmbedBuilder,
  MessageFlags,
  escapeMarkdown,
  userMention,
  type InteractionReplyOptions,
} from 'discord.js';
import type { DailyClaim, LeaderboardPage, Standing } from '../core/wallet.js';
import { discordTimestamp, formatCoins, formatCount, formatRank } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { colors } from './colors.js';

export function dailyGiftReply(
  locale: string,
  userId: string,
  claim: DailyClaim,
): InteractionReplyOptions {
  const nextReset = discordTimestamp(claim.nextReset);
  if (claim.status === 'alreadyClaimed') {
    return {
      content: t(locale, 'daily.alreadyClaimed', { time: nextReset }),
      flags: MessageFlags.Ephemeral,
    };
  }
  const embed = new EmbedBuilder()
    .setColor(colors.dailyGift)
    .setTitle(t(locale, 'daily.title'))
    .setDescription(
      t(locale, 'daily.claimed', {
        player: userMention(userId),
        amount: formatCoins(claim.amount),
      }),
    )
    .addFields(
      {
        name: t(locale, 'daily.streak'),
        value: t(locale, 'daily.streakDay', { streak: formatCount(claim.streak) }),
        inline: true,
      },
      { name: t(locale, 'daily.balance'), value: formatCoins(claim.balance), inline: true },
      { name: t(locale, 'daily.nextGift'), value: nextReset, inline: true },
    );
  return { embeds: [embed] };
}

export function balanceReply(
  locale: string,
  userId: string,
  standing: Standing,
): InteractionReplyOptions {
  const player = userMention(userId);
  const balance = formatCoins(standing.balance);
  const description =
    standing.rank === null
      ? t(locale, 'balance.unranked', { player, balance })
      : t(locale, 'balance.ranked', { player, balance, rank: formatRank(standing.rank) });
  const embed = new EmbedBuilder()
    .setColor(colors.info)
    .setTitle(t(locale, 'balance.title'))
    .setDescription(description);
  return { embeds: [embed] };
}

export function leaderboardReply(
  locale: string,
  board: LeaderboardPage,
  callerStanding: Standing,
): InteractionReplyOptions {
  if (board.entries.length === 0) {
    return { content: t(locale, 'leaderboard.empty'), flags: MessageFlags.Ephemeral };
  }
  const lines = board.entries.map((entry) =>
    t(locale, 'leaderboard.entry', {
      rank: formatRank(entry.rank),
      // Masked links aren't escaped by default, and a name like [x](url) would render as a link.
      name: escapeMarkdown(entry.displayName, { maskedLink: true }),
      balance: formatCoins(entry.balance),
    }),
  );
  const footer = t(locale, 'leaderboard.footer', {
    page: formatCount(board.page),
    pageCount: formatCount(board.pageCount),
    players: formatCount(board.playerCount),
    rank:
      callerStanding.rank === null
        ? t(locale, 'leaderboard.unranked')
        : formatRank(callerStanding.rank),
  });
  const embed = new EmbedBuilder()
    .setColor(colors.leaderboard)
    .setTitle(t(locale, 'leaderboard.title'))
    .setDescription(lines.join('\n'))
    .setFooter({ text: footer });
  return { embeds: [embed] };
}
