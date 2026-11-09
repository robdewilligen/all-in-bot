BeforeAll {
    $script:repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    $script:setupCmd = Join-Path $script:repoRoot 'setup.cmd'

    function script:Invoke-SetupCmd {
        param([string[]]$ArgumentList)
        # CI runs with Stop; in 5.1 the child's stderr through 2>&1 would then throw instead of being captured.
        $ErrorActionPreference = 'Continue'
        $savedLocalAppData = $env:LOCALAPPDATA
        try {
            # setup.ps1 keeps its logs and state under LOCALAPPDATA; keep test runs out of the real one.
            $env:LOCALAPPDATA = $TestDrive
            $output = & cmd.exe /d /c $script:setupCmd @ArgumentList 2>&1 | ForEach-Object { [string]$_ }
            [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
        }
        finally {
            $env:LOCALAPPDATA = $savedLocalAppData
        }
    }
}

Describe 'setup.cmd' {
    It 'passes a failing exit code through' {
        $run = Invoke-SetupCmd -ArgumentList @('-Port', '0')
        $run.ExitCode | Should -Be 1
    }

    It 'checks a development PC without changing anything' {
        $run = Invoke-SetupCmd -ArgumentList @('-CheckOnly', '-Dev', '-NonInteractive')
        $run.ExitCode | Should -BeIn @(0, 2, 3010)
        $run.Output | Should -Match '=== Summary ==='
        $run.Output | Should -Not -Match '(?m)^\s*FAILED '
        @(Get-ChildItem -Path (Join-Path $TestDrive 'all-in\logs') -Filter 'setup-*.log').Count | Should -BeGreaterThan 0
        Join-Path $TestDrive 'all-in\install-check.json' | Should -Exist
        Join-Path $TestDrive 'all-in\init-result.json' | Should -Exist
    }

    It 'checks a database host without creating its data directory' {
        $dataDir = Join-Path $TestDrive 'db-data'
        $run = Invoke-SetupCmd -ArgumentList @('-CheckOnly', '-NonInteractive', '-DataDir', $dataDir, '-Port', '55432')
        $run.ExitCode | Should -BeIn @(0, 2, 3010)
        $run.Output | Should -Match '=== Summary ==='
        $run.Output | Should -Not -Match '(?m)^\s*FAILED '
        $dataDir | Should -Not -Exist
    }
}
