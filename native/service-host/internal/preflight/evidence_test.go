package preflight

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/dataroot"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

func TestEvidenceDigestAndRuntimePlanAreRoleLocal(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			fixture := newCompositionFixture(t, role)
			evidence, err := composeSnapshots(fixture.input)
			if err != nil {
				t.Fatal(err)
			}
			digest, err := evidence.Digest()
			if err != nil || digest == ([32]byte{}) {
				t.Fatalf("Digest = %x, %v", digest, err)
			}
			binding, exists := evidence.DataRootBinding()
			if !exists || binding.Role() != role || binding.Digest() != fixture.input.dataRoot.digest {
				t.Fatal("Evidence omitted the data-root binding")
			}
			plan, err := evidence.runtimePlan()
			if err != nil || plan.Role() != role || plan.PreflightDigest() != digest ||
				plan.DataRootDigest() != binding.Digest() || plan.Configuration().Role != role {
				t.Fatalf("RuntimePlan is inconsistent: %#v, %v", plan, err)
			}
			if err := plan.Validate(); err != nil {
				t.Fatalf("RuntimePlan.Validate returned %v", err)
			}
			if plan.Node().Path() != plan.Configuration().Node.ExecutablePath ||
				plan.Node().SHA256() != plan.Configuration().Node.ExecutableSHA256 ||
				plan.Bundle().Path() != plan.Configuration().Node.BundlePath ||
				plan.Bundle().SHA256() != plan.Configuration().Node.BundleSHA256 {
				t.Fatal("RuntimePlan omitted pinned Node inputs")
			}
			if role == config.RoleControl && plan.Configuration().Executor != nil ||
				role == config.RoleExecutor && plan.Configuration().Control != nil {
				t.Fatal("RuntimePlan contains the peer role configuration")
			}
			processHost, hasProcessHost := plan.ProcessHost()
			if hasProcessHost != (role == config.RoleExecutor) {
				t.Fatal("RuntimePlan exposed ProcessHost for the wrong role")
			}
			if hasProcessHost && (processHost.Path() != plan.Configuration().Executor.ProcessHostPath ||
				processHost.SHA256() != plan.Configuration().Executor.ProcessHostSHA256) {
				t.Fatal("RuntimePlan ProcessHost pin is inconsistent")
			}
			contents := plan.RuntimeContents()
			wantContents := 1
			if role == config.RoleExecutor {
				wantContents = 2
			}
			if len(contents) != wantContents {
				t.Fatalf("RuntimePlan content count = %d, want %d", len(contents), wantContents)
			}
			for _, content := range contents {
				if role == config.RoleControl && content.Role() != releasemanifest.RoleCABundle {
					t.Fatal("Control RuntimePlan contains Executor trust content")
				}
				if role == config.RoleExecutor && content.Role() == releasemanifest.RoleCABundle {
					t.Fatal("Executor RuntimePlan contains Control root CA content")
				}
			}
			if _, hasCredentials := evidence.ControlCredentials(); hasCredentials != (role == config.RoleControl) {
				t.Fatal("credential attestation is present for the wrong role")
			}
		})
	}
}

func TestEvidenceAndRuntimePlanContentAccessorsAreCopyOnly(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	original := evidence.RuntimeContents()[0].Bytes()[0]
	fixture.installation.contents[0].data[0] ^= 0xff
	content := evidence.RuntimeContents()
	content[0].data[0] ^= 0xff
	bytes := content[0].Bytes()
	bytes[0] ^= 0xff
	plan, err := evidence.runtimePlan()
	if err != nil {
		t.Fatal(err)
	}
	plan.configuration.Node.Environment["TEMP"] = `C:\Changed`
	plan.configuration.WorkerNodeID = "changed-node"
	plan.configuration.Limits.ForceTerminationReserveMilliseconds++
	plan.runtimeContents[0].data[0] ^= 0xff
	identity := evidence.Identity()
	identity.Token.Groups[0].SID = "changed"
	roots := evidence.Roots()
	rootAncestorID := roots[0].Ancestors[0].Evidence.Identity
	roots[0].Ancestors[0].Evidence.Identity.FileID[0] ^= 0xff
	dataRoot, exists := evidence.DataRootBinding()
	if !exists {
		t.Fatal("Evidence omitted data-root binding")
	}
	dataRoot.installationRoots[0].target.FileID[0] ^= 0xff
	if evidence.RuntimeContents()[0].Bytes()[0] != original ||
		evidence.RuntimePlanMustForTest(t).Configuration().Node.Environment["TEMP"] == `C:\Changed` ||
		evidence.RuntimePlanMustForTest(t).Configuration().WorkerNodeID == "changed-node" ||
		evidence.RuntimePlanMustForTest(t).Configuration().Limits.ForceTerminationReserveMilliseconds !=
			fixture.control.Limits.ForceTerminationReserveMilliseconds ||
		evidence.RuntimePlanMustForTest(t).RuntimeContents()[0].Bytes()[0] != original ||
		evidence.Identity().Token.Groups[0].SID == "changed" ||
		evidence.Roots()[0].Ancestors[0].Evidence.Identity != rootAncestorID ||
		evidence.DataRootBindingMustForTest(t).installationRoots[0].target == dataRoot.installationRoots[0].target {
		t.Fatal("runtime content or plan accessor aliases evidence storage")
	}
}

