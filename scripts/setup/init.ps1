#Requires -Version 5.1
<#
.SYNOPSIS
    Script 2 of the All-in Windows setup (normal user). On the database PC: PostgreSQL 18 in Docker with its roles,
    databases, npm packages, migrations, a nightly backup and the production bot. With -Dev: prepares a development PC.
.PARAMETER Dev
    Prepare a development PC: npm packages, the repository .env, a check of the database host and migrations.
.PARAMETER CheckOnly
    Report the state of every step; change nothing and never prompt.
.PARAMETER NonInteractive
    Never prompt. When input is needed, leave placeholders and say what to do.
.PARAMETER DataDir
    Data directory on the database PC (.env with the passwords, backup.ps1, backups). Default: the saved value, else C:\all-in-db.
.PARAMETER Port
    PostgreSQL port on the local network. Default: the saved value, else 5432.
.PARAMETER ResultPath
    Write the results and the exit code to this JSON file.
.PARAMETER LogDir
    Folder for the transcript. Default: %LOCALAPPDATA%\all-in\logs.
.PARAMETER HideConnectionLines
    Don't print the two .env lines for the development PC at the end (setup.ps1 prints them itself).
#>
[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$CheckOnly,
    [switch]$NonInteractive,
    [string]$DataDir,
    [ValidateRange(0, 65535)][int]$Port,
    [string]$ResultPath,
    [string]$LogDir,
    [switch]$HideConnectionLines
)

Import-Module (Join-Path $PSScriptRoot 'AllIn.Setup.psm1') -Force

$script:devKeys = @('DATABASE_URL', 'TEST_DATABASE_URL', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DEV_GUILD_ID')
$script:placeholder = 'change-me'
$script:indent = '            '
$script:dataEnvHeader = '# All-in database passwords (PostgreSQL superuser, allin, allin_dev). Keep this file private; setup never overwrites a value.'
$script:noMigrations = 'no migrations yet (drizzle\meta\_journal.json does not exist)'
$script:checkOnlyMigrations = 'not checked in check-only mode; a full run applies pending migrations'

function Enter-Step {
    param(
        [Parameter(Mandatory)][int]$Number,
        [Parameter(Mandatory)][string]$Name
    )
    $script:currentStep = $Name
    Show-SetupStep -Number $Number -Total $script:totalSteps -Title $Name
}

function Add-StepResult {
    param(
        [Parameter(Mandatory)][ValidateSet('OK', 'INSTALLED', 'ACTION', 'FAILED', 'SKIPPED')][string]$Status,
        [AllowEmptyString()][string]$Message = '',
        [switch]$RebootRequired
    )
    Add-SetupResult -List $script:results -Name $script:currentStep -Status $Status -Message $Message -RebootRequired:$RebootRequired
}

function Show-Instruction {
    param([AllowEmptyCollection()][string[]]$Line = @())
    foreach ($text in $Line) { Show-SetupMessage -Text ($script:indent + $text) }
}

function Show-ResultRecap {
    foreach ($result in $script:results.ToArray()) {
        Show-SetupStatus -Status $result.Status -Message (Format-SetupResultLine -Result $result)
    }
}

function Test-StepPassed {
    param([Parameter(Mandatory)][string]$Name)
    @($script:results | Where-Object { $_.Name -eq $Name -and ($_.Status -eq 'OK' -or $_.Status -eq 'INSTALLED') }).Count -gt 0
}

function Test-MigrationJournal {
    Test-Path -LiteralPath (Join-Path $repoRoot 'drizzle\meta\_journal.json') -PathType Leaf
}

function Test-AccessDenied {
    param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord)
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        if ($exception -is [System.UnauthorizedAccessException] -or $exception.HResult -eq -2147024891) { return $true }
        $exception = $exception.InnerException
    }
    # CIM cmdlets (scheduled tasks) only carry E_ACCESSDENIED in the error id.
    [string]$ErrorRecord.FullyQualifiedErrorId -match '0x80070005'
}

function Invoke-NativeWithEnvironment {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [hashtable]$Environment = @{}
    )
    Invoke-NativeCommand -FilePath $FilePath -ArgumentList $ArgumentList -Environment $Environment -Secret $script:secrets
}

function Invoke-RepoNpm {
    param(
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [hashtable]$Environment = @{}
    )
    Push-Location -LiteralPath $repoRoot
    try {
        Invoke-NativeWithEnvironment -FilePath 'npm.cmd' -ArgumentList $ArgumentList -Environment $Environment
    }
    finally {
        Pop-Location
    }
}

function Get-DockerEngine {
    $result = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('info', '--format', '{{.OSType}}/{{.ServerVersion}}') -Capture
    if ($result.ExitCode -ne 0) { return $null }
    $line = @($result.Output | Where-Object { $_ -match '^(linux|windows)/\S' }) | Select-Object -First 1
    if (-not $line) { return $null }
    $parts = $line.Split('/')
    [pscustomobject]@{ OSType = $parts[0]; Version = $parts[1] }
}

function Wait-DockerEngine {
    $deadline = (Get-Date).AddMinutes(5)
    $notice = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $engine = Get-DockerEngine
        if ($null -ne $engine) { return $engine }
        if ((Get-Date) -ge $notice) {
            Show-SetupMessage -Text '  still waiting for the Docker engine ...'
            $notice = (Get-Date).AddSeconds(30)
        }
    }
    $null
}

