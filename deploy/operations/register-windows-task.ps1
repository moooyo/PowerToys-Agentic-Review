[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter()][System.Management.Automation.PSCredential]$Credential
)

. (Join-Path $PSScriptRoot 'windows-common.ps1')
$loaded = Get-OperationsConfiguration $ConfigPath
$config = $loaded.Value
$taskPath = '\AgenticReview\'
if ($null -ne (Get-ScheduledTask -TaskPath $taskPath -TaskName $config.taskName -ErrorAction SilentlyContinue)) {
    throw 'The scheduled task already exists. Review and remove or replace it explicitly; this installer never overwrites it.'
}
$scriptPath = Join-Path $config.releaseDirectory 'deploy\operations\start-windows-task.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "{0}" -ConfigPath "{1}"' -f $scriptPath, $loaded.ConfigPath
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $config.releaseDirectory
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
# Task Scheduler must not force-kill a Worker or independently reset its restart budget.
$settings.AllowHardTerminate = $false
$settings.RestartCount = 0

if ($config.role -eq 'worker') {
    if ($null -ne $Credential) { throw 'Interactive Worker registration does not accept a password.' }
    $principal = New-ScheduledTaskPrincipal -UserId $config.identity -LogonType Interactive -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $config.identity
} else {
    if ($null -eq $Credential -or (Get-OperationsIdentitySid $Credential.UserName) -ne $loaded.IdentitySid) {
        throw 'Server registration requires a PSCredential for the configured Windows identity.'
    }
    $principal = New-ScheduledTaskPrincipal -UserId $config.identity -LogonType Password -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtStartup
}
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Agentic Review production supervisor; stop cooperatively with stop-windows-task.ps1.'
if ($config.role -eq 'server') {
    # The password is supplied to the Windows scheduler API, never a command line or file.
    $password = $Credential.GetNetworkCredential().Password
    try {
        Register-ScheduledTask -TaskName $config.taskName -TaskPath $taskPath -InputObject $task -User $config.identity -Password $password -ErrorAction Stop | Out-Null
    } catch {
        throw 'Server task registration failed. Review the account rights and Windows Task Scheduler event log.'
    } finally { $password = $null }
} else {
    Register-ScheduledTask -TaskName $config.taskName -TaskPath $taskPath -InputObject $task -ErrorAction Stop | Out-Null
}
Write-Output 'Scheduled task registered without starting it. Review its action, identity, trigger, and settings before deployment.'
