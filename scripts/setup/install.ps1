#Requires -Version 5.1
<#
.SYNOPSIS
    Script 1 of the All-in Windows setup: checks the software and Windows settings this PC needs and installs what is missing.
.DESCRIPTION
    Runs elevated; setup.cmd asks for administrator rights. Every item is checked first and only changed when needed,
    so the script is safe to run any number of times. Exit codes: 0 ready, 1 error, 2 the user has to act, 3010 restart.
.PARAMETER Dev
    Development PC: handle only Windows, winget, Git and Node.js.
.PARAMETER CheckOnly
    Report only: change nothing, never prompt, no administrator rights needed.
.PARAMETER NonInteractive
    Never prompt. install.ps1 never prompts; the switch keeps the parameters in line with init.ps1.
.PARAMETER DataDir
    Data directory of the database host. Default: the saved one, otherwise C:\all-in-db.
.PARAMETER Port
    PostgreSQL port for the firewall rule. Default: the saved one, otherwise 5432.
.PARAMETER ResultPath
    Write the results and the exit code as JSON to this file.
.PARAMETER LogDir
    Folder for the transcript. Default: %LOCALAPPDATA%\all-in\logs.
.PARAMETER SetNetworkPrivate
    Switch networks on the Public profile to Private (setup.ps1 asks the user first).
.PARAMETER UserSid
    SID of the normal user who runs setup; keeps access to the data directory's .env. Default: the current user.
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'NonInteractive', Justification = 'Same parameters as init.ps1; install.ps1 never prompts.')]
[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$CheckOnly,
    [switch]$NonInteractive,
    [string]$DataDir = '',
    [ValidateRange(0, 65535)][int]$Port = 0,
    [string]$ResultPath = '',
    [string]$LogDir = '',
    [switch]$SetNetworkPrivate,
    [string]$UserSid = ''
)

Import-Module (Join-Path $PSScriptRoot 'AllIn.Setup.psm1') -Force
Set-StrictMode -Version 3.0

$script:HintIndent = ' ' * 12
$script:MinimumWslVersion = '2.1.5'
$script:WingetNoInstalledPackage = -1978335212
$script:StandbySettingId = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da'
$script:HibernateSettingId = '9d7815a6-7ee4-497e-8888-515a05f02364'
$script:DockerInstallerArguments = 'install --quiet --accept-license --backend=wsl-2 --always-run-service'

function Get-ItemOutcome {
    param(
        [Parameter(Mandatory)][ValidateSet('OK', 'INSTALLED', 'ACTION', 'FAILED', 'SKIPPED')][string]$Status,
        [AllowEmptyString()][string]$Message = '',
        [AllowEmptyCollection()][string[]]$Hint = @(),
        [switch]$Advisory,
        [switch]$RebootRequired
    )
    [pscustomobject]@{
        Status = $Status
        Message = $Message
        Hint = @($Hint)
        Advisory = [bool]$Advisory
        RebootRequired = [bool]$RebootRequired
    }
}

function Add-ItemOutcome {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][object]$Outcome
    )
    $result = @{
        List = $Results
        Name = $Name
        Status = $Outcome.Status
        Message = $Outcome.Message
        Advisory = $Outcome.Advisory
        RebootRequired = $Outcome.RebootRequired
    }
    Add-SetupResult @result
    foreach ($line in $Outcome.Hint) { Show-SetupMessage -Text ($script:HintIndent + $line) }
}

function Get-InstallPlan {
    param([switch]$Dev)
    if ($Dev) {
        return @(
            [pscustomobject]@{ Title = 'Windows'; Names = @('Windows') }
            [pscustomobject]@{ Title = 'Software'; Names = @('winget', 'Git', 'Node.js') }
        )
    }
    @(
        [pscustomobject]@{ Title = 'Windows and virtualization'; Names = @('Windows', 'Virtualization') }
        [pscustomobject]@{ Title = 'Software'; Names = @('winget', 'Git', 'Node.js', 'WSL', 'Docker Desktop') }
        [pscustomobject]@{
            Title = 'Database host settings'
            Names = @('Sleep on AC power', 'Firewall rule', 'Network profile', 'Old backup task', 'Data directory permissions')
        }
    )
}

function Get-ApplicationPath {
    param([Parameter(Mandatory)][string]$Name)
    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $null
}

