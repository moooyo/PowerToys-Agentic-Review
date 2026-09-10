# CLI workflow acceptance

This acceptance run exercises a Windows Worker against a Server in WSL, using an owned Git fixture
and the installed Codex and GitHub Copilot CLIs. Each engine executes one ordinary pull-request
review and the baseline and candidate cells of one Evaluation: three tasks per engine, six tasks
in total. A CLI task can make multiple model requests; the task count is not a model-request count.

The harness is a composition of production components, not a complete deployment through Worker
`main.ts`. Its Git transport substitution routes the fixture fetch to the owned local repository.
The Worker task lifecycle, ProcessHost, CLI execution, result submission, and Server processing use
the production implementations. The run must not be reported as full deployment acceptance.

This is a real-model run and requires an explicit opt-in. It can consume the selected CLI account's
quota or incur usage charges. Synthetic CLI responses are not a substitute for this acceptance
scope. No passing result is assumed before the retained run artifacts have been inspected.

## Prerequisites

- Windows with Node.js 24.20.x, Git for Windows, and a built Windows ProcessHost executable.
- A WSL Linux distribution with Node.js 24.20.x and the dependencies required to bundle and run
  the Server harness. Node's SQLite support is required.
- The same source revision available to both sides. The Windows coordinator bundles the Worker
  entry; preparation emits the Linux Server entry and builds its Server/shared-package dependencies.
- A Server listener reachable from the Windows Worker through the local Windows/WSL connection.
  Use a fresh run directory and a fresh Server database for each execution.
- Installed Codex and GitHub Copilot CLI executables that support the production launch arguments.
  Complete each CLI's login flow under the Windows account that runs the acceptance Worker.
- Sufficient disk space for the owned Git fixture, disposable task workspaces, retained outputs,
  and evidence. Keep both harness processes available until shutdown and cleanup finish.

The per-engine JSON settings select the engine and executable path. Home and default model
selection come from the current account's CLI configuration/environment, not additional per-engine
JSON fields. The harness must not read,
copy, reset, or replace CLI authentication files. A custom CLI home, when selected, must already
be configured by the account owner. Account setup and credentials are not acceptance artifacts.

## Scope and retained results

The fixture represents a pull request inside the isolated acceptance database. Its repository,
source revisions, prompts, profiles, and Evaluation cells belong to this run. Git fetches use the
owned fixture transport. This run does not authorize creation or mutation of any actual GitHub
pull request or issue, including comments, reviews, labels, publication, or merging.

The CLI owns model selection, authentication, and model HTTP traffic. There is no project provider
configuration, request relay, signature service, or additional execution-admission layer. Results
record the selected CLI engine and version, an optional requested model, and their task/input/output
association. A null requested model means the CLI default; it does not identify the actual remote
model used by the CLI.

Copilot's current adapter records incomplete command capture. Its result cannot establish a
complete list of tool actions. The harness does not claim that Windows or WSL blocks network
access; the fixture and task instructions define the acceptance scope.

Retain the source revision, harness inputs, fixture revisions, process logs, task and Evaluation
identities, structured results, and shutdown/cleanup observations. Preserve failed and interrupted
runs as well as successful ones. A failure or uncertain cleanup must remain visible in the run
record; a later rerun must use a new run directory.

Completion requires inspecting the ordinary review and both Evaluation arms for each engine,
including their task/result association, CLI metadata, deterministic validation results, scoring
projection, and final process/workspace cleanup. CLI exit code zero alone is insufficient. Model
quality and workflow execution are separate observations; a valid finding or score is not promised
in advance.

## Running the harness

Run the coordinator from the Windows source checkout. It builds the Worker harness, starts the
WSL Server, waits for its local readiness record, and then starts the Worker. Engines run in the
order listed in the configuration. Omitting `--allow-real-models` refuses execution.

Engines run serially. A failure in one engine stops the coordinator, so later engines in the list
are not automatically attempted. Within an engine, a failed required check or model step triggers
fail-fast/drain only after its real terminal acknowledgement; no later task is claimed. A terminal
Job or attempt can record a valid report containing a failed model branch, so `succeeded` alone
does not mean model acceptance passed. Inspect the Worker acceptance status and each model/check
state before deciding which scope completed.

Create a JSON configuration with paths appropriate to the machine:

