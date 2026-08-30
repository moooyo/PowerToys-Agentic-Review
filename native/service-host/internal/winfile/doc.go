// Package winfile provides handle-bound evidence for security-sensitive Windows
// file and directory reads.
//
// Opening an object with FILE_FLAG_OPEN_REPARSE_POINT prevents traversal of a
// reparse point in the final path component only. Evidence returned by this
// package therefore always reports that ancestor validation was not performed.
// A caller that needs a reparse-free path must open and validate every ancestor
// separately before relying on that stronger property.
package winfile
