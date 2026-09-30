/** Shared native-tool instructions for an owned Windows verification session. */
export function createE2eToolGuidance(directory: string): string {
  const quotedDirectory = directory.replaceAll("'", "''");
  return `The orchestrator holds the exclusive desktop lease. Use your shell only to inspect
the pinned source and call the Worker endpoint. All builds, repository tests, application
launches, desktop actions and media capture MUST use the endpoint, which owns their
processes and records authoritative observations. Do not detach a process.

Tool transport (PowerShell; never print transport.json or its private capability):
$transportPath = Join-Path -Path '${quotedDirectory}' -ChildPath 'transport.json'
$transport = Get-Content -LiteralPath $transportPath -Raw | ConvertFrom-Json
$responsePath = Join-Path -Path '${quotedDirectory}' -ChildPath ('tool-response-' + [Guid]::NewGuid().ToString('N') + '.json')
Write-Output "Worker response file: $responsePath"
$reply = Invoke-RestMethod -Method Post -Uri $transport.endpoint -Headers @{Authorization=('Bearer ' + $transport.capability)} -ContentType 'application/json' -Body ($request | ConvertTo-Json -Depth 30)
$reply | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $responsePath -Encoding utf8
Get-Content -LiteralPath $responsePath -Raw
Run the entire transport sequence in one foreground invocation for each request. Read
the exact endpoint and capability from this session's file; do not reconstruct them.
Retain the response path and any session handle returned by a yielded shell. Wait on
that same handle using the longest interval the tool explicitly supports (write_stdin
permits yield_time_ms:300000). Do not repeat short progress polls or reread completed
receipts. A yielded shell still owns the original call. Never reissue a build or another
operation because its response has not appeared. Recover its response file once if
the completed output is missing; if recovery fails, report the blocker.

Inspect the actual projects, solution dependencies and output layout before building.
Use the existing pinned product and repository tests; no temporary project, invented
executable, synthetic product replacement, or copied preinstalled binary may establish
verification. The Worker creates a fresh build output and owns compiler arguments.
{"operation":"build","request":{"tool":"msbuild","projectPath":"relative/Product.csproj","configuration":"Debug","platform":"x64","outputs":["Product.exe"]}}
tool selects a deployment-pinned msbuild or dotnet. For a solution's declared module
dependencies and output layout, use the actual pinned .slnx and select its project:
{"operation":"build","request":{"tool":"msbuild","projectPath":"Product.slnx","solutionProject":"src/Product/Product.csproj","repositoryOutputDirectory":"x64/Debug","configuration":"Debug","platform":"x64","outputs":["Product.exe","Modules/Module.dll"]}}
No arbitrary compiler properties, response files, custom targets or build scripts are
accepted. Read the source to choose real paths. Missing tools or dependencies are blocked
prerequisites. After a failed build, inspect its errorCode and bounded diagnostics. Make
at most one focused diagnostic call when an available remedy is concrete; otherwise stop.
Never repeatedly retry an unchanged failed prerequisite.

{"operation":"command","script":"PowerShell diagnostic code","timeoutMs":60000}
This is exploratory only: a command receipt is never a verified build or passing check.
{"operation":"launch","buildRef":"build receipt id","outputPath":"Product.exe","arguments":[]}
The build response's observed.artifacts lists verified outputPath values. Launch verifies
their hashes, returns observed.processRef, and owns the application process tree.
{"operation":"enumerate"}
{"operation":"inspect","processRef":"application processRef","maxDepth":6,"maxNodes":200}
Use inspect to identify real result controls, never a placeholder or design-time label.
When one PID owns multiple windows, select its decimal windowHandle from enumerate:
{"operation":"inspect","processRef":"application processRef","target":{"windowHandle":"123456"},"maxDepth":6,"maxNodes":200}

Register immutable feature assertions before their interactions. Replace illustrative
IDs, source paths, selectors and expected values with the saved check's actual behavior.
{"operation":"register-feature","feature":{"id":"saved-check-id","title":"Expected result","paths":["src/actual/file.cs"],"scenario":"Describe concrete inputs and their expected result.","userVisible":true,"assertions":[{"id":"result","kind":"ui","description":"The actual result has the expected value.","selector":{"automationId":"Result"},"assertion":{"property":"text","expected":"source-derived result","match":"contains"}}]}}
Every feature path must identify a real file in this pinned source. User-visible checks
require actual UI assertions, never a process exit code. UI properties are exists, text,
value, enabled, offscreen, focused and toggleState. Boolean properties require boolean
expected values. text/value require strings; toggleState uses on/off/indeterminate.
Selector name and automationId match exact case-sensitive values, not patterns. Each
selector needs a name or automationId. Do not weaken or replace a registered expectation.
{"operation":"click","featureId":"saved-check-id","processRef":"application processRef","target":{"selector":{"automationId":"Input"}}}
{"operation":"click","featureId":"saved-check-id","processRef":"application processRef","coordinates":{"x":100,"y":100}}
{"operation":"type","featureId":"saved-check-id","processRef":"application processRef","text":"concrete input"}
{"operation":"keys","featureId":"saved-check-id","processRef":"application processRef","keys":["ENTER"]}
keys requires an already visible owned window; it cannot activate a tray application.
Inspect and dismiss an owned initialization dialog first. For a documented global launch
shortcut use command, then enumerate and require a visible owned window. PowerToys Run's
Alt+Space can use Add-Type -AssemblyName System.Windows.Forms followed by
[System.Windows.Forms.SendKeys]::SendWait('% '). That command is only setup evidence.
{"operation":"assert","featureId":"saved-check-id","assertionId":"result","processRef":"application processRef"}
The Worker supplies the registered selector and expectation; supply no replacements.
An absence assertion is {"property":"exists","expected":false}. Before absence,
execute a positive control proving that the same feature is enabled in the same launch
or query mode. A disabled or uninvoked feature's absence cannot prove correct behavior.

For a non-visual check covered by an existing repository test, register userVisible:false
and a process assertion: {id,kind:"process",description,outputPath,arguments,
expectedExitCode,expectedOutputContains}. The outputPath must be in the successful build.
For a built .NET test assembly set host:"dotnet-vstest" and require output identifying the
specific executed test, so an empty or skipped suite cannot pass.
{"operation":"run-check","featureId":"saved-check-id","assertionId":"existing-test","buildRef":"build receipt id"}

{"operation":"screenshot","featureId":"saved-check-id","processRef":"application processRef"}
Capture each successful assertion's own state, including positive controls and absence
checks. A screenshot must follow successful assertions in the same application and
unchanged interaction state. One screenshot cannot prove a different feature's check.
Every passed UI feature requires matching runtime media. A headless non-visual check
needs real existing-test assertions and retained output, and does not need a screenshot.
{"operation":"video-start","featureId":"saved-check-id","processRef":"application processRef","durationSeconds":30}
{"operation":"video-stop","processRef":"video processRef"}
Recording needs an active owned application window. Exercise successful assertions
during the recording. Stop video cleanly; if recording is unavailable, retain that
limitation and use screenshots without rerunning successful checks solely for video.
{"operation":"stop","processRef":"application processRef"}
{"operation":"desktop-status"}
Stop owned applications after checking. The Worker confirms final process and desktop cleanup.
Responses include id/status/observed/artifactRefs and feature/build/process bindings.
Return their real IDs in assertionReceiptIds and mediaReceiptIds. The run-recipe or
command receipt itself is not an assertion. Missing observations must remain blocked.`;
}
