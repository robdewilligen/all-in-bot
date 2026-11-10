BeforeDiscovery {
    $script:setupDir = Split-Path -Parent $PSScriptRoot
    $script:repoRoot = Split-Path -Parent (Split-Path -Parent $script:setupDir)
    $script:scriptFiles = @(Get-ChildItem -Path $script:setupDir -Recurse -Include '*.ps1', '*.psm1' -File | ForEach-Object {
            @{ Path = $_.FullName; Name = $_.FullName.Substring($script:repoRoot.Length + 1) }
        })
    $script:asciiFiles = @($script:scriptFiles)
    $setupCmd = Join-Path $script:repoRoot 'setup.cmd'
    if (Test-Path -LiteralPath $setupCmd) { $script:asciiFiles += @{ Path = $setupCmd; Name = 'setup.cmd' } }
}

Describe 'Script files' {
    It '<Name> parses in this PowerShell' -ForEach $script:scriptFiles {
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
        $errors | Should -BeNullOrEmpty
    }

    # Windows PowerShell 5.1 reads a BOM-less file as ANSI, so anything beyond ASCII would be garbled.
    It '<Name> is plain ASCII' -ForEach $script:asciiFiles {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        @($bytes | Where-Object { $_ -gt 127 }).Count | Should -Be 0
    }
}
