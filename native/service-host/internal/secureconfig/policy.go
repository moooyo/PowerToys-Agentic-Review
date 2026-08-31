package secureconfig

import (
	"errors"
	"fmt"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	genericReadAccess    winfile.AccessMask = 0x80000000
	genericWriteAccess   winfile.AccessMask = 0x40000000
	genericExecuteAccess winfile.AccessMask = 0x20000000
	genericAllAccess     winfile.AccessMask = 0x10000000
	maximumAllowedAccess winfile.AccessMask = 0x02000000
	genericAccessMask                       = genericReadAccess | genericWriteAccess | genericExecuteAccess | genericAllAccess
)

type accessEvaluator interface {
	CheckAccess(
		winfile.SecurityDescriptorEvidence,
		winfile.AccessMask,
		winfile.GenericMapping,
	) (winfile.AccessCheckDecision, error)
	Close() error
}

type expectedAccessCheck struct {
	name            string
	token           accessEvaluator
	desiredAccess   winfile.AccessMask
	genericMapping  winfile.GenericMapping
	expectedAllowed bool
}

type securityExpectation struct {
	ownerSIDs           map[string]struct{}
	groupSIDs           map[string]struct{}
	descriptorSHA256    *Digest
	accessChecks        []expectedAccessCheck
	allowOwnerDefaulted bool
	allowGroupDefaulted bool
	allowDACLDefaulted  bool
}

// NewExpectedSecurityPolicy creates an immutable policy that checks exact
// owners and explicit DACL semantics separately for ancestors and the file.
// Each supplied StableAccessToken is synchronously duplicated; the returned
// policy owns those duplicates and must be closed by its caller.
func NewExpectedSecurityPolicy(
	ancestor SecurityExpectation,
	file SecurityExpectation,
) (*ExpectedSecurityPolicy, error) {
	ancestorCopy, err := prepareSecurityExpectation("ancestor", ancestor)
	if err != nil {
		return nil, err
	}
	fileCopy, err := prepareSecurityExpectation("file", file)
	if err != nil {
		return nil, errors.Join(err, closeSecurityExpectation(ancestorCopy))
	}
	return &ExpectedSecurityPolicy{
		state: &expectedSecurityPolicyState{
			ancestor: ancestorCopy,
			file:     fileCopy,
		},
	}, nil
}

// CheckAncestor applies the configured ancestor expectation.
func (policy *ExpectedSecurityPolicy) CheckAncestor(request AncestorSecurityRequest) error {
	if policy == nil || policy.state == nil {
		return fmt.Errorf("%w: expected security policy is nil", ErrInvalidPolicy)
	}
	policy.state.mu.RLock()
	defer policy.state.mu.RUnlock()
	if policy.state.closed {
		return fmt.Errorf("%w: expected security policy is closed", ErrInvalidPolicy)
	}
	return policy.check(request.Object, policy.state.ancestor)
}

// CheckFile applies the configured file expectation.
func (policy *ExpectedSecurityPolicy) CheckFile(request FileSecurityRequest) error {
	if policy == nil || policy.state == nil {
		return fmt.Errorf("%w: expected security policy is nil", ErrInvalidPolicy)
	}
	policy.state.mu.RLock()
	defer policy.state.mu.RUnlock()
	if policy.state.closed {
		return fmt.Errorf("%w: expected security policy is closed", ErrInvalidPolicy)
	}
	return policy.check(request.Object, policy.state.file)
}

// Close releases every independently owned token duplicate. It is idempotent
// and waits for in-progress policy checks to finish.
func (policy *ExpectedSecurityPolicy) Close() error {
	if policy == nil || policy.state == nil {
		return nil
	}
	policy.state.mu.Lock()
	defer policy.state.mu.Unlock()
	if policy.state.closed {
		return nil
	}
	policy.state.closed = true
	return errors.Join(
		closeSecurityExpectation(policy.state.ancestor),
		closeSecurityExpectation(policy.state.file),
	)
}

