function Read-BridgeRunnerSettings($Project, $ConfigPath) {
  if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $Project '.local/runner.json' }
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Copy runner.example.json to .local/runner.json and configure it first.' }
  $settings = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if ($settings.sshHost -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,200}$') { throw 'Set sshHost to a valid OpenSSH host alias.' }
  return $settings
}

function Get-BridgePath($Project, $Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A required Runner path is not configured.' }
  if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $Project $Path }
  return [IO.Path]::GetFullPath($Path)
}

function Get-BridgePort($Value, $Default) {
  if ($null -eq $Value) { return $Default }
  if ("$Value" -notmatch '^\d{1,5}$' -or [int]$Value -lt 1024 -or [int]$Value -gt 65535) { throw 'Runner ports must be in 1024–65535.' }
  return [int]$Value
}

function Get-BridgeSshArguments($Project, $Settings) {
  $result = @('-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes')
  if ($Settings.sshConfig) {
    $path = Get-BridgePath $Project $Settings.sshConfig
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'The configured OpenSSH config file does not exist.' }
    $result += @('-F', $path)
  }
  return $result
}

function Join-BridgeProcessArguments($Arguments) {
  # Start-Process joins arrays without quoting. Escape only entries that need it.
  return ($Arguments | ForEach-Object {
    if ($_ -match '["\r\n]') { throw 'Invalid character in a process argument.' }
    if ($_ -match '\s') { '"' + ($_ -replace '(\\+)$', '$1$1') + '"' } else { $_ }
  }) -join ' '
}
