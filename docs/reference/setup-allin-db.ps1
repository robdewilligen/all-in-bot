#Requires -Version 5.1
<#
.SYNOPSIS
    Zet PostgreSQL 18 in Docker op voor All-in: de databases allin, allin_dev en allin_test.

.DESCRIPTION
    Draai dit script in PowerShell als administrator op de pc die de databases host.
    Je kunt het veilig meerdere keren draaien: wat al bestaat, blijft staan.

    Eerste keer:  installeert WSL en Docker Desktop. Herstart daarna de pc, start Docker Desktop,
                  accepteer de voorwaarden en draai het script opnieuw.
    Tweede keer:  zet slaapstand en firewall goed, start PostgreSQL in Docker, maakt rollen en
                  databases aan, plant een nachtelijke back-up en toont de verbindingsregels
                  voor de .env op je dev-pc.

.EXAMPLE
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    .\setup-allin-db.ps1
#>
[CmdletBinding()]
param(
    # Map voor compose.yaml, .env (met de wachtwoorden), backup.ps1 en de back-ups.
    [string]$InstallPath = 'C:\all-in-db',

    # Poort waarop PostgreSQL in je netwerk bereikbaar is.
    [ValidateRange(1, 65535)]
    [int]$Port = 5432
)

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-TextFile([string]$Path, [string]$Content) {
    # UTF-8 zonder BOM, LF-regeleinden en een slotregel, zodat Docker de bestanden goed leest.
    $text = $Content -replace "`r`n", "`n"
    if (-not $text.EndsWith("`n")) { $text += "`n" }
    [System.IO.File]::WriteAllText($Path, $text)
}

function New-Password {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    # Alleen letters en cijfers: dan hoeft er in een verbindings-URL niets ge-encodeerd te worden.
    return ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '')
}

function Read-EnvFile([string]$Path) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Z_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
    }
    return $values
}

function Invoke-Psql([string]$Sql, [string]$Description) {
    # Draait als superuser via de socket in de container; het wachtwoord is daar niet nodig.
    $output = docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAc $Sql
    if ($LASTEXITCODE -ne 0) { throw "psql is mislukt bij: $Description" }
    return ("$output").Trim()
}

