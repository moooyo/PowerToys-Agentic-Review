[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')]
    [string]$WorkerNodeId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$WorkerIdentity
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Icacls {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    & icacls.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function Set-PrivateDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    Invoke-Icacls -Arguments @($Path, '/reset') `
        -FailureMessage 'Unable to reset the Worker authentication directory ACL.'
    Invoke-Icacls -Arguments @(
        $Path,
        '/inheritance:r',
        '/grant:r',
        "${WorkerIdentity}:(OI)(CI)F",
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F'
    ) -FailureMessage 'Unable to apply the private Worker authentication directory ACL.'
}

function Set-PrivateFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    Invoke-Icacls -Arguments @($Path, '/reset') `
        -FailureMessage 'Unable to reset the Worker authentication file ACL.'
    Invoke-Icacls -Arguments @(
        $Path,
        '/inheritance:r',
        '/grant:r',
        "${WorkerIdentity}:F",
        '*S-1-5-18:F',
        '*S-1-5-32-544:F'
    ) -FailureMessage 'Unable to apply the private Worker authentication file ACL.'
}

$authDirectory = 'C:\ProgramData\AgenticReview\Worker'
$authPath = Join-Path $authDirectory 'worker-auth-v1.json'
$secureToken = Read-Host 'Worker Token returned by the Server operator API' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
    $workerToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    if ($workerToken -notmatch '^arw1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$') {
        throw 'The Worker Token does not match the agentic-review-worker-auth-v1 profile.'
    }

    $authProfile = [ordered]@{
        profileId = 'agentic-review-worker-auth-v1'
        token = $workerToken
        workerNodeId = $WorkerNodeId
    } | ConvertTo-Json -Compress

    New-Item -ItemType Directory -Force -Path $authDirectory | Out-Null
    Set-PrivateDirectoryAcl -Path $authDirectory
    if (Test-Path -LiteralPath $authPath -PathType Leaf) {
        Set-PrivateFileAcl -Path $authPath
    }

    [System.IO.File]::WriteAllText(
        $authPath,
        $authProfile,
        [System.Text.UTF8Encoding]::new($false)
    )
    Set-PrivateFileAcl -Path $authPath
}
finally {
    if ($tokenPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
    $workerToken = $null
    $authProfile = $null
    $secureToken.Dispose()
}

Write-Host "Provisioned the Worker authentication profile at $authPath."