function ConvertTo-VersionText {
    param([AllowEmptyCollection()][AllowNull()][string[]]$Output)
    $text = (@($Output) -join ' ') -replace "`0", ''
    if ($text -match '\d+(?:\.\d+)+[^\s,;]*') { return $Matches[0] }
    $null
}

function Get-NativeVersionText {
    param([Parameter(Mandatory)][string]$Name)
    $path = Get-ApplicationPath -Name $Name
    if (-not $path) { return $null }
    $result = Invoke-NativeCommand -FilePath $path -ArgumentList @('--version') -Capture
    if ($result.ExitCode -ne 0) { return $null }
    ConvertTo-VersionText -Output $result.Output
}

function Format-ExitCode {
    param([Parameter(Mandatory)][long]$ExitCode)
    if ($ExitCode -lt 0) { return '{0} (0x{1:X8})' -f $ExitCode, [int]$ExitCode }
    [string]$ExitCode
}

function Invoke-WingetPackage {
    param(
        [Parameter(Mandatory)][ValidateSet('install', 'upgrade')][string]$Verb,
        [Parameter(Mandatory)][string]$Id,
        [AllowEmptyCollection()][string[]]$ExtraArgument = @()
    )
    $arguments = @(
        $Verb, '--id', $Id, '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
    ) + $ExtraArgument
    Show-SetupMessage -Text ('    winget {0} {1}' -f $Verb, $Id)
    $result = Invoke-NativeCommand -FilePath 'winget.exe' -ArgumentList $arguments
    Sync-SessionPath
    [pscustomobject]@{
        ExitCode = $result.ExitCode
        Outcome = Resolve-WingetExitCode -ExitCode $result.ExitCode
    }
}

function Get-InstallOutcome {
    param(
        [Parameter(Mandatory)][object]$Winget,
        [AllowEmptyString()][AllowNull()][string]$Version
    )
    if ($Winget.Outcome -eq 'FAILED') {
        return Get-ItemOutcome -Status FAILED -Message ('winget stopped with exit code {0}; see the lines above' -f (Format-ExitCode -ExitCode $Winget.ExitCode))
    }
    $reboot = $Winget.Outcome -eq 'REBOOT'
    if ($Version -and $reboot) { return Get-ItemOutcome -Status INSTALLED -Message "$Version; restart Windows to finish" -RebootRequired }
    if ($Version) { return Get-ItemOutcome -Status INSTALLED -Message $Version }
    if ($reboot) { return Get-ItemOutcome -Status INSTALLED -Message 'restart Windows to finish the installation' -RebootRequired }
    Get-ItemOutcome -Status ACTION -Message 'installed, but this window does not find it yet' -Hint @(
        'Close this window, open a new one and run setup.cmd again.'
    )
}

function Get-WindowsName {
    param([Parameter(Mandatory)][int]$Build, [Parameter(Mandatory)][int]$ProductType)
    if ($ProductType -ne 1) { return 'Windows Server' }
    if ($Build -ge 22000) { return 'Windows 11' }
    'Windows 10'
}

function Get-MinimumWindowsBuild {
    param([Parameter(Mandatory)][int]$Build, [switch]$Dev)
    if ($Dev) { return 19041 }
    # Docker Desktop's minimum: Windows 10 22H2 or Windows 11 23H2.
    if ($Build -ge 22000) { return 22631 }
    19045
}

function Invoke-WindowsItem {
    param([switch]$Dev)
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $build = [int]$os.BuildNumber
    $label = '{0} build {1}' -f (Get-WindowsName -Build $build -ProductType ([int]$os.ProductType)), $build
    if (-not [Environment]::Is64BitOperatingSystem) {
        return Get-ItemOutcome -Status ACTION -Message "$label is 32-bit; All-in needs 64-bit Windows"
    }
    $minimum = Get-MinimumWindowsBuild -Build $build -Dev:$Dev
    if ($build -lt $minimum) {
        return Get-ItemOutcome -Status ACTION -Message ('{0} is too old; build {1} or later is needed' -f $label, $minimum) -Hint @(
            'Run Windows Update (Settings > Windows Update) until it finds nothing more, and restart.'
            'Then run setup.cmd again.'
        )
    }
    Get-ItemOutcome -Status OK -Message "$label, 64-bit"
}

