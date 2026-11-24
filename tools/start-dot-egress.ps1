param([string]$ConfigPath = $env:WECHAT_BRIDGE_RUNNER_CONFIG)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runner-settings.ps1')

try {
  $settings = Read-BridgeRunnerSettings $project $ConfigPath
  $runtime = Get-BridgePath $project $settings.runtimeDirectory
  $sshArgs = @(Get-BridgeSshArguments $project $settings)
  $remote = $settings.sshHost
  $dotPort = Get-BridgePort $settings.dotEgressPort 17868
  $upstream = [string]$settings.dotEgressUpstream
  if ($upstream -notmatch '^http://127\.0\.0\.1:(\d{1,5})/?$') { throw 'Configure dotEgressUpstream as a loopback HTTP proxy URL.' }
  $proxyPort = Get-BridgePort $Matches[1] 8080
  $remoteSocket = [string]$settings.dotEgressSocket
  if ($remoteSocket -notmatch '^/run/weixin-dot-egress/[A-Za-z0-9_-]+\.sock$') { throw 'Use a dedicated socket under /run/weixin-dot-egress.' }
  $healthUrl = "http://127.0.0.1:$dotPort/health"
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  if (-not (Test-NetConnection -ComputerName '127.0.0.1' -Port $proxyPort -InformationLevel Quiet -WarningAction SilentlyContinue)) {
    throw "Start your local HTTP proxy on $upstream first."
  }
  $health = try { Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 } catch { $null }
  if ($health.relay -ne 'weixin-dot-only') {
    $env:WEIXIN_BRIDGE_DOT_EGRESS_PORT = "$dotPort"
    $env:WEIXIN_BRIDGE_DOT_EGRESS_UPSTREAM = $upstream
    $local = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'src/dot-egress-local.mjs' -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'dot-egress.out') -RedirectStandardError (Join-Path $runtime 'dot-egress.err')
    $local.Id | Set-Content -LiteralPath (Join-Path $runtime 'dot-egress.pid')
    for ($i=0; $i -lt 12; $i++) {
      try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2; if ($health.relay -eq 'weixin-dot-only') { break } }
      catch { if ($local.HasExited) { throw 'Dot relay exited early. Check dot-egress.err.' } }
      Start-Sleep -Milliseconds 200
    }
  }
  if ($health.relay -ne 'weixin-dot-only') { throw 'Could not verify the local Dot-only relay.' }
  $sshBin = (Get-Command ssh.exe).Source
  $prefix = "sock='$remoteSocket'; "
  $preflight = & $sshBin @sshArgs $remote ($prefix + 'set -eu; test -d /run/weixin-dot-egress; if ss -xlH | grep -Fq "$sock "; then echo online; elif test -S "$sock"; then rm -- "$sock"; echo start; elif test -e "$sock" || test -L "$sock"; then exit 4; else echo start; fi')
  if ($LASTEXITCODE -or $preflight -notin @('start','online')) { throw 'Could not prepare the dedicated ECS Dot socket.' }
  if ($preflight -eq 'start') {
    $spec = @('-N') + $sshArgs + @('-R', "${remoteSocket}:127.0.0.1:${dotPort}", $remote)
    $forward = Start-Process -FilePath $sshBin -ArgumentList (Join-BridgeProcessArguments $spec) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'dot-egress-ssh.out') -RedirectStandardError (Join-Path $runtime 'dot-egress-ssh.err')
    $forward.Id | Set-Content -LiteralPath (Join-Path $runtime 'dot-egress-ssh.pid')
  }
  $ready = & $sshBin @sshArgs $remote ($prefix + 'set -eu; for n in 1 2 3 4 5 6 7 8; do if test -S "$sock" && curl -fsS --max-time 2 --unix-socket "$sock" http://localhost/health 2>/dev/null | grep -q weixin-dot-only; then chgrp weixin-dot-egress "$sock"; chmod 0660 "$sock"; echo ok; exit 0; fi; sleep 1; done; exit 3')
  if ($LASTEXITCODE -or $ready -ne 'ok') { throw 'ECS Dot socket was not usable. Check dot-egress-ssh.err.' }
  Write-Host 'Dot callback relay ready. Only the OpenAI Connectors callback host is allowed.'
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
