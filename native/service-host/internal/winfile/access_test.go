package winfile

import (
	"errors"
	"testing"
)

func TestAccessEvaluationRejectsUnsafeInputs(t *testing.T) {
	validSecurity := SecurityDescriptorEvidence{
		DACLPresent: true, DACLProtected: true, SelfRelativeDescriptor: []byte{1},
	}
	tests := []struct {
		security SecurityDescriptorEvidence
		desired  AccessMask
		mapping  GenericMapping
	}{
		{},
		{security: validSecurity},
		{security: validSecurity, desired: maximumAllowedMask},
		{security: validSecurity, desired: genericReadMask},
		{security: SecurityDescriptorEvidence{DACLPresent: true, DACLProtected: true}, desired: 1},
	}
	for _, test := range tests {
		if err := validateAccessEvaluation(test.security, test.desired, test.mapping); !errors.Is(err, ErrAccessCheck) {
			t.Fatalf("evaluation %#v returned %v", test, err)
		}
	}
	if err := validateAccessEvaluation(validSecurity, 1, GenericMapping{}); err != nil {
		t.Fatalf("valid evaluation was rejected: %v", err)
	}
}

func TestMapRequestedAccessUsesExplicitGenericMapping(t *testing.T) {
	mapping := GenericMapping{Read: 1, Write: 2, Execute: 4, All: 8}
	actual := mapRequestedAccess(
		genericReadMask|genericWriteMask|genericExecuteMask|genericAllMask|0x10,
		mapping,
	)
	if actual != 0x1f {
		t.Fatalf("mapped access = 0x%x, want 0x1f", actual)
	}
}
