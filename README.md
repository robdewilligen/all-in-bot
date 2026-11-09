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
