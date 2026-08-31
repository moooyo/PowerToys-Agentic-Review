package servicebootstrap

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestEvidenceZeroValueAndUnissuedStateAreInvalid(t *testing.T) {
	zero := Evidence{}
	if err := zero.Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero Validate error = %v, want ErrInvalidEvidence", err)
	}
	if _, err := zero.Digest(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero Digest error = %v, want ErrInvalidEvidence", err)
	}
	if zero.Options() != (ResolvedOptions{}) || zero.Identity().ProcessID != 0 ||
		zero.SCMBeforeOpen() != (ServiceObservation{}) ||
		zero.StableWrapperFacts().ProcessID != 0 || zero.DirectParentProcessID() != 0 ||
		len(zero.ServiceHostProcessDACL().AccessRules) != 0 {
		t.Fatal("zero evidence getters returned authorization facts")
	}

	valid := mustSuccessfulEvidence(t)
	forged := cloneEvidenceForTest(valid)
	forged.state.issuer = &evidenceIssuer{marker: successfulEvidenceIssuer.marker}
	forged.state.digest = digestEvidenceState(forged.state)
	if err := forged.Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("unissued state Validate error = %v, want ErrInvalidEvidence", err)
	}
}

func TestEvidenceExportsNoConstructibleState(t *testing.T) {
	typeOfEvidence := reflect.TypeOf(Evidence{})
	for index := 0; index < typeOfEvidence.NumField(); index++ {
		if field := typeOfEvidence.Field(index); field.IsExported() {
			t.Fatalf("Evidence exposes constructible field %q", field.Name)
		}
	}
}

func TestEvidenceGettersReturnDetachedCopies(t *testing.T) {
	evidence := mustSuccessfulEvidence(t)
	baselineDigest, err := evidence.Digest()
	if err != nil {
		t.Fatal(err)
	}

	options := evidence.Options()
	options.ServiceName = "mutated"
	identity := evidence.Identity()
	identity.Token.Groups[0].SID = "mutated"
	identity.Token.RestrictedSIDs[0].SID = "mutated"
	identity.Token.Privileges[0].Name = "mutated"
	dacls := []DACLEvidence{
		evidence.ServiceHostProcessDACL(),
		evidence.ServiceHostPrimaryTokenDACL(),
		evidence.WinSWWrapperProcessDACL(),
	}
	for index := range dacls {
		dacls[index].AccessRules[0].SID = "mutated"
	}

	if evidence.Options() != validResolvedOptions() {
		t.Fatalf("Options getter exposed mutable state: %+v", evidence.Options())
	}
	currentIdentity := evidence.Identity()
	if currentIdentity.Token.Groups[0].SID == "mutated" ||
		currentIdentity.Token.RestrictedSIDs[0].SID == "mutated" ||
		currentIdentity.Token.Privileges[0].Name == "mutated" {
		t.Fatal("Identity getter exposed mutable slice storage")
	}
	for _, current := range []DACLEvidence{
		evidence.ServiceHostProcessDACL(),
		evidence.ServiceHostPrimaryTokenDACL(),
		evidence.WinSWWrapperProcessDACL(),
	} {
		if current.AccessRules[0].SID == "mutated" {
			t.Fatal("DACL getter exposed mutable state")
		}
	}
	if err := evidence.Validate(); err != nil {
		t.Fatalf("getter mutation invalidated evidence: %v", err)
	}
	currentDigest, err := evidence.Digest()
	if err != nil || currentDigest != baselineDigest {
		t.Fatalf("digest after getter mutation = %x, %v; want %x", currentDigest, err, baselineDigest)
	}
}

func TestEvidenceCopiesRemainValidAfterSessionClose(t *testing.T) {
	evidence := mustSuccessfulEvidence(t)
	copied := evidence

	if err := copied.Validate(); err != nil {
		t.Fatal(err)
	}
	originalDigest, err := evidence.Digest()
	if err != nil {
		t.Fatal(err)
	}
	copiedDigest, err := copied.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if copiedDigest != originalDigest || copied.Options() != evidence.Options() ||
		copied.StableWrapperFacts() != evidence.StableWrapperFacts() ||
		copied.StableServiceHostFacts() != evidence.StableServiceHostFacts() {
		t.Fatal("copied evidence does not preserve the sealed authorization facts")
	}
}

