//go:build windows

package winfile

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestAmbientSecurityModeAcceptsInheritedTemporaryDirectory(t *testing.T) {
	path := t.TempDir()
	directory, err := OpenDirectory(path, OpenOptions{
		VolumeUse:    VolumeUseReadOnly,
		SecurityMode: SecurityModeAmbientAncestor,
	})
	if err != nil {
		t.Fatalf("OpenDirectory with ambient security returned an error: %v", err)
	}
	t.Cleanup(func() {
		if err := directory.Close(); err != nil {
			t.Errorf("close ambient directory: %v", err)
		}
	})
	if directory.Evidence().SecurityMode != SecurityModeAmbientAncestor {
		t.Fatalf("security mode = %d", directory.Evidence().SecurityMode)
	}
	if _, err := directory.ReinspectSecurity(); err != nil {
		t.Fatalf("ReinspectSecurity with ambient mode returned an error: %v", err)
	}
}

// TestProvisionedRelativeTraversal exercises the native RootDirectory path on
// a fixture whose complete ancestor chain has protected DACLs. Windows test
// jobs opt in by setting AGENTIC_REVIEW_WINFILE_FIXTURE to a canonical regular
// file path on a fixed NTFS volume.
func TestProvisionedRelativeTraversal(t *testing.T) {
	path := os.Getenv("AGENTIC_REVIEW_WINFILE_FIXTURE")
	if path == "" {
		t.Skip("AGENTIC_REVIEW_WINFILE_FIXTURE is not configured")
	}
	if err := validateWindowsLocalPath(path); err != nil || len(path) == 3 {
		t.Fatalf("fixture path is not canonical: %v", err)
	}
	components := strings.Split(path[3:], `\`)
	root, err := OpenTraversalRoot(path[:3], OpenOptions{VolumeUse: VolumeUseReadOnly})
	if err != nil {
		t.Fatalf("OpenTraversalRoot returned an error: %v", err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Errorf("close traversal root: %v", err)
		}
	})
	parent := root
	for _, component := range components[:len(components)-1] {
		child, err := parent.OpenDirectoryComponent(component, OpenOptions{VolumeUse: VolumeUseReadOnly})
		if err != nil {
			t.Fatalf("OpenDirectoryComponent(%q) returned an error: %v", component, err)
		}
		t.Cleanup(func() {
			if err := child.Close(); err != nil {
				t.Errorf("close directory component %q: %v", component, err)
			}
		})
		parent = child
	}
	file, err := parent.OpenFileComponent(
		components[len(components)-1],
		OpenOptions{VolumeUse: VolumeUseReadOnly},
	)
	if err != nil {
		t.Fatalf("OpenFileComponent returned an error: %v", err)
	}
	t.Cleanup(func() {
		if err := file.Close(); err != nil {
			t.Errorf("close file component: %v", err)
		}
	})
	if file.Evidence().Path.RequestedPath != path {
		t.Fatalf("file evidence path = %q, want %q", file.Evidence().Path.RequestedPath, path)
	}
	current, err := file.ReinspectSecurity()
	if err != nil {
		t.Fatalf("ReinspectSecurity returned an error: %v", err)
	}
	if !bytes.Equal(current.SelfRelativeDescriptor, file.Evidence().Security.SelfRelativeDescriptor) {
		t.Fatal("stable fixture security descriptor bytes changed")
	}
}
