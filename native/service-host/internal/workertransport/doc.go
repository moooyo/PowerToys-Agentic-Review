// Package workertransport provides fixed-origin mTLS capabilities for closed Worker API operation
// sets. It deliberately does not expose a generic HTTP request, URL, header, or TLS configuration
// path to operation callers. A Client borrows its mTLS signer until Close succeeds; ownership
// remains with the caller. The source-only ArtifactClientV2 borrows that Client lifecycle and is
// intentionally absent from production composition.
package workertransport
