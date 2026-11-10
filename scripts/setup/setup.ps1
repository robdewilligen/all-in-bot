#Requires -Version 5.1
<#
.SYNOPSIS
    Prepares this PC for All-in: install.ps1 (as administrator), then init.ps1 (as you), then a summary.
.DESCRIPTION
    Start it through setup.cmd. Safe to run any number of times. Exit codes: 0 ready, 1 error,
    2 you need to act (the output says what to do), 3010 a restart is required.
.PARAMETER Dev
    Prepare a development PC (Git, Node.js, packages, .env) instead of the database host.
.PARAMETER CheckOnly
    Report the status of every item without changing anything.
.PARAMETER InstallOnly
    Run only the software part (install.ps1).
.PARAMETER NonInteractive
    Never ask anything; stop with instructions when input is needed.
.PARAMETER DataDir
    Data directory of the database host. Default: the one from an earlier run, otherwise C:\all-in-db.
.PARAMETER Port
    PostgreSQL port on the LAN. Default: the one from an earlier run, otherwise 5432.
#>
[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$CheckOnly,
    [switch]$InstallOnly,
    [switch]$NonInteractive,
    [string]$DataDir,
    [ValidateRange(1, 65535)][int]$Port
)

Import-Module (Join-Path $PSScriptRoot 'AllIn.Setup.psm1') -Force

$installScript = Join-Path $PSScriptRoot 'install.ps1'
$initScript = Join-Path $PSScriptRoot 'init.ps1'
$location = Get-SetupLocation
New-Item -ItemType Directory -Path $location.LogDir -Force -ErrorAction Stop | Out-Null
$options = Resolve-DatabaseOption -State (Read-SetupState -Path $location.StatePath) -DataDir $DataDir -Port $Port
$checkResultPath = Join-Path $location.Root 'install-check.json'
$installResultPath = Join-Path $location.Root 'install-result.json'
$initResultPath = Join-Path $location.Root 'init-result.json'
$runOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$runOnceName = 'AllInSetup'

$powershellArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File')
$scriptArguments = @('-DataDir', $options.DataDir, '-Port', [string]$options.Port)
if ($Dev) { $scriptArguments = @('-Dev') + $scriptArguments }

