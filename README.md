# All-in

All-in is a Discord casino bot. Players get virtual coins from a daily gift and play roulette, blackjack and a slot machine. Roulette and blackjack are shared tables where players in a server play together; slots are played alone. A leaderboard per server shows who has the most coins.

> Work in progress: this README grows with each build phase (see `docs/SPEC.md` §13).

## Guardrails

All-in coins are play money. They have no real-world value, and that is by design:

- **Coins can't be bought.** No premium tier, donations or server-subscription perks that grant coins.
- **Coins can't be transferred, traded, sold or cashed out**, and there is no shop.
- **No real prizes** are tied to balances or leaderboard positions.

Server owners: please don't run giveaways or rewards based on All-in balances. That would turn play money into a prize with real-world value.

## Requirements

- Node.js 26 (see `.nvmrc`)
- PostgreSQL 18
- A Discord application with a bot user

## Setup

On Windows, `setup.cmd` does most of this for you (see [Windows setup](#windows-setup)).

1. **Configuration.** Copy `.env.example` to `.env` and fill it in. The bot checks every value at startup and exits with a message that names what's missing or invalid.

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `DISCORD_TOKEN` | yes | Bot token |
   | `DISCORD_CLIENT_ID` | yes | Application ID |
   | `DEV_GUILD_ID` | no | `deploy:commands` registers in this server only, which is instant |
   | `DATABASE_URL` | yes | `postgresql://user:password@host:5432/database` |
   | `TEST_DATABASE_URL` | tests only | A separate database that the tests wipe; its name must end in `_test` |
   | `DAILY_RESET_TIMEZONE` | no | When the daily gift resets; default `Europe/Amsterdam` |
   | `LOG_LEVEL` | no | Default `info` |

2. **Database.** `npm run db:migrate` brings the database in `DATABASE_URL` up to date. Each database belongs to exactly one bot process: at startup the bot refunds every open round it finds, which would hit another instance's live tables.
3. **Discord.** Invite the bot with the scopes `bot` and `applications.commands`, and the permissions View Channels, Create Public Threads, Send Messages in Threads and Embed Links. Every roulette and blackjack table is a thread, so the bot needs those four in each channel where tables open. It posts nothing in the channel itself, so it doesn't need Send Messages. Then `npm run deploy:commands` registers the slash commands: in `DEV_GUILD_ID` when it's set, otherwise globally.
4. **Run.** `npm run dev` for development, or `npm run build` and `npm start`.

Tests: `npm test` needs `TEST_DATABASE_URL`. `npm test -- --project unit` runs everything except the database tests.

## Commands

| Command | What it does |
| --- | --- |
| `/first-gift` | Claim a one-time head start of 1,000 coins in this server |
| `/dailygift` | Claim today's coins: 100, plus 10 for each day in a row (up to 170) |
| `/balance` | Balance and leaderboard position |
| `/leaderboard` | Players with the most coins in this server |
| `/roulette` | Place bets on the next spin of a shared roulette table |
| `/blackjack` | Take a seat at a shared blackjack table |
| `/spin` | Slot machine |
| `/create-table` | Open a table thread where the players pick a game |
| `/help` | Rules, notation and payouts |

Every table is its own thread, such as `Table #12 (Roulette)`, so the channel stays clean. `/roulette` and `/blackjack` find a table with room or open one. `/create-table` opens an empty table: its lobby has a button per game, which asks for your bet. After each game, the lobby comes back: play again, switch games, or leave. A table closes when its last player leaves, or after 10 minutes without a new game.

## Windows setup

One command prepares a Windows PC: the database host (a PC that runs PostgreSQL and the production bot in Docker) or a development PC. It's plain Windows PowerShell 5.1, so it needs nothing that a fresh Windows 10 or 11 doesn't have. Design and rules: [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md).

On a fresh PC, in a normal (non-administrator) PowerShell window:

```powershell
winget install --id Git.Git --exact
# open a new window, so git is on the PATH
git clone https://github.com/robdewilligen/all-in-bot.git C:\src\all-in
cd C:\src\all-in
.\setup.cmd          # database host
.\setup.cmd -Dev     # development PC
```

Run it again whenever you like, for example after `git pull`: it checks everything first and only changes what's missing. `npm run setup:check` (or `.\setup.cmd -CheckOnly`) reports the status without changing anything.

### What it does

1. **Software and Windows settings** (`install.ps1`). Checks Windows (database host: Windows 10 22H2 or Windows 11 23H2 or later), hardware virtualization, winget, Git and Node.js (at least the version in `.nvmrc`). On the database host also WSL 2, Docker Desktop, no sleep on AC power, and an inbound firewall rule for the PostgreSQL port (local subnet, Private networks only). When a network is set to Public, it asks whether to switch it to Private. Only when something is missing does Windows ask for administrator rights, once.
2. **The project** (`init.ps1`, as you).
   - Database host: starts Docker Desktop when needed, keeps passwords and backups in `C:\all-in-db` (outside the repo), runs PostgreSQL 18 as the Docker project `all-in-db`, creates the roles `allin` and `allin_dev` and the databases `allin`, `allin_dev` and `allin_test`, installs the npm packages, runs the migrations on `allin_dev` and `allin_test`, and schedules a backup of `allin` every night at 03:30 (kept 14 days). Then it builds and (re)starts the production bot, whose container migrates `allin` when it starts; see [Deployment](#deployment).
   - Development PC: installs the npm packages, creates `.env` (it asks for the database host, the `allin_dev` password and the Discord dev values), checks that the database host answers, and runs the migrations on `allin_dev`.
3. **Summary.** On the database host: the PC's IP and MAC address, and the two lines for the development PC's `.env`.

Options: `-Dev`, `-CheckOnly`, `-InstallOnly` (only part 1), `-NonInteractive` (never ask; stop with instructions instead), `-DataDir <path>` (default `C:\all-in-db`) and `-Port <n>` (default 5432). Through npm: `npm run setup -- -Dev`.

| Script | Purpose |
| --- | --- |
| `npm run setup` / `setup:check` | Prepare this PC / report only |
| `npm run setup:install` / `setup:init` | Only the software part / only the project part |
| `npm run db:status` | Container, health, databases, newest backup |
| `npm run db:logs` / `db:psql` | PostgreSQL logs / a psql shell as superuser |
| `npm run db:backup` | Make a backup now |
| `npm run db:restore` | Restore a dump; asks you to type the database name to confirm. For `allin` it stops the bot during the restore and starts it again afterwards |
| `npm run check:setup` | PSScriptAnalyzer and Pester for the setup scripts |

### After the first run (database host)

- Give the PC a fixed IP address in your router: a DHCP reservation for the MAC address in the summary.
- Docker Desktop, Settings > General: turn on "Start Docker Desktop when you sign in".
- Optional: automatic sign-in. Docker Desktop, and so the database and the bot, only runs while you're signed in; automatic sign-in keeps them running after a power cut, but anyone with access to the PC then gets your desktop.

### Restarts, exit codes and logs

When an installation needs a restart, setup offers to restart right away and continues by itself after you sign in again.

| Exit code | Meaning |
| --- | --- |
| 0 | Ready |
| 1 | Error: see the log |
| 2 | You need to act: the lines marked ACTION say what to do, then run setup again |
| 3010 | Restart Windows; setup continues after you sign in |

Logs: one file per script per run in `%LOCALAPPDATA%\all-in\logs`. Passwords never appear in them. State between runs (for example the package-lock hash) is in `%LOCALAPPDATA%\all-in\state.json`.

The database lives in the Docker volume `all-in-db_pgdata`, and the passwords in `C:\all-in-db\.env`. Deleting or re-cloning the repo loses neither. A PC prepared with the older `docs/reference/setup-allin-db.ps1` is adopted as is: same folder, passwords, volume and databases. Setup renames its `C:\all-in-db\compose.yaml` to `compose.yaml.bak` and replaces its backup script and scheduled task.

### Manual test checklist

Run on a real PC; send the logs from `%LOCALAPPDATA%\all-in\logs` when something fails.

- [ ] **Fresh install** (database host): `.\setup.cmd` asks for administrator rights once, installs what's missing, asks for a restart when WSL needs one, and after sign-in finishes by itself with exit code 0 and the two `.env` lines.
- [ ] **Second run**: `.\setup.cmd` shows only OK lines, no administrator prompt, exit code 0.
- [ ] **Resume after a restart**: answer No to "Restart now?", restart later; setup starts by itself after sign-in and continues.
- [ ] **Docker Desktop stopped**: quit Docker Desktop, run `.\setup.cmd`; it starts Docker Desktop and waits for the engine.
- [ ] **Adopting the reference script**: on a PC set up with `setup-allin-db.ps1`, `.\setup.cmd` keeps the data and passwords, renames `compose.yaml`, and `Get-ScheduledTask 'All-in database backup'` shows the new task.
- [ ] **`-CheckOnly`**: `.\setup.cmd -CheckOnly` changes nothing (no prompt, no new files) and reports every item.
- [ ] **`-Dev`**: on a development PC, `.\setup.cmd -Dev` installs Git and Node.js when missing, creates `.env` and runs the migrations on `allin_dev`.
- [ ] **The bot** (database host): the first `.\setup.cmd` asks for the production token and Application ID and ends with the bot online; a second run shows only OK; after a `git pull` with code changes, the run rebuilds the image and restarts the bot.
- [ ] **Restore with the bot online** (database host): `npm run db:restore` for `allin` says before the confirmation that it stops the bot, ends with `Started the bot again`, and `docker ps` shows `all-in-bot-1` running.
- [ ] **Tables in threads** (Discord):
  - `/create-table` opens `Table #N` with a lobby and posts nothing in the channel;
  - Roulette in the lobby asks for bets, and after the spin the lobby returns;
  - choosing Blackjack renames the thread to `Table #N (Blackjack)`;
  - Leave table from the last player archives the thread;
  - `/roulette` in a channel opens `Table #N+1 (Roulette)`.

## Development

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run the bot with reload |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled bot |
| `npm run deploy:commands` | Register slash commands |
| `npm run db:generate` / `npm run db:migrate` | Generate a migration / apply migrations |
| `npm run check` | Typecheck, lint, format check and tests, the same as CI |

## Architecture

```
src/
  index.ts            startup: config → database → Discord client → loaders → refunds → login
  config/             .env schema (zod) and the game settings
  core/               wallet (every coin movement), amounts, daily reset, errors, logger
  db/                 Drizzle schema, connection pool, migrations
  games/              pure engines: roulette, blackjack, slots (no Discord, no database)
  bot/                Discord glue: loaders, error replies, cooldowns, shutdown, tables
  commands/<group>/   one slash command per file
  events/             one client event per file
  ui/                 embeds and buttons
  i18n/               every text a player sees
```

- **Money.** Only `src/core/wallet.ts` changes balances. Every coin movement is one database transaction that also appends a ledger entry with the resulting balance. Debits are conditional (`… WHERE balance >= stake`), so two commands at once can't overspend, a CHECK constraint keeps balances at 0 or above, and a trigger keeps the ledger append-only.
- **Shared tables.** A table is a thread (`src/bot/tables/table.ts`) that hosts one game at a time and shows a lobby between games; its number comes from `guild_table_counters`. A game (`roulette-table.ts`, `blackjack-table.ts`) is an ordinary message in that thread.
  - The table registry (`src/bot/tables/registry.ts`) keeps tables and games in memory per server. It seats each player at one game per game type per server, only in channels the player can see, and runs seating one command at a time per server.
  - Every table and game handles one action at a time.
  - A player's stake is an open round in the database until the game's shared outcome settles everyone in one transaction. A failed refund is retried until it goes through (`refunds.ts`), and when the bot restarts, open rounds are refunded.
- **Engines** receive their settings and a draw function (backed by `crypto.randomInt`) as arguments and return plain data, so tests use fixed draws and stacked decks.
- **Texts** live in `src/i18n/en.ts` and are looked up with typed keys: a missing or misspelled key or placeholder is a compile error.

## Adding a game

1. Write the engine in `src/games/<game>/`: pure, settings and draw as arguments, tested with fixed draws.
2. Put its settings in `src/config/game.ts`.
3. Move coins only through the wallet: `playInstant` for a solo game such as slots, or a table round (`openTableRound`, `openRound` and `raiseRound`, then `settleTableRound`) for a shared table. A shared game is played at a table thread: export a `play<Game>` entry point the way `playRoulette` does, and add its button to the lobby.
4. Add the command in `src/commands/games/` (one default export), its embeds in `src/ui/`, its texts in `src/i18n/en.ts` and a topic in `/help`.
5. Run `npm run deploy:commands` to register it.

## Deployment

The production bot runs as a Docker container next to the database, on the database PC: Docker project `all-in`, image `all-in-bot`, container `all-in-bot-1`. Its settings are in `C:\all-in-db\bot.env`, outside the repo, so a re-clone keeps them.

### Updating the production bot

On the database PC, in a normal (non-administrator) PowerShell window, with the repo on `master`:

```powershell
cd C:\src\all-in
git pull
.\setup.cmd
```

Before the first run, create the production application in the Discord Developer Portal (separate from the one you develop with) and invite its bot as described in [Setup](#setup), step 3.

### What step 9 of setup.cmd does

One status line per part; the [Windows setup design](docs/WINDOWS-SETUP.md) has the details.

1. **bot.env.** The first time, it creates `C:\all-in-db\bot.env` from `.env.example`, readable only by you, Administrators and SYSTEM. It asks for the production bot token (hidden) and the application ID. `DATABASE_URL` points to the `allin` database through `host.docker.internal`, and `DEV_GUILD_ID` stays empty, so the commands are registered globally. Setup never overwrites a value: to change one, edit the file and run `.\setup.cmd` again.
2. **Bot image.** Builds `all-in-bot` from the checkout with `deploy/Dockerfile`, without build attestations (`BUILDX_NO_DEFAULT_ATTESTATIONS=1`, and `provenance: false` in `deploy/compose.yaml`): they hold timestamps, so without them an unchanged checkout keeps its image id and the bot keeps running.
3. **Slash commands.** Registers them globally, but only when their definitions changed since the last registration (setup keeps a hash in `%LOCALAPPDATA%\all-in\state.json`).
4. **Bot container.** Starts the bot, or restarts it on the new image, and waits until it's logged in to Discord (at most 3 minutes). The container migrates `allin` before the bot starts, after the old container has stopped, so the old bot never runs on a newer schema. Step 7 leaves `allin` alone for that reason.

Step 9 needs only the roles and databases of step 5: a failed migration of `allin_dev` or `allin_test` doesn't hold back the bot. A failed build or registration leaves the running bot alone. With `-NonInteractive` it never asks; when `bot.env` misses a value, it says which one to fill in. `.\setup.cmd -CheckOnly` reports whether `bot.env` is complete and the bot is online, without changing anything.

`npm run db:restore` of `allin` stops the bot during the restore and starts it again afterwards, also when the restore fails. On start, the bot refunds the rounds that were open in the dump.

### Logs

```powershell
docker logs --tail 100 all-in-bot-1
docker logs --follow all-in-bot-1
```

The log is JSON (pino), and Docker keeps at most 3 files of 10 MB. The bot starts with Docker Desktop. To stop it, run `docker stop all-in-bot-1`; it stays stopped until the next `.\setup.cmd`.

### Without Docker: systemd

`deploy/all-in.service` is an example unit for a Linux host with Node.js 26 and a reachable PostgreSQL 18: it runs the migrations, then the bot, as the user `allin`, and restarts it after a crash. Fill in `/etc/all-in/bot.env` like the `bot.env` above, with `DATABASE_URL` pointing to your database.

```sh
sudo useradd --system --home-dir /opt/all-in --shell /usr/sbin/nologin allin
sudo git clone https://github.com/robdewilligen/all-in-bot.git /opt/all-in
sudo chown -R allin:allin /opt/all-in
cd /opt/all-in
sudo -u allin npm ci
sudo -u allin npm run build
sudo install -d -m 750 -g allin /etc/all-in
sudo install -m 640 -g allin .env.example /etc/all-in/bot.env
sudoedit /etc/all-in/bot.env
sudo -u allin node --env-file=/etc/all-in/bot.env dist/deploy-commands.js
sudo cp deploy/all-in.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now all-in
journalctl -u all-in --follow
```

To update: `git pull`, `npm ci` and `npm run build` as `allin`, the `deploy-commands.js` line again when the commands changed, then `sudo systemctl restart all-in`.
