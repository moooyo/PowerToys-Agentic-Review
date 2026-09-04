package roleconfigv3lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
)

type roleConfigWire struct {
	ActivationState                 string               `json:"activationState"`
	ARWX                            arwxSelection        `json:"arwx"`
	AvailableSlots                  int                  `json:"availableSlots"`
	CompletionMode                  string               `json:"completionMode"`
	DisabledReasonCode              string               `json:"disabledReasonCode"`
	ExecutionAuthority              bool                 `json:"executionAuthority"`
	ExecutionFlag                   bool                 `json:"executionEnabled"`
	ExecutorPolicySHA256            string               `json:"executorPolicySha256"`
	FoundationVersion               int                  `json:"foundationVersion"`
	GlobalRolloutDefault            string               `json:"globalRolloutDefault"`
	HostControl                     hostControlSelection `json:"hostControl"`
	JobExecutionEnvelopeVersion     int                  `json:"jobExecutionEnvelopeVersion"`
	PhysicalSlots                   int                  `json:"maximumSlots"`
	MissingPrerequisites            []string             `json:"missingPrerequisites"`
	Profile                         string               `json:"profile"`
	RequiredRuntimeBootstrapVersion int                  `json:"requiredRuntimeBootstrapVersion"`
	RequiredWorkerAPIVersion        string               `json:"requiredWorkerApiVersion"`
	Role                            Role                 `json:"role"`
}

type RoleConfig struct {
	state *roleConfigState
}

type roleConfigState struct {
	document []byte
	digest   [sha256.Size]byte
	role     Role
}

func NewControlRoleConfig(executorPolicySHA256 string) (RoleConfig, error) {
	if !validDigest(executorPolicySHA256) {
		return RoleConfig{}, ErrInvalidRoleConfig
	}
	return newRoleConfig(roleConfigValue(RoleControl, executorPolicySHA256), RoleControl)
}

func NewExecutorRoleConfig(executorPolicySHA256 string) (RoleConfig, error) {
	if !validDigest(executorPolicySHA256) {
		return RoleConfig{}, ErrInvalidRoleConfig
	}
	return newRoleConfig(roleConfigValue(RoleExecutor, executorPolicySHA256), RoleExecutor)
}

func ParseRoleConfig(document []byte, expectedRole Role) (RoleConfig, error) {
	if !validRole(expectedRole) || len(document) == 0 || len(document) > RoleConfigMaximumBytes {
		return RoleConfig{}, ErrInvalidRoleConfig
	}
	snapshot := bytes.Clone(document)
	parsed, err := localrpc.ParseCanonicalJSON(snapshot, RoleConfigMaximumBytes)
	if err != nil {
		return RoleConfig{}, errors.Join(ErrInvalidRoleConfig, err)
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return RoleConfig{}, ErrInvalidRoleConfig
	}
	if actualRole, ok := object["role"].(string); ok &&
		validRole(Role(actualRole)) && Role(actualRole) != expectedRole {
		if err := validateParsedRoleConfig(snapshot, object, Role(actualRole)); err != nil {
			return RoleConfig{}, ErrInvalidRoleConfig
		}
		return RoleConfig{}, ErrRoleMismatch
	}
	if err := validateParsedRoleConfig(snapshot, object, expectedRole); err != nil {
		return RoleConfig{}, errors.Join(ErrInvalidRoleConfig, err)
	}
	return RoleConfig{state: &roleConfigState{
		document: snapshot,
		digest:   sha256.Sum256(snapshot),
		role:     expectedRole,
	}}, nil
}

func validateParsedRoleConfig(document []byte, object map[string]any, role Role) error {
	expectedKeys := []string{
		"activationState", "arwx", "availableSlots", "completionMode", "disabledReasonCode",
		"executionAuthority", "executionEnabled", "executorPolicySha256", "foundationVersion",
		"globalRolloutDefault", "hostControl", "jobExecutionEnvelopeVersion",
		"maximumSlots", "missingPrerequisites", "profile", "requiredRuntimeBootstrapVersion",
		"requiredWorkerApiVersion", "role",
	}
	validated, ok := exactObject(object, expectedKeys...)
	if !ok {
		return ErrInvalidRoleConfig
	}
	object = validated
	if _, valid := exactObject(object["arwx"], "maximumMinor", "minimumMinor", "protocolMajor"); !valid {
		return ErrInvalidRoleConfig
	}
	if _, valid := exactObject(object["hostControl"], "operations", "protocolVersion"); !valid {
		return ErrInvalidRoleConfig
	}
	if !validRoleConfigJSONTypes(object, role) {
		return ErrInvalidRoleConfig
	}

	var wire roleConfigWire
	if err := decodeExact(document, &wire); err != nil || !validRoleConfigWire(wire, role) {
		return errors.Join(ErrInvalidRoleConfig, err)
	}
	return nil
}

func (config RoleConfig) CanonicalJSON() ([]byte, error) {
	if config.state == nil {
		return nil, ErrInvalidRoleConfig
	}
	return bytes.Clone(config.state.document), nil
}

