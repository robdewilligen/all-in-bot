/** Every user-facing string. Placeholders are `{name}`; callers format coins and times first. */
export const en = {
  errors: {
    generic: 'Something went wrong on our side. Please try again in a moment.',
    guildOnly: 'All-in only works in servers.',
    cooldown: 'Slow down! You can use `/{command}` again {time}.',
    insufficientFunds:
      "You don't have enough coins: this needs {needed}, and your balance is {balance}.",
    missingPermissions: "I can't open a table in this channel. I'm missing: {permissions}.",
    tableClosed: 'This table has closed. Open stakes were refunded.',
  },
  // Keys match discord.js permission names.
  permissions: {
    ViewChannel: 'View Channel',
    SendMessages: 'Send Messages',
    SendMessagesInThreads: 'Send Messages in Threads',
    EmbedLinks: 'Embed Links',
  },
  commands: {
    dailygift: { description: "Claim today's coins" },
    balance: {
      description: 'Balance and leaderboard position',
      player: 'The player to look up (default: you)',
    },
    leaderboard: {
      description: 'Players with the most coins in this server',
      page: 'Page number (default: 1)',
    },
    help: {
      description: 'Rules, notation and payouts',
      topic: 'What to explain',
      topics: { economy: 'Economy' },
    },
  },
  daily: {
    title: '🎁 Daily gift',
    claimed: '{player} claimed **{amount}**.',
    streak: 'Streak',
    streakDay: 'Day {streak}',
    balance: 'Balance',
    nextGift: 'Next gift',
    alreadyClaimed: "You've already claimed today's gift. Your next gift is ready {time}.",
  },
  balance: {
    title: '💰 Balance',
    ranked: '{player} has **{balance}** and is **{rank}** on the leaderboard.',
    unranked: '{player} has **{balance}** and is unranked.',
  },
  leaderboard: {
    title: '🏆 Leaderboard',
    entry: '**{rank}** {name} · {balance}',
    footer: 'Page {page}/{pageCount} · Players: {players} · Your rank: {rank}',
    unranked: 'unranked',
    empty: 'Nobody is on the leaderboard yet. Claim your first coins with `/dailygift`!',
  },
  help: {
    overview: {
      title: '🎰 All-in',
      description: 'Casino games played with virtual coins that have no real-world value.',
      commands: 'Commands',
      command: '`/{command}` · {description}',
      topics: 'Help topics',
      economy: '`/help topic:economy` · Daily gift, streaks, limits and amounts',
    },
    economy: {
      title: '🪙 Economy',
      description:
        'Each server has its own balances, streaks and leaderboard. The daily gift is the only way to get new coins.',
      dailyGift: 'Daily gift',
      dailyGiftText:
        "`/dailygift` gives you **{base}** once a day, plus your streak bonus. A new day starts at midnight in the bot's time zone, and `/dailygift` tells you when your next gift is ready.",
      streaks: 'Streaks',
      streaksText:
        'Claim on consecutive days to build a streak. Each day in a row adds **{bonus}** to your gift, up to **{maxBonus}** extra: from day {fullDay} on you get **{maxDaily}** a day. Miss a day and your streak starts over.',
      limits: 'Limits',
      limitsText: 'Every bet is at least **{min}** and at most **{max}** per round.',
      amounts: 'Amounts',
      amountsText:
        "Type `250`, `2,500` or `2.500`, or use `k` and `m`: `1.5k`, `1,5k`, `2k`, `1m`. Keywords: `all` (or `all-in`, `allin`, `alles`) bets your whole balance if that's within the limit, `max` bets your balance up to the maximum stake, and `half` (or `helft`) bets half your balance, rounded down.",
    },
  },
} as const;
