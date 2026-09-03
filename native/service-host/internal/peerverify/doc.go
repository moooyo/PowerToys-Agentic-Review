// Package peerverify binds the process connected to the private Control/Executor
// pipe to the opposing fixed Windows service.
//
// The verifier reads the service PID from SCM and the connected peer PID from
// the pipe before and after opening a process handle. All observations and the
// retained handle must identify one process. SCM may report START_PENDING or
// RUNNING because service status publication has no completion acknowledgement.
// It then requires the peer's
// primary token to match the exact restricted service SID policy. The process
// handle remains open for the full pipe session and supports WaitPeer and Close.
// No wrapper lineage, executable image, or Authenticode verification is part of
// this local identity check.
package peerverify
