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

function Get-DatabaseContainerId {
    param([switch]$IncludeStopped)
    $layout = Get-DatabaseLayout
    $arguments = @('ps', '-q')
    if ($IncludeStopped) { $arguments += '-a' }
    $arguments += @(
        '--filter', "label=com.docker.compose.project=$($layout.ProjectName)",
        '--filter', "label=com.docker.compose.service=$($layout.ServiceName)"
    )
    $result = Invoke-NativeCommand -FilePath 'docker' -ArgumentList $arguments -Capture
    if ($result.ExitCode -ne 0) { return $null }
    # Output also holds stderr, so a docker warning must not pass for a container id.
    @($result.Output | Where-Object { $_ -match '^[0-9a-f]{12,64}$' }) | Select-Object -First 1
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
    try {
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

Export-ModuleMember -Function *