func TestEvidenceDigestIsDeterministicAndCoversAuthorizationFacts(t *testing.T) {
	first := mustSuccessfulEvidence(t)
	second := mustSuccessfulEvidence(t)
	firstDigest, err := first.Digest()
	if err != nil {
		t.Fatal(err)
	}
	secondDigest, err := second.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if firstDigest != secondDigest {
		t.Fatalf("equivalent evidence digests differ: %x != %x", firstDigest, secondDigest)
	}

	tests := []struct {
		name   string
		mutate func(*evidenceState)
	}{
		{name: "service name", mutate: func(state *evidenceState) { state.options.ServiceName += ".Other" }},
		{name: "role", mutate: func(state *evidenceState) { state.options.Role = "other" }},
		{name: "own service SID", mutate: func(state *evidenceState) { state.options.OwnServiceSID += "0" }},
		{name: "peer service name", mutate: func(state *evidenceState) { state.options.PeerServiceName += ".Other" }},
		{name: "peer service SID", mutate: func(state *evidenceState) { state.options.PeerServiceSID += "0" }},
		{name: "identity PID", mutate: func(state *evidenceState) { state.identity.ProcessID++ }},
		{name: "identity service", mutate: func(state *evidenceState) { state.identity.OwnService.StartAccount += ".Other" }},
		{name: "identity token", mutate: func(state *evidenceState) { state.identity.Token.ModifiedID.LowPart++ }},
		{name: "identity group", mutate: func(state *evidenceState) { state.identity.Token.Groups[0].Attributes++ }},
		{name: "identity restricted SID", mutate: func(state *evidenceState) { state.identity.Token.RestrictedSIDs[0].SID += ".Other" }},
		{name: "identity privilege", mutate: func(state *evidenceState) { state.identity.Token.Privileges[0].Name += ".Other" }},
		{name: "SCM before state", mutate: func(state *evidenceState) { state.scmBeforeOpen.State = ServicePaused }},
		{name: "SCM before PID", mutate: func(state *evidenceState) { state.scmBeforeOpen.ProcessID++ }},
		{name: "SCM after state", mutate: func(state *evidenceState) { state.scmAfterOpen.State = ServicePaused }},
		{name: "SCM after PID", mutate: func(state *evidenceState) { state.scmAfterOpen.ProcessID++ }},
		{name: "wrapper PID", mutate: func(state *evidenceState) { state.stableWrapperFacts.ProcessID++ }},
		{name: "wrapper creation", mutate: func(state *evidenceState) {
			state.stableWrapperFacts.CreationTime = state.stableWrapperFacts.CreationTime.Add(time.Nanosecond)
		}},
		{name: "wrapper start-key availability", mutate: func(state *evidenceState) {
			state.stableWrapperFacts.StartKey.Available = false
			state.stableWrapperFacts.StartKey.SequenceNumber = 0
		}},
		{name: "wrapper start-key sequence", mutate: func(state *evidenceState) { state.stableWrapperFacts.StartKey.SequenceNumber++ }},
		{name: "ServiceHost PID", mutate: func(state *evidenceState) { state.stableServiceHostFacts.ProcessID++ }},
		{name: "ServiceHost creation", mutate: func(state *evidenceState) {
			state.stableServiceHostFacts.CreationTime = state.stableServiceHostFacts.CreationTime.Add(time.Nanosecond)
		}},
		{name: "ServiceHost start-key availability", mutate: func(state *evidenceState) {
			state.stableServiceHostFacts.StartKey.Available = false
			state.stableServiceHostFacts.StartKey.SequenceNumber = 0
		}},
		{name: "ServiceHost start-key sequence", mutate: func(state *evidenceState) { state.stableServiceHostFacts.StartKey.SequenceNumber++ }},
		{name: "direct parent", mutate: func(state *evidenceState) { state.directParentProcessID++ }},
		{name: "process DACL control", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.Control ^= 1 }},
		{name: "process DACL present", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.Present = false }},
		{name: "process DACL protected", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.Protected = false }},
		{name: "process DACL null", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.Null = true }},
		{name: "process DACL defaulted", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.Defaulted = true }},
		{name: "process DACL SID", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.AccessRules[0].SID += "0" }},
		{name: "process DACL mask", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.AccessRules[0].Mask++ }},
		{name: "process DACL ACE type", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.AccessRules[0].ACEType++ }},
		{name: "process DACL flags", mutate: func(state *evidenceState) { state.serviceHostProcessDACL.AccessRules[0].Flags++ }},
		{name: "token DACL", mutate: func(state *evidenceState) { state.serviceHostPrimaryTokenDACL.AccessRules[0].Mask++ }},
		{name: "wrapper DACL", mutate: func(state *evidenceState) { state.winSWWrapperProcessDACL.AccessRules[0].Mask++ }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneEvidenceForTest(first)
			test.mutate(candidate.state)
			if digest := digestEvidenceState(candidate.state); digest == firstDigest {
				t.Fatalf("mutating %s did not change the digest", test.name)
			}
		})
	}
}

