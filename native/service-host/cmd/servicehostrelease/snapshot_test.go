package main

import (
	"archive/tar"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestExtractSourceSnapshotMatchesFixedGitTree(t *testing.T) {
	source := testSourceInputs(t)
	tree, err := parseSourceTree(source.tree)
	if err != nil {
		t.Fatal(err)
	}
	root, err := extractSourceSnapshot(context.Background(), source.archive, tree, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySourceSnapshot(context.Background(), root, tree); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if info.IsDir() && info.Mode().Perm() != 0o500 {
				t.Errorf("snapshot directory %s mode = %o, want 500", path, info.Mode().Perm())
			}
			if info.Mode().IsRegular() && info.Mode().Perm() != 0o400 {
				t.Errorf("snapshot file %s mode = %o, want 400", path, info.Mode().Perm())
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestExtractSourceSnapshotRejectsUnsafeArchiveEntries(t *testing.T) {
	source := testSourceInputs(t)
	tree, err := parseSourceTree(source.tree)
	if err != nil {
		t.Fatal(err)
	}
	ancestors := []tar.Header{
		{Name: "native/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "native/service-host/", Typeflag: tar.TypeDir, Mode: 0o755},
	}
	tests := []struct {
		name    string
		headers []tar.Header
	}{
		{name: "absolute", headers: []tar.Header{{Name: "/native/service-host/main.go", Typeflag: tar.TypeReg}}},
		{name: "parent traversal", headers: []tar.Header{{Name: "native/service-host/../escape", Typeflag: tar.TypeReg}}},
		{name: "Windows drive or ADS", headers: []tar.Header{{Name: "native/service-host/C:main.go", Typeflag: tar.TypeReg}}},
		{name: "symlink", headers: []tar.Header{{Name: "native/service-host/go.mod", Typeflag: tar.TypeSymlink, Linkname: "main.go"}}},
		{name: "hardlink", headers: []tar.Header{{Name: "native/service-host/go.mod", Typeflag: tar.TypeLink, Linkname: "native/service-host/main.go"}}},
		{name: "device", headers: []tar.Header{{Name: "native/service-host/device", Typeflag: tar.TypeChar}}},
		{name: "reserved Windows name", headers: []tar.Header{{Name: "native/service-host/CON.go", Typeflag: tar.TypeReg}}},
		{name: "repeated ancestor", headers: []tar.Header{{Name: "native/", Typeflag: tar.TypeDir}}},
		{name: "case folded directory conflict", headers: []tar.Header{
			{Name: "native/service-host/internal/", Typeflag: tar.TypeDir},
			{Name: "native/service-host/Internal/", Typeflag: tar.TypeDir},
		}},
		{name: "unexpected file", headers: []tar.Header{{Name: "native/service-host/untracked.go", Typeflag: tar.TypeReg}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			headers := append(append([]tar.Header(nil), ancestors...), test.headers...)
			archive := tarFromHeaders(t, headers)
			if _, err := extractSourceSnapshot(context.Background(), archive, tree, t.TempDir()); err == nil {
				t.Fatal("unsafe source archive was accepted")
			}
		})
	}
}

func TestExtractSourceSnapshotRejectsBlobMutationAndBounds(t *testing.T) {
	source := testSourceInputs(t)
	tree, err := parseSourceTree(source.tree)
	if err != nil {
		t.Fatal(err)
	}
	mutated := append([]byte(nil), source.archive...)
	index := bytes.Index(mutated, []byte("module github.com/moooyo/PowerToys-Agentic-Review/native/service-host"))
	if index < 0 {
		t.Fatal("test archive does not contain go.mod payload")
	}
	mutated[index] ^= 1
	if _, err := extractSourceSnapshot(context.Background(), mutated, tree, t.TempDir()); err == nil {
		t.Fatal("archive content that differed from its Git blob was accepted")
	}
	oversized := make([]byte, maximumSourceArchiveBytes+1)
	if _, err := extractSourceSnapshot(context.Background(), oversized, tree, t.TempDir()); err == nil {
		t.Fatal("oversized source archive was accepted")
	}
}

func TestRejectAssemblySources(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "entry.s")
	content := []byte("# include \"../../outside.h\"\nTEXT ·entry(SB),$0-0\n")
	if err := os.WriteFile(path, content, 0o400); err != nil {
		t.Fatal(err)
	}
	if err := rejectAssemblySources(context.Background(), map[string]gitSourceFile{
		"entry.s": {size: int64(len(content))},
	}); err == nil {
		t.Fatal("assembly include that can escape the snapshot was accepted")
	}
}

func tarFromHeaders(t *testing.T, headers []tar.Header) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for index := range headers {
		header := headers[index]
		if header.Mode == 0 {
			header.Mode = 0o644
		}
		if err := writer.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		if header.Size != 0 {
			if _, err := writer.Write(make([]byte, header.Size)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
