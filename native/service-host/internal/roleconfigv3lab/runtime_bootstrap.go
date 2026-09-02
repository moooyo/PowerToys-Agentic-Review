package roleconfigv3lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
)

type runtimeBootstrapARWX struct {
	MaximumFrameBytes              int `json:"maximumFrameBytes"`
	MaximumMinor                   int `json:"maximumMinor"`
	MaximumQueuedBytesPerDirection int `json:"maximumQueuedBytesPerDirection"`
	MinimumMinor                   int `json:"minimumMinor"`
	ProtocolMajor                  int `json:"protocolMajor"`
}

type runtimeBootstrapShutdown struct {
	ForceTerminationReserveMS int `json:"forceTerminationReserveMs"`
	GracefulTimeoutMS         int `json:"gracefulTimeoutMs"`
}

type runtimeBootstrapWire struct {
	ARWX                        runtimeBootstrapARWX     `json:"arwx"`
	BootstrapID                 string                   `json:"bootstrapId"`
	BootstrapVersion            int                      `json:"bootstrapVersion"`
	CompletionMode              string                   `json:"completionMode"`
	ExecutionAuthority          bool                     `json:"executionAuthority"`
	HostControl                 hostControlSelection     `json:"hostControl"`
	InstallationManifestSHA256  string                   `json:"installationManifestSha256"`
	JobExecutionEnvelopeVersion int                      `json:"jobExecutionEnvelopeVersion"`
	NodeBundleSHA256            string                   `json:"nodeBundleSha256"`
	PreflightSHA256             string                   `json:"preflightSha256"`
	ProtocolVersion             string                   `json:"protocolVersion"`
	ReleaseID                   string                   `json:"releaseId"`
	ReleaseTemplateSHA256       string                   `json:"releaseTemplateSha256"`
	Role                        Role                     `json:"role"`
	RoleConfig                  bodyDescriptor           `json:"roleConfig"`
	Shutdown                    runtimeBootstrapShutdown `json:"shutdown"`
	Type                        string                   `json:"type"`
	WorkerNodeID                string                   `json:"workerNodeId"`
}

type RuntimeBootstrapFacts struct {
	BootstrapID                    string
	ForceTerminationReserveMS      int
	GracefulTimeoutMS              int
	InstallationManifestSHA256     string
	MaximumQueuedBytesPerDirection int
	NodeBundleSHA256               string
	PreflightSHA256                string
	ReleaseID                      string
	ReleaseTemplateSHA256          string
	Role                           Role
	RoleConfig                     RoleConfig
	WorkerNodeID                   string
}

type RuntimeBootstrap struct {
	state *runtimeBootstrapState
}

type runtimeBootstrapState struct {
	document   []byte
	digest     [sha256.Size]byte
	role       Role
	roleConfig RoleConfig
}

// DisabledReadinessProjection is not an ARWX Ready wire message and grants no Ready authority.
type DisabledReadinessProjection struct {
	AvailableSlots     int    `json:"availableSlots"`
	ExecutionAuthority bool   `json:"executionAuthority"`
	Ready              bool   `json:"ready"`
	ReasonCode         string `json:"reasonCode"`
}

