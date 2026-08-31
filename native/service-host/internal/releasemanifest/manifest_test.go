package releasemanifest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

func TestCanonicalSplitWorkerManifestRoundTrip(t *testing.T) {
	value := validManifest()
	document, err := MarshalCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Parse(document)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.SchemaVersion != SchemaVersion || parsed.Compatibility != RequiredCompatibility() {
		t.Fatalf("parsed manifest has unexpected compatibility: %#v", parsed)
	}
	if len(parsed.Files) != len(value.Files) {
		t.Fatalf("parsed file count = %d, want %d", len(parsed.Files), len(value.Files))
	}
	if parsed.Files[0].Root != RootInstallation || parsed.Files[0].Path != `AgenticReview.Worker.Control.exe` {
		t.Fatalf("canonical first file = %#v, want installation Control wrapper", parsed.Files[0])
	}
	if parsed.Files[len(parsed.Files)-1].Root != RootTrustedConfiguration {
		t.Fatalf("canonical last root = %q, want trusted-configuration", parsed.Files[len(parsed.Files)-1].Root)
	}
	if bytes.HasSuffix(document, []byte{'\n'}) {
		t.Fatal("canonical manifest has a trailing newline")
	}
	if bytes.Contains(document, []byte(`\u0026`)) || !bytes.Contains(document, []byte(`runtime&tools`)) {
		t.Fatalf("canonical manifest unexpectedly HTML-escaped ampersand: %s", document)
	}

	// This digest is shared with the TypeScript schema-v2 serializer for the same fixture.
	digest := sha256.Sum256(document)
	if actual := hex.EncodeToString(digest[:]); actual != "b1ab8900b3fff2f3f54150dadaa779945dc0d5461962120ff1e7e8371c239e8c" {
		t.Fatalf("canonical cross-language digest = %s", actual)
	}
}

func TestManifestRejectsNoncanonicalAndUnknownJSON(t *testing.T) {
	document, err := MarshalCanonical(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range [][]byte{
		append(append([]byte(nil), document...), '\n'),
		append([]byte{0xef, 0xbb, 0xbf}, document...),
		[]byte(strings.Replace(string(document), `"schemaVersion":2`, `"unknown":true,"schemaVersion":2`, 1)),
	} {
		if _, err := Parse(candidate); err == nil {
			t.Fatalf("Parse(%q) unexpectedly succeeded", candidate)
		}
	}
}

func TestManifestRequiresExactCompatibilityAndDualRoles(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{name: "worker API", mutate: func(value *Manifest) { value.Compatibility.WorkerAPIProtocolVersion = "2.0" }},
		{name: "local minor", mutate: func(value *Manifest) { value.Compatibility.LocalProtocolMaximumMinor = 1 }},
		{name: "one wrapper", mutate: func(value *Manifest) {
			removed := false
			files := make([]File, 0, len(value.Files)-1)
			for _, file := range value.Files {
				if file.Role == RoleServiceWrapper && !removed {
					removed = true
					continue
				}
				files = append(files, file)
			}
			value.Files = files
		}},
		{name: "missing executor", mutate: func(value *Manifest) {
			value.Files = removeRole(value.Files, RoleExecutorBundle)
		}},
		{name: "duplicate service host", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootInstallation, `native\SecondServiceHost.exe`, RoleServiceHost, "a"))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := validManifest()
			test.mutate(&value)
			if _, err := MarshalCanonical(value); err == nil {
				t.Fatal("MarshalCanonical unexpectedly succeeded")
			}
		})
	}
}

func TestManifestUsesRootAndPathAsItsUniqueSortedKey(t *testing.T) {
	value := validManifest()
	value.Files = append(value.Files,
		manifestFile(RootTrustedConfiguration, `shared\metadata.json`, RolePolicy, "0"),
		manifestFile(RootInstallation, `shared\metadata.json`, RoleRuntimeData, "f"),
	)
	document, err := MarshalCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Parse(document)
	if err != nil {
		t.Fatal(err)
	}
	installationIndex := findFileIndex(parsed.Files, RootInstallation, `shared\metadata.json`)
	trustedIndex := findFileIndex(parsed.Files, RootTrustedConfiguration, `shared\metadata.json`)
	if installationIndex < 0 || trustedIndex < 0 || installationIndex >= trustedIndex {
		t.Fatalf("root ordering is not installation then trusted-configuration: %d, %d", installationIndex, trustedIndex)
	}

	duplicate := validManifest()
	duplicate.Files = append(duplicate.Files, manifestFile(
		RootInstallation,
		strings.ToUpper(duplicate.Files[0].Path),
		duplicate.Files[0].Role,
		"e",
	))
	if _, err := MarshalCanonical(duplicate); err == nil {
		t.Fatal("MarshalCanonical accepted a case-insensitive duplicate within one root")
	}
}

