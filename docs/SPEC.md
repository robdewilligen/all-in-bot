# All-in: specification

## 1. Product

All-in is a Discord casino bot. Players get virtual coins from a daily gift and play roulette, blackjack and a slot machine. A leaderboard per server shows who has the most coins.

- The bot is the dealer in every game.
- Roulette and blackjack are played at shared tables, so players in a server play together: everyone at a roulette table bets on the same spin, and up to four players share a blackjack table and its dealer. When a table is full, a new one opens. Every table is its own thread ("Table #12 (Roulette)"), so the channels stay clean, and between games its players pick the next game. Slots are played alone: every player has their own machine.
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
| `/roulette` | `bets` (string, max 500 characters, required, autocomplete) | Place one or more bets on the next spin of a shared European roulette table |
| `/blackjack` | `bet` (string, required, autocomplete) | Take a seat at a shared blackjack table, with your bet for the next round |
| `/spin` | `bet` (string, required, autocomplete) | Slot machine |
| `/create-table` | none | Open a table thread where the players pick a game (§4); cooldown 30 seconds |
| `/help` | `topic` (choice: economy, roulette, blackjack, slots; optional) | Rules, notation and payouts |

## 4. Shared behaviour

**Amounts.** One parser for every amount: `250`, `2,500` or `2.500` (thousands separators), `1.5k` or `1,5k`, `2k`, `1m`, `all`, `all-in`, `allin`, `max` and `half`. The Dutch keywords `alles` and `helft` are accepted as aliases. The result must be a positive whole number.

- Without a `k` or `m` suffix, `,` and `.` are thousands separators and must separate groups of exactly three digits (`2,500`, `1.000.000`); `2.5` and `2,50` are rejected.
- With a suffix, a single `,` or `.` is the decimal point: `1.5k` and `1,5k` are 1,500, and so is `1.500k`. A result with a fraction, such as `1.2345k`, is rejected.
- Mixing `,` and `.` in one amount is rejected. The parser uses integer arithmetic only, never floating point.
- Keywords resolve against the player's current balance: `all`, `all-in`, `allin` and `alles` are the whole balance (rejected when that is above the maximum), `max` is the balance capped at the maximum, and `half` and `helft` are half the balance, rounded down.

**Limits** (config): minimum 10 and maximum 1,000,000 stake per player per round. For blackjack the limits apply to the opening bet; double, split and insurance are only limited by the balance. At most 30 bets per player per roulette spin; an announced bet counts as one.

**Autocomplete for bet options.** Suggest the parsed value of what the player typed, plus "All-in · 🪙 1,234" and "Half · 🪙 617" from the live balance. When the balance is above the maximum stake, suggest "Max · 🪙 1,000,000" instead of All-in. The value of a keyword choice is the keyword (`all`, `max`, `half`), so it resolves at execution time. Discord limits choice names and values to 100 characters. Autocomplete must answer within 3 seconds and never throw.

**Cooldowns.** Per user per command: 3 seconds by default, 5 seconds for `/leaderboard`. On cooldown the player gets an ephemeral reply with a relative timestamp.

**Errors.** Player errors (invalid input, not enough coins, cooldown, not your turn or seat) get a specific ephemeral message. Unexpected errors are logged with context, and the player gets a short generic ephemeral message.

**Look and feel.** Embeds. Colours: blurple for info and games in progress, green for a net win, red for a net loss, grey for break-even, gold for the daily gift and the leaderboard. Coins are shown as `🪙 1,234`. Times use Discord timestamps (`<t:…:R>`), which every user sees in their own time zone and language. Every random outcome comes from `crypto.randomInt`.

**Settle, then show.** Instant games (slots) are settled in one transaction before the first reply, so an error such as not having enough coins can still be ephemeral. A shared table round settles every player at the table in one transaction before its result is shown. Animations (roulette, slots) are cosmetic edits of a result that is already settled.

**Shared tables** (roulette and blackjack):

