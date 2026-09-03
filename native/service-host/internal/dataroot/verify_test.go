package dataroot

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestVerifyRuntimeEvidenceForEachRole(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			current, peer, installation, fs := verificationFixture(role)
			evidence, err := verifyWithDependencies(
				context.Background(), current, peer, installation,
				dependencies{openTraversalRoot: fs.openTraversalRoot},
			)
			if err != nil {
				t.Fatalf("verifyWithDependencies returned an error: %v", err)
			}
			defer evidence.Close()
			if err := evidence.Validate(); err != nil {
				t.Fatalf("Evidence.Validate returned an error: %v", err)
			}
			if evidence.Role() != role || evidence.DataRoot().Path() != current.Node.DataRoot ||
				evidence.PeerDataRootPath() != peer.Node.DataRoot ||
				evidence.PeerRootObservation() != PeerLiveRootNotObservedByDesign {
				t.Fatal("evidence omitted role or peer-observation binding")
			}
			if len(evidence.DataRoot().Ancestors()) != 3 || len(evidence.InstallationRoots()) != 2 {
				t.Fatal("evidence omitted a complete root chain")
			}
			if _, err := evidence.Digest(); err != nil {
				t.Fatalf("Evidence.Digest returned an error: %v", err)
			}
			for _, opened := range fs.opened {
				if strings.HasPrefix(opened, peer.Node.DataRoot) {
					t.Fatalf("verifier opened peer data path %s", opened)
				}
			}
		})
	}
}

func TestVerifyControlRetainsTheFixedAuthenticationFile(t *testing.T) {
	current, peer, installation, fs := verificationFixture(config.RoleControl)

	evidence, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer evidence.Close()
	found := false
	for _, path := range evidence.RuntimePaths() {
		if path.Purpose() == PurposeWorkerAuth && path.Path() == config.WorkerAuthenticationProfilePath &&
			path.Kind() == winfile.ObjectKindFile {
			found = true
		}
	}
	if !found {
		t.Fatal("Control evidence omitted the fixed Worker authentication file")
	}
}

func TestVerifyDataRootRejectsMissingOrMisplacedAuthenticationFiles(t *testing.T) {
	t.Run("missing Control file", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		delete(fs.nodes, config.WorkerAuthenticationProfilePath)
		if _, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		); !errors.Is(err, ErrFilesystem) {
			t.Fatalf("missing Worker authentication file returned %v", err)
		}
	})

	t.Run("wrong Control file kind", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		fs.nodes[config.WorkerAuthenticationProfilePath].kind = winfile.ObjectKindDirectory
		if _, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		); !errors.Is(err, ErrFilesystem) {
			t.Fatalf("wrong Worker authentication file kind returned %v", err)
		}
	})

	t.Run("Executor copy", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleExecutor)
		fs.addFile(current.Node.DataRoot+`\worker-auth-v1.json`, 13, roleFileSecurity(current))
		if _, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		); !errors.Is(err, ErrFilesystem) {
			t.Fatalf("Executor Worker authentication file returned %v", err)
		}
	})
}

func TestEvidenceGettersReturnDetachedCopies(t *testing.T) {
	current, peer, installation, fs := verificationFixture(config.RoleControl)
	evidence, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer evidence.Close()

	configuration := evidence.CurrentConfiguration()
	configuration.Node.Environment["TEMP"] = `C:\Changed`
	root := evidence.DataRoot()
	descriptorByte := root.Object().Evidence().Security.SelfRelativeDescriptor[0]
	object := root.Object()
	object.evidence.Security.SelfRelativeDescriptor[0] ^= 0xff
	paths := evidence.RuntimePaths()
	paths[0].object.evidence.Security.SelfRelativeDescriptor[0] ^= 0xff
	bindings := evidence.InstallationRoots()
	bindings[0].ancestors[0] = testIdentity(99)

	if evidence.CurrentConfiguration().Node.Environment["TEMP"] == `C:\Changed` ||
		evidence.DataRoot().Object().Evidence().Security.SelfRelativeDescriptor[0] != descriptorByte ||
		evidence.RuntimePaths()[0].Object().Evidence().Security.SelfRelativeDescriptor[0] != descriptorByte ||
		evidence.InstallationRoots()[0].ancestors[0] == testIdentity(99) {
		t.Fatal("evidence accessor exposed mutable internal storage")
	}
}

func TestEvidenceDigestBindsCompleteCanonicalConfigurations(t *testing.T) {
	current, peer, installation, fs := verificationFixture(config.RoleControl)
	first, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	firstDigest, err := first.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	current, peer, installation, fs = verificationFixture(config.RoleControl)
	current.Node.Environment["PATH"] += `;` + testInstallationRoot + `\bin`
	installation.control = cloneConfig(current)
	second, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	secondDigest, err := second.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if firstDigest == secondDigest {
		t.Fatal("evidence digest did not bind the complete canonical configuration")
	}
}

