// Package preflight composes detached service-bootstrap, configuration,
// installation, data-root, and key evidence into the fail-closed ServiceHost
// production preflight contract.
//
// The package performs no filesystem, network, process, certificate-store, or
// key-opening operations. A dedicated installation verifier must obtain
// handle-bound evidence first. Compose accepts opaque bootstrap and
// installation Evidence plus concrete live credential objects, cross-binds
// their current process and service identities, reads cached atomic
// attestations, and returns an immutable detached Evidence value. Bootstrap
// evidence does not claim configuration path or file identity provenance.
//
// Lexical path validation rejects tilde-bearing DOS short-name forms as an
// early defense. That check is not filesystem isolation evidence: custom short
// names need not contain a tilde. Final data-root separation comes from the
// dedicated verifier's retained-handle ancestor and File ID facts. Compose
// binds that verifier's digest and installation-root identities without
// consuming its handles. FinalizeRuntimePlan is the only RuntimePlan-producing
// API; it rechecks and closes the shared data-root evidence before returning.
// PeerVerificationPlan separately freezes the exact verified peer wrapper,
// sole ServiceHost, signer pin, role, pipe, and service identities. Its atomic
// VerifyWindows method attests the concrete endpoint and immediately invokes
// peerverify without exposing mutable options or platform filtering.
package preflight
