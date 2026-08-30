#Requires -Version 7.4
#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string] $PackageDirectory,

    [Parameter(Mandatory)]
    [uri] $ServerUrl,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string] $WorkerNodeId,

    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $ClientCertificatePath,

    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $ClientPrivateKeyPath,

    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $CaCertificatePath,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string] $ServiceName = 'AgenticReview.Worker',

    [string] $WorkerDisplayName = $WorkerNodeId,

    [ValidateRange(1, 64)]
    [int] $MaxSlots = 1,

    [ValidatePattern('^[0-9A-Za-z.+_-]{1,128}$')]
    [string] $WorkerVersion = '0.1.0',

    [ValidatePattern('^[0-9A-Za-z.+_-]{1,128}$')]
    [string] $CodexVersion = 'not-configured',

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string[]] $RecipeIds = @(),

    [string] $LabelsJson = '{}',

    [string] $InstallDirectory = 'C:\Program Files\AgenticReview\Worker',

    [string] $DataDirectory = 'C:\ProgramData\AgenticReview\Worker',

    [switch] $EnableExecution,

    [switch] $StartService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Resolve-AbsolutePath {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Name
    )

    if (-not [System.IO.Path]::IsPathFullyQualified($Path)) {
        throw "$Name must be an absolute path."
    }

    return [System.IO.Path]::GetFullPath($Path)
}

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Name
    )

    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$Name must identify a file: $resolved"
    }
    return $resolved
}

function Assert-SafeNewDirectory {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Name
    )

    $pathRoot = [System.IO.Path]::GetPathRoot($Path)
    if ($Path.TrimEnd('\') -eq $pathRoot.TrimEnd('\')) {
        throw "$Name must not be a filesystem root: $Path"
    }
    if (Test-Path -LiteralPath $Path) {
        $existingFiles = Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop | Select-Object -First 1
        if ($null -ne $existingFiles) {
            throw "$Name must be empty for a new installation: $Path"
        }
    }
}

