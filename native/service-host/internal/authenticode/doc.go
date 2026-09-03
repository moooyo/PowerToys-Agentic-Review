// Package authenticode verifies an embedded Authenticode signature against a
// file handle that is already owned and retained by the caller.
//
// The production Windows verifier never opens a path and never considers a
// catalog signature. Its Subject is an opaque, single-use capability that is
// valid only for the duration of WithBorrowedFileHandle's callback. This keeps
// the native handle under the file owner's lock while WinVerifyTrust consumes
// it.
//
// Runtime verification deliberately uses WTD_REVOKE_NONE together with
// WTD_REVOCATION_CHECK_NONE and WTD_CACHE_ONLY_URL_RETRIEVAL. This is a
// deterministic, non-interactive runtime policy over the locally provisioned
// trust state; it does not claim to perform CRL or OCSP checking. The release
// pipeline, installer, and signer-pin rotation process are responsible for
// online code-signing revocation checks. The Server separately remains the
// live revocation authority for Worker API access.
//
// The verifier supplies CERT_STRONG_SIGN_PARA_OS_CURRENT to WinVerifyTrust and
// independently requires SHA-256 in both the selected primary SignerInfo and
// the same provider state's SPC_INDIRECT_DATA_CONTENT. This second check binds
// the policy to the actual PE Authenticode digest rather than only the PKCS#7
// message signature. Certificate chains reporting a weak signature fail.
package authenticode