function Get-PortOwnerName {
    param([Parameter(Mandatory)][int]$Port)
    $connection = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) | Select-Object -First 1
    if (-not $connection) { return 'another program' }
    $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
    if ($process) { return ('{0} (PID {1})' -f $process.ProcessName, $process.Id) }
    'PID {0}' -f $connection.OwningProcess
}

function Invoke-PostgresScript {
    param(
        [Parameter(Mandatory)][string]$ContainerId,
        [Parameter(Mandatory)][string]$Sql,
        [AllowEmptyCollection()][string[]]$Secret = @()
    )
    # Superuser through the container's socket; passwords travel only on stdin, never in argv.
    $arguments = @('exec', '-i', $ContainerId, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres')
    Invoke-NativeCommand -FilePath 'docker' -ArgumentList $arguments -InputText $Sql -Secret $Secret -Capture
}

function Get-RoleSql {
    param(
        [AllowEmptyCollection()][string[]]$Present = @(),
        [System.Collections.IDictionary]$EnvValue = @{}
    )
    foreach ($role in $layout.Roles) {
        $literal = "'" + ([string]$EnvValue[$role.SecretKey]).Replace("'", "''") + "'"
        if ($Present -contains "role:$($role.Name)") { 'ALTER ROLE {0} WITH LOGIN PASSWORD {1};' -f $role.Name, $literal }
        else { 'CREATE ROLE {0} LOGIN PASSWORD {1};' -f $role.Name, $literal }
    }
    foreach ($database in $layout.Databases) {
        if ($Present -notcontains "database:$($database.Name)") { 'CREATE DATABASE {0} OWNER {1};' -f $database.Name, $database.Owner }
        'REVOKE CONNECT ON DATABASE {0} FROM PUBLIC;' -f $database.Name
    }
}

function ConvertTo-UserSid {
    param([AllowEmptyString()][string]$UserName)
    if (-not $UserName) { return $null }
    if ($UserName -match '^S-1-') { return $UserName }
    try {
        (New-Object System.Security.Principal.NTAccount -ArgumentList $UserName).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    catch {
        $null
    }
}

function Test-BackupTaskCurrent {
    param(
        [Parameter(Mandatory)][object]$Task,
        [Parameter(Mandatory)][string]$Argument
    )
    if ($Task.Description -ne $layout.BackupTaskDescription) { return $false }
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1 -or $actions[0].Execute -ne 'powershell.exe' -or $actions[0].Arguments -ne $Argument) { return $false }
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskDailyTrigger' -or -not $triggers[0].StartBoundary) { return $false }
    $time = ([datetime]$triggers[0].StartBoundary).ToString('HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
    if ($time -ne $layout.BackupTime) { return $false }
    if (-not $Task.Settings.StartWhenAvailable -or [string]$Task.Principal.LogonType -ne 'Interactive') { return $false }
    (ConvertTo-UserSid -UserName $Task.Principal.UserId) -eq (Get-CurrentUserSid)
}

function Register-BackupTask {
    param([Parameter(Mandatory)][string]$Argument)
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Argument
    $trigger = New-ScheduledTaskTrigger -Daily -At $layout.BackupTime
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $layout.BackupTaskName -Description $layout.BackupTaskDescription -Action $action `
        -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
}

function Get-MissingDevKey {
    param([System.Collections.IDictionary]$Value = @{})
    foreach ($key in $script:devKeys) {
        $text = [string]$Value[$key]
        $template = [string]$script:templateValues[$key]
        if (-not $text -or $text.Contains($script:placeholder) -or ($template -and $text -eq $template)) { $key }
    }
}

function Get-DevPlaceholder {
    param([Parameter(Mandatory)][string]$Key)
    switch ($Key) {
        'DATABASE_URL' { return ('postgresql://allin_dev:{0}@database-host:{1}/allin_dev' -f $script:placeholder, $Port) }
        'TEST_DATABASE_URL' { return ('postgresql://allin_dev:{0}@database-host:{1}/allin_test' -f $script:placeholder, $Port) }
        default { return $script:placeholder }
    }
}

function Get-DevSecret {
    $values = Read-EnvFile -Path (Join-Path $repoRoot '.env')
    $token = [string]$values['DISCORD_TOKEN']
    if ($token) { $token }
    $uri = $null
    if ([uri]::TryCreate([string]$values['DATABASE_URL'], [UriKind]::Absolute, [ref]$uri) -and $uri.UserInfo -match ':(.+)$') {
        [uri]::UnescapeDataString($Matches[1])
    }
}

function Read-DevValue {
    param([AllowEmptyCollection()][string[]]$Missing = @())
    $answers = [ordered]@{}
    if ($Missing -contains 'DATABASE_URL' -or $Missing -contains 'TEST_DATABASE_URL') {
        Show-Instruction -Line @('The database PC prints DATABASE_URL and TEST_DATABASE_URL at the end of its setup; these two answers build the same lines.')
        $dbHost = ([string](Read-Host -Prompt '  Address of the database PC (for example 192.168.1.20)')).Trim()
        $secret = Read-SecretValue -Prompt '  allin_dev password (ALLIN_DEV_PASSWORD in the .env of its data directory)'
        # Only the missing key gets an answer, so a working DATABASE_URL is never replaced.
        if ($dbHost -and $secret -and $Missing -contains 'DATABASE_URL') {
            $answers['DATABASE_URL'] = Format-PostgresUrl -User 'allin_dev' -Secret $secret -HostName $dbHost -Port $Port -Database 'allin_dev'
        }
        if ($dbHost -and $secret -and $Missing -contains 'TEST_DATABASE_URL') {
            $answers['TEST_DATABASE_URL'] = Format-PostgresUrl -User 'allin_dev' -Secret $secret -HostName $dbHost -Port $Port -Database 'allin_test'
        }
    }
    if ($Missing -contains 'DISCORD_TOKEN') {
        $token = Read-SecretValue -Prompt '  Bot token of your Discord development application (hidden)'
        if ($token) { $answers['DISCORD_TOKEN'] = $token }
    }
    if ($Missing -contains 'DISCORD_CLIENT_ID') {
        $clientId = ([string](Read-Host -Prompt '  Application ID of that Discord application')).Trim()
        if ($clientId) { $answers['DISCORD_CLIENT_ID'] = $clientId }
    }
    if ($Missing -contains 'DEV_GUILD_ID') {
        $guildId = ([string](Read-Host -Prompt '  Server ID of your Discord test server')).Trim()
        if ($guildId) { $answers['DEV_GUILD_ID'] = $guildId }
    }
    $answers
}

function Invoke-PrerequisiteStep {
    $installScript = Join-Path $PSScriptRoot 'install.ps1'
    if (-not (Test-Path -LiteralPath $installScript -PathType Leaf)) {
        Add-StepResult -Status FAILED -Message "install.ps1 is missing in $PSScriptRoot; update the repository (git pull) and run setup.cmd"
        return
    }
    $checkPath = Join-Path $LogDir ('install-check-{0}.json' -f [guid]::NewGuid().ToString('N'))
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installScript, '-CheckOnly', '-NonInteractive',
        '-DataDir', $DataDir, '-Port', [string]$Port, '-ResultPath', $checkPath, '-LogDir', $LogDir
    )
    Show-SetupMessage -Text '  Running install.ps1 -CheckOnly ...'
    $check = $null
    try {
        $run = Invoke-NativeCommand -FilePath 'powershell.exe' -ArgumentList $arguments -Capture
        $check = Import-SetupResult -Path $checkPath
    }
    finally {
        Remove-Item -LiteralPath $checkPath -Force -ErrorAction SilentlyContinue
    }
    if ($null -eq $check) {
        Add-StepResult -Status FAILED -Message "install.ps1 -CheckOnly stopped with exit code $($run.ExitCode) without writing a result"
        Show-Instruction -Line @($run.Output | Select-Object -Last 10)
        return
    }
    foreach ($item in @($check.Results | Where-Object { $_.Status -ne 'OK' })) { Show-SetupResult -Result $item }
    switch ($run.ExitCode) {
        0 { Add-StepResult -Status OK -Message 'install.ps1 -CheckOnly finds everything in place' }
        3010 { Add-StepResult -Status ACTION -RebootRequired -Message 'a restart is pending; restart the PC, then run setup.cmd again' }
        default { Add-StepResult -Status ACTION -Message 'install.ps1 found items to fix (listed above); run setup.cmd first, it asks for administrator rights' }
    }
}

function Invoke-DockerEngineStep {
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    $hasDesktop = Test-Path -LiteralPath $desktop -PathType Leaf
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        if ($hasDesktop) { Add-StepResult -Status ACTION -Message 'Docker Desktop is installed, but the docker command is not on PATH; sign out and in again, then run setup.cmd' }
        else { Add-StepResult -Status ACTION -Message 'Docker Desktop is not installed; run setup.cmd' }
        return
    }
    $engine = Get-DockerEngine
    $started = $false
    if ($null -eq $engine) {
        if ($CheckOnly) {
            Add-StepResult -Status ACTION -Message 'the Docker engine is not running; init.ps1 starts Docker Desktop and waits for it'
            return
        }
        if (-not $hasDesktop) {
            Add-StepResult -Status ACTION -Message "the Docker engine doesn't answer and $desktop is missing; run setup.cmd"
            return
        }
        Show-SetupMessage -Text '  Starting Docker Desktop and waiting up to 5 minutes for its engine ...'
        Start-Process -FilePath $desktop -ErrorAction Stop
        $engine = Wait-DockerEngine
        if ($null -eq $engine) {
            Add-StepResult -Status ACTION -Message "Docker Desktop didn't start its engine within 5 minutes"
            Show-Instruction -Line @(
                'Check the Docker Desktop window:'
                '- accept the Docker Subscription Service Agreement if it asks (no Docker account needed);'
                '- wait until it shows "Engine running";'
                '- if it reports a WSL problem, run "wsl --update" in an administrator PowerShell;'
                '- if it reports that virtualization is off, turn on Intel VT-x or AMD SVM in the BIOS/UEFI;'
                '- if docker reports "Access is denied" right after the installation, sign out of Windows and back in.'
                'Then run setup.cmd again.'
            )
            return
        }
        $started = $true
    }
    if ($engine.OSType -ne 'linux') {
        Add-StepResult -Status ACTION -Message "the Docker engine runs $($engine.OSType) containers; PostgreSQL needs Linux containers"
        Show-Instruction -Line @('Right-click the Docker icon in the notification area, choose "Switch to Linux containers...", then run setup.cmd again.')
        return
    }
    if ($started) { Add-StepResult -Status INSTALLED -Message "started Docker Desktop (engine $($engine.Version))" }
    else { Add-StepResult -Status OK -Message "running (engine $($engine.Version))" }
}

function Invoke-DataDirectoryStep {
    $backupDir = Join-Path $DataDir 'backups'
    $envPath = Join-Path $DataDir '.env'
    $legacyCompose = Join-Path $DataDir 'compose.yaml'
    if ($CheckOnly) {
        if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
            Add-StepResult -Status ACTION -Message "$DataDir doesn't exist yet; init.ps1 creates it with new passwords"
            return
        }
        $todo = New-Object System.Collections.Generic.List[string]
        if (-not (Test-Path -LiteralPath $backupDir -PathType Container)) { $todo.Add('create backups\') }
        if (Test-Path -LiteralPath $legacyCompose -PathType Leaf) { $todo.Add('rename the compose.yaml of the old setup script') }
        try {
            $values = Read-EnvFile -Path $envPath
            $missing = @($layout.SecretKeys | Where-Object { -not $values[$_] })
            if ($missing.Count -gt 0) { $todo.Add('generate ' + ($missing -join ', ')) }
            if ((Test-Path -LiteralPath $envPath -PathType Leaf) -and -not (Test-SecretFileProtected -Path $envPath)) {
                $todo.Add('restrict .env to you, Administrators and SYSTEM')
            }
        }
        catch {
            if (-not (Test-AccessDenied -ErrorRecord $_)) { throw }
            Add-StepResult -Status ACTION -Message "no access to $envPath; run setup.cmd, it fixes the permissions"
            return
        }
        if ($todo.Count -eq 0) { Add-StepResult -Status OK -Message "$DataDir (.env complete and private)" }
        else { Add-StepResult -Status ACTION -Message ('{0}: {1}; init.ps1 does this' -f $DataDir, ($todo -join ', ')) }
        return
    }

    $changes = New-Object System.Collections.Generic.List[string]
    try {
        foreach ($folder in @($DataDir, $backupDir)) {
            if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
                New-Item -ItemType Directory -Path $folder -Force -ErrorAction Stop | Out-Null
                $changes.Add("created $folder")
            }
        }
        if (Test-Path -LiteralPath $legacyCompose -PathType Leaf) {
            $newName = 'compose.yaml.bak'
            if (Test-Path -LiteralPath (Join-Path $DataDir $newName)) { $newName = 'compose.yaml.bak-' + (Get-Date).ToString('yyyyMMddHHmmss') }
            Rename-Item -LiteralPath $legacyCompose -NewName $newName -ErrorAction Stop
            $changes.Add("renamed the old compose.yaml to $newName")
        }
        if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
            # Restrict the empty file first, so the passwords are never readable by others.
            New-Item -ItemType File -Path $envPath -ErrorAction Stop | Out-Null
            Protect-SecretFile -Path $envPath
        }
        $text = [System.IO.File]::ReadAllText($envPath)
        $values = ConvertFrom-EnvText -Text $text
        $generated = [ordered]@{}
        foreach ($key in $layout.SecretKeys) {
            if (-not $values[$key]) { $generated[$key] = Get-RandomSecret }
        }
        if ($generated.Count -gt 0) {
            if (-not $text.Trim()) { $text = $script:dataEnvHeader }
            Write-Utf8LfFile -Path $envPath -Text (Merge-EnvText -Text $text -Values $generated)
            $changes.Add('generated ' + (@($generated.Keys) -join ', '))
        }
        if (-not (Test-SecretFileProtected -Path $envPath)) {
            Protect-SecretFile -Path $envPath
            $changes.Add('restricted .env to you, Administrators and SYSTEM')
        }
    }
    catch {
        if (-not (Test-AccessDenied -ErrorRecord $_)) { throw }
        Add-StepResult -Status ACTION -Message "no access to $DataDir or its .env; run setup.cmd, it fixes the permissions as administrator"
        return
    }
    $script:envValues = Read-EnvFile -Path $envPath
    $script:secrets = @($layout.SecretKeys | ForEach-Object { [string]$script:envValues[$_] } | Where-Object { $_ })
    if ([string]$state['dataDir'] -ne $DataDir -or [int]$state['port'] -ne $Port) {
        $state['dataDir'] = $DataDir
        $state['port'] = $Port
        Save-SetupState -Path $location.StatePath -State $state
    }
    if ($changes.Count -eq 0) { Add-StepResult -Status OK -Message "$DataDir (.env complete and private)" }
    else { Add-StepResult -Status INSTALLED -Message ('{0}: {1}' -f $DataDir, ($changes -join ', ')) }
}

function Invoke-PostgresStep {
    $before = Get-DatabaseContainerId
    if (-not $before -and (Test-TcpPort -HostName '127.0.0.1' -Port $Port -TimeoutMilliseconds 1000)) {
        $message = 'port {0} is already in use by {1}; stop that program or choose another port, for example: setup.cmd -Port {2}' -f $Port, (Get-PortOwnerName -Port $Port), ($Port + 1)
        if ($CheckOnly) { Add-StepResult -Status ACTION -Message $message }
        else { Add-StepResult -Status FAILED -Message $message }
        return
    }
    if ($CheckOnly) {
        if (-not $before) { Add-StepResult -Status ACTION -Message 'not running; init.ps1 starts it'; return }
        $health = Get-ContainerHealth -ContainerId $before
        if ($health -eq 'healthy') { Add-StepResult -Status OK -Message "running and healthy on port $Port" }
        else { Add-StepResult -Status ACTION -Message "running, but $health; init.ps1 recreates it when needed" }
        return
    }
    $arguments = @(
        'compose', '--project-name', $layout.ProjectName, '--file', (Join-Path $repoRoot 'deploy\database\compose.yaml'),
        '--env-file', (Join-Path $DataDir '.env'), 'up', '--detach', '--wait'
    )
    $environment = @{ ALLIN_DB_PORT = [string]$Port; ALLIN_DB_BACKUP_DIR = (Join-Path $DataDir 'backups').Replace('\', '/') }
    Show-SetupMessage -Text '  docker compose up (the first run downloads the postgres:18 image) ...'
    $run = Invoke-NativeWithEnvironment -FilePath 'docker' -ArgumentList $arguments -Environment $environment
    if ($run.ExitCode -ne 0) {
        Add-StepResult -Status FAILED -Message "docker compose up failed with exit code $($run.ExitCode); see the output above"
        return
    }
    $after = Get-DatabaseContainerId
    if (-not $after) { Add-StepResult -Status FAILED -Message 'docker compose up succeeded, but no running container was found'; return }
    if ($after -eq $before) { Add-StepResult -Status OK -Message "running and healthy on port $Port" }
    else { Add-StepResult -Status INSTALLED -Message "started on port $Port (container $after)" }
}

function Invoke-RoleStep {
    $containerId = Get-DatabaseContainerId
    if (-not $containerId) { Add-StepResult -Status SKIPPED -Message 'the database container is not running'; return }
    $roleNames = ($layout.Roles | ForEach-Object { "'$($_.Name)'" }) -join ', '
    $databaseNames = ($layout.Databases | ForEach-Object { "'$($_.Name)'" }) -join ', '
    $query = "SELECT 'role:' || rolname FROM pg_roles WHERE rolname IN ($roleNames) UNION ALL SELECT 'database:' || datname FROM pg_database WHERE datname IN ($databaseNames);"
    $check = Invoke-PostgresScript -ContainerId $containerId -Sql $query
    if ($check.ExitCode -ne 0) {
        Add-StepResult -Status FAILED -Message "psql failed with exit code $($check.ExitCode)"
        Show-Instruction -Line @($check.Output)
        return
    }
    $present = @($check.Output | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $missing = @(
        foreach ($role in $layout.Roles) { if ($present -notcontains "role:$($role.Name)") { "role $($role.Name)" } }
        foreach ($database in $layout.Databases) { if ($present -notcontains "database:$($database.Name)") { "database $($database.Name)" } }
    )
    $summary = 'roles allin and allin_dev, databases allin, allin_dev and allin_test'
    if ($CheckOnly) {
        if ($missing.Count -eq 0) { Add-StepResult -Status OK -Message $summary }
        else { Add-StepResult -Status ACTION -Message ('missing {0}; init.ps1 creates them' -f ($missing -join ', ')) }
        return
    }
    $sql = (@(Get-RoleSql -Present $present -EnvValue $script:envValues) -join "`n") + "`n"
    $run = Invoke-PostgresScript -ContainerId $containerId -Sql $sql -Secret $script:secrets
    if ($run.ExitCode -ne 0) {
        Add-StepResult -Status FAILED -Message "psql failed with exit code $($run.ExitCode)"
        Show-Instruction -Line @($run.Output)
        return
    }
    if ($missing.Count -eq 0) { Add-StepResult -Status OK -Message $summary }
    else { Add-StepResult -Status INSTALLED -Message ('created {0}' -f ($missing -join ', ')) }
}

function Invoke-PackageStep {
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        Add-StepResult -Status ACTION -Message 'npm is missing (Node.js is not installed); run setup.cmd first'
        return
    }
    $hash = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'package-lock.json') -Algorithm SHA256 -ErrorAction Stop).Hash
    $reason = ''
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container)) { $reason = 'node_modules is missing' }
    elseif (-not $state['packageLockHash']) { $reason = 'node_modules was not installed by this setup yet' }
    elseif ([string]$state['packageLockHash'] -ne $hash) { $reason = 'package-lock.json changed since the last npm ci of this setup' }
    if (-not $reason) { Add-StepResult -Status OK -Message 'node_modules matches package-lock.json'; return }
    if ($CheckOnly) { Add-StepResult -Status ACTION -Message "$reason; init.ps1 runs npm ci"; return }
    Show-SetupMessage -Text "  $reason; running npm ci ..."
    $run = Invoke-RepoNpm -ArgumentList @('ci', '--no-audit', '--no-fund')
    if ($run.ExitCode -ne 0) {
        Add-StepResult -Status FAILED -Message "npm ci failed with exit code $($run.ExitCode); see the output above"
        return
    }
    $state['packageLockHash'] = $hash
    Save-SetupState -Path $location.StatePath -State $state
    Add-StepResult -Status INSTALLED -Message 'npm ci done'
}

function Invoke-MigrationStep {
    param([switch]$WithBot)
    if (-not (Test-MigrationJournal)) { Add-StepResult -Status SKIPPED -Message $script:noMigrations; return }
    if ($CheckOnly) { Add-StepResult -Status SKIPPED -Message $script:checkOnlyMigrations; return }
    if (-not (Test-StepPassed -Name 'Roles and databases')) { Add-StepResult -Status SKIPPED -Message 'needs the roles and databases (step 5)'; return }
    if (-not (Test-StepPassed -Name 'npm packages')) { Add-StepResult -Status SKIPPED -Message 'needs the npm packages (step 6)'; return }
    $plan = Get-HostMigrationPlan -WithBot:$WithBot
    foreach ($target in $plan.Targets) {
        $url = Format-PostgresUrl -User $target.Role -Secret ([string]$script:envValues[$target.SecretKey]) -HostName 'localhost' -Port $Port -Database $target.Database
        Show-SetupMessage -Text ('  {0} (as {1})' -f $target.Database, $target.Role)
        $run = Invoke-RepoNpm -ArgumentList @('run', 'db:migrate') -Environment @{ DATABASE_URL = $url }
        if ($run.ExitCode -ne 0) {
            Add-StepResult -Status FAILED -Message "npm run db:migrate failed for $($target.Database) with exit code $($run.ExitCode); see the output above"
            return
        }
    }
    Add-StepResult -Status OK -Message $plan.Summary
}

function Invoke-BackupStep {
    $template = Join-Path $PSScriptRoot 'templates\backup.ps1'
    $target = Join-Path $DataDir 'backup.ps1'
    $argument = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $target
    $scriptCurrent = (Test-Path -LiteralPath $target -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $template -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash)
    $task = Get-ScheduledTask -TaskName $layout.BackupTaskName -ErrorAction SilentlyContinue | Select-Object -First 1
    $taskCurrent = ($null -ne $task) -and (Test-BackupTaskCurrent -Task $task -Argument $argument)
    $schedule = 'daily at {0}, dumps kept {1} days in {2}' -f $layout.BackupTime, $layout.BackupRetentionDays, (Join-Path $DataDir 'backups')
    if ($scriptCurrent -and $taskCurrent) { Add-StepResult -Status OK -Message $schedule; return }
    $todo = New-Object System.Collections.Generic.List[string]
    if (-not $scriptCurrent) { $todo.Add("copy backup.ps1 to $DataDir") }
    if (-not $taskCurrent) {
        if ($null -eq $task) { $todo.Add("register the task '$($layout.BackupTaskName)'") }
        else { $todo.Add("replace the task '$($layout.BackupTaskName)'") }
    }
    if ($CheckOnly) { Add-StepResult -Status ACTION -Message (($todo -join ' and ') + '; init.ps1 does this'); return }
    if (-not $scriptCurrent) { Copy-Item -LiteralPath $template -Destination $target -Force -ErrorAction Stop }
    if (-not $taskCurrent) {
        try {
            Register-BackupTask -Argument $argument
        }
        catch {
            if (-not (Test-AccessDenied -ErrorRecord $_)) { throw }
            Add-StepResult -Status ACTION -Message "the task '$($layout.BackupTaskName)' belongs to an administrator, so it can't be replaced from here"
            Show-Instruction -Line @(
                'Run this once in an administrator PowerShell, then run setup.cmd again:'
                ("Unregister-ScheduledTask -TaskName '{0}' -Confirm:`$false" -f $layout.BackupTaskName)
            )
            return
        }
    }
    Add-StepResult -Status INSTALLED -Message ('{0}: {1}' -f ($todo -join ', '), $schedule)
}

