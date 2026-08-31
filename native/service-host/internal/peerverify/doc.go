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
// Production Authenticode verification is handle-bound and accepts exactly one
// embedded primary signature. Production composition must remain fail-closed
// until reviewed platform orchestration enforces the complete prerequisite
// sequence before invoking this package.
package peerverify
