// Package winfile provides handle-bound evidence for security-sensitive Windows
// file and directory reads.
//
// Opening an object with FILE_FLAG_OPEN_REPARSE_POINT prevents traversal of a
// reparse point in the final path component only. Evidence returned by this
// package therefore always reports that ancestor validation was not performed.
// A caller that needs a reparse-free path must open and validate every ancestor
// separately before relying on that stronger property.
//
// Directory enumeration and stream inspection remain bound to retained handles.
// Enumeration access is opt-in, applies explicit entry and UTF-16 name budgets,
// sorts deterministically, and rejects case-insensitive collisions. Secure files
// accept only the unnamed default NTFS data stream; case-sensitive directories
// are rejected because higher-level manifests use case-insensitive Windows paths.
// Authenticode verification receives only a synchronous opaque capability for
// the same retained file handle and is serialized with all other file methods.
// Callers may explicitly mark operating-system-managed ancestor directories as
// ambient; this permits inherited or defaulted security without weakening the
// valid-owner, valid-group, present non-null DACL, or self-relative requirements.
package winfile
