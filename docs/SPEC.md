# All-in: specification

## 1. Product

All-in is a Discord casino bot. Players get virtual coins from a daily gift and play roulette, blackjack and a slot machine. A leaderboard per server shows who has the most coins.

- The bot is the dealer in every game.
- Everything users see (command names, option names, descriptions, replies) is in English, so the bot works in international servers. Keep all strings in `src/i18n/en.ts`, structured so another language could be added later through `interaction.locale`. No other languages for now, and no localized command names.
- The economy is per server: balance, daily gift, streak and leaderboard are scoped to (server, user).
- Commands only work in servers (guild install), not in DMs and not as a user-installed app.

## 2. Guardrails

Discord's gambling policy is about wagers and prizes with real-world value. All-in stays clear of that by design:

- coins can't be bought (no premium tier, donations or server-subscription perks that grant coins);
- coins can't be transferred, traded, sold or cashed out, and there is no shop;
- no real prizes are tied to balances or leaderboard positions.

The README states this plainly for server owners. Don't add features that break these rules.

## 3. Commands

| Command | Options | What it does |
| --- | --- | --- |
| `/dailygift` | none | Claim today's coins |
| `/balance` | `player` (user, optional) | Balance and leaderboard position |
| `/leaderboard` | `page` (integer ≥ 1, optional) | Players with the most coins in this server |
| `/roulette` | `bets` (string, max 500 characters, required, autocomplete) | European roulette, one or more bets per spin |
| `/blackjack` | `bet` (string, required, autocomplete) | Blackjack against the dealer |
| `/spin` | `bet` (string, required, autocomplete) | Slot machine |
| `/help` | `topic` (choice: economy, roulette, blackjack, slots; optional) | Rules, notation and payouts |

## 4. Shared behaviour

**Amounts.** One parser for every amount: `250`, `2,500` or `2.500` (thousands separators), `1.5k` or `1,5k`, `2k`, `1m`, `all`, `all-in`, `allin`, `max` and `half`. The Dutch keywords `alles` and `helft` are accepted as aliases. Keywords resolve against the player's current balance. The result must be a positive whole number.

**Limits** (config): minimum 10 and maximum 1,000,000 total stake per round; at most 30 bets per roulette spin.

**Autocomplete for bet options.** Suggest the parsed value of what the player typed, plus "All-in · 🪙 1,234" and "Half · 🪙 617" from the live balance. Autocomplete must answer within 3 seconds and never throw.

**Cooldowns.** Per user per command: 3 seconds by default, 5 seconds for `/leaderboard`. On cooldown the player gets an ephemeral reply with a relative timestamp.

**Errors.** Player errors (invalid input, not enough coins, cooldown, not your game) get a specific ephemeral message. Unexpected errors are logged with context, and the player gets a short generic ephemeral message.

**Look and feel.** Embeds. Colours: blurple for info and games in progress, green for a net win, red for a net loss, grey for break-even, gold for the daily gift and the leaderboard. Coins are shown as `🪙 1,234`. Times use Discord timestamps (`<t:…:R>`), which every user sees in their own time zone and language. Every random outcome comes from `crypto.randomInt`.

**Settle, then show.** Instant games are settled in one transaction before the first reply. Animations (roulette, slots) are cosmetic edits of a result that is already settled.

## 5. Economy

### /dailygift

- 1,000 coins per calendar day, plus 100 for every consecutive day, up to +700 (from day 8 on: 1,700 a day). Missing a day resets the streak.
- The day ends at midnight in `DAILY_RESET_TIMEZONE` (default `Europe/Amsterdam`). Daylight saving changes must work; test the March and October switches.
- A second claim on the same day gets an ephemeral reply with the next reset as a relative timestamp.
- Reply: amount, streak, new balance and the next reset.

### /balance

- Balance and leaderboard rank of the caller, or of `player`. Mentions never ping.

### /leaderboard

- Players in this server with a balance above 0, highest first. Equal balances share a rank (`RANK()`).
- Pages of 10; a page beyond the end shows the last page. Footer: page x/y, number of players and the caller's own rank.
- Names are the display name stored at the player's last activity (no API calls), with markdown escaped. Players who left the server stay listed; filtering them out would need the privileged GuildMembers intent.

## 6. Roulette (European, single zero)

