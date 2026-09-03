// Package preflight composes detached configuration, installation, data-root,
// and key evidence into the fail-closed ServiceHost production preflight
// contract.
//
// Evidence composition and plan construction perform no filesystem, network,
// process, or key-opening operations. A dedicated installation verifier must
// obtain handle-bound evidence first. Compose accepts opaque installation
// Evidence plus the concrete live local-capability signer. The current schema
// binds its CNG attestation and deliberately excludes the ordinary Worker
// Token. It cross-binds the compiled release authority, verified installation
// files, service identities, and cached atomic attestation into an immutable
// detached value.
//
// Lexical path validation rejects tilde-bearing DOS short-name forms as an
// early defense. That check is not filesystem isolation evidence: custom short
// names need not contain a tilde. Final data-root separation comes from the
// dedicated verifier's retained-handle ancestor and File ID facts. Compose
// binds that verifier's digest and installation-root identities without
// consuming its handles. FinalizeRuntimePlan is the only RuntimePlan-producing
// API; it rechecks and closes the shared data-root evidence before returning.
// PeerVerificationPlan separately freezes the exact verified peer wrapper,
// ServiceHost, compiled signer pin, role, pipe, service identities, and
// preflight provenance digests. VerifyWindows is
// the package's deliberate native-I/O boundary: it attests the concrete
// endpoint, invokes peerverify through the sole process-wide opaque authority,
// then reattests the same endpoint before returning a Session. A rejected
// Session that cannot close remains process-lifetime quarantined and requires
// immediate ServiceHost termination through ErrPeerCleanupFatal.
package preflight
