$ErrorActionPreference = 'Stop'
$snapshot = Join-Path $PSScriptRoot 'process-snapshot.ps1'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('agentic-review-process-snapshot-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporary
$identityPath = Join-Path $temporary 'identities.json'
$epoch = [DateTime]::Parse('2026-09-29T12:00:00Z').ToUniversalTime()
$script:mockProcesses = @()
$checks = @()

# The invoked snapshot inherits this function; the test never queries real processes.
function Get-CimInstance {
    param([string]$ClassName)
    if ($ClassName -cne 'Win32_Process') { throw 'Unexpected CIM class.' }
    return $mockProcesses
}
function New-FixtureProcess([int]$ProcessId, [int]$ParentProcessId, [int]$BirthSeconds) {
    [pscustomobject]@{ ProcessId=$ProcessId; ParentProcessId=$ParentProcessId; CreationDate=$epoch.AddSeconds($BirthSeconds); ExecutablePath=('C:\fixture\process-' + $ProcessId + '.exe') }
}
function Assert-Snapshot([string]$Name, [hashtable]$Parameters, [int[]]$ExpectedIds) {
    $text = (& $snapshot @Parameters) -join [Environment]::NewLine
    if (-not $text.StartsWith('[') -or -not $text.EndsWith(']')) { throw ($Name + ': output must remain a JSON array.') }
    $actual = $text | ConvertFrom-Json
    $actualIds = @(foreach ($entry in $actual) {
        $keys = @($entry.PSObject.Properties.Name | Sort-Object) -join ','
        if ($keys -cne 'createdAt,executablePath,parentProcessId,processId') { throw ($Name + ': output fields changed.') }
        [int]$entry.processId
    })
    if ((@($actualIds | Sort-Object) -join ',') -cne (@($ExpectedIds | Sort-Object) -join ',')) {
        throw ($Name + ': unexpected process IDs: ' + ($actualIds -join ','))
    }
    $script:checks += $Name
}

try {
    $script:mockProcesses = @((New-FixtureProcess 100 10 0), (New-FixtureProcess 200 100 2), (New-FixtureProcess 400 20 3))
    $identities = @(
        @{ processId=100; createdAt=$epoch.ToString('o') },
        @{ processId=200; createdAt=$epoch.AddSeconds(2).ToString('o') }
    )
    [IO.File]::WriteAllText($identityPath,($identities | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    Assert-Snapshot 'matches multiple exact identities' @{ IdentityPath=$identityPath } @(100,200)

    $identities[0].createdAt = $epoch.AddSeconds(1).ToString('o')
    $identities[1].createdAt = $epoch.AddSeconds(3).ToString('o')
    [IO.File]::WriteAllText($identityPath,($identities | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    Assert-Snapshot 'refuses matching PIDs with wrong birth times' @{ IdentityPath=$identityPath } @()

    $script:mockProcesses = @((New-FixtureProcess 300 200 3), (New-FixtureProcess 200 100 2), (New-FixtureProcess 100 10 0), (New-FixtureProcess 400 20 3))
    Assert-Snapshot 'includes the root and unordered live descendants' @{ RootProcessId=100 } @(100,200,300)

    $script:mockProcesses += @((New-FixtureProcess 500 100 -10), (New-FixtureProcess 501 500 1), (New-FixtureProcess 600 200 1))
    Assert-Snapshot 'excludes stale children of reused parent PIDs and their branches' @{ RootProcessId=100 } @(100,200,300)
    [pscustomobject]@{ status='passed'; checks=$checks; realProcessQueries=0 } | ConvertTo-Json -Depth 3
} finally {
    if (Test-Path -LiteralPath $identityPath) { Remove-Item -LiteralPath $identityPath -Force }
    Remove-Item -LiteralPath $temporary
}
