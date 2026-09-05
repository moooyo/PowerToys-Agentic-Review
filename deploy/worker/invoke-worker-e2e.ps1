#Requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'worker-config.psd1'),
    [Parameter(Mandatory = $true)]
    [ValidatePattern('\Ahttps://github\.com/[^/\s?#]+/[^/\s?#]+/pull/[1-9][0-9]*/?\z')]
    [string]$PullRequestUrl,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z')]
    [string]$TaskId,
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z')]
    [string]$CancelTaskId,
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z')]
    [string]$AttemptId,
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z')]
    [string]$CancelAttemptId,
    [ValidateRange(1, 9007199254740991)]
    [long]$RepositoryId,
    [ValidateSet('baseline', 'active', 'completed', 'cancelled')]
    [string]$CaptureStage = 'baseline',
    [ValidateNotNullOrEmpty()]
    [string]$WorkerLogPath,
    [ValidateNotNullOrEmpty()]
    [string]$EvidenceOutputPath = (Join-Path $PSScriptRoot 'worker-e2e-evidence.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-PathObservation {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $entry = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            return [ordered]@{ path = $Path; status = 'unsupported-reparse-point' }
        }
        return [ordered]@{
            path = $Path
            status = 'present'
            kind = if ($entry.PSIsContainer) { 'directory' } else { 'file' }
            lastWriteTimeUtc = $entry.LastWriteTimeUtc.ToString('o')
        }
    } catch [System.Management.Automation.ItemNotFoundException] {
        return [ordered]@{ path = $Path; status = 'missing' }
    } catch {
        return [ordered]@{ path = $Path; status = 'unavailable' }
    }
}

function Get-AttemptObservation {
    param([string]$RunAttemptId, [string]$Root)
    if ([string]::IsNullOrWhiteSpace($RunAttemptId)) {
        return [ordered]@{ status = 'not-requested'; reason = 'No runAttemptId supplied.' }
    }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($RunAttemptId))
        $name = 'attempt-' + [System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
    $attemptPath = Join-Path $Root $name
    $directory = Get-PathObservation -Path $attemptPath
    $checkout = [ordered]@{ status = 'not-inspected' }
    $gitFile = [ordered]@{ status = 'not-inspected' }
    if ($directory.status -eq 'present' -and $directory.kind -eq 'directory') {
        $checkoutPath = Join-Path $attemptPath 'checkout'
        $checkout = Get-PathObservation -Path $checkoutPath
        if ($checkout.status -eq 'present' -and $checkout.kind -eq 'directory') {
            $gitFile = Get-PathObservation -Path (Join-Path $checkoutPath '.git')
        }
    }
    return [ordered]@{ runAttemptId = $RunAttemptId; directory = $directory; checkout = $checkout; gitFile = $gitFile }
}