function Show-HostSummary {
    Show-ResultRecap
    $lan = Get-LanAddress
    Show-SetupMessage -Text ''
    if ($lan) {
        Show-SetupMessage -Text ('  This PC on the network: {0} (MAC {1}, {2})' -f $lan.IPv4, $lan.Mac, $lan.InterfaceAlias)
        $reservation = 'reserve {0} for MAC {1}' -f $lan.IPv4, $lan.Mac
    }
    else {
        Show-SetupMessage -Text '  No network connection with a default gateway found; connect this PC to your network and run setup.cmd again.'
        $reservation = 'give this PC a fixed address'
    }
    Show-SetupMessage -Text ''
    Show-SetupMessage -Text '  Manual actions:'
    Show-SetupMessage -Text ('  1. In your router, {0} (DHCP reservation), so the development PC always finds the database.' -f $reservation)
    Show-SetupMessage -Text '  2. Docker Desktop > Settings > General: turn on "Start Docker Desktop when you sign in".'
    Show-SetupMessage -Text '  3. Optional: automatic sign-in. Docker Desktop, and so the database, only runs while this user is signed in.'
    Show-SetupMessage -Text '     Automatic sign-in brings it back after a restart, but lets anyone with access to this PC open your desktop.'
    if ($CheckOnly -or -not $lan -or -not (Test-StepPassed -Name 'Roles and databases')) { return }
    $script:connectionLines = @(Format-DevConnectionLine -Secret ([string]$script:envValues['ALLIN_DEV_PASSWORD']) -HostName $lan.IPv4 -Port $Port)
    Show-SetupMessage -Text ''
    Show-SetupMessage -Text ('  The passwords are in {0}.' -f (Join-Path $DataDir '.env'))
}

