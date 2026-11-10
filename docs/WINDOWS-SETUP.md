# Windows setup

One command prepares a Windows PC for All-in. It must work without AI: plain PowerShell, with npm aliases once Node.js is installed. The main target is the second PC, which hosts PostgreSQL and the production bot in Docker. With `-Dev`, the same command prepares a development PC, without Docker or PostgreSQL.

## Usage

On a fresh PC:

```powershell
winget install --id Git.Git --exact
git clone https://github.com/<user>/all-in.git C:\src\all-in
cd C:\src\all-in
.\setup.cmd          # database host (the second PC)
.\setup.cmd -Dev     # development PC
```

Later runs, for example after `git pull`: `.\setup.cmd` again, or `npm run setup`. `npm run setup:check` reports the status without changing anything.

## Files

| Path | Purpose |
| --- | --- |
| `setup.cmd` | The one command. Starts `scripts/setup/setup.ps1` with `-ExecutionPolicy Bypass`, so the machine's execution policy stays untouched. Works from a terminal and by double-click (then keep the window open at the end). |
| `scripts/setup/setup.ps1` | Orchestrator: runs `install.ps1` elevated, then `init.ps1` as the normal user, then prints a summary. |
| `scripts/setup/install.ps1` | Script 1: checks and installs software and machine settings (administrator). |
| `scripts/setup/init.ps1` | Script 2: initializes the project: database container, roles, databases, packages, migrations, backups and the production bot (normal user). |
| `scripts/setup/AllIn.Setup.psm1` | Shared helpers, unit tested. |
| `scripts/setup/tests/` | Pester tests. |
| `deploy/database/compose.yaml` | The PostgreSQL service. |
| `deploy/compose.yaml`, `deploy/Dockerfile` | The production bot (step 9). |
| `docs/reference/setup-allin-db.ps1` | The stand-alone predecessor; see "Reference script" below. |

npm aliases: `setup`, `setup:install`, `setup:init` and `setup:check`, plus `db:status`, `db:logs`, `db:psql`, `db:backup` and `db:restore` for the database host.

## Exit codes

`install.ps1` and `setup.ps1` return 0 when ready, 1 on an error, 2 when the user has to act (the message says what to do) and 3010 when a reboot is required.

## Script 1: install.ps1 (administrator)

Check every item first, install only what's missing, and print one status line per item (`OK`, `INSTALLED`, `ACTION` or `FAILED`).

- Windows 10 build 19041 or later, or Windows 11, 64-bit.
- Hardware virtualization: if no hypervisor is running and firmware virtualization is off, stop with BIOS/UEFI instructions (Intel VT-x, AMD SVM). A running hypervisor makes the firmware flag read as off, so check `HypervisorPresent` first.
- winget. When it's missing, explain how to get App Installer from the Microsoft Store.
- Git (`Git.Git`) and Node.js LTS (`OpenJS.NodeJS.LTS`). Upgrade Node.js when its major version is below the one in `.nvmrc`.
- Database host only:
  - WSL 2 without a Linux distribution (`wsl --install --no-distribution`, then `wsl --update`).
  - Docker Desktop (`Docker.DockerDesktop`) with the WSL 2 backend. Check the installer's current command-line options for accepting the license unattended (passed through `winget --override`). If that isn't reliable, guide the user through the first start instead.
  - No sleep on AC power.
  - An inbound firewall rule for the PostgreSQL port: TCP, `RemoteAddress LocalSubnet`, Private profile only.
  - Networks on the Public profile: explain why that blocks the database and offer to switch them to Private (ask first).
- After installing, reload PATH from the registry (machine and user), so the rest of the run works without a new terminal.
- When an install needs a reboot, exit with 3010. `setup.ps1` then offers to restart right away and registers a one-time resume (HKCU RunOnce) that starts `setup.cmd` again after sign-in.
- `-CheckOnly` reports and changes nothing. `-Dev` handles only Git and Node.js.

## Script 2: init.ps1 (normal user)

### Database host (default)

