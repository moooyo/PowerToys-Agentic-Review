// Package localrpc implements the bounded, canonical, length-prefixed RPC channel between one
// ServiceHost process and its same-role Node payload. It is deliberately independent of the ARWX
// Control-Executor Named Pipe protocol. The control role exposes only fixed Worker API operations
// and signing of one caller-supplied 32-byte digest; routing, headers, paths, commands, and key
// handles are never accepted from Node.
package localrpc
