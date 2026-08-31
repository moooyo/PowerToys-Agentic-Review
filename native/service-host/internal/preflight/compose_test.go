package preflight

import (
	"crypto/sha256"
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/wincert"
)

func TestComposeReturnsDetachedProductionEvidenceForBothRoles(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			fixture := newCompositionFixture(t, role)
			evidence, err := composeSnapshots(fixture.input)
			if err != nil {
				t.Fatalf("Compose returned an error: %v", err)
			}
			if evidence.Role() != role || evidence.Configuration().Role != role ||
				!windowsPathEqual(evidence.ActualBootstrapPath(), fixture.input.actualBootstrapPath) {
				t.Fatalf("Compose returned the wrong selected role evidence: %#v", evidence.Configuration())
			}
			if evidence.Manifest().SHA256 != fixture.control.Installation.ManifestSHA256 ||
				evidence.ApprovedSignerCertificateDERSHA256() != fixture.control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 ||
				len(evidence.Files()) != len(fixture.manifest.Files) || len(evidence.Roots()) != 2 {
				t.Fatal("Compose omitted installation evidence")
			}
			bindings := evidence.FileBindings()
			wantBindings := 8 + len(fixture.manifest.Files)
			if len(bindings) != wantBindings {
				t.Fatalf("binding count = %d, want %d", len(bindings), wantBindings)
			}
			for index, file := range fixture.manifest.Files {
				profileBinding := bindings[8+index]
				if profileBinding.Manifest.File != file {
					t.Fatalf("profile binding %d = %#v, want manifest file %#v", index, profileBinding.Manifest.File, file)
				}
			}
			_, hasCredentials := evidence.ControlCredentials()
			if hasCredentials != (role == config.RoleControl) {
				t.Fatal("Compose returned key evidence for the wrong role")
			}
		})
	}
}

func TestEvidenceAccessorsReturnDetachedCopies(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}

	fixture.input.installation.controlBootstrap.Data[0] ^= 0xff
	fixture.input.releaseProfile.Dependencies[0].Path = `changed\dependency.exe`
	fixture.installation.files[0].Object.Evidence.Security.SelfRelativeDescriptor[0] ^= 0xff
	fixture.input.credentials.bound = false

	control := evidence.ControlConfiguration()
	originalByte := control.Read.Data[0]
	control.Read.Data[0] ^= 0xff
	control.Configuration.Node.Environment["PATH"] = `C:\Changed`
	files := evidence.Files()
	originalDescriptorByte := files[0].Object.Evidence.Security.SelfRelativeDescriptor[1]
	files[0].Object.Evidence.Security.SelfRelativeDescriptor[1] ^= 0xff
	profile := evidence.ReleaseProfile()
	profile.Dependencies[0].Path = `changed\again.exe`
	bindings := evidence.FileBindings()
	originalBindingDescriptorByte := bindings[0].VerifiedFile.Object.Evidence.Security.SelfRelativeDescriptor[1]
	bindings[0].VerifiedFile.Object.Evidence.Security.SelfRelativeDescriptor[1] ^= 0xff

	controlAgain := evidence.ControlConfiguration()
	filesAgain := evidence.Files()
	if controlAgain.Read.Data[0] != originalByte ||
		controlAgain.Configuration.Node.Environment["PATH"] == `C:\Changed` ||
		filesAgain[0].Object.Evidence.Security.SelfRelativeDescriptor[1] != originalDescriptorByte ||
		evidence.ReleaseProfile().Dependencies[0].Path == `changed\again.exe` ||
		evidence.FileBindings()[0].VerifiedFile.Object.Evidence.Security.SelfRelativeDescriptor[1] != originalBindingDescriptorByte {
		t.Fatal("Evidence accessor exposed mutable internal storage")
	}
	if _, exists := evidence.ControlCredentials(); !exists {
		t.Fatal("Evidence retained an aliased credential binding")
	}
}

