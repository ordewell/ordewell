# Installs the Ordewell desktop app for the current user on Windows
# (PowerShell 5.1 and 7; ADR-0060 H10):
#
#   irm https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.ps1 | iex
#
# It downloads the NSIS installer from the GitHub Release over https, checks
# its SHA-256 against the release's SHA256SUMS and stops on any mismatch, then
# runs it silently for the current user: no administrator, no prompt. Running it
# again upgrades. It never unblocks a file or changes a SmartScreen setting.
#
# Options (when the script is run as a file or a script block; `| iex` cannot
# pass any, so there they are the environment variables below):
#   -Version X.Y.Z   install that release instead of the latest (or ORDEWELL_VERSION)
#   -Uninstall       remove the per-user install this script made
#   -DryRun          say what would be downloaded and installed, and do nothing
#   -Help
#
#   & ([scriptblock]::Create((irm <the URL above>))) -Version 0.12.3
#   & ([scriptblock]::Create((irm <the URL above>))) -Uninstall
#
# Environment:
#   ORDEWELL_VERSION       the same as -Version
#   ORDEWELL_DESKTOP_FROM  a directory holding Ordewell-win-x64.exe and
#                          SHA256SUMS (see scripts/desktop-release-assets.mjs),
#                          used instead of downloading
#   ORDEWELL_INSTALL_DIR   the folder to install into, instead of the installer's
#                          default under %LOCALAPPDATA%\Programs
#
# Arguments are read from $args by hand, not from a param() block, because a
# param() block does not survive `| iex`. Nothing here calls `exit`, which
# would close the shell of someone who piped it to iex.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Invoke-OrdewellDesktop {
    param([object[]]$Arguments)

    $repo = 'ordewell/ordewell'
    $asset = 'Ordewell-win-x64.exe'

    function Fail([string]$Message) { throw "ordewell-desktop: $Message" }

    if ($null -eq $Arguments) { $Arguments = @() }
    $version = $env:ORDEWELL_VERSION
    $uninstall = $false
    $dryRun = $false
    $help = $false
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $arg = [string]$Arguments[$i]
        $name = $arg
        $inline = $null
        if ($arg -match '^(-{1,2}[A-Za-z]+):(.*)$') { $name = $Matches[1]; $inline = $Matches[2] }
        if ($name -ieq '-Version' -or $name -ieq '--version') {
            if ($null -ne $inline -and $inline -ne '') {
                $version = $inline
            } elseif ($i + 1 -lt $Arguments.Count) {
                $i++
                $version = [string]$Arguments[$i]
            } else {
                Fail '-Version needs a value, for example -Version 0.12.3'
            }
        } elseif ($name -ieq '-Uninstall' -or $name -ieq '--uninstall') {
            $uninstall = $true
        } elseif ($name -ieq '-DryRun' -or $name -ieq '--dry-run') {
            $dryRun = $true
        } elseif ($name -ieq '-Help' -or $name -ieq '-h' -or $name -ieq '--help') {
            $help = $true
        } else {
            Fail "unknown option: $arg (try -Help)"
        }
    }

    if ($help) {
        Write-Host 'Installs the Ordewell desktop app for the current user (Windows).'
        Write-Host ''
        Write-Host 'Usage: desktop.ps1 [-Version X.Y.Z] [-Uninstall] [-DryRun]'
        Write-Host ''
        Write-Host '  -Version X.Y.Z  install that release instead of the latest (or ORDEWELL_VERSION)'
        Write-Host '  -Uninstall      remove the per-user install this script made'
        Write-Host '  -DryRun         say what would be downloaded and installed, and do nothing'
        Write-Host ''
        Write-Host 'Environment: ORDEWELL_VERSION, ORDEWELL_DESKTOP_FROM (a directory with'
        Write-Host "$asset and SHA256SUMS, used instead of downloading), ORDEWELL_INSTALL_DIR."
        return
    }

    # A version names a release tag, so it is checked before it reaches a URL.
    if ($version) {
        $version = $version.Trim()
        if ($version.StartsWith('v')) { $version = $version.Substring(1) }
        if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.+-]+)?$') {
            Fail "not a version: $version (expected X.Y.Z)"
        }
    }

    $onWindows = ($env:OS -eq 'Windows_NT')
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -and $arch -ne 'AMD64' -and $arch -ne 'ARM64') {
        Fail "no Ordewell desktop build for the $arch architecture"
    }

    function Get-OrdewellInstall {
        $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
        if (-not (Test-Path -LiteralPath $root)) { return $null }
        foreach ($key in Get-ChildItem -LiteralPath $root) {
            $item = Get-ItemProperty -LiteralPath $key.PSPath
            $props = $item.PSObject.Properties.Name
            if ($props -notcontains 'DisplayName' -or $props -notcontains 'InstallLocation') { continue }
            # electron-builder names the entry "<product> <version>"; the
            # uninstaller's file name makes sure it is this app's.
            if ($item.DisplayName -notmatch '^Ordewell( [0-9].*)?$') { continue }
            if (-not (Test-Path -LiteralPath (Join-Path $item.InstallLocation 'Uninstall Ordewell.exe'))) { continue }
            return $item
        }
        return $null
    }

    if ($uninstall) {
        if ($dryRun) { Write-Host 'Would remove the per-user Ordewell install.'; return }
        if (-not $onWindows) { Fail 'this installer is for Windows; use scripts/install/desktop.sh on macOS and Linux' }
        $entry = Get-OrdewellInstall
        if ($null -eq $entry) {
            Write-Host 'No per-user Ordewell install found, so nothing was removed.'
            return
        }
        if (Get-Process -Name 'Ordewell' -ErrorAction SilentlyContinue) {
            Fail 'Ordewell is running; quit it and run this again'
        }
        $dir = $entry.InstallLocation.TrimEnd('\')
        $uninstaller = Join-Path $dir 'Uninstall Ordewell.exe'
        # `_?=` makes the uninstaller run in place, so -Wait waits for it; it
        # then leaves itself and the folder behind, which are removed below.
        $process = Start-Process -FilePath $uninstaller -ArgumentList "/S /currentuser _?=$dir" -Wait -PassThru
        if ($process.ExitCode -ne 0) { Fail "the uninstaller exited with $($process.ExitCode)" }
        Remove-Item -LiteralPath $uninstaller -Force -ErrorAction SilentlyContinue
        if ((Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) {
            Remove-Item -LiteralPath $dir -Force
        }
        Write-Host "Removed Ordewell from $dir"
        Write-Host 'Your sessions and settings in %APPDATA%\Ordewell and ~\.ordewell were left in place.'
        return
    }

    $from = $env:ORDEWELL_DESKTOP_FROM
    if ($from) {
        if (-not (Test-Path -LiteralPath $from -PathType Container)) { Fail "ORDEWELL_DESKTOP_FROM is not a directory: $from" }
        $sourceText = "the directory $from"
    } else {
        if ($version) {
            $base = "https://github.com/$repo/releases/download/v$version"
            $sourceText = "release v$version"
        } else {
            $base = "https://github.com/$repo/releases/latest/download"
            $sourceText = 'the latest release'
        }
    }

    if ($dryRun) {
        Write-Host "Platform:  windows x64"
        Write-Host "File:      $asset"
        Write-Host "From:      $sourceText"
        if (-not $from) {
            Write-Host "Download:  $base/$asset"
            Write-Host "Checksums: $base/SHA256SUMS"
        }
        if ($env:ORDEWELL_INSTALL_DIR) {
            Write-Host "Install:   $($env:ORDEWELL_INSTALL_DIR), for the current user"
        } else {
            Write-Host 'Install:   the installer''s default folder under %LOCALAPPDATA%\Programs, for the current user'
        }
        return
    }

    function Get-File([string]$Url, [string]$Path) {
        if (-not $Url.StartsWith('https://')) { Fail "refusing to download over anything but https: $Url" }
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch { }
        # Windows PowerShell 5.1 draws its progress bar slowly enough to dominate a large download.
        $previous = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
        } catch {
            Fail "could not download $Url ($($_.Exception.Message))"
        } finally {
            $ProgressPreference = $previous
        }
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ordewell-desktop-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $sums = Join-Path $tmp 'SHA256SUMS'
        $installer = Join-Path $tmp $asset
        if ($from) {
            $fromSums = Join-Path $from 'SHA256SUMS'
            $fromAsset = Join-Path $from $asset
            if (-not (Test-Path -LiteralPath $fromSums)) { Fail "no SHA256SUMS in $from (node scripts/desktop-release-assets.mjs <dir> writes it)" }
            if (-not (Test-Path -LiteralPath $fromAsset)) { Fail "no $asset in $from" }
            Copy-Item -LiteralPath $fromSums -Destination $sums
            # A copy, so what is checked is what is run.
            Copy-Item -LiteralPath $fromAsset -Destination $installer
        } else {
            Write-Host "Downloading $asset from $sourceText"
            Get-File "$base/SHA256SUMS" $sums
            Get-File "$base/$asset" $installer
        }

        $expected = $null
        $lines = @(Get-Content -LiteralPath $sums)
        foreach ($line in $lines) {
            if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -ceq $asset) {
                $expected = $Matches[1].ToLowerInvariant()
                break
            }
        }
        if (-not $expected) { Fail "SHA256SUMS has no checksum for $asset" }
        $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            [Console]::Error.WriteLine("ordewell-desktop: the checksum of $asset does not match SHA256SUMS.")
            [Console]::Error.WriteLine("  expected $expected")
            [Console]::Error.WriteLine("  got      $actual")
            Fail 'nothing was installed. If a release was published while this ran, run it again.'
        }
        Write-Host "Checksum verified (sha256 $actual)"

        $label = 'Ordewell'
        foreach ($line in $lines) {
            if ($line -match '^([0-9A-Fa-f]{64})\s+\*?Ordewell-(.+)-win-x64\.exe\s*$' -and $Matches[1].ToLowerInvariant() -eq $expected) {
                $label = "Ordewell $($Matches[2])"
                break
            }
        }

        if (-not $onWindows) { Fail 'this installer is for Windows; use scripts/install/desktop.sh on macOS and Linux' }
        if (Get-Process -Name 'Ordewell' -ErrorAction SilentlyContinue) {
            Fail 'Ordewell is running; quit it and run this again'
        }

        # electron-builder's assisted NSIS installer: /S is silent, /currentuser
        # chooses the per-user install without asking, and /D= sets the folder.
        # /D= has to come last and takes no quotes, even for a path with spaces.
        $installArguments = '/S /currentuser'
        if ($env:ORDEWELL_INSTALL_DIR) {
            $dir = [IO.Path]::GetFullPath($env:ORDEWELL_INSTALL_DIR).TrimEnd('\')
            $installArguments = "$installArguments /D=$dir"
        }
        $process = Start-Process -FilePath $installer -ArgumentList $installArguments -Wait -PassThru
        if ($process.ExitCode -ne 0) { Fail "the installer exited with $($process.ExitCode)" }

        $entry = Get-OrdewellInstall
        $where = 'the Start menu'
        if ($null -ne $entry) { $where = $entry.InstallLocation }
        Write-Host "Installed $label to $where"
        Write-Host 'Start it from the Start menu, or run Ordewell.exe from that folder.'
        Write-Host ''
        Write-Host 'This script did not unblock any file or change a SmartScreen setting. A file'
        Write-Host 'Invoke-WebRequest saves carries no mark of the web, so Windows does not run'
        Write-Host 'the SmartScreen prompt a browser download gets. See docs/desktop/README.md.'
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Invoke-OrdewellDesktop -Arguments $args
