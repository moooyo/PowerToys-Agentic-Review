# Real Issue summary acceptance

This opt-in harness runs one ordinary Issue validation and a two-arm Evaluation through each
configured CLI. Each engine uses one Windows Worker instance, a new Linux SQLite database,
new synthetic credentials, and fresh disposable validation/model workspaces. Engines run
sequentially. The coordinator does not start unless passed `--allow-real-models`.

The input is public Issue [fishjar/kiss-translator#1064](https://github.com/fishjar/kiss-translator/issues/1064)
at commit `7dfc03ebc7f10530681109f6a5aec982a5573936` (v2.0.32). Every task performs the production
anonymous Git checkout and runs the unmodified 17-module timedtext-processing closure through
the retained Node probe. The probe hashes every source file before evaluation and collects
19 typed observations. A zero probe exit means successful collection, not absence of the defect.

The disclosed input is a manual screenshot transcription, not an original JSON attachment or
complete transcript. Japanese punctuation, omitted timing fields, and trailing spaces are
preserved. A separate punctuation-space sensitivity control is labelled in the probe output.
The frozen claim covers flattened timing and built-in Japanese rule segmentation. Installed
extension interaction, playback, AI segmentation, and translation behavior are outside scope.

## Current result paths

- The ordinary V1 result retains advice in `report.modelSummary`; `modelReview.not_requested`
  is the current representation for a successful optional summary, not proof of zero CLI calls.
- Both Evaluation V2 results retain the original `ValidationSummaryV1` model output,
  `CliModelExecutionV1`, and the `summaryInputRef` returned by the real lease-bound HTTP API.
  The Server preserves both canonical frozen input documents and verifies their prompt,
  context, output schema, task, attempt, and worker associations.
- All three runner reports must independently retain `confirmed`, original source state,
  a successful required measurement check, complete reproduction coverage, and the 19-field
  receipt. Model advice is reported separately and cannot overwrite runner facts.
- Source capture uses the completed ordinary review run. Explicit observation mappings carry
  the same measured claim into the two Evaluation arms. A published assessment and result
  projections are saved alongside the raw task results.

There is no GitHub publisher or polling service. The real public Issue identity, content,
author, and timestamps remain unchanged. The internal assignment, operator, profiles, prompts,
runs, worker credentials, and database are synthetic fixture data. No actual GitHub PR/Issue
write is enabled or authorized by this harness. CLI prompts explicitly prohibit commands,
network access, file changes, and GitHub writes during summarization.
The normal assignment ingestion retains an earlier unscheduled automatic Issue run because
that run has no operator-selected tested commit. It is not executed or deleted. The explicit
operator run supplies the fixed commit and frozen reproduction claim.

## Preparation and invocation

Freeze the source and install the project's public dependencies into an isolated Linux stage.
Run the following with the fixed Linux Node toolchain, using a new build-report directory:

```text
node deploy/worker/issue-summary-acceptance/prepare-server.mjs /var/tmp/new-summary-build-report
```

This builds the shared packages and Server, type-checks these exact harness sources, and emits
the Server without bundling. Keeping production modules in their normal `dist` directories
preserves the database-owner worker's module-relative entry point.

Create a configuration file with absolute paths. It contains only public tool locations;
new worker and control tokens are generated inside each new run directory.

```json
{
  "runDirectory": "D:\\AR\\new-issue-summary-run",
  "nodeExecutablePath": "C:\\public-tools\\node.exe",
  "trustedExecutableRoot": "D:\\AR\\tools",
  "gitExecutablePath": "D:\\AR\\tools\\Git\\cmd\\git.exe",
  "processHostPath": "D:\\AR\\tools\\AgenticReview.ProcessHost.exe",
  "wslDistribution": "Debian",
  "linuxNodeExecutablePath": "/var/tmp/public-node/bin/node",
  "linuxSourceDirectory": "/var/tmp/new-source-stage",
  "linuxRunParent": "/var/tmp/issue-summary-runs",
  "maximumRunMs": 900000,
  "engines": [
    { "engine": "codex", "cliExecutablePath": "C:\\configured-cli\\codex.exe" },
    { "engine": "copilot", "cliExecutablePath": "C:\\configured-cli\\copilot.exe" }
  ]
}
```

After an execution window is authorized and no other acceptance Worker/model is running:

```text
node deploy/worker/issue-summary-acceptance/run.mjs current-config.json --allow-real-models
```

The Windows coordinator bundles the production runtime separately from the harness. It passes
`createExecutionRuntime` into the harness without activating production main's executable
entry point. The normal startup verifies public tool hashes, selects the installed CLI,
prepares headless validation, and constructs `ValidationSummaryExecutor`. Only this run's
Worker environment variables are temporarily replaced; the CLI uses its configured account.
No old private acceptance configuration or credentials are read.

Each engine gets a distinct new probe package, Worker data directory, Linux database directory,
token, and localhost Server. The Linux Server directory is created exclusively with mode 0700
and the database with mode 0600. Its random control token is kept in the current input file,
never in `ready.json`, `server-owner.json`, or ordinary logs. The early ownership file records
the current nonce, PID, Linux process start time, executable, and input path. If readiness or
normal closure fails, the coordinator verifies these values before signalling that owned
process. The Server retains an independent lifetime deadline
even after workflow completion. The coordinator stops the Worker before asking the Server to
revoke the fixture credential and close its owner. Worker drain, native-process settlement,
and final Host closure attempts all have explicit bounds.

## Retained evidence

The coordinator writes build input hashes, copied probe hashes, installed CLI versions, every
actual envelope/result, three native model process completions, three probe completions,
terminal acknowledgements, two logical frozen-input requests, source-state assertions,
workspace cleanup, host closure, Server status, and process exit. The Linux directory retains
the database, configuration, original results, frozen summary-input rows, projections,
Evaluation matrix/score/assessment, and closure report. No database or result is deleted.
CLI diagnostics additionally retain the actual arguments and output schema, prompt digest,
complete stream byte counts and hashes, and bounded credential-redacted stdout/stderr text.
The diagnostic tap passes the original bytes to the production consumer unchanged. It does
not retain raw credentials or claim that its bounded text is a complete raw stream.

`complete.json` is created only after every selected engine passes all three tasks and both
sides close successfully. Its engine list states the actual scope; a one-engine rerun does
not imply acceptance of the other engine. Earlier failed directories are retained unchanged.

The public probe and data originate from `artifacts/m33-real-issue-20260909/probe` and
`public-source`. Before authoring this harness, all 17 fixed Git blobs were retrieved again
and independently checked against the frozen tree and SHA-256 manifest. The new preparation
receipt is `artifacts/m40-ci-product-20260910/issue-summary-source-review1/receipt-final.json`.
Previous measured results are not loaded as acceptance outputs.
