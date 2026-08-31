// Package workertransport provides a fixed-origin mTLS client for the five Worker API operations.
// It deliberately does not expose a generic HTTP request, URL, header, or TLS configuration path
// to operation callers. A Client borrows its mTLS signer until Close succeeds; ownership remains
// with the caller.
package workertransport