func TestValidateConfigurationPairRejectsEveryCrossConfigurationMismatch(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	tests := []struct {
		name   string
		mutate func(*config.Config, *config.Config)
	}{
		{"own and peer identity", func(_ *config.Config, executor *config.Config) { executor.PeerService.Name += ".Other" }},
		{"pipe", func(_ *config.Config, executor *config.Config) { executor.PipeName += ".other" }},
		{"installation root", func(_ *config.Config, executor *config.Config) { executor.Installation.Root += "2" }},
		{"trusted root", func(_ *config.Config, executor *config.Config) { executor.Installation.TrustedConfigurationRoot += "2" }},
		{"release", func(_ *config.Config, executor *config.Config) { executor.Installation.ReleaseID += ".other" }},
		{"manifest path", func(_ *config.Config, executor *config.Config) {
			executor.Installation.ManifestPath = testInstallationRoot + `\other.json`
		}},
		{"manifest digest", func(_ *config.Config, executor *config.Config) {
			executor.Installation.ManifestSHA256 = strings.Repeat("a", 64)
		}},
		{"signer pin", func(_ *config.Config, executor *config.Config) {
			executor.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 = strings.Repeat("b", 64)
		}},
		{"data root", func(control *config.Config, executor *config.Config) { executor.Node.DataRoot = control.Node.DataRoot }},
		{"local authority", func(_ *config.Config, executor *config.Config) {
			executor.Executor.LocalAuthorityPublicKeySHA256 = strings.Repeat("c", 64)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			control := cloneConfig(fixture.control)
			executor := cloneConfig(fixture.executor)
			test.mutate(&control, &executor)
			assertPreflightErrorCode(t, validateConfigurationPair(control, executor), ErrorConfigurationPair)
		})
	}
}

func TestComposeRejectsIndividuallyValidCrossConfigurationMismatches(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*compositionFixture)
	}{
		{"release", func(f *compositionFixture) { f.executor.Installation.ReleaseID += ".other" }},
		{"manifest digest", func(f *compositionFixture) { f.executor.Installation.ManifestSHA256 = strings.Repeat("a", 64) }},
		{"signer pin", func(f *compositionFixture) {
			f.executor.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 = strings.Repeat("b", 64)
		}},
		{"manifest path", func(f *compositionFixture) {
			f.executor.Installation.ManifestPath = testInstallationRoot + `\other-manifest.json`
		}},
		{"data root", func(f *compositionFixture) {
			f.executor.Node = nodeConfiguration(
				config.RoleExecutor,
				requireManifestFixture(f.manifest, releasemanifest.RoleNodeRuntime, `runtime\node.exe`),
				requireManifestFixture(f.manifest, releasemanifest.RoleExecutorBundle, `app\executor.mjs`),
				f.control.Node.DataRoot,
			)
		}},
		{"local authority", func(f *compositionFixture) {
			f.executor.Executor.LocalAuthorityPublicKeySHA256 = strings.Repeat("c", 64)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCompositionFixture(t, config.RoleControl)
			test.mutate(&fixture)
			fixture.installation.executorConfig = cloneConfig(fixture.executor)
			replaceConfigurationRead(t, &fixture.input.installation.executorBootstrap, fixture.executor)
			_, err := composeSnapshots(fixture.input)
			assertPreflightErrorCode(t, err, ErrorConfigurationPair)
		})
	}
}

