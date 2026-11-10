# All-in

All-in is a Discord bot with casino games (roulette, blackjack and a slot machine) played with virtual coins that have no real-world value. Roulette and blackjack are shared tables where players in a server play together; slots are played alone. Players top up their balance with a daily gift, and a leaderboard per server shows who has the most coins. Everything users see is in English, so the bot works in international servers. Package name: `all-in`.

`docs/SPEC.md` is the source of truth for behaviour, rules and numbers. Read the relevant section before you start on a feature. If the spec is unclear or looks wrong, ask instead of silently deviating.

## Stack

- Node.js 26 LTS, TypeScript (strict, ESM, `module` and `moduleResolution` set to `NodeNext`)
- discord.js 14, latest stable. v15 is a dev pre-release: don't use it.
- PostgreSQL via Drizzle ORM and node-postgres (`pg`); SQL migrations generated with drizzle-kit and committed
- zod for environment validation, pino for logging
- Vitest, ESLint (flat config with typescript-eslint type-checked rules), Prettier, tsx for development
- TypeScript stays on 6.0.x until typescript-eslint supports TypeScript 7. Check with `npm view typescript-eslint peerDependencies` before changing this.
- Check versions with `npm view <package>` before installing anything; don't rely on memory.

## Scripts

Keep this table in sync with package.json.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run the bot with reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled bot |
| `npm run deploy:commands` | Register slash commands: in `DEV_GUILD_ID` when set, otherwise globally |
| `npm run db:generate` / `npm run db:migrate` | Generate a migration from the schema / apply migrations |
| `npm run typecheck` / `lint` / `format` / `test` | The usual |
| `npm run check` | typecheck + lint + format check + tests, the same as CI |
| `npm run sim:blackjack` / `npm run rtp:slots` | Verification scripts (see the spec) |
| `npm run setup` / `setup:check` | Windows setup (`docs/WINDOWS-SETUP.md`): prepare this PC / report only. Options after `--`, e.g. `npm run setup -- -Dev` |
| `npm run setup:install` / `setup:init` | Only the software part (asks for administrator rights) / only the project part |
| `npm run check:setup` | PSScriptAnalyzer and Pester for `scripts/setup/`, in Windows PowerShell 5.1 (also a CI job) |
| `npm run db:status` / `db:logs` / `db:psql` / `db:backup` / `db:restore` | Database host: container status, logs, a psql shell, a backup now, restore a dump |

## Layout

```
src/
  index.ts             bootstrap: config, database, client, loaders, startup refunds, login, shutdown
  deploy-commands.ts   registers slash commands through REST
  config/              env schema (zod) and game/economy settings
  db/                  Drizzle schema, pg Pool, migrator
  core/                wallet (all money), amount parser, RNG, time helpers, errors
  games/               pure game engines: roulette, blackjack, slots
  bot/                 discord.js glue: loaders, cooldowns, error replies, shared options, tables (registry, threads, refunds, roulette, blackjack)
  commands/<group>/    one slash command per file (default export)
  events/              one client event per file (default export)
  ui/                  embeds and buttons per game
  i18n/                every user-facing string
test/                  unit and integration tests
scripts/               simulation and RTP scripts
  setup/               Windows setup: setup.ps1, install.ps1 (admin), init.ps1, db.ps1, AllIn.Setup.psm1, tests/ (Pester)
drizzle/               generated SQL migrations (committed)
deploy/database/       compose.yaml for PostgreSQL 18 on the database host
setup.cmd              Windows setup entry point, starts scripts/setup/setup.ps1
```

Boundaries:

- `games/` never imports discord.js, the database or config. Engines receive an RNG or draw function and return plain data.
- Only `core/wallet` changes balances.
- discord.js is only used in `bot/`, `commands/`, `events/`, `ui/` and the two entry files.
- No user-facing strings outside `i18n/`.

## Money rules (never break these)

