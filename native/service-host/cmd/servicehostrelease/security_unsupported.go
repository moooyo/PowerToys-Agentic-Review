//go:build !windows && !unix

package main

import (
	"errors"
	"os"
)

var errUnsupportedReleaseBuildPlatform = errors.New("controlled release builds require Windows or a Unix platform")

func secureTemporaryDirectory(string) error {
	return errUnsupportedReleaseBuildPlatform
}

func validatePublishDirectory(string) error {
	return errUnsupportedReleaseBuildPlatform
}

func validateReadOnlyModuleCache(string) error {
	return errUnsupportedReleaseBuildPlatform
}

func validateAnchoredDirectoryInfo(os.FileInfo, string) error {
	return errUnsupportedReleaseBuildPlatform
}

func validateSnapshotNodeInfo(os.FileInfo, string) error {
	return errUnsupportedReleaseBuildPlatform
}
