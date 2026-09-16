# Investigation server

`src/main.ts` starts the Task / Attempt / LoopCheckpoint / Report application. The active server
uses built-in username and password accounts only. There is no passwordless local login, OIDC
callback, third-party identity provider, or self-service registration. Previous standalone prototype
modules are not part of this runtime.

## Start the application

Build the workspace and dashboard in the authorized verification or deployment environment, then
run `pnpm --filter @agentic-review/server start`. The server serves the dashboard bundle and `/api`
from the same origin. The default dashboard directory is resolved relative to the installed
application, independent of the process working directory. Missing `index.html` stops startup.
`SIGINT` and `SIGTERM` close HTTP admission, active connections, cleanup, and both database handles.

The server reads `INVESTIGATION_*` settings from its process environment; it does not automatically
load a dotenv file. `.env.example` lists the supported settings. Keep both databases in directories
restricted to the service account and administrators, outside the dashboard static directory.
Relative database paths resolve against the process working directory.

## Initialize the first administrator

A new installation uses a separate `investigation-accounts.sqlite` account database. Configure a
new path instead of an old authentication database: schema identities are checked and older or
unrelated schemas are rejected without migration, conversion, or deletion.

Before the first start, configure `INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME` and either
`INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD` or `INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD_PATH`.
`INVESTIGATION_BOOTSTRAP_ADMIN_DISPLAY_NAME` is optional and defaults to the normalized username.
A protected UTF-8 password file is read verbatim. Its leading spaces, trailing spaces, byte order
mark, and final newline are part of the password; create the file with exactly the intended text.
There is no predefined password. Empty account storage without bootstrap credentials refuses to
start, so a new instance never exposes an unauthenticated account-creation route.

Bootstrap runs only while no accounts exist. Subsequent starts do not replace passwords, account
status, administrator flags, or permissions from bootstrap settings. Remove all bootstrap settings
from the service environment after initialization. The first account is an enabled administrator
with no implicit repository scopes, business permissions, action capabilities, or source-execution
authority. Sign in and use account management to grant the exact required access.

Usernames are trimmed and normalized to lowercase ASCII, with 3 to 64 letters, digits, dots,
underscores, or hyphens, beginning with a letter or digit. Login names are immutable. Passwords
contain 15 to 128 Unicode code points and at least one non-whitespace character; passwords are
otherwise stored and compared exactly as entered. Do not trim or normalize them in a client.

## Accounts, permissions, and sessions

Only enabled administrators manage accounts. `isAdmin` grants account administration; it does not
expand repository or execution authority. Account management supports creating accounts, editing
names and access, disabling accounts, and resetting passwords. Disabling preserves account IDs
referenced by investigation history. Every update carries the current `version`; concurrent changes
return a conflict instead of overwriting another administrator's edits. Transactions protect the
last enabled administrator from being disabled or losing administrator status.

Repository scopes contain exact internal repository IDs, including during repository registration.
The five business permissions are `repository:manage`, `task:create`, `task:cancel`, `action:prepare`,
and `action:execute`. Action capabilities and `allowRepositoryExecution` remain separate explicit
grants. They do not replace current GitHub permissions, target state, revision checks, or confirmed
action intents.

Passwords use asynchronous Node.js scrypt with `N=32768`, `r=8`, `p=3`, a fresh 16-byte random salt,
and a 32-byte derived key. This work factor uses approximately 32 MiB per derivation, with a 64 MiB
allocation ceiling for overhead. Two concurrent derivations and eight queued requests are the
default; bounded settings prevent unbounded KDF work. Verification of missing, disabled, or invalid
accounts performs the same-cost dummy derivation and uses constant-time key comparison. Login,
account creation, administrator password resets, and personal password changes also share bounded
IP and normalized-account rate limits. Behind a loopback reverse proxy the IP limit applies to the
proxy's connection address; forwarded headers are not trusted as authentication or rate-limit keys.

Login issues a random opaque session token; only its SHA-256 hash is persisted. Sessions default to
eight hours. Each request reads the account's current enabled state and version. Account updates,
password changes, and password resets revoke every session for the changed account. Personal
password changes require the current password and sign the user out everywhere. Asynchronous KDF
operations recheck account and administrator versions inside their final transactions. A persisted
clock high-water mark prevents expired sessions from reviving after a restart and clock rollback.

