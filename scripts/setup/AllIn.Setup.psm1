#Requires -Version 5.1
Set-StrictMode -Version 3.0

$script:SecretAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
$script:EnvLinePattern = '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$'
$script:ExitCodes = @{ Ready = 0; Error = 1; UserAction = 2; Reboot = 3010 }
$script:StatusColors = @{ OK = 'Green'; INSTALLED = 'Cyan'; ACTION = 'Yellow'; FAILED = 'Red'; SKIPPED = 'DarkGray' }
$script:Mask = '********'

# winget return codes: https://github.com/microsoft/winget-cli/blob/master/doc/windows/package-manager/winget/returnCodes.md
$script:WingetAlreadyPresent = @(
    -1978335135, # PACKAGE_ALREADY_INSTALLED
    -1978334963, # INSTALL_ALREADY_INSTALLED
    -1978335189, # UPDATE_NOT_APPLICABLE
    -1978335153, # UPGRADE_VERSION_NOT_NEWER
    -1978334962  # INSTALL_DOWNGRADE
)
$script:WingetReboot = @(
    -1978334967, # INSTALL_REBOOT_REQUIRED_TO_FINISH
    -1978334966, # INSTALL_REBOOT_REQUIRED_FOR_INSTALL
    -1978334965, # INSTALL_REBOOT_INITIATED
    3010,
    1641
)