function Invoke-VirtualizationItem {
    # A running hypervisor hides the firmware flag (it reads as off), so it is checked first.
    $system = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    if ($system.HypervisorPresent) { return Get-ItemOutcome -Status OK -Message 'a hypervisor is running' }
    $processors = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
    $enabled = @($processors | Where-Object { $_.VirtualizationFirmwareEnabled -eq $true })
    if ($processors.Count -gt 0 -and $enabled.Count -eq $processors.Count) {
        return Get-ItemOutcome -Status OK -Message 'enabled in the firmware'
    }
    Get-ItemOutcome -Status ACTION -Message 'hardware virtualization is off in the BIOS/UEFI; WSL 2 and Docker need it' -Hint @(
        'Open the firmware settings: Settings > System > Recovery > Advanced startup > Restart now,'
        'then Troubleshoot > Advanced options > UEFI Firmware Settings (or press Del, F2 or F10 while the PC starts).'
        'Turn on Intel Virtualization Technology (VT-x) or AMD SVM Mode, save and restart.'
        'Then run setup.cmd again.'
    )
}

function Invoke-WingetItem {
    $hint = @(
        'Open the Microsoft Store, search for "App Installer" and install or update it.'
        'Without the Store: download it from https://aka.ms/getwinget and open the file.'
        'Then run setup.cmd again.'
    )
    if (-not (Get-ApplicationPath -Name 'winget.exe')) {
        return Get-ItemOutcome -Status ACTION -Message 'not installed' -Hint $hint
    }
    $version = $null
    try {
        $version = Get-NativeVersionText -Name 'winget.exe'
    }
    catch {
        Write-Verbose "winget.exe does not start: $($_.Exception.Message)"
    }
    if (-not $version) { return Get-ItemOutcome -Status ACTION -Message 'installed, but it does not start' -Hint $hint }
    Get-ItemOutcome -Status OK -Message $version
}

function Invoke-GitItem {
    param([switch]$CheckOnly, [switch]$WingetMissing)
    $version = Get-NativeVersionText -Name 'git.exe'
    if ($version) { return Get-ItemOutcome -Status OK -Message $version }
    if ($WingetMissing) { return Get-ItemOutcome -Status SKIPPED -Message 'not installed; needs winget' }
    if ($CheckOnly) { return Get-ItemOutcome -Status ACTION -Message 'not installed; setup.cmd installs it' }
    $winget = Invoke-WingetPackage -Verb install -Id 'Git.Git' -ExtraArgument @('--silent')
    Get-InstallOutcome -Winget $winget -Version (Get-NativeVersionText -Name 'git.exe')
}

function Test-NodeVersion {
    param(
        [AllowEmptyString()][AllowNull()][string]$Version,
        [AllowNull()][object]$RequiredMajor
    )
    if (-not $Version) { return $false }
    if ($null -eq $RequiredMajor) { return $true }
    (Get-MajorVersion -Version $Version) -ge $RequiredMajor
}

function Invoke-NodeItem {
    param(
        [switch]$CheckOnly,
        [switch]$WingetMissing,
        [AllowNull()][object]$RequiredMajor
    )
    $version = Get-NativeVersionText -Name 'node.exe'
    if (Test-NodeVersion -Version $version -RequiredMajor $RequiredMajor) {
        if ($null -eq $RequiredMajor) { return Get-ItemOutcome -Status OK -Message $version }
        return Get-ItemOutcome -Status OK -Message ('{0} (.nvmrc: {1})' -f $version, $RequiredMajor)
    }
    $state = 'not installed'
    if ($version) { $state = '{0} is older than {1} (.nvmrc)' -f $version, $RequiredMajor }
    if ($WingetMissing) { return Get-ItemOutcome -Status SKIPPED -Message "$state; needs winget" }
    if ($CheckOnly) { return Get-ItemOutcome -Status ACTION -Message "$state; setup.cmd installs the LTS version" }

    if ($version) {
        $winget = Invoke-WingetPackage -Verb upgrade -Id 'OpenJS.NodeJS.LTS' -ExtraArgument @('--silent')
        if ($winget.ExitCode -eq $script:WingetNoInstalledPackage) {
            return Get-ItemOutcome -Status ACTION -Message "$state and was not installed with winget (for example with nvm)" -Hint @(
                "Upgrade it the way you installed it, to Node.js $RequiredMajor or later. Then run setup.cmd again."
            )
        }
    }
    else {
        $winget = Invoke-WingetPackage -Verb install -Id 'OpenJS.NodeJS.LTS' -ExtraArgument @('--silent')
    }
    $after = Get-NativeVersionText -Name 'node.exe'
    if ($winget.Outcome -in @('INSTALLED', 'OK') -and $after -and -not (Test-NodeVersion -Version $after -RequiredMajor $RequiredMajor)) {
        return Get-ItemOutcome -Status ACTION -Message ('winget offers {0} as the newest LTS; .nvmrc needs {1}' -f $after, $RequiredMajor) -Hint @(
            "Install Node.js $RequiredMajor from https://nodejs.org, then run setup.cmd again."
        )
    }
    Get-InstallOutcome -Winget $winget -Version $after
}