func TestVerifyRejectsIdentityAliasesAndNoncanonicalHandlePaths(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(config.Config, *fakeFileSystem, *installationSnapshot)
	}{
		{
			name: "runtime directory alias",
			mutate: func(current config.Config, fs *fakeFileSystem, _ *installationSnapshot) {
				fs.nodes[current.Node.WorkingDirectory].identity = fs.nodes[current.Node.Environment["TEMP"]].identity
			},
		},
		{
			name: "case or short-name final path mismatch",
			mutate: func(current config.Config, fs *fakeFileSystem, _ *installationSnapshot) {
				fs.nodes[current.Node.WorkingDirectory].finalPath = `\\?\C:\PROGRA~1\Work`
			},
		},
		{
			name: "installation physical overlap",
			mutate: func(current config.Config, fs *fakeFileSystem, installation *installationSnapshot) {
				installation.roots[0].target = fs.nodes[current.Node.DataRoot].identity
			},
		},
		{
			name: "installation target is data ancestor",
			mutate: func(_ config.Config, fs *fakeFileSystem, installation *installationSnapshot) {
				installation.roots[0].target = fs.nodes[`C:\ProgramData`].identity
			},
		},
		{
			name: "data target is installation ancestor",
			mutate: func(current config.Config, fs *fakeFileSystem, installation *installationSnapshot) {
				installation.roots[0].ancestors[1] = fs.nodes[current.Node.DataRoot].identity
			},
		},
		{
			name: "shared identity has different ancestor path",
			mutate: func(_ config.Config, fs *fakeFileSystem, installation *installationSnapshot) {
				installation.roots[0].ancestors[1] = fs.nodes[`C:\ProgramData`].identity
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			current, peer, installation, fs := verificationFixture(config.RoleControl)
			test.mutate(current, fs, &installation)
			_, err := verifyWithDependencies(
				context.Background(), current, peer, installation,
				dependencies{openTraversalRoot: fs.openTraversalRoot},
			)
			if err == nil {
				t.Fatal("verification accepted an identity alias")
			}
		})
	}
}

func TestVerifyRejectsNamedStreamsAndCaseSensitiveDirectories(t *testing.T) {
	t.Run("named data stream", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		fs.nodes[current.Node.WorkingDirectory].streamErr = winfile.ErrNamedDataStream
		_, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if !errors.Is(err, winfile.ErrNamedDataStream) {
			t.Fatalf("verification error = %v, want ErrNamedDataStream", err)
		}
	})

	t.Run("case-sensitive directory", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		fs.nodes[current.Node.Environment["LOCALAPPDATA"]].caseSensitive = true
		_, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if !errors.Is(err, winfile.ErrCaseSensitiveDirectory) {
			t.Fatalf("verification error = %v, want ErrCaseSensitiveDirectory", err)
		}
	})
}

func TestVerifyRejectsMissingPathAndWrongRoleDataACL(t *testing.T) {
	t.Run("missing fixed directory", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		delete(fs.nodes, current.Node.Environment["APPDATA"])
		_, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if err == nil {
			t.Fatal("verification created or accepted a missing directory")
		}
	})

	t.Run("peer ACE", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		fs.nodes[current.Node.WorkingDirectory].security = buildSecurityDescriptor(true, []testACE{
			{flags: 0x03, mask: testFileAll, sid: testSystemSID},
			{flags: 0x03, mask: testFileAll, sid: testAdministratorsSID},
			{mask: testBoundaryDirectoryModify, sid: current.OwnService.SID},
			{flags: 0x09, mask: testFileModify, sid: current.OwnService.SID},
			{flags: 0x0a, mask: testDirectoryModify, sid: current.OwnService.SID},
			{flags: 0x0b, mask: testReadControl, sid: testOwnerRightsSID},
			{mask: testFileRead, sid: current.PeerService.SID},
		})
		_, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if !errors.Is(err, ErrACL) {
			t.Fatalf("verification error = %v, want ErrACL", err)
		}
	})
}