function Test-PathIsWithin {
    param(
        [Parameter(Mandatory)]
        [string] $Candidate,

        [Parameter(Mandatory)]
        [string] $Parent
    )

    $normalizedCandidate = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    $normalizedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    return $normalizedCandidate.StartsWith($normalizedParent, [System.StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-XmlAttributeValue {
    param([AllowEmptyString()][string] $Value)

    $escaped = [System.Security.SecurityElement]::Escape($Value)
    if ($null -eq $escaped) {
        return ''
    }
    return $escaped
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)]
        [string] $FilePath,

        [Parameter(Mandatory)]
        [string[]] $ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Native command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

function Set-RestrictedDirectoryAcl {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $ServiceAccount,

        [Parameter(Mandatory)]
        [ValidateSet('R', 'RX', 'M')]
        [string] $ServicePermission
    )

    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    Invoke-NativeCommand -FilePath $icacls -ArgumentList @(
        $Path,
        '/inheritance:r',
        '/grant:r',
        'SYSTEM:(OI)(CI)(F)',
        'BUILTIN\Administrators:(OI)(CI)(F)',
        "${ServiceAccount}:(OI)(CI)($ServicePermission)"
    )
}

if ($ServerUrl.Scheme -ne 'https') {
    throw 'ServerUrl must use HTTPS.'
}
if ($EnableExecution) {
    throw 'This release contains only the Worker control-plane skeleton; execution cannot be enabled yet.'
}
if (-not [string]::IsNullOrEmpty($ServerUrl.UserInfo)) {
    throw 'ServerUrl must not contain embedded credentials.'
}
if (-not [string]::IsNullOrEmpty($ServerUrl.Query) -or -not [string]::IsNullOrEmpty($ServerUrl.Fragment)) {
    throw 'ServerUrl must not contain a query or fragment.'
}
if ($ServerUrl.AbsolutePath -ne '/') {
    throw 'ServerUrl must be an origin without a path.'
}

try {
    $labels = $LabelsJson | ConvertFrom-Json -AsHashtable -NoEnumerate
} catch {
    throw 'LabelsJson must be a valid JSON object.'
}
if ($labels -isnot [System.Collections.IDictionary]) {
    throw 'LabelsJson must be a JSON object.'
}
foreach ($entry in $labels.GetEnumerator()) {
    if ($entry.Key -isnot [string] -or $entry.Value -isnot [string]) {
        throw 'LabelsJson keys and values must be strings.'
    }
}

$packageRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path
$installRoot = Resolve-AbsolutePath -Path $InstallDirectory -Name 'InstallDirectory'
$dataRoot = Resolve-AbsolutePath -Path $DataDirectory -Name 'DataDirectory'
if ($installRoot.TrimEnd('\') -eq $dataRoot.TrimEnd('\')) {
    throw 'InstallDirectory and DataDirectory must be different directories.'
}
if ((Test-PathIsWithin -Candidate $installRoot -Parent $dataRoot) -or
    (Test-PathIsWithin -Candidate $dataRoot -Parent $installRoot)) {
    throw 'InstallDirectory and DataDirectory must not contain one another.'
}
if ((Test-PathIsWithin -Candidate $installRoot -Parent $packageRoot) -or
    (Test-PathIsWithin -Candidate $packageRoot -Parent $installRoot) -or
    (Test-PathIsWithin -Candidate $dataRoot -Parent $packageRoot) -or
    (Test-PathIsWithin -Candidate $packageRoot -Parent $dataRoot)) {
    throw 'PackageDirectory must be separate from InstallDirectory and DataDirectory.'
}
Assert-SafeNewDirectory -Path $installRoot -Name 'InstallDirectory'
Assert-SafeNewDirectory -Path $dataRoot -Name 'DataDirectory'
$certificateSource = Resolve-ExistingFile -Path $ClientCertificatePath -Name 'ClientCertificatePath'
$privateKeySource = Resolve-ExistingFile -Path $ClientPrivateKeyPath -Name 'ClientPrivateKeyPath'
$caCertificateSource = Resolve-ExistingFile -Path $CaCertificatePath -Name 'CaCertificatePath'

$nodeSource = Resolve-ExistingFile -Path (Join-Path $packageRoot 'runtime\node.exe') -Name 'packaged Node.js runtime'
$entrypointSource = Resolve-ExistingFile -Path (Join-Path $packageRoot 'app\dist\worker.mjs') -Name 'Worker entrypoint'
$winSwSource = Resolve-ExistingFile -Path (Join-Path $packageRoot 'winsw\AgenticReview.Worker.exe') -Name 'WinSW executable'
$templateSource = Resolve-ExistingFile -Path (Join-Path $packageRoot 'winsw\worker-service.xml.template') -Name 'WinSW XML template'
$processHostSourcePath = Join-Path $packageRoot 'native\AgenticReview.ProcessHost.exe'
if ($EnableExecution -and -not (Test-Path -LiteralPath $processHostSourcePath -PathType Leaf)) {
    throw 'EnableExecution requires native\AgenticReview.ProcessHost.exe in the package.'
}

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $existingService) {
    throw "Service $ServiceName already exists. Use the upgrade workflow instead of the installer."
}
if (-not $PSCmdlet.ShouldProcess($env:COMPUTERNAME, "Install Windows service $ServiceName")) {
    return
}

$applicationDestination = Join-Path $installRoot 'app'
$runtimeDestination = Join-Path $installRoot 'runtime'
$nativeDestination = Join-Path $installRoot 'native'
$secretDestination = Join-Path $dataRoot 'secrets'
$logDestination = Join-Path $dataRoot 'logs'
$jobDestination = Join-Path $dataRoot 'jobs'
$wrapperDestination = Join-Path $installRoot "$ServiceName.exe"
$xmlDestination = Join-Path $installRoot "$ServiceName.xml"
$nodeDestination = Join-Path $runtimeDestination 'node.exe'
$entrypointDestination = Join-Path $applicationDestination 'dist\worker.mjs'
$processHostDestination = Join-Path $nativeDestination 'AgenticReview.ProcessHost.exe'
$certificateDestination = Join-Path $secretDestination 'client-cert.pem'
$privateKeyDestination = Join-Path $secretDestination 'client-key.pem'
$caCertificateDestination = Join-Path $secretDestination 'ca-cert.pem'
$serviceAccount = "NT SERVICE\$ServiceName"

New-Item -ItemType Directory -Path $installRoot, $applicationDestination, $runtimeDestination, $nativeDestination -Force | Out-Null
New-Item -ItemType Directory -Path $dataRoot, $secretDestination, $logDestination, $jobDestination -Force | Out-Null

# Protect the private-key destination before any secret bytes are copied. The
# virtual service account is granted read access only after the service exists.
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
Invoke-NativeCommand -FilePath $icacls -ArgumentList @(
    $secretDestination,
    '/inheritance:r',
    '/grant:r',
    'SYSTEM:(OI)(CI)(F)',
    'BUILTIN\Administrators:(OI)(CI)(F)'
)

Copy-Item -LiteralPath (Split-Path -Parent $entrypointSource) -Destination $applicationDestination -Recurse
Copy-Item -LiteralPath $nodeSource -Destination $nodeDestination
Copy-Item -LiteralPath $winSwSource -Destination $wrapperDestination
Copy-Item -LiteralPath $certificateSource -Destination $certificateDestination
Copy-Item -LiteralPath $privateKeySource -Destination $privateKeyDestination
Copy-Item -LiteralPath $caCertificateSource -Destination $caCertificateDestination
if ($EnableExecution) {
    Copy-Item -LiteralPath $processHostSourcePath -Destination $processHostDestination
}

$replacementValues = @{
    '{{SERVICE_NAME}}' = $ServiceName
    '{{WORKER_NODE_ID}}' = $WorkerNodeId
    '{{WORKER_DISPLAY_NAME}}' = $WorkerDisplayName
    '{{WORKER_VERSION}}' = $WorkerVersion
    '{{SERVER_URL}}' = $ServerUrl.AbsoluteUri.TrimEnd('/')
    '{{MAX_SLOTS}}' = $MaxSlots.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    '{{INSTALL_DIRECTORY}}' = $installRoot
    '{{DATA_DIRECTORY}}' = $dataRoot
    '{{LOG_DIRECTORY}}' = $logDestination
    '{{NODE_EXECUTABLE}}' = $nodeDestination
    '{{WORKER_ENTRYPOINT}}' = $entrypointDestination
    '{{EXECUTION_ENABLED}}' = $(if ($EnableExecution) { 'true' } else { 'false' })
    '{{PROCESS_HOST_PATH}}' = $(if ($EnableExecution) { $processHostDestination } else { '' })
    '{{CODEX_VERSION}}' = $CodexVersion
    '{{RECIPE_IDS}}' = ($RecipeIds -join ',')
    '{{LABELS_JSON}}' = ($labels | ConvertTo-Json -Compress)
    '{{TLS_CA_PATH}}' = $caCertificateDestination
    '{{TLS_CERT_PATH}}' = $certificateDestination
    '{{TLS_KEY_PATH}}' = $privateKeyDestination
}

$renderedXml = Get-Content -Raw -LiteralPath $templateSource
foreach ($entry in $replacementValues.GetEnumerator()) {
    $renderedXml = $renderedXml.Replace($entry.Key, (ConvertTo-XmlAttributeValue -Value ([string] $entry.Value)))
}
if ($renderedXml.Contains('{{')) {
    throw 'The rendered WinSW configuration contains unresolved placeholders.'
}
$null = [xml] $renderedXml
Set-Content -LiteralPath $xmlDestination -Value $renderedXml -Encoding utf8 -NoNewline

$serviceInstalled = $false
try {
    Push-Location -LiteralPath $installRoot
    try {
        Invoke-NativeCommand -FilePath $wrapperDestination -ArgumentList @('install')
        $serviceInstalled = $true
    } finally {
        Pop-Location
    }

    $serviceController = Join-Path $env:SystemRoot 'System32\sc.exe'
    Invoke-NativeCommand -FilePath $serviceController -ArgumentList @(
        'config', $ServiceName, 'obj=', $serviceAccount, 'password=', ''
    )
    Invoke-NativeCommand -FilePath $serviceController -ArgumentList @('config', $ServiceName, 'start=', 'delayed-auto')
    Invoke-NativeCommand -FilePath $serviceController -ArgumentList @('sidtype', $ServiceName, 'unrestricted')
    Invoke-NativeCommand -FilePath $serviceController -ArgumentList @('failureflag', $ServiceName, '1')

    Set-RestrictedDirectoryAcl -Path $installRoot -ServiceAccount $serviceAccount -ServicePermission 'RX'
    Set-RestrictedDirectoryAcl -Path $dataRoot -ServiceAccount $serviceAccount -ServicePermission 'M'
    Set-RestrictedDirectoryAcl -Path $secretDestination -ServiceAccount $serviceAccount -ServicePermission 'R'

    if ($StartService) {
        Start-Service -Name $ServiceName
    }
} catch {
    if ($serviceInstalled) {
        try {
            Invoke-NativeCommand -FilePath $wrapperDestination -ArgumentList @('uninstall')
        } catch {
            Write-Warning "Automatic service rollback failed. Inspect service $ServiceName before retrying."
        }
    }
    foreach ($secretPath in @($privateKeyDestination, $certificateDestination, $caCertificateDestination)) {
        if (Test-Path -LiteralPath $secretPath -PathType Leaf) {
            Remove-Item -LiteralPath $secretPath -Force
        }
    }
    throw
}

Write-Output "Installed $ServiceName for worker node $WorkerNodeId."
Write-Output "Service account: $serviceAccount"
Write-Output "Execution enabled: $($EnableExecution.IsPresent)"
