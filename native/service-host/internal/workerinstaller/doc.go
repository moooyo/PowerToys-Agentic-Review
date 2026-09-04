// Package workerinstaller performs a strict clean install for one Worker release.
//
// It validates the manifest, architecture, signature, and on-disk payload before
// issuing any mutating operation. After the first mutation, failures trigger one
// best-effort stop-and-disable cleanup action.
package workerinstaller