$exitCode = Get-SetupExitCode -Name Error
$restartNow = $false
$initRan = $false
$transcriptPath = Get-SetupLogPath -LogDir $location.LogDir -Name 'setup'
Start-Transcript -Path $transcriptPath | Out-Null
try {
    do {
        $target = 'database host'
        if ($Dev) { $target = 'development PC' }
        $mode = ''
        if ($CheckOnly) { $mode = ', check only' }
        Show-SetupMessage ('All-in setup: {0}{1}' -f $target, $mode) -Color 'Cyan'
        Remove-Item -LiteralPath $checkResultPath, $installResultPath, $initResultPath -ErrorAction SilentlyContinue

        Show-SetupMessage ''
        Show-SetupMessage '=== Part 1: software and Windows settings (install.ps1) ===' -Color 'Cyan'
        & powershell.exe @powershellArguments $installScript -CheckOnly -NonInteractive -ResultPath $checkResultPath -LogDir $location.LogDir @scriptArguments
        $check = Import-SetupResult -Path $checkResultPath
        if ($null -eq $check) { throw "install.ps1 -CheckOnly stopped without a result (exit code $LASTEXITCODE)." }
        $installOutcome = $check

        if (-not $CheckOnly -and $check.ExitCode -ne 0) {
            $installArguments = @($installScript, '-NonInteractive', '-ResultPath', $installResultPath, '-LogDir', $location.LogDir, '-UserSid', (Get-CurrentUserSid)) + $scriptArguments
            $publicNetwork = @($check.Results | Where-Object { $_.Name -eq 'Network profile' -and $_.Status -eq 'ACTION' })
            if ($publicNetwork.Count -gt 0 -and -not $NonInteractive) {
                Show-SetupMessage ''
                Show-SetupMessage 'Windows treats this network as Public, which blocks the database for the other PCs.'
                Show-SetupMessage 'Only switch it to Private when it is your own home or office network.'
                $answer = Read-Host 'Switch to Private? [y/N]'
                if ($answer -match '^\s*(y|yes|j|ja)\s*$') { $installArguments += '-SetNetworkPrivate' }
            }

            if (Test-IsAdministrator) {
                & powershell.exe @powershellArguments @installArguments
            }
            elseif ($NonInteractive) {
                Show-SetupStatus -Status ACTION -Message 'Installing needs administrator rights, and -NonInteractive forbids the Windows prompt.'
                Show-SetupMessage '    Run setup.cmd without -NonInteractive, or from an administrator window.'
                $exitCode = Get-SetupExitCode -Name UserAction
                break
            }
            else {
                Show-SetupMessage ''
                Show-SetupMessage 'Windows now asks for administrator rights. A second window shows the installation.'
                try {
                    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList (ConvertTo-ArgumentString -ArgumentList ($powershellArguments + $installArguments)) -Verb RunAs -PassThru -ErrorAction Stop
                }
                catch {
                    Show-SetupStatus -Status ACTION -Message 'Administrator rights were not granted, so nothing was installed.'
                    Show-SetupMessage '    Run setup.cmd again and choose Yes when Windows asks for permission.'
                    $exitCode = Get-SetupExitCode -Name UserAction
                    break
                }
                # Reading Handle right away keeps ExitCode available after an elevated process ends (Windows PowerShell 5.1).
                $null = $process.Handle
                $process.WaitForExit()
                $installOutcome = Import-SetupResult -Path $installResultPath
                if ($null -ne $installOutcome) {
                    Show-SetupMessage 'Result of the administrator window:'
                    foreach ($result in $installOutcome.Results) { Show-SetupResult -Result $result }
                }
            }
            $installOutcome = Import-SetupResult -Path $installResultPath
            if ($null -eq $installOutcome) { throw "install.ps1 stopped without a result (exit code $LASTEXITCODE). The install log in $($location.LogDir) has the details." }
        }

        Sync-SessionPath
        $nextStep = Get-SetupNextStep -InstallExitCode $installOutcome.ExitCode
        if (-not $CheckOnly -and $nextStep -ne 'Continue') {
            $exitCode = $installOutcome.ExitCode
            if ($nextStep -eq 'Reboot') {
                $resumeCommand = Get-ResumeCommand -SetupCmdPath (Join-Path (Get-RepoRoot) 'setup.cmd') -ArgumentList @(ConvertTo-ArgumentList -BoundParameters $PSBoundParameters)
                Show-SetupMessage ''
                Show-SetupStatus -Status ACTION -Message 'Windows needs a restart to finish the installation.'
                # RunOnce entries longer than 260 characters are not run.
                if ($resumeCommand.Length -le 260) {
                    New-ItemProperty -Path $runOnceKey -Name $runOnceName -Value $resumeCommand -PropertyType String -Force -ErrorAction Stop | Out-Null
                    Show-SetupMessage '    After the restart, sign in as this user: setup continues by itself.'
                }
                else {
                    Show-SetupMessage '    After the restart, run setup.cmd again.'
                }
                if (-not $NonInteractive) {
                    $answer = Read-Host 'Restart now? Save your work in other programs first. [y/N]'
                    $restartNow = $answer -match '^\s*(y|yes|j|ja)\s*$'
                }
            }
            break
        }

        if ($InstallOnly -and -not $CheckOnly) {
            $exitCode = $installOutcome.ExitCode
            break
        }
        if (-not $CheckOnly -and (Test-IsAdministrator)) {
            Show-SetupMessage ''
            Show-SetupStatus -Status ACTION -Message 'The software is ready. The project part must not run as administrator.'
            Show-SetupMessage '    Open a normal (non-administrator) window and run setup.cmd again to finish.'
            $exitCode = Get-SetupExitCode -Name UserAction
            break
        }

        Show-SetupMessage ''
        Show-SetupMessage '=== Part 2: the project (init.ps1) ===' -Color 'Cyan'
        $initArguments = @($initScript, '-ResultPath', $initResultPath, '-LogDir', $location.LogDir, '-HideConnectionLines') + $scriptArguments
        if ($CheckOnly) { $initArguments += '-CheckOnly' }
        if ($NonInteractive -or $CheckOnly) { $initArguments += '-NonInteractive' }
        & powershell.exe @powershellArguments @initArguments
        $initExitCode = $LASTEXITCODE
        $initRan = $true
        $initOutcome = Import-SetupResult -Path $initResultPath
        if ($null -eq $initOutcome) { throw "init.ps1 stopped without a result (exit code $initExitCode). The init log in $($location.LogDir) has the details." }

        if ($CheckOnly) {
            $exitCode = Get-CombinedExitCode -Results (@($installOutcome.Results) + @($initOutcome.Results))
        }
        else {
            $exitCode = $initOutcome.ExitCode
        }
    } until ($true)
}
catch {
    Show-SetupStatus -Status FAILED -Message $_.Exception.Message
    $exitCode = Get-SetupExitCode -Name Error
}

