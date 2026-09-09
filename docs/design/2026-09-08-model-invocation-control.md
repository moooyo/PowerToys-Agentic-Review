# Attempt-bound model invocation records

## Purpose and trust boundary

The model runtime registry stores an expected configuration. Invocation control records a
separate authenticated opening, an immutable closure commitment, and a subsequently uploaded
call ledger. A result payload cannot provide its own expected closure digest.

The collector is the trusted Worker parent process. The existing Worker credential and authenticated
transport identify it to the Server; the model subprocess must not receive that credential.
Separate HTTP operations alone do not authenticate measurements and do not protect against a
compromised Worker. This feature does not establish the still-unaccepted command/network boundary.

## Lifecycle and immutable state

1. The Worker requests an opening using its exact lease, a stable invocation ID and runtime
   measurements. The owner derives repository, evaluation, cell, Run, request, Job, attempt,
   authorization, Prompt, schema and execution-manifest scope from the frozen database records.
   Each attempt has at most one opening. CLI calls share that invocation; process-level retry
   requires a new attempt.
2. The Worker parent owns the relay and process handle. It separately observes process completion
   and output draining, then closes the relay. A termination acknowledgement alone is insufficient.
   It builds the closure commitment from the relay's retained result, never from model/executor JSON.
3. The owner saves the closure digest, call count, last receipt digest, observed identity/output
   digests, closure state and cleanup facts independently of the ledger. This operation carries no
   ledger or provider credentials.
4. The Worker uploads the unchanged ledger. The owner first requires the complete opening scope,
   runtime measurements, closure metadata and actual ledger digest to match the independently
   saved records. Mismatched transport is rejected without occupying the unique submission slot.
   It then recomputes internal hashes and retains the consistency result for those exact bytes.

All three records are immutable and resist replacement. They retain bounded canonical JSON and
digests, not raw tokens, provider headers, environment variables or model request/response bodies.
Control requests are at most 32 KiB; the ledger retains its existing 1 MiB aggregate limit.
Repository enablement and evaluation cancellation govern new activity. Later runtime selection
disablement does not rewrite a batch's already frozen expectation.

## Authentication, replay and time

HTTP authentication injects the current Worker credential digest; the body cannot choose it.
The owner independently rechecks that credential, the claimed node and stored attempt identity,
including the lease token, before considering exact replay. Current credential rotation does not
change a previously committed intent's identity, but the old credential ceases to authorize requests.

Exact opening, seal and submission replays return their original receipts. Different payloads for
the same immutable slot conflict. New records additionally require the current attempt, generation,
Worker instance, unsuperseded registration, active deadlines, uncancelled Job and valid frozen
evaluation binding. Recovery accepts existing authorized replay only; it cannot create new records.
An expired or cancelled attempt cannot acquire fresh success eligibility through late collection.

Opening and seal receipt timestamps use the Server clock. Call timestamps and relay closure use
the Worker clock. Relative call ordering is checked within the ledger; Server lease deadlines are
checked using the Server clock. Worker timestamps are not compared with unrelated Server wall time.

The same in-memory session owns retry of an uncertain opening, seal or ledger upload. Starting a
new collector session is not recovery of an already running invocation. Future production composition
must retain this session in the existing single-owner attempt execution context; a unique database
opening does not itself prevent a parent process from wrongly dispatching the same model twice.

## Meaning of the recorded result

Consistency can be `matched`, `unavailable`, `mismatched` or `invalid`. Missing output, zero calls,
earlier failure, cancellation, uncertain cleanup and missing model identity cannot become `matched`.
The complete observed identity is checked against the frozen registration, independently of the
requested model alias. A null sealed output remains unbound and is never filled from an expectation.

Every submission receipt explicitly has `executionAccepted: false`. No invocation control record
enables evaluation capability, admits a required-model lease, accepts a model-backed completion,
supplies a scored model observation or approves a PR. Result integration must later bind the actual
validated model output to this exact attempt's accepted invocation and independently accepted
execution boundary, inside the final completion transaction.

## Remaining production integration

The actual CLI binary and effective launch policy still require measurement and isolated execution
acceptance. The trusted provider authorization helper and process/relay lifecycle must be composed
in the production runner; the new collection interface cannot substitute for this. Full result and
Dashboard observation integration follows that boundary. Actual Windows application and provider
acceptance remain separate, and any real PR/Issue write still requires explicit target/action/content
approval. Synthetic transport and lease fixtures do not establish actual model execution.
