// Package wincert acquires a pinned client certificate and its non-exportable
// CNG private key from the Windows Local Machine certificate store.
//
// Selection uses only the SHA-256 digest of the certificate's exact DER bytes.
// Subject names, issuer names, display names, and SHA-1 thumbprints are never
// selectors. After finding exactly one match, the package separately requires
// a current non-CA P-256 leaf with DigitalSignature and ClientAuth usages, a
// fully validated leaf-first local chain, and a matching non-exportable
// signing-only machine CNG key under the approved KSP and pinned protected
// DACL. Local chain construction is cache-only and supplies certificates; it
// does not adopt Local Machine trust as Server policy. The remote mTLS Server
// remains the final trust and revocation authority for the client certificate.
package wincert
