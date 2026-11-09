#Requires -Version 5.1
<#
.SYNOPSIS
    Everyday commands for the All-in database on the database PC: status, logs, psql, backup and restore.
.PARAMETER Action
    status: container, health, databases, newest dump and backup task. logs: the last 200 log lines.
    psql: an interactive psql session as superuser. backup: run the nightly backup now. restore: restore a dump.
.PARAMETER DataDir
    Data directory (.env, backup.ps1, backups). Default: the value init.ps1 saved, else C:\all-in-db.
.PARAMETER Port
    PostgreSQL port on the local network. Default: the value init.ps1 saved, else 5432.
.PARAMETER Database
    Database for psql and restore: allin, allin_dev or allin_test (psql also accepts postgres). Default: allin.
.PARAMETER File
    restore: name of the dump in the backups folder. Without it, restore lists the dumps and asks for a number.
.PARAMETER Follow
    logs: keep streaming new log lines until Ctrl+C.
.PARAMETER LogDir
    Folder for the transcript of backup and restore. Default: %LOCALAPPDATA%\all-in\logs.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('status', 'logs', 'psql', 'backup', 'restore')][string]$Action,
    [string]$DataDir,
    [ValidateRange(0, 65535)][int]$Port,
    [ValidatePattern('^[A-Za-z0-9_]+$')][string]$Database = 'allin',
    [string]$File,
    [switch]$Follow,
    [string]$LogDir
)

Import-Module (Join-Path $PSScriptRoot 'AllIn.Setup.psm1') -Force

function Format-Timestamp {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return 'unknown' }
    ([datetime]$Value).ToString('yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-DumpFile {
    Get-ChildItem -LiteralPath $backupDir -Filter 'allin-*.dump' -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending
}

function Get-ReadyContainerId {
    param([switch]$IncludeStopped)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Show-SetupStatus -Status ACTION -Message 'Docker is not installed on this PC (no docker command). These commands run on the database PC; set it up with setup.cmd.'
        return $null
    }
    $info = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('info', '--format', '{{.ServerVersion}}') -Capture
    if ($info.ExitCode -ne 0) {
        Show-SetupStatus -Status ACTION -Message 'The Docker engine is not running. Start Docker Desktop and wait for "Engine running", or run setup.cmd.'
        return $null
    }
    $id = Get-DatabaseContainerId -IncludeStopped:$IncludeStopped
    if ($id) { return $id }
    if (Get-DatabaseContainerId -IncludeStopped) {
        Show-SetupStatus -Status ACTION -Message 'The database container is stopped. Start it with setup.cmd (or npm run setup:init).'
    }
    else {
        Show-SetupStatus -Status ACTION -Message 'The database container does not exist yet. Create it with setup.cmd (or npm run setup:init).'
    }
    $null
}

