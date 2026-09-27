Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-OperationsPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f"<>|?*]' -or $Path.Substring(2).Contains(':')) {
        throw 'Operations paths must be absolute local Windows paths without special characters.'
    }
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if ($resolved.Equals([System.IO.Path]::GetPathRoot($resolved), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'An operations path cannot be an entire volume root.'
    }
    return $resolved.TrimEnd('\')
}

function Assert-OperationsPath {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -ne [bool]$Directory) { throw 'An operations path has the wrong type.' }
    $cursor = $item
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Operations paths cannot contain reparse points.'
        }
        if ($cursor -is [System.IO.DirectoryInfo]) { $cursor = $cursor.Parent } else { $cursor = $cursor.Directory }
    }
}

function Get-OperationsIdentitySid {
    param([Parameter(Mandatory = $true)][string]$Identity)
    $account = [System.Security.Principal.NTAccount]::new($Identity)
    return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Assert-OperationsAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$IdentitySid,
        [switch]$Private,
        [switch]$RuntimeWrite
    )
    $acl = Get-Acl -LiteralPath $Path
    $trusted = @('S-1-5-18', 'S-1-5-32-544')
    if ($RuntimeWrite) { $trusted += $IdentitySid }
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -notin $trusted) { throw 'An operations path has an untrusted owner.' }
    $writeRights = [System.Security.AccessControl.FileSystemRights]::Write -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        if (-not $Private -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        $sid = $rule.IdentityReference.Value
        if ($Private -and $sid -notin @('S-1-5-18', 'S-1-5-32-544', $IdentitySid)) {
            throw 'A private operations path grants access to an unrelated identity.'
        }
        if (($rule.FileSystemRights -band $writeRights) -ne 0 -and $sid -notin $trusted) {
            throw 'An operations path grants write access to an untrusted identity.'
        }
    }
}

function Test-OperationsOverlap {
    param([string]$Left, [string]$Right)
    return $Left.Equals($Right, [System.StringComparison]::OrdinalIgnoreCase) -or
        $Left.StartsWith($Right.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
        $Right.StartsWith($Left.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-OperationsAncestors {
    param([Parameter(Mandatory = $true)][string]$Path)
    # Creating a sibling directory does not replace an existing protected path, but
    # DELETE_CHILD, ACL changes, ownership changes, and ancestor ownership can.
    $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $dangerous = [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $cursor = [System.IO.Path]::GetDirectoryName($Path)
    while (-not [string]::IsNullOrEmpty($cursor)) {
        $acl = Get-Acl -LiteralPath $cursor
        if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trusted) {
            throw 'An operations ancestor has an untrusted owner that could replace protected files.'
        }
        foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
            if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                ($rule.FileSystemRights -band $dangerous) -ne 0 -and $rule.IdentityReference.Value -notin $trusted) {
                throw 'An operations ancestor allows an untrusted identity to replace a protected path.'
            }
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
}

function Assert-OperationsReleaseTree {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$IdentitySid)
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $pending.Push($Root)
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($pending.Count -gt 0) {
        $path = $pending.Pop()
        if (-not $seen.Add($path)) { continue }
        if ($seen.Count -gt 250000 -or $timer.Elapsed.TotalSeconds -gt 300) { throw 'The immutable release ACL scan exceeded its safety limit.' }
        $item = Get-Item -LiteralPath $path -Force
        Assert-OperationsAcl -Path $path -IdentitySid $IdentitySid
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            # pnpm workspace links are supported only when their single physical target
            # remains inside this release and is included in the same ACL scan.
            $targetProperty = $item.PSObject.Properties['Target']
            if ($null -eq $targetProperty -or @($targetProperty.Value).Count -ne 1) { throw 'A release link has no single inspectable target.' }
            $target = [string](@($targetProperty.Value)[0])
            if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path ([System.IO.Path]::GetDirectoryName($path)) $target }
            $target = Resolve-OperationsPath $target
            if (-not $target.StartsWith($Root.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'A runtime dependency link escapes the immutable release.' }
            Assert-OperationsPath -Path $target -Directory:([bool]$item.PSIsContainer)
            $pending.Push($target)
        } elseif ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $pending.Push($child.FullName) }
        }
    }
}