function Resolve-FullPath {
    param([Parameter(Mandatory)][string]$Path)
    # .NET file APIs resolve relative paths against the process directory, not the PowerShell location.
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Get-RepoRoot {
    Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

function Get-SetupLocation {
    param([string]$BaseDirectory = $env:LOCALAPPDATA)
    $root = Join-Path $BaseDirectory 'all-in'
    [pscustomobject]@{
        Root = $root
        LogDir = Join-Path $root 'logs'
        StatePath = Join-Path $root 'state.json'
    }
}

function Get-SetupLogPath {
    param(
        [Parameter(Mandatory)][string]$LogDir,
        [Parameter(Mandatory)][string]$Name,
        [datetime]$Now = (Get-Date)
    )
    Join-Path $LogDir ('{0}-{1}.log' -f $Name, $Now.ToString('yyyyMMdd-HHmmss'))
}

# The transcript of setup.ps1 does not hold what install.ps1 and init.ps1 print: they run as child
# processes and keep their own logs, so a failure there points to that log.
function Format-SetupFailureMessage {
    param(
        [Parameter(Mandatory)][string]$TranscriptPath,
        [Parameter(Mandatory)][string]$LogDir,
        [ValidateSet('setup', 'install', 'init')][string]$FailedPart = 'setup'
    )
    if ($FailedPart -eq 'setup') {
        return 'Setup stopped with an error. Details: {0}' -f $TranscriptPath
    }
    'Setup stopped with an error in {0}.ps1; its FAILED lines are above. Details: the newest {0}-*.log in {1}' -f $FailedPart, $LogDir
}

function Get-DatabaseLayout {
    [pscustomobject]@{
        DefaultDataDir = 'C:\all-in-db'
        DefaultPort = 5432
        ProjectName = 'all-in-db'
        ServiceName = 'postgres'
        SecretKeys = @('POSTGRES_PASSWORD', 'ALLIN_PASSWORD', 'ALLIN_DEV_PASSWORD')
        Roles = @(
            [pscustomobject]@{ Name = 'allin'; SecretKey = 'ALLIN_PASSWORD' }
            [pscustomobject]@{ Name = 'allin_dev'; SecretKey = 'ALLIN_DEV_PASSWORD' }
        )
        Databases = @(
            [pscustomobject]@{ Name = 'allin'; Owner = 'allin' }
            [pscustomobject]@{ Name = 'allin_dev'; Owner = 'allin_dev' }
            [pscustomobject]@{ Name = 'allin_test'; Owner = 'allin_dev' }
        )
        FirewallRuleName = 'AllIn-PostgreSQL'
        FirewallDisplayName = 'All-in PostgreSQL (local network)'
        LegacyFirewallDisplayName = 'All-in PostgreSQL (poort *'
        BackupTaskName = 'All-in database backup'
        BackupTaskDescription = 'All-in: nightly pg_dump of the allin database into the backups folder, kept 14 days. Managed by scripts/setup/init.ps1.'
        BackupTime = '03:30'
        BackupRetentionDays = 14
    }
}

function Resolve-DatabaseOption {
    param(
        [AllowNull()][hashtable]$State,
        [AllowEmptyString()][string]$DataDir = '',
        [int]$Port = 0
    )
    $layout = Get-DatabaseLayout
    if ($null -eq $State) { $State = @{} }
    $resolvedDir = $DataDir
    if (-not $resolvedDir -and $State.ContainsKey('dataDir')) { $resolvedDir = [string]$State['dataDir'] }
    if (-not $resolvedDir) { $resolvedDir = $layout.DefaultDataDir }
    # Windows PowerShell 5.1 passes 'D:\My Data\' to a native program as "D:\My Data\", which escapes the closing quote.
    if ($resolvedDir -notmatch '^[A-Za-z]:\\$') { $resolvedDir = $resolvedDir.TrimEnd('\') }
    $resolvedPort = $Port
    if ($resolvedPort -le 0 -and $State.ContainsKey('port')) { $resolvedPort = [int]$State['port'] }
    if ($resolvedPort -le 0) { $resolvedPort = $layout.DefaultPort }
    [pscustomobject]@{ DataDir = $resolvedDir; Port = $resolvedPort }
}

function Get-ComposeContainerId {
    param(
        [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][string]$Service,
        [switch]$IncludeStopped
    )
    $arguments = @('ps', '-q')
    if ($IncludeStopped) { $arguments += '-a' }
    $arguments += @(
        '--filter', "label=com.docker.compose.project=$Project",
        '--filter', "label=com.docker.compose.service=$Service"
    )
    $result = Invoke-NativeCommand -FilePath 'docker' -ArgumentList $arguments -Capture
    if ($result.ExitCode -ne 0) { return $null }
    # Output also holds stderr, so a docker warning must not pass for a container id.
    @($result.Output | Where-Object { $_ -match '^[0-9a-f]{12,64}$' }) | Select-Object -First 1
}

function Get-DatabaseContainerId {
    param([switch]$IncludeStopped)
    $layout = Get-DatabaseLayout
    Get-ComposeContainerId -Project $layout.ProjectName -Service $layout.ServiceName -IncludeStopped:$IncludeStopped
}

function Get-ContainerHealth {
    param([Parameter(Mandatory)][string]$ContainerId)
    $format = '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
    $result = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('inspect', '--format', $format, $ContainerId) -Capture
    if ($result.ExitCode -ne 0) { return 'unknown' }
    [string](@($result.Output) | Select-Object -First 1)
}

function Get-DockerImageId {
    param([Parameter(Mandatory)][string]$Name)
    $result = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('image', 'inspect', '--format', '{{.Id}}', $Name) -Capture
    if ($result.ExitCode -ne 0) { return $null }
    @($result.Output | Where-Object { $_ -match '^sha256:[0-9a-f]{64}$' }) | Select-Object -First 1
}

function Get-SetupExitCode {
    param([Parameter(Mandatory)][ValidateSet('Ready', 'Error', 'UserAction', 'Reboot')][string]$Name)
    $script:ExitCodes[$Name]
}

function Show-SetupStep {
    param(
        [Parameter(Mandatory)][int]$Number,
        [Parameter(Mandatory)][int]$Total,
        [Parameter(Mandatory)][string]$Title
    )
    Write-Host ''
    Write-Host ('[{0}/{1}] {2}' -f $Number, $Total, $Title)
}

function Show-SetupStatus {
    param(
        [Parameter(Mandatory)][ValidateSet('OK', 'INSTALLED', 'ACTION', 'FAILED', 'SKIPPED')][string]$Status,
        [AllowEmptyString()][string]$Message = ''
    )
    # One Write-Host call per line: the status word carries the meaning, colour is extra.
    Write-Host ('  {0,-9} {1}' -f $Status, $Message) -ForegroundColor $script:StatusColors[$Status]
}

function Show-SetupMessage {
    param(
        [AllowEmptyString()][string]$Text = '',
        [string]$Color = ''
    )
    if ($Color) { Write-Host $Text -ForegroundColor $Color }
    else { Write-Host $Text }
}

function Format-SetupResultLine {
    param([Parameter(Mandatory)][object]$Result)
    if ($Result.Message) { '{0}: {1}' -f $Result.Name, $Result.Message }
    else { [string]$Result.Name }
}

function Show-SetupResult {
    param([Parameter(Mandatory)][object]$Result)
    Show-SetupStatus -Status $Result.Status -Message (Format-SetupResultLine -Result $Result)
    if ($Result.PSObject.Properties['Hint']) {
        foreach ($line in @($Result.Hint | Where-Object { $_ })) { Write-Host ((' ' * 12) + $line) }
    }
}

function Add-SetupResult {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$List,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('OK', 'INSTALLED', 'ACTION', 'FAILED', 'SKIPPED')][string]$Status,
        [AllowEmptyString()][string]$Message = '',
        [AllowEmptyCollection()][string[]]$Hint = @(),
        [switch]$Advisory,
        [switch]$RebootRequired,
        [switch]$Quiet
    )
    # Hints travel in the result file, so setup.ps1 can repeat them after the administrator window closes.
    $result = [pscustomobject]@{
        Name = $Name
        Status = $Status
        Message = $Message
        Hint = @($Hint)
        Advisory = [bool]$Advisory
        RebootRequired = [bool]$RebootRequired
    }
    $List.Add($result)
    if (-not $Quiet) { Show-SetupResult -Result $result }
}

function Get-CombinedExitCode {
    param([AllowEmptyCollection()][AllowNull()][object[]]$Results = @())
    $items = @($Results | Where-Object { $null -ne $_ })
    if (@($items | Where-Object { $_.Status -eq 'FAILED' }).Count -gt 0) { return $script:ExitCodes.Error }
    if (@($items | Where-Object { $_.RebootRequired }).Count -gt 0) { return $script:ExitCodes.Reboot }
    if (@($items | Where-Object { $_.Status -eq 'ACTION' -and -not $_.Advisory }).Count -gt 0) { return $script:ExitCodes.UserAction }
    $script:ExitCodes.Ready
}

function Get-SetupNextStep {
    param([Parameter(Mandatory)][int]$InstallExitCode)
    switch ($InstallExitCode) {
        0 { 'Continue' }
        2 { 'UserAction' }
        3010 { 'Reboot' }
        default { 'Error' }
    }
}

function Resolve-WingetExitCode {
    param([Parameter(Mandatory)][long]$ExitCode)
    if ($ExitCode -eq 0) { return 'INSTALLED' }
    if ($script:WingetAlreadyPresent -contains $ExitCode) { return 'OK' }
    if ($script:WingetReboot -contains $ExitCode) { return 'REBOOT' }
    'FAILED'
}

function Export-SetupResult {
    param(
        [Parameter(Mandatory)][string]$Path,
        [AllowEmptyCollection()][AllowNull()][object[]]$Results = @(),
        [Parameter(Mandatory)][int]$ExitCode
    )
    $payload = [pscustomobject]@{
        ExitCode = $ExitCode
        Results = @($Results | Where-Object { $null -ne $_ })
    }
    $directory = Split-Path -Parent (Resolve-FullPath $Path)
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    Write-Utf8LfFile -Path $Path -Text (ConvertTo-Json -InputObject $payload -Depth 5)
}

function Import-SetupResult {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $json = [System.IO.File]::ReadAllText((Resolve-FullPath $Path)) | ConvertFrom-Json
    [pscustomobject]@{
        ExitCode = [int]$json.ExitCode
        Results = @($json.Results | Where-Object { $null -ne $_ })
    }
}

function Get-RandomSecret {
    param([ValidateRange(16, 256)][int]$Length = 32)
    $alphabet = $script:SecretAlphabet
    # Rejection sampling: only bytes below 248 (4 x 62) are used, so every character is equally likely.
    $limit = 256 - (256 % $alphabet.Length)
    $builder = New-Object System.Text.StringBuilder
    $buffer = New-Object byte[] 64
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        while ($builder.Length -lt $Length) {
            $rng.GetBytes($buffer)
            foreach ($byte in $buffer) {
                if ($byte -lt $limit -and $builder.Length -lt $Length) {
                    [void]$builder.Append($alphabet[$byte % $alphabet.Length])
                }
            }
        }
    }
    finally {
        $rng.Dispose()
    }
    $builder.ToString()
}

function ConvertFrom-EnvValue {
    param([AllowEmptyString()][string]$Value)
    $trimmed = $Value.Trim()
    if ($trimmed.Length -ge 2) {
        $first = $trimmed[0]
        if (($first -eq '"' -or $first -eq "'") -and $trimmed[$trimmed.Length - 1] -eq $first) {
            return $trimmed.Substring(1, $trimmed.Length - 2)
        }
    }
    $trimmed
}

function ConvertFrom-EnvText {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    $values = [ordered]@{}
    if (-not $Text) { return $values }
    foreach ($line in ($Text -split "\r?\n")) {
        if ($line -match '^\s*#') { continue }
        if ($line -match $script:EnvLinePattern) {
            $values[$Matches[1]] = ConvertFrom-EnvValue -Value $Matches[2]
        }
    }
    $values
}

function Read-EnvFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [ordered]@{} }
    ConvertFrom-EnvText -Text ([System.IO.File]::ReadAllText((Resolve-FullPath $Path)))
}

