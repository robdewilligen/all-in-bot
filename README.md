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

_To be written._

## Commands

| Command | What it does |
| --- | --- |
| `/dailygift` | Claim today's coins |
| `/balance` | Balance and leaderboard position |
| `/leaderboard` | Players with the most coins in this server |
| `/roulette` | Place bets on the next spin of a shared roulette table |
| `/blackjack` | Take a seat at a shared blackjack table |
| `/spin` | Slot machine |
| `/help` | Rules, notation and payouts |

## Windows setup

One command prepares a Windows PC: the database host (a PC that runs PostgreSQL in Docker, and later the bot) or a development PC. It's plain Windows PowerShell 5.1, so it needs nothing that a fresh Windows 10 or 11 doesn't have. Design and rules: [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md).

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
   - Database host: starts Docker Desktop when needed, keeps passwords and backups in `C:\all-in-db` (outside the repo), runs PostgreSQL 18 as the Docker project `all-in-db`, creates the roles `allin` and `allin_dev` and the databases `allin`, `allin_dev` and `allin_test`, installs the npm packages, runs the migrations, and schedules a backup of `allin` every night at 03:30 (kept 14 days).
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
| `npm run db:restore` | Restore a dump; asks you to type the database name to confirm |
| `npm run check:setup` | PSScriptAnalyzer and Pester for the setup scripts |

### After the first run (database host)

- Give the PC a fixed IP address in your router: a DHCP reservation for the MAC address in the summary.
- Docker Desktop, Settings > General: turn on "Start Docker Desktop when you sign in".
- Optional: automatic sign-in. Docker Desktop, and so the database, only runs while you're signed in; automatic sign-in keeps it running after a power cut, but anyone with access to the PC then gets your desktop.

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

## Development

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run the bot with reload |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled bot |
| `npm run deploy:commands` | Register slash commands |
| `npm run db:generate` / `npm run db:migrate` | Generate a migration / apply migrations |
| `npm run check` | Typecheck, lint, format check and tests, the same as CI |

## Architecture

_To be written._

## Adding a game

_To be written._

## Deployment

_To be written._
