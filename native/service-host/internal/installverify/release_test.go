package installverify

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

func TestZeroReleaseAuthorityStopsBeforeDependencies(t *testing.T) {
	fixture := newInstallFixture(t)
	deps := fixture.dependencies()
	called := false
	deps.identityPreflight = func(winidentity.Options) (winidentity.Evidence, error) {
		called = true
		return winidentity.Evidence{}, errors.New("unexpected identity call")
	}
	deps.newSecurityPolicy = func(winidentity.Evidence) (filesystemSecurityPolicy, error) {
		called = true
		return nil, errors.New("unexpected policy call")
	}
	deps.newAuthenticodeVerifier = func() (authenticode.Verifier, error) {
		called = true
		return nil, errors.New("unexpected Authenticode call")
	}
	deps.managedAnchor = func(releasemanifest.FileRoot, string) (string, error) {
		called = true
		return "", errors.New("unexpected anchor call")
	}
	deps.secureRead = func(string, secureconfig.Options) (secureconfig.Result, error) {
		called = true
		return secureconfig.Result{}, errors.New("unexpected read call")
	}
	deps.openTraversalRoot = func(string, winfile.OpenOptions) (directoryHandle, error) {
		called = true
		return nil, errors.New("unexpected open call")
	}

	evidence, err := verifyWithDependencies(
		context.Background(),
		fixture.options,
		releaseAuthorityFacts{},
		deps,
	)
	if !errors.Is(err, ErrReleaseAuthority) {
		t.Fatalf("zero authority returned %v, want ErrReleaseAuthority", err)
	}
	if called || fixture.fs.secureReadCount != 0 || evidence.Validate() == nil {
		t.Fatal("zero authority crossed a dependency boundary or returned usable evidence")
	}
	if _, err := captureReleaseAuthority(releaseprofile.Evidence{}); !errors.Is(err, ErrReleaseAuthority) {
		t.Fatalf("zero concrete release evidence returned %v, want ErrReleaseAuthority", err)
	}
}

func TestCaptureReleaseAuthorityRequiresTwoStableSnapshots(t *testing.T) {
	fixture := newInstallFixture(t)
	source := &fakeReleaseAuthoritySource{facts: fixture.authority}
	facts, err := captureReleaseAuthoritySource(source)
	if err != nil {
		t.Fatalf("capture stable release authority: %v", err)
	}
	if !sameReleaseAuthorityFacts(facts, fixture.authority) {
		t.Fatal("captured release authority differs from the stable source")
	}
	wantCalls := []string{
		"validate", "digest", "schema", "profile", "release", "compatibility", "signer", "dependencies", "self",
		"validate", "digest", "schema", "profile", "release", "compatibility", "signer", "dependencies", "self",
	}
	if !reflect.DeepEqual(source.calls, wantCalls) {
		t.Fatalf("capture calls = %v, want %v", source.calls, wantCalls)
	}

	tests := []struct {
		name   string
		mutate func(*fakeReleaseAuthoritySource)
	}{
		{"first validation", func(value *fakeReleaseAuthoritySource) {
			value.validateErrors = map[int]error{1: errors.New("first validation failed")}
		}},
		{"first digest", func(value *fakeReleaseAuthoritySource) {
			value.digestErrors = map[int]error{1: errors.New("first digest failed")}
		}},
		{"second validation", func(value *fakeReleaseAuthoritySource) {
			value.validateErrors = map[int]error{2: errors.New("second validation failed")}
		}},
		{"second digest", func(value *fakeReleaseAuthoritySource) {
			value.digestErrors = map[int]error{2: errors.New("second digest failed")}
		}},
		{"digest drift", func(value *fakeReleaseAuthoritySource) {
			value.secondDigest = sha256.Sum256([]byte("drifted template"))
		}},
		{"fact drift", func(value *fakeReleaseAuthoritySource) {
			copy := cloneReleaseAuthorityFacts(value.facts)
			copy.signerPin = strings.Repeat("e", sha256.Size*2)
			value.secondFacts = &copy
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := &fakeReleaseAuthoritySource{facts: fixture.authority}
			test.mutate(candidate)
			if _, err := captureReleaseAuthoritySource(candidate); !errors.Is(err, ErrReleaseAuthority) {
				t.Fatalf("unstable authority returned %v, want ErrReleaseAuthority", err)
			}
		})
	}
	if _, err := captureReleaseAuthoritySource(nil); !errors.Is(err, ErrReleaseAuthority) {
		t.Fatalf("nil authority returned %v, want ErrReleaseAuthority", err)
	}
}

