package preflight

import (
	"strings"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

func TestCurrentImageBindingMatchesBootstrapAndReleaseSelfForBothRoles(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			fixture := newCompositionFixture(t, role)
			evidence, err := composeSnapshots(fixture.input)
			if err != nil {
				t.Fatal(err)
			}
			binding, ok := evidence.CurrentImageBinding()
			if !ok {
				t.Fatal("Evidence omitted current-image binding")
			}
			var serviceHost VerifiedFile
			for _, file := range evidence.Files() {
				if file.Role == releasemanifest.RoleServiceHost {
					serviceHost = file
					break
				}
			}
			if binding.BootstrapDigest() != evidence.BootstrapBindingMustForTest(t).SourceDigest() ||
				!sameStableProcessFacts(binding.ProcessFacts(), evidence.BootstrapBindingMustForTest(t).ServiceHostProcessFacts()) ||
				binding.ProcessFacts().ProcessID != evidence.Identity().ProcessID ||
				!windowsPathEqual(binding.ProcessPath(), serviceHost.AbsolutePath) ||
				binding.Size() != serviceHost.Size || !digestMatchesHex(binding.SHA256(), serviceHost.SHA256) {
				t.Fatal("current-image binding omitted a bootstrap or release-self fact")
			}
		})
	}
}

func TestCurrentImageBindingRejectsEveryAuthorityMismatch(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*CurrentImageBinding)
	}{
		{"unbound", func(value *CurrentImageBinding) { value.bound = false }},
		{"zero source digest", func(value *CurrentImageBinding) { value.sourceDigest = [32]byte{} }},
		{"bootstrap digest", func(value *CurrentImageBinding) { value.bootstrapDigest[0] ^= 0xff }},
		{"process PID", func(value *CurrentImageBinding) { value.processFacts.ProcessID++ }},
		{"process creation time", func(value *CurrentImageBinding) {
			value.processFacts.CreationTime = value.processFacts.CreationTime.Add(time.Nanosecond)
		}},
		{"process start key", func(value *CurrentImageBinding) { value.processFacts.StartKey.SequenceNumber++ }},
		{"relative path", func(value *CurrentImageBinding) { value.processPath = `native\AgenticReview.ServiceHost.exe` }},
		{"different path", func(value *CurrentImageBinding) { value.processPath += ".other" }},
		{"volume", func(value *CurrentImageBinding) { value.identity.VolumeSerialNumber++ }},
		{"file ID", func(value *CurrentImageBinding) { value.identity.FileID[0] ^= 0xff }},
		{"size", func(value *CurrentImageBinding) { value.size++ }},
		{"SHA-256", func(value *CurrentImageBinding) { value.sha256[0] ^= 0xff }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCompositionFixture(t, config.RoleControl)
			test.mutate(&fixture.input.currentImage)
			_, err := composeSnapshots(fixture.input)
			assertPreflightErrorCode(t, err, ErrorCurrentImage)
		})
	}
}

func TestCurrentImagePathUsesCanonicalCaseInsensitiveWindowsIdentity(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleExecutor)
	fixture.input.currentImage.processPath = strings.ToUpper(fixture.input.currentImage.processPath)
	if _, err := composeSnapshots(fixture.input); err != nil {
		t.Fatalf("case-only current image path difference was rejected: %v", err)
	}

	invalid := newCompositionFixture(t, config.RoleExecutor)
	invalid.input.currentImage.processPath = `C:\Program Files\AgenticReview\Worker\native\..\native\AgenticReview.ServiceHost.exe`
	_, err := composeSnapshots(invalid.input)
	assertPreflightErrorCode(t, err, ErrorCurrentImage)
}

func TestSameStableProcessFactsUsesInstantEquality(t *testing.T) {
	left := stableServiceHostFactsFixture(42)
	right := left
	right.CreationTime = left.CreationTime.In(time.FixedZone("fixture", 8*60*60))
	if !sameStableProcessFacts(left, right) {
		t.Fatal("same process creation instant in another location was rejected")
	}
}

func (e Evidence) BootstrapBindingMustForTest(t *testing.T) BootstrapBinding {
	t.Helper()
	binding, ok := e.BootstrapBinding()
	if !ok {
		t.Fatal("Evidence omitted bootstrap binding")
	}
	return binding
}
