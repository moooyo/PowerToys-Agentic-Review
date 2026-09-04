//go:build !windows

package main

import "os"

func hasReparsePoint(os.FileInfo) bool {
	return false
}