function Invoke-HostSetup {
    $script:totalSteps = 10
    Enter-Step -Number 1 -Name 'Prerequisites'
    Invoke-PrerequisiteStep
    if (-not $CheckOnly -and -not (Test-StepPassed -Name 'Prerequisites')) { return }

    Enter-Step -Number 2 -Name 'Docker engine'
    Invoke-DockerEngineStep
    $dockerReady = Test-StepPassed -Name 'Docker engine'

    Enter-Step -Number 3 -Name 'Data directory'
    Invoke-DataDirectoryStep
    $dataReady = $CheckOnly -or (Test-StepPassed -Name 'Data directory')

    Enter-Step -Number 4 -Name 'PostgreSQL'
    if (-not $dockerReady) { Add-StepResult -Status SKIPPED -Message 'needs the Docker engine (step 2)' }
    elseif (-not $dataReady) { Add-StepResult -Status SKIPPED -Message 'needs the data directory (step 3)' }
    else { Invoke-PostgresStep }

    Enter-Step -Number 5 -Name 'Roles and databases'
    if (Test-StepPassed -Name 'PostgreSQL') { Invoke-RoleStep }
    else { Add-StepResult -Status SKIPPED -Message 'needs a running PostgreSQL (step 4)' }

    Enter-Step -Number 6 -Name 'npm packages'
    Invoke-PackageStep

    $withBot = Test-Path -LiteralPath (Join-Path $repoRoot (Get-BotLayout).ComposeFile) -PathType Leaf
    Enter-Step -Number 7 -Name 'Migrations'
    Invoke-MigrationStep -WithBot:$withBot

    Enter-Step -Number 8 -Name 'Nightly backup'
    if ($dataReady) { Invoke-BackupStep }
    else { Add-StepResult -Status SKIPPED -Message 'needs the data directory (step 3)' }

    Enter-Step -Number 9 -Name 'Bot'
    if ($withBot) {
        Invoke-BotDeployment -Results $script:results -RepoRoot $repoRoot -DataDir $DataDir -Port $Port -State $state `
            -StatePath $location.StatePath -Secret $script:secrets -CheckOnly:$CheckOnly -NonInteractive:(-not $script:prompting) `
            -DataReady:$dataReady -DockerReady:$dockerReady -DatabaseReady:(Test-BotDatabaseReady -Results $script:results.ToArray())
    }
    else {
        Add-StepResult -Status SKIPPED -Message "deploy/compose.yaml doesn't exist yet (deployment phase)"
    }

    Enter-Step -Number 10 -Name 'Summary'
    Show-HostSummary
}

