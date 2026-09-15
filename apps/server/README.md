# Investigation server

`src/main.ts` starts the Task / Attempt / LoopCheckpoint / Report application. It does not load the
previous API, database gateway, scheduling bootstrap, or SQL migration directory. Configure new,
separate SQLite files for investigation data and authentication data. Existing unrelated databases
are rejected without conversion or deletion.

## Start the application

Build the workspace and dashboard in the authorized verification or deployment environment, then
run `pnpm --filter @agentic-review/server start`. The server serves the dashboard bundle and `/api`
from the same origin. The default dashboard directory is resolved relative to the installed
application, independent of the process working directory. Database files must be outside the
dashboard directory so static delivery cannot expose private data. An absent `index.html` stops startup
with a configuration error. `SIGINT` and `SIGTERM` close HTTP admission, active connections,
authentication cleanup, and both database handles.

The server reads `INVESTIGATION_*` settings from its process environment. `.env.example` is a
reference; startup does not automatically load a dotenv file. Database paths are resolved relative
to the process working directory unless absolute paths are supplied.

## Local operator authentication

The default listener and public origin use literal `127.0.0.1`, port `8000`, and loopback operator
authentication. Login issues an expiring, HttpOnly, SameSite cookie. It requires a matching Host,
an actual loopback connection, no forwarding headers, and the exact configured Origin. Every
operator mutation requires that Origin as well. Worker routes never accept operator cookies.

The default local identity has no repository scopes, no execution permission, and no action
capabilities. Set `INVESTIGATION_OPERATORS_JSON` to exactly one local operator binding to grant
the intended authority. For example:

```json
[
  {
    "id": "local-operator",
    "subject": "local-operator",
    "displayName": "Local Operator",
    "repositoryIds": ["repo-powertoys-fork"],
    "permissions": ["repository:manage", "task:create", "task:cancel", "action:prepare", "action:execute"],
    "actionCapabilities": ["comment", "approve", "suggestion-comment", "request-changes", "close", "merge", "trigger-ci", "close-as-duplicate", "start-task", "reviews.verify", "view-validation", "view-changes", "create-pr", "view-evidence", "resume"],
    "allowRepositoryExecution": true
  }
]
```

Repository scopes use exact internal repository IDs, including during repository registration.
Wildcards are rejected. Permission grants and action capabilities are separate: task creation,
repository administration, preparing a draft, and confirming an action require their corresponding
permissions. Action capabilities do not replace current GitHub permissions, target state, revision
checks, or explicit action confirmation. Source execution also requires `allowRepositoryExecution`.

## OIDC and HTTPS

For remote users, set `INVESTIGATION_AUTH_MODE=oidc`, an HTTPS public origin, the exact issuer,
client ID, client secret, and explicit operator bindings. Each binding's `subject` is the OIDC `sub`
claim for that issuer. The configured issuer is assigned by trusted startup configuration, never
by a request body. Login uses PKCE, state, nonce, a browser binding, one-use transactions, and
session expiration. The callback is `/api/auth/callback` at the public origin.

Use either a TLS listener with `INVESTIGATION_TLS_KEY_PATH` and `INVESTIGATION_TLS_CERT_PATH`, or
keep the server on `127.0.0.1` behind an HTTPS reverse proxy that preserves the public Host header.
A non-loopback listener without TLS is rejected. Do not expose an HTTP reverse-proxy upstream to
untrusted clients. OIDC cookies use the `__Host-` prefix and Secure attribute. Login authorization
and repository permissions come from the configured bindings; identity-provider claims do not
automatically grant additional authority.

## Worker and GitHub credentials

`INVESTIGATION_WORKERS_JSON` contains `{ "id", "token", "repositoryIds" }` entries. Generate each
unique token from at least 32 cryptographically random bytes encoded as base64url. Workers send
`Authorization: Bearer <token>`; the server resolves ID and exact repository scopes from the
credential, ignoring identity claims in HTTP payloads. No configured workers means no worker can
claim a task. Keep these values in the service's trusted environment or use
`INVESTIGATION_WORKERS_JSON_PATH` to reference a protected JSON file. Operator bindings similarly
support `INVESTIGATION_OPERATORS_JSON_PATH`.

GitHub transport is optional. Configure `INVESTIGATION_GITHUB_TOKEN` together with
`INVESTIGATION_GITHUB_USER_ID` to enable the transport's current-account and target checks. Token
and client-secret settings also support a `_PATH` variant; do not set both forms. Without transport
credentials, remote operations are explicitly unavailable. External writes additionally require
`INVESTIGATION_ENABLE_EXTERNAL_WRITES=true` and the normal confirmed action-intent workflow.
Enabling transport or running tests does not authorize writes to any actual repository PR or issue.

