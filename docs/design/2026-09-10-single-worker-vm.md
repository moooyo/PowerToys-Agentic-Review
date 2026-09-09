# One Worker per virtual machine

Decision: 2026-09-10. Each independently deployed virtual machine runs one long-lived Worker and
processes successive tasks. The deployment owns VM isolation and machine maintenance. The Worker
does not provision the VM or create a second privileged execution service inside it.

## Removed duplication

The proposed Windows execution-authority, per-attempt identity, protected journal, native/VM
adapter, signed prepared/closed evidence, one-use execution challenge and OS-attestation admission
framework are retired. The dormant WindowsAttempt lease/lifecycle/journal/recovery implementation
had no production consumer; its source, synthetic tests, exports and separate owner bundle were
removed together. A generic replacement journal is not needed by the existing Worker lifecycle.

The M35 tests remain historical evidence about the removed implementation, not a reason to retain
it. Its frozen source and reports remain in artifacts. The existing UI process-ownership recovery
and desktop lease are separate, used features and remain supported.

Evaluation no longer needs an application-issued claim that the VM provides isolation. Code that
unconditionally rejected Evaluation scheduling, execution, completion or scoring pending that
claim is removed. No replacement `vmAccepted` setting, signing service or deployment attestation
API is introduced.

## Runtime responsibilities that remain

The existing Worker and Server lifecycle already provide the required operational controls:

- The Server authenticates the Worker, assigns a task with a current lease and frozen inputs,
  applies configured queue/concurrency limits and rejects obsolete or cancelled attempts.
- Worker capability reports describe installed functionality. Evaluation review and summary
  support come from the corresponding configured runtime factories, so an ordinary model-enabled
  Worker without those factories does not receive a task it cannot execute. Profile-only tasks
  do not require either model runtime. This reuses the existing scheduler's capability matching.
- Each attempt uses its own prepared workspace and control files. CLI-owned login storage stays
  outside disposable attempts and is not copied by the Worker. Results and evidence remain
  available through terminal reporting; deferred cleanup runs afterward.
- ProcessHost applies existing resource limits, cancellation and process-tree termination. UI
  tasks retain desktop exclusion so one task cannot drive another task's application window.
- Lease expiry, cancellation and loss of ownership prevent late results from completing a task.
  Cleanup or process-supervision failures stop the Worker from taking further work until its
  existing recovery or operator maintenance has resolved the fault.
- The selected CLI owns provider configuration, authentication and HTTP traffic. The Worker does
  not read or copy CLI auth/provider files and has no global provider registry or model HTTP relay.
  Worker and Server credentials remain excluded from child environments and result payloads.
- Evaluation purpose continues to exclude ordinary PR/Issue publication. Automated tests use
  synthetic data; actual repository writes still require the user's explicit scoped approval.

These checks maintain a reusable Worker across successive tasks. They do not provision Windows
accounts, attest ACLs, prove an administrator honest or guarantee OS isolation between tasks inside
the same VM. Worker and task processes are within the deployment's VM trust boundary. VM rebuild,
patching and any stronger cross-task isolation are deployment responsibilities.

## Model records and result handling

Model-required Evaluation uses the configured Codex or Copilot CLI. The Worker records CLI
configuration, detected version, process exit and schema-validated structured output. The Server
checks task, attempt, frozen input and result ownership through the existing completion path.
Configured model names and CLI versions are not independently verified provider model identity.
There is no project-owned provider HTTP ledger or separate relay closure protocol. See the
[CLI-owned model execution design](./2026-09-10-cli-owned-model-execution.md).

The former constant execution-acceptance field and its checks are absent from the development
protocol, storage schema, Worker and Dashboard. Completion depends on valid structured output
and the current task lease. The product is unreleased, so development directly
maintains the current contracts and schema. Database resets, old-version upgrades, data conversion
and compatibility migrations are not development requirements. Existing SQL schema initialization
remains in use; this decision does not modify existing data or retained acceptance artifacts.

Profile-only Evaluation can run without a model. A model-required task without the configured
runtime or recorded model output remains visibly incomplete; a successful build is not a model
result. Existing evidence file hashes and result schema checks retain their ordinary data-integrity
meaning without introducing a new signing or admission system.

## Verification and deployment

Verification uses synthetic Worker/Server/domain tests and build/type checks on `ssh test-env`
unless local verification is explicitly authorized. Historical VM/app-server test reports do not
establish acceptance of the current CLI-owned path. A real configured VM/CLI/model end-to-end run
remains a deployment validation step with its own explicit scope and CLI login. General test
permission does not authorize an actual repository PR/Issue write or changes to local accounts,
firewall or registry.
