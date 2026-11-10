BeforeAll {
    Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'AllIn.Setup.psm1') -Force
}

Describe 'Get-RandomSecret' {
    It 'returns 32 letters and digits by default' {
        Get-RandomSecret | Should -MatchExactly '^[A-Za-z0-9]{32}$'
    }

    It 'honours the requested length' {
        (Get-RandomSecret -Length 40).Length | Should -Be 40
    }

    It 'never repeats over 200 secrets' {
        $secrets = 1..200 | ForEach-Object { Get-RandomSecret }
        @($secrets | Sort-Object -Unique).Count | Should -Be 200
    }

    It 'uses the whole alphabet' {
        $characters = (1..100 | ForEach-Object { Get-RandomSecret }) -join ''
        @($characters.ToCharArray() | Sort-Object -Unique -CaseSensitive).Count | Should -Be 62
    }
}

Describe 'ConvertFrom-EnvText' {
    It 'reads keys and values and skips comments and blank lines' {
        $values = ConvertFrom-EnvText -Text "# comment`nA=1`n`n  B = two `nexport C=3"
        @($values.Keys) | Should -Be @('A', 'B', 'C')
        $values['B'] | Should -Be 'two'
        $values['C'] | Should -Be '3'
    }

    It 'accepts CRLF line endings' {
        $values = ConvertFrom-EnvText -Text "A=1`r`nB=2`r`n"
        $values['A'] | Should -BeExactly '1'
        $values['B'] | Should -BeExactly '2'
    }

    It 'strips matching quotes and keeps = inside values' {
        $values = ConvertFrom-EnvText -Text "A=`"x y`"`nB='z'`nC=postgresql://u:p@h:1/d?x=1"
        $values['A'] | Should -BeExactly 'x y'
        $values['B'] | Should -BeExactly 'z'
        $values['C'] | Should -BeExactly 'postgresql://u:p@h:1/d?x=1'
    }

    It 'returns an empty dictionary for empty text' {
        (ConvertFrom-EnvText -Text '').Count | Should -Be 0
    }
}

Describe 'Merge-EnvText' {
    It 'appends missing keys and keeps comments and order' {
        $text = "# keep me`nPOSTGRES_PASSWORD=old`n"
        $merged = Merge-EnvText -Text $text -Values ([ordered]@{ POSTGRES_PASSWORD = 'new'; ALLIN_PASSWORD = 'added' })
        $merged | Should -BeExactly "# keep me`nPOSTGRES_PASSWORD=old`nALLIN_PASSWORD=added`n"
    }

    It 'never overwrites a filled value' {
        $merged = Merge-EnvText -Text "ALLIN_PASSWORD=secret1`n" -Values @{ ALLIN_PASSWORD = 'other' }
        $merged | Should -BeExactly "ALLIN_PASSWORD=secret1`n"
    }

    It 'fills an empty value in place' {
        $merged = Merge-EnvText -Text "A=1`nALLIN_PASSWORD=`nB=2`n" -Values @{ ALLIN_PASSWORD = 'filled' }
        $merged | Should -BeExactly "A=1`nALLIN_PASSWORD=filled`nB=2`n"
    }

    It 'replaces template values with -ReplaceExisting' {
        $template = "# Discord`nDISCORD_TOKEN=your-token`nLOG_LEVEL=info`n"
        $merged = Merge-EnvText -Text $template -Values ([ordered]@{ DISCORD_TOKEN = 't0k' }) -ReplaceExisting
        $merged | Should -BeExactly "# Discord`nDISCORD_TOKEN=t0k`nLOG_LEVEL=info`n"
    }

    It 'starts a new file from nothing' {
        Merge-EnvText -Text $null -Values ([ordered]@{ A = '1'; B = '2' }) | Should -BeExactly "A=1`nB=2`n"
    }

    It 'normalises CRLF input to LF' {
        Merge-EnvText -Text "A=1`r`n" -Values @{ B = '2' } | Should -BeExactly "A=1`nB=2`n"
    }
}

Describe 'Write-Utf8LfFile and Read-EnvFile' {
    BeforeEach {
        $script:file = Join-Path $TestDrive 'test.env'
    }

    It 'writes UTF-8 without BOM, LF only, with a final newline' {
        Write-Utf8LfFile -Path $script:file -Text "A=1`r`nB=2"
        $bytes = [System.IO.File]::ReadAllBytes($script:file)
        $bytes[0] | Should -Not -Be 0xEF
        $bytes | Should -Not -Contain 13
        [System.Text.Encoding]::UTF8.GetString($bytes) | Should -BeExactly "A=1`nB=2`n"
    }

    It 'resolves relative paths against the PowerShell location' {
        Push-Location $TestDrive
        try {
            Write-Utf8LfFile -Path 'relative.env' -Text 'X=1'
        }
        finally {
            Pop-Location
        }
        Join-Path $TestDrive 'relative.env' | Should -Exist
    }

    It 'round-trips through Read-EnvFile' {
        Write-Utf8LfFile -Path $script:file -Text "# c`nA=1`nB=two`n"
        $values = Read-EnvFile -Path $script:file
        $values['A'] | Should -Be '1'
        $values['B'] | Should -Be 'two'
    }

    It 'reads a missing file as empty' {
        (Read-EnvFile -Path (Join-Path $TestDrive 'missing.env')).Count | Should -Be 0
    }
}

Describe 'Version helpers' {
    It 'compares versions numerically' -ForEach @(
        @{ Version = 'v26.13.0'; Minimum = '26'; Expected = $true }
        @{ Version = 'v24.11.1'; Minimum = '26'; Expected = $false }
        @{ Version = '2.10.0'; Minimum = '2.1.5'; Expected = $true }
        @{ Version = '2.1.4.0'; Minimum = '2.1.5'; Expected = $false }
        @{ Version = 'WSL version: 2.6.1.0'; Minimum = '2.1.5'; Expected = $true }
        @{ Version = ''; Minimum = '1'; Expected = $false }
        @{ Version = 'not a version'; Minimum = '1'; Expected = $false }
    ) {
        Test-VersionAtLeast -Version $Version -Minimum $Minimum | Should -Be $Expected
    }

    It 'reads the major version' {
        Get-MajorVersion -Version 'v26.13.0' | Should -Be 26
        Get-MajorVersion -Version '' | Should -BeNullOrEmpty
    }

    It 'reads the Node major from .nvmrc' -ForEach @(
        @{ Content = "26`n"; Expected = 26 }
        @{ Content = 'v28.1.0'; Expected = 28 }
        @{ Content = 'lts/*'; Expected = $null }
    ) {
        $path = Join-Path $TestDrive '.nvmrc'
        Set-Content -LiteralPath $path -Value $Content -NoNewline
        Get-RequiredNodeMajor -NvmrcPath $path | Should -Be $Expected
    }

    It 'returns nothing when .nvmrc is missing' {
        Get-RequiredNodeMajor -NvmrcPath (Join-Path $TestDrive 'nope') | Should -BeNullOrEmpty
    }
}

