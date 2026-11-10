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
  amount: {
    aboveMaximum: '{stake} is above the maximum bet of {max}. Use `max` to bet the most you can.',
    allAboveMax: 'All-in ({balance}) is over the maximum bet of {max}. Use `max` to bet {max}.',
    belowMinimum: '{stake} is below the minimum bet of {min}.',
    choiceAll: 'All-in · {amount}',
    choiceError: '✗ {error}',
    choiceHalf: 'Half · {amount}',
    choiceMax: 'Max · {amount}',
    decimalPoint:
      'With `k` or `m`, use one `,` or `.` as the decimal point, like `1.5k` or `1,5k`.',
    empty: 'Type an amount, like `250`, `2,500`, `1.5k` or `half`.',
    fraction: 'That comes to a fraction of a coin. Coins are whole numbers: try `1.5k` or `1,234`.',
    grouping:
      'Without `k` or `m`, `,` and `.` separate thousands, like `2,500`. For decimals add `k`: `2.5k`.',
    halfIsZero: 'Half of {balance} rounds down to 0 coins. Claim more with `/dailygift`.',
    invalid: "That isn't an amount. Try `250`, `2,500`, `1.5k`, `2m`, `all`, `max` or `half`.",
    mixed: 'Use `,` or `.` in an amount, not both. Try `1,500` or `1.5k`.',
    negative: "An amount can't be negative. Try `250` or `1.5k`.",
    noCoins: 'You have no coins to bet. Claim your daily gift with `/dailygift`.',
    tooLarge: 'That number is too large. The maximum bet is {max}; `max` bets the most you can.',
    zero: 'The amount must be more than 0. Try `250` or `1.5k`.',
  },
  rouletteNotation: {
    announcedMultiple:
      '`{bet}` is {chips} chips, so its amount must be a multiple of {chips}, like `{example}:{bet}`.',
    announcedTooSmall: '`{amount}` comes to {coins}, too little for the {chips} chips of `{bet}`.',
    empty: 'Type your bets as `amount:spot`, like `10:17` or `10:red, 5:d1`.',
    missingAmount: '`{bet}` has no amount. Put it before the colon, like `10:17`.',
    missingSpot:
      '`{bet}` is missing a spot. Put spots after the colon, like `10:17` or `5:7+17+27`.',
    notABet: "`{text}` isn't a bet. Write each bet as `amount:spot`, like `10:17` or `10:red`.",
    notOnTable:
      "`{spot}` isn't one bet on the table. Splits, streets, corners and lines cover touching numbers, like `17/20`, `13-15`, `1/2/4/5` or `1-6`.",
    numberOutOfRange: "There's no {number} on the wheel: the numbers go from 0 to 36.",
    repeatedNumber: '`{spot}` has {number} twice. List each number once, like `17/20`.',
    tooManyBets:
      "That's {count} bets; you can place at most {max} per spin. An announced bet like `voisins` counts as one.",
    unknownSpot:
      "`{spot}` isn't a bet on the table. Try `17`, `17/20`, `red`, `d1`, `c1` or `voisins`, or see `/help topic:roulette`.",
  },
} as const;