func (e Evidence) RuntimePlanMustForTest(t *testing.T) RuntimePlan {
	t.Helper()
	plan, err := e.runtimePlan()
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func (e Evidence) DataRootBindingMustForTest(t *testing.T) DataRootBinding {
	t.Helper()
	binding, exists := e.DataRootBinding()
	if !exists {
		t.Fatal("Evidence omitted data-root binding")
	}
	return binding
}

func TestComposeRejectsMissingOrMutatedRoleScopedContent(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*installationSnapshot)
	}{
		{"missing", func(value *installationSnapshot) { value.contents = nil }},
		{"wrong role", func(value *installationSnapshot) { value.contents[0].role = releasemanifest.RoleRecipe }},
		{"wrong path", func(value *installationSnapshot) { value.contents[0].path += ".other" }},
		{"wrong digest", func(value *installationSnapshot) { value.contents[0].sha256 = strings.Repeat("a", 64) }},
		{"wrong size", func(value *installationSnapshot) { value.contents[0].size++ }},
		{"tampered bytes", func(value *installationSnapshot) { value.contents[0].data[0] ^= 0xff }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCompositionFixture(t, config.RoleExecutor)
			test.mutate(fixture.installation)
			_, err := composeSnapshots(fixture.input)
			assertPreflightErrorCode(t, err, ErrorRuntimeContent)
		})
	}
}

func TestDataRootBindingRejectsClosedWrongRoleConfigAndObservation(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	if _, err := captureDataRootBinding(dataroot.Evidence{}, fixture.installation); !errors.Is(err, dataroot.ErrClosed) {
		t.Fatalf("zero/closed data-root evidence returned %v", err)
	}
	valid := dataRootFacts{
		role:              config.RoleControl,
		current:           cloneConfig(fixture.control),
		peer:              cloneConfig(fixture.executor),
		currentPath:       fixture.control.Node.DataRoot,
		peerPath:          fixture.executor.Node.DataRoot,
		peerObservation:   dataroot.PeerLiveRootNotObservedByDesign,
		installationRoots: cloneDataRootBinding(fixture.input.dataRoot).installationRoots,
		digest:            fixture.input.dataRoot.digest,
	}
	if _, err := validateDataRootFacts(valid, fixture.installation); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*dataRootFacts)
	}{
		{"zero digest", func(value *dataRootFacts) { value.digest = [32]byte{} }},
		{"wrong role", func(value *dataRootFacts) { value.role = config.RoleExecutor }},
		{"wrong current config", func(value *dataRootFacts) { value.current.Node.DataRoot += `\other` }},
		{"wrong peer config", func(value *dataRootFacts) { value.peer.Node.DataRoot += `\other` }},
		{"wrong current path", func(value *dataRootFacts) { value.currentPath += `\other` }},
		{"wrong peer path", func(value *dataRootFacts) { value.peerPath += `\other` }},
		{"wrong observation", func(value *dataRootFacts) { value.peerObservation = "observed" }},
		{"wrong installation root", func(value *dataRootFacts) { value.installationRoots[0].root = releasemanifest.RootTrustedConfiguration }},
		{"wrong installation path", func(value *dataRootFacts) { value.installationRoots[0].path += `\other` }},
		{"wrong installation target", func(value *dataRootFacts) { value.installationRoots[0].target.FileID[0] ^= 0xff }},
		{"wrong ancestor path", func(value *dataRootFacts) { value.installationRoots[0].ancestorPaths[0] += "other" }},
		{"wrong ancestor identity", func(value *dataRootFacts) { value.installationRoots[0].ancestors[0].FileID[0] ^= 0xff }},
		{"missing installation root", func(value *dataRootFacts) { value.installationRoots = value.installationRoots[:1] }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			candidate.current = cloneConfig(valid.current)
			candidate.peer = cloneConfig(valid.peer)
			candidate.installationRoots = cloneDataRootBinding(DataRootBinding{
				installationRoots: valid.installationRoots,
			}).installationRoots
			test.mutate(&candidate)
			_, err := validateDataRootFacts(candidate, fixture.installation)
			assertPreflightErrorCode(t, err, ErrorDataRoot)
		})
	}
}

