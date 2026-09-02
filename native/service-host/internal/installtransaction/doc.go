// Package installtransaction defines ordinary split-installer journal data.
//
// It contains no filesystem, SCM, readiness, Claim, or execution authority.
// Parsing, validating, or reducing a record never proves that an observation
// came from Windows. The package-private reducer accepts only closed ordinary
// observation shapes, has no production consumer, and cannot perform or
// authorize an effect. Future platform composition must reacquire opaque
// evidence before it may supply any successful observation.
package installtransaction
