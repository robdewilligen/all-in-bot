/** Every user-facing string. Placeholders are `{name}`; callers format coins and times first. */
export const en = {
  errors: {
    generic: 'Something went wrong on our side. Please try again in a moment.',
    guildOnly: 'All-in only works in servers.',
    cooldown: 'Slow down! You can use `/{command}` again {time}.',
    insufficientFunds:
      "You don't have enough coins: this needs {needed}, and your balance is {balance}.",
    missingPermissions: "I can't open a table in this channel. I'm missing: {permissions}.",
    noThreads:
      'Tables are played in a thread, and this channel has none. Use the command in a text channel.',
    tableClosed: 'This table has closed. Open stakes were refunded.',
    formExpired: 'This form waited too long and has expired. Press the button on the table again.',
    restarting: 'All-in is restarting. Try again in a minute; nothing was bet.',
  },
  // Keys match discord.js permission names.
  permissions: {
    ViewChannel: 'View Channel',
    CreatePublicThreads: 'Create Public Threads',
    SendMessagesInThreads: 'Send Messages in Threads',
    EmbedLinks: 'Embed Links',
  },
  commands: {
    dailygift: { description: "Claim today's coins" },
    firstgift: { description: 'Claim a one-time head start of coins in this server' },
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
      topics: { economy: 'Economy', roulette: 'Roulette', blackjack: 'Blackjack', slots: 'Slots' },
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
  firstGift: {
    title: '🎁 First gift',
    claimed: '{player} got a head start of **{amount}**.',
    balance: 'Balance',
    alreadyClaimed:
      'You already got your first gift in this server. `/dailygift` gives you more every day.',
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
      description:
        'Casino games played with virtual coins that have no real-world value. Roulette and blackjack are played at tables: each table is a thread, so the channel itself stays clean.',
      commands: 'Commands',
      command: '`/{command}` · {description}',
      topics: 'Help topics',
      economy: '`/help topic:economy` · Daily gift, streaks, limits and amounts',
      roulette: '`/help topic:roulette` · Notation, announced bets and how a round works',
      blackjack: '`/help topic:blackjack` · Rules, seats, turns and payouts',
      slots: '`/help topic:slots` · Paytable and payout percentage',
    },
    economy: {
      title: '🪙 Economy',
      description:
        'Each server has its own balances, streaks and leaderboard. The first gift and the daily gift are the only ways to get new coins.',
      firstGift: 'First gift',
      firstGiftText:
        '`/first-gift` gives you **{amount}** once in each server, as a head start. Everyone can claim it once, also players who already have coins.',
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
  // Table threads and their lobby (SPEC §4).
  tables: {
    command: { description: 'Open a table thread where you and others pick a game to play' },
    games: { roulette: 'Roulette', blackjack: 'Blackjack' },
    thread: {
      name: 'Table #{number}',
      withGame: 'Table #{number} ({game})',
    },
    errors: {
      otherGame:
        'Table #{number} is playing {game} right now. Wait for this game to end, or use `/{command}` outside this thread.',
      full: 'Table #{number} has no room. Use `/{command}` outside this thread to find another table.',
    },
    buttons: { blackjack: '🃏 Blackjack', leave: '👋 Leave table', roulette: '🎡 Roulette' },
    created: 'Your table is open: [Table #{number}]({url}). Pick a game there.',
    forms: {
      blackjack: {
        label: 'Your bet',
        placeholder: '250, 2,500, 1.5k, all, max or half',
        title: '🃏 Blackjack',
      },
      roulette: {
        label: 'Your bets, as amount:spot',
        placeholder: '10:17, 10:red, 5:d1',
        title: '🎡 Roulette',
      },
    },
    lobby: {
      closedEmpty:
        'Everyone has left, so this table has closed. Use `/create-table` to open a new one.',
      closedIdle:
        'No game started for {minutes} minutes, so this table has closed. Use `/create-table` to open a new one.',
      closedLost:
        "This table can't be played any more, so it has closed. Use `/create-table` to open a new one.",
      closedRestart:
        'This table closed because the bot is restarting. Use `/create-table` to open a new one once it is back.',
      closedTitle: 'Table #{number} · closed',
      morePlayers: 'and {count} more',
      pick: 'Pick the next game with a button below, or leave the table. Without a new game, this table closes {time}.',
      players: 'Players',
      playing:
        'The game is below this message. When it ends, a new lobby lets you pick the next game.',
      playingTitle: 'Table #{number} · playing {game}',
      title: 'Table #{number} · pick a game',
    },
    notices: {
      notAPlayer: "You aren't a player at this table, so there's nothing to leave.",
    },
  },
  roulette: {
    announced: {
      jeuZero: 'Jeu zéro',
      neighbours: 'Neighbours of {number}',
      orphelins: 'Orphelins',
      tiers: 'Tiers du cylindre',
      voisins: 'Voisins du zéro',
    },
    autocomplete: {
      error: '✗ {error}',
      hint: 'Type bets as amount:spot, like 10:17 or 10:red, 5:d1 · see /help topic:roulette',
      preview: '✓ {bets} · total {total}',
    },
    bet: '{amount} on {bet}',
    betCount: {
      one: '1 bet',
      other: '{count} bets',
    },
    command: {
      bets: 'Your bets as amount:spot, like 10:17 or 10:red, 5:d1',
      description: 'Bet on the next spin of a shared European roulette table',
    },
    confirmation: {
      elsewhere: 'This table is in another channel: [go to the table]({url}).',
      here: '[Go to the table]({url})',
      spins: 'The wheel spins {time}.',
      title: '🎡 Your bets',
      total: 'Total: **{total}** on {bets}',
    },
    errors: {
      aboveMaximum:
        'That would bring your bets on this spin to {total}, over the maximum of {max}. You have {placed} on it already.',
      bettingClosed:
        'Betting on this spin has closed. Wait for the result, then bet on the next spin.',
      tooManyBets:
        "You have {placed} of your {max} bets on this spin already, so {count} more won't fit.",
    },
    help: {
      announced: 'Announced bets',
      announcedText:
        'The amount is the total for all chips, so it must divide evenly by the number of chips; `all`, `max` and `half` round down to fit. An announced bet counts as one bet.',
      bets: 'Bets and payouts',
      description:
        'European roulette with a single zero, at tables shared by everyone in the server. Bet with `/roulette bets:<bets>`, like `/roulette bets:10:17, 10:red, 5:d1`.',
      kinds: {
        column: 'Column · `c1` `c2` `c3` · **2:1**',
        corner: 'Corner · `1/2/4/5` · **8:1**',
        dozen: 'Dozen · `d1` `d2` `d3`, `1st12` `2nd12` `3rd12`, `1-12` · **2:1**',
        evenMoney:
          'Even money · `red` `black` `even` `odd` `low` (`1-18`) `high` (`19-36`) · **1:1**',
        firstFour: 'First four · `0-3` · **8:1**',
        sixLine: 'Six line · `1-6` · **5:1**',
        split: 'Split · `17/20`, `17-18`, `0/1` · **17:1**',
        straight: 'Straight · `17` · **35:1**',
        street: 'Street · `13-15` · **11:1**',
        trio: 'Trio · `0/1/2`, `0/2/3` · **11:1**',
      },
      layouts: {
        jeuZero: '`jeu0` · {name} · 4 chips: 0/3, 12/15, 26, 32/35',
        neighbours:
          '`n17` · Neighbours · 5 chips: 17 and the two numbers on each side of it on the wheel, straight up',
        orphelins: '`orphelins` · {name} · 5 chips: 1, 6/9, 14/17, 17/20, 31/34',
        tiers: '`tiers` · {name} · 6 chips: 5/8, 10/11, 13/16, 23/24, 27/30, 33/36',
        voisins:
          '`voisins` · {name} · 9 chips: 2 on 0/2/3; 1 each on 4/7, 12/15, 18/21, 19/22, 32/35; 2 on 25/26/28/29',
      },
      notation: 'Notation',
      notationText:
        'Write each bet as `amount:spot`, and separate bets with commas, semicolons or spaces. `5:7+17+27` puts 5 on each of 7, 17 and 27. `a-b` covers every number from a to b and `a/b/c` is a set; either must be one bet on the table. Amounts work as everywhere: `1.5k`, `half`, `all`. French and Dutch names work too: `rouge`, `noir`, `pair`, `impair`, `manque`, `passe`, `rood`, `zwart`, `oneven`, `laag`, `hoog` and `k1`–`k3`.',
      round: 'A betting round',
      roundText:
        "Every table is a thread, like **Table #12 (Roulette)**. `/roulette` puts your bets on the next spin of a table: one with room in this channel, otherwise one in a channel you can see, otherwise a new table here. In a table's thread, `/roulette` bets at that table. Between games a table shows a lobby, where the 🎡 Roulette button opens a bet form; `/create-table` opens a table with a lobby. The first bets start a {seconds}-second countdown. Until it ends, anyone can join and add bets: up to {players} players a spin, and up to {bets} bets and {min} to {max} per player. Your coins are taken when you bet. Then the wheel spins once for everyone at the table, the table shows the result, and you get your own result privately.",
      title: '🎡 Roulette',
    },
    pockets: {
      black: '⚫ **{number}** Black',
      green: '🟢 **{number}** Green',
      red: '🔴 **{number}** Red',
    },
    result: {
      balance: 'Balance',
      lost: '❌ {bet} · {amount} → {payout}',
      net: 'Net result',
      netLoss: '-{amount}',
      netWin: '+{amount}',
      payout: 'Total payout',
      stake: 'Total stake',
      title: '🎡 Your result',
      won: '✅ {bet} · {amount} → {payout}',
    },
    table: {
      betting: 'Place your bets with `/roulette`!',
      cancelled: 'Something went wrong, so this spin was cancelled. Every stake was refunded.',
      cancelledPending:
        'Something went wrong, so this spin was cancelled. Every stake comes back automatically shortly.',
      cancelledSettled:
        'Something went wrong while showing this spin, but it went through. Check `/balance` for your coins.',
      closed:
        'This table closed because the bot is restarting. Its stakes are refunded when the bot starts again.',
      player: '**{name}** · {stake} · {bets}',
      playerCount: '{count}/{max}',
      playerResult: '**{name}** · stake {stake} · payout {payout} · net {net}',
      players: 'Players',
      rolling: 'The ball is rolling…',
      spins: 'Wheel spins',
      title: '🎡 Roulette',
      total: 'Total stake',
    },
  },
  blackjack: {
    buttons: {
      changeBet: 'Change bet',
      double: 'Double ({cost})',
      evenMoney: 'Even money',
      hit: 'Hit',
      insurance: 'Insurance',
      insuranceCost: 'Insurance ({cost})',
      leave: 'Leave',
      noEvenMoney: 'No even money',
      noInsurance: 'No insurance',
      sameBet: 'Same bet',
      sameBetAmount: 'Same bet ({bet})',
      split: 'Split ({cost})',
      stand: 'Stand',
      surrender: 'Surrender',
    },
    cards: {
      card: '{rank}{suit}',
      hidden: '🎴',
      ranks: {
        '10': '10',
        '2': '2',
        '3': '3',
        '4': '4',
        '5': '5',
        '6': '6',
        '7': '7',
        '8': '8',
        '9': '9',
        A: 'A',
        J: 'J',
        K: 'K',
        Q: 'Q',
      },
      suits: { clubs: '♣️', diamonds: '♦️', hearts: '♥️', spades: '♠️' },
    },
    command: {
      bet: 'How much to bet: 250, 2,500, 1.5k, all, max or half',
      description: 'Take a seat at a shared blackjack table, with your bet for the next round',
    },
    help: {
      dealerH17: 'The dealer hits soft 17 and peeks for blackjack under an ace or a ten.',
      dealerS17: 'The dealer stands on soft 17 and peeks for blackjack under an ace or a ten.',
      decks: '{decks} decks, reshuffled once {cut}% of the shoe has been dealt.',
      description:
        'Every table is a thread named "Table #N", where up to {seats} players share a dealer. `/blackjack bet:<amount>` takes a seat with that amount as your bet: at a table with room in this channel, else in a channel you can see, else at a new table here. Between games a table shows a lobby, where the **Blackjack** button opens a bet form to start a game there.',
      doubleAfterSplit: 'Double on any first two cards, also after a split.',
      doubleNoSplit: 'Double on any first two cards, but not after a split.',
      insurance:
        'Insurance costs half your bet and pays 2:1 if the dealer has blackjack. With blackjack yourself, you get even money instead: 1:1, whatever the dealer has.',
      payout: 'Blackjack pays {ratio}.',
      rules: 'Rules',
      seats: 'Seats and betting',
      seatsText:
        'Every round opens with {betting} seconds of betting: **Same bet** repeats your bet, **Change bet** sets a new one and **Leave** gives up your seat. The cards come as soon as everyone has bet. A bet is {min} to {max}; doubling, splitting and insurance only need the coins. Sit out {sitOuts} rounds in a row and you lose your seat.',
      split:
        'Split two cards of equal value, K+Q too, into up to {hands} hands. Split aces get one card each.',
      surrender: 'Surrender your first two cards to get half your bet back.',
      title: '🃏 Blackjack',
      turns: 'Playing a hand',
      turnsText:
        "When the dealer shows an ace, everyone has {insurance} seconds to answer **Insurance** or **No insurance** (**Even money** with blackjack). Then the players act in seat order, with {turn} seconds per hand: **Hit** takes a card, **Stand** keeps your hand, **Double** doubles your bet for one last card, **Split** turns a pair into two hands and **Surrender** gives up the hand. Buttons you can't use or afford are grey. Only the player whose turn it is can act; when the time runs out, the bot stands for you.",
    },
    insurance: {
      declined: 'No insurance',
      evenMoneyDeclined: 'No even money',
      evenMoneyOffer: 'Even money?',
      evenMoneyTaken: 'Even money',
      lost: 'Insurance lost ({cost})',
      offer: 'Insurance? ({cost})',
      paid: 'Insurance paid {payout}',
      taken: 'Insurance taken ({cost})',
    },
    modal: {
      label: 'Your bet',
      placeholder: '250, 2,500, 1.5k, all, max or half',
      title: 'Change bet',
    },
    notices: {
      alreadyBet:
        'Your bet of **{bet}** is placed for this round. Use `/blackjack` to change your bet for the next one.',
      betForNextRound: 'Betting has closed. Your bet for the next round is **{bet}**.',
      betStands:
        'Your bet of **{bet}** stands for this round. Your bet for the next round is **{next}**.',
      evenMoneyButtons: 'You have blackjack: answer with **Even money** or **No even money**.',
      insuranceButtons: 'Answer with **Insurance** or **No insurance**.',
      leavingAfterRound:
        "Your bet for this round is placed, so you'll leave the table when the round ends.",
      notInRound: "You aren't playing this round. Wait for the next one.",
      notSeated: "You don't have a seat at this table. Use `/blackjack` to sit down.",
      notYourTurn: "It's **{player}**'s turn.",
    },
    outcomes: {
      blackjack: '🎉 Paid {ratio}',
      evenMoney: '💰 Even money',
      lose: '❌ Lose',
      push: '➖ Push',
      surrender: '🏳️ Surrendered',
      win: '✅ Win',
    },
    ratio: '{numerator}:{denominator}',
    reply: {
      elsewhere: 'This table is in another channel: [go to the table]({url}).',
      link: '[Go to the table]({url})',
      nextRound:
        'You have seat {seat}. Your bet for the next round is **{bet}**: press **Same bet** when betting opens. {link}',
      placed: 'You have seat {seat}, with a bet of **{bet}** on this round. {link}',
    },
    status: {
      betPlaced: '✅ Bet placed',
      leaving: '👋 Bet placed, leaves after this round',
      nextRound: '⏳ Joins the next round',
      noBet: '⏳ No bet yet',
      noBetSatOut: '⏳ No bet yet · sat out {count}/{max}',
      playing: '🃏 Playing',
      playingLeaving: '🃏 Playing, leaves after this round',
      sittingOut: '💤 Sitting out · {count}/{max}',
    },
    table: {
      bettingOpen: '**Place your bets!** Betting closes {time}.',
      closedEmpty: 'Every seat is empty, so this game of blackjack has ended.',
      closedRefundPending:
        '⚠️ This round could not be settled, so this game has ended. Its stakes come back to you automatically shortly.',
      closedRefunded:
        '⚠️ This round could not be settled, so every stake was refunded and this game has ended.',
      closedRestart:
        'This table closed for a restart. Open stakes are refunded when the bot starts again.',
      closedSettledLate:
        "⚠️ This round went through, but its result can't be shown, so this game has ended. Check your coins with `/balance`.",
      dealer: 'Dealer',
      dealerHand: '{cards} · {total}',
      footerH17:
        '{decks} decks · Dealer hits soft 17 · Blackjack pays {ratio} · {cards} cards left in the shoe',
      footerS17:
        '{decks} decks · Dealer stands on soft 17 · Blackjack pays {ratio} · {cards} cards left in the shoe',
      hand: '{cards} · {total} · {bet}',
      handActive: '▶️ {hand}',
      handDoubled: '{cards} · {total} · {bet}, doubled',
      handResult: '{hand} · {outcome}',
      insuranceOpen:
        'The dealer shows an ace. **Insurance?** Everyone answers for themselves, and no answer means no. Answers close {time}.',
      lastDealer: 'Dealer · last round',
      net: 'Net {net} · Balance {balance}',
      netLoss: '-{amount}',
      netWin: '+{amount}',
      player: '**{name}**',
      seat: 'Seat {seat}',
      seatLine: 'Seat {seat} · **{name}** · {bet} · {status}',
      stoodAutomatically: '⏱️ Out of time: the bot stood automatically.',
      title: '🃏 Blackjack · Table #{number}',
      turn: "It's **{player}**'s turn. Time runs out {time}.",
    },
    totals: {
      blackjack: 'Blackjack!',
      bust: '{total}, bust',
      hard: '{total}',
      soft: 'soft {total}',
    },
  },
  slots: {
    balance: 'Balance',
    bet: 'Bet',
    command: {
      bet: 'How much to bet: 250, 2,500, 1.5k, all, max or half',
      description: 'Spin the slot machine',
    },
    help: {
      anywhere: '{symbols} anywhere on the payline · **{multiplier}×**',
      description:
        '`/spin bet:<amount>` spins three reels, and the middle row is the payline. Payouts are multiples of your bet and include it.',
      line: '{symbols} · **{multiplier}×**',
      payout: 'Payout percentage',
      payoutText:
        'Over every possible spin, the machine pays back **{rtp}** of all bets, and **{winRate}** of spins win.',
      paytable: 'Paytable',
      title: '🎰 Slots',
    },
    jackpot: '🎉 **JACKPOT!** {count}× {symbol} pays {multiplier}×',
    net: 'Net result',
    netLoss: '-{amount}',
    netWin: '+{amount}',
    noWin: 'No win this time.',
    payline: '{symbols} ⬅️',
    spinning: 'Spinning…',
    symbols: {
      bell: '🔔',
      cherry: '🍒',
      diamond: '💎',
      grape: '🍇',
      lemon: '🍋',
      orange: '🍊',
      seven: '7️⃣',
    },
    title: '🎰 Slots',
    win: '**{count}× {symbol} pays {multiplier}×**',
    winnings: 'Winnings',
  },
} as const;