func TestEvidenceDigestBindsEverySecurityInputAndIgnoresDiagnostics(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := evidence.Digest()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*Evidence)
	}{
		{"role", func(value *Evidence) { value.role = config.RoleExecutor }},
		{"bootstrap", func(value *Evidence) { value.control.Binding.SHA256 = strings.Repeat("a", 64) }},
		{"configuration", func(value *Evidence) { value.control.Configuration.Limits.ConnectTimeoutMilliseconds++ }},
		{"worker node ID", func(value *Evidence) { value.control.Configuration.WorkerNodeID = "powertoys-node:02" }},
		{"force termination reserve", func(value *Evidence) {
			value.control.Configuration.Limits.ForceTerminationReserveMilliseconds++
		}},
		{"Control read digest", func(value *Evidence) { value.control.Read.ContentSHA256[0] ^= 0xff }},
		{"Control read bytes", func(value *Evidence) { value.control.Read.Data[0] ^= 0xff }},
		{"Control read size", func(value *Evidence) { value.control.Read.File.Evidence.Size++ }},
		{"Control read file", func(value *Evidence) { value.control.Read.File.EvidenceSHA256[0] ^= 0xff }},
		{"Control read ancestor", func(value *Evidence) { value.control.Read.Ancestors[0].EvidenceSHA256[0] ^= 0xff }},
		{"Executor read digest", func(value *Evidence) { value.executor.Read.ContentSHA256[0] ^= 0xff }},
		{"Executor read bytes", func(value *Evidence) { value.executor.Read.Data[0] ^= 0xff }},
		{"Executor read file", func(value *Evidence) { value.executor.Read.File.EvidenceSHA256[0] ^= 0xff }},
		{"Executor read ancestor", func(value *Evidence) { value.executor.Read.Ancestors[0].EvidenceSHA256[0] ^= 0xff }},
		{"manifest", func(value *Evidence) { value.manifest.SHA256 = strings.Repeat("a", 64) }},
		{"manifest read digest", func(value *Evidence) { value.manifest.Read.ContentSHA256[0] ^= 0xff }},
		{"manifest read bytes", func(value *Evidence) { value.manifest.Read.Data[0] ^= 0xff }},
		{"manifest read file", func(value *Evidence) { value.manifest.Read.File.EvidenceSHA256[0] ^= 0xff }},
		{"manifest read ancestor", func(value *Evidence) { value.manifest.Read.Ancestors[0].EvidenceSHA256[0] ^= 0xff }},
		{"release template digest", func(value *Evidence) { value.release.templateDigest[0] ^= 0xff }},
		{"release manifest digest", func(value *Evidence) { value.release.manifestSHA256 = strings.Repeat("a", 64) }},
		{"release template schema", func(value *Evidence) { value.release.templateSchemaVersion++ }},
		{"release profile ID", func(value *Evidence) { value.release.profileID += ".other" }},
		{"release ID", func(value *Evidence) { value.release.releaseID += ".other" }},
		{"release compatibility", func(value *Evidence) { value.release.compatibility.ServiceHostRPCVersion++ }},
		{"release dependency", func(value *Evidence) { value.release.dependencies[0].SHA256 = strings.Repeat("a", 64) }},
		{"release self", func(value *Evidence) { value.release.serviceHost.Size = "2" }},
		{"file binding", func(value *Evidence) { value.bindings[0].Purpose += ".other" }},
		{"binding compatibility", func(value *Evidence) { value.bindings[0].Manifest.Compatibility.LocalProtocolMajor++ }},
		{"root identity", func(value *Evidence) { value.roots[0].Object.Evidence.Identity.FileID[0] ^= 0xff }},
		{"root ancestor", func(value *Evidence) { value.roots[0].Ancestors[0].EvidenceSHA256[0] ^= 0xff }},
		{"file identity", func(value *Evidence) { value.files[0].Object.Evidence.Identity.FileID[0] ^= 0xff }},
		{"service identity", func(value *Evidence) { value.identity.ProcessID++ }},
		{"bootstrap role", func(value *Evidence) { value.bootstrap.role = config.RoleExecutor }},
		{"bootstrap own name", func(value *Evidence) { value.bootstrap.ownServiceName += ".other" }},
		{"bootstrap own SID", func(value *Evidence) { value.bootstrap.ownServiceSID = config.ExecutorServiceSID }},
		{"bootstrap peer name", func(value *Evidence) { value.bootstrap.peerServiceName += ".other" }},
		{"bootstrap peer SID", func(value *Evidence) { value.bootstrap.peerServiceSID = config.ControlServiceSID }},
		{"bootstrap PID", func(value *Evidence) { value.bootstrap.serviceHostFacts.ProcessID++ }},
		{"bootstrap creation time", func(value *Evidence) {
			value.bootstrap.serviceHostFacts.CreationTime = value.bootstrap.serviceHostFacts.CreationTime.Add(time.Nanosecond)
		}},
		{"bootstrap start key", func(value *Evidence) { value.bootstrap.serviceHostFacts.StartKey.SequenceNumber++ }},
		{"bootstrap source digest", func(value *Evidence) { value.bootstrap.sourceDigest[0] ^= 0xff }},
		{"signer", func(value *Evidence) { value.release.signerPin = strings.Repeat("a", 64) }},
		{"current image digest", func(value *Evidence) { value.currentImage.sourceDigest[0] ^= 0xff }},
		{"current image bootstrap", func(value *Evidence) { value.currentImage.bootstrapDigest[0] ^= 0xff }},
		{"current image process", func(value *Evidence) { value.currentImage.processFacts.ProcessID++ }},
		{"current image creation time", func(value *Evidence) {
			value.currentImage.processFacts.CreationTime = value.currentImage.processFacts.CreationTime.Add(time.Nanosecond)
		}},
		{"current image start key", func(value *Evidence) { value.currentImage.processFacts.StartKey.SequenceNumber++ }},
		{"current image path", func(value *Evidence) { value.currentImage.processPath += ".other" }},
		{"current image volume", func(value *Evidence) { value.currentImage.identity.VolumeSerialNumber++ }},
		{"current image identity", func(value *Evidence) { value.currentImage.identity.FileID[0] ^= 0xff }},
		{"current image size", func(value *Evidence) { value.currentImage.size++ }},
		{"current image SHA-256", func(value *Evidence) { value.currentImage.sha256[0] ^= 0xff }},
		{"data root", func(value *Evidence) { value.dataRoot.digest[0] ^= 0xff }},
		{"data-root installation target", func(value *Evidence) { value.dataRoot.installationRoots[0].target.FileID[0] ^= 0xff }},
		{"data-root installation ancestor", func(value *Evidence) { value.dataRoot.installationRoots[0].ancestors[0].FileID[0] ^= 0xff }},
		{"credential identity", func(value *Evidence) { value.controlCredentials.localFacts.identity.UniqueName += ".other" }},
		{"runtime content", func(value *Evidence) { value.contents[0].data[0] ^= 0xff }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneEvidenceForDigestTest(evidence)
			test.mutate(&candidate)
			digest, digestErr := digestEvidence(candidate)
			if digestErr != nil {
				t.Fatal(digestErr)
			}
			if digest == baseline {
				t.Fatal("binding mutation did not change the preflight digest")
			}
		})
	}

	diagnosticOnly := cloneEvidenceForDigestTest(evidence)
	diagnosticOnly.files[0].Object.Evidence.Path.FinalPathDiagnostic = `\\?\C:\diagnostic-only`
	diagnosticOnly.files[0].Object.Evidence.Path.FinalPathDiagnosticError = "diagnostic text"
	diagnosticOnly.roots[0].Ancestors[0].Evidence.Path.FinalPathDiagnostic = `\\?\C:\root-diagnostic`
	diagnosticOnly.roots[0].Ancestors[0].Evidence.Path.FinalPathDiagnosticError = "root diagnostic text"
	diagnosticOnly.control.Read.File.Evidence.Path.FinalPathDiagnostic = `\\?\C:\control-file-diagnostic`
	diagnosticOnly.control.Read.File.Evidence.Path.FinalPathDiagnosticError = "control file diagnostic text"
	diagnosticOnly.executor.Read.Ancestors[0].Evidence.Path.FinalPathDiagnostic = `\\?\C:\executor-ancestor-diagnostic`
	diagnosticOnly.executor.Read.Ancestors[0].Evidence.Path.FinalPathDiagnosticError = "executor ancestor diagnostic text"
	diagnosticOnly.manifest.Read.Ancestors[0].Evidence.Path.FinalPathDiagnostic = `\\?\C:\manifest-ancestor-diagnostic`
	diagnosticOnly.manifest.Read.Ancestors[0].Evidence.Path.FinalPathDiagnosticError = "manifest ancestor diagnostic text"
	diagnosticDigest, err := digestEvidence(diagnosticOnly)
	if err != nil || diagnosticDigest != baseline {
		t.Fatalf("diagnostic-only fields changed digest: %x, %v", diagnosticDigest, err)
	}
	if err := diagnosticOnly.Validate(); err != nil {
		t.Fatalf("diagnostic-only fields invalidated evidence: %v", err)
	}

	reordered := cloneEvidenceForDigestTest(evidence)
	environment := reordered.control.Configuration.Node.Environment
	reordered.control.Configuration.Node.Environment = make(map[string]string, len(environment))
	for name, value := range environment {
		reordered.control.Configuration.Node.Environment[name] = value
	}
	reorderedDigest, err := digestEvidence(reordered)
	if err != nil || reorderedDigest != baseline {
		t.Fatalf("map insertion order changed digest: %x, %v", reorderedDigest, err)
	}
}