try {
    # --- 0. Administrator? ------------------------------------------------------------
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Warning 'Start PowerShell als administrator (rechtermuisknop > Als administrator uitvoeren) en draai het script opnieuw.'
        exit 1
    }

    # --- 1. WSL en Docker Desktop -----------------------------------------------------
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Step 'Docker Desktop is nog niet geinstalleerd'
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            Write-Warning 'winget ontbreekt. Installeer of update "App Installer" via de Microsoft Store en draai het script opnieuw.'
            exit 1
        }

        Write-Step 'WSL installeren (zonder Linux-distributie; Docker Desktop heeft alleen WSL 2 nodig)'
        wsl --install --no-distribution

        Write-Step 'Docker Desktop installeren'
        winget install --id Docker.DockerDesktop --exact --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "winget stopte met foutcode $LASTEXITCODE; zie de melding hierboven."
            exit 1
        }

        Write-Host ''
        Write-Host 'Installatie klaar. Volgende stappen:' -ForegroundColor Green
        Write-Host '  1. Herstart de pc.'
        Write-Host '  2. Start Docker Desktop, accepteer de voorwaarden en wacht tot er "Engine running" staat.'
        Write-Host '     Inloggen met een Docker-account is niet nodig.'
        Write-Host '  3. Zet in Docker Desktop bij Settings > General "Start Docker Desktop when you sign in" aan.'
        Write-Host '  4. Draai dit script opnieuw als administrator.'
        exit 0
    }

    # --- 2. Draait de Docker-engine? --------------------------------------------------
    $null = docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Docker is geinstalleerd, maar de engine draait niet. Start Docker Desktop, wacht op "Engine running" en draai het script opnieuw.'
        exit 1
    }

    # --- 3. Slaapstand ----------------------------------------------------------------
    Write-Step 'Slaapstand op netstroom uitzetten, zodat de database bereikbaar blijft'
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0

    # --- 4. Netwerkprofiel en firewall ------------------------------------------------
    Write-Step "Firewallregel voor poort $Port (alleen je eigen netwerk)"
    $publicConnections = @(Get-NetConnectionProfile | Where-Object { "$($_.NetworkCategory)" -eq 'Public' })
    if ($publicConnections.Count -gt 0) {
        Write-Warning 'Een netwerkverbinding staat op "Openbaar". Dan blokkeert Windows de database voor andere pcs.'
        Write-Warning 'Zet je thuisnetwerk op "Prive" met:'
        foreach ($connection in $publicConnections) {
            Write-Host "    Set-NetConnectionProfile -InterfaceIndex $($connection.InterfaceIndex) -NetworkCategory Private"
        }
    }

    $ruleName = "All-in PostgreSQL (poort $Port, eigen netwerk)"
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
        Write-Host '    Regel bestaat al.'
    }
    else {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port `
            -RemoteAddress LocalSubnet -Profile Private -Action Allow -ErrorAction Stop | Out-Null
        Write-Host '    Regel aangemaakt.'
    }

    # --- 5. Bestanden -----------------------------------------------------------------
    Write-Step "Bestanden in $InstallPath"
    $backupPath = Join-Path $InstallPath 'backups'
    New-Item -ItemType Directory -Force -Path $InstallPath, $backupPath -ErrorAction Stop | Out-Null

    $envFile = Join-Path $InstallPath '.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
        $envLines = @(
            '# Gemaakt door setup-allin-db.ps1. Bewaar dit bestand goed en deel het niet.',
            '# PostgreSQL gebruikt deze wachtwoorden alleen bij het aanmaken; later wijzigen gaat met ALTER ROLE.',
            "POSTGRES_PASSWORD=$(New-Password)",
            "ALLIN_PASSWORD=$(New-Password)",
            "ALLIN_DEV_PASSWORD=$(New-Password)",
            ''
        )
        Write-TextFile $envFile ($envLines -join "`n")
        Write-Host '    .env met nieuwe wachtwoorden aangemaakt.'
    }
    $secrets = Read-EnvFile $envFile
    foreach ($key in 'POSTGRES_PASSWORD', 'ALLIN_PASSWORD', 'ALLIN_DEV_PASSWORD') {
        if (-not $secrets[$key]) { throw "$key ontbreekt in $envFile." }
    }

    $composeFile = Join-Path $InstallPath 'compose.yaml'
    if (-not (Test-Path -LiteralPath $composeFile)) {
        $compose = @'
name: all-in-db

services:
  postgres:
    image: postgres:18
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    ports:
      - "__PORT__:5432"
    volumes:
      # Vanaf PostgreSQL 18 hoort het datavolume op /var/lib/postgresql (niet meer op /data).
      - pgdata:/var/lib/postgresql
      - ./backups:/backups
    healthcheck:
      # Via TCP, zodat de container pas gezond is als de echte server luistert.
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 30

volumes:
  pgdata:
'@
        Write-TextFile $composeFile $compose.Replace('__PORT__', "$Port")
        Write-Host '    compose.yaml aangemaakt.'
    }

    $backupScript = Join-Path $InstallPath 'backup.ps1'
    if (-not (Test-Path -LiteralPath $backupScript)) {
        $backup = @'
# Back-up van de productiedatabase allin naar de map backups; bewaart 14 dagen.
Set-Location -LiteralPath $PSScriptRoot
$file = 'allin-{0:yyyy-MM-dd}.dump' -f (Get-Date)
docker compose exec -T postgres pg_dump -U postgres -Fc -f "/backups/$file" allin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'backups') -Filter 'allin-*.dump' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item
'@
        Write-TextFile $backupScript $backup
        Write-Host '    backup.ps1 aangemaakt.'
    }

    # --- 6. PostgreSQL starten, rollen en databases -----------------------------------
    Write-Step 'PostgreSQL 18 starten (de eerste keer wordt het image gedownload)'
    Push-Location -LiteralPath $InstallPath
    try {
        docker compose up -d --wait
        if ($LASTEXITCODE -ne 0) { throw 'docker compose up is mislukt; zie de melding hierboven.' }

        Write-Step 'Rollen en databases'
        # allin_dev is van je dev-pc en de tests, allin van de bot in productie.
        $roles = @(
            @{ Name = 'allin'; Password = $secrets['ALLIN_PASSWORD'] },
            @{ Name = 'allin_dev'; Password = $secrets['ALLIN_DEV_PASSWORD'] }
        )
        foreach ($role in $roles) {
            $exists = Invoke-Psql "SELECT 1 FROM pg_roles WHERE rolname = '$($role.Name)'" "rol $($role.Name) controleren"
            if ($exists -ne '1') {
                Invoke-Psql "CREATE ROLE $($role.Name) LOGIN PASSWORD '$($role.Password)'" "rol $($role.Name) aanmaken" | Out-Null
                Write-Host "    Rol $($role.Name) aangemaakt."
            }
        }

        $databases = @(
            @{ Name = 'allin'; Owner = 'allin' },
            @{ Name = 'allin_dev'; Owner = 'allin_dev' },
            @{ Name = 'allin_test'; Owner = 'allin_dev' }
        )
        foreach ($database in $databases) {
            $exists = Invoke-Psql "SELECT 1 FROM pg_database WHERE datname = '$($database.Name)'" "database $($database.Name) controleren"
            if ($exists -ne '1') {
                Invoke-Psql "CREATE DATABASE $($database.Name) OWNER $($database.Owner)" "database $($database.Name) aanmaken" | Out-Null
                Write-Host "    Database $($database.Name) aangemaakt (eigenaar $($database.Owner))."
            }
            # Alleen de eigenaar mag verbinden; zo kan je dev-pc nooit bij de productiedatabase.
            Invoke-Psql "REVOKE CONNECT ON DATABASE $($database.Name) FROM PUBLIC" "rechten op $($database.Name)" | Out-Null
        }
    }
    finally {
        Pop-Location
    }

    # --- 7. Nachtelijke back-up -------------------------------------------------------
    Write-Step 'Nachtelijke back-up van allin plannen (03:30, 14 dagen bewaren)'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`""
    $trigger = New-ScheduledTaskTrigger -Daily -At '03:30'
    Register-ScheduledTask -TaskName 'All-in database backup' -Action $action -Trigger $trigger -Force `
        -Description "pg_dump van de All-in-productiedatabase naar $backupPath" -ErrorAction Stop | Out-Null

    # --- 8. Overzicht -----------------------------------------------------------------
    $ip = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|Docker' } |
        Select-Object -First 1 -ExpandProperty IPAddress
    if (-not $ip) { $ip = '<ip-van-deze-pc>' }
    $devPassword = $secrets['ALLIN_DEV_PASSWORD']
    $prodPassword = $secrets['ALLIN_PASSWORD']

    Write-Host ''
    Write-Host 'Klaar: PostgreSQL draait.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Zet dit in de .env van All-in op je dev-pc:'
    Write-Host "  DATABASE_URL=postgresql://allin_dev:$devPassword@${ip}:$Port/allin_dev"
    Write-Host "  TEST_DATABASE_URL=postgresql://allin_dev:$devPassword@${ip}:$Port/allin_test"
    Write-Host ''
    Write-Host 'Later, voor de bot in productie op deze pc (vanuit een container):'
    Write-Host "  DATABASE_URL=postgresql://allin:$prodPassword@host.docker.internal:$Port/allin"
    Write-Host ''
    Write-Host "De wachtwoorden staan ook in $envFile."
    Write-Host "Test vanaf je dev-pc:  Test-NetConnection $ip -Port $Port"
    Write-Host 'Geef deze pc in je router een vast IP-adres (DHCP-reservering).'
}
catch {
    Write-Host ''
    Write-Host "Fout: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
