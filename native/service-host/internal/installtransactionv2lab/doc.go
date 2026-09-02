// Package installtransactionv2lab defines ordinary, dormant split-installer
// transaction schema-v2 data.
//
// The package has no filesystem, registry, SCM, readiness, Claim, or execution
// authority. Its blocked schema cannot reach a successful terminal
// phase. Parsing, validating, or reducing a record never proves that an
// observation came from Windows and never authorizes an effect.
package installtransactionv2lab