function Invoke-StatusAction {
    $id = Get-ReadyContainerId -IncludeStopped
    if (-not $id) { return 2 }
    $format = '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}}'
    $inspect = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('inspect', '--format', $format, $id) -Capture
    $parts = ([string](@($inspect.Output) | Select-Object -First 1)).Split('/')
    if ($parts[0] -ne 'running') {
        Show-SetupStatus -Status ACTION -Message ('Container: {0}. Start it with setup.cmd (or npm run setup:init).' -f $parts[0])
        return 2
    }
    $exitCode = 0
    $health = 'unknown'
    if ($parts.Count -gt 1) { $health = $parts[1] }
    if ($health -eq 'healthy') { Show-SetupStatus -Status OK -Message "Container: running, healthy ($id)" }
    else { Show-SetupStatus -Status ACTION -Message "Container: running, $health ($id)"; $exitCode = 2 }

    $ready = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('exec', $id, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres') -Capture
    if ($ready.ExitCode -eq 0) { Show-SetupStatus -Status OK -Message 'pg_isready: accepting connections' }
    else { Show-SetupStatus -Status ACTION -Message ('pg_isready: {0}' -f (@($ready.Output) -join ' ')); $exitCode = 2 }

    if (Test-TcpPort -HostName '127.0.0.1' -Port $Port -TimeoutMilliseconds 2000) { Show-SetupStatus -Status OK -Message "Port $Port answers" }
    else { Show-SetupStatus -Status ACTION -Message "Port $Port doesn't answer on this PC; was the database started with another -Port?"; $exitCode = 2 }

    $names = ($layout.Databases | ForEach-Object { "'$($_.Name)'" }) -join ', '
    $sql = "SELECT datname || ' ' || pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname IN ($names) ORDER BY datname;"
    $sizes = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('exec', '-i', $id, 'psql', '-X', '-q', '-t', '-A', '-U', 'postgres', '-d', 'postgres') -InputText $sql -Capture
    if ($sizes.ExitCode -ne 0) {
        Show-SetupStatus -Status ACTION -Message ('Databases: psql failed with exit code {0}' -f $sizes.ExitCode)
    }
    else {
        $lines = @($sizes.Output | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $found = @($lines | ForEach-Object { ($_ -split ' ')[0] })
        $missing = @($layout.Databases | Where-Object { $found -notcontains $_.Name } | ForEach-Object { $_.Name })
        if ($missing.Count -eq 0) { Show-SetupStatus -Status OK -Message ('Databases: {0}' -f ($lines -join ', ')) }
        else { Show-SetupStatus -Status ACTION -Message ('Databases: {0}; missing {1} (run setup.cmd)' -f ($lines -join ', '), ($missing -join ', ')) }
    }

    $newest = Get-DumpFile | Select-Object -First 1
    if ($newest) { Show-SetupStatus -Status OK -Message ('Newest dump: {0}, {1}, {2:N1} MB' -f $newest.Name, (Format-Timestamp -Value $newest.LastWriteTime), ($newest.Length / 1MB)) }
    else { Show-SetupStatus -Status ACTION -Message "Newest dump: none in $backupDir yet; npm run db:backup makes one now" }

    $task = Get-ScheduledTask -TaskName $layout.BackupTaskName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $task) {
        Show-SetupStatus -Status ACTION -Message ("Backup task: '{0}' is not registered; run setup.cmd" -f $layout.BackupTaskName)
    }
    else {
        $info = $task | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        $next = Format-Timestamp -Value $info.NextRunTime
        if (-not $info -or $null -eq $info.LastRunTime -or $info.LastRunTime -lt [datetime]'2000-01-01') {
            Show-SetupStatus -Status OK -Message "Backup task: not run yet; next run $next"
        }
        elseif ($info.LastTaskResult -eq 0) {
            Show-SetupStatus -Status OK -Message ('Backup task: last run {0} succeeded; next run {1}' -f (Format-Timestamp -Value $info.LastRunTime), $next)
        }
        else {
            Show-SetupStatus -Status ACTION -Message ('Backup task: last run {0} failed (result {1}); see the backup-*.log files in {2}' -f (Format-Timestamp -Value $info.LastRunTime), $info.LastTaskResult, $location.LogDir)
        }
    }
    $exitCode
}

function Invoke-LogAction {
    param([switch]$Stream)
    $id = Get-ReadyContainerId -IncludeStopped
    if (-not $id) { return 2 }
    $arguments = @('logs', '--tail', '200')
    if ($Stream) { $arguments += '--follow' }
    $arguments += $id
    $run = Invoke-NativeCommand -FilePath 'docker' -ArgumentList $arguments -Indent ''
    if ($run.ExitCode -eq 0) { return 0 }
    1
}

function Invoke-BackupAction {
    $id = Get-ReadyContainerId
    if (-not $id) { return 2 }
    $backupScript = Join-Path $DataDir 'backup.ps1'
    if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) {
        Show-SetupStatus -Status ACTION -Message "$backupScript doesn't exist; run setup.cmd first"
        return 2
    }
    $run = Invoke-NativeCommand -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $backupScript)
    if ($run.ExitCode -ne 0) {
        Show-SetupStatus -Status FAILED -Message "backup.ps1 failed with exit code $($run.ExitCode); see the output above"
        return 1
    }
    $newest = Get-DumpFile | Select-Object -First 1
    if ($newest) { Show-SetupStatus -Status OK -Message ('Backup written: {0} ({1:N1} MB)' -f $newest.FullName, ($newest.Length / 1MB)) }
    0
}

