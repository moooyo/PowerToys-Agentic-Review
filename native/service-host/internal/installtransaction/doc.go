// Package installtransaction defines ordinary split-installer journal data.
//
// It contains no filesystem, SCM, readiness, Claim, or execution authority.
// Parsing or validating a record never proves that any recorded observation
// came from Windows. Platform code must reacquire opaque evidence before a
// later transaction reducer may complete an effect.
package installtransaction