```json
{
  "runDirectory": "D:\\AgenticReview\\Acceptance\\m39-run-001",
  "nodeExecutablePath": "C:\\Tools\\Node\\node.exe",
  "gitExecutablePath": "C:\\Program Files\\Git\\cmd\\git.exe",
  "processHostPath": "D:\\AgenticReview\\Tools\\AgenticReview.ProcessHost.exe",
  "linuxNodeExecutablePath": "/opt/node/bin/node",
  "linuxSourceDirectory": "/home/tester/PowerToys-Agentic-Review",
  "linuxRunParent": "/home/tester/acceptance-runs",
  "wslDistribution": "Ubuntu",
  "engines": [
    { "engine": "codex", "cliExecutablePath": "C:\\Tools\\Codex\\codex.exe" },
    { "engine": "copilot", "cliExecutablePath": "C:\\Tools\\Copilot\\copilot.exe" }
  ],
  "maximumRunMs": 900000
}
```

The Windows paths must be absolute. `runDirectory` must not already exist; its parent must exist.
The three Linux paths must be absolute, and `linuxRunParent` must be on the WSL Linux filesystem
rather than a Windows `/mnt/...` mount. The coordinator creates that parent when needed. It expects
standard WSL drive mounts such as `/mnt/d` when sharing its Windows input and readiness files with
the Server.

Before starting, use the preparation script to build `apps/server/dist`, type-check the acceptance
entry points, and emit `deploy/worker/cli-workflow-acceptance/server.mjs` inside
`linuxSourceDirectory` from the same source revision. For the example paths above:

```powershell
wsl.exe --distribution Ubuntu --exec /bin/mkdir --parents --mode=0700 -- /home/tester/acceptance-runs
wsl.exe --distribution Ubuntu --exec /opt/node/bin/node `
  /home/tester/PowerToys-Agentic-Review/deploy/worker/cli-workflow-acceptance/prepare-server.mjs `
  /home/tester/acceptance-runs/m39-build-001
```

The build-report directory must be new, with an existing parent. Preparation records compiler
output, emitted-file hashes, and its final receipt there. Use a fresh dedicated Linux source copy
for a rebuild: generated acceptance entry points are created exclusively and are not overwritten.
The Server retains its SQLite database and evidence on the Linux filesystem. The Windows checkout
needs its Worker build dependencies, including `esbuild`; the coordinator bundles its Worker entry
point directly from source.

Keep the emitted Linux entry with the prepared source tree, compiled Server/shared packages and
installed dependencies. `server.mjs` is not a standalone deployment bundle that can be copied by
itself. The preparation receipt distinguishes shared/Server compilation from acceptance-entry
type checking; a Server-only compile is not evidence that the Worker harness compiled.

`maximumRunMs` is an optional per-engine workflow budget, defaulting to `900000` milliseconds.
The Server accepts `60000..3600000` milliseconds. Each task also retains its own production
execution and no-progress timeouts. CLI versions are detected through `--version`; do not add
hand-maintained version strings or provider-file paths to this configuration. A one-engine list
is useful for an isolated rerun, but it does not cover the complete two-engine acceptance scope.

```powershell
& 'C:\Tools\Node\node.exe' `
  .\deploy\worker\cli-workflow-acceptance\run.mjs `
  D:\AgenticReview\Acceptance\m39-config.json `
  --allow-real-models
```

The coordinator writes per-engine artifacts under `<runDirectory>\codex` and
`<runDirectory>\copilot`, including Worker receipts, Server status, Server logs, and an aggregate
receipt. Their `serverDirectory` fields locate the matching retained Linux database, results,
scoring report, and closure record. The generated `input.json` contains temporary harness access
tokens, not CLI credentials; keep it with the private run inputs and exclude it from shared reports.

Result JSON exports are produced by the Server's 500-ms reporting poll after database completion.
Fail-fast shutdown can occur after a result commits but before that poll writes its file. An empty
`results` directory therefore does not prove that no result was persisted. Retain the closed
synthetic database and inspect its original task/result record when diagnosing that case. The
coordinator does not automatically copy the Linux database to Windows; preserve the location named
by `serverDirectory` before removing a WSL run. A manually retained `server-retained` copy is an
evidence collection step, not an alternative successful result.

Normal shutdown requests the owned Server's authenticated local stop endpoint and waits for its
exit. Retain the Worker receipt and the Server `closure.json` to inspect cleanup. A `complete`
workflow phase means the planned tasks settled. The coordinator also requires a passing Worker
execution/cleanup receipt and the Server's `passed` checks before emitting the overall
`complete.json`. Inspect individual task results, Worker-instance continuity, scoring, and cleanup
when describing the acceptance outcome.

Current Worker receipts use `completedProcessTrees` from fulfilled managed ProcessHost completion
observations. A passing receipt requires that count to match every recorded managed process, zero
active process requests and successful Host closure. ProcessHost completion is published only after
the owned Job Object drains. Historical numeric PID probes are not a substitute: Windows may reuse
an exited Git process's PID for an unrelated application. Preserve older PID observations with
their recorded process/exit identities; do not label or terminate an unrelated current process
solely because it has the same number.
