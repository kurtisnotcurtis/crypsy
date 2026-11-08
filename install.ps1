<#
.SYNOPSIS
  Crypsy Cloud Folder Onboarding & Installer (Windows PowerShell)
  Walks the user through placing Crypsy into OneDrive, Google Drive, Dropbox, or iCloud Drive.
#>
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (Get-Command node -ErrorAction SilentlyContinue) {
    node "$ScriptDir\install.js" @args
} else {
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "  Crypsy — Windows Cloud Folder Installer" -ForegroundColor Cyan
    Write-Host "================================================================"
    $candidates = @()
    if ($env:OneDriveConsumer -and (Test-Path $env:OneDriveConsumer)) { $candidates += [PSCustomObject]@{ Name="OneDrive (Personal)"; Path=$env:OneDriveConsumer } }
    elseif ($env:OneDrive -and (Test-Path $env:OneDrive)) { $candidates += [PSCustomObject]@{ Name="OneDrive"; Path=$env:OneDrive } }
    if (Test-Path "G:\My Drive") { $candidates += [PSCustomObject]@{ Name="Google Drive (G:\My Drive)"; Path="G:\My Drive" } }
    if (Test-Path "$HOME\Dropbox") { $candidates += [PSCustomObject]@{ Name="Dropbox"; Path="$HOME\Dropbox" } }

    for ($i = 0; $i -lt $candidates.Count; $i++) {
        Write-Host ("  [{0}] {1} -> {2}" -f ($i + 1), $candidates[$i].Name, $candidates[$i].Path)
    }
    $customIdx = $candidates.Count + 1
    Write-Host "  [$customIdx] Custom folder path"
    $sel = Read-Host "Select a cloud folder [1-$customIdx] (default: 1)"
    if ([string]::IsNullOrWhiteSpace($sel)) { $sel = "1" }
    $idx = [int]$sel - 1
    if ($idx -ge 0 -and $idx -lt $candidates.Count) {
        $basePath = $candidates[$idx].Path
    } else {
        $basePath = Read-Host "Enter target cloud folder path"
    }
    $targetDir = Join-Path $basePath "Crypsy"
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Copy-Item "$ScriptDir\index.html","$ScriptDir\styles.css","$ScriptDir\crypto.js","$ScriptDir\cloud-sync.js","$ScriptDir\app.js" -Destination $targetDir -Force
    Write-Host "`n[OK] Crypsy installed to: $targetDir" -ForegroundColor Green
}
