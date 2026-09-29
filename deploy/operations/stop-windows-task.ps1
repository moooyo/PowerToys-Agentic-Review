[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter()][ValidateRange(0, 3600)][int]$WaitTimeoutSeconds = 0
)

. (Join-Path $PSScriptRoot 'windows-common.ps1')

function Read-OperationsControlJson([string]$Path) {
    # Status replacement and consumed-request removal must remain possible during reads.
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true))
        try { return ($reader.ReadToEnd() | ConvertFrom-Json) }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

$loaded = Get-OperationsConfiguration $ConfigPath
$config = $loaded.Value
$statusPath = Join-Path $config.stateDirectory 'status.json'
Assert-OperationsPath $statusPath
try { $status = Read-OperationsControlJson $statusPath } catch { throw 'The private supervisor status could not be read.' }
if ($status.schemaVersion -ne 1 -or $status.instanceId -cnotmatch '^[0-9a-f-]{36}$' -or $status.taskName -cne $config.taskName -or $status.role -cne $config.role) {
    throw 'The supervisor status does not match this task configuration.'
}
if ($status.state -eq 'stopped') { Write-Output 'The supervisor has already stopped.'; return }
if ($status.state -in @('failed', 'recovery-required')) { throw 'The supervisor retained a failure. Inspect the private status before recovery.' }
if ($WaitTimeoutSeconds -eq 0) { $WaitTimeoutSeconds = [int]$config.shutdownTimeoutSeconds + 15 }
$requestPath = Join-Path $config.stateDirectory ('stop-' + $status.instanceId + '.json')
$request = @{ schemaVersion = 1; instanceId = $status.instanceId; action = 'stop' } | ConvertTo-Json -Compress
$published = $false
if (-not (Test-Path -LiteralPath $requestPath)) {
    $temporary = $requestPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $stream = [System.IO.File]::Open($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($request)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    try { [System.IO.File]::Move($temporary, $requestPath); $published = $true } catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) { throw 'The cooperative stop request could not be saved.' }
    }
}
if (-not $published) {
    $saved = $null
    try {
        Assert-OperationsPath $requestPath
        $saved = Read-OperationsControlJson $requestPath
    } catch {
        # A completed supervisor removes its consumed request. The status below is authoritative.
        if (Test-Path -LiteralPath $requestPath) { throw 'The existing stop request could not be read safely.' }
    }
    if ($null -ne $saved -and ($saved.schemaVersion -ne 1 -or $saved.instanceId -cne $status.instanceId -or $saved.action -cne 'stop')) {
        throw 'An existing stop request does not match this supervisor generation.'
    }
}
$deadline = [DateTime]::UtcNow.AddSeconds($WaitTimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try { $latest = Read-OperationsControlJson $statusPath } catch { continue }
    if ($latest.instanceId -cne $status.instanceId) { throw 'The supervisor generation changed while waiting for shutdown.' }
    if ($latest.state -eq 'stopped') { Write-Output 'Cooperative shutdown completed.'; return }
    if ($latest.state -in @('failed', 'shutdown-timeout', 'recovery-required')) {
        throw 'Cooperative shutdown did not complete successfully. The failure and any running child are retained; no forced termination or restart was performed.'
    }
}
throw 'The stop request was saved but shutdown is not confirmed. Inspect the same generation before retrying or deploying.'