function Get-ProcessObservation {
    param([string]$ExecutablePath)
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        return [ordered]@{ status = 'unavailable'; reason = 'Windows process inspection is required.' }
    }
    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        return [ordered]@{ status = 'unavailable'; reason = 'WORKER_PROCESS_HOST_PATH is missing.' }
    }
    try {
        $expectedPath = [System.IO.Path]::GetFullPath($ExecutablePath)
        # Command lines and environment variables may contain credentials and are never captured.
        $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, ExecutablePath)
        $roots = @($all | Where-Object { $_.ExecutablePath -ieq $expectedPath })
        $byId = @{}
        foreach ($process in $all) { $byId[[uint32]$process.ProcessId] = $process }
        $selected = [System.Collections.Generic.HashSet[uint32]]::new()
        $unconfirmed = [System.Collections.Generic.HashSet[uint32]]::new()
        foreach ($root in $roots) { [void]$selected.Add([uint32]$root.ProcessId) }
        do {
            $changed = $false
            foreach ($process in $all) {
                if ($selected.Contains([uint32]$process.ParentProcessId) -and -not $selected.Contains([uint32]$process.ProcessId)) {
                    $parent = $byId[[uint32]$process.ParentProcessId]
                    # A recycled parent PID cannot own a child that predates its current lifetime.
                    if ($null -eq $parent.CreationDate -or $null -eq $process.CreationDate -or $process.CreationDate -lt $parent.CreationDate) {
                        [void]$unconfirmed.Add([uint32]$process.ProcessId)
                        continue
                    }
                    $changed = $selected.Add([uint32]$process.ProcessId) -or $changed
                }
            }
        } while ($changed)
        $processes = @($all | Where-Object { $selected.Contains([uint32]$_.ProcessId) } | ForEach-Object {
            [ordered]@{
                processId = $_.ProcessId
                parentProcessId = $_.ParentProcessId
                name = $_.Name
                creationDate = if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('o') }
            }
        })
        return [ordered]@{
            status = 'captured'
            matchingHostCount = $roots.Count
            unconfirmedParentLinkCount = $unconfirmed.Count
            processesWithUnreadableExecutablePath = @($all | Where-Object { [string]::IsNullOrWhiteSpace($_.ExecutablePath) }).Count
            processes = $processes
            limitation = 'Point-in-time trees for all hosts at the configured path. Correlate the intended host and previously captured descendant identities separately; an empty tree does not prove cleanup.'
        }
    } catch {
        return [ordered]@{ status = 'unavailable'; reason = 'Windows process inspection failed.' }
    }
}

$resolvedConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
$config = Import-PowerShellDataFile -LiteralPath $resolvedConfigPath
if ($config -isnot [hashtable]) { throw "Config file must return a hashtable: $resolvedConfigPath" }
foreach ($rootKey in @('WORKER_GIT_SHARED_ROOT_DIRECTORY', 'WORKER_WORKSPACE_ROOT_DIRECTORY')) {
    if ([string]::IsNullOrWhiteSpace([string]$config[$rootKey]) -or -not [System.IO.Path]::IsPathFullyQualified([string]$config[$rootKey])) {
        throw "$rootKey must be an absolute path in the configuration."
    }
}
if (-not [string]::IsNullOrWhiteSpace($CancelAttemptId) -and [string]::IsNullOrWhiteSpace($CancelTaskId)) {
    throw 'CancelTaskId is required when CancelAttemptId is supplied.'
}
$sharedRoot = [System.IO.Path]::GetFullPath([string]$config['WORKER_GIT_SHARED_ROOT_DIRECTORY'])
$workspaceRoot = [System.IO.Path]::GetFullPath([string]$config['WORKER_WORKSPACE_ROOT_DIRECTORY'])
$sharedRootObservation = Get-PathObservation -Path $sharedRoot
$workspaceRootObservation = Get-PathObservation -Path $workspaceRoot
$repository = [ordered]@{ status = 'not-requested'; reason = 'No GitHub RepositoryId supplied.' }
if ($PSBoundParameters.ContainsKey('RepositoryId')) {
    $repositoryPath = Join-Path $sharedRoot "repository-$RepositoryId.git"
    $repository = [ordered]@{
        repositoryId = $RepositoryId
        directory = [ordered]@{ status = 'not-inspected' }
        head = [ordered]@{ status = 'not-inspected' }
    }
    if ($sharedRootObservation.status -eq 'present' -and $sharedRootObservation.kind -eq 'directory') {
        $repository.directory = Get-PathObservation -Path $repositoryPath
        if ($repository.directory.status -eq 'present' -and $repository.directory.kind -eq 'directory') {
            $repository.head = Get-PathObservation -Path (Join-Path $repositoryPath 'HEAD')
        }
    }
}
$attempt = [ordered]@{ status = 'not-inspected'; reason = 'Workspace root is missing, unavailable, or unsupported.' }
$cancelAttempt = $attempt
if ($workspaceRootObservation.status -eq 'present' -and $workspaceRootObservation.kind -eq 'directory') {
    $attempt = Get-AttemptObservation -RunAttemptId $AttemptId -Root $workspaceRoot
    $cancelAttempt = Get-AttemptObservation -RunAttemptId $CancelAttemptId -Root $workspaceRoot
}
$policyPresence = [ordered]@{}
foreach ($policyKey in @(
    'WORKER_GIT_SHARED_CACHE_MAX_BYTES',
    'WORKER_GIT_SHARED_MINIMUM_FREE_DISK_BYTES',
    'WORKER_GIT_SHARED_SCAN_ENTRY_LIMIT',
    'WORKER_GIT_SHARED_SCAN_TIMEOUT_MS',
    'WORKER_GIT_SHARED_GC_MINIMUM_INTERVAL_MINUTES',
    'WORKER_GIT_SHARED_GC_PRUNE_AGE_HOURS'
)) {
    $policyPresence[$policyKey] = -not [string]::IsNullOrWhiteSpace([string]$config[$policyKey])
}
$workerLog = [ordered]@{ status = 'not-requested' }
if (-not [string]::IsNullOrWhiteSpace($WorkerLogPath)) {
    $workerLog = Get-PathObservation -Path ([System.IO.Path]::GetFullPath($WorkerLogPath))
}
$requirements = [ordered]@{
    'registration' = 'Correlate Worker registration and healthy status with its node and instance IDs.'
    'real-public-pr' = 'Verify the public GitHub PR, its actual target base branch, admitted actor, job ID, and immutable base/head SHAs.'
    'shared-repository-preparation' = 'Compare both runs for the exact repository ID; capture detached HEAD and expected SHAs during each active attempt.'
    'codex-build-test' = 'Attach build/test invocations, working directory, exit codes, and output tied to the attempt. Log keywords are not proof.'
    'inline-completion' = 'Confirm one accepted immutable result for the successful attempt and matching Dashboard digest. HTTP retries may be idempotent.'
    'lease-cancellation' = 'Capture an active lease, withdrawal of its final authorization, and terminal cancellation with no accepted success result.'
    'processhost-descendant-cleanup' = 'Compare descendant PID and creation-time identities captured while active with post-teardown observations. ProcessHost should remain healthy.'
    'workspace-cleanup' = 'Compare each exact attempt directory while active and after teardown. Missing roots or an initially empty root cannot prove cleanup.'
    'shared-git-policy-config' = 'Review effective policy values and Worker-side conservative maintenance. Key presence alone is not runtime validation.'
}
$checks = @($requirements.GetEnumerator() | ForEach-Object {
    [ordered]@{ check = $_.Key; status = 'manual'; evidence = $_.Value }
})
$report = [ordered]@{
    schemaVersion = 2
    generatedAt = [DateTime]::UtcNow.ToString('o')
    scriptRole = 'Evidence collector only. This script does not execute or certify an end-to-end run.'
    acceptanceStatus = 'unverified'
    captureStage = $CaptureStage
    taskId = $TaskId
    cancelTaskId = $CancelTaskId
    pullRequestUrl = $PullRequestUrl
    configPath = $resolvedConfigPath
    observations = [ordered]@{
        sharedRoot = $sharedRootObservation
        workspaceRoot = $workspaceRootObservation
        repository = $repository
        attempt = $attempt
        cancelAttempt = $cancelAttempt
        processHost = Get-ProcessObservation -ExecutablePath ([string]$config['WORKER_PROCESS_HOST_PATH'])
        workerLog = $workerLog
        sharedGitPolicyKeyPresence = $policyPresence
    }
    checks = $checks
}
$json = $report | ConvertTo-Json -Depth 12
$outputPath = [System.IO.Path]::GetFullPath($EvidenceOutputPath)
# CreateNew preserves earlier captures and refuses to overwrite config, logs, or other inputs.
$stream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream.Write($bytes, 0, $bytes.Length)
} finally {
    $stream.Dispose()
}
Write-Host "Wrote unverified E2E observations to $outputPath"
Write-Output $json