1. Run `install.ps1 -CheckOnly`. When anything is missing, stop and point to `setup.cmd`.
2. If the Docker engine isn't running, start Docker Desktop and wait up to 5 minutes for `docker info`. Explain what to check when it doesn't come up.
3. Use a data directory outside the repo (`-DataDir`, default `C:\all-in-db`), so deleting or re-cloning the repo never loses secrets or backups. It holds:
   - `.env` with `POSTGRES_PASSWORD`, `ALLIN_PASSWORD` and `ALLIN_DEV_PASSWORD`. Generate missing values (cryptographic RNG, at least 30 letters and digits) and never overwrite existing ones. Restrict the file to the current user, Administrators and SYSTEM.
   - `backups\` for the nightly dumps.
4. Start PostgreSQL from `deploy/database/compose.yaml`:
   - fixed project name `all-in-db`, so the named volume `all-in-db_pgdata` survives a re-clone or a different repo path;
   - image `postgres:18`. Pin the major version and never use `latest`: a major upgrade needs a dump and restore.
   - data volume at `/var/lib/postgresql` (the layout from PostgreSQL 18 on);
   - the port published for the LAN (`-Port`, default 5432), with a clear message when it's already taken;
   - `restart: unless-stopped`;
   - healthcheck `pg_isready -h 127.0.0.1`. Checking over TCP keeps the container from being reported healthy while initdb's temporary server runs.
   - `<DataDir>\backups` mounted at `/backups`;
   - start with `docker compose up -d --wait`.
5. Create roles and databases idempotently, as superuser through the container's socket:
   - roles `allin` and `allin_dev`, with LOGIN and the passwords from the data `.env`;
   - databases `allin` (owner `allin`), and `allin_dev` and `allin_test` (owner `allin_dev`);
   - `REVOKE CONNECT ... FROM PUBLIC` on all three, so each role can only reach its own databases.
6. Run `npm ci` when `node_modules` is missing or `package-lock.json` changed since the last successful run.
7. Migrations: run `npm run db:migrate` against `allin_dev` and `allin_test` (as `allin_dev`), and against `allin` (as `allin`) only when `deploy/compose.yaml` doesn't exist. With it, the bot container migrates `allin` when it starts (step 9), after compose has stopped the old bot, so the old bot never runs on a newer schema. Set `DATABASE_URL` for that child process only, on `localhost`. Before migrations exist, skip this step with a notice.
8. Nightly backup: copy a backup script into the data directory and register a scheduled task that runs daily at 03:30. It runs `pg_dump -Fc` for `allin` inside the container, writes to `/backups` and deletes dumps older than 14 days. Write the dump inside the container (`pg_dump -f`); never pipe a binary dump through PowerShell.
9. The production bot from `deploy/compose.yaml` (project `all-in`, service `bot`, image `all-in-bot`), with one status line per part. Every `docker compose` call gets `ALLIN_BOT_ENV_FILE` (the path of `bot.env`, in forward slashes) for that child process only, and an empty stdin, so docker never waits for input.
   - **bot.env.** When `<DataDir>\bot.env` is missing, create it from `.env.example` and restrict it like `.env` before any secret goes in. `DATABASE_URL` points to the database `allin` as role `allin` through `host.docker.internal` on `-Port`, with the `ALLIN_PASSWORD` of the data `.env` percent-encoded. The production bot token comes from a hidden prompt and the application ID from a prompt; an answer that isn't a bot token (three dot-separated parts) or an application ID (17 to 20 digits) isn't saved. `DEV_GUILD_ID` and `TEST_DATABASE_URL` stay empty, so commands are registered globally, and no example value of the template survives. In an existing `bot.env` only empty or absent values are filled in, never an existing one. With `-NonInteractive`, write what's known and stop (`ACTION`) with the keys to fill in.
   - **Bot image.** `docker compose build bot`, with `BUILDX_NO_DEFAULT_ATTESTATIONS=1` for that child process only. Attestations hold build timestamps, so without them an unchanged checkout keeps its image id and the bot isn't restarted. `deploy/compose.yaml` also sets `provenance: false` and `sbom: false` (which needs Compose v2.39 or later), but Compose before v5.5.1 ignores them; the variable works on every version. `OK` when the image id of `all-in-bot` didn't change, `INSTALLED` when the build made a new one.
   - **Slash commands.** Print the definitions from inside the new image (`docker compose run --rm -T bot node dist/deploy-commands.js --print`, which needs no token) and hash them with SHA-256, together with `DISCORD_CLIENT_ID` and `DEV_GUILD_ID`. Register them (the same command without `--print`) only when that hash differs from `botCommandsHash` in the state file, and save the hash after a successful registration.
   - **Bot container.** `docker compose up --detach --wait --wait-timeout 180`, which recreates the container on a new image and returns once its healthcheck sees the bot logged in to Discord. The container migrates `allin` before it starts the bot; step 7 leaves `allin` to it.
   - The Docker parts need the Docker engine, a complete `bot.env` and the roles and databases (step 5); otherwise they're `SKIPPED` with the reason. A failed migration of `allin_dev` or `allin_test` (step 7) or a failed `npm ci` (step 6) doesn't hold back the bot. A failed build or registration leaves the running bot alone. When the bot doesn't come online, the line under its status gives the command for its log: `docker logs --tail 100 all-in-bot-1`.
   - `-CheckOnly` reports whether `bot.env` is complete and private and whether the bot container runs and is healthy; it doesn't build or register.
10. Summary:
    - the status of every step;
    - the PC's LAN IPv4 and MAC address, for a DHCP reservation;
    - the two lines for the dev PC's `.env`: `DATABASE_URL` and `TEST_DATABASE_URL`, both as `allin_dev`;
    - the remaining manual actions: the router reservation, Docker Desktop's "Start when you sign in", and optional automatic sign-in with its trade-off.

### Development PC (`-Dev`)

1. Run `npm ci`.
2. When `.env` is missing, create it from `.env.example` and ask for the database host, the `allin_dev` password and the Discord dev values. With `-NonInteractive`, leave placeholders instead.
3. Check that the database host answers on its port.
4. When it does, run `npm run db:migrate` on `allin_dev`.

## Rules for both scripts

- **Idempotent and resumable.** Check before every change, so the scripts are safe to run any number of times. No destructive actions: they never drop data, delete databases or overwrite secrets. (`db:restore` is separate and asks for the database name as confirmation. For `allin` it stops a running bot container during the restore and starts it again afterwards, also when the restore fails, so the bot never works on a database that changes under it, and its startup refund cleans up the rounds that were open in the dump.)
- **Guide instead of failing silently.** Whenever the user has to act (UAC, reboot, Docker Desktop's first start, BIOS, network profile), say exactly what to do and how to continue, then exit with the matching code.
- **Output.** Numbered steps, one status line per check, and a summary at the end. Colour helps, but the output must be readable without it.
- **Logs and state.** Write a transcript per run to `%LOCALAPPDATA%\all-in\logs`. Secrets never appear in output or logs; print the dev connection lines only after the transcript has stopped. Keep state between runs (hashes) in `%LOCALAPPDATA%\all-in\state.json`.
- **Elevation only where needed.** `install.ps1` runs elevated; `init.ps1`, npm and Docker run as the normal user.
- **`-NonInteractive`.** Never prompt; when input is needed, stop with instructions.
- **Windows PowerShell 5.1 compatible**, because that's what every Windows PC has:
  - no `&&`, `??`, ternaries, `-Parallel`, `Get-SecureRandom` or `Test-Connection -TcpPort`;
  - save scripts as ASCII or UTF-8 with BOM, because 5.1 reads BOM-less UTF-8 as ANSI;
  - `.gitattributes` keeps `*.ps1`, `*.psm1` and `*.cmd` on CRLF.
- **Native commands.** Check `$LASTEXITCODE` after each call. In 5.1, redirecting a native command's stderr while `$ErrorActionPreference` is `Stop` throws, so don't set Stop globally; use `-ErrorAction Stop` per cmdlet.
- **Files for Docker or Node** (`.env`, generated configs) are written as UTF-8 without BOM, with LF line endings.
- **No native npm dependencies that need build tools.** If one ever becomes necessary, `install.ps1` installs the prerequisites.

## Tests

- Shared logic lives in `AllIn.Setup.psm1` and has Pester 5 tests: password generation, reading and merging env files without overwriting, version comparison, connection strings, exit-code handling, the PATH refresh, and step 9: `bot.env`, the hash of the command definitions and the decisions of each part, with docker mocked. Also which databases step 7 migrates, the gate of step 9, and the bot stop and start around a restore of `allin`.
- PSScriptAnalyzer passes with the default rules. Suppress a rule only with a written justification.
- CI gets a `windows-latest` job that runs PSScriptAnalyzer and Pester (no Docker needed). Check whether the runner has both modules, and install them otherwise.
- The README contains a manual test checklist covering:
  - a fresh install;
  - a second run with nothing to do;
  - resuming after a reboot;
  - Docker Desktop stopped;
  - adopting an installation made by the reference script;
  - `-CheckOnly`;
  - `-Dev`.

## Reference script

`docs/reference/setup-allin-db.ps1` is the stand-alone predecessor. Its SQL for roles, databases and permissions was tested against a real PostgreSQL; the rest was syntax-checked but not run on Windows. It may already have been run on the second PC, so `init.ps1` must adopt such an installation without data loss:

- use the same data directory, the same keys in `C:\all-in-db\.env`, the same project name and volume, and the same roles and databases;
- rename its `C:\all-in-db\compose.yaml` to `compose.yaml.bak`;
- replace its scheduled task (same task name).

Reuse its tested parts: password generation, writing files as UTF-8 without BOM with LF, the idempotent role and database SQL, the firewall rule and the TCP healthcheck.

## Documentation

- README: a "Windows setup" section with the command, what it does, the manual actions, the exit codes and where the logs are.
- CLAUDE.md: add the setup scripts to the layout and the scripts table.