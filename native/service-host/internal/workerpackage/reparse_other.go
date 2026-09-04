//go:build !windows

package workerpackage

import "os"

func hasReparsePoint(os.FileInfo) bool {
	return false
}