// NewRuntimeBootstrap creates only a dormant data document. ProtocolVersion selects the
// local HostControl RPC 2.0 contract; it is not a Worker API or ARWX version.
func NewRuntimeBootstrap(facts RuntimeBootstrapFacts) (RuntimeBootstrap, error) {
	roleConfigDocument, roleConfigRole, err := snapshotRoleConfig(facts.RoleConfig)
	if err != nil || roleConfigRole != facts.Role {
		return RuntimeBootstrap{}, errors.Join(ErrInvalidRuntimeBootstrap, ErrInvalidRoleConfig)
	}
	roleConfigDigest := sha256.Sum256(roleConfigDocument)
	value := map[string]any{
		"arwx": map[string]any{
			"maximumFrameBytes":              RuntimeBootstrapARWXMaximumFrameBytes,
			"maximumMinor":                   ARWXProtocolMinor,
			"maximumQueuedBytesPerDirection": facts.MaximumQueuedBytesPerDirection,
			"minimumMinor":                   ARWXProtocolMinor,
			"protocolMajor":                  ARWXProtocolMajor,
		},
		"bootstrapId":        facts.BootstrapID,
		"bootstrapVersion":   RuntimeBootstrapVersion,
		"completionMode":     CompletionMode,
		"executionAuthority": false,
		"hostControl": map[string]any{
			"operations":      stringsAsAny(hostControlOperations[:]),
			"protocolVersion": HostControlProtocolVersion,
		},
		"installationManifestSha256":  facts.InstallationManifestSHA256,
		"jobExecutionEnvelopeVersion": JobExecutionEnvelopeVersion,
		"nodeBundleSha256":            facts.NodeBundleSHA256,
		"preflightSha256":             facts.PreflightSHA256,
		"protocolVersion":             RuntimeBootstrapHostControlRPCVersion,
		"releaseId":                   facts.ReleaseID,
		"releaseTemplateSha256":       facts.ReleaseTemplateSHA256,
		"role":                        string(facts.Role),
		"roleConfig": map[string]any{
			"base64Url":  base64.RawURLEncoding.EncodeToString(roleConfigDocument),
			"byteLength": len(roleConfigDocument),
			"sha256":     hex.EncodeToString(roleConfigDigest[:]),
		},
		"shutdown": map[string]any{
			"forceTerminationReserveMs": facts.ForceTerminationReserveMS,
			"gracefulTimeoutMs":         facts.GracefulTimeoutMS,
		},
		"type":         "runtimeBootstrap",
		"workerNodeId": facts.WorkerNodeID,
	}
	document, err := localrpc.MarshalCanonicalJSON(value, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return RuntimeBootstrap{}, errors.Join(ErrInvalidRuntimeBootstrap, err)
	}
	return ParseRuntimeBootstrap(document, facts.Role)
}

func ParseRuntimeBootstrap(document []byte, expectedRole Role) (RuntimeBootstrap, error) {
	if !validRole(expectedRole) || len(document) == 0 || len(document) > RuntimeBootstrapMaximumBytes {
		return RuntimeBootstrap{}, ErrInvalidRuntimeBootstrap
	}
	snapshot := bytes.Clone(document)
	parsed, err := localrpc.ParseCanonicalJSON(snapshot, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return RuntimeBootstrap{}, errors.Join(ErrInvalidRuntimeBootstrap, err)
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return RuntimeBootstrap{}, ErrInvalidRuntimeBootstrap
	}
	if actualRole, ok := object["role"].(string); ok &&
		validRole(Role(actualRole)) && Role(actualRole) != expectedRole {
		if _, err := validateParsedRuntimeBootstrap(snapshot, object, Role(actualRole)); err != nil {
			return RuntimeBootstrap{}, ErrInvalidRuntimeBootstrap
		}
		return RuntimeBootstrap{}, ErrRoleMismatch
	}
	roleConfig, err := validateParsedRuntimeBootstrap(snapshot, object, expectedRole)
	if err != nil {
		return RuntimeBootstrap{}, errors.Join(ErrInvalidRuntimeBootstrap, err)
	}
	return RuntimeBootstrap{state: &runtimeBootstrapState{
		document:   snapshot,
		digest:     sha256.Sum256(snapshot),
		role:       expectedRole,
		roleConfig: roleConfig,
	}}, nil
}

