#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$LauncherPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'start-worker.ps1'),
    [string]$NodeExecutable = 'node'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    [System.IO.Path]::GetFullPath($LauncherPath), [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) { throw 'The Worker launcher must parse without errors.' }

# Load only pure configuration, PATH and resolution helpers; never execute launcher preflight or Worker.
foreach ($name in @('Assert-Config', 'Resolve-WorkerNodeApplication', 'Get-WorkerProcessPath')) {
    $functions = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $false))
    if ($functions.Count -ne 1) { throw "Expected one launcher helper named $name." }
    . ([scriptblock]::Create($functions[0].Extent.Text))
}

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ($Actual -cne $Expected) { throw $Message }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$ExpectedMessage)
    $caughtMessage = $null
    try { & $Action } catch { $caughtMessage = $_.Exception.Message }
    if ($caughtMessage -cne $ExpectedMessage) {
        throw "Expected configuration rejection: $ExpectedMessage"
    }
}

$minimalExecutionConfig = @{
    WORKER_SERVER_URL = 'https://review.example.invalid'
    WORKER_EXECUTION_ENABLED = 'true'
    WORKER_TRUSTED_EXECUTABLE_ROOT = 'D:\Trusted'
    WORKER_PROCESS_HOST_PATH = 'D:\Trusted\AgenticReview.ProcessHost.exe'
    WORKER_GIT_EXECUTABLE_PATH = 'D:\Trusted\git.exe'
    WORKER_WORKSPACE_ROOT_DIRECTORY = 'D:\Worker\Workspaces'
    WORKER_EXECUTION_TEMP_DIRECTORY = 'D:\Worker\Temp'
    WORKER_PROCESS_HOST_SHA256 = 'a' * 64
    WORKER_GIT_SHA256 = 'b' * 64
    WORKER_CLI_ENGINE = 'codex'
    WORKER_CLI_EXECUTABLE_PATH = 'C:\Users\Worker\AppData\Local\Microsoft\WinGet\Links\codex.exe'
}

# No CLI version, digest, home, provider configuration, or authentication file is needed by preflight.
foreach ($engine in @('codex', 'copilot')) {
    $cliConfig = $minimalExecutionConfig.Clone()
    $cliConfig['WORKER_CLI_ENGINE'] = $engine
    Assert-Config -Config $cliConfig
}

$modelFreeConfig = $minimalExecutionConfig.Clone()
$modelFreeConfig['WORKER_MODEL_EXECUTION_ENABLED'] = 'false'
$modelFreeConfig.Remove('WORKER_CLI_ENGINE')
$modelFreeConfig.Remove('WORKER_CLI_EXECUTABLE_PATH')
Assert-Config -Config $modelFreeConfig
Assert-Config -Config @{ WORKER_SERVER_URL = 'https://review.example.invalid' }

foreach ($requiredName in @('WORKER_CLI_ENGINE', 'WORKER_CLI_EXECUTABLE_PATH')) {
    $missingCliConfig = $minimalExecutionConfig.Clone()
    $missingCliConfig.Remove($requiredName)
    Assert-Throws -Action { Assert-Config -Config $missingCliConfig } `
        -ExpectedMessage "$requiredName is required when model execution is enabled."
}

$invalidEngineConfig = $minimalExecutionConfig.Clone()
$invalidEngineConfig['WORKER_CLI_ENGINE'] = 'unsupported'
Assert-Throws -Action { Assert-Config -Config $invalidEngineConfig } `
    -ExpectedMessage 'WORKER_CLI_ENGINE must be codex or copilot.'

$missingHostPinConfig = $minimalExecutionConfig.Clone()
$missingHostPinConfig.Remove('WORKER_PROCESS_HOST_SHA256')
Assert-Throws -Action { Assert-Config -Config $missingHostPinConfig } `
    -ExpectedMessage 'WORKER_PROCESS_HOST_SHA256 is required when WORKER_EXECUTION_ENABLED=true.'

$originalPath = $env:PATH
$normalized = Get-WorkerProcessPath -NodeDirectory 'C:\Selected Node' -InheritedPath ' ; C:\Windows\System32 ;c:\selected node;C:\Tools;C:\WINDOWS\SYSTEM32;; '
Assert-Equal $normalized 'C:\Selected Node;C:\Windows\System32;C:\Tools' 'Node must lead PATH and case-insensitive duplicates and blank entries must be removed in order.'

$unsafe = Get-WorkerProcessPath -NodeDirectory 'C:\Selected Node' -InheritedPath 'relative-tools;C:drive-relative;C:\Tools\..\Other;\\server\share'
Assert-Equal $unsafe 'C:\Selected Node;relative-tools;C:drive-relative;C:\Tools\..\Other;\\server\share' 'Unsafe entries must remain visible to runtime validation instead of being silently resolved or dropped.'

$empty = Get-WorkerProcessPath -NodeDirectory 'C:\Selected Node' -InheritedPath $null
Assert-Equal $empty 'C:\Selected Node' 'An empty inherited PATH must retain the selected Node directory.'
Assert-Equal $env:PATH $originalPath 'The PATH helper must not modify the test process environment.'

$expectedNode = (Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
$resolvedNode = Resolve-WorkerNodeApplication -Executable $NodeExecutable
Assert-Equal $resolvedNode ([System.IO.Path]::GetFullPath($expectedNode)) 'Node must resolve to its actual application path without running it.'

$rejected = $false
try {
    Resolve-WorkerNodeApplication -Executable 'Get-Item' | Out-Null
} catch {
    $rejected = $_.Exception.Message -eq 'NodeExecutable must resolve to a single application.'
}
if (-not $rejected) { throw 'NodeExecutable must reject non-application commands.' }

Write-Host 'All Worker launcher regression checks passed; no Worker process was started.'