function Invoke-WslCommand {
    param(
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [switch]$Capture
    )
    $previous = $env:WSL_UTF8
    # Without it wsl.exe writes UTF-16.
    $env:WSL_UTF8 = '1'
    try {
        Invoke-NativeCommand -FilePath 'wsl.exe' -ArgumentList $ArgumentList -Capture:$Capture
    }
    finally {
        $env:WSL_UTF8 = $previous
    }
}

function Get-WslVersion {
    if (-not (Get-ApplicationPath -Name 'wsl.exe')) { return $null }
    $result = Invoke-WslCommand -ArgumentList @('--version') -Capture
    if ($result.ExitCode -ne 0) { return $null }
    ConvertTo-VersionText -Output $result.Output
}

function Invoke-WslItem {
    param([switch]$CheckOnly)
    $minimum = $script:MinimumWslVersion
    $version = Get-WslVersion
    if (Test-VersionAtLeast -Version $version -Minimum $minimum) {
        if (Test-PendingReboot) {
            return Get-ItemOutcome -Status ACTION -Message "$version; Windows has to restart to finish installing" -RebootRequired -Hint @(
                'Restart Windows, then run setup.cmd again.'
            )
        }
        return Get-ItemOutcome -Status OK -Message $version
    }
    if ($CheckOnly) {
        if ($version) { return Get-ItemOutcome -Status ACTION -Message "$version is older than $minimum; setup.cmd updates it" }
        return Get-ItemOutcome -Status ACTION -Message 'not installed; setup.cmd installs it'
    }
    $arguments = @('--install', '--no-distribution')
    if ($version) { $arguments = @('--update') }
    Show-SetupMessage -Text ('    wsl.exe {0}' -f ($arguments -join ' '))
    $exitCode = (Invoke-WslCommand -ArgumentList $arguments).ExitCode
    if (@(0, 1641, 3010) -notcontains $exitCode) {
        return Get-ItemOutcome -Status FAILED -Message ('wsl.exe {0} stopped with exit code {1}; see the lines above' -f ($arguments -join ' '), (Format-ExitCode -ExitCode $exitCode))
    }
    $after = Get-WslVersion
    if ($exitCode -ne 0 -or (Test-PendingReboot) -or -not (Test-VersionAtLeast -Version $after -Minimum $minimum)) {
        return Get-ItemOutcome -Status INSTALLED -Message 'restart Windows to finish the installation' -RebootRequired
    }
    Get-ItemOutcome -Status INSTALLED -Message $after
}

function Get-DockerDesktopVersion {
    $path = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $productVersion = (Get-Item -LiteralPath $path -ErrorAction Stop).VersionInfo.ProductVersion
    if ($productVersion) { return [string]$productVersion }
    'installed'
}

function Invoke-DockerDesktopItem {
    param([switch]$CheckOnly, [switch]$WingetMissing, [switch]$WaitForRestart)
    $version = Get-DockerDesktopVersion
    if ($version) { return Get-ItemOutcome -Status OK -Message $version }
    if ($WaitForRestart) { return Get-ItemOutcome -Status SKIPPED -Message 'not installed; setup.cmd installs it after the restart' }
    if ($WingetMissing) { return Get-ItemOutcome -Status SKIPPED -Message 'not installed; needs winget' }
    if ($CheckOnly) { return Get-ItemOutcome -Status ACTION -Message 'not installed; setup.cmd installs it' }
    $extra = @('--scope', 'machine', '--override', $script:DockerInstallerArguments)
    $winget = Invoke-WingetPackage -Verb install -Id 'Docker.DockerDesktop' -ExtraArgument $extra
    Get-InstallOutcome -Winget $winget -Version (Get-DockerDesktopVersion)
}