func TestVerifyEnforcesClosedStructureButAllowsRuntimeContent(t *testing.T) {
	t.Run("extra root entry", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		fs.addDirectory(current.Node.DataRoot+`\Unexpected`, winfile.SecurityModeRoleDataInherited, 40, inheritedDirectorySecurity(current))
		_, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if !errors.Is(err, ErrFilesystem) {
			t.Fatalf("verification error = %v, want ErrFilesystem", err)
		}
	})

	t.Run("extra profile entry", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		fs.addDirectory(current.Node.Environment["USERPROFILE"]+`\Unexpected`, winfile.SecurityModeRoleDataInherited, 41, inheritedDirectorySecurity(current))
		_, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if !errors.Is(err, ErrFilesystem) {
			t.Fatalf("verification error = %v, want ErrFilesystem", err)
		}
	})

	t.Run("runtime content", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		contentDirectory := current.Node.WorkingDirectory + `\Cache`
		contentFile := contentDirectory + `\state.bin`
		fs.addDirectory(contentDirectory, winfile.SecurityModeRoleDataInherited, 42, inheritedDirectorySecurity(current))
		fs.addFile(contentFile, 43, roleFileSecurity(current))
		evidence, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if err != nil {
			t.Fatalf("verification rejected allowed runtime content: %v", err)
		}
		if len(evidence.RetainedObjects()) <= len(evidence.RuntimePaths()) {
			t.Fatal("runtime content was not retained in evidence")
		}
		openedContent := false
		for _, opened := range fs.opened {
			if opened == contentFile {
				openedContent = true
			}
		}
		if !openedContent {
			t.Fatal("runtime content file was not opened relative to its retained parent")
		}
		if err := evidence.Close(); err != nil {
			t.Fatalf("Evidence.Close returned an error: %v", err)
		}
	})

	t.Run("runtime content peer ACE", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		path := current.Node.WorkingDirectory + `\shared.bin`
		fs.addFile(path, 44, buildInheritedSecurityDescriptor(current.OwnService.SID, []testACE{
			{flags: 0x10, mask: testFileAll, sid: testSystemSID},
			{flags: 0x10, mask: testFileAll, sid: testAdministratorsSID},
			{flags: 0x10, mask: testFileModify, sid: current.OwnService.SID},
			{flags: 0x10, mask: testReadControl, sid: testOwnerRightsSID},
			{flags: 0x10, mask: testFileRead, sid: current.PeerService.SID},
		}))
		_, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if !errors.Is(err, ErrACL) {
			t.Fatalf("verification error = %v, want ErrACL", err)
		}
	})
}

func TestEvidenceDetectsClosedStructureTOCTOU(t *testing.T) {
	current, peer, installation, fs := verificationFixture(config.RoleControl)
	evidence, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	fs.addDirectory(current.Node.DataRoot+`\LateEntry`, winfile.SecurityModeRoleDataInherited, 43, inheritedDirectorySecurity(current))
	if err := evidence.VerifyUnchanged(context.Background()); !errors.Is(err, ErrChanged) {
		t.Fatalf("VerifyUnchanged error = %v, want ErrChanged", err)
	}
	_ = evidence.Close()

	current, peer, installation, fs = verificationFixture(config.RoleControl)
	evidence, err = verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	fs.addFile(current.Node.WorkingDirectory+`\late.bin`, 45, roleFileSecurity(current))
	if err := evidence.VerifyUnchanged(context.Background()); !errors.Is(err, ErrChanged) {
		t.Fatalf("runtime content VerifyUnchanged error = %v, want ErrChanged", err)
	}
	_ = evidence.Close()
}

