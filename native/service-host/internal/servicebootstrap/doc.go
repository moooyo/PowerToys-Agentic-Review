// Package servicebootstrap establishes the Windows process boundary that must
// exist before ServiceHost opens its application Named Pipe.
//
// Bootstrap first verifies the fixed role identities and restricted current
// process token through a read-only identity preflight. Only then may it open
// the retained WinSW process handle or apply the exact protected DACLs. A
// successful session can supervise that handle through winprocess.WrapperWatcher
// and can be transferred directly to peerverify as its StableWrapper. No API
// exposes a native handle.
//
// Production Open is the only public issuer: it accepts only config.Role and
// calls winidentity.Preflight with the fixed Control/Executor mapping. The
// injectable identity seam used by the pure core is private and exists only so
// tests can prove ordering and failure behavior. Complete service and token
// semantics are established by winidentity.Preflight; this package seals its
// detached result into opaque, mutation-detecting evidence.
//
// SCM status reads performed after identity preflight bind the retained WinSW
// process lifetime. They never replace the fixed service mapping or derive a
// new DACL policy from mutable SCM data. Administrative service-configuration
// changes remain outside this package's threat boundary and must fail later
// installation and preflight cross-checks rather than becoming authority here.
package servicebootstrap
