BeforeAll {
    $script:setupDir = Split-Path -Parent $PSScriptRoot
    $script:repoRoot = Split-Path -Parent (Split-Path -Parent $script:setupDir)
    $script:repoEnv = Join-Path $script:repoRoot '.env'
    Import-Module (Join-Path $script:setupDir 'AllIn.Setup.psm1') -Force

    function script:Invoke-SetupScript {
        param([string]$Name, [string[]]$ArgumentList)
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:setupDir $Name)) + $ArgumentList
        Invoke-NativeCommand -FilePath 'powershell.exe' -ArgumentList $arguments -Capture
    }

    function script:Get-FailedLine {
        param([object]$Result)
        @($Result.Results | Where-Object { $_.Status -eq 'FAILED' } | ForEach-Object { Format-SetupResultLine -Result $_ })
    }
}

Describe 'init.ps1 -CheckOnly on the database host' {
    BeforeAll {
        $script:dataDir = Join-Path $TestDrive 'all-in-db'
        $script:logDir = Join-Path $TestDrive 'host-logs'
        $script:resultPath = Join-Path $TestDrive 'host-result.json'
        $script:envExisted = Test-Path -LiteralPath $script:repoEnv
        $script:run = Invoke-SetupScript -Name 'init.ps1' -ArgumentList @(
            '-CheckOnly', '-NonInteractive', '-DataDir', $script:dataDir, '-LogDir', $script:logDir, '-ResultPath', $script:resultPath
        )
        $script:result = Import-SetupResult -Path $script:resultPath
    }

    It 'exits with 0, 2 or 3010' {
        $script:run.ExitCode | Should -BeIn @(0, 2, 3010)
    }

    It 'writes every host step to the result file, in order, with the exit code' {
        @($script:result.Results | ForEach-Object { $_.Name }) | Should -Be @(
            'Prerequisites', 'Docker engine', 'Data directory', 'PostgreSQL', 'Roles and databases',
            'npm packages', 'Migrations', 'Nightly backup', 'bot.env', 'Bot image', 'Slash commands', 'Bot container'
        )
        $script:result.ExitCode | Should -Be $script:run.ExitCode
    }

    It 'reports no FAILED step' {
        Get-FailedLine -Result $script:result | Should -BeNullOrEmpty
    }

    It 'creates neither the data directory nor a .env in the repository' {
        $script:dataDir | Should -Not -Exist
        Test-Path -LiteralPath $script:repoEnv | Should -Be $script:envExisted
    }

    It 'writes its transcript to -LogDir' {
        @(Get-ChildItem -LiteralPath $script:logDir -Filter 'init-*.log').Count | Should -Be 1
    }
}

Describe 'init.ps1 -CheckOnly -Dev' {
    BeforeAll {
        $script:resultPath = Join-Path $TestDrive 'dev-result.json'
        $script:envExisted = Test-Path -LiteralPath $script:repoEnv
        $script:run = Invoke-SetupScript -Name 'init.ps1' -ArgumentList @(
            '-Dev', '-CheckOnly', '-NonInteractive', '-LogDir', (Join-Path $TestDrive 'dev-logs'), '-ResultPath', $script:resultPath
        )
        $script:result = Import-SetupResult -Path $script:resultPath
    }

    It 'exits with 0, 2 or 3010' {
        $script:run.ExitCode | Should -BeIn @(0, 2, 3010)
    }

    It 'writes every development step to the result file, in order' {
        @($script:result.Results | ForEach-Object { $_.Name }) | Should -Be @('npm packages', '.env', 'Database host', 'Migrations')
        $script:result.ExitCode | Should -Be $script:run.ExitCode
    }

    It 'reports no FAILED step' {
        Get-FailedLine -Result $script:result | Should -BeNullOrEmpty
    }

    It 'leaves the repository .env as it was' {
        Test-Path -LiteralPath $script:repoEnv | Should -Be $script:envExisted
    }
}

Describe 'db.ps1 status without a database container' {
    BeforeAll {
        $script:hasContainer = $false
        if (Get-Command docker -ErrorAction SilentlyContinue) {
            $script:hasContainer = [bool](Get-DatabaseContainerId -IncludeStopped)
        }
        $script:dataDir = Join-Path $TestDrive 'status-db'
        $script:logDir = Join-Path $TestDrive 'status-logs'
        if (-not $script:hasContainer) {
            $script:run = Invoke-SetupScript -Name 'db.ps1' -ArgumentList @('status', '-DataDir', $script:dataDir, '-LogDir', $script:logDir)
        }
    }

    It 'exits with 2' {
        if ($script:hasContainer) { Set-ItResult -Skipped -Because 'the database container exists on this PC' }
        $script:run.ExitCode | Should -Be 2
    }

    It 'says what to do' {
        if ($script:hasContainer) { Set-ItResult -Skipped -Because 'the database container exists on this PC' }
        ($script:run.Output -join "`n") | Should -Match 'ACTION .*setup\.cmd'
    }

    It 'writes nothing' {
        if ($script:hasContainer) { Set-ItResult -Skipped -Because 'the database container exists on this PC' }
        $script:dataDir | Should -Not -Exist
        $script:logDir | Should -Not -Exist
    }
}
