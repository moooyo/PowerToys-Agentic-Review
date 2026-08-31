// Package controlrpc adapts the bounded local control RPC surface to the fixed Worker API
// transport and the validated, non-exportable local-authority CNG key. Worker API JSON bodies are
// validated and copied without interpretation or reserialization.
package controlrpc