function Get-ActivePowerSchemeId {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
    $item = Get-ItemProperty -LiteralPath $key -Name 'ActivePowerScheme' -ErrorAction SilentlyContinue
    if ($item -and $item.ActivePowerScheme) { return [string]$item.ActivePowerScheme }
    $result = Invoke-NativeCommand -FilePath 'powercfg.exe' -ArgumentList @('/getactivescheme') -Capture
    $guid = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
    if ($result.ExitCode -eq 0 -and ((@($result.Output) -join ' ') -match $guid)) { return $Matches[0] }
    $null
}

function Get-AcPowerTimeout {
    param([Parameter(Mandatory)][string]$SchemeId)
    $settings = @(
        [pscustomobject]@{ Verb = 'sleeps'; Id = $script:StandbySettingId; Change = 'standby-timeout-ac' }
        [pscustomobject]@{ Verb = 'hibernates'; Id = $script:HibernateSettingId; Change = 'hibernate-timeout-ac' }
    )
    foreach ($setting in $settings) {
        # Win32_PowerPlan needs administrator rights; the setting index does not.
        $instanceId = 'Microsoft:PowerSettingDataIndex\\{{{0}}}\\AC\\{{{1}}}' -f $SchemeId, $setting.Id
        $index = Get-CimInstance -Namespace 'root\cimv2\power' -ClassName 'Win32_PowerSettingDataIndex' -Filter "InstanceID = '$instanceId'" -ErrorAction Stop |
            Select-Object -First 1
        if (-not $index -or [long]$index.SettingIndexValue -le 0) { continue }
        [pscustomobject]@{ Verb = $setting.Verb; Change = $setting.Change; Seconds = [long]$index.SettingIndexValue }
    }
}

function Format-PowerTimeout {
    param([Parameter(Mandatory)][object[]]$Timeout)
    $parts = foreach ($item in $Timeout) {
        if ($item.Seconds % 60 -eq 0) { '{0} after {1} min' -f $item.Verb, ($item.Seconds / 60) }
        else { '{0} after {1} s' -f $item.Verb, $item.Seconds }
    }
    '{0} on AC power' -f (@($parts) -join ' and ')
}

function Invoke-SleepItem {
    param([switch]$CheckOnly)
    $scheme = Get-ActivePowerSchemeId
    if (-not $scheme) { return Get-ItemOutcome -Status FAILED -Message 'could not find the active power plan' }
    $timeouts = @(Get-AcPowerTimeout -SchemeId $scheme)
    if ($timeouts.Count -eq 0) { return Get-ItemOutcome -Status OK -Message 'never sleeps or hibernates on AC power' }
    $description = Format-PowerTimeout -Timeout $timeouts
    if ($CheckOnly) { return Get-ItemOutcome -Status ACTION -Message "$description, so the database would go offline; setup.cmd turns that off" }
    foreach ($timeout in $timeouts) {
        $result = Invoke-NativeCommand -FilePath 'powercfg.exe' -ArgumentList @('/change', $timeout.Change, '0')
        if ($result.ExitCode -ne 0) {
            return Get-ItemOutcome -Status FAILED -Message ('powercfg /change {0} 0 stopped with exit code {1}' -f $timeout.Change, (Format-ExitCode -ExitCode $result.ExitCode))
        }
    }
    $left = @(Get-AcPowerTimeout -SchemeId $scheme)
    if ($left.Count -gt 0) { return Get-ItemOutcome -Status FAILED -Message ('still {0} after powercfg' -f (Format-PowerTimeout -Timeout $left)) }
    Get-ItemOutcome -Status INSTALLED -Message 'sleep and hibernate on AC power turned off'
}

function Get-FirewallRuleSummary {
    param([Parameter(Mandatory)][object]$Rule)
    $portFilter = @($Rule | Get-NetFirewallPortFilter -ErrorAction Stop)[0]
    $addressFilter = @($Rule | Get-NetFirewallAddressFilter -ErrorAction Stop)[0]
    '{0} {1} {2} {3} from {4}, profile {5}, enabled {6}' -f $Rule.Direction, $Rule.Action, $portFilter.Protocol,
        (@($portFilter.LocalPort) -join ','), (@($addressFilter.RemoteAddress) -join ','), $Rule.Profile, $Rule.Enabled
}