try {
    Show-SetupMessage ''
    Show-SetupMessage '=== Summary ===' -Color 'Cyan'
    switch ($exitCode) {
        0 {
            if ($CheckOnly) { Show-SetupStatus -Status OK -Message 'Everything is in place.' }
            else { Show-SetupStatus -Status OK -Message 'Ready.' }
            if (-not $CheckOnly) { Remove-ItemProperty -Path $runOnceKey -Name $runOnceName -ErrorAction SilentlyContinue }
        }
        2 {
            if ($CheckOnly) { Show-SetupStatus -Status ACTION -Message 'Some items need setup.cmd or your action: see ACTION above.' }
            else { Show-SetupStatus -Status ACTION -Message 'Do what the ACTION lines above say, then run setup.cmd again.' }
        }
        3010 {
            if ($CheckOnly) { Show-SetupStatus -Status ACTION -Message 'A restart is pending; restart Windows, then run setup.cmd.' }
            elseif ($restartNow) { Show-SetupStatus -Status ACTION -Message 'Restarting now.' }
            else { Show-SetupStatus -Status ACTION -Message 'Restart Windows to continue.' }
        }
        default { Show-SetupStatus -Status FAILED -Message ('Setup stopped with an error. Details: {0}' -f $transcriptPath) }
    }
    Show-SetupMessage ('Logs: {0}' -f $location.LogDir)
}
finally {
    Stop-Transcript | Out-Null
}

# The connection lines hold a password, so they are printed only after the transcript has stopped.
if ($initRan -and -not $Dev -and -not $CheckOnly -and $exitCode -eq 0) {
    $secrets = Read-EnvFile -Path (Join-Path $options.DataDir '.env')
    $address = Get-LanAddress
    if ($secrets.Contains('ALLIN_DEV_PASSWORD') -and $null -ne $address) {
        Show-SetupMessage ''
        Show-SetupMessage "Put these two lines in the .env of All-in on your development PC:"
        foreach ($line in (Format-DevConnectionLine -Secret $secrets['ALLIN_DEV_PASSWORD'] -HostName $address.IPv4 -Port $options.Port)) {
            Show-SetupMessage ('  ' + $line) -Color 'Green'
        }
        Show-SetupMessage ('The passwords are also in {0}.' -f (Join-Path $options.DataDir '.env'))
    }
}

if ($restartNow) {
    try {
        Restart-Computer -ErrorAction Stop
    }
    catch {
        Show-SetupMessage ('Windows did not restart ({0}). Restart it from the Start menu.' -f $_.Exception.Message)
    }
}
elseif (-not $NonInteractive -and (Test-StartedFromExplorer)) {
    [void](Read-Host 'Press Enter to close this window')
}
exit $exitCode
