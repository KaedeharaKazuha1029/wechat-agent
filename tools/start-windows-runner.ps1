param([switch]$NoBrowser, [string]$ConfigPath = $env:WECHAT_BRIDGE_RUNNER_CONFIG)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runner-settings.ps1')

try {
  $settings = Read-BridgeRunnerSettings $project $ConfigPath
  $runtime = Get-BridgePath $project $settings.runtimeDirectory
  $tokenPath = Get-BridgePath $project $settings.tokenFile
  $allowedRoot = Get-BridgePath $project $settings.workspaceRoot
  $sshArgs = @(Get-BridgeSshArguments $project $settings)
  $runnerPort = Get-BridgePort $settings.runnerPort 17867
  $remoteRunnerPort = Get-BridgePort $settings.remoteRunnerPort 17867
  $adminPort = Get-BridgePort $settings.adminPort 17875
  if ($runnerPort -eq $adminPort) { throw 'Choose different local Runner and admin ports.' }
  $runnerUri = "http://127.0.0.1:$runnerPort/health"
  $panel = "http://127.0.0.1:$adminPort/"
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  foreach ($path in @($tokenPath, $allowedRoot, (Join-Path $project 'src/runner.mjs'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing bridge setup: $path" }
  }
  $token = [IO.File]::ReadAllText($tokenPath).Trim()
  if ($token -notmatch '^[a-f0-9]{64}$') { throw 'The saved Runner credential is invalid.' }
  $headers = @{ Authorization = "Bearer $token" }
  $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $runnerPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $health = Invoke-RestMethod -Uri $runnerUri -Headers $headers -TimeoutSec 4
    if (-not $health.ok) { throw 'The existing listener is not the expected Runner.' }
  } else {
    $env:WEIXIN_BRIDGE_RUNNER_TOKEN_FILE = $tokenPath
    $env:WEIXIN_BRIDGE_RUNNER_ROOT = $allowedRoot
    $env:WEIXIN_BRIDGE_CODEX_PREFER_MXC = if ($settings.preferMxc) { '1' } else { '0' }
    $env:WEIXIN_BRIDGE_RUNNER_PORT = "$runnerPort"
    $runner = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'src/runner.mjs' -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'runner.out') -RedirectStandardError (Join-Path $runtime 'runner.err')
    $runner.Id | Set-Content -LiteralPath (Join-Path $runtime 'runner.pid')
    $health = $null
    for ($i = 0; $i -lt 15 -and -not $health; $i++) {
      try { $health = Invoke-RestMethod -Uri $runnerUri -Headers $headers -TimeoutSec 2 }
      catch { if ($runner.HasExited) { throw "Runner stopped during startup. See $(Join-Path $runtime 'runner.err')." }; Start-Sleep -Milliseconds 200 }
    }
    if (-not $health.ok) { throw 'Windows Runner did not become ready.' }
  }
  Write-Host ('Windows Runner ready: ' + ($health.kinds -join ', '))

  $forward = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $adminPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $forward) {
    $spec = @('-N') + $sshArgs + @('-L', "127.0.0.1:${adminPort}:127.0.0.1:${adminPort}", '-R', "127.0.0.1:${remoteRunnerPort}:127.0.0.1:${runnerPort}", $settings.sshHost)
    $ssh = Start-Process -FilePath (Get-Command ssh.exe).Source -ArgumentList (Join-BridgeProcessArguments $spec) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'ssh.out') -RedirectStandardError (Join-Path $runtime 'ssh.err')
    $ssh.Id | Set-Content -LiteralPath (Join-Path $runtime 'ssh.pid')
  } else {
    $pidFile = Join-Path $runtime 'ssh.pid'
    if (-not (Test-Path -LiteralPath $pidFile) -or [int](Get-Content -LiteralPath $pidFile) -ne $forward.OwningProcess -or (Get-Process -Id $forward.OwningProcess).ProcessName -ne 'ssh') {
      throw "Port $adminPort is already used by another application."
    }
  }
  $reachable = $false
  for ($i = 0; $i -lt 15 -and -not $reachable; $i++) {
    try {
      $page = Invoke-WebRequest -Uri $panel -UseBasicParsing -TimeoutSec 2
      $reachable = [bool]($page.Content -match 'name="bridge-token"')
    } catch { if ($ssh -and $ssh.HasExited) { throw "SSH forwarding stopped. See $(Join-Path $runtime 'ssh.err')." }; Start-Sleep -Milliseconds 250 }
  }
  if (-not $reachable) { throw 'Could not reach the ECS admin panel through SSH.' }
  Write-Host 'ECS tunnel ready.'
  if (-not $NoBrowser) { Start-Process $panel }
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