func TestEvidenceValidateRejectsSecureReadAndAttestationDrift(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*Evidence)
	}{
		{"Control file identity", func(value *Evidence) {
			value.control.Read.File.Evidence.Identity.FileID[0] ^= 0xff
			rebuildObjectEvidence(t, &value.control.Read.File)
		}},
		{"Executor ancestor identity", func(value *Evidence) {
			value.executor.Read.Ancestors[0].Evidence.Identity.FileID[0] ^= 0xff
			rebuildObjectEvidence(t, &value.executor.Read.Ancestors[0])
		}},
		{"manifest ancestor identity", func(value *Evidence) {
			value.manifest.Read.Ancestors[0].Evidence.Identity.FileID[0] ^= 0xff
			rebuildObjectEvidence(t, &value.manifest.Read.Ancestors[0])
		}},
		{"release template digest", func(value *Evidence) { value.release.templateDigest[0] ^= 0xff }},
		{"release self", func(value *Evidence) { value.release.serviceHost.SHA256 = strings.Repeat("a", 64) }},
		{"current image bootstrap digest", func(value *Evidence) { value.currentImage.bootstrapDigest[0] ^= 0xff }},
		{"current image process", func(value *Evidence) { value.currentImage.processFacts.ProcessID++ }},
		{"current image identity", func(value *Evidence) { value.currentImage.identity.FileID[0] ^= 0xff }},
		{"local attestation getters", func(value *Evidence) {
			facts := value.controlCredentials.localFacts
			facts.identity.UniqueName += ".other"
			value.controlCredentials.localAuthority = cngAttestationFixture(facts)
		}},
		{"mTLS attestation getters", func(value *Evidence) {
			facts := value.controlCredentials.mtlsFacts
			facts.containerName += ".other"
			facts.keyName = facts.containerName
			value.controlCredentials.mtls = mtlsAttestationFixture(facts)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneEvidenceForDigestTest(evidence)
			test.mutate(&candidate)
			if err := candidate.Validate(); !errors.Is(err, ErrInvalidEvidence) {
				t.Fatalf("Validate = %v, want ErrInvalidEvidence", err)
			}
		})
	}
}

