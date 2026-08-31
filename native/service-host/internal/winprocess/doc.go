// Package winprocess provides the fail-closed Windows process-lifetime
// primitives for ServiceHost. Before resuming Node, it applies and reads back
// exact protected DACLs on the process object and primary token. Standard I/O
// uses per-launch random, single-instance local named pipes.
// Node starts with fixed code-generation and native-addon restrictions placed
// before the sole reviewed bundle path; neither caller arguments nor
// NODE_OPTIONS can weaken or reorder them.
// Only each synchronous child end is inheritable; parent ends use overlapped
// I/O and protected DACLs containing SYSTEM, Administrators, and the owning
// service SID. The owning restricted service SID receives file-generic read
// and write so the same token can create the directional server and open the
// opposite directional child end; each child handle itself is opened with
// only its required direction. FILE_GENERIC_WRITE necessarily includes the
// FILE_APPEND_DATA bit that aliases FILE_CREATE_PIPE_INSTANCE for pipes; a
// random 256-bit name, FILE_FLAG_FIRST_PIPE_INSTANCE, and one maximum instance
// bound that unavoidable mapping. Failed launch termination may use bounded
// retries, but every raw handle close is consume-once. If cleanup remains
// unresolved, LaunchNode returns ErrLaunchCleanupFatal and permanently rejects
// another launch in the current process, whose caller must then exit.
// Raw handle closes are consume-once: any failure quarantines ownership until
// process exit and the same numeric handle value is never retried. Node stdin
// callers use CloseWrite with a deadline for consumed-write delivery; aggregate
// standard-I/O Close is intentionally abortive.
//
// Outer preflight adapters must still verify service-SID and token membership,
// filesystem identity, manifests, hashes, and application configuration
// before this package is wired into the platform host.
package winprocess
