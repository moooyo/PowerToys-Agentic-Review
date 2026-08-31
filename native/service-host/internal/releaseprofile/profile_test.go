package releaseprofile

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

func TestCanonicalTemplateProducesOpaqueCopyOnlyEvidence(t *testing.T) {
	document := testTemplateDocument(t)
	state, err := parseCanonicalDocument(document)
	if err != nil {
		t.Fatal(err)
	}
	evidence := Evidence{state: state}
	if err := evidence.Validate(); err != nil {
		t.Fatal(err)
	}
	digest, err := evidence.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256.Sum256(document) || evidence.SchemaVersion() != SchemaVersion ||
		evidence.ProfileID() != ProductionProfileID || evidence.ReleaseID() != "worker-test-1" ||
		evidence.Compatibility() != releasemanifest.RequiredCompatibility() ||
		evidence.AuthenticodeLeafSignerCertificateDERSHA256() != strings.Repeat("c", 64) {
		t.Fatalf("unexpected release template evidence: %#v", evidence)
	}
	if evidence.ServiceHost() != (SelfRequirement{
		Root: releasemanifest.RootInstallation,
		Path: ServiceHostRelativePath,
		Role: releasemanifest.RoleServiceHost,
	}) {
		t.Fatalf("unexpected ServiceHost descriptor: %#v", evidence.ServiceHost())
	}

	first := evidence.Dependencies()
	if len(first) != len(testTemplate(t).Dependencies) {
		t.Fatalf("dependency count = %d", len(first))
	}
	first[0].Path = `mutated\path.exe`
	second := evidence.Dependencies()
	if second[0].Path == first[0].Path {
		t.Fatal("Dependencies returned mutable internal storage")
	}
	if err := evidence.Validate(); err != nil {
		t.Fatalf("caller mutation changed evidence: %v", err)
	}
}

func TestTemplateRejectsStructuralAndDependencyMutations(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*templateDocument)
	}{
		{name: "schema", mutate: func(value *templateDocument) { value.SchemaVersion++ }},
		{name: "profile", mutate: func(value *templateDocument) { value.ProfileID = "other" }},
		{name: "release", mutate: func(value *templateDocument) { value.ReleaseID = "bad release" }},
		{name: "compatibility", mutate: func(value *templateDocument) { value.Compatibility.LocalProtocolMaximumMinor++ }},
		{name: "signer empty", mutate: func(value *templateDocument) { value.AuthenticodeLeafSignerCertificateDERSHA256 = "" }},
		{name: "signer uppercase", mutate: func(value *templateDocument) {
			value.AuthenticodeLeafSignerCertificateDERSHA256 = strings.Repeat("C", 64)
		}},
		{name: "self root", mutate: func(value *templateDocument) { value.ServiceHost.Root = releasemanifest.RootTrustedConfiguration }},
		{name: "self path", mutate: func(value *templateDocument) { value.ServiceHost.Path = `bin\AgenticReview.ServiceHost.exe` }},
		{name: "self role", mutate: func(value *templateDocument) { value.ServiceHost.Role = releasemanifest.RoleNodeRuntime }},
		{name: "self role in dependencies", mutate: func(value *templateDocument) {
			value.Dependencies[0].Role = releasemanifest.RoleServiceHost
		}},
		{name: "self path in dependencies", mutate: func(value *templateDocument) {
			value.Dependencies[0].Path = ServiceHostRelativePath
		}},
		{name: "duplicate dependency", mutate: func(value *templateDocument) {
			duplicate := value.Dependencies[0]
			duplicate.Path = strings.ToUpper(duplicate.Path)
			value.Dependencies = append(value.Dependencies, duplicate)
		}},
		{name: "unsafe dependency path", mutate: func(value *templateDocument) { value.Dependencies[0].Path = `..\escape.exe` }},
		{name: "unknown dependency role", mutate: func(value *templateDocument) { value.Dependencies[0].Role = "unknown" }},
		{name: "invalid dependency root", mutate: func(value *templateDocument) { value.Dependencies[0].Root = "other" }},
		{name: "uppercase dependency digest", mutate: func(value *templateDocument) { value.Dependencies[0].SHA256 = strings.Repeat("A", 64) }},
		{name: "noncanonical dependency size", mutate: func(value *templateDocument) { value.Dependencies[0].Size = "01" }},
		{name: "missing required dependency", mutate: func(value *templateDocument) { value.Dependencies = value.Dependencies[1:] }},
		{name: "noncanonical dependency order", mutate: func(value *templateDocument) {
			value.Dependencies[0], value.Dependencies[1] = value.Dependencies[1], value.Dependencies[0]
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := testTemplate(t)
			test.mutate(&value)
			document, err := marshalNormalized(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateDocument(document); err == nil {
				t.Fatal("ValidateDocument unexpectedly succeeded")
			}
		})
	}
}

func TestTemplateRejectsNoncanonicalAndUnknownJSON(t *testing.T) {
	document := testTemplateDocument(t)
	unknown := bytes.Replace(
		document,
		[]byte(`{"authenticodeLeafSignerCertificateDerSha256":`),
		[]byte(`{"unknown":true,"authenticodeLeafSignerCertificateDerSha256":`),
		1,
	)
	selfWithDigest := bytes.Replace(
		document,
		[]byte(`"serviceHost":{"root":`),
		[]byte(`"serviceHost":{"sha256":"`+strings.Repeat("d", 64)+`","root":`),
		1,
	)
	for _, candidate := range [][]byte{
		append(append([]byte(nil), document...), '\n'),
		append([]byte{0xef, 0xbb, 0xbf}, document...),
		unknown,
		selfWithDigest,
	} {
		if err := ValidateDocument(candidate); err == nil {
			t.Fatalf("ValidateDocument(%q) unexpectedly succeeded", candidate)
		}
	}
}