func TestEvidenceZeroAndMutationAreInvalid(t *testing.T) {
	if err := (Evidence{}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero Evidence.Validate = %v", err)
	}
	if _, err := (Evidence{}).Digest(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero Evidence.Digest = %v", err)
	}
	if _, err := (Evidence{}).FinalizeRuntimePlan(context.Background(), dataroot.Evidence{}); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero Evidence.FinalizeRuntimePlan = %v", err)
	}
	if err := (RuntimePlan{}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero RuntimePlan.Validate = %v", err)
	}
	fixture := newCompositionFixture(t, config.RoleControl)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	evidence.dataRoot.digest[0] ^= 0xff
	if err := evidence.Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("mutated Evidence.Validate = %v", err)
	}
}

func TestFinalizeRuntimePlanVerifiesThenClosesAndCannotBeRepeated(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleExecutor)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	root := &fakeDataRootLifecycle{}
	plan, err := finalizeRuntimePlan(
		context.Background(),
		evidence,
		cloneDataRootBinding(evidence.dataRoot),
		root,
	)
	if err != nil || !plan.valid || strings.Join(root.events, ",") != "verify,close" {
		t.Fatalf("Finalize = %#v, %v, events=%v", plan, err, root.events)
	}
	second, err := finalizeRuntimePlan(
		context.Background(),
		evidence,
		cloneDataRootBinding(evidence.dataRoot),
		root,
	)
	if !errors.Is(err, dataroot.ErrClosed) || second.valid ||
		strings.Join(root.events, ",") != "verify,close,verify,close" {
		t.Fatalf("repeated Finalize = %#v, %v, events=%v", second, err, root.events)
	}
}

