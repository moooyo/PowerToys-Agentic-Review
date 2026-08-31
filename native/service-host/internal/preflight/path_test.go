package preflight

import (
	"strings"
	"testing"
)

func TestManifestRelativePathUsesStrictWindowsSemantics(t *testing.T) {
	relative, err := ManifestRelativePath(
		`C:\Program Files\AgenticReview\Worker`,
		`C:\PROGRAM FILES\AgenticReview\Worker\git\cmd\git.exe`,
	)
	if err != nil {
		t.Fatal(err)
	}
	if relative != `git\cmd\git.exe` {
		t.Fatalf("ManifestRelativePath = %q", relative)
	}

	tests := []struct {
		name     string
		root     string
		absolute string
	}{
		{"equal root", `C:\Trusted`, `C:\Trusted`},
		{"sibling prefix", `C:\Trusted`, `C:\TrustedOther\file.txt`},
		{"different drive", `C:\Trusted`, `D:\Trusted\file.txt`},
		{"lowercase drive", `c:\Trusted`, `C:\Trusted\file.txt`},
		{"UNC", `C:\Trusted`, `\\server\share\file.txt`},
		{"alternate separator", `C:\Trusted`, `C:\Trusted/file.txt`},
		{"alternate stream", `C:\Trusted`, `C:\Trusted\file.txt:stream`},
		{"relative component", `C:\Trusted`, `C:\Trusted\..\file.txt`},
		{"trailing dot", `C:\Trusted`, `C:\Trusted\file.txt.`},
		{"reserved device", `C:\Trusted`, `C:\Trusted\COM1.txt`},
		{"superscript device", `C:\Trusted`, "C:\\Trusted\\LPT\u00b9.txt"},
		{"DOS short name", `C:\Trusted`, `C:\Trusted\PROGRA~1\file.txt`},
		{"non ASCII manifest path", `C:\Trusted`, "C:\\Trusted\\caf\u00e9.txt"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ManifestRelativePath(test.root, test.absolute); err == nil {
				t.Fatalf("ManifestRelativePath(%q, %q) unexpectedly succeeded", test.root, test.absolute)
			}
		})
	}
}

func TestManifestRelativePathRejectsWindowsLengthOverflow(t *testing.T) {
	longComponent := strings.Repeat("a", maximumWindowsPathUnits)
	if _, err := ManifestRelativePath(`C:\Trusted`, `C:\Trusted\`+longComponent); err == nil {
		t.Fatal("ManifestRelativePath accepted a path beyond the UTF-16 limit")
	}
}

func TestWindowsPathComparisonIsComponentAware(t *testing.T) {
	if !windowsPathEqual(`C:\Trusted\One`, `C:\TRUSTED\one`) {
		t.Fatal("windowsPathEqual rejected a case-only difference")
	}
	if windowsPathEqual(`C:\Trusted\One`, `C:\Trusted\One\Child`) {
		t.Fatal("windowsPathEqual accepted a descendant")
	}
	if !windowsPathsOverlap(`C:\Trusted\One`, `C:\TRUSTED\one\Child`) {
		t.Fatal("windowsPathsOverlap rejected a descendant")
	}
	if windowsPathsOverlap(`C:\Trusted\One`, `C:\Trusted\OneOther`) {
		t.Fatal("windowsPathsOverlap accepted a sibling prefix")
	}
}
