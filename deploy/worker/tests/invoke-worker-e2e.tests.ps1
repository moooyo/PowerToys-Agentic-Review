#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$CollectorPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'invoke-worker-e2e.ps1')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CollectorPath = [System.IO.Path]::GetFullPath($CollectorPath)
$script:TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('worker e2e regression ' + [guid]::NewGuid().ToString('N'))
$script:ScenarioIndex = 0
$script:CaptureIndex = 0
$script:PassedCount = 0
$script:SkippedCount = 0
$script:CreatedLinks = [System.Collections.Generic.List[string]]::new()

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ($Actual -cne $Expected) {
        throw "$Message Expected <$Expected>; actual <$Actual>."
    }
}

function Invoke-Case {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:PassedCount++
        Write-Host "PASS $Name"
    } catch {
        throw "FAIL ${Name}: $($_.Exception.Message)"
    }
}

function Write-TestConfig {
    param([string]$Path, [System.Collections.IDictionary]$Values)
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('@{')
    foreach ($entry in $Values.GetEnumerator()) {
        $key = ([string]$entry.Key).Replace("'", "''")
        $value = ([string]$entry.Value).Replace("'", "''")
        $lines.Add("    '$key' = '$value'")
    }
    $lines.Add('}')
    [System.IO.File]::WriteAllLines($Path, $lines, [System.Text.UTF8Encoding]::new($false))
}

function New-Scenario {
    param([string]$Name, [switch]$CreateRoots)
    $script:ScenarioIndex++
    $directory = Join-Path $script:TestRoot ("$($script:ScenarioIndex)-$Name")
    [void][System.IO.Directory]::CreateDirectory($directory)
    $sharedRoot = Join-Path $directory 'shared git'
    $workspaceRoot = Join-Path $directory 'workspaces'
    if ($CreateRoots) {
        [void][System.IO.Directory]::CreateDirectory($sharedRoot)
        [void][System.IO.Directory]::CreateDirectory($workspaceRoot)
    }
    $values = @{
        WORKER_GIT_SHARED_ROOT_DIRECTORY = $sharedRoot
        WORKER_WORKSPACE_ROOT_DIRECTORY = $workspaceRoot
        WORKER_PROCESS_HOST_PATH = (Join-Path $directory 'nonexistent-process-host.exe')
        WORKER_GIT_SHARED_CACHE_MAX_BYTES = '1024'
        WORKER_GIT_SHARED_MINIMUM_FREE_DISK_BYTES = '1024'
        WORKER_GIT_SHARED_SCAN_ENTRY_LIMIT = '100'
        WORKER_GIT_SHARED_SCAN_TIMEOUT_MS = '1000'
        WORKER_GIT_SHARED_GC_MINIMUM_INTERVAL_MINUTES = '60'
        WORKER_GIT_SHARED_GC_PRUNE_AGE_HOURS = '24'
    }
    $configPath = Join-Path $directory 'worker-config.psd1'
    Write-TestConfig -Path $configPath -Values $values
    return @{
        Directory = $directory
        SharedRoot = $sharedRoot
        WorkspaceRoot = $workspaceRoot
        ConfigPath = $configPath
        ConfigValues = $values
    }
}

function New-CollectorParameters {
    param([hashtable]$Scenario, [hashtable]$Overrides = @{})
    $script:CaptureIndex++
    $parameters = @{
        ConfigPath = $Scenario.ConfigPath
        PullRequestUrl = 'https://github.com/example/repository/pull/123'
        TaskId = 'task-main'
        EvidenceOutputPath = (Join-Path $Scenario.Directory ("capture-$($script:CaptureIndex).json"))
    }
    foreach ($key in $Overrides.Keys) { $parameters[$key] = $Overrides[$key] }
    return $parameters
}

