package workerpackage

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestMarshalManifestCanonicalSortsFilesAndMatchesSchema(t *testing.T) {
	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{
			{RelativePath: "z/file.txt", Size: 2, SHA256: strings.Repeat("a", 64)},
			{RelativePath: "A/file.txt", Size: 1, SHA256: strings.Repeat("b", 64)},
		},
	}

	canonical, err := MarshalManifestCanonical(manifest)
	if err != nil {
		t.Fatalf("MarshalManifestCanonical error = %v", err)
	}
	want := "{" +
		"\"releaseId\":\"R-1\"," +
		"\"architecture\":\"amd64\"," +
		"\"files\":[{" +
		"\"relativePath\":\"A/file.txt\"," +
		"\"size\":1," +
		"\"sha256\":\"" + strings.Repeat("b", 64) + "\"},{" +
		"\"relativePath\":\"z/file.txt\"," +
		"\"size\":2," +
		"\"sha256\":\"" + strings.Repeat("a", 64) + "\"}]}"
	if string(canonical) != want {
		t.Fatalf("canonical manifest mismatch\nwant: %s\n got: %s", want, string(canonical))
	}

	parsed, err := ParseManifest(canonical)
	if err != nil {
		t.Fatalf("ParseManifest error = %v", err)
	}
	if parsed.Files[0].RelativePath != "A/file.txt" || parsed.Files[1].RelativePath != "z/file.txt" {
		t.Fatalf("parsed files are not canonicalized: %#v", parsed.Files)
	}
}

func TestParseManifestRejectsNonCanonicalInput(t *testing.T) {
	nonCanonical := []byte(
		`{"releaseId":"R-1","architecture":"amd64","files":[{"relativePath":"z/file.txt","size":2,"sha256":"` + strings.Repeat("a", 64) + `"},{"relativePath":"A/file.txt","size":1,"sha256":"` + strings.Repeat("b", 64) + `"}]}`,
	)
	_, err := ParseManifest(nonCanonical)
	if err == nil {
		t.Fatal("ParseManifest should reject non-canonical JSON ordering")
	}
	if !errors.Is(err, ErrCanonical) {
		t.Fatalf("ParseManifest error = %v, want ErrCanonical", err)
	}
}

func TestParseManifestRejectsUnknownFieldAndTrailingValue(t *testing.T) {
	withUnknown := []byte(
		`{"releaseId":"R-1","architecture":"amd64","files":[{"relativePath":"bin/worker.exe","size":1,"sha256":"` + strings.Repeat("a", 64) + `","extra":true}]}`,
	)
	if _, err := ParseManifest(withUnknown); err == nil || !errors.Is(err, ErrManifest) {
		t.Fatalf("ParseManifest(unknown field) error = %v, want ErrManifest", err)
	}

	canonical, err := MarshalManifestCanonical(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	withTrailing := append(canonical, []byte(" 0")...)
	if _, err := ParseManifest(withTrailing); err == nil || !errors.Is(err, ErrManifest) {
		t.Fatalf("ParseManifest(trailing value) error = %v, want ErrManifest", err)
	}
}

func TestManifestValidationRejectsUnsupportedArchitecture(t *testing.T) {
	manifest := validManifest()
	manifest.Architecture = "x86"
	if _, err := MarshalManifestCanonical(manifest); err == nil || !errors.Is(err, ErrManifest) {
		t.Fatalf("MarshalManifestCanonical error = %v, want ErrManifest", err)
	}
}

func TestManifestValidationRejectsInvalidPaths(t *testing.T) {
	invalidPaths := []string{
		"/absolute/file.txt",
		"dir\\file.txt",
		"./file.txt",
		"dir/../file.txt",
		"dir//file.txt",
		"dir/file.txt:ads",
		"dir/con.txt",
		"dir/COM¹.txt",
		"dir/LPT³.log",
		"dir/file?.txt",
		"dir/trailing. ",
		"dir/trailing.",
	}
	for _, path := range invalidPaths {
		manifest := validManifest()
		manifest.Files[0].RelativePath = path
		if _, err := MarshalManifestCanonical(manifest); err == nil || !errors.Is(err, ErrManifest) {
			t.Fatalf("MarshalManifestCanonical(%q) error = %v, want ErrManifest", path, err)
		}
	}
}

func TestManifestValidationRejectsCaseInsensitiveDuplicatePaths(t *testing.T) {
	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureARM64,
		Files: []File{
			{RelativePath: "bin/Worker.exe", Size: 1, SHA256: strings.Repeat("a", 64)},
			{RelativePath: "BIN/worker.exe", Size: 1, SHA256: strings.Repeat("b", 64)},
		},
	}
	if _, err := MarshalManifestCanonical(manifest); err == nil || !errors.Is(err, ErrManifest) {
		t.Fatalf("MarshalManifestCanonical duplicate path error = %v, want ErrManifest", err)
	}
}

func TestManifestValidationRejectsUnicodeCaseDuplicatePaths(t *testing.T) {
	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{
			{RelativePath: "bin/Ä.txt", Size: 1, SHA256: strings.Repeat("a", 64)},
			{RelativePath: "BIN/ä.TXT", Size: 1, SHA256: strings.Repeat("b", 64)},
		},
	}
	if _, err := MarshalManifestCanonical(manifest); err == nil || !errors.Is(err, ErrManifest) {
		t.Fatalf("MarshalManifestCanonical Unicode duplicate path error = %v, want ErrManifest", err)
	}
}

func TestManifestValidationRejectsInvalidSHA256(t *testing.T) {
	manifest := validManifest()
	manifest.Files[0].SHA256 = strings.Repeat("A", 64)
	if _, err := MarshalManifestCanonical(manifest); err == nil || !errors.Is(err, ErrManifest) {
		t.Fatalf("MarshalManifestCanonical invalid sha error = %v, want ErrManifest", err)
	}
}

func TestManifestValidationLimits(t *testing.T) {
	manifest := validManifest()
	manifest.Files[0].Size = MaximumFileBytes + 1
	if _, err := MarshalManifestCanonical(manifest); err == nil || !errors.Is(err, ErrLimit) {
		t.Fatalf("MarshalManifestCanonical file size limit error = %v, want ErrLimit", err)
	}

	bigDocument := make([]byte, MaximumManifestBytes+1)
	for index := range bigDocument {
		bigDocument[index] = 'a'
	}
	if _, err := ParseManifest(bigDocument); err == nil || !errors.Is(err, ErrLimit) {
		t.Fatalf("ParseManifest byte limit error = %v, want ErrLimit", err)
	}

	tooMany := Manifest{ReleaseID: "R-1", Architecture: ArchitectureAMD64, Files: make([]File, MaximumFiles+1)}
	for index := range tooMany.Files {
		tooMany.Files[index] = File{
			RelativePath: fmt.Sprintf("bin/file-%05d.txt", index),
			Size:         1,
			SHA256:       strings.Repeat("a", 64),
		}
	}
	if _, err := MarshalManifestCanonical(tooMany); err == nil || !errors.Is(err, ErrLimit) {
		t.Fatalf("MarshalManifestCanonical file count limit error = %v, want ErrLimit", err)
	}
}

func validManifest() Manifest {
	return Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{{
			RelativePath: "bin/worker.exe",
			Size:         1,
			SHA256:       strings.Repeat("a", 64),
		}},
	}
}