Describe 'Connection strings' {
    It 'builds a PostgreSQL URL' {
        Format-PostgresUrl -User 'allin' -Secret 'abc123' -HostName 'localhost' -Port 5432 -Database 'allin' |
            Should -BeExactly 'postgresql://allin:abc123@localhost:5432/allin'
    }

    It 'percent-encodes user and secret' {
        Format-PostgresUrl -User 'a b' -Secret 'p@ss:w/rd' -HostName 'db' -Port 6543 -Database 'x' |
            Should -BeExactly 'postgresql://a%20b:p%40ss%3Aw%2Frd@db:6543/x'
    }

    It 'gives the two dev lines, both as allin_dev' {
        $lines = @(Format-DevConnectionLine -Secret 's3cr3t' -HostName '192.168.1.20' -Port 5432)
        $lines | Should -Be @(
            'DATABASE_URL=postgresql://allin_dev:s3cr3t@192.168.1.20:5432/allin_dev'
            'TEST_DATABASE_URL=postgresql://allin_dev:s3cr3t@192.168.1.20:5432/allin_test'
        )
    }
}

Describe 'Exit codes' {
    BeforeAll {
        function script:New-TestResult {
            param([string]$Status, [switch]$Advisory, [switch]$RebootRequired)
            [pscustomobject]@{ Name = 'x'; Status = $Status; Message = ''; Advisory = [bool]$Advisory; RebootRequired = [bool]$RebootRequired }
        }
    }

    It 'maps the names to 0, 1, 2 and 3010' {
        Get-SetupExitCode -Name Ready | Should -Be 0
        Get-SetupExitCode -Name Error | Should -Be 1
        Get-SetupExitCode -Name UserAction | Should -Be 2
        Get-SetupExitCode -Name Reboot | Should -Be 3010
    }

    It 'is 0 without results and for OK, INSTALLED and SKIPPED' {
        Get-CombinedExitCode -Results @() | Should -Be 0
        Get-CombinedExitCode -Results @((New-TestResult OK), (New-TestResult INSTALLED), (New-TestResult SKIPPED)) | Should -Be 0
    }

    It 'is 2 for a blocking action' {
        Get-CombinedExitCode -Results @((New-TestResult OK), (New-TestResult ACTION)) | Should -Be 2
    }

    It 'ignores advisory actions' {
        Get-CombinedExitCode -Results @((New-TestResult OK), (New-TestResult ACTION -Advisory)) | Should -Be 0
    }

    It 'puts a reboot above an action' {
        Get-CombinedExitCode -Results @((New-TestResult ACTION), (New-TestResult INSTALLED -RebootRequired)) | Should -Be 3010
    }

    It 'puts a failure above everything' {
        Get-CombinedExitCode -Results @((New-TestResult INSTALLED -RebootRequired), (New-TestResult ACTION), (New-TestResult FAILED)) | Should -Be 1
    }

    It 'maps install exit codes to the next step' -ForEach @(
        @{ Code = 0; Expected = 'Continue' }
        @{ Code = 1; Expected = 'Error' }
        @{ Code = 2; Expected = 'UserAction' }
        @{ Code = 3010; Expected = 'Reboot' }
        @{ Code = -1; Expected = 'Error' }
    ) {
        Get-SetupNextStep -InstallExitCode $Code | Should -Be $Expected
    }

    It 'maps winget exit codes' -ForEach @(
        @{ Code = 0; Expected = 'INSTALLED' }
        @{ Code = -1978335135; Expected = 'OK' }
        @{ Code = -1978335189; Expected = 'OK' }
        @{ Code = -1978334967; Expected = 'REBOOT' }
        @{ Code = 3010; Expected = 'REBOOT' }
        @{ Code = 1; Expected = 'FAILED' }
        @{ Code = -1978335212; Expected = 'FAILED' }
    ) {
        Resolve-WingetExitCode -ExitCode $Code | Should -Be $Expected
    }
}

Describe 'Setup results' {
    It 'adds a result without printing when quiet' {
        $list = New-Object System.Collections.Generic.List[object]
        Add-SetupResult -List $list -Name 'Git' -Status INSTALLED -Message '2.56.0' -Quiet
        $list.Count | Should -Be 1
        $list[0].Status | Should -Be 'INSTALLED'
        Format-SetupResultLine -Result $list[0] | Should -BeExactly 'Git: 2.56.0'
    }

    It 'round-trips results and exit code through a file' {
        $list = New-Object System.Collections.Generic.List[object]
        Add-SetupResult -List $list -Name 'WSL' -Status INSTALLED -RebootRequired -Quiet
        $path = Join-Path $TestDrive 'nested\result.json'
        Export-SetupResult -Path $path -Results $list -ExitCode 3010
        $imported = Import-SetupResult -Path $path
        $imported.ExitCode | Should -Be 3010
        @($imported.Results).Count | Should -Be 1
        $imported.Results[0].RebootRequired | Should -BeTrue
        Get-CombinedExitCode -Results $imported.Results | Should -Be 3010
    }

    It 'keeps hints through the result file and prints them under the status line' {
        $list = New-Object System.Collections.Generic.List[object]
        Add-SetupResult -List $list -Name 'Node.js' -Status ACTION -Message 'old' -Hint @('Upgrade it with nvm.', 'Then run setup.cmd again.') -Quiet
        $path = Join-Path $TestDrive 'hint.json'
        Export-SetupResult -Path $path -Results $list -ExitCode 2
        $imported = (Import-SetupResult -Path $path).Results[0]
        @($imported.Hint) | Should -Be @('Upgrade it with nvm.', 'Then run setup.cmd again.')

        Mock -ModuleName 'AllIn.Setup' Write-Host {}
        Show-SetupResult -Result $imported
        Should -Invoke -ModuleName 'AllIn.Setup' Write-Host -Times 1 -ParameterFilter { "$Object" -eq ((' ' * 12) + 'Upgrade it with nvm.') }
    }

    It 'round-trips an empty result list' {
        $path = Join-Path $TestDrive 'empty.json'
        Export-SetupResult -Path $path -Results @() -ExitCode 0
        @((Import-SetupResult -Path $path).Results).Count | Should -Be 0
    }

    It 'returns nothing for a missing result file' {
        Import-SetupResult -Path (Join-Path $TestDrive 'none.json') | Should -BeNullOrEmpty
    }
}

Describe 'Get-RefreshedPath' {
    It 'puts machine and user entries first and keeps process-only entries' {
        Get-RefreshedPath -MachinePath 'C:\Windows;C:\Program Files\nodejs' -UserPath 'C:\Users\me\bin' -CurrentPath 'C:\Windows;C:\repo\node_modules\.bin' |
            Should -BeExactly 'C:\Windows;C:\Program Files\nodejs;C:\Users\me\bin;C:\repo\node_modules\.bin'
    }

    It 'removes duplicates regardless of case and trailing backslash' {
        Get-RefreshedPath -MachinePath 'C:\Tools\' -UserPath 'c:\tools' -CurrentPath '' | Should -BeExactly 'C:\Tools\'
    }

    It 'expands environment variables and drops empty entries' {
        Get-RefreshedPath -MachinePath '%SystemRoot%\system32;;' -UserPath $null -CurrentPath $null |
            Should -BeExactly "$env:SystemRoot\system32"
    }

    It 'updates the session PATH from the registry' {
        $saved = $env:Path
        try {
            $env:Path = 'C:\only-in-this-process'
            Sync-SessionPath
            $env:Path | Should -BeLike '*C:\only-in-this-process'
            $env:Path | Should -BeLike "*$env:SystemRoot*"
        }
        finally {
            $env:Path = $saved
        }
    }
}