- Coins are whole numbers stored as `bigint`. No floats anywhere near money; payouts round down.
- Every coin movement runs in one database transaction and appends a ledger entry with the resulting balance.
- Debits are conditional and atomic (`UPDATE … SET balance = balance - $stake WHERE … AND balance >= $stake`), so concurrent commands can't overspend. A CHECK constraint keeps balances at 0 or above.
- A round is settled in the database before any reply or animation shows its result.
- Table rounds (roulette, blackjack) stay `open` until settled, and one shared outcome settles every player at the table in one transaction. Open rounds are refunded at startup.
- Daily claims are idempotent: a unique key on (guild, user, day) decides.
- Coins have no real-world value: no buying coins, no transfers between players, no shop, no prizes. Don't add features that change this.

## discord.js conventions

- Structure as in the official discord.js guide: command files export `{ data, execute, autocomplete?, cooldown? }`, event files export `{ name, once?, execute }`, and both are loaded dynamically. Commands live in `client.commands` (a `Collection`), typed through module augmentation.
- Intents: `Guilds` only. No privileged intents, no message content.
- Acknowledge every interaction within 3 seconds; use `deferReply` when work might take longer. Ephemeral replies use `flags: MessageFlags.Ephemeral`.
- Current APIs only: `withResponse: true` instead of `fetchReply`, `Events.ClientReady`, and `setContexts(InteractionContextType.Guild)` plus `setIntegrationTypes(ApplicationIntegrationType.GuildInstall)` instead of `setDMPermission`.
- Every table is a public thread (`src/bot/tables/table.ts`) that hosts one game at a time and shows a lobby between games. A game's table message is an ordinary bot message in that thread, so it outlives the 15-minute interaction token. With only the Guilds intent the bot hears of no message deletes, so a table learns it is lost from a failed edit (`isLostTableError`). A component collector on the table message handles the buttons, with phase timers (betting, turns) instead of one idle timeout, and each table handles one action at a time. Only the player whose seat or turn it is can act; anyone else gets an ephemeral notice. Catch errors inside collector callbacks.
- One shared error helper: player errors are ephemeral and specific, unexpected errors are logged and get a generic message (`followUp` when the interaction was already replied to or deferred).
- A `followUp` straight after a public `deferReply` replaces the loading message and ignores the Ephemeral flag, so an error would show publicly. A command that defers and can still throw a `PlayerError` defers ephemerally or validates first.
- Log Discord errors through `loggableError()` (`src/bot/errors.ts`): REST errors carry the request URL, and interaction routes put the token in it.
- Client options include `allowedMentions: { parse: [] }`. Listen to the client `error` event and log `unhandledRejection`.
- Slash commands are registered by the deploy script only, never on startup.
- Command and option names: English, lowercase, at most 32 characters.

## Code style

- Strict TypeScript: no `any`, no `@ts-ignore`, non-null assertions only when the reason is obvious.
- No floating promises: `no-floating-promises` and `no-misused-promises` are errors, and event listeners never return a rejected promise.
- Small modules, explicit return types on exported functions, comments that explain why rather than what.
- Adding a dependency? Say why, and check its current version first.

## Testing

- Engines: unit tests with seeded RNGs and stacked decks.
- Wallet and database: integration tests against `TEST_DATABASE_URL` only, never the dev or production database. Truncate between tests.
- Vitest has two projects: `db` (`test/db/`, migrated once by `test/db/global-setup.ts`, files run one at a time) and `unit` (everything else, no database). `vitest.config.ts` passes only `TEST_DATABASE_URL` on to the tests, and `test/db/helpers.ts` refuses a database whose name doesn't end in `_test`.
- Discord layer: tests with fake interactions, no network; the fakes are in `test/helpers/` (`fakeChatInput` and friends, `fakeContext` with a mock wallet).
- A task is done when `npm run check` passes.
- Changes in `scripts/setup/` or `setup.cmd` also need `npm run check:setup`. Those scripts target Windows PowerShell 5.1; the rules are in `docs/WINDOWS-SETUP.md` ("Rules for both scripts").

## Workflow

- Follow the phases in `docs/SPEC.md` §13. Start each phase with a short plan; end it with `npm run check`, a summary and a commit (Conventional Commits). Wait for my go before starting the next phase.
- Never print, log or commit secrets. Don't open `.env`; `.env.example` documents every variable.
- Destructive database commands (drop, truncate, reset) run only against the test database.
- Anything outside the repo (Discord Developer Portal, PostgreSQL server, hosting) is done by me. Tell me what you need instead of trying to do it.