func TestRuntimeContentTraversalEnforcesPerDirectoryAndTotalBudgets(t *testing.T) {
	t.Run("per directory", func(t *testing.T) {
		current, peer, installation, fs := verificationFixture(config.RoleControl)
		security := roleFileSecurity(current)
		for index := 0; index <= maximumRuntimeEntriesPerDirectory; index++ {
			fs.addFile(
				current.Node.WorkingDirectory+`\`+fmt.Sprintf("entry-%04d.dat", index),
				byte(index%255+1),
				security,
			)
		}
		_, err := verifyWithDependencies(
			context.Background(), current, peer, installation,
			dependencies{openTraversalRoot: fs.openTraversalRoot},
		)
		if !errors.Is(err, winfile.ErrDirectoryBudget) {
			t.Fatalf("verification error = %v, want ErrDirectoryBudget", err)
		}
	})

	t.Run("total", func(t *testing.T) {
		v := verifier{resources: retainedResources{values: make([]retainedResource, maximumRetainedObjects)}}
		err := v.openRuntimeContentDirectory(&openedDirectory{}, `C:\Data`, 1)
		if !errors.Is(err, ErrFilesystem) {
			t.Fatalf("content traversal error = %v, want ErrFilesystem", err)
		}
	})
}

func TestVerifyRejectsConfigurationAndInstallationMismatchesBeforeOpening(t *testing.T) {
	current, peer, installation, fs := verificationFixture(config.RoleControl)
	peer.Node.DataRoot = current.Node.DataRoot
	_, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err == nil || len(fs.opened) != 0 {
		t.Fatalf("configuration mismatch opened filesystem objects: %v, %#v", err, fs.opened)
	}

	current, peer, installation, fs = verificationFixture(config.RoleControl)
	installation.role = config.RoleExecutor
	_, err = verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if !errors.Is(err, ErrInstallationEvidence) || len(fs.opened) != 0 {
		t.Fatalf("installation mismatch opened filesystem objects: %v, %#v", err, fs.opened)
	}

	current, peer, installation, fs = verificationFixture(config.RoleControl)
	current.Node.Environment["PATH"] = testInstallationRoot + `\missing-tools`
	installation.control = cloneConfig(current)
	_, err = verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if !errors.Is(err, ErrInstallationEvidence) || len(fs.opened) != 0 {
		t.Fatalf("unwitnessed PATH opened filesystem objects: %v, %#v", err, fs.opened)
	}
}

func TestEvidenceInvalidatesOnTOCTOUAndRetriesClose(t *testing.T) {
	current, peer, installation, fs := verificationFixture(config.RoleControl)
	evidence, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	fs.nodes[current.Node.WorkingDirectory].changed = true
	if err := evidence.VerifyUnchanged(context.Background()); !errors.Is(err, ErrChanged) {
		t.Fatalf("VerifyUnchanged error = %v, want ErrChanged", err)
	}
	if evidence.Role() != "" {
		t.Fatal("failed reinspection left evidence accessors valid")
	}
	if err := evidence.Close(); err == nil {
		// The object remains changed, so final cleanup reports the already-invalid
		// evidence only through the earlier VerifyUnchanged call.
	}

	current, peer, installation, fs = verificationFixture(config.RoleControl)
	evidence, err = verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	fs.nodes[current.Node.WorkingDirectory].closeFailures = 1
	if err := evidence.Close(); !errors.Is(err, ErrCleanup) {
		t.Fatalf("first Close error = %v, want ErrCleanup", err)
	}
	if err := evidence.Close(); err != nil {
		t.Fatalf("retry Close returned an error: %v", err)
	}
}

func TestCloseInvalidatesEvidenceWhenFinalReinspectionFails(t *testing.T) {
	current, peer, installation, fs := verificationFixture(config.RoleControl)
	evidence, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	fs.nodes[current.Node.Environment["APPDATA"]].changed = true
	if err := evidence.Close(); !errors.Is(err, ErrChanged) {
		t.Fatalf("Close error = %v, want ErrChanged", err)
	}
	if err := evidence.Validate(); !errors.Is(err, ErrClosed) {
		t.Fatalf("Validate after failed final reinspection = %v, want ErrClosed", err)
	}
	if err := evidence.Close(); err != nil {
		t.Fatalf("idempotent Close returned an error: %v", err)
	}
}

func TestEvidenceAccessAndCloseAreConcurrencySafe(t *testing.T) {
	current, peer, installation, fs := verificationFixture(config.RoleControl)
	evidence, err := verifyWithDependencies(
		context.Background(), current, peer, installation,
		dependencies{openTraversalRoot: fs.openTraversalRoot},
	)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	done := make(chan struct{}, 4)
	for index := 0; index < 3; index++ {
		go func() {
			<-start
			for attempt := 0; attempt < 20; attempt++ {
				_ = evidence.Role()
				_ = evidence.CurrentConfiguration()
				_ = evidence.RuntimePaths()
				_, _ = evidence.Digest()
			}
			done <- struct{}{}
		}()
	}
	go func() {
		<-start
		_ = evidence.Close()
		done <- struct{}{}
	}()
	close(start)
	for index := 0; index < 4; index++ {
		<-done
	}
	if err := evidence.Validate(); !errors.Is(err, ErrClosed) {
		t.Fatalf("Validate after concurrent Close = %v, want ErrClosed", err)
	}
}

func TestVerifyHonorsCancellationAndZeroEvidenceIsInvalid(t *testing.T) {
	if err := (Evidence{}).Validate(); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Evidence.Validate error = %v", err)
	}
	current, peer, installation, fs := verificationFixture(config.RoleControl)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := verifyWithDependencies(ctx, current, peer, installation, dependencies{openTraversalRoot: fs.openTraversalRoot})
	if !errors.Is(err, context.Canceled) || len(fs.opened) != 0 {
		t.Fatalf("cancelled verification = %v, opened %#v", err, fs.opened)
	}
}

func verificationFixture(role config.Role) (config.Config, config.Config, installationSnapshot, *fakeFileSystem) {
	control, executor := pairedConfigs()
	current, peer := control, executor
	if role == config.RoleExecutor {
		current, peer = executor, control
	}
	installation := fakeInstallationSnapshot(role, control, executor)
	return current, peer, installation, newFakeFileSystem(current)
}

var _ directoryHandle = (*fakeDirectory)(nil)
var _ fileHandle = (*fakeFile)(nil)
var _ = winfile.ErrClosed