func TestManifestRejectsUnsafePathsDigestsSizesRootsAndBootstrapEntries(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Manifest)
		code   ErrorCode
	}{
		{name: "relative escape", mutate: func(value *Manifest) { value.Files[0].Path = `app\..\control.mjs` }, code: ErrorFormat},
		{name: "alternate stream", mutate: func(value *Manifest) { value.Files[0].Path = `app\control.mjs:evil` }, code: ErrorFormat},
		{name: "non ASCII", mutate: func(value *Manifest) { value.Files[0].Path = "app\\caf\u00e9.exe" }, code: ErrorFormat},
		{name: "unknown root", mutate: func(value *Manifest) { value.Files[0].Root = "other" }, code: ErrorFormat},
		{name: "uppercase digest", mutate: func(value *Manifest) { value.Files[0].SHA256 = strings.Repeat("A", 64) }, code: ErrorFormat},
		{name: "leading zero size", mutate: func(value *Manifest) { value.Files[0].Size = "01" }, code: ErrorFormat},
		{name: "empty file", mutate: func(value *Manifest) { value.Files[0].Size = "0" }, code: ErrorFormat},
		{name: "oversized file", mutate: func(value *Manifest) { value.Files[0].Size = "8589934593" }, code: ErrorLimit},
		{name: "control bootstrap", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootTrustedConfiguration, ControlBootstrapConfigurationPath, RolePolicy, "f"))
		}, code: ErrorFormat},
		{name: "executor bootstrap", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootTrustedConfiguration, ExecutorBootstrapConfigurationPath, RolePolicy, "f"))
		}, code: ErrorFormat},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := validManifest()
			test.mutate(&value)
			_, err := MarshalCanonical(value)
			assertManifestErrorCode(t, err, test.code)
		})
	}

	allowedNames := validManifest()
	allowedNames.Files = append(allowedNames.Files,
		manifestFile(RootInstallation, ControlBootstrapConfigurationPath, RoleRuntimeData, "0"),
		manifestFile(RootInstallation, `git\mingw64\ssl\cert.pem`, RoleCABundle, "2"),
		manifestFile(RootInstallation, `licenses.v1\LICENSE`, RoleLicense, "1"),
		manifestFile(RootTrustedConfiguration, `nested\executor-service-host.json`, RolePolicy, "f"),
	)
	if _, err := MarshalCanonical(allowedNames); err != nil {
		t.Fatalf("non-bootstrap root/path pairs were rejected: %v", err)
	}
}

func TestManifestEnforcesRoleRootAndExtensionMatrix(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{name: "core in trusted root", mutate: func(value *Manifest) { findRole(value.Files, RoleNodeRuntime).Root = RootTrustedConfiguration }},
		{name: "policy in installation root", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootInstallation, `policy\codex.toml`, RolePolicy, "f"))
		}},
		{name: "runtime data in trusted root", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootTrustedConfiguration, `data\runtime.dat`, RoleRuntimeData, "f"))
		}},
		{name: "wrong bundle extension", mutate: func(value *Manifest) { findRole(value.Files, RoleControlBundle).Path = `app\control.js` }},
		{name: "git helper is executable", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootInstallation, `git\helper.dll`, RoleGitHelper, "f"))
		}},
		{name: "codex runtime extension", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootInstallation, `codex\runtime.bin`, RoleCodexRuntime, "f"))
		}},
		{name: "native library extension", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootInstallation, `native\library.exe`, RoleNativeLibrary, "f"))
		}},
		{name: "trusted config is only SPKI", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootTrustedConfiguration, `keys\authority.json`, RoleTrustedConfig, "f"))
		}},
		{name: "script disguised as policy", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootTrustedConfiguration, `policy\review.ps1`, RolePolicy, "f"))
		}},
		{name: "executable disguised as runtime data", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootInstallation, `data\payload.exe`, RoleRuntimeData, "f"))
		}},
		{name: "script disguised as license", mutate: func(value *Manifest) {
			value.Files = append(value.Files, manifestFile(RootInstallation, `LICENSE.cmd`, RoleLicense, "f"))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := validManifest()
			test.mutate(&value)
			if _, err := MarshalCanonical(value); err == nil {
				t.Fatal("MarshalCanonical unexpectedly succeeded")
			}
		})
	}
}

