package preflight

import (
	"crypto/sha256"
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
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
			wantBindings := 7 + len(fixture.manifest.Files)
			if len(bindings) != wantBindings {
				t.Fatalf("binding count = %d, want %d", len(bindings), wantBindings)
			}
			for index, file := range fixture.manifest.Files {
				profileBinding := bindings[7+index]
				if profileBinding.Manifest.File != file {
					t.Fatalf("profile binding %d = %#v, want manifest file %#v", index, profileBinding.Manifest.File, file)
				}
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
	fixture.installation.release.dependencies[0].Path = `changed\dependency.exe`
	fixture.installation.files[0].Object.Evidence.Security.SelfRelativeDescriptor[0] ^= 0xff

	control := evidence.ControlConfiguration()
	originalByte := control.Read.Data[0]
	originalWorkerNodeID := control.Configuration.WorkerNodeID
	originalReserve := control.Configuration.Limits.ForceTerminationReserveMilliseconds
	control.Read.Data[0] ^= 0xff
	control.Configuration.WorkerNodeID = "changed-node"
	control.Configuration.Limits.ForceTerminationReserveMilliseconds++
	control.Configuration.Node.Environment["PATH"] = `C:\Changed`
	files := evidence.Files()
	originalDescriptorByte := files[0].Object.Evidence.Security.SelfRelativeDescriptor[1]
	files[0].Object.Evidence.Security.SelfRelativeDescriptor[1] ^= 0xff
	releaseDigest := evidence.ReleaseTemplateDigest()
	releaseDigest[0] ^= 0xff
	bindings := evidence.FileBindings()
	originalBindingDescriptorByte := bindings[0].VerifiedFile.Object.Evidence.Security.SelfRelativeDescriptor[1]
	bindings[0].VerifiedFile.Object.Evidence.Security.SelfRelativeDescriptor[1] ^= 0xff

	controlAgain := evidence.ControlConfiguration()
	filesAgain := evidence.Files()
	if controlAgain.Read.Data[0] != originalByte ||
		controlAgain.Configuration.WorkerNodeID != originalWorkerNodeID ||
		controlAgain.Configuration.Limits.ForceTerminationReserveMilliseconds != originalReserve ||
		controlAgain.Configuration.Node.Environment["PATH"] == `C:\Changed` ||
		filesAgain[0].Object.Evidence.Security.SelfRelativeDescriptor[1] != originalDescriptorByte ||
		evidence.ReleaseTemplateDigest() == releaseDigest ||
		evidence.FileBindings()[0].VerifiedFile.Object.Evidence.Security.SelfRelativeDescriptor[1] != originalBindingDescriptorByte {
		t.Fatal("Evidence accessor exposed mutable internal storage")
	}
}

func TestValidateConfigurationPairRejectsEveryCrossConfigurationMismatch(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	tests := []struct {
		name   string
		mutate func(*config.Config, *config.Config)
	}{
		{"own and peer identity", func(_ *config.Config, executor *config.Config) { executor.PeerService.Name += ".Other" }},
		{"worker node ID", func(_ *config.Config, executor *config.Config) { executor.WorkerNodeID = "powertoys-node:02" }},
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
		{"maximum frame", func(_ *config.Config, executor *config.Config) { executor.Limits.MaximumFrameBytes-- }},
		{"maximum queue", func(_ *config.Config, executor *config.Config) {
			executor.Limits.MaximumQueuedBytesPerDirection++
		}},
		{"connect timeout", func(_ *config.Config, executor *config.Config) {
			executor.Limits.ConnectTimeoutMilliseconds++
		}},
		{"shutdown total", func(_ *config.Config, executor *config.Config) {
			executor.Limits.ShutdownTimeoutMilliseconds++
		}},
		{"force termination reserve", func(_ *config.Config, executor *config.Config) {
			executor.Limits.ForceTerminationReserveMilliseconds++
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
		{"worker node ID", func(f *compositionFixture) { f.executor.WorkerNodeID = "powertoys-node:02" }},
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
		{"maximum queue", func(f *compositionFixture) { f.executor.Limits.MaximumQueuedBytesPerDirection++ }},
		{"connect timeout", func(f *compositionFixture) { f.executor.Limits.ConnectTimeoutMilliseconds++ }},
		{"shutdown total", func(f *compositionFixture) { f.executor.Limits.ShutdownTimeoutMilliseconds++ }},
		{"force termination reserve", func(f *compositionFixture) {
			f.executor.Limits.ForceTerminationReserveMilliseconds++
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
			name: "verified signer pin", code: ErrorReleaseAuthority,
			mutate: func(f *compositionFixture) { f.installation.release.signerPin = strings.Repeat("a", 64) },
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

func TestComposeRequiresCompleteOpaqueReleaseBinding(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*releaseBindingSnapshot)
	}{
		{"unbound", func(release *releaseBindingSnapshot) { release.bound = false }},
		{"template digest", func(release *releaseBindingSnapshot) { release.templateDigest = [32]byte{} }},
		{"manifest digest", func(release *releaseBindingSnapshot) { release.manifestSHA256 = strings.Repeat("a", 64) }},
		{"template schema", func(release *releaseBindingSnapshot) { release.templateSchemaVersion++ }},
		{"profile ID", func(release *releaseBindingSnapshot) { release.profileID = "other" }},
		{"release ID", func(release *releaseBindingSnapshot) { release.releaseID = "other" }},
		{"compatibility", func(release *releaseBindingSnapshot) { release.compatibility.ServiceHostRPCVersion++ }},
		{"signer", func(release *releaseBindingSnapshot) { release.signerPin = strings.Repeat("a", 64) }},
		{"missing dependency", func(release *releaseBindingSnapshot) {
			release.dependencies = release.dependencies[:len(release.dependencies)-1]
		}},
		{"extra dependency", func(release *releaseBindingSnapshot) {
			release.dependencies = append(release.dependencies, release.dependencies[0])
		}},
		{"duplicate dependency", func(release *releaseBindingSnapshot) {
			release.dependencies[len(release.dependencies)-1] = release.dependencies[0]
		}},
		{"dependency order", func(release *releaseBindingSnapshot) {
			release.dependencies[0], release.dependencies[1] = release.dependencies[1], release.dependencies[0]
		}},
		{"role mismatch", func(release *releaseBindingSnapshot) {
			release.dependencies[0].Role = releasemanifest.RolePrompt
		}},
		{"digest mismatch", func(release *releaseBindingSnapshot) {
			release.dependencies[0].SHA256 = strings.Repeat("a", 64)
		}},
		{"size mismatch", func(release *releaseBindingSnapshot) { release.dependencies[0].Size = "2" }},
		{"root mismatch", func(release *releaseBindingSnapshot) {
			release.dependencies[0].Root = releasemanifest.RootTrustedConfiguration
		}},
		{"path mismatch", func(release *releaseBindingSnapshot) { release.dependencies[0].Path += ".other" }},
		{"path case mismatch", func(release *releaseBindingSnapshot) {
			release.dependencies[0].Path = strings.ToUpper(release.dependencies[0].Path)
		}},
		{"self path", func(release *releaseBindingSnapshot) { release.serviceHost.Path += ".other" }},
		{"self role", func(release *releaseBindingSnapshot) { release.serviceHost.Role = releasemanifest.RoleNodeRuntime }},
		{"self digest", func(release *releaseBindingSnapshot) { release.serviceHost.SHA256 = strings.Repeat("a", 64) }},
		{"self size", func(release *releaseBindingSnapshot) { release.serviceHost.Size = "2" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCompositionFixture(t, config.RoleControl)
			test.mutate(&fixture.installation.release)
			_, err := composeSnapshots(fixture.input)
			assertPreflightErrorCode(t, err, ErrorReleaseAuthority)
		})
	}
}

func TestReleaseBindingCoversFutureRolesAndBindsInManifestOrder(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	requiredRoles := map[releasemanifest.FileRole]bool{
		releasemanifest.RoleSchema:        false,
		releasemanifest.RoleRecipe:        false,
		releasemanifest.RoleRuntimeData:   false,
		releasemanifest.RolePolicy:        false,
		releasemanifest.RoleTrustedConfig: false,
		releasemanifest.RoleLicense:       false,
	}
	for _, dependency := range fixture.installation.release.dependencies {
		if _, tracked := requiredRoles[dependency.Role]; tracked {
			requiredRoles[dependency.Role] = true
		}
	}
	for role, present := range requiredRoles {
		if !present {
			t.Fatalf("release profile fixture lacks role %s", role)
		}
	}

	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	profileBindings := evidence.FileBindings()[7:]
	for index, file := range fixture.manifest.Files {
		if profileBindings[index].Manifest.File != file {
			t.Fatalf("profile binding %d is not in canonical manifest order", index)
		}
	}
}

func TestConfigurationPairRejectsMixedBootstrapSchemaVersions(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	fixture.executor.SchemaVersion = 3
	err := validateConfigurationPair(fixture.control, fixture.executor)
	assertPreflightErrorCode(t, err, ErrorConfigurationPair)
}

func TestPublicComposeRejectsZeroInstallationEvidenceFirst(t *testing.T) {
	_, err := Compose(Input{Role: config.RoleControl, ActualBootstrapPath: `C:\trusted\control-service-host.json`})
	assertPreflightErrorCode(t, err, ErrorInstallation)
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