Describe 'ConvertTo-MaskedText' {
    It 'hides every secret' {
        ConvertTo-MaskedText -Text 'url postgresql://u:Abc123xyz@h/d and Def456uvw' -Secret @('Abc123xyz', 'Def456uvw') |
            Should -BeExactly 'url postgresql://u:********@h/d and ********'
    }

    It 'hides the percent-encoded form too' {
        ConvertTo-MaskedText -Text 'p%40ss%3Aword' -Secret @('p@ss:word') | Should -BeExactly '********'
    }

    It 'leaves text alone without secrets and ignores short values' {
        ConvertTo-MaskedText -Text 'nothing here' -Secret @() | Should -BeExactly 'nothing here'
        ConvertTo-MaskedText -Text 'a b c' -Secret @('a', '') | Should -BeExactly 'a b c'
    }
}

Describe 'Invoke-NativeCommand' {
    It 'captures masked output and the exit code' {
        $result = Invoke-NativeCommand -FilePath 'cmd.exe' -ArgumentList @('/c', 'echo token=Sup3rS3cret& exit 3') -Secret @('Sup3rS3cret') -Capture
        $result.ExitCode | Should -Be 3
        $result.Output | Should -Contain 'token=********'
    }

    It 'captures stderr without throwing, even with Stop' {
        $ErrorActionPreference = 'Stop'
        $result = Invoke-NativeCommand -FilePath 'cmd.exe' -ArgumentList @('/c', 'echo oops 1>&2') -Capture
        $result.ExitCode | Should -Be 0
        ($result.Output -join "`n") | Should -Match 'oops'
    }

    It 'feeds input text to stdin' {
        $result = Invoke-NativeCommand -FilePath 'findstr.exe' -ArgumentList @('x') -InputText "axb`nccc" -Capture
        $result.Output | Should -Be @('axb')
    }

    It 'gives environment variables to the child only' {
        $name = 'ALLIN_SETUP_TEST_VARIABLE'
        [Environment]::SetEnvironmentVariable($name, 'before', 'Process')
        try {
            $result = Invoke-NativeCommand -FilePath 'cmd.exe' -ArgumentList @('/c', "echo %$name%") -Environment @{ $name = 'child' } -Capture
            $result.Output | Should -Be @('child')
            [Environment]::GetEnvironmentVariable($name, 'Process') | Should -BeExactly 'before'
        }
        finally {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
    }
}

Describe 'Argument helpers' {
    It 'quotes only what needs quoting' {
        ConvertTo-ArgumentString -ArgumentList @('-File', 'C:\My Repo\setup.ps1', '-Port', '5433') |
            Should -BeExactly '-File "C:\My Repo\setup.ps1" -Port 5433'
    }

    It 'escapes quotes and trailing backslashes' {
        ConvertTo-ArgumentString -ArgumentList @('a"b', 'C:\dir with space\', '') |
            Should -BeExactly '"a\"b" "C:\dir with space\\" ""'
    }

    It 'turns bound parameters into an argument list' {
        $bound = [ordered]@{
            Dev = [System.Management.Automation.SwitchParameter]::new($true)
            CheckOnly = [System.Management.Automation.SwitchParameter]::new($false)
            DataDir = 'D:\db data'
            Port = 5433
            ResultPath = 'x'
        }
        $list = ConvertTo-ArgumentList -BoundParameters $bound -Exclude @('ResultPath')
        $list | Should -Be @('-Dev', '-DataDir', 'D:\db data', '-Port', '5433')
    }

    It 'returns an empty list for no parameters' {
        @(ConvertTo-ArgumentList -BoundParameters @{}).Count | Should -Be 0
    }

    It 'builds the RunOnce command through cmd' {
        Get-ResumeCommand -SetupCmdPath 'C:\src\all-in\setup.cmd' -ArgumentList @('-Dev') -CommandProcessor 'C:\Windows\system32\cmd.exe' |
            Should -BeExactly 'C:\Windows\system32\cmd.exe /c "C:\src\all-in\setup.cmd -Dev"'
    }

    It 'keeps a repo path with spaces intact in the RunOnce command' {
        Get-ResumeCommand -SetupCmdPath 'C:\my src\setup.cmd' -CommandProcessor 'C:\Windows\system32\cmd.exe' |
            Should -BeExactly 'C:\Windows\system32\cmd.exe /c ""C:\my src\setup.cmd""'
    }
}

Describe 'Locations' {
    It 'keeps logs and state under all-in in the base directory' {
        $location = Get-SetupLocation -BaseDirectory 'C:\Users\me\AppData\Local'
        $location.LogDir | Should -BeExactly 'C:\Users\me\AppData\Local\all-in\logs'
        $location.StatePath | Should -BeExactly 'C:\Users\me\AppData\Local\all-in\state.json'
    }

    It 'names a log after the script and the start time' {
        Get-SetupLogPath -LogDir 'C:\logs' -Name 'install' -Now ([datetime]'2026-11-09T17:05:09') |
            Should -BeExactly 'C:\logs\install-20261109-170509.log'
    }

    It 'points a failed part to its own log, which the setup transcript does not hold' {
        Format-SetupFailureMessage -TranscriptPath 'C:\logs\setup-1.log' -LogDir 'C:\logs' -FailedPart init |
            Should -BeExactly 'Setup stopped with an error in init.ps1; its FAILED lines are above. Details: the newest init-*.log in C:\logs'
        Format-SetupFailureMessage -TranscriptPath 'C:\logs\setup-1.log' -LogDir 'C:\logs' -FailedPart install |
            Should -BeExactly 'Setup stopped with an error in install.ps1; its FAILED lines are above. Details: the newest install-*.log in C:\logs'
    }

    It 'points an error of setup.ps1 itself to its transcript' {
        Format-SetupFailureMessage -TranscriptPath 'C:\logs\setup-1.log' -LogDir 'C:\logs' |
            Should -BeExactly 'Setup stopped with an error. Details: C:\logs\setup-1.log'
    }

    It 'finds the repo root two levels above the module' {
        Join-Path (Get-RepoRoot) 'scripts\setup\AllIn.Setup.psm1' | Should -Exist
    }
}

Describe 'Resolve-DatabaseOption' {
    It 'uses the defaults without state or parameters' {
        $options = Resolve-DatabaseOption -State @{}
        $options.DataDir | Should -BeExactly 'C:\all-in-db'
        $options.Port | Should -Be 5432
    }

    It 'prefers the saved state over the defaults' {
        $options = Resolve-DatabaseOption -State @{ dataDir = 'D:\pg'; port = 5433 }
        $options.DataDir | Should -BeExactly 'D:\pg'
        $options.Port | Should -Be 5433
    }

    It 'prefers explicit parameters over the saved state' {
        $options = Resolve-DatabaseOption -State @{ dataDir = 'D:\pg'; port = 5433 } -DataDir 'E:\db' -Port 6000
        $options.DataDir | Should -BeExactly 'E:\db'
        $options.Port | Should -Be 6000
    }

    It 'drops a trailing backslash but keeps a drive root' {
        (Resolve-DatabaseOption -State @{} -DataDir 'D:\My Data\').DataDir | Should -BeExactly 'D:\My Data'
        (Resolve-DatabaseOption -State @{} -DataDir 'D:\').DataDir | Should -BeExactly 'D:\'
    }
}

Describe 'Get-DatabaseContainerId' {
    It 'skips docker warnings and returns the container id' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand {
            [pscustomobject]@{ ExitCode = 0; Output = @('WARNING: Error loading config file', '3f2a9c1b7d4e') }
        }
        Get-DatabaseContainerId | Should -BeExactly '3f2a9c1b7d4e'
    }

    It 'returns nothing when only a warning comes back' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand {
            [pscustomobject]@{ ExitCode = 0; Output = @('WARNING: something') }
        }
        Get-DatabaseContainerId | Should -BeNullOrEmpty
    }

    It 'looks for the compose project and service of the database' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 0; Output = @() } }
        Get-DatabaseContainerId -IncludeStopped | Out-Null
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-NativeCommand -Times 1 -Exactly -ParameterFilter {
            ($ArgumentList -join ' ') -eq 'ps -q -a --filter label=com.docker.compose.project=all-in-db --filter label=com.docker.compose.service=postgres'
        }
    }
}