func TestFileContentPrefixRejectsRoleDisguises(t *testing.T) {
	node := manifestFile(RootInstallation, `runtime\node.exe`, RoleNodeRuntime, "f")
	node.Size = "2"
	if err := ValidateFileContentPrefix(node, []byte("MZ")); err != nil {
		t.Fatalf("PE prefix was rejected: %v", err)
	}
	if err := ValidateFileContentPrefix(node, []byte("NO")); err == nil {
		t.Fatal("PE role accepted non-PE content")
	}

	data := manifestFile(RootInstallation, `data\runtime.bin`, RoleRuntimeData, "f")
	data.Size = "2"
	for _, prefix := range [][]byte{[]byte("MZ"), []byte("#!")} {
		if err := ValidateFileContentPrefix(data, prefix); err == nil {
			t.Fatalf("data role accepted dangerous prefix %q", prefix)
		}
	}
	data.Size = "5"
	if prefix := []byte{0xef, 0xbb, 0xbf, '#', '!'}; ValidateFileContentPrefix(data, prefix) == nil {
		t.Fatalf("data role accepted dangerous prefix %q", prefix)
	}
	data.Size = "2"
	if err := ValidateFileContentPrefix(data, []byte("OK")); err != nil {
		t.Fatalf("data prefix was rejected: %v", err)
	}

	bundle := manifestFile(RootInstallation, `app\control.mjs`, RoleControlBundle, "f")
	bundle.Size = "2"
	if err := ValidateFileContentPrefix(bundle, []byte("#!")); err != nil {
		t.Fatalf("explicit script role rejected a shebang: %v", err)
	}
	if err := ValidateFileContentPrefix(bundle, []byte("MZ")); err == nil {
		t.Fatal("bundle role accepted PE content")
	}
}

func TestManifestFileBindingProducesReleaseEvidence(t *testing.T) {
	manifest := validManifest()
	node := *findRole(manifest.Files, RoleNodeRuntime)
	evidence, err := manifest.RequireFileBinding(FileBindingRequirement{
		Root:   RootInstallation,
		Path:   strings.ToUpper(node.Path),
		Role:   RoleNodeRuntime,
		SHA256: node.SHA256,
	})
	if err != nil {
		t.Fatal(err)
	}
	if evidence.ReleaseID != manifest.ReleaseID || evidence.Compatibility != RequiredCompatibility() || evidence.File != node {
		t.Fatalf("unexpected binding evidence: %#v", evidence)
	}
	canonical, err := MarshalCanonical(manifest)
	if err != nil {
		t.Fatal(err)
	}
	expectedManifestDigest := sha256.Sum256(canonical)
	if evidence.ManifestSHA256 != hex.EncodeToString(expectedManifestDigest[:]) || evidence.SchemaVersion != SchemaVersion {
		t.Fatalf("binding evidence has incorrect manifest provenance: %#v", evidence)
	}
	if found, exists := manifest.LookupFile(RootInstallation, strings.ToUpper(node.Path)); !exists || found != node {
		t.Fatalf("LookupFile = (%#v, %t), want node", found, exists)
	}

	_, err = manifest.RequireFileBinding(FileBindingRequirement{
		Root: RootInstallation, Path: node.Path, Role: node.Role, SHA256: strings.Repeat("f", 64),
	})
	assertManifestErrorCode(t, err, ErrorBinding)
}

