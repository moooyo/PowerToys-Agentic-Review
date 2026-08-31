// Package installverify performs a retained-handle, closed-tree verification
// of the split-worker installation and trusted-configuration roots.
//
// The public production entry point accepts no injected verifier or security
// policy. Ambient operating-system ancestors and installer-managed product
// anchors are opened under distinct structural security modes. Tests exercise
// the same engine through package-private dependencies. Evidence is detached
// only after every retained directory and file has been re-enumerated or
// reinspected and every handle has closed successfully.
package installverify