Describe 'Docker lookups for the bot' {
    It 'finds a running container by compose project and service' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 0; Output = @('0123456789ab') } }
        Get-ComposeContainerId -Project 'all-in' -Service 'bot' | Should -BeExactly '0123456789ab'
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-NativeCommand -Times 1 -Exactly -ParameterFilter {
            ($ArgumentList -join ' ') -eq 'ps -q --filter label=com.docker.compose.project=all-in --filter label=com.docker.compose.service=bot'
        }
    }

    It 'returns the id of an image and nothing for a missing one' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 0; Output = @('WARNING: x', ('sha256:' + ('ab' * 32))) } }
        Get-DockerImageId -Name 'all-in-bot' | Should -BeExactly ('sha256:' + ('ab' * 32))
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 1; Output = @('Error: No such image: all-in-bot') } }
        Get-DockerImageId -Name 'all-in-bot' | Should -BeNullOrEmpty
    }

    It 'reads the health of a container, or its state without a healthcheck' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 0; Output = @('healthy') } }
        Get-ContainerHealth -ContainerId 'c1' | Should -BeExactly 'healthy'
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 1; Output = @('Error') } }
        Get-ContainerHealth -ContainerId 'c1' | Should -BeExactly 'unknown'
    }
}

Describe 'Setup state' {
    It 'saves and reads values' {
        $path = Join-Path $TestDrive 'state\state.json'
        Save-SetupState -Path $path -State @{ packageLockHash = 'abc'; port = 5433 }
        $state = Read-SetupState -Path $path
        $state['packageLockHash'] | Should -Be 'abc'
        $state['port'] | Should -Be 5433
    }

    It 'treats a missing or broken file as empty' {
        (Read-SetupState -Path (Join-Path $TestDrive 'none.json')).Count | Should -Be 0
        $broken = Join-Path $TestDrive 'broken.json'
        Set-Content -LiteralPath $broken -Value '{ not json'
        (Read-SetupState -Path $broken).Count | Should -Be 0
    }
}

Describe 'Secret file permissions' {
    It 'restricts a file to the user, Administrators and SYSTEM' {
        $path = Join-Path $TestDrive 'secret.env'
        Set-Content -LiteralPath $path -Value 'A=1'
        Test-SecretFileProtected -Path $path | Should -BeFalse
        Protect-SecretFile -Path $path
        Test-SecretFileProtected -Path $path | Should -BeTrue
        Get-Content -LiteralPath $path | Should -Be 'A=1'
    }

    It 'reports a file with an extra rule as not protected' {
        $path = Join-Path $TestDrive 'extra.env'
        Set-Content -LiteralPath $path -Value 'A=1'
        Protect-SecretFile -Path $path
        $acl = [System.IO.File]::GetAccessControl($path)
        $users = New-Object System.Security.Principal.SecurityIdentifier -ArgumentList 'S-1-5-32-545'
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList $users, 'Read', 'Allow'))
        [System.IO.File]::SetAccessControl($path, $acl)
        Test-SecretFileProtected -Path $path | Should -BeFalse
    }
}

Describe 'Test-TcpPort' {
    It 'sees a listening port and a closed one' {
        $listener = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Loopback), 0
        $listener.Start()
        $port = $listener.LocalEndpoint.Port
        try {
            Test-TcpPort -HostName '127.0.0.1' -Port $port -TimeoutMilliseconds 2000 | Should -BeTrue
        }
        finally {
            $listener.Stop()
        }
        Test-TcpPort -HostName '127.0.0.1' -Port $port -TimeoutMilliseconds 2000 | Should -BeFalse
    }
}