function Merge-EnvText {
    param(
        [AllowEmptyString()][AllowNull()][string]$Text,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Values,
        [switch]$ReplaceExisting
    )
    $lines = New-Object System.Collections.Generic.List[string]
    if ($Text) {
        foreach ($line in ($Text -split "\r?\n")) { $lines.Add($line) }
    }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }

    $seen = @{}
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*#') { continue }
        if ($lines[$i] -notmatch $script:EnvLinePattern) { continue }
        $key = $Matches[1]
        if (-not $Values.Contains($key)) { continue }
        $seen[$key] = $true
        $current = ConvertFrom-EnvValue -Value $Matches[2]
        # An empty value counts as missing; a filled one is never touched unless asked.
        if ($ReplaceExisting -or $current -eq '') { $lines[$i] = '{0}={1}' -f $key, $Values[$key] }
    }
    foreach ($key in $Values.Keys) {
        if (-not $seen.ContainsKey($key)) { $lines.Add(('{0}={1}' -f $key, $Values[$key])) }
    }
    ($lines -join "`n") + "`n"
}

function Write-Utf8LfFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text
    )
    $normalized = $Text -replace "`r`n", "`n"
    if (-not $normalized.EndsWith("`n")) { $normalized += "`n" }
    $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText((Resolve-FullPath $Path), $normalized, $encoding)
}

function Read-SetupState {
    param([Parameter(Mandatory)][string]$Path)
    $state = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $state }
    try {
        $json = [System.IO.File]::ReadAllText((Resolve-FullPath $Path)) | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Write-Verbose "Ignoring unreadable state file $Path"
        return $state
    }
    if ($null -eq $json) { return $state }
    foreach ($property in $json.PSObject.Properties) { $state[$property.Name] = $property.Value }
    $state
}

function Save-SetupState {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$State
    )
    $directory = Split-Path -Parent (Resolve-FullPath $Path)
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    Write-Utf8LfFile -Path $Path -Text (ConvertTo-Json -InputObject $State -Depth 5)
}

function ConvertTo-SetupVersion {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    if (-not $Text) { return $null }
    if ($Text -notmatch '(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?') { return $null }
    $parts = foreach ($index in 1..4) {
        if ($Matches.ContainsKey($index)) { [int]$Matches[$index] } else { 0 }
    }
    New-Object System.Version -ArgumentList $parts
}

function Test-VersionAtLeast {
    param(
        [AllowEmptyString()][AllowNull()][string]$Version,
        [Parameter(Mandatory)][string]$Minimum
    )
    $actual = ConvertTo-SetupVersion -Text $Version
    if ($null -eq $actual) { return $false }
    $actual -ge (ConvertTo-SetupVersion -Text $Minimum)
}

function Get-MajorVersion {
    param([AllowEmptyString()][AllowNull()][string]$Version)
    $parsed = ConvertTo-SetupVersion -Text $Version
    if ($null -eq $parsed) { return $null }
    $parsed.Major
}

function Get-RequiredNodeMajor {
    param([Parameter(Mandatory)][string]$NvmrcPath)
    if (-not (Test-Path -LiteralPath $NvmrcPath -PathType Leaf)) { return $null }
    $text = ([System.IO.File]::ReadAllText((Resolve-FullPath $NvmrcPath))).Trim()
    if ($text -notmatch '^v?\d+') { return $null }
    Get-MajorVersion -Version $text
}

function Format-PostgresUrl {
    param(
        [Parameter(Mandatory)][string]$User,
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][string]$HostName,
        [ValidateRange(1, 65535)][int]$Port = 5432,
        [Parameter(Mandatory)][string]$Database
    )
    'postgresql://{0}:{1}@{2}:{3}/{4}' -f [uri]::EscapeDataString($User), [uri]::EscapeDataString($Secret),
        $HostName, $Port, [uri]::EscapeDataString($Database)
}

function Format-DevConnectionLine {
    param(
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][string]$HostName,
        [ValidateRange(1, 65535)][int]$Port = 5432
    )
    'DATABASE_URL=' + (Format-PostgresUrl -User 'allin_dev' -Secret $Secret -HostName $HostName -Port $Port -Database 'allin_dev')
    'TEST_DATABASE_URL=' + (Format-PostgresUrl -User 'allin_dev' -Secret $Secret -HostName $HostName -Port $Port -Database 'allin_test')
}

function Get-RefreshedPath {
    param(
        [AllowEmptyString()][AllowNull()][string]$MachinePath,
        [AllowEmptyString()][AllowNull()][string]$UserPath,
        [AllowEmptyString()][AllowNull()][string]$CurrentPath
    )
    $entries = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' -ArgumentList ([System.StringComparer]::OrdinalIgnoreCase)
    # Registry entries first, so a fresh install wins; entries only this process has (npm's .bin) stay at the end.
    foreach ($source in @($MachinePath, $UserPath, $CurrentPath)) {
        if (-not $source) { continue }
        foreach ($entry in $source.Split(';')) {
            $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim())
            if (-not $expanded) { continue }
            $key = $expanded.TrimEnd('\')
            if (-not $key) { $key = $expanded }
            if ($seen.Add($key)) { $entries.Add($expanded) }
        }
    }
    $entries -join ';'
}