function Invoke-DevEnvStep {
    $envPath = Join-Path $repoRoot '.env'
    $examplePath = Join-Path $repoRoot '.env.example'
    $exists = Test-Path -LiteralPath $envPath -PathType Leaf
    $text = ''
    if ($exists) { $text = [System.IO.File]::ReadAllText($envPath) }
    elseif (Test-Path -LiteralPath $examplePath -PathType Leaf) { $text = [System.IO.File]::ReadAllText($examplePath) }
    $current = ConvertFrom-EnvText -Text $text
    $missing = @(Get-MissingDevKey -Value $current)
    if ($exists -and $missing.Count -eq 0) {
        Add-StepResult -Status OK -Message 'DATABASE_URL, TEST_DATABASE_URL and the Discord values are set'
        return
    }
    if ($CheckOnly) {
        if ($exists) { Add-StepResult -Status ACTION -Message ('not set yet: {0}; init.ps1 -Dev asks for them' -f ($missing -join ', ')) }
        else { Add-StepResult -Status ACTION -Message "doesn't exist yet; init.ps1 -Dev creates it" }
        return
    }
    $values = [ordered]@{}
    if ($script:prompting) { $values = Read-DevValue -Missing $missing }
    foreach ($key in $missing) {
        if (-not $values.Contains($key) -and -not $current[$key]) { $values[$key] = Get-DevPlaceholder -Key $key }
    }
    if ($values.Count -gt 0) { $text = Merge-EnvText -Text $text -Values $values -ReplaceExisting }
    if ($values.Count -gt 0 -or -not $exists) { Write-Utf8LfFile -Path $envPath -Text $text }
    $stillMissing = @(Get-MissingDevKey -Value (ConvertFrom-EnvText -Text $text))
    if ($stillMissing.Count -eq 0) { Add-StepResult -Status INSTALLED -Message "wrote $envPath"; return }
    Add-StepResult -Status ACTION -Message ('fill in {0} in {1}' -f ($stillMissing -join ', '), $envPath)
    Show-Instruction -Line @(
        'Or run .\setup.cmd -Dev in a terminal to be asked for them.'
        'The database PC prints DATABASE_URL and TEST_DATABASE_URL at the end of its setup.'
    )
}

