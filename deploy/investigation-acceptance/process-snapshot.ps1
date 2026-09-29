param(
    [int]$RootProcessId = 0,
    [string]$IdentityPath = ''
)
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process)
$selected = @()
if ($IdentityPath) {
    $identities = Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json
    foreach ($identity in $identities) {
        $selected += @($all | Where-Object {
            $_.ProcessId -eq $identity.processId -and
            $_.CreationDate.ToUniversalTime().ToString('o') -eq $identity.createdAt
        })
    }
} else {
    if ($RootProcessId -le 0) { throw 'A positive owned root process ID is required.' }
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    $createdAt = @{}
    foreach ($root in @($all | Where-Object { $_.ProcessId -eq $RootProcessId })) {
        [void]$ids.Add($RootProcessId)
        $createdAt[$RootProcessId] = $root.CreationDate.ToUniversalTime()
    }
    do {
        $added = $false
        foreach ($entry in $all) {
            if ($ids.Contains([int]$entry.ParentProcessId) -and
                $entry.CreationDate.ToUniversalTime() -ge $createdAt[[int]$entry.ParentProcessId] -and
                $ids.Add([int]$entry.ProcessId)) {
                $createdAt[[int]$entry.ProcessId] = $entry.CreationDate.ToUniversalTime()
                $added = $true
            }
        }
    } while ($added)
    $selected = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })
}
$result = @($selected | ForEach-Object {
    [ordered]@{
        processId = [int]$_.ProcessId
        parentProcessId = [int]$_.ParentProcessId
        createdAt = $_.CreationDate.ToUniversalTime().ToString('o')
        executablePath = $_.ExecutablePath
    }
})
ConvertTo-Json -InputObject $result -Depth 4 -Compress
