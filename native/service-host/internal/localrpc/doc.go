// Package localrpc implements the bounded, canonical, length-prefixed RPC channel between one
// ServiceHost process and its same-role Node payload. RuntimeBootstrapV1 is a separate bounded
// three-stage first exchange and is not admitted through the ordinary call decoder. Worker API
// bodies cross that canonical channel as length- and SHA-256-bound base64url descriptors so their
// validated JSON bytes remain opaque and exact. The digest binds the precise UTF-8 bytes produced
// by JSON.stringify for Node requests, or received from the Server for responses; this is not JCS,
// and Go never reorders or reserializes the business document. The package is deliberately
// independent of the ARWX Control-Executor Named Pipe protocol. The control role exposes only
// fixed Worker API operations and signing of one caller-supplied 32-byte digest; routing, headers,
// paths, commands, and key handles are never accepted from Node.
//
// An established session may remain idle at a frame boundary for its payload lifetime. Once the
// first byte of a frame arrives, the complete prefix and payload share one nonrenewable I/O
// deadline. After ArmArwxShutdownV1 is acknowledged, even the frame boundary is capped by the
// authorization deadline and only a literal zero-byte io.EOF is an orderly request-stream end.
// Reads and serialized response writes use the context-aware bootstrap-bound channel directly;
// no detached transport goroutine may continue consuming or publishing bytes after a deadline.
// Server.Serve borrows that channel; the platform owner closes it after Serve has settled.
package localrpc
