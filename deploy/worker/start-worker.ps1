[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'worker-config.psd1'),

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$WorkerEntryPath = (Join-Path $PSScriptRoot '..\..\apps\worker\dist\worker.mjs'),

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$NodeExecutable = 'node'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$authProfilePath = 'C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json'

function Test-RunningWorkerProcess {
    param([Parameter(Mandatory = $true)][string]$EntryPath)

    $normalizedEntry = [System.IO.Path]::GetFullPath($EntryPath).ToLowerInvariant()
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
    foreach ($process in $processes) {
        $commandLine = $process.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) {
            continue
        }

        if ($commandLine.ToLowerInvariant().Contains($normalizedEntry)) {
            return $true
        }
    }

    return $false
}

function Set-WorkerEnvironment {
    param([Parameter(Mandatory = $true)][hashtable]$Config)

    foreach ($entry in $Config.GetEnumerator()) {
        $name = [string]$entry.Key
        $value = $entry.Value
        if ($name -notmatch '^WORKER_[A-Z0-9_]+$') {
            throw "Unsupported worker configuration key: $name"
        }

        if ($null -eq $value) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            continue
        }

        Set-Item -LiteralPath "Env:$name" -Value ([string]$value)
    }
}

function Assert-Config {
    param([Parameter(Mandatory = $true)][hashtable]$Config)

    $requiredAlways = @(
        'WORKER_SERVER_URL'
    )
    $requiredWhenExecutionEnabled = @(
        'WORKER_TRUSTED_EXECUTABLE_ROOT',
        'WORKER_PROCESS_HOST_PATH',
        'WORKER_CODEX_EXECUTABLE_PATH',
        'WORKER_GIT_EXECUTABLE_PATH',
        'WORKER_WORKSPACE_ROOT_DIRECTORY',
        'WORKER_EXECUTION_TEMP_DIRECTORY',
        'WORKER_EXECUTION_PROFILE_DIRECTORY',
        'WORKER_CODEX_VERSION',
        'WORKER_PROCESS_HOST_SHA256',
        'WORKER_CODEX_SHA256',
        'WORKER_GIT_SHA256'
    )

    foreach ($requiredName in $requiredAlways) {
        if ([string]::IsNullOrWhiteSpace([string]$Config[$requiredName])) {
            throw "$requiredName is required in $ConfigPath."
        }
    }

    $executionEnabled = [string]$Config['WORKER_EXECUTION_ENABLED']
    $isExecutionEnabled = $executionEnabled -in @('true', '1', 'TRUE', 'True')

    if ($isExecutionEnabled) {
        foreach ($requiredName in $requiredWhenExecutionEnabled) {
            if ([string]::IsNullOrWhiteSpace([string]$Config[$requiredName])) {
                throw "$requiredName is required when WORKER_EXECUTION_ENABLED=true."
            }
        }
    }
}

$resolvedConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $resolvedConfigPath -PathType Leaf)) {
    throw "Config file not found: $resolvedConfigPath"
}

$config = Import-PowerShellDataFile -LiteralPath $resolvedConfigPath
if ($config -isnot [hashtable]) {
    throw "Config file must return a hashtable: $resolvedConfigPath"
}

Assert-Config -Config $config

$resolvedWorkerEntryPath = [System.IO.Path]::GetFullPath($WorkerEntryPath)
if (-not (Test-Path -LiteralPath $resolvedWorkerEntryPath -PathType Leaf)) {
    throw "Worker entry file not found: $resolvedWorkerEntryPath"
}

if (-not (Test-Path -LiteralPath $authProfilePath -PathType Leaf)) {
    throw "Worker auth profile not found: $authProfilePath"
}

if (Test-RunningWorkerProcess -EntryPath $resolvedWorkerEntryPath) {
    throw 'A worker.mjs process is already running for this entry path.'
}

Set-WorkerEnvironment -Config $config

Write-Host "Starting Worker from $resolvedWorkerEntryPath"
Write-Host "Loaded configuration from $resolvedConfigPath"
Write-Host "Authentication profile found at fixed path."
Write-Host 'Single-instance preflight passed (this is not a hard host-wide lock).'

& $NodeExecutable '--enable-source-maps' $resolvedWorkerEntryPath
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Worker exited with code $exitCode."
}
