# Installs the opencode server as an NSSM Windows service. Idempotent:
# re-running updates the service config and restarts it.
#
# Usage (from the repo root, or anywhere — the repo is located via this
# script's own path):
#   powershell -ExecutionPolicy Bypass -File deploy\windows-setup.ps1
#
# The script auto-elevates. It installs the NSSM service (auto-start at boot,
# auto-restart on crash and after self-deploys).
#
# Service account:
#   -Account user   (recommended) runs as .\<you> with your password stored in
#                   the service (LSA-protected). Git-pull deploys from origin
#                   work out of the box.
#   -Account system                 passwordless LocalSystem. The server cannot
#                   use your SSH key (verified: publickey denied even with
#                   USERPROFILE overridden), so self-deploys need
#                   OPENCODE_DEPLOY_PULL_COMMAND pointing at a git bundle
#                   (the script sets a default path).
param(
  [string]$NssmPath = "D:\Apps\nssm.exe",
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [ValidateSet("user", "system")] [string]$Account,
  [string]$ServiceName = "opencode",
  [string]$Branch = "laurent-dev",
  [string]$ListenHosts = "127.0.0.1",
  [int]$Port = 4096,
  [string]$LogDir = "$env:USERPROFILE\.local\share\opencode\log"
)

$ErrorActionPreference = "Stop"

# --- auto-elevate -----------------------------------------------------------
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
  $args = ""
  foreach ($bound in $MyInvocation.BoundParameters.Keys) {
    $args += " -$bound `"$($MyInvocation.BoundParameters[$bound])`""
  }
  Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"$args" -Verb RunAs
  exit
}

function Show($msg) { Write-Host $msg -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

Show "=== opencode NSSM service setup ==="
Show "repo: $RepoDir"

# --- preflight --------------------------------------------------------------
if (-not (Test-Path $NssmPath)) {
  $found = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($found) { $NssmPath = $found.Source } else { Fail "nssm.exe not found at $NssmPath or on PATH (-NssmPath to override)" }
}
$bunCandidates = @("$env:USERPROFILE\.bun\bin\bun.exe", "$env:USERPROFILE\.bun\bin\bun") + @((Get-Command bun.exe -ErrorAction SilentlyContinue).Source)
$bun = $bunCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $bun) { Fail "bun.exe not found (install bun or add it to PATH)" }
$git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "C:\Program Files\Git\cmd\git.exe" }
if (-not (Test-Path "$RepoDir\packages\opencode\package.json")) { Fail "not an opencode repo: $RepoDir" }
Show "nssm: $NssmPath"
Show "bun:  $bun"

# --- account ----------------------------------------------------------------
if (-not $Account) {
  Show ""
  Show "Service account:"
  Show "  1 = your user account (recommended; git-pull deploys work out of the box)"
  Show "  2 = LocalSystem (passwordless; self-deploys need a git bundle)"
  $choice = Read-Host "choose 1 or 2"
  if ($choice -eq "2") { $Account = "system" } else { $Account = "user" }
}
$currentUser = "$env:COMPUTERNAME\$env:USERNAME"
$extra = @(
  "OPENCODE_BROWSER_AGENT_SESSION=opencode-default",
  "OPENCODE_BROWSER_AGENT_SKIP_INSTALL=1",
  "OPENCODE_DISABLE_CHANNEL_DB=1",
  # The deploy endpoint exits the process and NSSM restarts it (AppExit Default
  # Restart below). A scheduled-task indirection is unnecessary: supervising
  # restarts is exactly what NSSM is for.
  "OPENCODE_RESTART_COMMAND=self-exit"
)
$passwordPlain = $null
if ($Account -eq "system") {
  Show "account: LocalSystem"
  $bundlePath = "$env:USERPROFILE\opencode-deploy.bundle"
  $extra += "USERPROFILE=$env:USERPROFILE"
  $extra += "HOME=$env:USERPROFILE"
  $extra += "OPENCODE_DEPLOY_PULL_COMMAND=$git pull $bundlePath $Branch --ff-only"
  Show "note: LocalSystem cannot use your SSH key; self-deploys pull from $bundlePath"
  Show "      (ship a bundle there first: git bundle create <path> <prev-tip>..$Branch, then scp it)"
} else {
  Show "account: $currentUser"
  $secure = Read-Host "Windows password for $env:USERNAME" -AsSecureString
  $passwordPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if (-not $passwordPlain) { Fail "empty password" }
}

# --- install / update the service -------------------------------------------
$exists = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($exists) {
  Show "service $ServiceName exists - stopping and updating config"
  & $NssmPath stop $ServiceName | Out-Null
  & $NssmPath remove $ServiceName confirm | Out-Null
}
Show "installing service $ServiceName"
& $NssmPath install $ServiceName $bun "run --conditions=browser packages/opencode/src/index.ts serve --hostname $ListenHosts --port $Port"
if ($LASTEXITCODE -ne 0) { Fail "nssm install failed" }
& $NssmPath set $ServiceName AppDirectory $RepoDir | Out-Null
& $NssmPath set $ServiceName AppEnvironmentExtra $extra | Out-Null
& $NssmPath set $ServiceName AppStdout "$LogDir\nssm-service.log" | Out-Null
& $NssmPath set $ServiceName AppStderr "$LogDir\nssm-service.log" | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmPath set $ServiceName AppRotateOnline 1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 10485760 | Out-Null
& $NssmPath set $ServiceName AppExit Default Restart | Out-Null
& $NssmPath set $ServiceName AppRestartDelay 5000 | Out-Null
& $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
if ($Account -eq "user") {
  & $NssmPath set $ServiceName ObjectName ".\$env:USERNAME" $passwordPlain | Out-Null
}

# --- start + health check ----------------------------------------------------
Show "starting service..."
Start-Service -Name $ServiceName
$health = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 3
  try {
    $health = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/global/health" -TimeoutSec 3).StatusCode
    break
  } catch { Write-Host "[WAIT] server not up yet ($($i*3+3)s)" }
}
if ($health -ne 200) { Fail "server did not come up - check $LogDir\nssm-service.log" }

Show ""
Show "=== SETUP COMPLETE ==="
Show "service:      $ServiceName (auto-start at boot, restarts on crash and after self-deploys)"
Show "logs:         $LogDir\nssm-service.log (10 MB rotating)"
Show "deploy:       POST http://127.0.0.1:$Port/global/deploy"
Show "              the server exits itself and NSSM restarts it (AppExit Default Restart)"
if ($Account -eq "system") {
  Show "deploy pulls: $bundlePath (ship a bundle there before each deploy)"
}
Show "rollback:     sc stop $ServiceName && sc delete $ServiceName"