func TestZeroAndForgedEvidenceAreInvalid(t *testing.T) {
	var zero Evidence
	if !errors.Is(zero.Validate(), ErrInvalidEvidence) {
		t.Fatalf("zero Validate error = %v", zero.Validate())
	}
	if digest, err := zero.Digest(); !errors.Is(err, ErrInvalidEvidence) || digest != ([sha256.Size]byte{}) {
		t.Fatalf("zero Digest = (%x, %v)", digest, err)
	}
	if zero.SchemaVersion() != 0 || zero.ProfileID() != "" || zero.ReleaseID() != "" ||
		zero.AuthenticodeLeafSignerCertificateDERSHA256() != "" || zero.Dependencies() != nil ||
		zero.ServiceHost() != (SelfRequirement{}) {
		t.Fatal("zero Evidence exposed nonzero facts")
	}

	document := testTemplateDocument(t)
	state, err := parseCanonicalDocument(document)
	if err != nil {
		t.Fatal(err)
	}
	forgedState := *state
	forgedState.validated = false
	if err := (Evidence{state: &forgedState}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("unvalidated forged state error = %v", err)
	}
	forgedState = *state
	forgedState.document = append(append([]byte(nil), state.document...), '\n')
	if err := (Evidence{state: &forgedState}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("mutated document state error = %v", err)
	}
	forgedState = *state
	forgedState.template = cloneTemplate(state.template)
	forgedState.template.Dependencies[0].Path = `mutated\path.exe`
	if err := (Evidence{state: &forgedState}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("mutated fact state error = %v", err)
	}
	forgedState = *state
	forgedState.digest[0] ^= 0xff
	if err := (Evidence{state: &forgedState}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("mutated digest state error = %v", err)
	}
}

func TestTemplateReservesMaximumServiceHostBudget(t *testing.T) {
	value := testTemplate(t)
	setDependencyTotalSize(t, &value, releasemanifest.MaximumTotalBytes-MaximumServiceHostBytes)
	document, err := marshalNormalized(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateDocument(document); err != nil {
		t.Fatalf("exact aggregate budget was rejected: %v", err)
	}

	value = testTemplate(t)
	setDependencyTotalSize(t, &value, releasemanifest.MaximumTotalBytes-MaximumServiceHostBytes+1)
	document, err = marshalNormalized(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateDocument(document); err == nil {
		t.Fatal("template accepted dependencies that leave less than MaximumServiceHostBytes")
	}
}

func setDependencyTotalSize(t *testing.T, value *templateDocument, total uint64) {
	t.Helper()
	if total < uint64(len(value.Dependencies)) {
		t.Fatal("test dependency total is too small")
	}
	remaining := total
	for index := range value.Dependencies {
		remainingFiles := uint64(len(value.Dependencies) - index - 1)
		maximum := releasemanifest.MaximumFileBytes
		if available := remaining - remainingFiles; available < maximum {
			maximum = available
		}
		value.Dependencies[index].Size = strconv.FormatUint(maximum, 10)
		remaining -= maximum
	}
	if remaining != 0 {
		t.Fatalf("could not distribute dependency bytes: %d remain", remaining)
	}
}

func testTemplateDocument(t *testing.T) []byte {
	t.Helper()
	document, err := marshalNormalized(testTemplate(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateDocument(document); err != nil {
		t.Fatal(err)
	}
	return document
}

func testTemplate(t *testing.T) templateDocument {
	t.Helper()
	file := func(root releasemanifest.FileRoot, path string, role releasemanifest.FileRole, digit string) Dependency {
		return Dependency{Root: root, Path: path, Role: role, SHA256: strings.Repeat(digit, 64), Size: "1"}
	}
	value := templateDocument{
		AuthenticodeLeafSignerCertificateDERSHA256: strings.Repeat("c", 64),
		Compatibility: releasemanifest.RequiredCompatibility(),
		Dependencies: []Dependency{
			file(releasemanifest.RootInstallation, `AgenticReview.Worker.Control.exe`, releasemanifest.RoleServiceWrapper, "1"),
			file(releasemanifest.RootInstallation, `AgenticReview.Worker.Executor.exe`, releasemanifest.RoleServiceWrapper, "2"),
			file(releasemanifest.RootInstallation, `app\control.mjs`, releasemanifest.RoleControlBundle, "3"),
			file(releasemanifest.RootInstallation, `app\executor.mjs`, releasemanifest.RoleExecutorBundle, "4"),
			file(releasemanifest.RootInstallation, `codex\codex.exe`, releasemanifest.RoleCodexCLI, "5"),
			file(releasemanifest.RootInstallation, `git\cmd\git.exe`, releasemanifest.RoleGitCLI, "6"),
			file(releasemanifest.RootInstallation, `native\AgenticReview.ProcessHost.exe`, releasemanifest.RoleProcessHost, "7"),
			file(releasemanifest.RootInstallation, `runtime\node.exe`, releasemanifest.RoleNodeRuntime, "8"),
			file(releasemanifest.RootInstallation, `service\control.xml`, releasemanifest.RoleServiceConfig, "9"),
			file(releasemanifest.RootInstallation, `service\executor.xml`, releasemanifest.RoleServiceConfig, "a"),
		},
		ProfileID:     ProductionProfileID,
		ReleaseID:     "worker-test-1",
		SchemaVersion: SchemaVersion,
		ServiceHost: SelfRequirement{
			Root: releasemanifest.RootInstallation,
			Path: ServiceHostRelativePath,
			Role: releasemanifest.RoleServiceHost,
		},
	}
	normalized, err := normalizeDocument(value)
	if err != nil {
		t.Fatal(err)
	}
	return normalized
}
