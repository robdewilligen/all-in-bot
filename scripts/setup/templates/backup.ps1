#Requires -Version 5.1
<#
.SYNOPSIS
    Dumps the All-in production database (allin) into the backups folder next to this script and deletes dumps
    older than 14 days. Exit code 0 on success, 1 on failure; the log is in %LOCALAPPDATA%\all-in\logs.
.DESCRIPTION
    scripts/setup/init.ps1 copies this script into the data directory and runs it daily through the scheduled task
    "All-in database backup". It needs no other file: run it by hand with "npm run db:backup" or directly.
#>
[CmdletBinding()]
param()

$projectName = 'all-in-db'
$serviceName = 'postgres'
$database = 'allin'
$retentionDays = 14
$backupDir = Join-Path $PSScriptRoot 'backups'
$logDir = Join-Path $env:LOCALAPPDATA 'all-in\logs'
$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Invoke-Docker {
    param(
        [Parameter(Mandatory)][string]$Docker,
        [Parameter(Mandatory)][string[]]$ArgumentList
    )
    # Native stderr arrives as error records through 2>&1; Continue keeps them from stopping the script.
    $ErrorActionPreference = 'Continue'
    $lines = @(& $Docker @ArgumentList 2>&1 | ForEach-Object { [string]$_ })
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $lines }
}

$exitCode = 1
$transcribing = $false
try {
    New-Item -ItemType Directory -Path $logDir -Force -ErrorAction Stop | Out-Null
    Start-Transcript -Path (Join-Path $logDir ('backup-{0}.log' -f (Get-Date).ToString('yyyyMMdd-HHmmss', $invariant))) -ErrorAction Stop | Out-Null
    $transcribing = $true

    $docker = Get-Command docker -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($docker) { $docker = $docker.Source }
    else { $docker = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe' }
    if (-not (Test-Path -LiteralPath $docker -PathType Leaf)) { throw 'Docker is not installed (no docker.exe found).' }

    $filter = @('--filter', "label=com.docker.compose.project=$projectName", '--filter', "label=com.docker.compose.service=$serviceName")
    $list = Invoke-Docker -Docker $docker -ArgumentList (@('ps', '-q') + $filter)
    if ($list.ExitCode -ne 0) { throw ('docker ps failed with exit code {0}; is Docker Desktop running? {1}' -f $list.ExitCode, ($list.Output -join ' ')) }
    $containerId = @($list.Output | Where-Object { $_ -match '^[0-9a-f]{12,64}$' }) | Select-Object -First 1
    if (-not $containerId) { throw 'The database container is not running.' }

    $file = 'allin-{0}.dump' -f (Get-Date).ToString('yyyy-MM-dd-HHmm', $invariant)
    Write-Output "Dumping $database into $backupDir\$file"
    # pg_dump writes the file inside the container, so the binary dump never passes through PowerShell.
    $dump = Invoke-Docker -Docker $docker -ArgumentList @('exec', $containerId, 'pg_dump', '-U', 'postgres', '-Fc', '-f', "/backups/$file", $database)
    foreach ($line in $dump.Output) { Write-Output "  $line" }
    if ($dump.ExitCode -ne 0) { throw "pg_dump failed with exit code $($dump.ExitCode)." }
    $dumpPath = Join-Path $backupDir $file
    if (-not (Test-Path -LiteralPath $dumpPath -PathType Leaf)) { throw "pg_dump succeeded, but $dumpPath does not exist; check the /backups mount." }

    $cutoff = (Get-Date).AddDays(-$retentionDays)
    $expired = @(Get-ChildItem -LiteralPath $backupDir -Filter 'allin-*.dump' -File -ErrorAction Stop | Where-Object { $_.LastWriteTime -lt $cutoff })
    foreach ($item in $expired) {
        Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
        Write-Output "Deleted $($item.Name) (older than $retentionDays days)"
    }
    Write-Output ('Backup OK: {0} ({1} bytes)' -f $file, (Get-Item -LiteralPath $dumpPath).Length)
    $exitCode = 0
}
catch {
    Write-Output "Backup FAILED: $($_.Exception.Message)"
}
finally {
    if ($transcribing) { Stop-Transcript | Out-Null }
}
exit $exitCode