- **Tables are threads.** Every table is a public thread that the bot starts in a channel, without posting anything in the channel itself, so the channel stays clean.
  - The thread is named `Table #N`, plus the game being played: `Table #12 (Roulette)`. N counts the tables of the server (1, 2, 3…), is stored in the database and never restarts.
  - The thread is renamed when the table switches games. Discord allows two renames per 10 minutes; past that, the name follows at the next switch.
  - A thread auto-archives after a day without messages, and a closed table archives its thread at once.
- **Opening a table.**
  - `/create-table` opens a table with its lobby in the current channel (inside a thread: in that thread's channel), and the player gets an ephemeral link to it.
  - `/roulette` and `/blackjack` open a table themselves when the seating rule finds none; it is named after its game from the start.
  - Opening a table needs the View Channel, Create Public Threads, Send Messages in Threads and Embed Links permissions in the channel. When one is missing, the player gets an ephemeral error that names it.
  - Where no thread can be started (the chat of a voice channel, a forum post), the player gets an ephemeral error.
- **The lobby.** Between games a table shows a lobby message with the table's players and the buttons Roulette, Blackjack and Leave table.
  - A game button opens a bet form (roulette: the bet notation; blackjack: an amount), which plays exactly like the command typed in the thread.
  - The first bet starts that game: the lobby loses its buttons, and the game's table message is posted in the thread.
  - When the game is over (a roulette spin after its result, or a blackjack game once its last seat is empty), a new lobby message appears. The players can then play the same game again, switch games, or leave.
  - The players of a table are its creator and everyone who bet there; Leave table removes a player.
  - A table closes when its last player leaves, or when no game starts within 10 minutes of a lobby. The lobby then says so, and the thread is archived.
- **Seating.**
  - A player plays at their own table of that game first: at most one table per game per server.
  - Inside a table's thread, a command plays at that table: it joins its game, or starts the game from its lobby. When the table plays the other game or has no room, the player gets an ephemeral error.
  - Anywhere else, a player joins a table of that game with room in the current channel (a thread counts as its channel). Without one, they join a table with room in another channel of the server that they can see. Without one either, a new table opens in the current channel.
  - Every confirmation links to the table message.
- **Table messages.** A game's table message is an ordinary bot message in the thread, not an interaction reply, so it keeps working after the 15-minute interaction token expires.
- **State.** Tables live in memory, keyed by server and table ID. Each table and each game handles one action at a time, so concurrent presses and commands can't interleave, and seating runs one command at a time per server.
- **Money.**
  - Every player in a game has their own round in the database: open, with the stake reserved, until the shared outcome settles all players in the game in one transaction.
  - The first bet at a new table is debited before its thread is created, so a refused bet leaves nothing behind.
  - A round that can't be settled is refunded. When the refund fails too, it is retried in the background (after 5 s, 30 s, 2 min, then every 10 min) until it goes through.
- **Lost tables.**
  - With only the Guilds intent the bot isn't told when a message is deleted, so a failed edit is how a table finds out: an unknown message or channel, missing access or permissions, or an archived thread. A deleted thread is handled the same way.
  - A blackjack game then closes and refunds its open round. A roulette spin stops seating players, but still settles and sends the private results.
  - Either way, the table closes.
- **Restarts.**
  - On shutdown, every game's message says it closed, and the table threads are archived. Open rounds are refunded at startup.
  - Table IDs carry a per-process boot ID, so a button from before a restart never matches a new table. A press on a button of a table that no longer exists removes the buttons and replies ephemerally that the table closed and open stakes were refunded.

## 5. Economy

New players start with 0 coins; the daily gift is the only source of new coins. A player's row is created on their first command in a server, and every command they use refreshes their stored display name: the member's display name (server nickname, otherwise global name, otherwise username).

### /dailygift

- 1,000 coins per calendar day, plus 100 for every consecutive day, up to +700 (from day 8 on: 1,700 a day). Missing a day resets the streak.
- The day ends at midnight in `DAILY_RESET_TIMEZONE` (default `Europe/Amsterdam`). Daylight saving changes must work; test the March and October switches.
- A second claim on the same day gets an ephemeral reply with the next reset as a relative timestamp.
- Reply: amount, streak, new balance and the next reset.

### /balance

- Balance and leaderboard rank of the caller, or of `player`. Mentions never ping.
- A player with a balance of 0, or who has never played, is shown as unranked. Looking up another player doesn't create a row for them.

### /leaderboard

- Players in this server with a balance above 0, highest first. Equal balances share a rank (`RANK()`); within a rank, rows are ordered by user ID so that pages are stable.
- Pages of 10; a page beyond the end shows the last page. Footer: page x/y, number of players and the caller's own rank (or "unranked").
- A server without ranked players gets a short notice instead of an empty list.
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
- Amounts accept the shared amount syntax (`1k`, `half`, `all`). Keywords resolve against the balance before the command's bets are placed.
- An amount runs up to its colon and a spot never contains a comma, so a comma inside an amount doesn't split bets: `2,500:17, 10:red` and `10:5,10:15` both parse as two bets.

### Resolving bets

Every spot resolves to the set of numbers it covers, and that set must be one of the 157 legal bets of a European table: 37 straight, 60 split (including 0/1, 0/2 and 0/3), 12 street, 2 trio, 22 corner, 1 first four, 11 six line, 3 dozen, 3 column and 6 even money. Build this table once from the layout and look spots up by their sorted number set. Bet type and payout follow from the set: a winning chip returns stake × 36 / n (stake included), which gives every bet the same 1/37 house edge. Sets that aren't on the table, such as `1/3` or `1-4`, are rejected with a clear message.

- Red numbers: 1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36.
- Wheel order: 0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26.

### Announced bets

The amount is the total and must divide evenly by the number of chips; a keyword amount (`all`, `half`, …) rounds down to a multiple of it. An announced bet counts as one bet toward the limit and gets one result line with its combined payout.

| Bet | Chips | Layout |
| --- | --- | --- |
| Voisins du zéro | 9 | 2 on 0/2/3; 1 each on 4/7, 12/15, 18/21, 19/22, 32/35; 2 on 25/26/28/29 |
| Tiers du cylindre | 6 | 5/8, 10/11, 13/16, 23/24, 27/30, 33/36 |
| Orphelins | 5 | 1, 6/9, 14/17, 17/20, 31/34 |
| Jeu zéro | 4 | 0/3, 12/15, 26, 32/35 |
| Neighbours `nX` | 5 | X and the two numbers on each side of it on the wheel, straight up |

Tests check that each announced bet covers exactly its sector of the wheel: voisins from 22 to 25 through 0, tiers from 27 to 33, jeu zéro from 12 to 15, and orphelins the remaining 8 numbers.

### Table round

- `/roulette`, or the Roulette button of a table's lobby, places the player's bets on the next spin at a roulette table chosen by the seating rule (§4).
  - The first bets open a betting round with a 30-second countdown (`<t:…:R>`) on the table message.
  - Until it closes, other players join, and players add bets with more `/roulette` commands, within their per-spin limits.
  - At most 20 players per round; the 21st opens a new table.
- Bets are debited when placed: the player's round is open with the stake reserved. The player gets an ephemeral confirmation with their bets so far and a link to the table.
- When the countdown ends: one CSPRNG draw from 0 to 36, and every player at the table is settled in one transaction. The table message then shows "The ball is rolling…" and, about 1.5 seconds later, the result: number and colour, and one line per player with stake, payout and net result.
- Each player also gets their own result as an ephemeral follow-up on their latest `/roulette` interaction: every bet with ✅ or ❌ and its payout, total stake, total payout, new balance and net result.
- After the result the spin is over, and the table shows its lobby (§4).
- Autocomplete on `bets` is a live preview: "✓ 3 bets · total 🪙 30" or "✗ <the parse error>" (at most 100 characters). Its value is what the player typed, so choosing it keeps the input; input longer than 100 characters gets no suggestions. With an empty field it shows a hint that points to `/help topic:roulette`.

## 7. Blackjack

### Rules (one config object)

- A 6-deck shoe per table, shuffled with Fisher–Yates and the CSPRNG, and reshuffled before the next round once the cut card at 75% of the shoe has been dealt. If the shoe runs out during a round, dealing continues from a freshly shuffled shoe.
- The dealer stands on every 17, soft 17 included (S17). `dealerHitsSoft17: true` switches to H17.
- Blackjack pays 3:2, rounded down for odd bets.
- The dealer peeks for blackjack when showing an ace or a ten-value card; a dealer natural ends the round at once for every seat. A player's natural isn't played on: it's paid 3:2 at settlement, or pushes against a dealer natural.
- Insurance is offered when the dealer shows an ace: it costs half the bet (rounded down) and pays 2:1. A player with blackjack is offered even money instead: taking it settles the hand at 1:1 whatever the hole card, and costs nothing extra.
- Double on any first two cards, also after a split.
- Split two cards of equal value (K+Q allowed), up to 4 hands. Split aces get exactly one card each and can't be resplit. 21 after a split isn't blackjack.
- Late surrender on the first two cards of an unsplit hand returns half the bet, rounded down.
- A player holds at most one blackjack seat per server.

### Table and seats

A blackjack game has 4 seats and plays round after round for as long as players are seated.

- **Taking a seat.** `/blackjack bet:<amount>`, or the Blackjack button of a table's lobby, takes a free seat by the seating rule (§4). That amount is the player's bet for the next round, or for the round that's about to start. A player who already has a seat in this server changes their bet for the next round instead, and gets a link to their table.
- **Betting** (20 seconds, shown as a countdown; it ends early once every seated player has bet).
  - Buttons: Same bet (🪙 X), Change bet (a modal with an amount field, using the shared parser and limits) and Leave.
  - Placing a bet opens the player's round in the database (status `open`, stake reserved).
  - A player who doesn't bet sits out the round; after 2 rounds in a row sitting out, they lose their seat.
  - When the last seat is empty the game is over: its message says so and loses its buttons, and the table shows its lobby (§4).
- **Deal.** In seat order, every seat with a bet gets a card, then the dealer gets the upcard, then every seat gets a second card, then the dealer gets the hole card.
- **Insurance.** When the dealer shows an ace, every seat answers at once (20 seconds; no answer means no insurance) with Insurance (with its cost) or No insurance, or Even money or No even money for a player with blackjack. Each player answers only for themselves. Then the dealer peeks.
- **Turns.** Seats act in order, 45 seconds per turn. Buttons: Hit, Stand, Double (with its cost), Split (with its cost) and Surrender; buttons the active player isn't allowed to use or can't afford are disabled. Only the active player can act; anyone else gets an ephemeral notice saying whose turn it is. On timeout the bot stands on that player's remaining hands and notes that it stood automatically.
- **Settlement.** The dealer plays, but doesn't draw when every hand is busted, surrendered or already settled. Every seat settles in one transaction, the message shows the results, and the next betting phase starts. When the settlement fails, the round is refunded (§4), the message says what became of the stakes, and the game ends.
- Custom IDs: `bj:<tableId>:<action>:<step>`. The step goes up under the table lock before anything is awaited. Presses with an outdated step are acknowledged and ignored, which also handles double clicks.
- Double, split and insurance raise the player's open round in the database before the action is applied. With too few coins the player gets an ephemeral error and nothing changes.
- Display: dealer cards (hole card hidden until the dealer plays); per seat the player's name, each hand with its total ("soft 17", "Blackjack!", "24, bust"), its bet, a marker on the active hand, the result per hand, the insurance outcome, the net result and the new balance. Footer: a summary of the rules and the cards left in the shoe.

### Verification

- Engine tests with stacked decks: S17 and H17, 3:2 and its rounding, peeking under a ten and an ace, insurance paid and lost, even money, double, surrender, split aces, resplitting up to 4 hands, no dealer draw when every hand busted, and standing on timeout. With several seats: dealing order, turn order, one dealer hand for every seat, no dealer draw when every hand at the table is finished, and even money for one seat while another takes insurance.
- `scripts/simulate-blackjack.ts` plays N hands (default 1,000,000, which gives about ±0.23%) at a one-seat table with basic strategy (multi-deck S17, double after split, late surrender, no insurance) against the real engine and prints the player's expected return with a 95% interval. With the default rules this lands around −0.4%; a prototype measured −0.37% ± 0.13% over 3 million hands. A clearly different value after a change means a rule or payout broke.

## 8. Slot machine (/spin)

- 3 reels of 32 stops and one payline, the middle row. The reply shows a 3×3 window.
- Symbols per reel, with their weight: 🍒 10, 🍋 7, 🍊 6, 🍇 4, 🔔 3, 💎 1, 7️⃣ 1. Build each strip from the weights with the symbols spread evenly, and rotate each reel differently.
- Paytable (× stake, stake included): 7️⃣ 7️⃣ 7️⃣ 100, 💎 💎 💎 50, 🔔 🔔 🔔 25, 🍇 🍇 🍇 15, 🍊 🍊 🍊 10, 🍋 🍋 🍋 8, 🍒 🍒 🍒 5, and exactly two 🍒 anywhere on the line 3.
- The exact return-to-player, found by going through all 32,768 stop combinations, is 96.10%, with a win on 25.18% of spins. `npm run rtp:slots` prints it, and a test asserts it stays between 95% and 97%.
- Settle first. Animation: the reels stop one by one, about 700 ms apart (three edits); reels that haven't stopped yet show random symbols.
- Result: the winning combination ("3× 🔔 pays 25×", and "JACKPOT" from 50× up), the bet, the winnings, the new balance and the net result.

## 9. /help

Ephemeral. Without a topic it gives an overview of all commands, `/create-table` included, and says that every table is a thread. Topics: economy (daily gift, streaks, limits, amount syntax), roulette (the notation table, announced bets and how a betting round works), blackjack (rules, seats and buttons) and slots (paytable and payout percentage).

## 10. Data model and wallet

Discord IDs are stored as `text`. Coin columns are `bigint`; the code reads them as JS numbers with a safe-integer check. With a maximum stake of 1,000,000, every intermediate value stays far below 2^53.

| Table | Columns | Keys and constraints |
| --- | --- | --- |
| `players` | guild_id, user_id, display_name, balance, created_at, updated_at | PK (guild_id, user_id); `balance >= 0`; index on (guild_id, balance desc, user_id) |
| `daily_claims` | guild_id, user_id, claim_date (date), amount, streak, claimed_at | PK (guild_id, user_id, claim_date) |
| `table_rounds` | id, guild_id, game, status (open, settled, refunded), outcome (jsonb), created_at, settled_at | partial index where status = 'open' |
| `rounds` | id, guild_id, user_id, game, table_round_id, status (open, settled, refunded), stake, payout, details (jsonb), created_at, settled_at | `stake > 0`; FK on table_round_id (null for slots); unique (guild_id, user_id, game) where status = 'open' |
| `ledger_entries` | id, guild_id, user_id, round_id, kind (daily, stake, raise, payout, refund), amount (signed), balance_after, created_at | FK on round_id; index on (guild_id, user_id, created_at); append-only, enforced by a trigger that rejects UPDATE and DELETE |
| `guild_table_counters` | guild_id, last_number | PK guild_id; the table numbers of §4, taken with one atomic upsert, so two tables never get the same number. Not money, so not part of the wallet |

Wallet API (names may change, the guarantees may not):

- `balanceOf`, `rankOf` and `leaderboard(guildId, page)`
- `claimDaily(player, now)`
- `playInstant(player, game, stake, play)`: debit, play and credit in one transaction (slots)
- `openTableRound`, then `openRound` and `raiseRound` for each player at the table, then `settleTableRound`, which settles the table round and all of its players' rounds in one transaction. Rows are locked through `SELECT … FOR UPDATE`.
- `refundTableRound(id)`: refunds one open table round and its players' rounds, for a game whose settlement failed, so its players can play that game again without a restart. A table round that is no longer open fails with an error that says whether it was settled or refunded, so a game whose settlement answer got lost can tell the players the truth. The bot retries a refund that fails until it goes through (§4).
- `refundOpenRounds()`: called once at startup; refunds open rounds and marks their table rounds refunded

Tests, against `TEST_DATABASE_URL`:

- 50 parallel stakes of 100 on a balance of 1,000: exactly 10 succeed, and the balance ends at 0 without ever going negative.
- Concurrent daily claims for the same player and day: exactly one succeeds.
- For every player, the sum of the ledger amounts equals the balance.
- A game that throws rolls back completely.
- Settling a table round with 4 players is atomic: an error rolls back every player.
- A player can't hold two open rounds of the same game in one server.
- Open rounds are refunded exactly once.
- Table numbers count 1, 2, 3 per server, and concurrent calls never get the same number.

Infrastructure: one `pg.Pool` for the whole app, closed on shutdown, connecting through `DATABASE_URL`. The bot's pool has timeouts: 5 s to connect, 10 s per statement, 15 s per query and 30 s idle in a transaction. A hung database call therefore fails instead of holding a table and its server's seating forever. drizzle-kit generates migrations into `drizzle/`; they are reviewed, committed and applied with `npm run db:migrate`. Migrations run as an explicit step, not automatically when the bot starts (the Docker image runs them right before starting the bot).

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

Game settings (limits, daily amounts, blackjack rules, table sizes and timers, the lobby timeout, reel weights, paytable) live in a typed config module, not in `.env`.

## 12. Deliverables

- package.json with the scripts listed in CLAUDE.md, `engines.node` set to `>=26`, and a `.nvmrc` containing 26.
- tsconfig (strict, NodeNext, `verbatimModuleSyntax`), `eslint.config.js`, a Prettier config, `.gitignore` and `.env.example`.
- README.md: what All-in is, the guardrails, setup and run instructions, the commands, the architecture and how to add a game. It also names the channel permissions tables need, and says that each database belongs to exactly one bot process: startup refunds would otherwise hit another instance's live tables.
- `.github/workflows/ci.yml`: Node 26, a PostgreSQL 18 service container, `npm ci`, migrations on the test database, then `npm run check`.
- `deploy/`: a Dockerfile (multi-stage, non-root user, Node 26 slim), a `compose.yaml` (bot plus `postgres:18`, with the data volume mounted at `/var/lib/postgresql`) and an example systemd unit `all-in.service`.
- No sharding; Discord only requires it from 2,500 servers. Keep all in-memory state (tables, shoes, cooldowns) keyed by server so it would stay correct per shard.

## 13. Phases

Every phase ends with `npm run check`, a summary and a commit. Wait for approval before starting the next one.

0. **Scaffold**: package.json, TypeScript, ESLint, Prettier, Vitest, CI and a README skeleton. Verify all versions with `npm view`.
1. **Config and database**: zod env, pino logger, Drizzle schema and the first migration, and the wallet with the integration tests from §10.
2. **Bot skeleton**: client bootstrap, command and event loaders, the events clientReady, interactionCreate and error, the deploy script, the error helper, cooldowns and the i18n module; `/dailygift`, `/balance`, `/leaderboard` and `/help`; tests with fake interactions.
3. **Roulette**: table, parser and settlement with tests (157 legal bets, notation cases, announced bets, house edge), then the shared table round (seating, 30-second betting window, settling every player, reveal) and the command with its autocomplete preview.
4. **Blackjack**, in two parts that each end with `npm run check`, a summary and a commit:
   - 4a. **Engine**: shoe and multi-seat engine with stacked-deck tests, and the simulation script.
   - 4b. **Tables**: seats, betting phase, insurance, turns and their timers, the bet modal, stale-button handling and startup refunds. Then the table threads that roulette and blackjack share: a thread per table, `/create-table`, the lobby with its bet forms, and the table numbers.
5. **Slot machine**: the machine, the exact RTP test and script, and the command with its reveal.
6. **Hardening**: graceful shutdown (close the tables, destroy the client, end the pool), a logging review, README, deploy files and a final `npm run check`.

## 14. Done by the human

Outside the repo and not your job: creating the Discord applications (All-in and All-in Dev) and their tokens, inviting the bot (scopes `bot` and `applications.commands`; permissions View Channels, Create Public Threads, Send Messages in Threads and Embed Links), installing PostgreSQL and creating the databases, and hosting. Ask for what you need through `.env`; never ask for secrets in chat.
