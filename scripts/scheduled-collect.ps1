<#
  Durable scheduled collection for Windows (Task Scheduler equivalent of cron).
  The repo's collectors also support in-process node-cron via `run start`, but that needs a
  long-lived daemon (the Docker path). On this machine we instead trigger a clean `run once`
  per interval, which can't overlap and exits cleanly each time.

  Usage:  scheduled-collect.ps1 -Collector kalshi   (or weather)
  Registered by Task Scheduler; logs to logs\<collector>.log (rotated by size).

  NOTE: do NOT set $ErrorActionPreference = 'Stop' here. The collectors print a Node SSL
  warning to stderr at startup; under 'Stop' with merged-stream redirection PowerShell 5.1
  treats that stderr line as a terminating error and kills the run before it does any work.
  We keep the default 'Continue' and merge 2>&1 into a UTF-8 log instead.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("kalshi", "weather")]
  [string]$Collector
)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir "$Collector.log"

# Simple size-based rotation so logs don't grow unbounded.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
  Move-Item $log "$log.1" -Force
}

"=== $(Get-Date -Format o) start $Collector ===" | Out-File -Append -Encoding utf8 $log
# 2>&1 merges stderr (incl. the harmless SSL warning) into the pipeline; default
# ErrorActionPreference ('Continue') means those lines are logged, not thrown.
& npx --yes pnpm@9 --filter "@weather/collector-$Collector" run once 2>&1 |
  Out-File -Append -Encoding utf8 $log
$code = $LASTEXITCODE
"=== $(Get-Date -Format o) exit $code $Collector ===" | Out-File -Append -Encoding utf8 $log
exit $code