Describe 'Bot settings' {
    It 'lists the required keys that are empty or absent' {
        Get-MissingBotKey -Value ([ordered]@{ DATABASE_URL = 'postgresql://x'; DISCORD_TOKEN = '  '; DEV_GUILD_ID = '1' }) |
            Should -Be @('DISCORD_TOKEN', 'DISCORD_CLIENT_ID')
        @(Get-MissingBotKey -Value @{ DATABASE_URL = 'u'; DISCORD_TOKEN = 't'; DISCORD_CLIENT_ID = 'c' }).Count | Should -Be 0
    }

    It 'accepts an application ID of 17 to 20 digits only: <Value>' -ForEach @(
        @{ Value = '123456789012345678'; Expected = $true }
        @{ Value = '12345678901234567'; Expected = $true }
        @{ Value = '1234567890123456'; Expected = $false }
        @{ Value = '123456789012345678901'; Expected = $false }
        @{ Value = '12345678901234567x'; Expected = $false }
        @{ Value = ''; Expected = $false }
    ) {
        Test-DiscordId -Value $Value | Should -Be $Expected
    }

    It 'accepts a bot token, not a client secret or a public key: <Value>' -ForEach @(
        @{ Value = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.fake_token-Value123'; Expected = $true }
        @{ Value = 'abcdefghijklmnopqrstuvwxyz012345'; Expected = $false }
        @{ Value = 'MTIz.Ga Bc.x'; Expected = $false }
        @{ Value = 'Bot MTIz.GaBc.x'; Expected = $false }
        @{ Value = ''; Expected = $false }
    ) {
        Test-DiscordToken -Value $Value | Should -Be $Expected
    }
}

Describe 'Merge-BotEnvText' {
    It 'fills the template with the production values and keeps none of its example values' {
        $template = "# Discord`nDISCORD_TOKEN=your-token`nDISCORD_CLIENT_ID=`nDEV_GUILD_ID=100000000000000009`n`n# Database`n" +
            "DATABASE_URL=postgresql://user:password@localhost:5432/allin`nTEST_DATABASE_URL=postgresql://user:password@localhost:5432/allin_test`n`n" +
            "DAILY_RESET_TIMEZONE=Europe/Amsterdam`nLOG_LEVEL=info`n"
        $text = Merge-BotEnvText -Text $template -FromTemplate -Values ([ordered]@{ DATABASE_URL = 'postgresql://allin:s@host.docker.internal:5432/allin'; DISCORD_TOKEN = '' })
        $values = ConvertFrom-EnvText -Text $text
        $values['DATABASE_URL'] | Should -BeExactly 'postgresql://allin:s@host.docker.internal:5432/allin'
        $values['DISCORD_TOKEN'] | Should -BeExactly ''
        $values['DISCORD_CLIENT_ID'] | Should -BeExactly ''
        $values['DEV_GUILD_ID'] | Should -BeExactly ''
        $values['TEST_DATABASE_URL'] | Should -BeExactly ''
        $values['DAILY_RESET_TIMEZONE'] | Should -BeExactly 'Europe/Amsterdam'
        $values['LOG_LEVEL'] | Should -BeExactly 'info'
        $text | Should -Match '^# All-in production bot\.'
        $text | Should -Match '(?m)^# Database$'
    }

    It 'never overwrites a filled value of an existing file' {
        $existing = "DATABASE_URL=postgresql://kept`nDISCORD_TOKEN=`nLOG_LEVEL=debug`n"
        $values = [ordered]@{ DATABASE_URL = 'postgresql://new'; DISCORD_TOKEN = 'a.b.c'; DISCORD_CLIENT_ID = '123456789012345678' }
        Merge-BotEnvText -Text $existing -Values $values |
            Should -BeExactly "DATABASE_URL=postgresql://kept`nDISCORD_TOKEN=a.b.c`nLOG_LEVEL=debug`nDISCORD_CLIENT_ID=123456789012345678`n"
    }
}

Describe 'Write-BotEnvFile' {
    BeforeEach {
        $script:envPath = Join-Path $TestDrive ('bot-{0}.env' -f [guid]::NewGuid().ToString('N'))
    }

    It 'creates bot.env private, as UTF-8 without BOM and with LF' {
        $result = Write-BotEnvFile -Path $script:envPath -Template "LOG_LEVEL=info`r`n" -Values ([ordered]@{ DISCORD_TOKEN = 'a.b.c' })
        $result.Created | Should -BeTrue
        Test-SecretFileProtected -Path $script:envPath | Should -BeTrue
        $bytes = [System.IO.File]::ReadAllBytes($script:envPath)
        $bytes[0] | Should -Not -Be 0xEF
        $bytes | Should -Not -Contain 13
        (Read-EnvFile -Path $script:envPath)['DISCORD_TOKEN'] | Should -BeExactly 'a.b.c'
    }

    It 'keeps every value of an existing file and fills only the empty ones' {
        Write-Utf8LfFile -Path $script:envPath -Text "DISCORD_TOKEN=kept.token.value`nDISCORD_CLIENT_ID=`n"
        Protect-SecretFile -Path $script:envPath
        $values = [ordered]@{ DISCORD_TOKEN = 'new.token.value'; DISCORD_CLIENT_ID = '123456789012345678' }
        $result = Write-BotEnvFile -Path $script:envPath -Template 'IGNORED=1' -Values $values
        $result.Created | Should -BeFalse
        $result.Restricted | Should -BeFalse
        [System.IO.File]::ReadAllText($script:envPath) | Should -BeExactly "DISCORD_TOKEN=kept.token.value`nDISCORD_CLIENT_ID=123456789012345678`n"
    }

    It 'restricts an existing file that others can read' {
        Set-Content -LiteralPath $script:envPath -Value 'DISCORD_TOKEN=a.b.c'
        $result = Write-BotEnvFile -Path $script:envPath -Template '' -Values @{}
        $result.Restricted | Should -BeTrue
        Test-SecretFileProtected -Path $script:envPath | Should -BeTrue
        (Read-EnvFile -Path $script:envPath)['DISCORD_TOKEN'] | Should -BeExactly 'a.b.c'
    }
}

Describe 'Invoke-BotCompose' {
    It 'runs docker compose for the project all-in, with bot.env in forward slashes and an empty stdin' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 0; Output = @('done') } }
        $run = Invoke-BotCompose -RepoRoot 'C:\src\all-in' -DataDir 'D:\my data' -Command @('up', '--detach') -Secret @('s3cr3t-value') -Capture
        $run.Output | Should -Be @('done')
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-NativeCommand -Times 1 -Exactly -ParameterFilter {
            $FilePath -eq 'docker' -and
            ($ArgumentList -join '|') -eq 'compose|--project-name|all-in|--file|C:\src\all-in\deploy\compose.yaml|up|--detach' -and
            $Environment['ALLIN_BOT_ENV_FILE'] -eq 'D:/my data/bot.env' -and
            $InputText -eq '' -and $Secret -contains 's3cr3t-value' -and $Capture
        }
    }

    It 'adds extra variables for the child process next to bot.env' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 0; Output = @() } }
        Invoke-BotCompose -RepoRoot 'C:\src\all-in' -DataDir 'D:\data' -Command @('build', 'bot') -Environment @{ BUILDX_NO_DEFAULT_ATTESTATIONS = '1' } | Out-Null
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-NativeCommand -Times 1 -Exactly -ParameterFilter {
            $Environment.Count -eq 2 -and $Environment['ALLIN_BOT_ENV_FILE'] -eq 'D:/data/bot.env' -and $Environment['BUILDX_NO_DEFAULT_ATTESTATIONS'] -eq '1'
        }
    }
}

Describe 'Command definitions' {
    It 'finds the JSON array among the lines of docker compose' {
        $output = @(
            ' Network all-in_default  Creating'
            '[+] Running 1/1'
            '{"level":30,"msg":"loaded"}'
            '[{"name":"balance","description":"Balance"},{"name":"help","description":"Rules"}]'
        )
        $definition = Get-CommandDefinition -Output $output
        $definition.Json | Should -BeExactly '[{"name":"balance","description":"Balance"},{"name":"help","description":"Rules"}]'
        $definition.Count | Should -Be 2
    }

    It 'counts one definition and none' {
        (Get-CommandDefinition -Output @('[{"name":"help"}]')).Count | Should -Be 1
        (Get-CommandDefinition -Output @('[]')).Count | Should -Be 0
    }

    It 'returns nothing without a valid JSON array' {
        Get-CommandDefinition -Output @('[+] Running 1/1', '[{"name":}]', 'Error: no such service') | Should -BeNullOrEmpty
        Get-CommandDefinition -Output @() | Should -BeNullOrEmpty
    }

    It 'hashes the definitions together with the application and server they are registered for' {
        # sha256 of "1`n`n[]", checked with Node's crypto module.
        $hash = Get-CommandDefinitionHash -Json '[]' -ClientId '1' -GuildId ''
        $hash | Should -BeExactly '0b54edcca5f139b5e9f4764f2ce4371050e232501fcb61df82e477894cabb7f2'
        Get-CommandDefinitionHash -Json '[{"name":"help"}]' -ClientId '1' -GuildId '' | Should -Not -Be $hash
        Get-CommandDefinitionHash -Json '[]' -ClientId '2' -GuildId '' | Should -Not -Be $hash
        Get-CommandDefinitionHash -Json '[]' -ClientId '1' -GuildId '3' | Should -Not -Be $hash
    }
}

