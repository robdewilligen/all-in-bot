BeforeDiscovery {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList $identity
    $script:elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

BeforeAll {
    $script:setupDir = Split-Path -Parent $PSScriptRoot
    $script:installScript = Join-Path $script:setupDir 'install.ps1'
    Import-Module (Join-Path $script:setupDir 'AllIn.Setup.psm1') -Force

    $script:devItems = @('Windows', 'winget', 'Git', 'Node.js')
    $script:hostItems = @(
        'Windows', 'Virtualization', 'winget', 'Git', 'Node.js', 'WSL', 'Docker Desktop',
        'Sleep on AC power', 'Firewall rule', 'Network profile', 'Old backup task', 'Data directory permissions'
    )

    function script:Invoke-InstallScript {
        param(
            [Parameter(Mandatory)][string]$Folder,
            [string[]]$ArgumentList = @()
        )
        $ErrorActionPreference = 'Continue'
        New-Item -ItemType Directory -Path $Folder -Force | Out-Null
        $resultPath = Join-Path $Folder 'result.json'
        $logDir = Join-Path $Folder 'logs'
        $arguments = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:installScript,
            '-NonInteractive', '-LogDir', $logDir, '-ResultPath', $resultPath
        ) + $ArgumentList
        $output = @(& powershell.exe @arguments 2>&1 | ForEach-Object { [string]$_ })
        [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output = $output
            Result = Import-SetupResult -Path $resultPath
            LogDir = $logDir
        }
    }

    function script:Get-ItemName {
        param([object]$Run)
        @($Run.Result.Results | ForEach-Object { $_.Name }) -join '|'
    }

    function script:Get-FailedItem {
        param([object]$Run)
        @($Run.Result.Results | Where-Object { $_.Status -eq 'FAILED' } | ForEach-Object { Format-SetupResultLine -Result $_ })
    }

    function script:Get-StatusLineCount {
        param([string[]]$Output, [string]$Name)
        $pattern = '^\s+(OK|INSTALLED|ACTION|FAILED|SKIPPED)\s+' + [regex]::Escape($Name) + '(:|$)'
        @($Output | Where-Object { $_ -cmatch $pattern }).Count
    }
}

Describe 'install.ps1 -CheckOnly -Dev' {
    BeforeAll {
        $script:devRun = Invoke-InstallScript -Folder (Join-Path $TestDrive 'dev') -ArgumentList @('-CheckOnly', '-Dev')
    }

    It 'exits with 0, 2 or 3010 and records that code in the result file' {
        $script:devRun.ExitCode | Should -BeIn @(0, 2, 3010)
        $script:devRun.Result.ExitCode | Should -Be $script:devRun.ExitCode
    }

    It 'reports exactly the development items, in order, and none FAILED' {
        Get-ItemName -Run $script:devRun | Should -BeExactly ($script:devItems -join '|')
        Get-FailedItem -Run $script:devRun | Should -BeNullOrEmpty
    }

    It 'prints one status line per item' {
        foreach ($name in $script:devItems) {
            Get-StatusLineCount -Output $script:devRun.Output -Name $name | Should -Be 1 -Because "the status line of $name"
        }
    }

    It 'writes its transcript to -LogDir' {
        @(Get-ChildItem -Path $script:devRun.LogDir -Filter 'install-*.log').Count | Should -Be 1
    }
}

Describe 'install.ps1 -CheckOnly on the database host' {
    BeforeAll {
        $script:hostDataDir = Join-Path $TestDrive 'host-data'
        $script:hostRun = Invoke-InstallScript -Folder (Join-Path $TestDrive 'host') -ArgumentList @('-CheckOnly', '-DataDir', $script:hostDataDir)
    }

    It 'exits with 0, 2 or 3010 and records that code in the result file' {
        $script:hostRun.ExitCode | Should -BeIn @(0, 2, 3010)
        $script:hostRun.Result.ExitCode | Should -Be $script:hostRun.ExitCode
    }

    It 'reports exactly the host items, in order, and none FAILED' {
        Get-ItemName -Run $script:hostRun | Should -BeExactly ($script:hostItems -join '|')
        Get-FailedItem -Run $script:hostRun | Should -BeNullOrEmpty
    }

    It 'prints one status line per item' {
        foreach ($name in $script:hostItems) {
            Get-StatusLineCount -Output $script:hostRun.Output -Name $name | Should -Be 1 -Because "the status line of $name"
        }
    }

    It 'leaves the data directory absent' {
        $script:hostDataDir | Should -Not -Exist
    }
}

Describe 'install.ps1 -CheckOnly with an unprotected .env in the data directory' {
    BeforeAll {
        $script:envDataDir = Join-Path $TestDrive 'env-data'
        New-Item -ItemType Directory -Path $script:envDataDir | Out-Null
        $script:envFile = Join-Path $script:envDataDir '.env'
        Set-Content -LiteralPath $script:envFile -Value 'TEST_ONLY=1'
        $script:envRun = Invoke-InstallScript -Folder (Join-Path $TestDrive 'env') -ArgumentList @('-CheckOnly', '-DataDir', $script:envDataDir)
    }

    It 'reports an ACTION for the permissions and exits with 2 or 3010' {
        $item = @($script:envRun.Result.Results | Where-Object { $_.Name -eq 'Data directory permissions' })
        $item.Count | Should -Be 1
        $item[0].Status | Should -BeExactly 'ACTION'
        $script:envRun.ExitCode | Should -BeIn @(2, 3010)
    }

    It 'leaves the permissions and the content of .env alone' {
        Test-SecretFileProtected -Path $script:envFile | Should -BeFalse
        Get-Content -LiteralPath $script:envFile | Should -BeExactly 'TEST_ONLY=1'
    }
}

Describe 'install.ps1 without -CheckOnly in a window without administrator rights' -Skip:$script:elevated {
    BeforeAll {
        # -Dev: should the elevation check ever break, a development PC that is set up has nothing to install.
        $script:userRun = Invoke-InstallScript -Folder (Join-Path $TestDrive 'user') -ArgumentList @('-Dev')
    }

    It 'exits with 2 and only asks to run setup.cmd' {
        $script:userRun.ExitCode | Should -Be 2
        $script:userRun.Result.ExitCode | Should -Be 2
        @($script:userRun.Result.Results).Count | Should -Be 1
        $script:userRun.Result.Results[0].Status | Should -BeExactly 'ACTION'
        $script:userRun.Result.Results[0].Message | Should -BeExactly 'run setup.cmd; it asks for administrator rights'
    }

    It 'prints that action as a status line' {
        @($script:userRun.Output | Where-Object { $_ -cmatch '^\s+ACTION\s+.*run setup\.cmd; it asks for administrator rights$' }).Count | Should -Be 1
    }
}