function Invoke-DatabaseHostStep {
    $values = Read-EnvFile -Path (Join-Path $repoRoot '.env')
    if (@(Get-MissingDevKey -Value $values) -contains 'DATABASE_URL') {
        Add-StepResult -Status SKIPPED -Message 'DATABASE_URL in .env is not set yet (step 2)'
        return
    }
    $uri = $null
    if (-not [uri]::TryCreate([string]$values['DATABASE_URL'], [UriKind]::Absolute, [ref]$uri) -or -not $uri.Host) {
        Add-StepResult -Status ACTION -Message 'DATABASE_URL in .env is not a valid postgresql:// URL'
        return
    }
    $hostPort = $uri.Port
    if ($hostPort -le 0) { $hostPort = 5432 }
    $target = '{0}:{1}' -f $uri.Host, $hostPort
    if (Test-TcpPort -HostName $uri.Host -Port $hostPort) { Add-StepResult -Status OK -Message "$target answers"; return }
    Add-StepResult -Status ACTION -Message "$target doesn't answer"
    Show-Instruction -Line @(
        'Check on the database PC: it is on, Docker Desktop shows "Engine running" and npm run db:status reports the database as running.'
        'Both PCs must be on the same network, and the database PC must use the Private network profile for it.'
    )
}

function Invoke-DevMigrationStep {
    if (-not (Test-MigrationJournal)) { Add-StepResult -Status SKIPPED -Message $script:noMigrations; return }
    if ($CheckOnly) { Add-StepResult -Status SKIPPED -Message $script:checkOnlyMigrations; return }
    if (-not (Test-StepPassed -Name 'npm packages')) { Add-StepResult -Status SKIPPED -Message 'needs the npm packages (step 1)'; return }
    if (-not (Test-StepPassed -Name 'Database host')) { Add-StepResult -Status SKIPPED -Message 'needs a reachable database host (step 3)'; return }
    $run = Invoke-RepoNpm -ArgumentList @('run', 'db:migrate')
    if ($run.ExitCode -ne 0) {
        Add-StepResult -Status FAILED -Message "npm run db:migrate failed with exit code $($run.ExitCode); see the output above"
        return
    }
    Add-StepResult -Status OK -Message 'allin_dev is up to date'
}

