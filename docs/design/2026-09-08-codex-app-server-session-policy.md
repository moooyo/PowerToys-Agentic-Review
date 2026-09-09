# App-server session policy and parent composition

The prepared runner has an explicit app-server backend. It requires a parent invocation and
never falls back to exec after a policy, transport or recording failure. The default exec path
retains its existing behavior. Production startup does not enable the new backend yet.

## Configuration observation before a turn

The policy builder selects a named profile for review or read-only summary. Review permits writes
to its checkout and temporary directory; summary keeps both read-only. Both retain shell access.
The command network proxy has an explicit, bounded domain allowlist; summary requires an empty
list. The parent relay URL never grants command access to loopback. Writable directories cannot
cover the control directory, Codex home or user profile.

One app-server process performs initialize, configuration/requirements reads, permission-profile
listing, Windows readiness, thread creation and feature listing. Returned provider, model,
authentication configuration, environment, workspace roots, permissions and CLI version must
match the generated settings. The function does not start a turn or provision a Windows sandbox.
An unready sandbox returns `SANDBOX_NOT_READY` with its actual observation.

`app_server_configuration_projection_v1` hashes actual merged configuration, requirements,
permission/feature observations and thread policy. Only enumerated lifecycle fields are excluded,
and known dynamic paths and the relay URL have explicit role substitutions. Directory relationships
are validated before those substitutions. Sorting is independent of the host locale. Unknown
policy fields remain in the projection. Origins/layers retain their dynamic version hashes in a
separate raw-observation digest, rather than being described as a stable policy.

This is a configuration projection, not OS confinement attestation. `executionAccepted` stays
false. Readiness alone does not prove ACL or firewall enforcement, and the selected profile's
legacy `networkAccess` field does not establish permitted command destinations.

## Invocation lifecycle

The parent factory validates the complete frozen evaluation envelope and derives ScopeV1 from
its source, authorization, registration and lease. Startup runtime configuration must match the
frozen registration. It snapshots the relay endpoint, limits, API handles and authorization
callback; the callback's credential results remain inside the parent relay.

The original attempt owner plus job/attempt IDs identify one retained preparation. Changes to
Worker identity, lease generation, execution signal or frozen input cannot obtain another
preparation for that attempt. Opening has one retained promise, including failure. Both the
original owner and current execution signal cancel the parent session, and opening rechecks the
earlier of the execution deadline and assigned-time hard limit.

The prepared runner retains scope/input snapshots, single dispatch, immutable close intent and
matching recording checks. After creating the actual process it synchronously attaches the driver
and its physical drain promise to the coordinator. It then observes the same session and compares
the observed version/configuration digest with the opening's runtime and the startup-verified
binary digest before sending the prompt. App-server output does not create exec control files.
Both backends share disk monitoring, progress and terminal cleanup.

## Current evidence and boundary

Three actual Windows metadata cases exercised generated review, summary and review-again settings
on pinned Codex 0.145.0. Different temporary directories, relay ports and session IDs produced the
same review projection digest and different raw-observation digests. All three reported
`updateRequired`, issued zero provider requests, and closed the CLI, streams, Host and listener.
These are successful metadata-compatibility and refusal checks, not accepted model execution.

The factory retains the existing evaluation-only ScopeV1 boundary. It does not reinterpret an
ordinary envelope as an evaluation or substitute the rendered prompt hash for a composed summary
input. Production startup composition, actual model execution, command/network confinement and
Windows application acceptance remain open. No PR/Issue mutation is permitted by this design.
