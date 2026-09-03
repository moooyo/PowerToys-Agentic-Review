// Package workertransport provides fixed-origin HTTPS capabilities for closed Worker API operation
// sets. It deliberately does not expose a generic HTTP request, URL, header, or TLS configuration
// path to operation callers. The client owns a copied per-Worker Token and sends it only in the
// Authorization header. ArtifactClientV2 borrows the selected Client lifecycle.
package workertransport
