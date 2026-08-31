// Package secureconfig reads a bounded Windows configuration file while
// retaining handle-bound evidence for every canonical path component.
//
// The package composes winfile's terminal-component guarantee by opening the
// volume root, then opening each ancestor directory and the file as a single
// component relative to the retained parent handle. Previously opened handles
// remain live until the read, metadata checks, and exact security-descriptor
// rereads finish.
// This is an aggregate proof over separately inspected components; it is not a
// claim that any single winfile handle validated its own ancestors.
//
// A caller-selected managed anchor divides structural descriptor handling.
// Operating-system ancestors before the anchor may use inherited or defaulted
// ambient security. The anchor, its descendants, and the file must use
// protected, non-defaulted managed security. SecurityPolicy still makes the
// semantic authorization decision for every opened object in both regions.
//
// The retained handles deny delete sharing during this transaction. That does
// not prove durable immutability after Read returns. The supplied SecurityPolicy
// must enforce the deployment's write, delete, DACL, owner, and parent-directory
// mutation rules for every relevant token.
package secureconfig
