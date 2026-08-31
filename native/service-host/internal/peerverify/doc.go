// Package peerverify verifies evidence about the Windows ServiceHost process
// connected to a named pipe and retains stable process objects for the full
// pipe session.
//
// A named-pipe or SCM process ID is only a point-in-time lookup key. It is
// never authentication. QueryFullProcessImageName only maps a retained process
// to a path; reopening and hashing that path does not prove the bytes in the
// process's mapped image section. Platform orchestration must first establish
// an immutable, protected installation tree, trusted SCM launch evidence, and
// process and token DACLs. This package does not accept caller assertions that
// those prerequisite checks succeeded.
//
// The package exposes no caller-constructible production options and no direct
// verification function. Preflight claims the sole opaque Windows verifier
// authority during package initialization, derives the opposing Control or
// Executor service from its fixed role, and supplies only release-bound image
// expectations. A runtime caller check plus repository architecture tests
// prevent any other production package from claiming that authority. The
// verifier observes the peer service through SCM around process acquisition
// and retains the resulting wrapper and pipe-peer process handles in the
// returned Session. Production Authenticode verification is handle-bound and
// accepts exactly one embedded primary signature. An invalid native handle
// during Session cleanup is sticky and requires process exit; its numeric value
// is never retried.
package peerverify