function Get-FirewallRuleProblem {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][object]$Layout
    )
    $wanted = 'Inbound Allow TCP {0} from LocalSubnet, profile Private, enabled True' -f $Port
    $rule = Get-NetFirewallRule -Name $Layout.FirewallRuleName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rule) { return [pscustomobject]@{ Exists = $false; Text = "$($Layout.FirewallRuleName) is missing" } }
    $actual = Get-FirewallRuleSummary -Rule $rule
    if ($actual -ne $wanted -or $rule.DisplayName -ne $Layout.FirewallDisplayName) {
        return [pscustomobject]@{ Exists = $true; Text = "$($Layout.FirewallRuleName) is set to $actual" }
    }
    $null
}

function Invoke-FirewallItem {
    param([switch]$CheckOnly, [Parameter(Mandatory)][int]$Port)
    $layout = Get-DatabaseLayout
    $ready = 'TCP {0} open for the local network (Private profile)' -f $Port
    $problem = Get-FirewallRuleProblem -Port $Port -Layout $layout
    $legacy = @(Get-NetFirewallRule -DisplayName $layout.LegacyFirewallDisplayName -ErrorAction SilentlyContinue)
    $legacyNames = (@($legacy | ForEach-Object { "'$($_.DisplayName)'" }) -join ', ')
    if (-not $problem -and $legacy.Count -eq 0) { return Get-ItemOutcome -Status OK -Message $ready }
    if ($CheckOnly) {
        $issues = @()
        if ($problem) { $issues += $problem.Text }
        if ($legacy.Count -gt 0) { $issues += "old rule $legacyNames from the previous setup script" }
        return Get-ItemOutcome -Status ACTION -Message ('{0}; setup.cmd fixes this ({1})' -f ($issues -join '; '), $ready)
    }
    $done = @()
    $settings = @{
        Direction = 'Inbound'
        Protocol = 'TCP'
        LocalPort = [string]$Port
        RemoteAddress = 'LocalSubnet'
        Profile = 'Private'
        Action = 'Allow'
        Enabled = 'True'
        ErrorAction = 'Stop'
    }
    if ($problem -and -not $problem.Exists) {
        New-NetFirewallRule -Name $layout.FirewallRuleName -DisplayName $layout.FirewallDisplayName @settings | Out-Null
        $done += 'rule added'
    }
    elseif ($problem) {
        Set-NetFirewallRule -Name $layout.FirewallRuleName -NewDisplayName $layout.FirewallDisplayName @settings | Out-Null
        $done += 'rule updated'
    }
    if ($legacy.Count -gt 0) {
        $legacy | Remove-NetFirewallRule -ErrorAction Stop
        $done += "removed old rule $legacyNames"
    }
    $left = Get-FirewallRuleProblem -Port $Port -Layout $layout
    if ($left) { return Get-ItemOutcome -Status FAILED -Message $left.Text }
    Get-ItemOutcome -Status INSTALLED -Message ('{0}; {1}' -f $ready, ($done -join ', '))
}

function Invoke-NetworkProfileItem {
    param([switch]$CheckOnly, [switch]$SetNetworkPrivate)
    $public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { "$($_.NetworkCategory)" -eq 'Public' })
    if ($public.Count -eq 0) { return Get-ItemOutcome -Status OK -Message 'no network uses the Public profile' }
    $names = @($public | ForEach-Object { "'$($_.Name)'" }) -join ', '
    if ($SetNetworkPrivate -and -not $CheckOnly) {
        foreach ($connection in $public) {
            Set-NetConnectionProfile -InterfaceIndex $connection.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
        }
        return Get-ItemOutcome -Status INSTALLED -Message "switched to Private: $names"
    }
    Get-ItemOutcome -Status ACTION -Advisory -Message "$names on the Public profile" -Hint @(
        'Windows blocks the database on Public networks: the firewall rule only opens the port on Private ones.'
        'If this is your own network, switch it to Private: run setup.cmd and answer yes when it asks,'
        'or Settings > Network & internet > your network > Properties > Private network.'
    )
}