function Sync-SessionPath {
    $env:Path = Get-RefreshedPath -MachinePath ([Environment]::GetEnvironmentVariable('Path', 'Machine')) `
        -UserPath ([Environment]::GetEnvironmentVariable('Path', 'User')) -CurrentPath $env:Path
}

function ConvertTo-MaskedText {
    param(
        [AllowEmptyString()][AllowNull()][string]$Text,
        [AllowEmptyCollection()][AllowNull()][string[]]$Secret = @()
    )
    if (-not $Text) { return $Text }
    $masked = $Text
    $secrets = @($Secret | Where-Object { $_ -and $_.Length -ge 4 } | Sort-Object -Property Length -Descending)
    foreach ($value in $secrets) {
        $masked = $masked.Replace($value, $script:Mask)
        $encoded = [uri]::EscapeDataString($value)
        if ($encoded -ne $value) { $masked = $masked.Replace($encoded, $script:Mask) }
    }
    $masked
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [AllowEmptyCollection()][string[]]$ArgumentList = @(),
        [AllowEmptyString()][string]$InputText,
        [AllowEmptyCollection()][string[]]$Secret = @(),
        [hashtable]$Environment = @{},
        [switch]$Capture,
        [string]$Indent = '    '
    )
    # Native stderr arrives as ErrorRecords through 2>&1; with Stop that would throw in 5.1.
    $ErrorActionPreference = 'Continue'
    $lines = New-Object System.Collections.Generic.List[string]
    $handler = {
        $line = ConvertTo-MaskedText -Text ([string]$_) -Secret $Secret
        if ($Capture) { $lines.Add($line) }
        else { Show-SetupMessage -Text ($Indent + $line) -Color 'DarkGray' }
    }
    $previousEncoding = $null
    try {
        $previousEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
    }
    catch {
        Write-Verbose 'No console attached; keeping the output encoding.'
    }
    $savedEnvironment = @{}
    try {
        # The variables reach only this child process; the previous values come back afterwards.
        foreach ($name in @($Environment.Keys)) {
            $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, [string]$Environment[$name], 'Process')
        }
        if ($PSBoundParameters.ContainsKey('InputText')) {
            $InputText | & $FilePath @ArgumentList 2>&1 | ForEach-Object -Process $handler
        }
        else {
            & $FilePath @ArgumentList 2>&1 | ForEach-Object -Process $handler
        }
        $exitCode = $LASTEXITCODE
    }
    finally {
        if ($null -ne $previousEncoding) {
            try { [Console]::OutputEncoding = $previousEncoding }
            catch { Write-Verbose 'Could not restore the console output encoding.' }
        }
        foreach ($name in @($savedEnvironment.Keys)) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    }
    [pscustomobject]@{
        ExitCode = $exitCode
        Output = $lines.ToArray()
    }
}

function ConvertTo-ArgumentString {
    param([AllowEmptyCollection()][AllowNull()][string[]]$ArgumentList = @())
    # Quoting rules of CommandLineToArgvW, which powershell.exe and cmd-started programs use.
    $quoted = foreach ($argument in @($ArgumentList)) {
        if ($argument -eq '') { '""' }
        elseif ($argument -notmatch '[\s"]') { $argument }
        else {
            $escaped = [regex]::Replace($argument, '(\\*)"', { param($m) ($m.Groups[1].Value * 2) + '\"' })
            $escaped = [regex]::Replace($escaped, '(\\+)$', { param($m) $m.Groups[1].Value * 2 })
            '"' + $escaped + '"'
        }
    }
    @($quoted) -join ' '
}

function ConvertTo-ArgumentList {
    param(
        [AllowNull()][System.Collections.IDictionary]$BoundParameters,
        [string[]]$Exclude = @()
    )
    $list = New-Object System.Collections.Generic.List[string]
    if ($null -eq $BoundParameters) { return }
    foreach ($key in $BoundParameters.Keys) {
        if ($Exclude -contains $key) { continue }
        $value = $BoundParameters[$key]
        if ($value -is [System.Management.Automation.SwitchParameter]) {
            if ($value.IsPresent) { $list.Add("-$key") }
            continue
        }
        if ($value -is [bool]) {
            if ($value) { $list.Add("-$key") }
            continue
        }
        $list.Add("-$key")
        $list.Add([string]$value)
    }
    $list.ToArray()
}

function Get-ResumeCommand {
    param(
        [Parameter(Mandatory)][string]$SetupCmdPath,
        [AllowEmptyCollection()][string[]]$ArgumentList = @(),
        [string]$CommandProcessor = $env:ComSpec
    )
    $inner = ConvertTo-ArgumentString -ArgumentList (@($SetupCmdPath) + @($ArgumentList))
    '{0} /c "{1}"' -f (ConvertTo-ArgumentString -ArgumentList @($CommandProcessor)), $inner
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList $identity
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-CurrentUserSid {
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Test-PendingReboot {
    Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
}

function Test-StartedFromExplorer {
    param([int]$ProcessId = $PID)
    $current = $ProcessId
    for ($depth = 0; $depth -lt 4; $depth++) {
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
        if (-not $process) { return $false }
        $parent = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($process.ParentProcessId)" -ErrorAction SilentlyContinue
        if (-not $parent) { return $false }
        if ($parent.Name -eq 'explorer.exe') { return $true }
        if ($parent.Name -ne 'cmd.exe') { return $false }
        $current = $parent.ProcessId
    }
    $false
}

function Get-SecretFileSid {
    param([string]$UserSid = (Get-CurrentUserSid))
    @($UserSid, 'S-1-5-32-544', 'S-1-5-18')
}

function Protect-SecretFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$UserSid = (Get-CurrentUserSid)
    )
    $fullPath = Resolve-FullPath $Path
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in (Get-SecretFileSid -UserSid $UserSid)) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier -ArgumentList $sid
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList $identity, 'FullControl', 'Allow'
        $acl.AddAccessRule($rule)
    }
    # Only the DACL was touched, so only the DACL is written; the owner stays as it is.
    [System.IO.File]::SetAccessControl($fullPath, $acl)
}

function Test-SecretFileProtected {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$UserSid = (Get-CurrentUserSid)
    )
    $fullPath = Resolve-FullPath $Path
    $acl = [System.IO.File]::GetAccessControl($fullPath)
    if (-not $acl.AreAccessRulesProtected) { return $false }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $expected = @(Get-SecretFileSid -UserSid $UserSid)
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne 'Allow') { return $false }
        if ($expected -notcontains $rule.IdentityReference.Value) { return $false }
    }
    foreach ($sid in $expected) {
        $match = @($rules | Where-Object {
                $_.IdentityReference.Value -eq $sid -and
                ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl
            })
        if ($match.Count -eq 0) { return $false }
    }
    $true
}

function Test-TcpPort {
    param(
        [Parameter(Mandatory)][string]$HostName,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [int]$TimeoutMilliseconds = 3000
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) { return $false }
        $client.EndConnect($pending)
        $true
    }
    catch {
        $false
    }
    finally {
        $client.Close()
    }
}

function Get-LanAddress {
    $configuration = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {
            $_.IPv4DefaultGateway -and $_.NetAdapter -and "$($_.NetAdapter.Status)" -eq 'Up'
        }) | Select-Object -First 1
    if (-not $configuration) { return $null }
    [pscustomobject]@{
        IPv4 = @($configuration.IPv4Address)[0].IPAddress
        Mac = $configuration.NetAdapter.MacAddress
        InterfaceAlias = $configuration.InterfaceAlias
    }
}

function Read-SecretValue {
    param([Parameter(Mandatory)][string]$Prompt)
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Get-BotLayout {
    [pscustomobject]@{
        ProjectName = 'all-in'
        ServiceName = 'bot'
        ImageName = 'all-in-bot'
        ContainerName = 'all-in-bot-1'
        ComposeFile = 'deploy\compose.yaml'
        EnvFileName = 'bot.env'
        EnvFileVariable = 'ALLIN_BOT_ENV_FILE'
        EnvFileHeader = '# All-in production bot. Written by setup.cmd (scripts/setup/init.ps1), which never overwrites a value.'
        DatabaseHost = 'host.docker.internal'
        DatabaseName = 'allin'
        DatabaseRole = 'allin'
        RequiredKeys = @('DATABASE_URL', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID')
        EmptyKeys = @('DEV_GUILD_ID', 'TEST_DATABASE_URL')
        PrintCommand = @('node', 'dist/deploy-commands.js', '--print')
        RegisterCommand = @('node', 'dist/deploy-commands.js')
        CommandsHashKey = 'botCommandsHash'
        WaitSeconds = 180
        LogCommand = 'docker logs --tail 100 all-in-bot-1'
    }
}

function Get-MissingBotKey {
    param([AllowNull()][System.Collections.IDictionary]$Value)
    if ($null -eq $Value) { $Value = @{} }
    foreach ($key in (Get-BotLayout).RequiredKeys) {
        if (-not ([string]$Value[$key]).Trim()) { $key }
    }
}

function Test-DiscordId {
    param([AllowEmptyString()][AllowNull()][string]$Value)
    $Value -match '^[0-9]{17,20}$'
}

function Test-DiscordToken {
    param([AllowEmptyString()][AllowNull()][string]$Value)
    # A bot token has three dot-separated parts; this catches a pasted client secret or public key.
    $Value -match '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
}

function Merge-BotEnvText {
    param(
        [AllowEmptyString()][AllowNull()][string]$Text,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Values,
        [switch]$FromTemplate
    )
    if (-not $FromTemplate) { return Merge-EnvText -Text $Text -Values $Values }
    $layout = Get-BotLayout
    # Every key the bot reads from the template gets this setup's value, so no example value survives.
    $managed = [ordered]@{}
    foreach ($key in $layout.RequiredKeys) { $managed[$key] = [string]$Values[$key] }
    foreach ($key in $layout.EmptyKeys) { $managed[$key] = '' }
    Merge-EnvText -Text ($layout.EnvFileHeader + "`n" + $Text) -Values $managed -ReplaceExisting
}