## HTTP, HTTPS, and cookies

The default listener and public origin are literal `127.0.0.1`, port `8000`. Unencrypted HTTP is
permitted only for actual loopback requests with matching Host and no forwarding headers. Passwords
remain mandatory. All state-changing browser requests must have the exact configured Origin.
Cookies are HttpOnly and SameSite=Strict; HTTPS uses Secure cookies with the `__Host-` prefix.
Authentication and account routes suppress request logs, and password fields are redacted from
runtime request logging. Responses never include password hashes, salts, or bearer session tokens.

For remote users, configure an HTTPS public origin and either a TLS listener using
`INVESTIGATION_TLS_KEY_PATH`/`INVESTIGATION_TLS_CERT_PATH`, or a private loopback listener behind an
HTTPS reverse proxy that preserves the public Host header. Public HTTP listeners are rejected.
Keep the reverse proxy's HTTP upstream inaccessible to untrusted clients. Forwarded identity
headers never establish an account session.

## Account API

- `GET /api/auth/session` returns a password-mode session. Authenticated responses include
  `expiresAt` and a user with `id`, `username`, `displayName`, `isAdmin`, explicit access fields,
  and `email: null`; signed-out responses contain `user: null`.
- `POST /api/auth/login` accepts `{username, password}` and returns the session with an HttpOnly
  cookie. Invalid credentials use a uniform response. Rate limits return HTTP `429`.
- `POST /api/auth/logout` revokes the current session, clears its cookie, and returns HTTP `204`.
- `POST /api/auth/password` accepts `{currentPassword, newPassword}`, revokes all of the caller's
  sessions, clears the cookie, and returns HTTP `204`.
- `GET /api/accounts` returns `{items: Account[]}` to administrators.
- `POST /api/accounts` creates an account using its username, password, display name, administrator
  flag, and explicit access fields.
- `POST /api/accounts/:id/update` accepts `version`, `displayName`, `enabled`, `isAdmin`, and all
  explicit access fields. Usernames cannot change.
- `POST /api/accounts/:id/password` accepts `{version, newPassword}`, increments the target version,
  and revokes the target's sessions.

Account DTOs include `id`, `username`, `displayName`, `isAdmin`, `enabled`, `version`, `createdAt`,
`updatedAt`, `repositoryIds`, `permissions`, `actionCapabilities`, and `allowRepositoryExecution`.
All request and response structures are defined in the shared investigation authentication contract.

## Recover a lost administrator password

Stop the service and run the recovery command as an operating-system administrator or the trusted
service account. Prepare a protected UTF-8 file containing the new password, then run:

```powershell
pnpm --filter @agentic-review/server run accounts:reset-admin --database "D:\ServiceData\investigation-accounts.sqlite" --username "your-admin-name" --password-path "D:\Secrets\replacement-password.txt"
```

The command first checks the existing database identity with a read-only connection. It refuses an
empty file, a different schema, a missing account, a disabled account, or a non-administrator. It
changes only the existing administrator's password and version and revokes that account's sessions;
it does not create accounts, promote users, or change repository permissions. Password values are
not accepted on the command line or printed. Restart the service, sign in with the new password,
and remove the temporary secret file using the environment's normal secret-handling procedure.

## Worker and GitHub credentials

Worker authentication remains separate from browser accounts. `INVESTIGATION_WORKERS_JSON` or
`INVESTIGATION_WORKERS_JSON_PATH` supplies `{id, token, repositoryIds}` entries. Generate each unique
token from at least 32 cryptographically random bytes encoded as base64url. Workers send
`Authorization: Bearer <token>`; the server resolves ID and exact repository scopes from trusted
configuration, ignoring identity claims in request bodies. Worker tokens cannot administer accounts,
and browser cookies cannot claim worker tasks. No configured workers means no worker admission.

GitHub transport remains optional. Configure `INVESTIGATION_GITHUB_TOKEN` or its `_PATH` variant
alongside `INVESTIGATION_GITHUB_USER_ID`. Without credentials, remote operations are unavailable.
External writes also require `INVESTIGATION_ENABLE_EXTERNAL_WRITES=true` and the normal confirmed
action-intent workflow. Account administration or test execution does not authorize writes to any
actual repository PR or issue.
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

