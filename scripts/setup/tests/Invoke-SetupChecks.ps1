#Requires -Version 5.1
<#
.SYNOPSIS
    Runs PSScriptAnalyzer and the Pester tests for scripts/setup. Exit code 0 when both pass.
.PARAMETER InstallMissing
    Install Pester 5 and PSScriptAnalyzer for the current user when they are missing (used in CI).
#>
[CmdletBinding()]
param(
    [switch]$InstallMissing
)

$setupDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $setupDir)
Import-Module (Join-Path $setupDir 'AllIn.Setup.psm1') -Force

# Windows ships Pester 3.4, which can't run these tests; pin the 5.x line.
$requiredModules = @(
    @{ Name = 'Pester'; MinimumVersion = '5.5.0'; MaximumVersion = '5.99.99' }
    @{ Name = 'PSScriptAnalyzer'; MinimumVersion = '1.21.0'; MaximumVersion = '1.99.99' }
)

function Get-RequiredModule {
    param([string]$Name, [version]$MinimumVersion, [version]$MaximumVersion)
    Get-Module -ListAvailable -Name $Name |
        Where-Object { $_.Version -ge $MinimumVersion -and $_.Version -le $MaximumVersion } |
        Sort-Object -Property Version -Descending |
        Select-Object -First 1
}

function Install-RequiredModule {
    param([string]$Name, [version]$MinimumVersion, [version]$MaximumVersion)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $nuget = Get-PackageProvider -ListAvailable -Name NuGet -ErrorAction SilentlyContinue |
        Where-Object { $_.Version -ge [version]'2.8.5.201' }
    if (-not $nuget) {
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force -ErrorAction Stop | Out-Null
    }
    Install-Module -Name $Name -MinimumVersion $MinimumVersion -MaximumVersion $MaximumVersion -Scope CurrentUser `
        -Force -SkipPublisherCheck -AllowClobber -ErrorAction Stop
}

foreach ($module in $requiredModules) {
    if (-not (Get-RequiredModule @module)) {
        if (-not $InstallMissing) {
            Show-SetupStatus -Status ACTION -Message ('{0} {1} or later (below 6) is missing. Run this script with -InstallMissing.' -f $module.Name, $module.MinimumVersion)
            exit (Get-SetupExitCode -Name UserAction)
        }
        Show-SetupStatus -Status INSTALLED -Message ('{0}: installing for the current user' -f $module.Name)
        Install-RequiredModule @module
    }
    Import-Module @module -Force -ErrorAction Stop
}

Show-SetupStep -Number 1 -Total 2 -Title 'PSScriptAnalyzer (default rules)'
$findings = @(Invoke-ScriptAnalyzer -Path $setupDir -Recurse)
foreach ($finding in $findings) {
    $file = $finding.ScriptPath.Substring($repoRoot.Length + 1)
    Show-SetupStatus -Status FAILED -Message ('{0}:{1} {2}: {3}' -f $file, $finding.Line, $finding.RuleName, $finding.Message)
}
if ($findings.Count -eq 0) { Show-SetupStatus -Status OK -Message 'no findings' }

Show-SetupStep -Number 2 -Total 2 -Title ('Pester {0}' -f (Get-Module -Name Pester).Version)
$configuration = New-PesterConfiguration
$configuration.Run.Path = $PSScriptRoot
$configuration.Run.PassThru = $true
$configuration.Output.Verbosity = 'Detailed'
$testResult = Invoke-Pester -Configuration $configuration

if ($findings.Count -gt 0 -or $testResult.Result -ne 'Passed') {
    Show-SetupStatus -Status FAILED -Message ('{0} analyzer finding(s), {1} failed test(s)' -f $findings.Count, $testResult.FailedCount)
    exit (Get-SetupExitCode -Name Error)
}
Show-SetupStatus -Status OK -Message ('analyzer clean, {0} tests passed' -f $testResult.PassedCount)
exit (Get-SetupExitCode -Name Ready)