function Write-BotEnvFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [AllowEmptyString()][AllowNull()][string]$Template,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Values
    )
    $fullPath = Resolve-FullPath $Path
    $created = -not (Test-Path -LiteralPath $fullPath -PathType Leaf)
    $before = ''
    if ($created) {
        # Restricted while still empty, so the token is never readable by others.
        New-Item -ItemType File -Path $fullPath -ErrorAction Stop | Out-Null
        Protect-SecretFile -Path $fullPath
        $text = Merge-BotEnvText -Text $Template -Values $Values -FromTemplate
    }
    else {
        $before = [System.IO.File]::ReadAllText($fullPath)
        $text = Merge-BotEnvText -Text $before -Values $Values
    }
    if ($text -cne $before) { Write-Utf8LfFile -Path $fullPath -Text $text }
    $restricted = $false
    if (-not (Test-SecretFileProtected -Path $fullPath)) {
        Protect-SecretFile -Path $fullPath
        $restricted = $true
    }
    [pscustomobject]@{ Created = $created; Restricted = $restricted }
}

function Get-BotComposeArgument {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string[]]$Command
    )
    $layout = Get-BotLayout
    @('compose', '--project-name', $layout.ProjectName, '--file', (Join-Path $RepoRoot $layout.ComposeFile)) + $Command
}

function Get-BotComposeEnvironment {
    param([Parameter(Mandatory)][string]$DataDir)
    $layout = Get-BotLayout
    $environment = @{}
    # Forward slashes, like the backup folder that step 4 passes to the database's compose file.
    $environment[$layout.EnvFileVariable] = (Join-Path $DataDir $layout.EnvFileName).Replace('\', '/')
    $environment
}

function Invoke-BotCompose {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$DataDir,
        [Parameter(Mandatory)][string[]]$Command,
        [AllowEmptyCollection()][string[]]$Secret = @(),
        [hashtable]$Environment = @{},
        [switch]$Capture
    )
    $arguments = Get-BotComposeArgument -RepoRoot $RepoRoot -Command $Command
    $variables = Get-BotComposeEnvironment -DataDir $DataDir
    foreach ($name in @($Environment.Keys)) { $variables[$name] = $Environment[$name] }
    # An empty stdin instead of the console: docker never waits for input, so -NonInteractive holds.
    Invoke-NativeCommand -FilePath 'docker' -ArgumentList $arguments -InputText '' -Environment $variables -Secret $Secret -Capture:$Capture
}