func TestEvidenceValidateRejectsInternalInconsistency(t *testing.T) {
	valid := mustSuccessfulEvidence(t)
	tests := []struct {
		name            string
		recomputeDigest bool
		mutate          func(*evidenceState)
	}{
		{name: "issuer", recomputeDigest: true, mutate: func(state *evidenceState) { state.issuer = &evidenceIssuer{marker: 1} }},
		{name: "options", recomputeDigest: true, mutate: func(state *evidenceState) { state.options.ServiceName = "" }},
		{name: "role", recomputeDigest: true, mutate: func(state *evidenceState) { state.options.Role = "other" }},
		{name: "identity service", recomputeDigest: true, mutate: func(state *evidenceState) { state.identity.OwnService.Name += ".Other" }},
		{name: "identity PID", recomputeDigest: true, mutate: func(state *evidenceState) { state.identity.ProcessID++ }},
		{name: "SCM state", recomputeDigest: true, mutate: func(state *evidenceState) {
			state.scmBeforeOpen.State = ServiceStopped
			state.scmAfterOpen.State = ServiceStopped
		}},
		{name: "SCM instability", recomputeDigest: true, mutate: func(state *evidenceState) { state.scmAfterOpen.State = ServicePaused }},
		{name: "wrapper SCM PID", recomputeDigest: true, mutate: func(state *evidenceState) { state.stableWrapperFacts.ProcessID++ }},
		{name: "wrapper creation", recomputeDigest: true, mutate: func(state *evidenceState) { state.stableWrapperFacts.CreationTime = time.Time{} }},
		{name: "wrapper start key", recomputeDigest: true, mutate: func(state *evidenceState) {
			state.stableWrapperFacts.StartKey.Available = false
		}},
		{name: "same process PID", recomputeDigest: true, mutate: func(state *evidenceState) {
			state.stableServiceHostFacts.ProcessID = state.stableWrapperFacts.ProcessID
		}},
		{name: "ServiceHost creation", recomputeDigest: true, mutate: func(state *evidenceState) {
			state.stableServiceHostFacts.CreationTime = state.stableWrapperFacts.CreationTime
		}},
		{name: "same process start key", recomputeDigest: true, mutate: func(state *evidenceState) { state.stableServiceHostFacts.StartKey = state.stableWrapperFacts.StartKey }},
		{name: "parent PID", recomputeDigest: true, mutate: func(state *evidenceState) { state.directParentProcessID++ }},
		{name: "ServiceHost process DACL", recomputeDigest: true, mutate: func(state *evidenceState) { state.serviceHostProcessDACL.AccessRules[3].Mask = genericAllAccessMask }},
		{name: "ServiceHost token DACL", recomputeDigest: true, mutate: func(state *evidenceState) {
			state.serviceHostPrimaryTokenDACL.AccessRules[3].Mask = genericAllAccessMask
		}},
		{name: "wrapper process DACL", recomputeDigest: true, mutate: func(state *evidenceState) {
			state.winSWWrapperProcessDACL.AccessRules[3] = state.winSWWrapperProcessDACL.AccessRules[0]
		}},
		{name: "sealed digest", mutate: func(state *evidenceState) { state.options.ServiceName += ".Mutated" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneEvidenceForTest(valid)
			test.mutate(candidate.state)
			if test.recomputeDigest {
				candidate.state.digest = digestEvidenceState(candidate.state)
			}
			if err := candidate.Validate(); !errors.Is(err, ErrInvalidEvidence) {
				t.Fatalf("Validate error = %v, want ErrInvalidEvidence", err)
			}
			if _, err := candidate.Digest(); !errors.Is(err, ErrInvalidEvidence) {
				t.Fatalf("Digest error = %v, want ErrInvalidEvidence", err)
			}
		})
	}
}

func mustSuccessfulEvidence(t *testing.T) Evidence {
	t.Helper()
	platform, _, _ := newSuccessfulFakePlatform()
	session, err := openWithTestPlatform(validOptions(), platform)
	if err != nil {
		t.Fatal(err)
	}
	evidence := session.Evidence()
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if err := evidence.Validate(); err != nil {
		t.Fatalf("retained evidence validation error = %v", err)
	}
	return evidence
}

func cloneEvidenceForTest(evidence Evidence) Evidence {
	state := *evidence.state
	state.identity = cloneIdentityEvidence(state.identity)
	state.serviceHostProcessDACL = cloneDACLEvidence(state.serviceHostProcessDACL)
	state.serviceHostPrimaryTokenDACL = cloneDACLEvidence(state.serviceHostPrimaryTokenDACL)
	state.winSWWrapperProcessDACL = cloneDACLEvidence(state.winSWWrapperProcessDACL)
	return Evidence{state: &state}
}