func TestComposeBindsActualBootstrapPathDigestAndSize(t *testing.T) {
	tests := []struct {
		name   string
		code   ErrorCode
		mutate func(*compositionFixture)
	}{
		{
			name: "wrong selected path", code: ErrorInput,
			mutate: func(f *compositionFixture) {
				f.input.actualBootstrapPath = f.input.installation.executorBootstrap.File.Path
			},
		},
		{
			name: "content digest", code: ErrorConfiguration,
			mutate: func(f *compositionFixture) { f.input.installation.controlBootstrap.ContentSHA256[0] ^= 0xff },
		},
		{
			name: "reported size", code: ErrorConfiguration,
			mutate: func(f *compositionFixture) { f.input.installation.controlBootstrap.File.Evidence.Size++ },
		},
		{
			name: "nested fixed name", code: ErrorBootstrapBinding,
			mutate: func(f *compositionFixture) {
				f.input.installation.controlBootstrap = f.factory.read(
					testTrustedRoot+`\nested\`+releasemanifest.ControlBootstrapConfigurationPath,
					f.input.installation.controlBootstrap.Data,
				)
				f.input.actualBootstrapPath = f.input.installation.controlBootstrap.File.Path
				f.installation.actualBootstrapPath = f.input.actualBootstrapPath
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCompositionFixture(t, config.RoleControl)
			test.mutate(&fixture)
			_, err := composeSnapshots(fixture.input)
			assertPreflightErrorCode(t, err, test.code)
		})
	}

	caseInsensitive := newCompositionFixture(t, config.RoleControl)
	caseInsensitive.input.actualBootstrapPath = strings.ToUpper(caseInsensitive.input.actualBootstrapPath)
	if _, err := composeSnapshots(caseInsensitive.input); err != nil {
		t.Fatalf("Compose rejected case-insensitive Windows path identity: %v", err)
	}
}

func TestComposeRejectsManifestAndVerifiedFileMismatch(t *testing.T) {
	tests := []struct {
		name   string
		code   ErrorCode
		mutate func(*compositionFixture)
	}{
		{
			name: "manifest content digest", code: ErrorManifest,
			mutate: func(f *compositionFixture) { f.installation.manifestRead.ContentSHA256[0] ^= 0xff },
		},
		{
			name: "noncanonical manifest", code: ErrorManifest,
			mutate: func(f *compositionFixture) {
				f.installation.manifestRead.Data = append(f.installation.manifestRead.Data, '\n')
				f.installation.manifestRead.ContentSHA256 = secureconfig.Digest(sha256.Sum256(f.installation.manifestRead.Data))
				f.installation.manifestRead.File.Evidence.Size = uint64(len(f.installation.manifestRead.Data))
			},
		},
		{
			name: "both pins disagree with manifest", code: ErrorManifestBinding,
			mutate: func(f *compositionFixture) {
				f.control.Installation.ManifestSHA256 = strings.Repeat("a", 64)
				f.executor.Installation.ManifestSHA256 = strings.Repeat("a", 64)
				f.installation.controlConfig = cloneConfig(f.control)
				f.installation.executorConfig = cloneConfig(f.executor)
				replaceConfigurationRead(t, &f.installation.controlBootstrap, f.control)
				replaceConfigurationRead(t, &f.installation.executorBootstrap, f.executor)
			},
		},
		{
			name: "missing verified file", code: ErrorInstallation,
			mutate: func(f *compositionFixture) { f.installation.files = f.installation.files[:len(f.installation.files)-1] },
		},
		{
			name: "verified digest", code: ErrorInstallation,
			mutate: func(f *compositionFixture) { f.installation.files[0].SHA256 = strings.Repeat("a", 64) },
		},
		{
			name: "verified absolute path", code: ErrorInstallation,
			mutate: func(f *compositionFixture) { f.installation.files[0].AbsolutePath = `C:\Elsewhere\node.exe` },
		},
		{
			name: "verified signer pin", code: ErrorInstallation,
			mutate: func(f *compositionFixture) { f.installation.approvedSignerPin = strings.Repeat("a", 64) },
		},
		{
			name: "duplicate file identity", code: ErrorInstallation,
			mutate: func(f *compositionFixture) {
				f.installation.files[1].Object.Evidence.Identity = f.installation.files[0].Object.Evidence.Identity
			},
		},
		{
			name: "duplicate root identity", code: ErrorInstallation,
			mutate: func(f *compositionFixture) {
				identity := f.installation.roots[0].Object.Evidence.Identity
				f.installation.roots[1].Object.Evidence.Identity = identity
				rebuildObjectEvidence(t, &f.installation.roots[1].Object)
				for _, read := range []*secureconfig.Result{&f.installation.controlBootstrap, &f.installation.executorBootstrap} {
					for index := range read.Ancestors {
						if windowsPathEqual(read.Ancestors[index].Path, testTrustedRoot) {
							read.Ancestors[index].Evidence.Identity = identity
							rebuildObjectEvidence(t, &read.Ancestors[index])
						}
					}
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCompositionFixture(t, config.RoleControl)
			test.mutate(&fixture)
			_, err := composeSnapshots(fixture.input)
			assertPreflightErrorCode(t, err, test.code)
		})
	}
}

func TestComposeRequiresCompleteConcreteReleaseProfile(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*ReleaseProfile)
	}{
		{"profile ID", func(profile *ReleaseProfile) { profile.ID = "other" }},
		{"missing dependency", func(profile *ReleaseProfile) {
			profile.Dependencies = profile.Dependencies[:len(profile.Dependencies)-1]
		}},
		{"extra dependency", func(profile *ReleaseProfile) {
			profile.Dependencies = append(profile.Dependencies, profile.Dependencies[0])
		}},
		{"duplicate dependency", func(profile *ReleaseProfile) {
			profile.Dependencies[len(profile.Dependencies)-1] = profile.Dependencies[0]
		}},
		{"role mismatch", func(profile *ReleaseProfile) {
			profile.Dependencies[0].Role = releasemanifest.RolePrompt
		}},
		{"digest mismatch", func(profile *ReleaseProfile) {
			profile.Dependencies[0].SHA256 = strings.Repeat("a", 64)
		}},
		{"root mismatch", func(profile *ReleaseProfile) {
			profile.Dependencies[0].Root = releasemanifest.RootTrustedConfiguration
		}},
		{"path mismatch", func(profile *ReleaseProfile) {
			profile.Dependencies[0].Path += ".other"
		}},
		{"path case mismatch", func(profile *ReleaseProfile) {
			profile.Dependencies[0].Path = strings.ToUpper(profile.Dependencies[0].Path)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCompositionFixture(t, config.RoleControl)
			test.mutate(&fixture.input.releaseProfile)
			_, err := composeSnapshots(fixture.input)
			assertPreflightErrorCode(t, err, ErrorReleaseProfile)
		})
	}
}

func TestReleaseProfileCoversFutureRolesAndBindsInManifestOrder(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	requiredRoles := map[releasemanifest.FileRole]bool{
		releasemanifest.RoleSchema:        false,
		releasemanifest.RoleRecipe:        false,
		releasemanifest.RoleRuntimeData:   false,
		releasemanifest.RolePolicy:        false,
		releasemanifest.RoleTrustedConfig: false,
		releasemanifest.RoleLicense:       false,
	}
	for _, dependency := range fixture.input.releaseProfile.Dependencies {
		if _, tracked := requiredRoles[dependency.Role]; tracked {
			requiredRoles[dependency.Role] = true
		}
	}
	for role, present := range requiredRoles {
		if !present {
			t.Fatalf("release profile fixture lacks role %s", role)
		}
	}

	dependencies := fixture.input.releaseProfile.Dependencies
	for left, right := 0, len(dependencies)-1; left < right; left, right = left+1, right-1 {
		dependencies[left], dependencies[right] = dependencies[right], dependencies[left]
	}
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	profileBindings := evidence.FileBindings()[8:]
	for index, file := range fixture.manifest.Files {
		if profileBindings[index].Manifest.File != file {
			t.Fatalf("profile binding %d is not in canonical manifest order", index)
		}
	}
}

func TestComposeRejectsDOSShortNameFormInConfiguration(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	dataRoot := `C:\PROGRA~1\AgenticReview\Control`
	fixture.control.Node.DataRoot = dataRoot
	fixture.control.Node.WorkingDirectory = dataRoot + `\Work`
	fixture.control.Node.Environment["TEMP"] = dataRoot + `\Temp`
	fixture.control.Node.Environment["TMP"] = dataRoot + `\Temp`
	fixture.control.Node.Environment["USERPROFILE"] = dataRoot + `\Profile`
	fixture.control.Node.Environment["APPDATA"] = dataRoot + `\Profile\AppData`
	fixture.control.Node.Environment["LOCALAPPDATA"] = dataRoot + `\Profile\LocalAppData`
	fixture.installation.controlConfig = cloneConfig(fixture.control)
	replaceConfigurationRead(t, &fixture.installation.controlBootstrap, fixture.control)
	_, err := composeSnapshots(fixture.input)
	assertPreflightErrorCode(t, err, ErrorConfiguration)
}

func TestValidateControlCredentialFactsBindsPinsAndRejectsKeyReuse(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	validLocal, validMTLS := credentialFactFixtures(t, fixture.control)
	tests := []struct {
		name   string
		mutate func(*localCredentialFacts, *mtlsCredentialFacts)
	}{
		{"local key name", func(local *localCredentialFacts, _ *mtlsCredentialFacts) { local.keyName += ".other" }},
		{"local descriptor", func(local *localCredentialFacts, _ *mtlsCredentialFacts) { local.keySecurityDescriptor[0] ^= 0xff }},
		{"local public key", func(local *localCredentialFacts, _ *mtlsCredentialFacts) { local.publicKeySPKI[0] ^= 0xff }},
		{"mTLS scope", func(_ *localCredentialFacts, mtls *mtlsCredentialFacts) { mtls.storeScope = "CurrentUser" }},
		{"mTLS store", func(_ *localCredentialFacts, mtls *mtlsCredentialFacts) { mtls.storeName = "ROOT" }},
		{"certificate DER", func(_ *localCredentialFacts, mtls *mtlsCredentialFacts) { mtls.certificateDER[0] ^= 0xff }},
		{"mTLS descriptor", func(_ *localCredentialFacts, mtls *mtlsCredentialFacts) { mtls.keySecurityDescriptor[0] ^= 0xff }},
		{"local Control SID", func(local *localCredentialFacts, _ *mtlsCredentialFacts) {
			local.validatedControlServiceSID = config.ExecutorServiceSID
		}},
		{"local Executor SID", func(local *localCredentialFacts, _ *mtlsCredentialFacts) {
			local.validatedExecutorSID = config.ControlServiceSID
		}},
		{"mTLS Control SID", func(_ *localCredentialFacts, mtls *mtlsCredentialFacts) {
			mtls.validatedControlServiceSID = config.ExecutorServiceSID
		}},
		{"mTLS Executor SID", func(_ *localCredentialFacts, mtls *mtlsCredentialFacts) {
			mtls.validatedExecutorSID = config.ControlServiceSID
		}},
		{"same identity", func(local *localCredentialFacts, mtls *mtlsCredentialFacts) { mtls.identity = local.identity }},
		{"same public key", func(local *localCredentialFacts, mtls *mtlsCredentialFacts) { mtls.publicKeySPKI = local.publicKeySPKI }},
		{"wrong provider", func(local *localCredentialFacts, _ *mtlsCredentialFacts) {
			local.identity.ProviderName = "Other Provider"
		}},
		{"user key", func(_ *localCredentialFacts, mtls *mtlsCredentialFacts) { mtls.identity.MachineKey = false }},
		{"empty unique name", func(local *localCredentialFacts, _ *mtlsCredentialFacts) { local.identity.UniqueName = "" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			local := validLocal
			mtls := validMTLS
			test.mutate(&local, &mtls)
			err := validateControlCredentialFacts(fixture.control, local, mtls)
			assertPreflightErrorCode(t, err, ErrorCredentialIdentity)
		})
	}
	if err := validateControlCredentialFacts(fixture.control, validLocal, validMTLS); err != nil {
		t.Fatalf("valid credential facts were rejected: %v", err)
	}
}

func TestComposeSnapshotsRequiresRoleAppropriateCredentials(t *testing.T) {
	control := newCompositionFixture(t, config.RoleControl)
	control.input.credentials = nil
	_, err := composeSnapshots(control.input)
	assertPreflightErrorCode(t, err, ErrorCredentialIdentity)

	executor := newCompositionFixture(t, config.RoleExecutor)
	executor.input.credentials = &ControlCredentialEvidence{bound: true}
	_, err = composeSnapshots(executor.input)
	assertPreflightErrorCode(t, err, ErrorCredentialIdentity)
}

func TestPublicComposeRejectsZeroInstallationEvidenceFirst(t *testing.T) {
	_, err := Compose(Input{Role: config.RoleControl, ActualBootstrapPath: `C:\trusted\control-service-host.json`})
	assertPreflightErrorCode(t, err, ErrorInstallation)
}

func TestBindControlCredentialsRejectsMissingConcreteObjects(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	_, err := BindControlCredentials(fixture.control, nil, nil)
	assertPreflightErrorCode(t, err, ErrorCredentialIdentity)
}

func credentialFactFixtures(
	t *testing.T,
	configuration config.Config,
) (localCredentialFacts, mtlsCredentialFacts) {
	t.Helper()
	localSPKI := mustDecodeDigest(t, configuration.Control.LocalAuthorityPublicKeySHA256)
	localDescriptor := mustDecodeDigest(t, configuration.Control.LocalAuthorityKeySecurityDescriptorSHA256)
	certificateDER := mustDecodeDigest(t, configuration.Control.ClientCertificateDERSHA256)
	mtlsDescriptor := mustDecodeDigest(t, configuration.Control.ClientPrivateKeySecurityDescriptorSHA256)
	mtlsSPKI := sha256.Sum256([]byte("distinct mTLS public key"))
	return localCredentialFacts{
			keyName:                    configuration.Control.LocalAuthorityCNGKeyName,
			keySecurityDescriptor:      localDescriptor,
			identity:                   cng.KeyIdentity{ProviderName: ApprovedCNGProvider, UniqueName: "local-authority", MachineKey: true},
			publicKeySPKI:              localSPKI,
			validatedControlServiceSID: configuration.OwnService.SID,
			validatedExecutorSID:       configuration.PeerService.SID,
		}, mtlsCredentialFacts{
			storeScope:                 wincert.LocalMachineStoreScope,
			storeName:                  configuration.Control.ClientCertificateStore,
			certificateDER:             certificateDER,
			keySecurityDescriptor:      mtlsDescriptor,
			identity:                   cng.KeyIdentity{ProviderName: ApprovedCNGProvider, UniqueName: "mtls", MachineKey: true},
			publicKeySPKI:              mtlsSPKI,
			validatedControlServiceSID: configuration.OwnService.SID,
			validatedExecutorSID:       configuration.PeerService.SID,
		}
}

func TestCompiledCompatibilityMatchesReleaseAndRuntimeConstants(t *testing.T) {
	if CompiledCompatibility() != releasemanifest.RequiredCompatibility() {
		t.Fatalf("compiled compatibility = %#v, want %#v", CompiledCompatibility(), releasemanifest.RequiredCompatibility())
	}
}

func assertPreflightErrorCode(t *testing.T, err error, code ErrorCode) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected preflight error %s", code)
	}
	var preflightErr *Error
	if !errors.As(err, &preflightErr) || preflightErr.Code != code {
		t.Fatalf("error = %T %v, want preflight code %s", err, err, code)
	}
}