Describe 'Invoke-BotDeployment' {
    BeforeAll {
        $script:token = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.fake_token-Value123'
        $script:clientId = '123456789012345678'
        $script:definitions = '[{"name":"balance","description":"Balance"},{"name":"help","description":"Rules"}]'
        $script:expectedHash = Get-CommandDefinitionHash -Json $script:definitions -ClientId $script:clientId -GuildId ''
        $script:expectedUrl = 'postgresql://allin:p%40ss%3Aw%2Frd@host.docker.internal:5432/allin'
        $script:template = "# Discord`nDISCORD_TOKEN=`nDISCORD_CLIENT_ID=`nDEV_GUILD_ID=`n`n# Database`nDATABASE_URL=`nTEST_DATABASE_URL=`n`n" +
            "DAILY_RESET_TIMEZONE=Europe/Amsterdam`nLOG_LEVEL=info`n"

        function script:Invoke-Deployment {
            param([switch]$CheckOnly, [switch]$NonInteractive, [switch]$NoDatabase)
            Invoke-BotDeployment -Results $script:results -RepoRoot $script:repoDir -DataDir $script:dataDir -Port 5432 `
                -State $script:state -StatePath $script:statePath -Secret @('DbSecretValue') -CheckOnly:$CheckOnly `
                -NonInteractive:$NonInteractive -DataReady -DockerReady -DatabaseReady:(-not $NoDatabase)
        }

        function script:Get-ResultSummary {
            @($script:results | ForEach-Object { '{0}={1}' -f $_.Name, $_.Status })
        }

        function script:Get-ResultFor {
            param([string]$Name)
            @($script:results | Where-Object { $_.Name -eq $Name })[0]
        }

        function script:Write-CompleteBotEnv {
            $path = Join-Path $script:dataDir 'bot.env'
            Write-Utf8LfFile -Path $path -Text ("DATABASE_URL={0}`nDISCORD_TOKEN={1}`nDISCORD_CLIENT_ID={2}`nDEV_GUILD_ID=`n" -f $script:expectedUrl, $script:token, $script:clientId)
            Protect-SecretFile -Path $path
        }

        function script:Read-BotEnv {
            Read-EnvFile -Path (Join-Path $script:dataDir 'bot.env')
        }
    }

    BeforeEach {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $script:repoDir = Join-Path $root 'repo'
        $script:dataDir = Join-Path $root 'data'
        $script:statePath = Join-Path $root 'state.json'
        New-Item -ItemType Directory -Path $script:repoDir, $script:dataDir | Out-Null
        Write-Utf8LfFile -Path (Join-Path $script:repoDir '.env.example') -Text $script:template
        Write-Utf8LfFile -Path (Join-Path $script:dataDir '.env') -Text "POSTGRES_PASSWORD=x1`nALLIN_PASSWORD=p@ss:w/rd`nALLIN_DEV_PASSWORD=y1`n"
        $script:results = New-Object System.Collections.Generic.List[object]
        $script:state = @{}
        $script:imageIds = New-Object System.Collections.Queue
        $script:containerIds = New-Object System.Collections.Queue
        $script:exitCodes = @{ build = 0; register = 0; up = 0 }

        Mock -ModuleName 'AllIn.Setup' Write-Host {}
        Mock -ModuleName 'AllIn.Setup' Read-SecretValue { $script:token }
        Mock -ModuleName 'AllIn.Setup' Read-Host { $script:clientId }
        Mock -ModuleName 'AllIn.Setup' Get-DockerImageId { $script:imageIds.Dequeue() }
        Mock -ModuleName 'AllIn.Setup' Get-ComposeContainerId { $script:containerIds.Dequeue() }
        Mock -ModuleName 'AllIn.Setup' Get-ContainerHealth { 'healthy' }
        Mock -ModuleName 'AllIn.Setup' Invoke-BotCompose { [pscustomobject]@{ ExitCode = $script:exitCodes['build']; Output = @() } } -ParameterFilter {
            $Command[0] -eq 'build'
        }
        Mock -ModuleName 'AllIn.Setup' Invoke-BotCompose { [pscustomobject]@{ ExitCode = 0; Output = @('[+] Running 1/1', $script:definitions) } } -ParameterFilter {
            $Command -contains '--print'
        }
        Mock -ModuleName 'AllIn.Setup' Invoke-BotCompose { [pscustomobject]@{ ExitCode = $script:exitCodes['register']; Output = @() } } -ParameterFilter {
            $Command[0] -eq 'run' -and $Command -notcontains '--print'
        }
        Mock -ModuleName 'AllIn.Setup' Invoke-BotCompose { [pscustomobject]@{ ExitCode = $script:exitCodes['up']; Output = @() } } -ParameterFilter {
            $Command[0] -eq 'up'
        }
    }

    It 'on a first run writes bot.env from the answers, builds, registers the commands and starts the bot' {
        $script:imageIds.Enqueue($null)
        $script:imageIds.Enqueue('sha256:new')
        $script:containerIds.Enqueue($null)
        $script:containerIds.Enqueue('c2')

        Invoke-Deployment

        Get-ResultSummary | Should -Be @('bot.env=INSTALLED', 'Bot image=INSTALLED', 'Slash commands=INSTALLED', 'Bot container=INSTALLED')
        (Get-ResultFor -Name 'Slash commands').Message | Should -BeExactly 'registered 2 commands globally'
        $values = Read-BotEnv
        $values['DATABASE_URL'] | Should -BeExactly $script:expectedUrl
        $values['DISCORD_TOKEN'] | Should -BeExactly $script:token
        $values['DISCORD_CLIENT_ID'] | Should -BeExactly $script:clientId
        $values['DEV_GUILD_ID'] | Should -BeExactly ''
        $values['TEST_DATABASE_URL'] | Should -BeExactly ''
        Test-SecretFileProtected -Path (Join-Path $script:dataDir 'bot.env') | Should -BeTrue
        (Read-SetupState -Path $script:statePath)['botCommandsHash'] | Should -BeExactly $script:expectedHash
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 1 -Exactly -ParameterFilter {
            $Command[0] -eq 'run' -and $Command -notcontains '--print' -and $Secret -contains $script:token
        }
        Should -Invoke -ModuleName 'AllIn.Setup' Write-Host -Times 0 -Exactly -ParameterFilter { "$Object" -match 'fake_token|p@ss|p%40ss' }
    }

    It 'with nothing changed reports OK, without prompting or registering' {
        Write-CompleteBotEnv
        $script:state['botCommandsHash'] = $script:expectedHash
        $script:imageIds.Enqueue('sha256:same')
        $script:imageIds.Enqueue('sha256:same')
        $script:containerIds.Enqueue('c1')
        $script:containerIds.Enqueue('c1')

        Invoke-Deployment

        Get-ResultSummary | Should -Be @('bot.env=OK', 'Bot image=OK', 'Slash commands=OK', 'Bot container=OK')
        Should -Invoke -ModuleName 'AllIn.Setup' Read-SecretValue -Times 0 -Exactly
        Should -Invoke -ModuleName 'AllIn.Setup' Read-Host -Times 0 -Exactly
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 0 -Exactly -ParameterFilter { $Command[0] -eq 'run' -and $Command -notcontains '--print' }
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 1 -Exactly -ParameterFilter { $Command[0] -eq 'up' }
    }

    It 'registers the commands again when their definitions changed' {
        Write-CompleteBotEnv
        $script:state['botCommandsHash'] = 'the hash of older definitions'
        $script:imageIds.Enqueue('sha256:old')
        $script:imageIds.Enqueue('sha256:new')
        $script:containerIds.Enqueue('c1')
        $script:containerIds.Enqueue('c2')

        Invoke-Deployment

        Get-ResultSummary | Should -Be @('bot.env=OK', 'Bot image=INSTALLED', 'Slash commands=INSTALLED', 'Bot container=INSTALLED')
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 1 -Exactly -ParameterFilter { $Command[0] -eq 'run' -and $Command -notcontains '--print' }
        $script:state['botCommandsHash'] | Should -BeExactly $script:expectedHash
    }

    It 'keeps the values of an existing bot.env and asks only for the missing one' {
        $path = Join-Path $script:dataDir 'bot.env'
        Write-Utf8LfFile -Path $path -Text "DATABASE_URL=postgresql://allin:kept@db.example:5433/allin`nDISCORD_TOKEN=`nDISCORD_CLIENT_ID=999999999999999999`n"
        Protect-SecretFile -Path $path
        $script:imageIds.Enqueue('sha256:same')
        $script:imageIds.Enqueue('sha256:same')
        $script:containerIds.Enqueue('c1')
        $script:containerIds.Enqueue('c1')

        Invoke-Deployment

        $values = Read-BotEnv
        $values['DATABASE_URL'] | Should -BeExactly 'postgresql://allin:kept@db.example:5433/allin'
        $values['DISCORD_CLIENT_ID'] | Should -BeExactly '999999999999999999'
        $values['DISCORD_TOKEN'] | Should -BeExactly $script:token
        (Get-ResultFor -Name 'bot.env').Message | Should -BeExactly "${path}: filled in DISCORD_TOKEN"
        Should -Invoke -ModuleName 'AllIn.Setup' Read-SecretValue -Times 1 -Exactly
        Should -Invoke -ModuleName 'AllIn.Setup' Read-Host -Times 0 -Exactly
    }

    It 'with -NonInteractive fills in what it can, never prompts and stops before Docker' {
        Invoke-Deployment -NonInteractive

        Get-ResultSummary | Should -Be @('bot.env=ACTION', 'Bot image=SKIPPED', 'Slash commands=SKIPPED', 'Bot container=SKIPPED')
        (Get-ResultFor -Name 'bot.env').Message | Should -BeLike 'fill in DISCORD_TOKEN, DISCORD_CLIENT_ID in *bot.env, then run setup.cmd again'
        (Get-ResultFor -Name 'Bot image').Message | Should -BeExactly 'needs a complete bot.env (above)'
        $values = Read-BotEnv
        $values['DATABASE_URL'] | Should -BeExactly $script:expectedUrl
        $values['DISCORD_TOKEN'] | Should -BeExactly ''
        Should -Invoke -ModuleName 'AllIn.Setup' Read-SecretValue -Times 0 -Exactly
        Should -Invoke -ModuleName 'AllIn.Setup' Read-Host -Times 0 -Exactly
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 0 -Exactly
    }

    It 'does not save an answer that is not a bot token' {
        Mock -ModuleName 'AllIn.Setup' Read-SecretValue { 'abcdefghijklmnopqrstuvwxyz012345' }

        Invoke-Deployment

        Get-ResultSummary | Should -Be @('bot.env=ACTION', 'Bot image=SKIPPED', 'Slash commands=SKIPPED', 'Bot container=SKIPPED')
        $values = Read-BotEnv
        $values['DISCORD_TOKEN'] | Should -BeExactly ''
        $values['DISCORD_CLIENT_ID'] | Should -BeExactly $script:clientId
    }

    It 'leaves the running bot alone when the build fails' {
        Write-CompleteBotEnv
        $script:imageIds.Enqueue('sha256:old')
        $script:exitCodes['build'] = 1

        Invoke-Deployment

        Get-ResultSummary | Should -Be @('bot.env=OK', 'Bot image=FAILED', 'Slash commands=SKIPPED', 'Bot container=SKIPPED')
        (Get-ResultFor -Name 'Bot container').Message | Should -BeExactly 'needs the image (above); the running bot was left alone'
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 1 -Exactly
    }

    It 'does not restart the bot when registering the commands fails' {
        Write-CompleteBotEnv
        $script:imageIds.Enqueue('sha256:old')
        $script:imageIds.Enqueue('sha256:new')
        $script:exitCodes['register'] = 1

        Invoke-Deployment

        Get-ResultSummary | Should -Be @('bot.env=OK', 'Bot image=INSTALLED', 'Slash commands=FAILED', 'Bot container=SKIPPED')
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 0 -Exactly -ParameterFilter { $Command[0] -eq 'up' }
        $script:state.ContainsKey('botCommandsHash') | Should -BeFalse
        $script:statePath | Should -Not -Exist
    }

    It 'shows the command for the log when the bot does not come online' {
        Write-CompleteBotEnv
        $script:state['botCommandsHash'] = $script:expectedHash
        $script:imageIds.Enqueue('sha256:same')
        $script:imageIds.Enqueue('sha256:same')
        $script:containerIds.Enqueue('c1')
        $script:exitCodes['up'] = 1

        Invoke-Deployment

        $container = Get-ResultFor -Name 'Bot container'
        $container.Status | Should -BeExactly 'FAILED'
        @($container.Hint) | Should -Be @('Its log says why: docker logs --tail 100 all-in-bot-1')
    }

    It 'waits for the roles and databases before any Docker work' {
        Write-CompleteBotEnv

        Invoke-Deployment -NoDatabase

        Get-ResultSummary | Should -Be @('bot.env=OK', 'Bot image=SKIPPED', 'Slash commands=SKIPPED', 'Bot container=SKIPPED')
        (Get-ResultFor -Name 'Bot image').Message | Should -BeExactly 'needs the roles and databases (step 5)'
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 0 -Exactly
    }

    It 'builds the image without default attestations, so an unchanged build keeps its image id' {
        Write-CompleteBotEnv
        $script:state['botCommandsHash'] = $script:expectedHash
        $script:imageIds.Enqueue('sha256:same')
        $script:imageIds.Enqueue('sha256:same')
        $script:containerIds.Enqueue('c1')
        $script:containerIds.Enqueue('c1')

        Invoke-Deployment

        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 1 -Exactly -ParameterFilter {
            $Command[0] -eq 'build' -and $Environment['BUILDX_NO_DEFAULT_ATTESTATIONS'] -eq '1'
        }
    }

    It 'with -CheckOnly reports and changes nothing' {
        $script:containerIds.Enqueue($null)

        Invoke-Deployment -CheckOnly

        Get-ResultSummary | Should -Be @('bot.env=ACTION', 'Bot image=SKIPPED', 'Slash commands=SKIPPED', 'Bot container=ACTION')
        Join-Path $script:dataDir 'bot.env' | Should -Not -Exist
        $script:statePath | Should -Not -Exist
        Should -Invoke -ModuleName 'AllIn.Setup' Read-SecretValue -Times 0 -Exactly
        Should -Invoke -ModuleName 'AllIn.Setup' Read-Host -Times 0 -Exactly
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-BotCompose -Times 0 -Exactly
    }

    It 'with -CheckOnly reports a bot that is logged in' {
        Write-CompleteBotEnv
        $script:containerIds.Enqueue('c1')

        Invoke-Deployment -CheckOnly

        Get-ResultSummary | Should -Be @('bot.env=OK', 'Bot image=SKIPPED', 'Slash commands=SKIPPED', 'Bot container=OK')
    }
}

