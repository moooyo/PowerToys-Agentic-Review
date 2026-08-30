// Package winprocess provides the fail-closed Windows process-lifetime
// primitives for ServiceHost. Before resuming Node, it applies and reads back
// exact protected DACLs on the process object and primary token. Outer
// preflight adapters must still verify service-SID and token membership,
// filesystem identity, manifests, hashes, and application configuration
// before this package is wired into the platform host.
package winprocess
