// Package preflight composes detached service-bootstrap, configuration,
// installation, data-root, and key evidence into the fail-closed ServiceHost
// production preflight contract.
//
// Evidence composition and plan construction perform no filesystem, network,
// process, or key-opening operations. A dedicated installation verifier must
// obtain handle-bound evidence first. Compose accepts opaque bootstrap and
// installation Evidence, current-image Evidence, plus the concrete live
// local-capability signer. The current schema binds its CNG attestation and
// deliberately excludes the ordinary Worker Token. It cross-binds the compiled
// release authority, the unique verified ServiceHost self entry, current
// process and file identities, service identities, and cached atomic
// attestation into an immutable detached value.
//
// Lexical path validation rejects tilde-bearing DOS short-name forms as an
// early defense. That check is not filesystem isolation evidence: custom short
// names need not contain a tilde. Final data-root separation comes from the
// dedicated verifier's retained-handle ancestor and File ID facts. Compose
// binds that verifier's digest and installation-root identities without
// consuming its handles. FinalizeRuntimePlan is the only RuntimePlan-producing
// API; it rechecks and closes the shared data-root evidence before returning.
// PeerVerificationPlan separately freezes only the fixed role, pipe, service
// identities, and preflight provenance digests. VerifyWindows attests the
// concrete endpoint, invokes peerverify, and reattests the same endpoint before
// returning a Session. Service setup must configure the restricted service SID,
// token policy, and process DACL before SCM reports the service as running;
// peerverify then binds that running service PID to the connected pipe PID and
// validates the retained process token.
package preflight