function Get-CommandDefinition {
    param([AllowEmptyCollection()][AllowNull()][string[]]$Output = @())
    # docker compose mixes its own lines into the output; the definitions are the one JSON array.
    $candidates = @($Output | Where-Object { $_ -match '^\s*\[(\]|\{.*\}\])\s*$' } | ForEach-Object { $_.Trim() })
    for ($i = $candidates.Count - 1; $i -ge 0; $i--) {
        try {
            $parsed = ConvertFrom-Json -InputObject $candidates[$i] -ErrorAction Stop
        }
        catch {
            continue
        }
        $count = 0
        if ($candidates[$i] -ne '[]') { $count = @($parsed).Count }
        return [pscustomobject]@{ Json = $candidates[$i]; Count = $count }
    }
    $null
}

function Get-CommandDefinitionHash {
    param(
        [Parameter(Mandatory)][string]$Json,
        [AllowEmptyString()][string]$ClientId = '',
        [AllowEmptyString()][string]$GuildId = ''
    )
    # The target is part of the hash, so another application or server gets its own registration.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(("{0}`n{1}`n{2}" -f $ClientId, $GuildId, $Json))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    }
    finally {
        $sha.Dispose()
    }
}

function Read-BotValue {
    param([AllowEmptyCollection()][string[]]$Missing = @())
    $answers = [ordered]@{}
    Show-SetupMessage -Text '  bot.env needs your production application from the Discord Developer Portal (not the development one).'
    if ($Missing -contains 'DISCORD_TOKEN') {
        $token = ([string](Read-SecretValue -Prompt '  Bot token (Bot > Reset Token; hidden)')).Trim()
        if (Test-DiscordToken -Value $token) { $answers['DISCORD_TOKEN'] = $token }
        elseif ($token) { Show-SetupMessage -Text '  That is not a bot token (three parts separated by dots), so it was not saved.' }
    }
    if ($Missing -contains 'DISCORD_CLIENT_ID') {
        $clientId = ([string](Read-Host -Prompt '  Application ID (General Information)')).Trim()
        if (Test-DiscordId -Value $clientId) { $answers['DISCORD_CLIENT_ID'] = $clientId }
        elseif ($clientId) { Show-SetupMessage -Text '  That is not an application ID (17 to 20 digits), so it was not saved.' }
    }
    $answers
}

function Invoke-BotEnvAction {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$DataDir,
        [ValidateRange(1, 65535)][int]$Port = 5432,
        [switch]$CheckOnly,
        [switch]$NonInteractive
    )
    $layout = Get-BotLayout
    $name = 'bot.env'
    $path = Join-Path $DataDir $layout.EnvFileName
    $exists = Test-Path -LiteralPath $path -PathType Leaf
    $missing = @(Get-MissingBotKey -Value (Read-EnvFile -Path $path))
    $restricted = (-not $exists) -or (Test-SecretFileProtected -Path $path)
    if ($exists -and $missing.Count -eq 0 -and $restricted) {
        Add-SetupResult -List $Results -Name $name -Status OK -Message "$path (complete and private)"
        return $true
    }
    if ($CheckOnly) {
        $message = "$path doesn't exist yet; init.ps1 creates it and asks for the production bot token"
        if ($exists) {
            $todo = @()
            if ($missing.Count -gt 0) { $todo += 'fill in ' + ($missing -join ', ') }
            if (-not $restricted) { $todo += 'restrict it to you, Administrators and SYSTEM' }
            $message = '{0}: {1}; init.ps1 does this' -f $path, ($todo -join ' and ')
        }
        Add-SetupResult -List $Results -Name $name -Status ACTION -Message $message
        return $false
    }

    $values = [ordered]@{}
    if ($missing -contains 'DATABASE_URL') {
        $role = @((Get-DatabaseLayout).Roles | Where-Object { $_.Name -eq $layout.DatabaseRole })[0]
        $dataValues = Read-EnvFile -Path (Join-Path $DataDir '.env')
        $secret = [string]$dataValues[$role.SecretKey]
        if ($secret) {
            $values['DATABASE_URL'] = Format-PostgresUrl -User $layout.DatabaseRole -Secret $secret -HostName $layout.DatabaseHost -Port $Port -Database $layout.DatabaseName
        }
    }
    $asked = @($missing | Where-Object { $_ -ne 'DATABASE_URL' })
    if ($asked.Count -gt 0 -and -not $NonInteractive) {
        $answers = Read-BotValue -Missing $asked
        foreach ($key in @($answers.Keys)) { $values[$key] = $answers[$key] }
    }
    $template = ''
    $templatePath = Join-Path $RepoRoot '.env.example'
    if (Test-Path -LiteralPath $templatePath -PathType Leaf) { $template = [System.IO.File]::ReadAllText($templatePath) }
    $written = Write-BotEnvFile -Path $path -Template $template -Values $values

    $stillMissing = @(Get-MissingBotKey -Value (Read-EnvFile -Path $path))
    if ($stillMissing.Count -gt 0) {
        Add-SetupResult -List $Results -Name $name -Status ACTION -Message ('fill in {0} in {1}, then run setup.cmd again' -f ($stillMissing -join ', '), $path) -Hint @(
            'From your production application in the Discord Developer Portal: Bot > Reset Token, and General Information > Application ID.'
            'Or run .\setup.cmd in a terminal to be asked for them.'
        )
        return $false
    }
    $changes = New-Object System.Collections.Generic.List[string]
    if ($written.Created) { $changes.Add('created it') }
    $filled = @($values.Keys | Where-Object { $values[$_] })
    if ($filled.Count -gt 0) { $changes.Add('filled in ' + ($filled -join ', ')) }
    if ($written.Restricted) { $changes.Add('restricted it to you, Administrators and SYSTEM') }
    if ($changes.Count -eq 0) { Add-SetupResult -List $Results -Name $name -Status OK -Message "$path (complete and private)" }
    else { Add-SetupResult -List $Results -Name $name -Status INSTALLED -Message ('{0}: {1}' -f $path, ($changes -join ', ')) }
    $true
}

