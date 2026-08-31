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
// VerifyWindows derives the opposing Control or Executor service from the
// caller's fixed role, observes that peer service through SCM around process
// acquisition, and retains the resulting wrapper and pipe-peer process handles
// in the returned Session. Production Authenticode verification is
// handle-bound and accepts exactly one embedded primary signature.
//
// Options and VerifyWindows remain a low-level bridge rather than a type-sealed
// API. A repository architecture test permits their production use only from
// preflight's atomic plan. Moving the bridge behind an inverted package
// boundary is deferred Tier-2 hardening.
package peerverify
