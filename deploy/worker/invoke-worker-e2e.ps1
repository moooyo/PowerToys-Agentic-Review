[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'worker-config.psd1'),

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PullRequestUrl,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TaskId,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$CancelTaskId,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$WorkerLogPath,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$EvidenceOutputPath = (Join-Path $PSScriptRoot 'worker-e2e-evidence.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Contains {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Pattern
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }

    return [bool](Select-String -LiteralPath $Path -Pattern $Pattern -SimpleMatch -Quiet)
}

$resolvedConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $resolvedConfigPath -PathType Leaf)) {
    throw "Config file not found: $resolvedConfigPath"
}
$config = Import-PowerShellDataFile -LiteralPath $resolvedConfigPath
if ($config -isnot [hashtable]) {
    throw "Config file must return a hashtable: $resolvedConfigPath"
}

$sharedRoot = [string]$config['WORKER_GIT_SHARED_ROOT_DIRECTORY']
$workspaceRoot = [string]$config['WORKER_WORKSPACE_ROOT_DIRECTORY']
$sharedGitPolicyKeys = @(
    'WORKER_GIT_SHARED_CACHE_MAX_BYTES',
    'WORKER_GIT_SHARED_MINIMUM_FREE_DISK_BYTES',
    'WORKER_GIT_SHARED_SCAN_ENTRY_LIMIT',
    'WORKER_GIT_SHARED_SCAN_TIMEOUT_MS',
    'WORKER_GIT_SHARED_GC_MINIMUM_INTERVAL_MINUTES',
    'WORKER_GIT_SHARED_GC_PRUNE_AGE_HOURS'
)

$missingSharedGitPolicyKeys = @()
foreach ($policyKey in $sharedGitPolicyKeys) {
    if ([string]::IsNullOrWhiteSpace([string]$config[$policyKey])) {
        $missingSharedGitPolicyKeys += $policyKey
    }
}

$sharedRootExists = Test-Path -LiteralPath $sharedRoot -PathType Container
$workspaceRootExists = Test-Path -LiteralPath $workspaceRoot -PathType Container
$sharedRepoHeadCount = 0
if ($sharedRootExists) {
    $sharedRepoHeadCount = (Get-ChildItem -LiteralPath $sharedRoot -Recurse -File -Filter HEAD | Measure-Object).Count
}

$workspaceAttemptCount = 0
if ($workspaceRootExists) {
    $workspaceAttemptCount = (Get-ChildItem -LiteralPath $workspaceRoot -Directory -Force | Measure-Object).Count
}

$processHostRunning = [bool](Get-Process -Name 'AgenticReview.ProcessHost' -ErrorAction SilentlyContinue)

$checks = @(
    [ordered]@{
        check = 'registration'
        status = 'manual'
        evidence = 'Verify worker registration from dashboard/API and worker log.'
    },
    [ordered]@{
        check = 'real-public-main-pr'
        status = 'manual'
        evidence = "TaskId=$TaskId PullRequestUrl=$PullRequestUrl"
    },
    [ordered]@{
        check = 'shared-repository-preparation'
        status = if ($sharedRepoHeadCount -gt 0) { 'observed' } else { 'missing' }
        evidence = "HEAD files under shared root: $sharedRepoHeadCount"
    },
    [ordered]@{
        check = 'codex-build-test'
        status = if ([string]::IsNullOrWhiteSpace($WorkerLogPath)) { 'manual' } else { if (Test-Contains -Path $WorkerLogPath -Pattern 'codex') { 'observed' } else { 'missing' } }
        evidence = if ([string]::IsNullOrWhiteSpace($WorkerLogPath)) { 'Provide -WorkerLogPath for log assertions.' } else { "Searched log for keyword: codex ($WorkerLogPath)" }
    },
    [ordered]@{
        check = 'inline-completion'
        status = 'manual'
        evidence = 'Verify exactly one inline completion payload in server records.'
    },
    [ordered]@{
        check = 'lease-cancellation'
        status = if ([string]::IsNullOrWhiteSpace($CancelTaskId)) { 'manual' } else { 'manual' }
        evidence = if ([string]::IsNullOrWhiteSpace($CancelTaskId)) { 'Provide -CancelTaskId after executing cancellation scenario.' } else { "CancelTaskId=$CancelTaskId" }
    },
    [ordered]@{
        check = 'processhost-descendant-cleanup'
        status = if (-not $processHostRunning) { 'observed' } else { 'manual' }
        evidence = if (-not $processHostRunning) { 'No AgenticReview.ProcessHost process observed at capture time.' } else { 'ProcessHost still running; inspect descendants and teardown timing manually.' }
    },
    [ordered]@{
        check = 'workspace-cleanup'
        status = if ($workspaceAttemptCount -eq 0) { 'observed' } else { 'manual' }
        evidence = "Workspace attempt directory count: $workspaceAttemptCount"
    },
    [ordered]@{
        check = 'shared-git-policy-config'
        status = if ($missingSharedGitPolicyKeys.Count -eq 0) { 'observed' } else { 'missing' }
        evidence = if ($missingSharedGitPolicyKeys.Count -eq 0) {
            'Worker-side shared Git cache and conservative GC policy keys are configured.'
        } else {
            "Missing policy keys: $($missingSharedGitPolicyKeys -join ', ')"
        }
    }
)

$report = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    scriptRole = 'Evidence collector only. This script does not execute an automated end-to-end run.'
    taskId = $TaskId
    cancelTaskId = $CancelTaskId
    pullRequestUrl = $PullRequestUrl
    configPath = $resolvedConfigPath
    sharedRoot = $sharedRoot
    workspaceRoot = $workspaceRoot
    checks = $checks
}

$json = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($EvidenceOutputPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote E2E evidence report to $EvidenceOutputPath"
Write-Output $json
