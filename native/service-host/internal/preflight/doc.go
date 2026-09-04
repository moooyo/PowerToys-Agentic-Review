// Package preflight composes detached configuration, installation, and data-root evidence into
// the fail-closed ServiceHost production preflight contract.
//
// Evidence composition and plan construction perform no filesystem, network,
// process, or key-opening operations. A dedicated installation verifier must obtain handle-bound
// evidence first. Compose cross-binds the compiled release authority, verified installation files,
// service identities, and role data-root evidence into an immutable detached value. The Worker
// Token remains a Control-local runtime input and is not copied into preflight evidence.
//
// Lexical path validation rejects tilde-bearing DOS short-name forms as an
// early defense. That check is not filesystem isolation evidence: custom short
// names need not contain a tilde. Final data-root separation comes from the
// dedicated verifier's retained-handle ancestor and File ID facts. Compose
// binds that verifier's digest and installation-root identities without
// consuming its handles. FinalizeRuntimePlan is the only RuntimePlan-producing
// API; it rechecks and closes the shared data-root evidence before returning.
// PeerVerificationPlan freezes only the fixed role, pipe, and service
// identities. VerifyWindows attests the
// concrete endpoint, invokes peerverify, and reattests the same endpoint before
// returning a Session. Service setup must configure the restricted service SID,
// token policy, and process DACL before connecting the peer pipe; peerverify
// then binds that service PID to the connected pipe PID and
// validates the retained process token.
package preflight