function Invoke-OldBackupTaskItem {
    param([switch]$CheckOnly)
    $layout = Get-DatabaseLayout
    $task = Get-ScheduledTask -TaskPath '\' -TaskName $layout.BackupTaskName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $task) { return Get-ItemOutcome -Status OK -Message 'none' }
    if ($task.Description -eq $layout.BackupTaskDescription) { return Get-ItemOutcome -Status OK -Message 'none; the backup task there is the one from init.ps1' }
    if ($CheckOnly) {
        return Get-ItemOutcome -Status ACTION -Message ("'{0}' is from the previous setup script; setup.cmd removes it" -f $layout.BackupTaskName)
    }
    Unregister-ScheduledTask -TaskPath '\' -TaskName $layout.BackupTaskName -Confirm:$false -ErrorAction Stop
    Get-ItemOutcome -Status INSTALLED -Message ("removed '{0}'; init.ps1 registers the new one" -f $layout.BackupTaskName)
}

function Invoke-SecretFileItem {
    param(
        [switch]$CheckOnly,
        [Parameter(Mandatory)][string]$DataDir,
        [Parameter(Mandatory)][string]$UserSid
    )
    $envPath = Join-Path $DataDir '.env'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        return Get-ItemOutcome -Status OK -Message "$envPath does not exist yet; init.ps1 creates it"
    }
    try {
        $protected = Test-SecretFileProtected -Path $envPath -UserSid $UserSid
    }
    catch [System.UnauthorizedAccessException] {
        if (-not $CheckOnly) { throw }
        return Get-ItemOutcome -Status ACTION -Message "cannot read who may open $envPath; setup.cmd checks and fixes it"
    }
    if ($protected) { return Get-ItemOutcome -Status OK -Message "only you, Administrators and SYSTEM can open $envPath" }
    if ($CheckOnly) { return Get-ItemOutcome -Status ACTION -Message "other accounts can open $envPath; setup.cmd restricts it" }
    Protect-SecretFile -Path $envPath -UserSid $UserSid
    Get-ItemOutcome -Status INSTALLED -Message "only you, Administrators and SYSTEM can open $envPath now"
}

function Invoke-InstallItem {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][hashtable]$Context
    )
    $checkOnly = [bool]$Context.CheckOnly
    $wingetMissing = [bool]$Context.WingetMissing
    switch ($Name) {
        'Windows' { Invoke-WindowsItem -Dev:$Context.Dev }
        'Virtualization' { Invoke-VirtualizationItem }
        'winget' { Invoke-WingetItem }
        'Git' { Invoke-GitItem -CheckOnly:$checkOnly -WingetMissing:$wingetMissing }
        'Node.js' { Invoke-NodeItem -CheckOnly:$checkOnly -WingetMissing:$wingetMissing -RequiredMajor $Context.RequiredNodeMajor }
        'WSL' { Invoke-WslItem -CheckOnly:$checkOnly }
        'Docker Desktop' { Invoke-DockerDesktopItem -CheckOnly:$checkOnly -WingetMissing:$wingetMissing -WaitForRestart:$Context.WslRestart }
        'Sleep on AC power' { Invoke-SleepItem -CheckOnly:$checkOnly }
        'Firewall rule' { Invoke-FirewallItem -CheckOnly:$checkOnly -Port $Context.Port }
        'Network profile' { Invoke-NetworkProfileItem -CheckOnly:$checkOnly -SetNetworkPrivate:$Context.SetNetworkPrivate }
        'Old backup task' { Invoke-OldBackupTaskItem -CheckOnly:$checkOnly }
        'Data directory permissions' { Invoke-SecretFileItem -CheckOnly:$checkOnly -DataDir $Context.DataDir -UserSid $Context.UserSid }
        default { throw "Unknown item: $Name" }
    }
}

function Invoke-InstallPlan {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory)][hashtable]$Context
    )
    $plan = @(Get-InstallPlan -Dev:$Context.Dev)
    $skipReason = ''
    for ($index = 0; $index -lt $plan.Count; $index++) {
        Show-SetupStep -Number ($index + 1) -Total $plan.Count -Title $plan[$index].Title
        foreach ($name in $plan[$index].Names) {
            if ($skipReason) {
                $outcome = Get-ItemOutcome -Status SKIPPED -Message $skipReason
            }
            else {
                try {
                    $outcome = @(Invoke-InstallItem -Name $name -Context $Context) | Select-Object -Last 1
                    if (-not $outcome) { $outcome = Get-ItemOutcome -Status FAILED -Message 'the check returned no result' }
                }
                catch {
                    $outcome = Get-ItemOutcome -Status FAILED -Message $_.Exception.Message
                }
            }
            Add-ItemOutcome -Results $Results -Name $name -Outcome $outcome
            if ($name -eq 'Windows' -and $outcome.Status -ne 'OK') { $skipReason = 'skipped until the Windows item is OK' }
            if ($name -eq 'winget' -and $outcome.Status -ne 'OK') { $Context.WingetMissing = $true }
            if ($name -eq 'WSL' -and $outcome.RebootRequired) { $Context.WslRestart = $true }
        }
    }
}