func validateParsedRuntimeBootstrap(
	document []byte,
	object map[string]any,
	role Role,
) (RoleConfig, error) {
	validated, ok := exactObject(object,
		"arwx", "bootstrapId", "bootstrapVersion", "completionMode", "executionAuthority",
		"hostControl", "installationManifestSha256", "jobExecutionEnvelopeVersion",
		"nodeBundleSha256", "preflightSha256", "protocolVersion", "releaseId",
		"releaseTemplateSha256", "role", "roleConfig", "shutdown", "type", "workerNodeId",
	)
	if !ok {
		return RoleConfig{}, ErrInvalidRuntimeBootstrap
	}
	object = validated
	if _, valid := exactObject(
		object["arwx"], "maximumFrameBytes", "maximumMinor",
		"maximumQueuedBytesPerDirection", "minimumMinor", "protocolMajor",
	); !valid {
		return RoleConfig{}, ErrInvalidRuntimeBootstrap
	}
	if _, valid := exactObject(object["hostControl"], "operations", "protocolVersion"); !valid {
		return RoleConfig{}, ErrInvalidRuntimeBootstrap
	}
	if _, valid := exactObject(object["roleConfig"], "base64Url", "byteLength", "sha256"); !valid {
		return RoleConfig{}, ErrInvalidRuntimeBootstrap
	}
	if _, valid := exactObject(object["shutdown"], "forceTerminationReserveMs", "gracefulTimeoutMs"); !valid {
		return RoleConfig{}, ErrInvalidRuntimeBootstrap
	}
	if !validRuntimeBootstrapJSONTypes(object) {
		return RoleConfig{}, ErrInvalidRuntimeBootstrap
	}

	var wire runtimeBootstrapWire
	if err := decodeExact(document, &wire); err != nil || !validRuntimeBootstrapWire(wire, role) {
		return RoleConfig{}, errors.Join(ErrInvalidRuntimeBootstrap, err)
	}
	roleConfigDocument, err := decodeRoleConfigDescriptor(wire.RoleConfig)
	if err != nil {
		return RoleConfig{}, errors.Join(ErrInvalidRuntimeBootstrap, err)
	}
	roleConfig, err := ParseRoleConfig(roleConfigDocument, role)
	if err != nil {
		return RoleConfig{}, ErrInvalidRoleConfig
	}
	return roleConfig, nil
}

func (bootstrap RuntimeBootstrap) CanonicalJSON() ([]byte, error) {
	if bootstrap.state == nil {
		return nil, ErrInvalidRuntimeBootstrap
	}
	return bytes.Clone(bootstrap.state.document), nil
}

func (bootstrap RuntimeBootstrap) SHA256() (string, error) {
	if bootstrap.state == nil || bootstrap.state.digest == ([sha256.Size]byte{}) {
		return "", ErrInvalidRuntimeBootstrap
	}
	return hex.EncodeToString(bootstrap.state.digest[:]), nil
}

func (bootstrap RuntimeBootstrap) Role() (Role, error) {
	if bootstrap.state == nil || !validRole(bootstrap.state.role) {
		return "", ErrInvalidRuntimeBootstrap
	}
	return bootstrap.state.role, nil
}

func (bootstrap RuntimeBootstrap) RoleConfig() (RoleConfig, error) {
	if bootstrap.state == nil || bootstrap.state.roleConfig.state == nil {
		return RoleConfig{}, ErrInvalidRuntimeBootstrap
	}
	return bootstrap.state.roleConfig, nil
}

func (bootstrap RuntimeBootstrap) ExecutionAuthority() bool {
	return false
}

func (bootstrap RuntimeBootstrap) DisabledReadiness() DisabledReadinessProjection {
	return DisabledReadinessProjection{
		AvailableSlots:     0,
		ExecutionAuthority: false,
		Ready:              false,
		ReasonCode:         DisabledReasonCode,
	}
}

func snapshotRoleConfig(config RoleConfig) ([]byte, Role, error) {
	if config.state == nil || !validRole(config.state.role) {
		return nil, "", ErrInvalidRoleConfig
	}
	return bytes.Clone(config.state.document), config.state.role, nil
}