### Notation

`amount:spot`, several bets separated by commas, semicolons or spaces. Example: `/roulette bets:10:5, 10:15, 10:20` places 10 on 5, 10 on 15 and 10 on 20.

| Bet | Notation | Pays |
| --- | --- | --- |
| Straight | `17` | 35:1 |
| Split | `17/20`, `17-18`, `0/1` | 17:1 |
| Street | `13-15` | 11:1 |
| Trio | `0/1/2`, `0/2/3` | 11:1 |
| Corner | `1/2/4/5` | 8:1 |
| First four | `0-3` | 8:1 |
| Six line | `1-6` | 5:1 |
| Dozen | `d1` `d2` `d3`, `1st12` `2nd12` `3rd12`, `1-12` | 2:1 |
| Column | `c1` `c2` `c3` | 2:1 |
| Even money | `red` `black` `even` `odd` `low` (`1-18`) `high` (`19-36`) | 1:1 |
| Announced | `voisins`, `tiers`, `orphelins`, `jeu0`, neighbours `n17` | per chip |

- `a-b` means every number from a to b; `a/b/c` is an explicit set.
- French names (`rouge`, `noir`, `pair`, `impair`, `manque`, `passe`) and Dutch names (`rood`, `zwart`, `oneven`, `laag`, `hoog`, `k1`–`k3`) are accepted as aliases.
- `5:7+17+27` places the same amount on several spots (three bets of 5).
- Amounts accept the shared amount syntax (`1k`, `half`, `all`).

### Resolving bets

Every spot resolves to the set of numbers it covers, and that set must be one of the 157 legal bets of a European table: 37 straight, 60 split (including 0/1, 0/2 and 0/3), 12 street, 2 trio, 22 corner, 1 first four, 11 six line, 3 dozen, 3 column and 6 even money. Build this table once from the layout and look spots up by their sorted number set. Bet type and payout follow from the set: a winning chip returns stake × 36 / n (stake included), which gives every bet the same 1/37 house edge. Sets that aren't on the table, such as `1/3` or `1-4`, are rejected with a clear message.

- Red numbers: 1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36.
- Wheel order: 0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26.

### Announced bets

The amount is the total and must divide evenly by the number of chips.

| Bet | Chips | Layout |
| --- | --- | --- |
| Voisins du zéro | 9 | 2 on 0/2/3; 1 each on 4/7, 12/15, 18/21, 19/22, 32/35; 2 on 25/26/28/29 |
| Tiers du cylindre | 6 | 5/8, 10/11, 13/16, 23/24, 27/30, 33/36 |
| Orphelins | 5 | 1, 6/9, 14/17, 17/20, 31/34 |
| Jeu zéro | 4 | 0/3, 12/15, 26, 32/35 |
| Neighbours `nX` | 5 | X and the two numbers on each side of it on the wheel, straight up |

Tests check that each announced bet covers exactly its sector of the wheel: voisins from 22 to 25 through 0, tiers from 27 to 33, jeu zéro from 12 to 15, and orphelins the remaining 8 numbers.

### Spin and result

- One CSPRNG draw from 0 to 36. Settle, reply "The ball is rolling…", then after about 1.5 seconds edit in the result: number and colour, every bet with ✅ or ❌ and its payout, total stake, total payout, new balance and net result.
- Autocomplete on `bets` is a live preview: "✓ 3 bets · total 🪙 30" or "✗ <the parse error>" (at most 100 characters). With an empty field it shows a hint that points to `/help topic:roulette`.

## 7. Blackjack

### Rules (one config object)

- A 6-deck shoe per server, shuffled with Fisher–Yates and the CSPRNG, and reshuffled before the next round once the cut card at 75% of the shoe has been dealt.
- The dealer stands on every 17, soft 17 included (S17). `dealerHitsSoft17: true` switches to H17.
- Blackjack pays 3:2, rounded down for odd bets.
- The dealer peeks for blackjack when showing an ace or a ten-value card; a natural ends the round at once.
- Insurance is offered when the dealer shows an ace: it costs half the bet (rounded down) and pays 2:1. When the player has blackjack it's presented as even money.
- Double on any first two cards, also after a split.
- Split two cards of equal value (K+Q allowed), up to 4 hands. Split aces get exactly one card each and can't be resplit. 21 after a split isn't blackjack.
- Late surrender on the first two cards of an unsplit hand returns half the bet.
- One active game per player per server.