func (config RoleConfig) Role() (Role, error) {
	if config.state == nil || !validRole(config.state.role) {
		return "", ErrInvalidRoleConfig
	}
	return config.state.role, nil
}

func (config RoleConfig) SHA256() (string, error) {
	if config.state == nil || config.state.digest == ([sha256.Size]byte{}) {
		return "", ErrInvalidRoleConfig
	}
	return hex.EncodeToString(config.state.digest[:]), nil
}

func newRoleConfig(value map[string]any, role Role) (RoleConfig, error) {
	document, err := localrpc.MarshalCanonicalJSON(value, RoleConfigMaximumBytes)
	if err != nil {
		return RoleConfig{}, errors.Join(ErrInvalidRoleConfig, err)
	}
	return ParseRoleConfig(document, role)
}

func roleConfigValue(role Role, executorPolicySHA256 string) map[string]any {
	return map[string]any{
		"activationState": "blocked",
		"arwx": map[string]any{
			"maximumMinor":  ARWXProtocolMinor,
			"minimumMinor":  ARWXProtocolMinor,
			"protocolMajor": ARWXProtocolMajor,
		},
		"availableSlots":       0,
		"completionMode":       CompletionMode,
		"disabledReasonCode":   DisabledReasonCode,
		"executionAuthority":   false,
		"executionEnabled":     false,
		"executorPolicySha256": executorPolicySHA256,
		"foundationVersion":    FoundationVersion,
		"globalRolloutDefault": "off",
		"hostControl": map[string]any{
			"operations":      stringsAsAny(hostControlOperations[:]),
			"protocolVersion": HostControlProtocolVersion,
		},
		"jobExecutionEnvelopeVersion":     JobExecutionEnvelopeVersion,
		"maximumSlots":                    1,
		"missingPrerequisites":            stringsAsAny(missingPrerequisites[:]),
		"profile":                         RoleConfigProfile,
		"requiredRuntimeBootstrapVersion": RequiredRuntimeBootstrapVersion,
		"requiredWorkerApiVersion":        RequiredWorkerAPIVersion,
		"role":                            string(role),
	}
}

func validRoleConfigWire(wire roleConfigWire, role Role) bool {
	return wire.ActivationState == "blocked" &&
		wire.ARWX.MaximumMinor == ARWXProtocolMinor &&
		wire.ARWX.MinimumMinor == ARWXProtocolMinor &&
		wire.ARWX.ProtocolMajor == ARWXProtocolMajor &&
		wire.AvailableSlots == 0 &&
		wire.CompletionMode == CompletionMode &&
		wire.DisabledReasonCode == DisabledReasonCode &&
		!wire.ExecutionAuthority &&
		!wire.ExecutionFlag &&
		validDigest(wire.ExecutorPolicySHA256) &&
		wire.FoundationVersion == FoundationVersion &&
		wire.GlobalRolloutDefault == "off" &&
		wire.HostControl.ProtocolVersion == HostControlProtocolVersion &&
		equalStrings(wire.HostControl.Operations, hostControlOperations[:]) &&
		wire.JobExecutionEnvelopeVersion == JobExecutionEnvelopeVersion &&
		wire.PhysicalSlots == 1 &&
		equalStrings(wire.MissingPrerequisites, missingPrerequisites[:]) &&
		wire.Profile == RoleConfigProfile &&
		wire.RequiredRuntimeBootstrapVersion == RequiredRuntimeBootstrapVersion &&
		wire.RequiredWorkerAPIVersion == RequiredWorkerAPIVersion &&
		wire.Role == role
}

func validRoleConfigJSONTypes(object map[string]any, role Role) bool {
	for _, key := range []string{
		"activationState", "completionMode", "disabledReasonCode", "executorPolicySha256",
		"globalRolloutDefault", "profile", "requiredWorkerApiVersion", "role",
	} {
		if _, ok := object[key].(string); !ok {
			return false
		}
	}
	for _, key := range []string{"executionAuthority", "executionEnabled"} {
		if _, ok := object[key].(bool); !ok {
			return false
		}
	}
	for _, key := range []string{
		"availableSlots", "foundationVersion", "jobExecutionEnvelopeVersion", "maximumSlots",
		"requiredRuntimeBootstrapVersion",
	} {
		if !isJSONNumber(object[key]) {
			return false
		}
	}
	if !isJSONStringArray(object["missingPrerequisites"]) {
		return false
	}
	arwx, _ := object["arwx"].(map[string]any)
	for _, key := range []string{"maximumMinor", "minimumMinor", "protocolMajor"} {
		if !isJSONNumber(arwx[key]) {
			return false
		}
	}
	hostControl, _ := object["hostControl"].(map[string]any)
	if _, ok := hostControl["protocolVersion"].(string); !ok ||
		!isJSONStringArray(hostControl["operations"]) {
		return false
	}
	return true
}
