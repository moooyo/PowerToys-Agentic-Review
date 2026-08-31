// Package servicebootstrap establishes the Windows process boundary that must
// exist before ServiceHost opens its application Named Pipe.
//
// A successful bootstrap retains the one WinSW process handle opened between
// two stable SCM observations. The returned session can supervise that handle
// through winprocess.WrapperWatcher and can be transferred directly to
// peerverify as its StableWrapper. No API exposes the native handle.
package servicebootstrap
