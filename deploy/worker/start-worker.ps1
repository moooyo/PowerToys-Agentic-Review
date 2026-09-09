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

function Resolve-WorkerNodeApplication {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $commands = @(Get-Command -Name $Executable -ErrorAction Stop)
    if ($commands.Count -ne 1 -or $commands[0].CommandType -ne [System.Management.Automation.CommandTypes]::Application) {
        throw 'NodeExecutable must resolve to a single application.'
    }

    return [System.IO.Path]::GetFullPath($commands[0].Path)
}

function Get-WorkerProcessPath {
    param(
        [Parameter(Mandatory = $true)][string]$NodeDirectory,
        [AllowNull()][AllowEmptyString()][string]$InheritedPath
    )

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $entries = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in (@($NodeDirectory) + @($InheritedPath -split ';'))) {
        $trimmedEntry = $entry.Trim()
        if ($trimmedEntry.Length -gt 0 -and $seen.Add($trimmedEntry)) {
            $entries.Add($trimmedEntry)
        }
    }

    # Preserve non-empty entries for the runtime path validator; do not resolve relative paths.
    return $entries -join ';'
}

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
    param(
        [Parameter(Mandatory = $true)][hashtable]$Config,
        [string]$SourcePath = 'worker configuration'
    )

    $requiredAlways = @(
        'WORKER_SERVER_URL'
    )
    $requiredWhenExecutionEnabled = @(
        'WORKER_TRUSTED_EXECUTABLE_ROOT',
        'WORKER_PROCESS_HOST_PATH',
        'WORKER_GIT_EXECUTABLE_PATH',
        'WORKER_WORKSPACE_ROOT_DIRECTORY',
        'WORKER_EXECUTION_TEMP_DIRECTORY',
        'WORKER_PROCESS_HOST_SHA256',
        'WORKER_GIT_SHA256'
    )

    foreach ($requiredName in $requiredAlways) {
        if ([string]::IsNullOrWhiteSpace([string]$Config[$requiredName])) {
            throw "$requiredName is required in $SourcePath."
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

        # Model execution defaults to enabled. Model-free validation does not require CLI settings.
        $modelExecutionEnabled = [string]$Config['WORKER_MODEL_EXECUTION_ENABLED']
        $isModelExecutionEnabled = $modelExecutionEnabled -notin @('false', '0')
        if ($isModelExecutionEnabled) {
            foreach ($requiredName in @('WORKER_CLI_ENGINE', 'WORKER_CLI_EXECUTABLE_PATH')) {
                if ([string]::IsNullOrWhiteSpace([string]$Config[$requiredName])) {
                    throw "$requiredName is required when model execution is enabled."
                }
            }

            if ([string]$Config['WORKER_CLI_ENGINE'] -cnotin @('codex', 'copilot')) {
                throw 'WORKER_CLI_ENGINE must be codex or copilot.'
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

Assert-Config -Config $config -SourcePath $resolvedConfigPath

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
$resolvedNodeExecutable = Resolve-WorkerNodeApplication -Executable $NodeExecutable
$nodeDirectory = [System.IO.Path]::GetDirectoryName($resolvedNodeExecutable)
$env:PATH = Get-WorkerProcessPath -NodeDirectory $nodeDirectory -InheritedPath $env:PATH

Write-Host "Starting Worker from $resolvedWorkerEntryPath"
Write-Host "Loaded configuration from $resolvedConfigPath"
Write-Host "Authentication profile found at fixed path."
Write-Host 'Single-instance preflight passed (this is not a hard host-wide lock).'

& $resolvedNodeExecutable '--enable-source-maps' $resolvedWorkerEntryPath
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Worker exited with code $exitCode."
}