function Get-OperationsConfiguration {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)
    $resolved = Resolve-OperationsPath $ConfigPath
    Assert-OperationsPath $resolved
    if ((Get-Item -LiteralPath $resolved).Length -gt 1MB) { throw 'The operations configuration exceeds its size limit.' }
    try { $config = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'The operations configuration is invalid JSON.' }
    $required = @('schemaVersion', 'role', 'taskName', 'identity', 'releaseDirectory', 'dataDirectory', 'stateDirectory', 'nodeExecutable', 'restartLimit', 'restartDelaySeconds', 'restartMaximumDelaySeconds', 'shutdownTimeoutSeconds', 'artifact', 'environment')
    $actual = @($config.PSObject.Properties.Name)
    if (@($actual | Where-Object { $_ -notin $required }).Count -gt 0 -or @($required | Where-Object { $_ -notin $actual }).Count -gt 0) {
        throw 'The operations configuration has unsupported or missing fields.'
    }
    if ($config.schemaVersion -ne 1 -or $config.role -cnotin @('server', 'worker') -or $config.taskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') {
        throw 'The operations schema, role, or task name is invalid.'
    }
    $identitySid = Get-OperationsIdentitySid $config.identity
    foreach ($name in @('releaseDirectory', 'dataDirectory', 'stateDirectory', 'nodeExecutable')) {
        $config.$name = Resolve-OperationsPath $config.$name
        Assert-OperationsPath -Path $config.$name -Directory:($name -ne 'nodeExecutable')
        Assert-OperationsAncestors $config.$name
    }
    $expectedScripts = Join-Path $config.releaseDirectory 'deploy\operations'
    if (-not $PSScriptRoot.Equals($expectedScripts, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Use the operations scripts from the configured immutable release.'
    }
    $directories = @($config.releaseDirectory, $config.dataDirectory, $config.stateDirectory)
    for ($left = 0; $left -lt $directories.Count; $left++) {
        for ($right = $left + 1; $right -lt $directories.Count; $right++) {
            if (Test-OperationsOverlap $directories[$left] $directories[$right]) { throw 'Release, data, and operations directories must be disjoint.' }
        }
        if (Test-OperationsOverlap $resolved $directories[$left]) { throw 'The private configuration must be outside release, data, and operations state directories.' }
    }
    foreach ($path in @($resolved, [System.IO.Path]::GetDirectoryName($resolved))) {
        Assert-OperationsAcl -Path $path -IdentitySid $identitySid -Private
    }
    Assert-OperationsAncestors $resolved
    foreach ($path in @($config.dataDirectory, $config.stateDirectory)) {
        Assert-OperationsAcl -Path $path -IdentitySid $identitySid -Private -RuntimeWrite
    }
    Assert-OperationsAcl -Path $config.releaseDirectory -IdentitySid $identitySid
    Assert-OperationsReleaseTree -Root $config.releaseDirectory -IdentitySid $identitySid
    Assert-OperationsAcl -Path $config.nodeExecutable -IdentitySid $identitySid
    Assert-OperationsAcl -Path ([System.IO.Path]::GetDirectoryName($config.nodeExecutable)) -IdentitySid $identitySid
    $scripts = @('windows-common.ps1', 'start-windows-task.ps1', 'windows-supervisor.mjs', 'windows-shutdown-bridge.mjs')
    foreach ($script in $scripts) {
        $path = Join-Path $config.releaseDirectory ('deploy\operations\' + $script)
        Assert-OperationsPath $path
        Assert-OperationsAcl -Path $path -IdentitySid $identitySid
    }
    foreach ($path in @((Join-Path $config.releaseDirectory 'deploy'), (Join-Path $config.releaseDirectory 'deploy\operations'))) {
        Assert-OperationsAcl -Path $path -IdentitySid $identitySid
    }
    $entry = if ($config.role -eq 'server') { 'apps\server\dist\main.js' } else { 'apps\worker\dist\worker.mjs' }
    $entryPath = Join-Path $config.releaseDirectory $entry
    Assert-OperationsPath $entryPath
    $cursor = $entryPath
    while (-not $cursor.Equals($config.releaseDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
        Assert-OperationsAcl -Path $cursor -IdentitySid $identitySid
        $cursor = [System.IO.Path]::GetDirectoryName($cursor)
    }
    foreach ($entry in $config.environment.PSObject.Properties) {
        if ($entry.Name -match '^INVESTIGATION_(?:(?:.*TOKEN|.*SECRET|.*PASSWORD|.*PASSPHRASE|WORKERS_JSON).*_PATH|TLS_KEY_PATH)$') {
            $path = Resolve-OperationsPath $entry.Value
            Assert-OperationsPath $path
            Assert-OperationsAcl -Path $path -IdentitySid $identitySid -Private
            Assert-OperationsAcl -Path ([System.IO.Path]::GetDirectoryName($path)) -IdentitySid $identitySid -Private
            Assert-OperationsAncestors $path
        }
    }
    return [pscustomobject]@{ Value = $config; ConfigPath = $resolved; IdentitySid = $identitySid }
}
