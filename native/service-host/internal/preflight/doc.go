// Package preflight composes detached configuration, installation, and key
// evidence into the fail-closed ServiceHost production preflight contract.
//
// The package performs no filesystem, network, process, certificate-store, or
// key-opening operations. A dedicated installation verifier must obtain
// handle-bound evidence first. Compose accepts only that verifier's opaque
// Evidence and concrete live credential objects, reads their cached atomic
// attestations, and returns an immutable detached Evidence value.
//
// Lexical path validation rejects tilde-bearing DOS short-name forms as an
// early defense. That check is not filesystem isolation evidence: custom short
// names need not contain a tilde. Final data-root separation comes from the
// dedicated verifier's retained-handle ancestor and File ID facts. Compose
// binds that verifier's digest and installation-root identities without
// consuming its handles. FinalizeRuntimePlan is the only plan-producing API;
// it rechecks and closes the shared data-root evidence before returning.
package preflight
