package secureconfig

import (
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestPlanCanonicalFilePathIncludesEveryAncestor(t *testing.T) {
	plan, err := planCanonicalFilePath(`C:\Program Files\AgenticReview\config.json`)
	if err != nil {
		t.Fatalf("planCanonicalFilePath returned an error: %v", err)
	}
	want := []string{`C:\`, `C:\Program Files`, `C:\Program Files\AgenticReview`}
	if len(plan.ancestors) != len(want) {
		t.Fatalf("ancestor count = %d, want %d", len(plan.ancestors), len(want))
	}
	for index := range want {
		if plan.ancestors[index] != want[index] {
			t.Fatalf("ancestor %d = %q, want %q", index, plan.ancestors[index], want[index])
		}
	}
	if plan.file != `C:\Program Files\AgenticReview\config.json` {
		t.Fatalf("file = %q", plan.file)
	}

	direct, err := planCanonicalFilePath(`D:\config.json`)
	if err != nil {
		t.Fatalf("direct-root file was rejected: %v", err)
	}
	if len(direct.ancestors) != 1 || direct.ancestors[0] != `D:\` {
		t.Fatalf("direct-root ancestors = %#v", direct.ancestors)
	}
}

func TestPlanCanonicalFilePathRejectsNoncanonicalInputs(t *testing.T) {
	tests := []string{
		"",
		`C:\`,
		`c:\config.json`,
		`C:/config.json`,
		`\\server\share\config.json`,
		`C:\safe\..\config.json`,
		`C:\safe\\config.json`,
		`C:\safe\config.json\`,
		`C:\safe\config.json:payload`,
		`C:\safe\CON.json`,
		"C:\\safe\\COM\u00b9.json",
		"C:\\safe\\bad\x00name.json",
	}
	for _, path := range tests {
		if _, err := planCanonicalFilePath(path); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("planCanonicalFilePath(%q) returned %v", path, err)
		}
	}

	overlong := `C:\` + strings.Repeat("a", maximumWindowsPathUnits)
	if _, err := planCanonicalFilePath(overlong); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("overlong path returned %v", err)
	}
}

func TestEvidenceDigestExcludesDiagnosticsAndBindsSecurityEvidence(t *testing.T) {
	evidence := fixtureEvidence(`C:\safe`, winfile.ObjectKindDirectory, 1, 0)
	first := digestObjectEvidence(`C:\safe`, evidence)
	evidence.Path.FinalPathDiagnostic = `\\?\C:\safe`
	evidence.Path.FinalPathDiagnosticError = "diagnostic failure"
	if second := digestObjectEvidence(`C:\safe`, evidence); second != first {
		t.Fatal("diagnostic-only fields changed the evidence digest")
	}
	evidence.Security.SelfRelativeDescriptor[0]++
	if second := digestObjectEvidence(`C:\safe`, evidence); second == first {
		t.Fatal("security descriptor change did not change the evidence digest")
	}
}

func TestNewObjectEvidenceValidatesAndDetachesWinfileSnapshot(t *testing.T) {
	path := `C:\Program Files\AgenticReview\Worker\runtime\node.exe`
	evidence := fixtureEvidence(path, winfile.ObjectKindFile, 41, 128)
	object, err := NewObjectEvidence(path, evidence)
	if err != nil {
		t.Fatal(err)
	}
	if object.EvidenceSHA256 == (Digest{}) ||
		object.SecurityDescriptorSHA256 != DigestSecurityDescriptor(evidence.Security.SelfRelativeDescriptor) {
		t.Fatal("NewObjectEvidence omitted canonical evidence digests")
	}
	original := object.Evidence.Security.SelfRelativeDescriptor[0]
	evidence.Security.SelfRelativeDescriptor[0] ^= 0xff
	if object.Evidence.Security.SelfRelativeDescriptor[0] != original {
		t.Fatal("NewObjectEvidence retained caller-owned security descriptor storage")
	}

	invalid := fixtureEvidence(path, winfile.ObjectKindFile, 42, 128)
	invalid.Path.RequestedPath = `C:\Elsewhere\node.exe`
	if _, err := NewObjectEvidence(path, invalid); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("NewObjectEvidence accepted inconsistent evidence: %v", err)
	}
}

func TestValidateObjectEvidenceRejectsUnsafeClaims(t *testing.T) {
	path := `C:\safe\config.json`
	tests := []struct {
		name   string
		mutate func(*winfile.Evidence)
		want   error
	}{
		{
			name: "reparse",
			mutate: func(value *winfile.Evidence) {
				value.Attributes |= fileAttributeReparsePoint
			},
			want: winfile.ErrReparsePoint,
		},
		{
			name: "hard link",
			mutate: func(value *winfile.Evidence) {
				value.LinkCount = 2
			},
			want: winfile.ErrHardLinkedFile,
		},
		{
			name: "non NTFS",
			mutate: func(value *winfile.Evidence) {
				value.Volume.FileSystem = "ReFS"
			},
			want: winfile.ErrUnsupportedVolume,
		},
		{
			name: "removable",
			mutate: func(value *winfile.Evidence) {
				value.Volume.DriveType = 2
			},
			want: winfile.ErrUnsupportedVolume,
		},
		{
			name: "volume cross check",
			mutate: func(value *winfile.Evidence) {
				value.Volume.PathIdentityCrossCheck = false
			},
			want: winfile.ErrVolumeIdentityMismatch,
		},
		{
			name: "unprotected DACL",
			mutate: func(value *winfile.Evidence) {
				value.Security.DACLProtected = false
			},
			want: winfile.ErrUnsafeSecurityDescriptor,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := fixtureEvidence(path, winfile.ObjectKindFile, 10, 3)
			test.mutate(&evidence)
			err := validateObjectEvidence(path, winfile.ObjectKindFile, evidence, 64)
			if !errors.Is(err, test.want) {
				t.Fatalf("validateObjectEvidence returned %v, want %v", err, test.want)
			}
		})
	}
}
