package installverify

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

func TestVerifiedContentIsRoleScopedAndCopyOnly(t *testing.T) {
	t.Run("Control", func(t *testing.T) {
		fixture := newInstallFixture(t)
		evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
		if err != nil {
			t.Fatalf("verifyWithDependencies returned an error: %v", err)
		}
		content, err := evidence.VerifiedContent(
			releasemanifest.RootTrustedConfiguration,
			`certificates\server-root.cer`,
		)
		if err != nil {
			t.Fatalf("VerifiedContent returned an error: %v", err)
		}
		if err := content.Validate(); err != nil {
			t.Fatalf("VerifiedContent.Validate returned an error: %v", err)
		}
		if content.Role() != releasemanifest.RoleCABundle ||
			content.AbsolutePath() != testTrustedRoot+`\certificates\server-root.cer` ||
			!bytes.Equal(content.Bytes(), []byte("certificate")) {
			t.Fatalf("unexpected Control content metadata or bytes")
		}

		first := content.Bytes()
		first[0] ^= 0xff
		object := content.Object()
		object.Evidence.Security.SelfRelativeDescriptor[0] ^= 0xff
		again, err := evidence.VerifiedContent(
			releasemanifest.RootTrustedConfiguration,
			`CERTIFICATES\SERVER-ROOT.CER`,
		)
		if err != nil || !bytes.Equal(again.Bytes(), []byte("certificate")) ||
			again.Object().Evidence.Security.SelfRelativeDescriptor[0] == object.Evidence.Security.SelfRelativeDescriptor[0] {
			t.Fatal("VerifiedContent getters retained caller-owned storage")
		}
		assertContentUnavailable(t, evidence, releasemanifest.RootTrustedConfiguration, `keys\local-authority.spki`)
		assertContentUnavailable(t, evidence, releasemanifest.RootInstallation, `certificates\server-root.cer`)
		assertContentUnavailable(t, evidence, releasemanifest.RootTrustedConfiguration, `other\server-root.cer`)
	})

	t.Run("Executor", func(t *testing.T) {
		fixture := newInstallFixture(t)
		fixture.options.Role = config.RoleExecutor
		fixture.options.ActualBootstrapPath = testTrustedRoot + `\` + releasemanifest.ExecutorBootstrapConfigurationPath
		evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
		if err != nil {
			t.Fatalf("verifyWithDependencies returned an error: %v", err)
		}
		for _, expected := range []struct {
			path string
			role releasemanifest.FileRole
			data []byte
		}{
			{`policy\codex.toml`, releasemanifest.RolePolicy, []byte("sandbox='required'")},
		} {
			content, contentErr := evidence.VerifiedContent(releasemanifest.RootTrustedConfiguration, expected.path)
			if contentErr != nil || content.Role() != expected.role || !bytes.Equal(content.Bytes(), expected.data) {
				t.Fatalf("Executor content %s = (%v, %v)", expected.path, content, contentErr)
			}
		}
		assertContentUnavailable(t, evidence, releasemanifest.RootTrustedConfiguration, `certificates\server-root.cer`)
		assertContentUnavailable(t, evidence, releasemanifest.RootTrustedConfiguration, `keys\local-authority.spki`)
	})

	if _, err := (Evidence{}).VerifiedContent(
		releasemanifest.RootTrustedConfiguration,
		`certificates\server-root.cer`,
	); !errors.Is(err, ErrVerifiedContentUnavailable) {
		t.Fatalf("zero Evidence returned %v, want ErrVerifiedContentUnavailable", err)
	}
	if (VerifiedContent{}).Validate() == nil || (VerifiedContent{}).Bytes() != nil {
		t.Fatal("zero VerifiedContent is usable")
	}
}

func TestVerifiedContentRejectsPostHashTampering(t *testing.T) {
	fixture := newInstallFixture(t)
	node := fixture.fs.mustNode(testTrustedRoot + `\certificates\server-root.cer`)
	node.afterHash = func() {
		node.data = []byte("tampered-after-hash")
	}
	evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
	if !errors.Is(err, ErrFileContent) {
		t.Fatalf("post-hash tampering returned %v, want ErrFileContent", err)
	}
	if evidence.Validate() == nil {
		t.Fatal("post-hash tampering returned usable evidence")
	}
}

func TestVerifiedContentEnforcesFixedPerPurposeBounds(t *testing.T) {
	tests := []struct {
		name       string
		role       config.Role
		rootCA     []byte
		publicSPKI []byte
		policy     []byte
	}{
		{
			name: "Control root certificate", role: config.RoleControl,
			rootCA:     bytes.Repeat([]byte{'c'}, int(maximumControlRootCertificateBytes+1)),
			publicSPKI: []byte("public-key"), policy: []byte("sandbox='required'"),
		},
		{
			name: "Executor Codex policy", role: config.RoleExecutor,
			rootCA: []byte("certificate"), publicSPKI: []byte("public-key"),
			policy: bytes.Repeat([]byte{'p'}, int(maximumExecutorCodexPolicyBytes+1)),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newInstallFixtureWithTrustedContent(t, test.rootCA, test.publicSPKI, test.policy)
			fixture.options.Role = test.role
			if test.role == config.RoleExecutor {
				fixture.options.ActualBootstrapPath = testTrustedRoot + `\` + releasemanifest.ExecutorBootstrapConfigurationPath
			}
			evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
			if !errors.Is(err, ErrFileContent) {
				t.Fatalf("oversized content returned %v, want ErrFileContent", err)
			}
			if evidence.Validate() == nil {
				t.Fatal("oversized content returned usable evidence")
			}
		})
	}
}

func TestVerifiedContentRequiresFinalReinspectionAndClose(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*fakeNode)
	}{
		{"reinspection failure", func(node *fakeNode) { node.reinspectSecurityError = errors.New("fixture reinspection failure") }},
		{"close failure", func(node *fakeNode) { node.closeFailures = 1 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newInstallFixture(t)
			test.mutate(fixture.fs.mustNode(testTrustedRoot + `\certificates\server-root.cer`))
			evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
			if !errors.Is(err, ErrCleanup) {
				t.Fatalf("cleanup failure returned %v, want ErrCleanup", err)
			}
			if evidence.Validate() == nil {
				t.Fatal("cleanup failure returned usable evidence")
			}
			assertContentUnavailable(t, evidence, releasemanifest.RootTrustedConfiguration, `certificates\server-root.cer`)
		})
	}
}

func assertContentUnavailable(
	t *testing.T,
	evidence Evidence,
	root releasemanifest.FileRoot,
	path string,
) {
	t.Helper()
	if _, err := evidence.VerifiedContent(root, path); !errors.Is(err, ErrVerifiedContentUnavailable) {
		t.Fatalf("VerifiedContent(%s, %s) returned %v, want ErrVerifiedContentUnavailable", root, path, err)
	}
}
