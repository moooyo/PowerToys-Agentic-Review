// Package nodeenrollment defines the canonical, non-authorizing Windows node enrollment record.
//
// Parsing or constructing a Record never grants release, installation, service, signing, Claim,
// or execution authority. RecordEvidence is reserved for a future fixed-path, handle-bound reader;
// production evidence minting is deliberately unavailable in this package version.
package nodeenrollment