function Invoke-BotImageAction {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$DataDir,
        [AllowEmptyCollection()][string[]]$Secret = @()
    )
    $layout = Get-BotLayout
    $name = 'Bot image'
    $before = Get-DockerImageId -Name $layout.ImageName
    Show-SetupMessage -Text '  docker compose build (the first build downloads node:26-slim and the npm packages) ...'
    # Compose before v5.5.1 ignores provenance: false in compose.yaml; buildx honours this variable on every version.
    $run = Invoke-BotCompose -RepoRoot $RepoRoot -DataDir $DataDir -Secret $Secret -Command @('build', $layout.ServiceName) -Environment @{ BUILDX_NO_DEFAULT_ATTESTATIONS = '1' }
    if ($run.ExitCode -ne 0) {
        Add-SetupResult -List $Results -Name $name -Status FAILED -Message "docker compose build failed with exit code $($run.ExitCode); see the output above"
        return $false
    }
    $after = Get-DockerImageId -Name $layout.ImageName
    if (-not $after) {
        Add-SetupResult -List $Results -Name $name -Status FAILED -Message "docker compose build succeeded, but the image $($layout.ImageName) is missing"
        return $false
    }
    if ($after -eq $before) { Add-SetupResult -List $Results -Name $name -Status OK -Message "$($layout.ImageName) matches this checkout" }
    else { Add-SetupResult -List $Results -Name $name -Status INSTALLED -Message "built $($layout.ImageName) from this checkout" }
    $true
}

function Invoke-BotCommandAction {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$DataDir,
        [Parameter(Mandatory)][hashtable]$State,
        [Parameter(Mandatory)][string]$StatePath,
        [AllowEmptyCollection()][string[]]$Secret = @()
    )
    $layout = Get-BotLayout
    $name = 'Slash commands'
    $oneOff = @('run', '--rm', '-T', $layout.ServiceName)
    $print = Invoke-BotCompose -RepoRoot $RepoRoot -DataDir $DataDir -Secret $Secret -Command ($oneOff + $layout.PrintCommand) -Capture
    $definition = $null
    if ($print.ExitCode -eq 0) { $definition = Get-CommandDefinition -Output $print.Output }
    if ($null -eq $definition) {
        Add-SetupResult -List $Results -Name $name -Status FAILED -Message "the bot image printed no command definitions (exit code $($print.ExitCode))" -Hint @($print.Output | Select-Object -Last 10)
        return $false
    }
    $values = Read-EnvFile -Path (Join-Path $DataDir $layout.EnvFileName)
    $guildId = [string]$values['DEV_GUILD_ID']
    $hash = Get-CommandDefinitionHash -Json $definition.Json -ClientId ([string]$values['DISCORD_CLIENT_ID']) -GuildId $guildId
    $scope = 'globally'
    if ($guildId) { $scope = "in server $guildId" }
    if ([string]$State[$layout.CommandsHashKey] -eq $hash) {
        Add-SetupResult -List $Results -Name $name -Status OK -Message ('{0} commands, registered {1}; unchanged since then' -f $definition.Count, $scope)
        return $true
    }
    Show-SetupMessage -Text ('  The command definitions changed; registering {0} commands {1} ...' -f $definition.Count, $scope)
    $register = Invoke-BotCompose -RepoRoot $RepoRoot -DataDir $DataDir -Secret $Secret -Command ($oneOff + $layout.RegisterCommand)
    if ($register.ExitCode -ne 0) {
        Add-SetupResult -List $Results -Name $name -Status FAILED -Message "registering the commands failed with exit code $($register.ExitCode); see the output above"
        return $false
    }
    $State[$layout.CommandsHashKey] = $hash
    Save-SetupState -Path $StatePath -State $State
    Add-SetupResult -List $Results -Name $name -Status INSTALLED -Message ('registered {0} commands {1}' -f $definition.Count, $scope)
    $true
}

function Invoke-BotContainerAction {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$DataDir,
        [AllowEmptyCollection()][string[]]$Secret = @(),
        [switch]$CheckOnly
    )
    $layout = Get-BotLayout
    $name = 'Bot container'
    $logHint = @("Its log says why: $($layout.LogCommand)")
    $before = Get-ComposeContainerId -Project $layout.ProjectName -Service $layout.ServiceName
    if ($CheckOnly) {
        if (-not $before) {
            Add-SetupResult -List $Results -Name $name -Status ACTION -Message 'not running; init.ps1 builds and starts it'
            return
        }
        $health = Get-ContainerHealth -ContainerId $before
        if ($health -eq 'healthy') { Add-SetupResult -List $Results -Name $name -Status OK -Message 'running and logged in to Discord' }
        else { Add-SetupResult -List $Results -Name $name -Status ACTION -Message "running, but $health" -Hint $logHint }
        return
    }
    Show-SetupMessage -Text ('  docker compose up, waiting until the bot is logged in to Discord (at most {0} seconds) ...' -f $layout.WaitSeconds)
    $run = Invoke-BotCompose -RepoRoot $RepoRoot -DataDir $DataDir -Secret $Secret -Command @('up', '--detach', '--wait', '--wait-timeout', [string]$layout.WaitSeconds)
    if ($run.ExitCode -ne 0) {
        Add-SetupResult -List $Results -Name $name -Status FAILED -Message "the bot is not online; docker compose up failed with exit code $($run.ExitCode)" -Hint $logHint
        return
    }
    $after = Get-ComposeContainerId -Project $layout.ProjectName -Service $layout.ServiceName
    if ($after -and $after -eq $before) { Add-SetupResult -List $Results -Name $name -Status OK -Message 'running and logged in to Discord' }
    else { Add-SetupResult -List $Results -Name $name -Status INSTALLED -Message 'started; the bot is logged in to Discord' }
}