function Invoke-Capture {
    param([hashtable]$Scenario, [hashtable]$Overrides = @{})
    $parameters = New-CollectorParameters -Scenario $Scenario -Overrides $Overrides
    & $script:CollectorPath @parameters 6>$null | Out-Null
    Assert-True -Condition ([System.IO.File]::Exists($parameters.EvidenceOutputPath)) -Message 'The collector must create the requested evidence file.'
    $raw = [System.IO.File]::ReadAllText($parameters.EvidenceOutputPath)
    return @{
        Report = (ConvertFrom-Json -InputObject $raw)
        Raw = $raw
        Path = $parameters.EvidenceOutputPath
    }
}

function Assert-Rejected {
    param([hashtable]$Parameters, [string]$MessagePattern, [switch]$ExistingOutput)
    $failure = $null
    try {
        & $script:CollectorPath @Parameters 6>$null | Out-Null
    } catch {
        $failure = $_
    }
    Assert-True -Condition ($null -ne $failure) -Message 'The collector must reject this invocation.'
    if (-not [string]::IsNullOrWhiteSpace($MessagePattern)) {
        Assert-True -Condition ($failure.Exception.Message -like $MessagePattern) -Message "The rejection must identify its cause: $MessagePattern"
    }
    if (-not $ExistingOutput) {
        Assert-True -Condition (-not [System.IO.File]::Exists($Parameters.EvidenceOutputPath)) -Message 'Rejected input must not create an evidence file.'
    }
}

function Assert-Unverified {
    param([object]$Report)
    Assert-Equal -Actual $Report.schemaVersion -Expected 2 -Message 'The report must use the observation schema.'
    Assert-Equal -Actual $Report.acceptanceStatus -Expected 'unverified' -Message 'An observation capture must never certify E2E acceptance.'
    Assert-True -Condition (@($Report.checks).Count -gt 0) -Message 'The report must expose the remaining acceptance checks.'
    foreach ($check in $Report.checks) {
        Assert-Equal -Actual $check.status -Expected 'manual' -Message "The $($check.check) check needs independent evidence."
    }
}

function Get-Check {
    param([object]$Report, [string]$Name)
    $checks = @($Report.checks | Where-Object { $_.check -ceq $Name })
    Assert-Equal -Actual $checks.Count -Expected 1 -Message "The $Name check must appear exactly once."
    return $checks[0]
}

function Remove-TestPath {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $resolvedPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).ProviderPath)
    $rootPath = [System.IO.Path]::GetFullPath($script:TestRoot)
    $rootPrefix = $rootPath.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    $isRoot = [string]::Equals($resolvedPath, $rootPath, [System.StringComparison]::OrdinalIgnoreCase)
    $isChild = $resolvedPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    Assert-True -Condition ($isRoot -or $isChild) -Message 'Fixture cleanup must remain inside the exact test directory.'
    $entry = Get-Item -LiteralPath $resolvedPath -Force
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Remove-Item -LiteralPath $resolvedPath -Force
    } else {
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
    }
}

function New-TestLink {
    param([string]$Path, [string]$Target)
    [void](New-Item -ItemType SymbolicLink -Path $Path -Target $Target -ErrorAction Stop)
    $script:CreatedLinks.Add($Path)
}

