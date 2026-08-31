// Package peerverify verifies evidence about the Windows ServiceHost process
// connected to a named pipe and retains stable process objects for the full
// pipe session.
//
// A named-pipe or SCM process ID is only a point-in-time lookup key. It is
// never authentication. QueryFullProcessImageName only maps a retained process
// to a path; reopening and hashing that path does not prove the bytes in the
// process's mapped image section. Callers must first establish an immutable,
// protected installation tree and trusted SCM launch evidence, then perform
// the protocol-level authentication required by the ServiceHost threat model.
//
// This package intentionally provides no production Authenticode, SCM wrapper,
// or process/token DACL adapter. Production composition must remain fail-closed
// until reviewed implementations supply all three prerequisites.
package peerverify
