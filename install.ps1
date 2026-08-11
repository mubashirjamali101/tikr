# Install tikr for Windows in one step.
#
#   irm https://raw.githubusercontent.com/mubashirjamali101/tikr/main/install.ps1 | iex
#   .\install.ps1
#
# Press Enter at the prompt to install, or Ctrl-C to cancel.
$ErrorActionPreference = "Stop"

$Repo = if ($env:TIKR_REPO) { $env:TIKR_REPO } else { "mubashirjamali101/tikr" }
$bin = "tikr-windows-x64.exe"
$destDir = Join-Path $env:LOCALAPPDATA "Programs\tikr"
$dest = Join-Path $destDir "tikr.exe"

if (-not $env:YES) {
    Write-Host "Install tikr → $dest"
    Read-Host "Press Enter to continue (Ctrl-C to cancel)"
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

$repoDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$local = Join-Path $repoDir "dist\$bin"

if (Test-Path $local) {
    Copy-Item $local $dest -Force
} else {
    $base = $env:TIKR_DOWNLOAD_BASE
    if (-not $base) {
        if ($env:TIKR_VERSION) {
            $base = "https://github.com/$Repo/releases/download/$($env:TIKR_VERSION)"
        } else {
            $base = "https://github.com/$Repo/releases/latest/download"
        }
    }
    $url = "$($base.TrimEnd('/'))/$bin"
    Write-Host "Downloading $url …"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

Write-Host "Installed: $dest"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$destDir*") {
    $newPath = if ($userPath) { "$userPath;$destDir" } else { $destDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = "$env:Path;$destDir"
    Write-Host "Added $destDir to your user PATH (open a new terminal to pick it up)."
}

& $dest --version
Write-Host "Done. Try:  tikr --help"