func TestBootstrapConfigurationCannotReplaceCompiledAuthority(t *testing.T) {
	fixture := newInstallFixture(t)
	attackerSigner := strings.Repeat("e", sha256.Size*2)
	rewriteFixtureBootstraps(t, fixture, func(value *config.Config) {
		value.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 = attackerSigner
	})
	fixture.signerDigest = attackerSigner

	evidence, err := verifyWithDependencies(
		context.Background(),
		fixture.options,
		fixture.authority,
		fixture.dependencies(),
	)
	if !errors.Is(err, ErrReleaseAuthority) {
		t.Fatalf("attacker-controlled config signer returned %v, want ErrReleaseAuthority", err)
	}
	if fixture.fs.authenticodeCount != 0 || evidence.Validate() == nil {
		t.Fatal("config signer reached Authenticode verification or returned usable evidence")
	}
}

func TestBindReleaseManifestRejectsEveryCompiledFieldMutation(t *testing.T) {
	fixture := newInstallFixture(t)
	nonSelf := firstNonServiceHostIndex(fixture.manifest)
	self := serviceHostIndex(fixture.manifest)
	tests := []struct {
		name   string
		mutate func(*releasemanifest.Manifest)
	}{
		{"dependency root", func(value *releasemanifest.Manifest) {
			value.Files[nonSelf].Root = releasemanifest.RootTrustedConfiguration
		}},
		{"dependency path", func(value *releasemanifest.Manifest) { value.Files[nonSelf].Path = `other\control.exe` }},
		{"dependency role", func(value *releasemanifest.Manifest) { value.Files[nonSelf].Role = releasemanifest.RoleNodeRuntime }},
		{"dependency digest", func(value *releasemanifest.Manifest) { value.Files[nonSelf].SHA256 = strings.Repeat("a", 64) }},
		{"dependency size", func(value *releasemanifest.Manifest) { value.Files[nonSelf].Size = strconv.FormatUint(99, 10) }},
		{"dependency removed", func(value *releasemanifest.Manifest) {
			value.Files = append(value.Files[:nonSelf], value.Files[nonSelf+1:]...)
		}},
		{"dependency order", func(value *releasemanifest.Manifest) {
			value.Files[nonSelf], value.Files[nonSelf+1] = value.Files[nonSelf+1], value.Files[nonSelf]
		}},
		{"release ID", func(value *releasemanifest.Manifest) { value.ReleaseID = "other-release" }},
		{"compatibility", func(value *releasemanifest.Manifest) { value.Compatibility.ServiceHostRPCVersion++ }},
		{"self root", func(value *releasemanifest.Manifest) {
			value.Files[self].Root = releasemanifest.RootTrustedConfiguration
		}},
		{"self path", func(value *releasemanifest.Manifest) { value.Files[self].Path = `native\other.exe` }},
		{"self role", func(value *releasemanifest.Manifest) { value.Files[self].Role = releasemanifest.RoleNodeRuntime }},
		{"self zero size", func(value *releasemanifest.Manifest) { value.Files[self].Size = "0" }},
		{"self oversized", func(value *releasemanifest.Manifest) {
			value.Files[self].Size = strconv.FormatUint(releaseprofile.MaximumServiceHostBytes+1, 10)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := cloneTestManifest(fixture.manifest)
			test.mutate(&manifest)
			if _, err := bindReleaseManifest(fixture.authority, manifest, testManifestDigest(manifest)); !errors.Is(err, ErrReleaseAuthority) {
				t.Fatalf("mutated manifest returned %v, want ErrReleaseAuthority", err)
			}
		})
	}
}