func (policy *ExpectedSecurityPolicy) check(object ObjectEvidence, expectation securityExpectation) error {
	security := object.Evidence.Security
	if _, accepted := expectation.ownerSIDs[security.OwnerSID]; !accepted {
		return fmt.Errorf("%w: %s has unexpected owner %s", ErrPolicyRejected, object.Path, security.OwnerSID)
	}
	if len(expectation.groupSIDs) != 0 {
		if _, accepted := expectation.groupSIDs[security.GroupSID]; !accepted {
			return fmt.Errorf("%w: %s has unexpected group %s", ErrPolicyRejected, object.Path, security.GroupSID)
		}
	}
	if security.OwnerDefaulted && !expectation.allowOwnerDefaulted {
		return fmt.Errorf("%w: %s has a defaulted owner", ErrPolicyRejected, object.Path)
	}
	if security.GroupDefaulted && !expectation.allowGroupDefaulted {
		return fmt.Errorf("%w: %s has a defaulted group", ErrPolicyRejected, object.Path)
	}
	if security.DACLDefaulted && !expectation.allowDACLDefaulted {
		return fmt.Errorf("%w: %s has a defaulted DACL", ErrPolicyRejected, object.Path)
	}
	if expectation.descriptorSHA256 != nil && object.SecurityDescriptorSHA256 != *expectation.descriptorSHA256 {
		return fmt.Errorf("%w: %s security descriptor digest differs from the expected digest", ErrPolicyRejected, object.Path)
	}

	for _, expected := range expectation.accessChecks {
		if err := checkExpectedAccess(object.Path, security, expected); err != nil {
			return err
		}
	}
	return nil
}

func checkExpectedAccess(
	path string,
	security winfile.SecurityDescriptorEvidence,
	expected expectedAccessCheck,
) error {
	if expected.expectedAllowed {
		decision, err := expected.token.CheckAccess(
			cloneSecurityEvidence(security),
			expected.desiredAccess,
			expected.genericMapping,
		)
		if err != nil {
			return fmt.Errorf("%w: %s access check %q failed: %w", ErrPolicyRejected, path, expected.name, err)
		}
		if !decision.Allowed {
			return fmt.Errorf("%w: %s access check %q was denied", ErrPolicyRejected, path, expected.name)
		}
		desired := mapGenericAccess(expected.desiredAccess, expected.genericMapping)
		if decision.GrantedAccess&desired != desired {
			return fmt.Errorf(
				"%w: %s access check %q granted 0x%x, want 0x%x",
				ErrPolicyRejected,
				path,
				expected.name,
				decision.GrantedAccess,
				desired,
			)
		}
		return nil
	}

	for _, bit := range concreteAccessBits(expected.desiredAccess, expected.genericMapping) {
		decision, err := expected.token.CheckAccess(
			cloneSecurityEvidence(security),
			bit,
			expected.genericMapping,
		)
		if err != nil {
			return fmt.Errorf(
				"%w: %s access check %q for bit 0x%x failed: %w",
				ErrPolicyRejected,
				path,
				expected.name,
				bit,
				err,
			)
		}
		if decision.Allowed {
			return fmt.Errorf(
				"%w: %s access check %q unexpectedly allowed bit 0x%x",
				ErrPolicyRejected,
				path,
				expected.name,
				bit,
			)
		}
	}
	return nil
}

