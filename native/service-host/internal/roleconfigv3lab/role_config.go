package roleconfigv3lab

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

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
	LocalAuthorityKeyID             string               `json:"localAuthorityKeyId"`
	LocalAuthorityPublicKeySPKI     *publicKeyDescriptor `json:"localAuthorityPublicKeySpki,omitempty"`
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

func NewControlRoleConfig(executorPolicySHA256, localAuthorityKeyID string) (RoleConfig, error) {
	if !validDigest(executorPolicySHA256) || !validDigest(localAuthorityKeyID) {
		return RoleConfig{}, ErrInvalidRoleConfig
	}
	return newRoleConfig(roleConfigValue(RoleControl, executorPolicySHA256, localAuthorityKeyID), RoleControl)
}

func NewExecutorRoleConfig(executorPolicySHA256 string, publicKeySPKI []byte) (RoleConfig, error) {
	if !validDigest(executorPolicySHA256) {
		return RoleConfig{}, ErrInvalidRoleConfig
	}
	publicKey := bytes.Clone(publicKeySPKI)
	if err := validateP256SPKI(publicKey); err != nil {
		return RoleConfig{}, err
	}
	digest := sha256.Sum256(publicKey)
	keyID := hex.EncodeToString(digest[:])
	value := roleConfigValue(RoleExecutor, executorPolicySHA256, keyID)
	value["localAuthorityPublicKeySpki"] = map[string]any{
		"base64Url":  base64.RawURLEncoding.EncodeToString(publicKey),
		"byteLength": len(publicKey),
		"sha256":     keyID,
	}
	return newRoleConfig(value, RoleExecutor)
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
		"globalRolloutDefault", "hostControl", "jobExecutionEnvelopeVersion", "localAuthorityKeyId",
		"maximumSlots", "missingPrerequisites", "profile", "requiredRuntimeBootstrapVersion",
		"requiredWorkerApiVersion", "role",
	}
	if role == RoleExecutor {
		expectedKeys = append(expectedKeys, "localAuthorityPublicKeySpki")
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
	if role == RoleExecutor {
		if _, valid := exactObject(
			object["localAuthorityPublicKeySpki"], "base64Url", "byteLength", "sha256",
		); !valid {
			return ErrInvalidRoleConfig
		}
	}
	if !validRoleConfigJSONTypes(object, role) {
		return ErrInvalidRoleConfig
	}

	var wire roleConfigWire
	if err := decodeExact(document, &wire); err != nil || !validRoleConfigWire(wire, role) {
		return errors.Join(ErrInvalidRoleConfig, err)
	}
	if role == RoleExecutor {
		if err := validateExecutorDescriptor(wire); err != nil {
			return err
		}
	} else if wire.LocalAuthorityPublicKeySPKI != nil {
		return ErrInvalidRoleConfig
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

func roleConfigValue(role Role, executorPolicySHA256, localAuthorityKeyID string) map[string]any {
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
		"localAuthorityKeyId":             localAuthorityKeyID,
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
		validDigest(wire.LocalAuthorityKeyID) &&
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
		"globalRolloutDefault", "localAuthorityKeyId", "profile", "requiredWorkerApiVersion", "role",
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
	if role == RoleExecutor {
		descriptor, _ := object["localAuthorityPublicKeySpki"].(map[string]any)
		if _, ok := descriptor["base64Url"].(string); !ok {
			return false
		}
		if !isJSONNumber(descriptor["byteLength"]) {
			return false
		}
		if _, ok := descriptor["sha256"].(string); !ok {
			return false
		}
	}
	return true
}

func validateExecutorDescriptor(wire roleConfigWire) error {
	descriptor := wire.LocalAuthorityPublicKeySPKI
	if descriptor == nil || descriptor.ByteLength < 1 || descriptor.ByteLength > PublicKeyMaximumBytes ||
		!validDigest(descriptor.SHA256) || descriptor.SHA256 != wire.LocalAuthorityKeyID {
		return ErrInvalidPublicKey
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(descriptor.Base64URL)
	if err != nil || base64.RawURLEncoding.EncodeToString(publicKey) != descriptor.Base64URL ||
		len(publicKey) != descriptor.ByteLength {
		return ErrInvalidPublicKey
	}
	digest := sha256.Sum256(publicKey)
	decodedDigest, err := hex.DecodeString(descriptor.SHA256)
	if err != nil || subtle.ConstantTimeCompare(digest[:], decodedDigest) != 1 {
		return ErrInvalidPublicKey
	}
	return validateP256SPKI(publicKey)
}

func validateP256SPKI(document []byte) error {
	prefix, err := hex.DecodeString(canonicalP256SPKIPrefixHex)
	if err != nil || len(document) != 91 || !bytes.HasPrefix(document, prefix) {
		return ErrInvalidPublicKey
	}
	parsed, err := x509.ParsePKIXPublicKey(document)
	if err != nil {
		return errors.Join(ErrInvalidPublicKey, err)
	}
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() {
		return ErrInvalidPublicKey
	}
	canonical, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return errors.Join(ErrInvalidPublicKey, fmt.Errorf("marshal P-256 DER SPKI: %w", err))
	}
	if !bytes.Equal(canonical, document) {
		return fmt.Errorf("%w: public key is not canonical P-256 DER SPKI", ErrInvalidPublicKey)
	}
	return nil
}
