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
