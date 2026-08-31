package generator

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExclusiveOutputAndBoundedCheck(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "generated.go")
	expected := []byte("exact bytes")
	if err := WriteExclusiveRegular(path, expected, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CheckExactRegular(path, expected, int64(len(expected))); err != nil {
		t.Fatal(err)
	}
	if err := CheckExactRegular(path, expected, int64(len(expected)-1)); err == nil {
		t.Fatal("bounded check accepted an oversized file")
	}
	if err := WriteExclusiveRegular(path, []byte("replacement"), 0o600); err == nil {
		t.Fatal("exclusive writer replaced an existing regular file")
	}
	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != string(expected) {
		t.Fatalf("existing output changed to %q", actual)
	}
}

func TestRegularReaderRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	link := filepath.Join(directory, "link")
	if err := os.WriteFile(target, []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	if _, err := ReadRegularBounded(link, 16); err == nil {
		t.Fatal("regular reader followed a symlink")
	}
	if err := WriteExclusiveRegular(link, []byte("replacement"), 0o600); err == nil {
		t.Fatal("exclusive writer replaced a symlink")
	}
}
