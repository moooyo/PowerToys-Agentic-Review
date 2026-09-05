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

# Load only the pure PATH and command-resolution helpers; never execute launcher preflight or Worker.
foreach ($name in @('Resolve-WorkerNodeApplication', 'Get-WorkerProcessPath')) {
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

$originalPath = $env:PATH
$normalized = Get-WorkerProcessPath -NodeDirectory 'C:\Selected Node' -InheritedPath ' ; C:\Windows\System32 ;c:\selected node;C:\Tools;C:\WINDOWS\SYSTEM32;; '
Assert-Equal $normalized 'C:\Selected Node;C:\Windows\System32;C:\Tools' 'Node must lead PATH and case-insensitive duplicates and blank entries must be removed in order.'

$unsafe = Get-WorkerProcessPath -NodeDirectory 'C:\Selected Node' -InheritedPath 'relative-tools;C:drive-relative;C:\Tools\..\Other;\\server\share'
Assert-Equal $unsafe 'C:\Selected Node;relative-tools;C:drive-relative;C:\Tools\..\Other;\\server\share' 'Unsafe entries must remain visible to runtime validation instead of being silently resolved or dropped.'

$empty = Get-WorkerProcessPath -NodeDirectory 'C:\Selected Node' -InheritedPath $null
Assert-Equal $empty 'C:\Selected Node' 'An empty inherited PATH must retain the selected Node directory.'
Assert-Equal $env:PATH $originalPath 'The PATH helper must not modify the test process environment.'

$expectedNode = (Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop).Path
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