### Flow

- `/blackjack bet:<amount>` opens a round in the database (status `open`, stake reserved) and deals player, dealer upcard, player, dealer hole card.
- Buttons: Hit, Stand, Double (with its cost), Split (with its cost) and Surrender. During the insurance question: Insurance (with its cost) and No insurance. Buttons that aren't allowed or affordable are disabled.
- A component collector with a 2-minute idle timeout. On timeout the bot declines insurance, stands on every remaining hand, settles and edits the message with a note that it stood automatically.
- Custom IDs carry a step counter (`blackjack:<action>:<step>`). Presses with an outdated step are ignored, which also handles double clicks.
- Double, split and insurance raise the open round's stake in the database before the action is applied. With too few coins the player gets an ephemeral error and nothing changes.
- Open rounds are refunded at startup. A press on a button of a game that no longer exists removes the buttons and replies ephemerally that the game ended and the stake was refunded.
- Display: dealer cards (hole card hidden until the end), each hand with its total ("soft 17", "Blackjack!", "24, bust"), its bet, a marker on the active hand after a split, the result per hand, the insurance outcome, the net result and the new balance. Footer: a summary of the rules and the cards left in the shoe.

### Verification

- Engine tests with stacked decks: S17 and H17, 3:2 and its rounding, peeking under a ten and an ace, insurance paid and lost, even money, double, surrender, split aces, resplitting up to 4 hands, no dealer draw when every hand busted, and standing on timeout.
- `scripts/simulate-blackjack.ts` plays N hands (default 1,000,000) of basic strategy (multi-deck S17, double after split, late surrender, no insurance) against the real engine and prints the player's expected return with a 95% interval. With the default rules this lands around −0.4%; a prototype measured −0.37% ± 0.13% over 3 million hands. A clearly different value after a change means a rule or payout broke.

## 8. Slot machine (/spin)

- 3 reels of 32 stops and one payline, the middle row. The reply shows a 3×3 window.
- Symbols per reel, with their weight: 🍒 10, 🍋 7, 🍊 6, 🍇 4, 🔔 3, 💎 1, 7️⃣ 1. Build each strip from the weights with the symbols spread evenly, and rotate each reel differently.
- Paytable (× stake, stake included): 7️⃣ 7️⃣ 7️⃣ 100, 💎 💎 💎 50, 🔔 🔔 🔔 25, 🍇 🍇 🍇 15, 🍊 🍊 🍊 10, 🍋 🍋 🍋 8, 🍒 🍒 🍒 5, and exactly two 🍒 anywhere on the line 3.
- The exact return-to-player, found by going through all 32,768 stop combinations, is 96.10%, with a win on 25.18% of spins. `npm run rtp:slots` prints it, and a test asserts it stays between 95% and 97%.
- Settle first. Animation: the reels stop one by one, about 700 ms apart (three edits); reels that haven't stopped yet show random symbols.
- Result: the winning combination ("3× 🔔 pays 25×", and "JACKPOT" from 50× up), the bet, the winnings, the new balance and the net result.

## 9. /help

Ephemeral. Without a topic it gives an overview of all commands. Topics: economy (daily gift, streaks, limits, amount syntax), roulette (the notation table and announced bets), blackjack (rules and buttons) and slots (paytable and payout percentage).

## 10. Data model and wallet

Discord IDs are stored as `text`. Coin columns are `bigint`; read them as JS numbers with a safe-integer check, or as `bigint`.

| Table | Columns | Keys and constraints |
| --- | --- | --- |
| `players` | guild_id, user_id, display_name, balance, created_at, updated_at | PK (guild_id, user_id); `balance >= 0`; index on (guild_id, balance desc) |
| `daily_claims` | guild_id, user_id, claim_date (date), amount, streak, claimed_at | PK (guild_id, user_id, claim_date) |
| `rounds` | id, guild_id, user_id, game, status (open, settled, refunded), stake, payout, details (jsonb), created_at, settled_at | `stake > 0`; partial index where status = 'open' |
| `ledger_entries` | id, guild_id, user_id, round_id, kind (daily, stake, raise, payout, refund), amount (signed), balance_after, created_at | FK on round_id; index on (guild_id, user_id, created_at); append-only |