func validRuntimeBootstrapWire(wire runtimeBootstrapWire, role Role) bool {
	return wire.ARWX.MaximumFrameBytes == RuntimeBootstrapARWXMaximumFrameBytes &&
		wire.ARWX.MaximumMinor == ARWXProtocolMinor &&
		wire.ARWX.MaximumQueuedBytesPerDirection >= RuntimeBootstrapARWXMinimumQueuedBytes &&
		wire.ARWX.MaximumQueuedBytesPerDirection <= RuntimeBootstrapARWXMaximumQueuedBytes &&
		wire.ARWX.MinimumMinor == ARWXProtocolMinor &&
		wire.ARWX.ProtocolMajor == ARWXProtocolMajor &&
		uuidV4Pattern.MatchString(wire.BootstrapID) &&
		wire.BootstrapVersion == RuntimeBootstrapVersion &&
		wire.CompletionMode == CompletionMode &&
		!wire.ExecutionAuthority &&
		wire.HostControl.ProtocolVersion == HostControlProtocolVersion &&
		equalStrings(wire.HostControl.Operations, hostControlOperations[:]) &&
		validDigest(wire.InstallationManifestSHA256) &&
		wire.JobExecutionEnvelopeVersion == JobExecutionEnvelopeVersion &&
		validDigest(wire.NodeBundleSHA256) &&
		validDigest(wire.PreflightSHA256) &&
		wire.ProtocolVersion == RuntimeBootstrapHostControlRPCVersion &&
		releaseIDPattern.MatchString(wire.ReleaseID) &&
		validDigest(wire.ReleaseTemplateSHA256) &&
		wire.Role == role &&
		wire.Shutdown.ForceTerminationReserveMS >= RuntimeBootstrapMinimumTerminationReserve &&
		wire.Shutdown.ForceTerminationReserveMS < wire.Shutdown.GracefulTimeoutMS &&
		wire.Shutdown.GracefulTimeoutMS >= RuntimeBootstrapMinimumGracefulTimeoutMS &&
		wire.Shutdown.GracefulTimeoutMS <= RuntimeBootstrapMaximumGracefulTimeoutMS &&
		wire.Type == "runtimeBootstrap" &&
		entityIDPattern.MatchString(wire.WorkerNodeID)
}

func validRuntimeBootstrapJSONTypes(object map[string]any) bool {
	for _, key := range []string{
		"bootstrapId", "completionMode", "installationManifestSha256", "nodeBundleSha256",
		"preflightSha256", "protocolVersion", "releaseId", "releaseTemplateSha256", "role",
		"type", "workerNodeId",
	} {
		if _, ok := object[key].(string); !ok {
			return false
		}
	}
	if _, ok := object["executionAuthority"].(bool); !ok {
		return false
	}
	for _, key := range []string{"bootstrapVersion", "jobExecutionEnvelopeVersion"} {
		if !isJSONNumber(object[key]) {
			return false
		}
	}
	arwx, _ := object["arwx"].(map[string]any)
	for _, key := range []string{
		"maximumFrameBytes", "maximumMinor", "maximumQueuedBytesPerDirection", "minimumMinor",
		"protocolMajor",
	} {
		if !isJSONNumber(arwx[key]) {
			return false
		}
	}
	hostControl, _ := object["hostControl"].(map[string]any)
	if _, ok := hostControl["protocolVersion"].(string); !ok ||
		!isJSONStringArray(hostControl["operations"]) {
		return false
	}
	roleConfig, _ := object["roleConfig"].(map[string]any)
	if _, ok := roleConfig["base64Url"].(string); !ok {
		return false
	}
	if !isJSONNumber(roleConfig["byteLength"]) {
		return false
	}
	if _, ok := roleConfig["sha256"].(string); !ok {
		return false
	}
	shutdown, _ := object["shutdown"].(map[string]any)
	return isJSONNumber(shutdown["forceTerminationReserveMs"]) &&
		isJSONNumber(shutdown["gracefulTimeoutMs"])
}

func decodeRoleConfigDescriptor(descriptor bodyDescriptor) ([]byte, error) {
	if descriptor.ByteLength < 1 || descriptor.ByteLength > RoleConfigMaximumBytes ||
		!validDigest(descriptor.SHA256) {
		return nil, ErrInvalidRoleConfig
	}
	document, err := base64.RawURLEncoding.DecodeString(descriptor.Base64URL)
	if err != nil || base64.RawURLEncoding.EncodeToString(document) != descriptor.Base64URL ||
		len(document) != descriptor.ByteLength {
		return nil, ErrInvalidRoleConfig
	}
	digest := sha256.Sum256(document)
	if hex.EncodeToString(digest[:]) != descriptor.SHA256 {
		return nil, ErrInvalidRoleConfig
	}
	return bytes.Clone(document), nil
}