[void][System.IO.Directory]::CreateDirectory($script:TestRoot)
try {
    Invoke-Case -Name 'missing and initially empty roots never establish acceptance or cleanup' -Body {
        foreach ($createRoots in @($false, $true)) {
            $scenario = New-Scenario -Name 'empty-roots' -CreateRoots:$createRoots
            foreach ($stage in @('baseline', 'active', 'completed', 'cancelled')) {
                $capture = Invoke-Capture -Scenario $scenario -Overrides @{
                    CaptureStage = $stage
                    RepositoryId = 42
                    AttemptId = 'abc'
                    CancelTaskId = 'task-cancel'
                    CancelAttemptId = 'hello'
                }
                Assert-Unverified -Report $capture.Report
                Assert-Equal -Actual $capture.Report.captureStage -Expected $stage -Message 'The capture stage must be descriptive only.'
                Assert-Equal -Actual (Get-Check -Report $capture.Report -Name 'workspace-cleanup').status -Expected 'manual' -Message 'An empty directory is not cleanup evidence.'
                if ($createRoots) {
                    Assert-Equal -Actual $capture.Report.observations.workspaceRoot.status -Expected 'present' -Message 'The empty workspace root exists.'
                    Assert-Equal -Actual $capture.Report.observations.attempt.directory.status -Expected 'missing' -Message 'The absent exact attempt must be reported as missing.'
                    Assert-Equal -Actual $capture.Report.observations.cancelAttempt.directory.status -Expected 'missing' -Message 'The absent cancel attempt must be reported as missing.'
                    Assert-Equal -Actual $capture.Report.observations.repository.directory.status -Expected 'missing' -Message 'An empty cache does not contain the requested repository.'
                } else {
                    Assert-Equal -Actual $capture.Report.observations.sharedRoot.status -Expected 'missing' -Message 'The missing shared root must be explicit.'
                    Assert-Equal -Actual $capture.Report.observations.workspaceRoot.status -Expected 'missing' -Message 'The missing workspace root must be explicit.'
                    Assert-Equal -Actual $capture.Report.observations.attempt.status -Expected 'not-inspected' -Message 'A missing workspace root cannot establish attempt absence.'
                    Assert-Equal -Actual $capture.Report.observations.repository.directory.status -Expected 'not-inspected' -Message 'A missing shared root cannot establish repository absence.'
                }
            }
        }
    }

    Invoke-Case -Name 'log keywords and populated policy keys are not runtime command proof' -Body {
        $scenario = New-Scenario -Name 'keyword-log' -CreateRoots
        $logPath = Join-Path $scenario.Directory 'worker.log'
        $sentinel = 'worker-log-sensitive-sentinel-836109'
        [System.IO.File]::WriteAllText($logPath, "codex build test success exit code 0`n$sentinel")
        $capture = Invoke-Capture -Scenario $scenario -Overrides @{ WorkerLogPath = $logPath; CaptureStage = 'completed' }
        Assert-Unverified -Report $capture.Report
        Assert-Equal -Actual $capture.Report.observations.workerLog.status -Expected 'present' -Message 'The log file presence should be observed.'
        Assert-Equal -Actual (Get-Check -Report $capture.Report -Name 'codex-build-test').status -Expected 'manual' -Message 'Codex keywords cannot prove an executed build or test.'
        Assert-True -Condition (-not $capture.Raw.Contains($sentinel)) -Message 'The report must not copy log contents.'
        foreach ($property in $capture.Report.observations.sharedGitPolicyKeyPresence.PSObject.Properties) {
            Assert-Equal -Actual $property.Value -Expected $true -Message "The $($property.Name) fixture must be configured."
        }
        Assert-Equal -Actual (Get-Check -Report $capture.Report -Name 'shared-git-policy-config').status -Expected 'manual' -Message 'Configured keys cannot prove runtime maintenance behavior.'
    }

    Invoke-Case -Name 'attempt paths use exact UTF-8 SHA256 vectors before and after teardown' -Body {
        $scenario = New-Scenario -Name 'attempt-mapping' -CreateRoots
        # These are fixed SHA256 vectors, independent of the collector implementation.
        $attemptPath = Join-Path $scenario.WorkspaceRoot 'attempt-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        $cancelPath = Join-Path $scenario.WorkspaceRoot 'attempt-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
        foreach ($path in @($attemptPath, $cancelPath)) {
            $checkoutPath = Join-Path $path 'checkout'
            [void][System.IO.Directory]::CreateDirectory($checkoutPath)
            [System.IO.File]::WriteAllText((Join-Path $checkoutPath '.git'), 'gitdir: fixture-only')
        }
        [void][System.IO.Directory]::CreateDirectory((Join-Path $scenario.WorkspaceRoot 'attempt-abc'))
        [void][System.IO.Directory]::CreateDirectory((Join-Path $scenario.WorkspaceRoot 'attempt-unrelated'))
        $identifiers = @{ AttemptId = 'abc'; CancelAttemptId = 'hello'; CancelTaskId = 'task-cancel'; CaptureStage = 'active' }
        $active = Invoke-Capture -Scenario $scenario -Overrides $identifiers
        Assert-Unverified -Report $active.Report
        foreach ($pair in @(
            @{ Observation = $active.Report.observations.attempt; Id = 'abc'; Path = $attemptPath },
            @{ Observation = $active.Report.observations.cancelAttempt; Id = 'hello'; Path = $cancelPath }
        )) {
            Assert-Equal -Actual $pair.Observation.runAttemptId -Expected $pair.Id -Message 'The original attempt ID must be preserved.'
            Assert-Equal -Actual $pair.Observation.directory.path -Expected $pair.Path -Message 'Attempt directory mapping must match the complete lowercase SHA256 digest.'
            Assert-Equal -Actual $pair.Observation.directory.status -Expected 'present' -Message 'The exact active attempt directory must be observed.'
            Assert-Equal -Actual $pair.Observation.checkout.status -Expected 'present' -Message 'The active checkout must be observed.'
            Assert-Equal -Actual $pair.Observation.gitFile.kind -Expected 'file' -Message 'The linked-worktree .git file must be observed.'
        }
        Remove-TestPath -Path $attemptPath
        Remove-TestPath -Path $cancelPath
        $identifiers.CaptureStage = 'completed'
        $after = Invoke-Capture -Scenario $scenario -Overrides $identifiers
        Assert-Unverified -Report $after.Report
        foreach ($observation in @($after.Report.observations.attempt, $after.Report.observations.cancelAttempt)) {
            Assert-Equal -Actual $observation.directory.status -Expected 'missing' -Message 'The exact directory absence must be observed after teardown.'
            Assert-Equal -Actual $observation.checkout.status -Expected 'not-inspected' -Message 'An absent attempt has no inspectable checkout.'
            Assert-Equal -Actual $observation.gitFile.status -Expected 'not-inspected' -Message 'An absent attempt has no inspectable .git file.'
        }
        Assert-Equal -Actual (Get-Check -Report $after.Report -Name 'workspace-cleanup').status -Expected 'manual' -Message 'Separate captures still require independent cleanup correlation.'
    }

    Invoke-Case -Name 'repository observations use the exact requested repository ID' -Body {
        $scenario = New-Scenario -Name 'exact-repository' -CreateRoots
        $unrelatedPath = Join-Path $scenario.SharedRoot 'repository-420.git'
        [void][System.IO.Directory]::CreateDirectory($unrelatedPath)
        [System.IO.File]::WriteAllText((Join-Path $unrelatedPath 'HEAD'), 'unrelated-repository-head')
        $expectedPath = Join-Path $scenario.SharedRoot 'repository-42.git'
        $missing = Invoke-Capture -Scenario $scenario -Overrides @{ RepositoryId = 42 }
        Assert-Unverified -Report $missing.Report
        Assert-Equal -Actual $missing.Report.observations.repository.repositoryId -Expected 42 -Message 'The numeric repository ID must be retained.'
        Assert-Equal -Actual $missing.Report.observations.repository.directory.path -Expected $expectedPath -Message 'Only the exact repository path should be inspected.'
        Assert-Equal -Actual $missing.Report.observations.repository.directory.status -Expected 'missing' -Message 'An unrelated repository cannot satisfy the requested ID.'
        Assert-Equal -Actual $missing.Report.observations.repository.head.status -Expected 'not-inspected' -Message 'The unrelated repository HEAD must be ignored.'
        Assert-True -Condition (-not $missing.Raw.Contains($unrelatedPath)) -Message 'The report must not enumerate unrelated repositories.'
        [void][System.IO.Directory]::CreateDirectory($expectedPath)
        [System.IO.File]::WriteAllText((Join-Path $expectedPath 'HEAD'), 'ref: refs/heads/main')
        $present = Invoke-Capture -Scenario $scenario -Overrides @{ RepositoryId = 42 }
        Assert-Unverified -Report $present.Report
        Assert-Equal -Actual $present.Report.observations.repository.directory.status -Expected 'present' -Message 'The requested repository should be observed when present.'
        Assert-Equal -Actual $present.Report.observations.repository.head.path -Expected (Join-Path $expectedPath 'HEAD') -Message 'HEAD must belong to the exact repository.'
        Assert-Equal -Actual $present.Report.observations.repository.head.status -Expected 'present' -Message 'The requested repository HEAD should be observed.'
        $notRequested = Invoke-Capture -Scenario $scenario
        Assert-Equal -Actual $notRequested.Report.observations.repository.status -Expected 'not-requested' -Message 'Omitting the repository ID must not select an arbitrary repository.'
    }

    Invoke-Case -Name 'both configured roots must be present in config and absolute' -Body {
        foreach ($key in @('WORKER_GIT_SHARED_ROOT_DIRECTORY', 'WORKER_WORKSPACE_ROOT_DIRECTORY')) {
            foreach ($invalidValue in @($null, '', ' ', 'relative-root')) {
                $scenario = New-Scenario -Name 'invalid-config' -CreateRoots
                if ($null -eq $invalidValue) {
                    $scenario.ConfigValues.Remove($key)
                } else {
                    $scenario.ConfigValues[$key] = $invalidValue
                }
                Write-TestConfig -Path $scenario.ConfigPath -Values $scenario.ConfigValues
                $parameters = New-CollectorParameters -Scenario $scenario
                Assert-Rejected -Parameters $parameters -MessagePattern "$key must be an absolute path*"
            }
        }
    }

    Invoke-Case -Name 'output creation never clobbers previous captures or inputs' -Body {
        $scenario = New-Scenario -Name 'no-clobber' -CreateRoots
        $existingPath = Join-Path $scenario.Directory 'existing-evidence.json'
        $logPath = Join-Path $scenario.Directory 'worker.log'
        [System.IO.File]::WriteAllBytes($existingPath, [byte[]]@(0, 255, 10, 13, 65, 66, 67))
        [System.IO.File]::WriteAllText($logPath, 'original worker log')
        foreach ($path in @($existingPath, $scenario.ConfigPath, $logPath)) {
            $before = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path))
            $parameters = New-CollectorParameters -Scenario $scenario -Overrides @{ EvidenceOutputPath = $path; WorkerLogPath = $logPath }
            Assert-Rejected -Parameters $parameters -ExistingOutput
            $after = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path))
            Assert-Equal -Actual $after -Expected $before -Message 'A refused output write must preserve every original byte.'
        }
    }

    Invoke-Case -Name 'invalid task, attempt, repository, and pull-request identifiers are rejected' -Body {
        $scenario = New-Scenario -Name 'invalid-identifiers' -CreateRoots
        foreach ($key in @('TaskId', 'CancelTaskId', 'AttemptId', 'CancelAttemptId')) {
            foreach ($value in @('../escape', "bad`nid", "bad`n", ('a' * 129))) {
                $overrides = @{ CancelTaskId = 'task-cancel' }
                $overrides[$key] = $value
                $parameters = New-CollectorParameters -Scenario $scenario -Overrides $overrides
                Assert-Rejected -Parameters $parameters
            }
        }
        foreach ($repositoryId in @(0, -1, 9007199254740992)) {
            $parameters = New-CollectorParameters -Scenario $scenario -Overrides @{ RepositoryId = $repositoryId }
            Assert-Rejected -Parameters $parameters
        }
        foreach ($url in @('https://github.com/example/repository/pull/0', 'https://example.com/example/repository/pull/123', 'https://github.com/example/repository/pull/123?extra=1', "https://github.com/example/repository/pull/123`n")) {
            $parameters = New-CollectorParameters -Scenario $scenario -Overrides @{ PullRequestUrl = $url }
            Assert-Rejected -Parameters $parameters
        }
    }

    Invoke-Case -Name 'a cancel attempt requires its cancel task ID' -Body {
        $scenario = New-Scenario -Name 'cancel-correlation' -CreateRoots
        $parameters = New-CollectorParameters -Scenario $scenario -Overrides @{ CancelAttemptId = 'hello' }
        Assert-Rejected -Parameters $parameters -MessagePattern 'CancelTaskId is required when CancelAttemptId is supplied.'
    }

    $linkScenario = New-Scenario -Name 'symbolic-links' -CreateRoots
    $workspaceLink = Join-Path $linkScenario.Directory 'workspace-link'
    $linksAvailable = $true
    try {
        New-TestLink -Path $workspaceLink -Target $linkScenario.WorkspaceRoot
    } catch {
        $linksAvailable = $false
        $script:SkippedCount++
        Write-Host 'SKIP reparse-point observations: symbolic link creation is unavailable in this environment.'
    }
    if ($linksAvailable) {
        Invoke-Case -Name 'reparse roots, attempts, checkouts, repositories, and git metadata are not followed' -Body {
            $linkScenario.ConfigValues.WORKER_WORKSPACE_ROOT_DIRECTORY = $workspaceLink
            Write-TestConfig -Path $linkScenario.ConfigPath -Values $linkScenario.ConfigValues
            $workspace = Invoke-Capture -Scenario $linkScenario -Overrides @{ AttemptId = 'abc' }
            Assert-Unverified -Report $workspace.Report
            Assert-Equal -Actual $workspace.Report.observations.workspaceRoot.status -Expected 'unsupported-reparse-point' -Message 'A linked workspace root must not be traversed.'
            Assert-Equal -Actual $workspace.Report.observations.attempt.status -Expected 'not-inspected' -Message 'Attempts beneath a linked root must not be inspected.'

            $sharedLink = Join-Path $linkScenario.Directory 'shared-link'
            New-TestLink -Path $sharedLink -Target $linkScenario.SharedRoot
            $linkScenario.ConfigValues.WORKER_GIT_SHARED_ROOT_DIRECTORY = $sharedLink
            $linkScenario.ConfigValues.WORKER_WORKSPACE_ROOT_DIRECTORY = $linkScenario.WorkspaceRoot
            Write-TestConfig -Path $linkScenario.ConfigPath -Values $linkScenario.ConfigValues
            $shared = Invoke-Capture -Scenario $linkScenario -Overrides @{ RepositoryId = 42 }
            Assert-Equal -Actual $shared.Report.observations.sharedRoot.status -Expected 'unsupported-reparse-point' -Message 'A linked shared root must not be traversed.'
            Assert-Equal -Actual $shared.Report.observations.repository.directory.status -Expected 'not-inspected' -Message 'Repositories beneath a linked root must not be inspected.'

            $linkScenario.ConfigValues.WORKER_GIT_SHARED_ROOT_DIRECTORY = $linkScenario.SharedRoot
            Write-TestConfig -Path $linkScenario.ConfigPath -Values $linkScenario.ConfigValues
            $targetDirectory = Join-Path $linkScenario.Directory 'link-target'
            [void][System.IO.Directory]::CreateDirectory((Join-Path $targetDirectory 'checkout'))
            [System.IO.File]::WriteAllText((Join-Path $targetDirectory 'HEAD'), 'ref: refs/heads/main')
            $attemptPath = Join-Path $linkScenario.WorkspaceRoot 'attempt-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
            $repositoryPath = Join-Path $linkScenario.SharedRoot 'repository-42.git'
            New-TestLink -Path $attemptPath -Target $targetDirectory
            New-TestLink -Path $repositoryPath -Target $targetDirectory
            $linkedDirectories = Invoke-Capture -Scenario $linkScenario -Overrides @{ AttemptId = 'abc'; RepositoryId = 42 }
            Assert-Unverified -Report $linkedDirectories.Report
            Assert-Equal -Actual $linkedDirectories.Report.observations.attempt.directory.status -Expected 'unsupported-reparse-point' -Message 'A linked attempt directory must not be traversed.'
            Assert-Equal -Actual $linkedDirectories.Report.observations.attempt.checkout.status -Expected 'not-inspected' -Message 'A linked attempt checkout must not be inspected.'
            Assert-Equal -Actual $linkedDirectories.Report.observations.repository.directory.status -Expected 'unsupported-reparse-point' -Message 'A linked repository must not be traversed.'
            Assert-Equal -Actual $linkedDirectories.Report.observations.repository.head.status -Expected 'not-inspected' -Message 'A linked repository HEAD must not be inspected.'

            Remove-TestPath -Path $attemptPath
            [void][System.IO.Directory]::CreateDirectory($attemptPath)
            $checkoutPath = Join-Path $attemptPath 'checkout'
            New-TestLink -Path $checkoutPath -Target $targetDirectory
            $linkedCheckout = Invoke-Capture -Scenario $linkScenario -Overrides @{ AttemptId = 'abc' }
            Assert-Equal -Actual $linkedCheckout.Report.observations.attempt.checkout.status -Expected 'unsupported-reparse-point' -Message 'A linked checkout must not be traversed.'
            Assert-Equal -Actual $linkedCheckout.Report.observations.attempt.gitFile.status -Expected 'not-inspected' -Message 'Git metadata beneath a linked checkout must not be inspected.'

            Remove-TestPath -Path $checkoutPath
            [void][System.IO.Directory]::CreateDirectory($checkoutPath)
            $gitTarget = Join-Path $targetDirectory 'git-metadata'
            [System.IO.File]::WriteAllText($gitTarget, 'gitdir: fixture-only')
            New-TestLink -Path (Join-Path $checkoutPath '.git') -Target $gitTarget
            $linkedGitFile = Invoke-Capture -Scenario $linkScenario -Overrides @{ AttemptId = 'abc' }
            Assert-Equal -Actual $linkedGitFile.Report.observations.attempt.gitFile.status -Expected 'unsupported-reparse-point' -Message 'Linked git metadata must be reported without following it.'
        }
    }
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
        $processMockState = @{ CallCount = 0; ClassName = $null; Properties = @(); Processes = @() }
        # Define the mock in the test script scope so the invoked collector can resolve it.
        $processMock = {
            [CmdletBinding()]
            param(
                [Parameter(Position = 0)][string]$ClassName,
                [string[]]$Property
            )
            $processMockState.CallCount++
            $processMockState.ClassName = $ClassName
            $processMockState.Properties = $Property
            return $processMockState.Processes
        }.GetNewClosure()
        Set-Item -LiteralPath 'Function:\Get-CimInstance' -Value $processMock
        try {
            Invoke-Case -Name 'process identities exclude recycled and unconfirmed parent links without leaking sensitive fields' -Body {
                $scenario = New-Scenario -Name 'process-identities' -CreateRoots
                $hostPath = Join-Path $scenario.Directory 'ProcessHost.exe'
                $scenario.ConfigValues.WORKER_PROCESS_HOST_PATH = $hostPath
                Write-TestConfig -Path $scenario.ConfigPath -Values $scenario.ConfigValues
                $hostCreated = [DateTime]::new(2026, 1, 2, 3, 4, 5, [DateTimeKind]::Utc)
                $commandLineSentinel = 'process-command-line-secret-624193'
                $expected = @{
                    100 = @{ Parent = 10; Name = 'ProcessHost.exe'; Created = $hostCreated }
                    200 = @{ Parent = 100; Name = 'worker.exe'; Created = $hostCreated.AddSeconds(1) }
                    300 = @{ Parent = 200; Name = 'codex.exe'; Created = $hostCreated.AddSeconds(2) }
                }
                # Grandchild precedes child to exercise closure over multiple passes.
                $processMockState.Processes = @(
                    [pscustomobject]@{
                        ProcessId = [uint32]300; ParentProcessId = [uint32]200; Name = 'codex.exe'
                        CreationDate = $expected[300].Created; ExecutablePath = (Join-Path $scenario.Directory 'codex.exe')
                        CommandLine = $commandLineSentinel
                    },
                    [pscustomobject]@{
                        ProcessId = [uint32]400; ParentProcessId = [uint32]100; Name = 'stale-child.exe'
                        CreationDate = $hostCreated.AddSeconds(-1); ExecutablePath = (Join-Path $scenario.Directory 'stale-child.exe')
                        CommandLine = $commandLineSentinel
                    },
                    [pscustomobject]@{
                        ProcessId = [uint32]500; ParentProcessId = [uint32]100; Name = 'undated-child.exe'
                        CreationDate = $null; ExecutablePath = (Join-Path $scenario.Directory 'undated-child.exe')
                        CommandLine = $commandLineSentinel
                    },
                    [pscustomobject]@{
                        ProcessId = [uint32]600; ParentProcessId = [uint32]10; Name = 'ProcessHost.exe'
                        CreationDate = $hostCreated; ExecutablePath = (Join-Path $scenario.Directory 'other-host/ProcessHost.exe')
                        CommandLine = $commandLineSentinel
                    },
                    [pscustomobject]@{
                        ProcessId = [uint32]200; ParentProcessId = [uint32]100; Name = 'worker.exe'
                        CreationDate = $expected[200].Created; ExecutablePath = $null
                        CommandLine = $commandLineSentinel
                    },
                    [pscustomobject]@{
                        ProcessId = [uint32]100; ParentProcessId = [uint32]10; Name = 'ProcessHost.exe'
                        CreationDate = $hostCreated; ExecutablePath = $hostPath
                        CommandLine = $commandLineSentinel
                    }
                )
                $capture = Invoke-Capture -Scenario $scenario -Overrides @{ CaptureStage = 'active' }
                Assert-Unverified -Report $capture.Report
                Assert-Equal -Actual $processMockState.CallCount -Expected 1 -Message 'The collector must query the deterministic process fixture once.'
                Assert-Equal -Actual $processMockState.ClassName -Expected 'Win32_Process' -Message 'The collector must inspect Windows processes.'
                Assert-Equal -Actual (($processMockState.Properties | Sort-Object) -join ',') -Expected 'CreationDate,ExecutablePath,Name,ParentProcessId,ProcessId' -Message 'The process query must request only the metadata needed for identity and ancestry.'
                $observation = $capture.Report.observations.processHost
                Assert-Equal -Actual $observation.status -Expected 'captured' -Message 'The Windows process observation must use the provided fixture.'
                Assert-Equal -Actual $observation.matchingHostCount -Expected 1 -Message 'Matching a process name alone must not select an unrelated host.'
                Assert-Equal -Actual $observation.unconfirmedParentLinkCount -Expected 2 -Message 'Predating and undated children must be counted once as unconfirmed.'
                Assert-Equal -Actual $observation.processesWithUnreadableExecutablePath -Expected 1 -Message 'An unreadable child executable path must be reported without losing its confirmed parent link.'
                Assert-Equal -Actual (($observation.processes.processId | Sort-Object) -join ',') -Expected '100,200,300' -Message 'Only the exact host and confirmed descendants may be captured.'
                foreach ($process in $observation.processes) {
                    $identity = $expected[[int]$process.processId]
                    Assert-Equal -Actual $process.parentProcessId -Expected $identity.Parent -Message 'The original parent PID must be retained.'
                    Assert-Equal -Actual $process.name -Expected $identity.Name -Message 'The captured process must have the expected identity.'
                    $actualCreated = [DateTime]$process.creationDate
                    Assert-Equal -Actual $actualCreated.ToUniversalTime().Ticks -Expected $identity.Created.Ticks -Message 'Creation time must preserve the captured process identity.'
                    Assert-Equal -Actual (($process.PSObject.Properties.Name | Sort-Object) -join ',') -Expected 'creationDate,name,parentProcessId,processId' -Message 'Process projection must omit CommandLine and ExecutablePath.'
                }
                Assert-True -Condition (-not $capture.Raw.Contains($commandLineSentinel)) -Message 'Command-line contents must never appear in evidence.'
            }
        } finally {
            Remove-Item -LiteralPath 'Function:\Get-CimInstance' -Force
        }
    } else {
        $script:SkippedCount++
        Write-Host 'SKIP process identity fixture: native Windows process inspection is required.'
    }
    Write-Host "All $($script:PassedCount) regression cases passed; $($script:SkippedCount) skipped."
} finally {
    # Remove links first so recursive cleanup cannot walk into their targets.
    foreach ($link in $script:CreatedLinks) {
        $entry = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
        if ($null -ne $entry -and ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Remove-TestPath -Path $link
        }
    }
    Remove-TestPath -Path $script:TestRoot
}