func prepareSecurityExpectation(name string, value SecurityExpectation) (securityExpectation, error) {
	owners, err := prepareSIDSet(name+" owners", value.OwnerSIDs, true)
	if err != nil {
		return securityExpectation{}, err
	}
	groups, err := prepareSIDSet(name+" groups", value.GroupSIDs, false)
	if err != nil {
		return securityExpectation{}, err
	}
	if value.DescriptorSHA256 == nil && len(value.AccessChecks) == 0 {
		return securityExpectation{}, fmt.Errorf(
			"%w: %s DACL requires a descriptor digest or AccessCheck expectations",
			ErrInvalidPolicy,
			name,
		)
	}

	seenNames := make(map[string]struct{}, len(value.AccessChecks))
	for _, check := range value.AccessChecks {
		if check.Name == "" || check.Token == nil || check.DesiredAccess == 0 {
			return securityExpectation{}, fmt.Errorf("%w: %s contains an incomplete AccessCheck expectation", ErrInvalidPolicy, name)
		}
		if check.DesiredAccess&maximumAllowedAccess != 0 {
			return securityExpectation{}, fmt.Errorf("%w: %s AccessCheck %q uses MAXIMUM_ALLOWED", ErrInvalidPolicy, name, check.Name)
		}
		if _, duplicate := seenNames[check.Name]; duplicate {
			return securityExpectation{}, fmt.Errorf("%w: %s repeats AccessCheck name %q", ErrInvalidPolicy, name, check.Name)
		}
		seenNames[check.Name] = struct{}{}
		if check.DesiredAccess&genericReadAccess != 0 && check.GenericMapping.Read == 0 ||
			check.DesiredAccess&genericWriteAccess != 0 && check.GenericMapping.Write == 0 ||
			check.DesiredAccess&genericExecuteAccess != 0 && check.GenericMapping.Execute == 0 ||
			check.DesiredAccess&genericAllAccess != 0 && check.GenericMapping.All == 0 {
			return securityExpectation{}, fmt.Errorf("%w: %s AccessCheck %q lacks a generic mapping", ErrInvalidPolicy, name, check.Name)
		}
		mapped := mapGenericAccess(check.DesiredAccess, check.GenericMapping)
		if mapped == 0 || mapped&(genericAccessMask|maximumAllowedAccess) != 0 {
			return securityExpectation{}, fmt.Errorf("%w: %s AccessCheck %q does not map to concrete rights", ErrInvalidPolicy, name, check.Name)
		}
	}

	result := securityExpectation{
		ownerSIDs:           owners,
		groupSIDs:           groups,
		allowOwnerDefaulted: value.AllowOwnerDefaulted,
		allowGroupDefaulted: value.AllowGroupDefaulted,
		allowDACLDefaulted:  value.AllowDACLDefaulted,
	}
	if value.DescriptorSHA256 != nil {
		copy := *value.DescriptorSHA256
		result.descriptorSHA256 = &copy
	}
	for _, check := range value.AccessChecks {
		duplicate, err := check.Token.Duplicate()
		if err != nil {
			return securityExpectation{}, errors.Join(
				fmt.Errorf("%w: duplicate %s AccessCheck token %q: %w", ErrInvalidPolicy, name, check.Name, err),
				closeSecurityExpectation(result),
			)
		}
		result.accessChecks = append(result.accessChecks, expectedAccessCheck{
			name:            check.Name,
			token:           duplicate,
			desiredAccess:   check.DesiredAccess,
			genericMapping:  check.GenericMapping,
			expectedAllowed: check.ExpectedAllowed,
		})
	}
	return result, nil
}

func closeSecurityExpectation(expectation securityExpectation) error {
	var result error
	for _, check := range expectation.accessChecks {
		if err := check.token.Close(); err != nil {
			result = errors.Join(result, fmt.Errorf("close AccessCheck token %q: %w", check.name, err))
		}
	}
	return result
}

func prepareSIDSet(name string, values []string, required bool) (map[string]struct{}, error) {
	if required && len(values) == 0 {
		return nil, fmt.Errorf("%w: %s cannot be empty", ErrInvalidPolicy, name)
	}
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" {
			return nil, fmt.Errorf("%w: %s contains an empty SID", ErrInvalidPolicy, name)
		}
		if _, duplicate := result[value]; duplicate {
			return nil, fmt.Errorf("%w: %s contains duplicate SID %s", ErrInvalidPolicy, name, value)
		}
		result[value] = struct{}{}
	}
	return result, nil
}

func mapGenericAccess(mask winfile.AccessMask, mapping winfile.GenericMapping) winfile.AccessMask {
	if mask&genericReadAccess != 0 {
		mask = mask&^genericReadAccess | mapping.Read
	}
	if mask&genericWriteAccess != 0 {
		mask = mask&^genericWriteAccess | mapping.Write
	}
	if mask&genericExecuteAccess != 0 {
		mask = mask&^genericExecuteAccess | mapping.Execute
	}
	if mask&genericAllAccess != 0 {
		mask = mask&^genericAllAccess | mapping.All
	}
	return mask
}

func concreteAccessBits(mask winfile.AccessMask, mapping winfile.GenericMapping) []winfile.AccessMask {
	mapped := mapGenericAccess(mask, mapping)
	bits := make([]winfile.AccessMask, 0, 32)
	for bit := winfile.AccessMask(1); bit != 0; bit <<= 1 {
		if mapped&bit != 0 {
			bits = append(bits, bit)
		}
	}
	return bits
}

func cloneSecurityEvidence(value winfile.SecurityDescriptorEvidence) winfile.SecurityDescriptorEvidence {
	value.SelfRelativeDescriptor = append([]byte(nil), value.SelfRelativeDescriptor...)
	return value
}

func isNilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflection := reflect.ValueOf(value)
	switch reflection.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflection.IsNil()
	default:
		return false
	}
}
