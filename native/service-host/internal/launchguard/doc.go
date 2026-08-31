// Package launchguard reacquires and retains the exact installation objects
// selected by preflight until the guarded Node root Job has drained.
//
// Regular files are held without write or delete sharing. Every path component
// is opened relative to its retained parent, and no native handle is inherited
// by Node. No temporary executable, image section, or undocumented process
// creation API is used. Changes between installation verification and guard
// acquisition can only make the exact evidence comparison fail; accepted
// objects stay locked through the guarded root-Job lifetime.
//
// This is not a boundary against a trusted local administrator or the kernel.
// Installer ACLs and the closed release manifest remain authoritative for
// unselected native libraries and every other executable dependency. The
// package uses a repository architecture gate for the sole raw winprocess
// launch bridge; Go's internal-package rules are not a type seal between
// sibling packages. The gate reviews direct Go and known Windows process-start
// families, but it is not a hostile-source sandbox and cannot exhaustively
// prove the absence of dynamically resolved native calls, cgo, COM, WMI, or
// SCM activation. Trusted source review, release signing, and operating-system
// ACLs remain part of that threat boundary.
package launchguard