## Browser session API

- `GET /api/auth/session` returns `authenticated`, `authMode`, `loginPath`, `user`, and an optional
  `expiresAt`. An authenticated user contains `id`, `displayName`, `email`, `repositoryIds`,
  `permissions`, `actionCapabilities`, and `allowRepositoryExecution`.
- `POST /api/auth/login` returns the authenticated session in loopback mode, or an
  `authorizationUrl` for OIDC. The browser then navigates to that authorization URL.
- `GET /api/auth/callback` completes OIDC and redirects to `/pull-requests`.
- `POST /api/auth/logout` revokes the session and browser login flow, clears cookies, and returns
  HTTP `204`.

The previous `/api/v1` endpoints and management pages are not served by this entry point. New
repository/work-item registration and structured investigation endpoints are the active API.

## Import complete upstream inputs

After registering an exact repository ID, an operator with `repository:manage` can call
`POST /api/repositories/:id/import-work-item` with `{ "kind": "issue", "number": 7 }` or
`{ "kind": "pull_request", "number": 7 }`. This endpoint only performs GitHub GET requests. It
checks the configured account, upstream numeric repository ID, work item kind, and final revision.
It reads every conversation page, including inline review comments and review summaries for PRs.
It returns `workItem`, `snapshotRef`, and `commentsCount` after atomically saving a complete snapshot.
The source snapshots preserve immutable content archives; a current pointer selects the snapshot
copied into each newly created task. Existing tasks retain their own frozen input.

`INVESTIGATION_SOURCE_IMPORT_MAXIMUM_BYTES` defaults to 16 MiB across upstream response bodies;
`INVESTIGATION_SOURCE_IMPORT_MAXIMUM_PAGES` defaults to 1000 comment pages. Exceeding either budget,
a changed upstream target, or incomplete pagination fails the import without saving partial data.
Increase an appropriate deployment budget and retry the complete import when necessary. Inputs are
never shortened to fit these limits. Production task preparation requires an imported snapshot and
retains its entire title, body, and comment list.

PR source acquisition runs on the Worker using the exact frozen base and head SHAs. The imported
input does not claim that inline files constitute complete source coverage. For an Issue task in a
source-aware mode, explicitly provide `sourceCommit` as a full Git SHA when creating the task.
The Server verifies `GET /repos/{owner}/{repo}/commits/{sha}` returns that same SHA and adds a
`source_commit` subject while retaining the original Issue snapshot. No branch name or latest
commit is inferred.

## Bind saved plans to trusted executable steps

`INVESTIGATION_EXECUTION_BINDINGS_PATH` references a deployment-owned JSON array. Each entry binds
an exact repository and saved `planRef`, or a complete `profileRef` plus `planKind`, to fixed
operations. A reference includes `id`, `version`, and `digest`. For example:

```json
[
  {
    "repositoryId": "repo-powertoys-fork",
    "planRef": { "id": "saved-plan-1", "version": 1, "digest": "<actual 64-character digest>" },
    "planKind": "verification",
    "satisfiedPrerequisiteRefs": ["environment-ready"],
    "steps": [
      {
        "stepId": "verify-settings",
        "operation": {
          "kind": "command",
          "executableId": "dotnet",
          "arguments": ["test", "tests/Settings.Tests.csproj", "--no-restore"],
          "workingDirectory": ".",
          "expectedExitCode": 0
        }
      }
    ]
  }
]
```

Replace example IDs and digests with the actual saved plan data. Every plan step must have exactly
one operation in the same order, and globally distinct validation check IDs. Verification and
reproduction plans need at least one actual check; setup steps can have none. Model-edit steps do
not establish validation success, and an implementation-only plan can produce a patch without
claiming tests passed. All prerequisites require
explicit matching acknowledgements. The Server computes each operation digest and binds the
result to the exact plan, source revision, execution policy, and authorizing operator. It never
substitutes model text into command arguments. Missing or ambiguous bindings fail task creation
with a specific missing-prerequisite response; they do not produce a successful validation.

Worker executable IDs resolve through `INVESTIGATION_WORKER_EXECUTABLES_JSON`, whose entries contain
trusted absolute paths and SHA-256 pins. A UI operation uses
`{ "kind": "ui", "adapterId": "...", "scenarioId": "..." }` and still requires a configured
Worker adapter. An unavailable adapter reports a blocked result. Implementation and issue-fix
plans require at least one `{ "kind": "model-edit", "allowedPaths": ["src/example.ts"] }`
operation. Allowed edit paths are explicit repository-relative files, without globs or traversal;
validation tasks cannot contain model-edit steps. Registry changes take effect after server restart,
and already-created tasks preserve their frozen execution binding.