func TestBindReleaseManifestAllowsBoundedRuntimeSelfFields(t *testing.T) {
	fixture := newInstallFixture(t)
	self := serviceHostIndex(fixture.manifest)
	manifest := cloneTestManifest(fixture.manifest)
	manifest.Files[self].Size = strconv.FormatUint(releaseprofile.MaximumServiceHostBytes, 10)
	manifest.Files[self].SHA256 = strings.Repeat("a", sha256.Size*2)
	canonical, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		t.Fatalf("marshal maximum-size self manifest: %v", err)
	}
	manifest, err = releasemanifest.Parse(canonical)
	if err != nil {
		t.Fatalf("parse maximum-size self manifest: %v", err)
	}
	digest := sha256.Sum256(canonical)
	binding, err := bindReleaseManifest(fixture.authority, manifest, fmt.Sprintf("%x", digest))
	if err != nil {
		t.Fatalf("bind maximum-size runtime self: %v", err)
	}
	if binding.ServiceHost().Size != strconv.FormatUint(releaseprofile.MaximumServiceHostBytes, 10) ||
		binding.ServiceHost().SHA256 != strings.Repeat("a", sha256.Size*2) {
		t.Fatal("runtime self hash or maximum size was not preserved")
	}
}

func TestReleaseBindingAndEvidenceGettersAreCopyOnly(t *testing.T) {
	fixture := newInstallFixture(t)
	evidence, err := verifyWithDependencies(
		context.Background(),
		fixture.options,
		fixture.authority,
		fixture.dependencies(),
	)
	if err != nil {
		t.Fatalf("verify fixture: %v", err)
	}
	binding, ok := evidence.ReleaseBinding()
	if !ok || binding.Validate() != nil || binding.TemplateDigest() != fixture.authority.templateDigest ||
		binding.ApprovedSignerCertificateDERSHA256() != testSignerDigest ||
		evidence.ReleaseTemplateDigest() != fixture.authority.templateDigest ||
		evidence.ApprovedSignerCertificateDERSHA256() != testSignerDigest {
		t.Fatal("release authority getters omitted the compiled binding")
	}
	dependencies := binding.Dependencies()
	dependencies[0].Path = `tampered.exe`
	again, ok := evidence.ReleaseBinding()
	if !ok || again.Dependencies()[0].Path == `tampered.exe` {
		t.Fatal("release binding getter retained caller-owned dependency storage")
	}
}

func TestEvidenceValidateRejectsReleaseAuthorityMutation(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*evidenceState)
	}{
		{"template digest", func(state *evidenceState) {
			state.releaseBinding.templateDigest = [sha256.Size]byte{}
		}},
		{"signer pin", func(state *evidenceState) {
			state.releaseBinding.signerPin = strings.Repeat("e", sha256.Size*2)
		}},
		{"dependency", func(state *evidenceState) {
			state.releaseBinding.dependencies[0].Path = `other.exe`
		}},
		{"self descriptor", func(state *evidenceState) {
			state.releaseBinding.serviceHost.Path = `native\other.exe`
		}},
		{"self digest", func(state *evidenceState) {
			state.releaseBinding.serviceHost.SHA256 = strings.Repeat("e", sha256.Size*2)
		}},
		{"configuration manifest digest", func(state *evidenceState) {
			state.controlConfig.Installation.ManifestSHA256 = strings.Repeat("e", sha256.Size*2)
			state.executorConfig.Installation.ManifestSHA256 = strings.Repeat("e", sha256.Size*2)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newInstallFixture(t)
			evidence, err := verifyWithDependencies(
				context.Background(),
				fixture.options,
				fixture.authority,
				fixture.dependencies(),
			)
			if err != nil {
				t.Fatalf("verify fixture: %v", err)
			}
			test.mutate(evidence.state)
			if evidence.Validate() == nil {
				t.Fatal("mutated release authority evidence validated")
			}
		})
	}
}