function Invoke-RestoreAction {
    param([AllowEmptyString()][string]$DumpName = '')
    $target = @($layout.Databases | Where-Object { $_.Name -eq $Database }) | Select-Object -First 1
    if (-not $target) {
        Show-SetupStatus -Status ACTION -Message ("restore works for {0}, not for '{1}'" -f (($layout.Databases | ForEach-Object { $_.Name }) -join ', '), $Database)
        return 2
    }
    $id = Get-ReadyContainerId
    if (-not $id) { return 2 }
    $dumps = @(Get-DumpFile)
    if ($dumps.Count -eq 0) {
        Show-SetupStatus -Status ACTION -Message "No dumps in $backupDir."
        return 2
    }
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        Show-SetupStatus -Status ACTION -Message 'restore asks for confirmation; run it in a terminal window (npm run db:restore).'
        return 2
    }
    Show-SetupMessage -Text "Dumps in ${backupDir}:"
    for ($i = 0; $i -lt $dumps.Count; $i++) {
        Show-SetupMessage -Text ('  {0,3}  {1}  {2}  {3:N1} MB' -f ($i + 1), $dumps[$i].Name, (Format-Timestamp -Value $dumps[$i].LastWriteTime), ($dumps[$i].Length / 1MB))
    }
    if ($DumpName) {
        $name = Split-Path -Leaf $DumpName
        $dump = $dumps | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        if (-not $dump) {
            Show-SetupStatus -Status ACTION -Message "$name is not in $backupDir."
            return 2
        }
    }
    else {
        $answer = Read-Host -Prompt 'Number of the dump to restore'
        $number = 0
        if (-not [int]::TryParse([string]$answer, [ref]$number) -or $number -lt 1 -or $number -gt $dumps.Count) {
            Show-SetupStatus -Status ACTION -Message 'Nothing restored: that is not a number from the list.'
            return 2
        }
        $dump = $dumps[$number - 1]
    }
    Show-SetupMessage -Text ('This replaces everything in database {0} with {1}.' -f $Database, $dump.Name) -Color 'Yellow'
    $confirmation = Read-Host -Prompt ('Type {0} to continue' -f $Database)
    if ($confirmation -cne $Database) {
        Show-SetupStatus -Status ACTION -Message 'Nothing restored: the name did not match.'
        return 2
    }
    # One transaction: a restore that fails halfway leaves the database as it was.
    $arguments = @('exec', $id, 'pg_restore', '-U', 'postgres', '--clean', '--if-exists', '--single-transaction', '-d', $Database)
    if ($Database -ne 'allin') { $arguments += @('--no-owner', '--no-acl', "--role=$($target.Owner)") }
    $arguments += "/backups/$($dump.Name)"
    $run = Invoke-NativeCommand -FilePath 'docker' -ArgumentList $arguments
    if ($run.ExitCode -ne 0) {
        Show-SetupStatus -Status FAILED -Message "pg_restore reported errors (exit code $($run.ExitCode)); see the output above"
        return 1
    }
    Show-SetupStatus -Status OK -Message ('Restored {0} into {1}.' -f $dump.Name, $Database)
    0
}

$layout = Get-DatabaseLayout
$location = Get-SetupLocation
$options = Resolve-DatabaseOption -State (Read-SetupState -Path $location.StatePath) -DataDir $DataDir -Port $Port
$DataDir = Resolve-FullPath -Path $options.DataDir
$Port = $options.Port
if (-not $LogDir) { $LogDir = $location.LogDir }
$backupDir = Join-Path $DataDir 'backups'

$exitCode = 1
$transcribing = $false
try {
    Sync-SessionPath
    if ($Action -eq 'backup' -or $Action -eq 'restore') {
        New-Item -ItemType Directory -Path $LogDir -Force -ErrorAction Stop | Out-Null
        Start-Transcript -Path (Get-SetupLogPath -LogDir $LogDir -Name 'db') -ErrorAction Stop | Out-Null
        $transcribing = $true
    }
    switch ($Action) {
        'status' { $exitCode = Invoke-StatusAction }
        'logs' { $exitCode = Invoke-LogAction -Stream:$Follow }
        'psql' {
            $exitCode = 2
            $allowed = @($layout.Databases | ForEach-Object { $_.Name }) + 'postgres'
            if ($allowed -notcontains $Database) {
                Show-SetupStatus -Status ACTION -Message ("Unknown database '{0}'; use one of: {1}" -f $Database, ($allowed -join ', '))
            }
            else {
                $containerId = Get-ReadyContainerId
                if ($containerId) {
                    # Called directly, not through Invoke-NativeCommand: psql needs the terminal.
                    & docker exec -it $containerId psql -U postgres -d $Database
                    $exitCode = 0
                    if ($LASTEXITCODE -ne 0) { $exitCode = 1 }
                }
            }
        }
        'backup' { $exitCode = Invoke-BackupAction }
        'restore' { $exitCode = Invoke-RestoreAction -DumpName $File }
    }
}
catch {
    Show-SetupStatus -Status FAILED -Message $_.Exception.Message
    $exitCode = 1
}
finally {
    if ($transcribing) { Stop-Transcript | Out-Null }
}
exit $exitCode