function Show-InstallSummary {
    param(
        [Parameter(Mandatory)][int]$ExitCode,
        [switch]$CheckOnly,
        [AllowEmptyString()][string]$LogPath = ''
    )
    Show-SetupMessage
    switch ($ExitCode) {
        0 { Show-SetupMessage -Text 'Ready.' -Color 'Green' }
        2 {
            if ($CheckOnly) { Show-SetupMessage -Text 'Not ready: run setup.cmd to fix the ACTION items above.' -Color 'Yellow' }
            else { Show-SetupMessage -Text 'Not ready: do what the ACTION lines above say, then run setup.cmd again.' -Color 'Yellow' }
        }
        3010 { Show-SetupMessage -Text 'Restart Windows, then run setup.cmd again.' -Color 'Yellow' }
        default {
            Show-SetupMessage -Text 'Something went wrong: see the FAILED lines above.' -Color 'Red'
            if ($LogPath) { Show-SetupMessage -Text "Log: $LogPath" }
        }
    }
}

$results = New-Object System.Collections.Generic.List[object]
$location = Get-SetupLocation
if (-not $LogDir) { $LogDir = $location.LogDir }
if (-not $UserSid) { $UserSid = Get-CurrentUserSid }
$logPath = Get-SetupLogPath -LogDir $LogDir -Name 'install'
$transcribing = $false
try {
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force -ErrorAction Stop | Out-Null }
    Start-Transcript -Path $logPath -ErrorAction Stop | Out-Null
    $transcribing = $true
}
catch {
    Show-SetupMessage -Text "Could not start the log in ${LogDir}: $($_.Exception.Message)" -Color 'Yellow'
    $logPath = ''
}

$code = Get-SetupExitCode -Name Error
try {
    try {
        $target = 'the database host'
        if ($Dev) { $target = 'a development PC' }
        Show-SetupMessage -Text "All-in setup, script 1: software and Windows settings for $target"
        if ($CheckOnly) { Show-SetupMessage -Text 'Check only: nothing is changed.' }
        if ($logPath) { Show-SetupMessage -Text "Log: $logPath" }
        if (-not $CheckOnly -and -not (Test-IsAdministrator)) {
            Add-SetupResult -List $results -Name 'Administrator rights' -Status ACTION -Message 'run setup.cmd; it asks for administrator rights'
        }
        else {
            Sync-SessionPath
            $options = Resolve-DatabaseOption -State (Read-SetupState -Path $location.StatePath) -DataDir $DataDir -Port $Port
            $context = @{
                Dev = [bool]$Dev
                CheckOnly = [bool]$CheckOnly
                SetNetworkPrivate = [bool]$SetNetworkPrivate
                DataDir = $options.DataDir
                Port = $options.Port
                UserSid = $UserSid
                RequiredNodeMajor = Get-RequiredNodeMajor -NvmrcPath (Join-Path (Get-RepoRoot) '.nvmrc')
                WingetMissing = $false
                WslRestart = $false
            }
            Invoke-InstallPlan -Results $results -Context $context
        }
    }
    catch {
        Add-SetupResult -List $results -Name 'install.ps1' -Status FAILED -Message $_.Exception.Message
    }
    $code = Get-CombinedExitCode -Results $results
    if ($ResultPath) {
        try {
            Export-SetupResult -Path $ResultPath -Results $results -ExitCode $code
        }
        catch {
            Show-SetupStatus -Status FAILED -Message "Could not write ${ResultPath}: $($_.Exception.Message)"
            $code = Get-SetupExitCode -Name Error
        }
    }
    Show-InstallSummary -ExitCode $code -CheckOnly:$CheckOnly -LogPath $logPath
}
finally {
    if ($transcribing) { Stop-Transcript | Out-Null }
}
exit $code
