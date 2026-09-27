[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ConfigPath)

. (Join-Path $PSScriptRoot 'windows-common.ps1')
$loaded = Get-OperationsConfiguration $ConfigPath
$config = $loaded.Value
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($currentIdentity.User.Value -ne $loaded.IdentitySid) { throw 'The supervisor must run as its configured Windows identity.' }
if ($config.role -eq 'worker') {
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($sessionId -eq 0 -or -not [Environment]::UserInteractive) {
        throw 'The Worker requires a logged-in interactive Windows session. Session 0 cannot run desktop acceptance.'
    }
}
$hash = [System.Security.Cryptography.SHA256]::Create()
try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($config.stateDirectory.ToLowerInvariant())
    $mutexSuffix = ([System.BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '')
} finally { $hash.Dispose() }
$mutex = [System.Threading.Mutex]::new($false, ('Global\AgenticReviewOperations-' + $mutexSuffix))
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'A supervisor already owns this operations state directory.' }
    # Remove inherited Node loader hooks from the supervisor as well as its child.
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime
    $env:AGENTIC_REVIEW_OPERATIONS_BOOT_ID = $operatingSystem.LastBootUpTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    $supervisor = Join-Path $config.releaseDirectory 'deploy\operations\windows-supervisor.mjs'
    & $config.nodeExecutable $supervisor $loaded.ConfigPath
    $result = $LASTEXITCODE
    if ($result -ne 0) { throw 'Production supervision failed. Inspect the private operations status before restarting.' }
} finally {
    Remove-Item Env:AGENTIC_REVIEW_OPERATIONS_BOOT_ID -ErrorAction SilentlyContinue
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