Describe 'Get-HostMigrationPlan' {
    It 'migrates allin, allin_dev and allin_test on the host without the bot' {
        $plan = Get-HostMigrationPlan
        @($plan.Targets | ForEach-Object { '{0}/{1}/{2}' -f $_.Database, $_.Role, $_.SecretKey }) |
            Should -Be @('allin/allin/ALLIN_PASSWORD', 'allin_dev/allin_dev/ALLIN_DEV_PASSWORD', 'allin_test/allin_dev/ALLIN_DEV_PASSWORD')
        $plan.Summary | Should -BeExactly 'allin, allin_dev and allin_test are up to date'
    }

    It 'leaves allin to the bot container, which migrates it after compose has stopped the old bot' {
        $plan = Get-HostMigrationPlan -WithBot
        @($plan.Targets | ForEach-Object { '{0}/{1}/{2}' -f $_.Database, $_.Role, $_.SecretKey }) |
            Should -Be @('allin_dev/allin_dev/ALLIN_DEV_PASSWORD', 'allin_test/allin_dev/ALLIN_DEV_PASSWORD')
        $plan.Summary | Should -BeExactly 'allin_dev and allin_test are up to date; allin is migrated by the bot container when it starts (step 9)'
    }
}

Describe 'Test-BotDatabaseReady' {
    It 'is <Expected> for <Case>' -ForEach @(
        @{ Case = 'roles OK and migrations FAILED'; Steps = @('Roles and databases=OK', 'npm packages=OK', 'Migrations=FAILED'); Expected = $true }
        @{ Case = 'roles INSTALLED and npm packages FAILED'; Steps = @('Roles and databases=INSTALLED', 'npm packages=FAILED', 'Migrations=SKIPPED'); Expected = $true }
        @{ Case = 'roles SKIPPED'; Steps = @('PostgreSQL=FAILED', 'Roles and databases=SKIPPED', 'Migrations=SKIPPED'); Expected = $false }
        @{ Case = 'roles FAILED'; Steps = @('Roles and databases=FAILED', 'Migrations=OK'); Expected = $false }
        @{ Case = 'no roles step'; Steps = @('npm packages=OK', 'Migrations=OK'); Expected = $false }
        @{ Case = 'no results'; Steps = @(); Expected = $false }
    ) {
        $list = New-Object System.Collections.Generic.List[object]
        foreach ($step in $Steps) {
            $stepName, $stepStatus = $step.Split('=')
            Add-SetupResult -List $list -Name $stepName -Status $stepStatus -Quiet
        }
        Test-BotDatabaseReady -Results $list.ToArray() | Should -Be $Expected
    }
}

