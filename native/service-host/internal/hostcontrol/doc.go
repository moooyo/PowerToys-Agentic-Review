// Package hostcontrol owns the per-Node-launch byte-mode Named Pipe used by
// one ServiceHost process and its exact retained Node child for localrpc.
//
// A pipe name is random rendezvous metadata, not a credential. Prepare creates
// the first and only server instance and starts overlapped ConnectNamedPipe
// before callers launch Node. Accept consumes that pending listener only after
// two kernel client-PID observations match the retained Node process identity,
// Node remains live, and the service-root Job contains exactly that one process.
// winprocess holds the root Job process limit at one until Accept sends the
// canonical RuntimeBootstrapV1 document, validates the exact acknowledgement,
// and then raises the limit through the retained Job handle. Any rejected
// connection or bootstrap terminates the Node root Job before closing the pipe.
// If post-transfer pipe cleanup fails, Accept returns the shared Connection
// state with the joined error. Disconnect failures can be retried before a raw
// close begins. CloseHandle consumes its callable slot exactly once; a failed
// close retains the detached owner for the process lifetime and makes every
// Connection copy sticky-fatal.
//
// Connection.Read applies the configured I/O timeout. Connection.ReadContext
// is bounded only by its caller context so the local RPC server can wait at a
// frame boundary for the payload lifetime, then apply one nonrenewable timeout
// after the first frame byte arrives. Context cancellation and Connection.Close
// both request cancellation of the exact outstanding operation. Connect, read,
// and write operations keep their OVERLAPPED values, events, and pointer-free
// internal buffers pinned in heap owners until Windows proves terminal
// completion. Reads copy into caller memory only after that proof. An operation
// whose completion or handle ownership cannot be proved is retained for the
// process lifetime, makes HostControl sticky-fatal, and prevents every later
// native call from reusing a suspect numeric handle.
//
// Pure Node net.connect uses GENERIC_READ | GENERIC_WRITE on Windows. The own
// service SID therefore receives exactly FILE_GENERIC_READ |
// FILE_GENERIC_WRITE. That unavoidable mapping includes FILE_APPEND_DATA,
// whose bit is FILE_CREATE_PIPE_INSTANCE for a Named Pipe. The boundary relies
// on FILE_FLAG_FIRST_PIPE_INSTANCE, one maximum instance, create-before-launch,
// a per-launch 256-bit name, single-use acceptance, no reconnect, and exact
// retained-Node PID verification. A narrower client access mask would require
// native Node code and is not available through pure JavaScript net.connect.
package hostcontrol
