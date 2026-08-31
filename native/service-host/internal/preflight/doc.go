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
// names need not contain a tilde. Final data-root separation must come from a
// dedicated verifier that compares retained-handle ancestor and File ID facts.
// Platform orchestration must therefore remain disabled until that data-root
// evidence is part of this composition contract.
package preflight