Wallet API (names may change, the guarantees may not):

- `balanceOf`, `rankOf` and `leaderboard(guildId, page)`
- `claimDaily(player, now)`
- `playInstant(player, game, stake, play)`: debit, play and credit in one transaction
- `openRound`, `raiseRound` and `settleRound`: the blackjack lifecycle, with the round row locked through `SELECT … FOR UPDATE`
- `refundOpenRounds()`: called once at startup

Tests, against `TEST_DATABASE_URL`:

- 50 parallel stakes of 100 on a balance of 1,000: exactly 10 succeed, and the balance ends at 0 without ever going negative.
- Concurrent daily claims for the same player and day: exactly one succeeds.
- For every player, the sum of the ledger amounts equals the balance.
- A game that throws rolls back completely.
- Open rounds are refunded exactly once.

Infrastructure: one `pg.Pool` for the whole app, closed on shutdown, connecting through `DATABASE_URL`. drizzle-kit generates migrations into `drizzle/`; they are reviewed, committed and applied with `npm run db:migrate`. Migrations run as an explicit step, not automatically when the bot starts (the Docker image runs them right before starting the bot).

## 11. Configuration

`.env` is validated with zod at startup; the bot exits with a clear message when a value is missing or invalid.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | yes | Application ID |
| `DEV_GUILD_ID` | no | When set, `deploy:commands` registers in this server only, which is instant |
| `DATABASE_URL` | yes | `postgresql://user:password@host:5432/database` |
| `TEST_DATABASE_URL` | tests only | A separate database that tests may wipe |
| `DAILY_RESET_TIMEZONE` | no | Default `Europe/Amsterdam` |
| `LOG_LEVEL` | no | Default `info` |

Game settings (limits, daily amounts, blackjack rules, reel weights, paytable) live in a typed config module, not in `.env`.

## 12. Deliverables

- package.json with the scripts listed in CLAUDE.md, `engines.node` set to `>=26`, and a `.nvmrc` containing 26.
- tsconfig (strict, NodeNext, `verbatimModuleSyntax`), `eslint.config.js`, a Prettier config, `.gitignore` and `.env.example`.
- README.md: what All-in is, the guardrails, setup and run instructions, the commands, the architecture and how to add a game.
- `.github/workflows/ci.yml`: Node 26, a PostgreSQL 18 service container, `npm ci`, migrations on the test database, then `npm run check`.
- `deploy/`: a Dockerfile (multi-stage, non-root user, Node 26 slim), a `compose.yaml` (bot plus `postgres:18`, with the data volume mounted at `/var/lib/postgresql`) and an example systemd unit `all-in.service`.
- No sharding; Discord only requires it from 2,500 servers. Keep all in-memory state (shoes, active games, cooldowns) keyed by server so it would stay correct per shard.

## 13. Phases

Every phase ends with `npm run check`, a summary and a commit. Wait for approval before starting the next one.

0. **Scaffold**: package.json, TypeScript, ESLint, Prettier, Vitest, CI and a README skeleton. Verify all versions with `npm view`.
1. **Config and database**: zod env, pino logger, Drizzle schema and the first migration, and the wallet with the integration tests from §10.
2. **Bot skeleton**: client bootstrap, command and event loaders, the events clientReady, interactionCreate and error, the deploy script, the error helper, cooldowns and the i18n module; `/dailygift`, `/balance`, `/leaderboard` and `/help`; tests with fake interactions.
3. **Roulette**: table, parser and settlement with tests (157 legal bets, notation cases, announced bets, house edge), then the command with its autocomplete preview and reveal.
4. **Blackjack**: shoe and engine with stacked-deck tests, the simulation script, the collector flow, stale-button handling and startup refunds.
5. **Slot machine**: the machine, the exact RTP test and script, and the command with its reveal.
6. **Hardening**: graceful shutdown (destroy the client, end the pool), a logging review, README, deploy files and a final `npm run check`.

## 14. Done by the human

Outside the repo and not your job: creating the Discord applications (All-in and All-in Dev) and their tokens, inviting the bot, installing PostgreSQL and creating the databases, and hosting. Ask for what you need through `.env`; never ask for secrets in chat.