function Invoke-DevSetup {
    $script:totalSteps = 5
    $script:templateValues = Read-EnvFile -Path (Join-Path $repoRoot '.env.example')
    Enter-Step -Number 1 -Name 'npm packages'
    Invoke-PackageStep
    Enter-Step -Number 2 -Name '.env'
    Invoke-DevEnvStep
    $script:secrets = @(Get-DevSecret)
    Enter-Step -Number 3 -Name 'Database host'
    Invoke-DatabaseHostStep
    Enter-Step -Number 4 -Name 'Migrations'
    Invoke-DevMigrationStep
    Enter-Step -Number 5 -Name 'Summary'
    Show-ResultRecap
}

$layout = Get-DatabaseLayout
$location = Get-SetupLocation
$repoRoot = Get-RepoRoot
$state = Read-SetupState -Path $location.StatePath
$options = Resolve-DatabaseOption -State $state -DataDir $DataDir -Port $Port
$DataDir = Resolve-FullPath -Path $options.DataDir
if ($DataDir.Length -gt 3) { $DataDir = $DataDir.TrimEnd('\') }
$Port = $options.Port
if (-not $LogDir) { $LogDir = $location.LogDir }
$LogDir = Resolve-FullPath -Path $LogDir

$script:results = New-Object System.Collections.Generic.List[object]
$script:currentStep = 'Start'
$script:totalSteps = 10
$script:secrets = @()
$script:envValues = [ordered]@{}
$script:templateValues = [ordered]@{}
$script:connectionLines = @()
$script:prompting = -not ($CheckOnly -or $NonInteractive)
$exitCode = 1
$transcribing = $false
try {
    try {
        New-Item -ItemType Directory -Path $LogDir -Force -ErrorAction Stop | Out-Null
        Start-Transcript -Path (Get-SetupLogPath -LogDir $LogDir -Name 'init') -ErrorAction Stop | Out-Null
        $transcribing = $true
        Sync-SessionPath
        if ($Dev) { Invoke-DevSetup }
        else { Invoke-HostSetup }
    }
    catch {
        Add-StepResult -Status FAILED -Message (ConvertTo-MaskedText -Text $_.Exception.Message -Secret $script:secrets)
    }
    $exitCode = Get-CombinedExitCode -Results $script:results.ToArray()
    if ($ResultPath) { Export-SetupResult -Path $ResultPath -Results $script:results.ToArray() -ExitCode $exitCode }
}
finally {
    if ($transcribing) { Stop-Transcript | Out-Null }
}

if ($script:connectionLines.Count -gt 0 -and -not $HideConnectionLines) {
    Show-SetupMessage -Text ''
    Show-SetupMessage -Text "Put these two lines in the .env of All-in on your development PC (they hold the allin_dev password):"
    foreach ($line in $script:connectionLines) { Show-SetupMessage -Text $line }
}
exit $exitCode