func rewriteFixtureBootstraps(
	t *testing.T,
	fixture *installFixture,
	mutate func(*config.Config),
) {
	t.Helper()
	for _, relative := range []string{
		releasemanifest.ControlBootstrapConfigurationPath,
		releasemanifest.ExecutorBootstrapConfigurationPath,
	} {
		node := fixture.fs.mustNode(testTrustedRoot + `\` + relative)
		value, err := config.Parse(node.data)
		if err != nil {
			t.Fatalf("parse fixture bootstrap %s: %v", relative, err)
		}
		mutate(&value)
		document, err := config.MarshalCanonical(value)
		if err != nil {
			t.Fatalf("marshal fixture bootstrap %s: %v", relative, err)
		}
		node.data = document
	}
}

func firstNonServiceHostIndex(manifest releasemanifest.Manifest) int {
	for index, file := range manifest.Files {
		if file.Role != releasemanifest.RoleServiceHost {
			return index
		}
	}
	panic("fixture manifest has no non-ServiceHost dependency")
}

func serviceHostIndex(manifest releasemanifest.Manifest) int {
	for index, file := range manifest.Files {
		if file.Role == releasemanifest.RoleServiceHost {
			return index
		}
	}
	panic("fixture manifest has no ServiceHost entry")
}

func cloneTestManifest(value releasemanifest.Manifest) releasemanifest.Manifest {
	value.Files = append([]releasemanifest.File(nil), value.Files...)
	return value
}

func testManifestDigest(value releasemanifest.Manifest) string {
	document, err := releasemanifest.MarshalCanonical(value)
	if err != nil {
		return strings.Repeat("f", sha256.Size*2)
	}
	digest := sha256.Sum256(document)
	return fmt.Sprintf("%x", digest)
}

type fakeReleaseAuthoritySource struct {
	facts          releaseAuthorityFacts
	secondFacts    *releaseAuthorityFacts
	secondDigest   [sha256.Size]byte
	validateErrors map[int]error
	digestErrors   map[int]error
	validateCalls  int
	digestCalls    int
	calls          []string
}

func (source *fakeReleaseAuthoritySource) Validate() error {
	source.calls = append(source.calls, "validate")
	source.validateCalls++
	return source.validateErrors[source.validateCalls]
}

func (source *fakeReleaseAuthoritySource) Digest() ([sha256.Size]byte, error) {
	source.calls = append(source.calls, "digest")
	source.digestCalls++
	if err := source.digestErrors[source.digestCalls]; err != nil {
		return [sha256.Size]byte{}, err
	}
	if source.digestCalls == 2 && source.secondDigest != ([sha256.Size]byte{}) {
		return source.secondDigest, nil
	}
	return source.facts.templateDigest, nil
}

func (source *fakeReleaseAuthoritySource) currentFacts() releaseAuthorityFacts {
	if source.digestCalls >= 2 && source.secondFacts != nil {
		return *source.secondFacts
	}
	return source.facts
}

func (source *fakeReleaseAuthoritySource) SchemaVersion() uint32 {
	source.calls = append(source.calls, "schema")
	return source.currentFacts().schemaVersion
}

func (source *fakeReleaseAuthoritySource) ProfileID() string {
	source.calls = append(source.calls, "profile")
	return source.currentFacts().profileID
}

func (source *fakeReleaseAuthoritySource) ReleaseID() string {
	source.calls = append(source.calls, "release")
	return source.currentFacts().releaseID
}

func (source *fakeReleaseAuthoritySource) Compatibility() releasemanifest.Compatibility {
	source.calls = append(source.calls, "compatibility")
	return source.currentFacts().compatibility
}

func (source *fakeReleaseAuthoritySource) AuthenticodeLeafSignerCertificateDERSHA256() string {
	source.calls = append(source.calls, "signer")
	return source.currentFacts().signerPin
}

func (source *fakeReleaseAuthoritySource) Dependencies() []releaseprofile.Dependency {
	source.calls = append(source.calls, "dependencies")
	return append([]releaseprofile.Dependency(nil), source.currentFacts().dependencies...)
}

func (source *fakeReleaseAuthoritySource) ServiceHost() releaseprofile.SelfRequirement {
	source.calls = append(source.calls, "self")
	return source.currentFacts().serviceHost
}