func TestFinalizeRuntimePlanReturnsNoPlanOnReinspectionOrCloseFailure(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleExecutor)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name      string
		verifyErr error
		closeErr  error
		want      error
	}{
		{"VerifyUnchanged changed", dataroot.ErrChanged, nil, dataroot.ErrChanged},
		{"Close changed", nil, dataroot.ErrChanged, dataroot.ErrChanged},
		{"Close cleanup", nil, dataroot.ErrCleanup, dataroot.ErrCleanup},
		{"verify and close", dataroot.ErrChanged, dataroot.ErrCleanup, dataroot.ErrCleanup},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := &fakeDataRootLifecycle{verifyErr: test.verifyErr, closeErr: test.closeErr}
			plan, err := finalizeRuntimePlan(
				context.Background(),
				evidence,
				cloneDataRootBinding(evidence.dataRoot),
				root,
			)
			if !errors.Is(err, test.want) || plan.valid || strings.Join(root.events, ",") != "verify,close" {
				t.Fatalf("Finalize = %#v, %v, events=%v", plan, err, root.events)
			}
			if test.verifyErr != nil && !errors.Is(err, test.verifyErr) {
				t.Fatalf("Finalize omitted VerifyUnchanged error: %v", err)
			}
		})
	}
}

func TestFinalizeRuntimePlanClosesWithoutReinspectionOnBindingMismatch(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleExecutor)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	observed := cloneDataRootBinding(evidence.dataRoot)
	observed.installationRoots[0].target.FileID[0] ^= 0xff
	root := &fakeDataRootLifecycle{}
	plan, err := finalizeRuntimePlan(context.Background(), evidence, observed, root)
	if err == nil || plan.valid || strings.Join(root.events, ",") != "close" {
		t.Fatalf("mismatched Finalize = %#v, %v, events=%v", plan, err, root.events)
	}
}

type fakeDataRootLifecycle struct {
	events    []string
	verifyErr error
	closeErr  error
	closed    bool
}

func (root *fakeDataRootLifecycle) VerifyUnchanged(ctx context.Context) error {
	root.events = append(root.events, "verify")
	if root.closed {
		return dataroot.ErrClosed
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return root.verifyErr
}

func (root *fakeDataRootLifecycle) Close() error {
	root.events = append(root.events, "close")
	root.closed = true
	return root.closeErr
}

func cloneEvidenceForDigestTest(value Evidence) Evidence {
	value.control = cloneConfigurationEvidence(value.control)
	value.executor = cloneConfigurationEvidence(value.executor)
	value.manifest = cloneManifestEvidence(value.manifest)
	value.identity = cloneIdentityEvidence(value.identity)
	value.roots = cloneRoots(value.roots)
	value.files = cloneFiles(value.files)
	value.release = cloneReleaseBinding(value.release)
	value.bindings = cloneBindings(value.bindings)
	value.controlCredentials = cloneControlCredentials(value.controlCredentials)
	value.dataRoot = cloneDataRootBinding(value.dataRoot)
	value.contents = cloneRuntimeContents(value.contents)
	return value
}
