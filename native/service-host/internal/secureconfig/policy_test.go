package secureconfig

import (
	"errors"
	"reflect"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestCheckExpectedAccessRequiresCompleteAllowedGrant(t *testing.T) {
	security := fixtureEvidence(`C:\trusted\config.json`, winfile.ObjectKindFile, 8, 3).Security
	token := &fixtureAccessEvaluator{decisions: []winfile.AccessCheckDecision{{
		Allowed: true, GrantedAccess: 0x00020089,
	}}}
	err := checkExpectedAccess(`C:\trusted\config.json`, security, expectedAccessCheck{
		name:            "service can read",
		token:           token,
		desiredAccess:   genericReadAccess,
		genericMapping:  winfile.GenericMapping{Read: 0x00020089},
		expectedAllowed: true,
	})
	if err != nil {
		t.Fatalf("checkExpectedAccess rejected a complete grant: %v", err)
	}
	if len(token.requests) != 1 || token.requests[0].desired != genericReadAccess {
		t.Fatalf("access requests = %#v", token.requests)
	}
}

func TestCheckExpectedAccessTestsEveryDeniedConcreteBit(t *testing.T) {
	security := fixtureEvidence(`C:\trusted`, winfile.ObjectKindDirectory, 3, 0).Security
	token := &fixtureAccessEvaluator{decisions: []winfile.AccessCheckDecision{
		{Allowed: false},
		{Allowed: false},
		{Allowed: false},
	}}
	expected := expectedAccessCheck{
		name:            "service cannot mutate",
		token:           token,
		desiredAccess:   genericWriteAccess,
		genericMapping:  winfile.GenericMapping{Write: 0x0000000b},
		expectedAllowed: false,
	}
	if err := checkExpectedAccess(`C:\trusted`, security, expected); err != nil {
		t.Fatalf("checkExpectedAccess rejected per-bit denials: %v", err)
	}
	want := []accessEvaluationRequest{
		{desired: 0x00000001, mapping: expected.genericMapping},
		{desired: 0x00000002, mapping: expected.genericMapping},
		{desired: 0x00000008, mapping: expected.genericMapping},
	}
	if !reflect.DeepEqual(token.requests, want) {
		t.Fatalf("access requests = %#v, want %#v", token.requests, want)
	}

	token = &fixtureAccessEvaluator{decisions: []winfile.AccessCheckDecision{
		{Allowed: false},
		{Allowed: true, GrantedAccess: 0x00000002},
	}}
	expected.token = token
	if err := checkExpectedAccess(`C:\trusted`, security, expected); !errors.Is(err, ErrPolicyRejected) {
		t.Fatalf("allowed concrete bit returned %v", err)
	}
	if len(token.requests) != 2 || token.requests[1].desired != 0x00000002 {
		t.Fatalf("access requests = %#v", token.requests)
	}
}

func TestCheckExpectedAccessMapsGenericACEsDuringSplitDenial(t *testing.T) {
	security := fixtureEvidence(`C:\trusted`, winfile.ObjectKindDirectory, 3, 0).Security
	mapping := winfile.GenericMapping{Write: 0x0000000b}
	token := &genericWriteAccessEvaluator{genericWrite: mapping.Write}
	err := checkExpectedAccess(`C:\trusted`, security, expectedAccessCheck{
		name:            "service cannot mutate",
		token:           token,
		desiredAccess:   genericWriteAccess,
		genericMapping:  mapping,
		expectedAllowed: false,
	})
	if !errors.Is(err, ErrPolicyRejected) {
		t.Fatalf("generic-write grant returned %v", err)
	}
	if len(token.requests) != 1 || token.requests[0].desired != 0x00000001 ||
		token.requests[0].mapping != mapping {
		t.Fatalf("generic-write requests = %#v", token.requests)
	}
}

func TestExpectedSecurityPolicyCopiesDescriptorExpectationsAndCloses(t *testing.T) {
	object := makeObjectEvidence(
		`C:\trusted`,
		fixtureEvidence(`C:\trusted`, winfile.ObjectKindDirectory, 3, 0),
	)
	digest := object.SecurityDescriptorSHA256
	owners := []string{"S-1-5-18"}
	expectation := SecurityExpectation{OwnerSIDs: owners, DescriptorSHA256: &digest}
	policy, err := NewExpectedSecurityPolicy(expectation, expectation)
	if err != nil {
		t.Fatalf("NewExpectedSecurityPolicy returned an error: %v", err)
	}
	owners[0] = "S-1-5-21-1"
	digest[0]++
	if err := policy.CheckAncestor(AncestorSecurityRequest{Object: object}); err != nil {
		t.Fatalf("caller mutation changed the policy: %v", err)
	}
	if err := policy.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	policyCopy := *policy
	if err := policyCopy.Close(); err != nil {
		t.Fatalf("repeated Close returned an error: %v", err)
	}
	if err := policy.CheckAncestor(AncestorSecurityRequest{Object: object}); !errors.Is(err, ErrInvalidPolicy) {
		t.Fatalf("closed policy returned %v", err)
	}
}

func TestExpectedSecurityPolicyRejectsMismatches(t *testing.T) {
	object := makeObjectEvidence(
		`C:\trusted`,
		fixtureEvidence(`C:\trusted`, winfile.ObjectKindDirectory, 3, 0),
	)
	digest := object.SecurityDescriptorSHA256
	tests := []struct {
		name        string
		expectation SecurityExpectation
		mutate      func(*ObjectEvidence)
	}{
		{
			name:        "owner",
			expectation: SecurityExpectation{OwnerSIDs: []string{"S-1-5-21-1"}, DescriptorSHA256: &digest},
		},
		{
			name: "descriptor",
			expectation: func() SecurityExpectation {
				wrong := digest
				wrong[0]++
				return SecurityExpectation{OwnerSIDs: []string{"S-1-5-18"}, DescriptorSHA256: &wrong}
			}(),
		},
		{
			name:        "defaulted DACL",
			expectation: SecurityExpectation{OwnerSIDs: []string{"S-1-5-18"}, DescriptorSHA256: &digest},
			mutate: func(value *ObjectEvidence) {
				value.Evidence.Security.DACLDefaulted = true
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			policy, err := NewExpectedSecurityPolicy(test.expectation, test.expectation)
			if err != nil {
				t.Fatalf("NewExpectedSecurityPolicy returned an error: %v", err)
			}
			defer policy.Close()
			candidate := object
			if test.mutate != nil {
				test.mutate(&candidate)
			}
			if err := policy.CheckAncestor(AncestorSecurityRequest{Object: candidate}); !errors.Is(err, ErrPolicyRejected) {
				t.Fatalf("CheckAncestor returned %v", err)
			}
		})
	}
}

func TestExpectedSecurityPolicyRejectsInvalidDefinitions(t *testing.T) {
	digest := Digest{1}
	tests := []SecurityExpectation{
		{DescriptorSHA256: &digest},
		{OwnerSIDs: []string{"S-1-5-18"}},
		{
			OwnerSIDs:    []string{"S-1-5-18"},
			AccessChecks: []AccessExpectation{{Name: "read", DesiredAccess: 1}},
		},
		{
			OwnerSIDs:    []string{"S-1-5-18"},
			AccessChecks: []AccessExpectation{{Name: "all", DesiredAccess: maximumAllowedAccess}},
		},
		{
			OwnerSIDs:    []string{"S-1-5-18"},
			AccessChecks: []AccessExpectation{{Name: "read", DesiredAccess: genericReadAccess}},
		},
	}
	for _, expectation := range tests {
		if _, err := NewExpectedSecurityPolicy(expectation, expectation); !errors.Is(err, ErrInvalidPolicy) {
			t.Fatalf("NewExpectedSecurityPolicy(%#v) returned %v", expectation, err)
		}
	}
}

type accessEvaluationRequest struct {
	desired winfile.AccessMask
	mapping winfile.GenericMapping
}

type fixtureAccessEvaluator struct {
	requests  []accessEvaluationRequest
	decisions []winfile.AccessCheckDecision
	err       error
	closed    int
}

func (token *fixtureAccessEvaluator) CheckAccess(
	_ winfile.SecurityDescriptorEvidence,
	desired winfile.AccessMask,
	mapping winfile.GenericMapping,
) (winfile.AccessCheckDecision, error) {
	token.requests = append(token.requests, accessEvaluationRequest{desired: desired, mapping: mapping})
	if token.err != nil {
		return winfile.AccessCheckDecision{}, token.err
	}
	if len(token.decisions) == 0 {
		return winfile.AccessCheckDecision{}, errors.New("missing fixture decision")
	}
	decision := token.decisions[0]
	token.decisions = token.decisions[1:]
	return decision, nil
}

type genericWriteAccessEvaluator struct {
	genericWrite winfile.AccessMask
	requests     []accessEvaluationRequest
}

func (token *genericWriteAccessEvaluator) CheckAccess(
	_ winfile.SecurityDescriptorEvidence,
	desired winfile.AccessMask,
	mapping winfile.GenericMapping,
) (winfile.AccessCheckDecision, error) {
	token.requests = append(token.requests, accessEvaluationRequest{desired: desired, mapping: mapping})
	allowed := desired&token.genericWrite != 0 && mapping.Write == token.genericWrite
	return winfile.AccessCheckDecision{Allowed: allowed, GrantedAccess: desired}, nil
}

func (*genericWriteAccessEvaluator) Close() error {
	return nil
}

func (token *fixtureAccessEvaluator) Close() error {
	token.closed++
	return nil
}