Describe 'Get-RunningBotContainerId' {
    It 'looks for the running bot container when the database is allin' {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 0; Output = @('0123456789ab') } }
        Get-RunningBotContainerId -Database 'allin' | Should -BeExactly '0123456789ab'
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-NativeCommand -Times 1 -Exactly -ParameterFilter {
            ($ArgumentList -join ' ') -eq 'ps -q --filter label=com.docker.compose.project=all-in --filter label=com.docker.compose.service=bot'
        }
    }

    It 'does not look for the bot for <Database>' -ForEach @(@{ Database = 'allin_dev' }, @{ Database = 'allin_test' }) {
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand { [pscustomobject]@{ ExitCode = 0; Output = @('0123456789ab') } }
        Get-RunningBotContainerId -Database $Database | Should -BeNullOrEmpty
        Should -Invoke -ModuleName 'AllIn.Setup' Invoke-NativeCommand -Times 0 -Exactly
    }
}

Describe 'Invoke-DatabaseRestore' {
    BeforeAll {
        $script:dumpName = 'allin-20261109-033000.dump'
        $script:restoreArguments = "exec db1 pg_restore -U postgres --clean --if-exists --single-transaction -d allin /backups/$script:dumpName"

        function script:Invoke-Restore {
            param([string]$Database = 'allin', [string]$Owner = 'allin', [string]$BotContainerId = 'bot1')
            Invoke-DatabaseRestore -ContainerId 'db1' -Database $Database -Owner $Owner -DumpName $script:dumpName -BotContainerId $BotContainerId
        }
    }

    BeforeEach {
        $script:calls = New-Object System.Collections.Generic.List[string]
        $script:dockerExitCodes = @{ stop = 0; exec = 0; start = 0 }
        $script:restoreThrows = $false
        Mock -ModuleName 'AllIn.Setup' Write-Host {}
        Mock -ModuleName 'AllIn.Setup' Invoke-NativeCommand {
            $script:calls.Add($ArgumentList -join ' ')
            if ($ArgumentList[0] -eq 'exec' -and $script:restoreThrows) { throw 'the Docker engine went away' }
            [pscustomobject]@{ ExitCode = $script:dockerExitCodes[$ArgumentList[0]]; Output = @() }
        }
    }

    It 'stops the bot, restores allin and starts the bot again' {
        Invoke-Restore | Should -Be 0
        @($script:calls) | Should -Be @('stop bot1', $script:restoreArguments, 'start bot1')
        Should -Invoke -ModuleName 'AllIn.Setup' Write-Host -Times 1 -Exactly -ParameterFilter {
            "$Object" -match '^  OK +Started the bot again \(all-in-bot-1\); it refunds the open rounds before it logs in\.$'
        }
    }

    It 'starts the bot again after a failing restore' {
        $script:dockerExitCodes['exec'] = 1
        Invoke-Restore | Should -Be 1
        @($script:calls) | Should -Be @('stop bot1', $script:restoreArguments, 'start bot1')
    }

    It 'starts the bot again when the restore throws' {
        $script:restoreThrows = $true
        { Invoke-Restore } | Should -Throw '*the Docker engine went away*'
        @($script:calls) | Should -Be @('stop bot1', $script:restoreArguments, 'start bot1')
    }

    It 'restores nothing when the bot does not stop' {
        $script:dockerExitCodes['stop'] = 1
        Invoke-Restore | Should -Be 1
        @($script:calls) | Should -Be @('stop bot1')
        Should -Invoke -ModuleName 'AllIn.Setup' Write-Host -Times 1 -Exactly -ParameterFilter { "$Object" -match '^  FAILED +Nothing restored: ' }
    }

    It 'fails with the command to start the bot when it does not start again' {
        $script:dockerExitCodes['start'] = 1
        Invoke-Restore | Should -Be 1
        @($script:calls) | Should -Be @('stop bot1', $script:restoreArguments, 'start bot1')
        Should -Invoke -ModuleName 'AllIn.Setup' Write-Host -Times 1 -Exactly -ParameterFilter { "$Object" -match '^  FAILED +The bot did not start again .*: docker start all-in-bot-1$' }
    }

    It 'restores allin without a running bot exactly as before' {
        Invoke-Restore -BotContainerId '' | Should -Be 0
        @($script:calls) | Should -Be @($script:restoreArguments)
    }

    It 'restores <Database> as allin_dev without touching the bot' -ForEach @(@{ Database = 'allin_dev' }, @{ Database = 'allin_test' }) {
        Invoke-Restore -Database $Database -Owner 'allin_dev' -BotContainerId '' | Should -Be 0
        @($script:calls) | Should -Be @("exec db1 pg_restore -U postgres --clean --if-exists --single-transaction -d $Database --no-owner --no-acl --role=allin_dev /backups/$script:dumpName")
    }
}