function Invoke-BotDeployment {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$DataDir,
        [ValidateRange(1, 65535)][int]$Port = 5432,
        [Parameter(Mandatory)][hashtable]$State,
        [Parameter(Mandatory)][string]$StatePath,
        [AllowEmptyCollection()][string[]]$Secret = @(),
        [switch]$CheckOnly,
        [switch]$NonInteractive,
        [switch]$DataReady,
        [switch]$DockerReady,
        [switch]$DatabaseReady
    )
    $layout = Get-BotLayout
    $envReady = $false
    if ($DataReady) {
        $envReady = Invoke-BotEnvAction -Results $Results -RepoRoot $RepoRoot -DataDir $DataDir -Port $Port -CheckOnly:$CheckOnly -NonInteractive:$NonInteractive
    }
    else {
        Add-SetupResult -List $Results -Name 'bot.env' -Status SKIPPED -Message 'needs the data directory (step 3)'
    }
    if ($CheckOnly) {
        Add-SetupResult -List $Results -Name 'Bot image' -Status SKIPPED -Message 'not checked in check-only mode; a full run builds it from this checkout'
        Add-SetupResult -List $Results -Name 'Slash commands' -Status SKIPPED -Message 'not checked in check-only mode; a full run registers them when their definitions changed'
        if ($DockerReady) { Invoke-BotContainerAction -Results $Results -RepoRoot $RepoRoot -DataDir $DataDir -CheckOnly }
        else { Add-SetupResult -List $Results -Name 'Bot container' -Status SKIPPED -Message 'needs the Docker engine (step 2)' }
        return
    }

    $blocked = ''
    if (-not $DockerReady) { $blocked = 'needs the Docker engine (step 2)' }
    elseif (-not $envReady) { $blocked = 'needs a complete bot.env (above)' }
    elseif (-not $DatabaseReady) { $blocked = 'needs the roles and databases (step 5)' }
    $botSecret = @($Secret)
    if (-not $blocked) {
        $botValues = Read-EnvFile -Path (Join-Path $DataDir $layout.EnvFileName)
        $botSecret += [string]$botValues['DISCORD_TOKEN']
    }
    $actions = @{ Results = $Results; RepoRoot = $RepoRoot; DataDir = $DataDir; Secret = $botSecret }

    if ($blocked) { Add-SetupResult -List $Results -Name 'Bot image' -Status SKIPPED -Message $blocked }
    elseif (-not (Invoke-BotImageAction @actions)) { $blocked = 'needs the image (above); the running bot was left alone' }

    if ($blocked) { Add-SetupResult -List $Results -Name 'Slash commands' -Status SKIPPED -Message $blocked }
    elseif (-not (Invoke-BotCommandAction @actions -State $State -StatePath $StatePath)) { $blocked = 'needs the slash commands (above); the running bot was left alone' }

    if ($blocked) { Add-SetupResult -List $Results -Name 'Bot container' -Status SKIPPED -Message $blocked }
    else { Invoke-BotContainerAction @actions }
}

function Get-HostMigrationPlan {
    param([switch]$WithBot)
    $layout = Get-DatabaseLayout
    $botDatabase = (Get-BotLayout).DatabaseName
    # The bot container migrates its database itself, after compose has stopped the old bot.
    $targets = foreach ($database in $layout.Databases) {
        if ($WithBot -and $database.Name -eq $botDatabase) { continue }
        $role = @($layout.Roles | Where-Object { $_.Name -eq $database.Owner })[0]
        [pscustomobject]@{ Database = $database.Name; Role = $role.Name; SecretKey = $role.SecretKey }
    }
    $summary = 'allin, allin_dev and allin_test are up to date'
    if ($WithBot) { $summary = 'allin_dev and allin_test are up to date; allin is migrated by the bot container when it starts (step 9)' }
    [pscustomobject]@{ Targets = @($targets); Summary = $summary }
}

function Test-BotDatabaseReady {
    param([AllowEmptyCollection()][AllowNull()][object[]]$Results = @())
    @($Results | Where-Object { $null -ne $_ -and $_.Name -eq 'Roles and databases' -and ($_.Status -eq 'OK' -or $_.Status -eq 'INSTALLED') }).Count -gt 0
}

function Get-RunningBotContainerId {
    param([Parameter(Mandatory)][string]$Database)
    $layout = Get-BotLayout
    if ($Database -ne $layout.DatabaseName) { return $null }
    Get-ComposeContainerId -Project $layout.ProjectName -Service $layout.ServiceName
}

function Invoke-DatabaseRestore {
    param(
        [Parameter(Mandatory)][string]$ContainerId,
        [Parameter(Mandatory)][string]$Database,
        [Parameter(Mandatory)][string]$Owner,
        [Parameter(Mandatory)][string]$DumpName,
        [string]$BotContainerId = ''
    )
    $botName = (Get-BotLayout).ContainerName
    # One transaction: a restore that fails halfway leaves the database as it was.
    $arguments = @('exec', $ContainerId, 'pg_restore', '-U', 'postgres', '--clean', '--if-exists', '--single-transaction', '-d', $Database)
    if ($Database -ne 'allin') { $arguments += @('--no-owner', '--no-acl', "--role=$Owner") }
    $arguments += "/backups/$DumpName"
    if ($BotContainerId) {
        Show-SetupMessage -Text "Stopping the bot ($botName) ..."
        $stop = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('stop', $BotContainerId) -Capture
        if ($stop.ExitCode -ne 0) {
            Show-SetupStatus -Status FAILED -Message "Nothing restored: docker stop $botName failed with exit code $($stop.ExitCode)."
            foreach ($line in @($stop.Output)) { Show-SetupMessage -Text ('    ' + $line) -Color 'DarkGray' }
            return 1
        }
    }
    $exitCode = 1
    try {
        $run = Invoke-NativeCommand -FilePath 'docker' -ArgumentList $arguments
        if ($run.ExitCode -eq 0) {
            Show-SetupStatus -Status OK -Message ('Restored {0} into {1}.' -f $DumpName, $Database)
            $exitCode = 0
        }
        else {
            Show-SetupStatus -Status FAILED -Message "pg_restore reported errors (exit code $($run.ExitCode)); see the output above"
        }
    }
    finally {
        if ($BotContainerId) {
            $start = Invoke-NativeCommand -FilePath 'docker' -ArgumentList @('start', $BotContainerId) -Capture
            if ($start.ExitCode -eq 0) {
                Show-SetupStatus -Status OK -Message "Started the bot again ($botName); it refunds the open rounds before it logs in."
            }
            else {
                Show-SetupStatus -Status FAILED -Message "The bot did not start again (exit code $($start.ExitCode)); start it with: docker start $botName"
                foreach ($line in @($start.Output)) { Show-SetupMessage -Text ('    ' + $line) -Color 'DarkGray' }
                $exitCode = 1
            }
        }
    }
    $exitCode
}

Export-ModuleMember -Function *