func TestBootstrapConfigurationEvidenceIsSeparateAndExact(t *testing.T) {
	evidence, err := NewBootstrapConfigurationEvidence(
		RootTrustedConfiguration,
		strings.ToUpper(ControlBootstrapConfigurationPath),
		strings.Repeat("a", 64),
		"128",
	)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Kind != BootstrapControl || evidence.Path != ControlBootstrapConfigurationPath || evidence.Root != RootTrustedConfiguration {
		t.Fatalf("unexpected bootstrap evidence: %#v", evidence)
	}

	for _, candidate := range []struct {
		root FileRoot
		path string
		size string
	}{
		{RootInstallation, ControlBootstrapConfigurationPath, "1"},
		{RootTrustedConfiguration, `nested\control-service-host.json`, "1"},
		{RootTrustedConfiguration, ExecutorBootstrapConfigurationPath, "0"},
		{RootTrustedConfiguration, ExecutorBootstrapConfigurationPath, "65537"},
	} {
		if _, err := NewBootstrapConfigurationEvidence(candidate.root, candidate.path, strings.Repeat("a", 64), candidate.size); err == nil {
			t.Fatalf("NewBootstrapConfigurationEvidence(%q, %q, %q) unexpectedly succeeded", candidate.root, candidate.path, candidate.size)
		}
	}
}

func validManifest() Manifest {
	return Manifest{
		Compatibility:   RequiredCompatibility(),
		PublisherPolicy: PublisherPolicy,
		ReleaseID:       "2026.08.31-test.2",
		SchemaVersion:   SchemaVersion,
		Files: []File{
			manifestFile(RootInstallation, `runtime&tools\node.exe`, RoleNodeRuntime, "1"),
			manifestFile(RootInstallation, `AgenticReview.Worker.Executor.exe`, RoleServiceWrapper, "2"),
			manifestFile(RootInstallation, `app\executor.mjs`, RoleExecutorBundle, "3"),
			manifestFile(RootInstallation, `native\AgenticReview.ProcessHost.exe`, RoleProcessHost, "4"),
			manifestFile(RootInstallation, `git\cmd\git.exe`, RoleGitCLI, "5"),
			manifestFile(RootInstallation, `codex\codex.exe`, RoleCodexCLI, "6"),
			manifestFile(RootInstallation, `AgenticReview.Worker.Control.exe`, RoleServiceWrapper, "7"),
			manifestFile(RootInstallation, `native\AgenticReview.ServiceHost.exe`, RoleServiceHost, "8"),
			manifestFile(RootInstallation, `app\control.mjs`, RoleControlBundle, "9"),
			manifestFile(RootInstallation, `service\control.xml`, RoleServiceConfig, "a"),
			manifestFile(RootInstallation, `service\executor.xml`, RoleServiceConfig, "b"),
			manifestFile(RootTrustedConfiguration, `certificates\server&root.cer`, RoleCABundle, "c"),
			manifestFile(RootTrustedConfiguration, `keys\local-authority.spki`, RoleTrustedConfig, "d"),
			manifestFile(RootTrustedConfiguration, `policy\codex-requirements.toml`, RolePolicy, "e"),
		},
	}
}

func manifestFile(root FileRoot, path string, role FileRole, digestByte string) File {
	return File{Root: root, Path: path, Role: role, SHA256: strings.Repeat(digestByte, 64), Size: "1"}
}

func findRole(files []File, role FileRole) *File {
	for index := range files {
		if files[index].Role == role {
			return &files[index]
		}
	}
	panic("test manifest role is missing: " + string(role))
}

func findFileIndex(files []File, root FileRoot, path string) int {
	for index, file := range files {
		if file.Root == root && strings.EqualFold(file.Path, path) {
			return index
		}
	}
	return -1
}

func removeRole(files []File, role FileRole) []File {
	result := make([]File, 0, len(files))
	for _, file := range files {
		if file.Role != role {
			result = append(result, file)
		}
	}
	return result
}

func assertManifestErrorCode(t *testing.T, err error, code ErrorCode) {
	t.Helper()
	var manifestErr *ManifestError
	if !errors.As(err, &manifestErr) || manifestErr.Code != code {
		t.Fatalf("error = %v, want ManifestError code %s", err, code)
	}
}
