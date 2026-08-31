package localrpc

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

const (
	RuntimeBootstrapVersion                        = 1
	RuntimeBootstrapMaximumBytes                   = 64 * 1024
	RuntimeBootstrapRoleConfigMaximumBytes         = 47 * 1024
	RuntimeBootstrapARWXProtocolMajor              = 1
	RuntimeBootstrapARWXMinimumMinor               = 0
	RuntimeBootstrapARWXMaximumMinor               = 0
	RuntimeBootstrapARWXMaximumFrameBytes          = 1_048_576
	RuntimeBootstrapARWXMinimumQueuedBytes         = RuntimeBootstrapARWXMaximumFrameBytes
	RuntimeBootstrapARWXMaximumQueuedBytes         = 64 * 1024 * 1024
	RuntimeBootstrapMinimumGracefulTimeoutMS       = 1_000
	RuntimeBootstrapMaximumGracefulTimeoutMS       = 300_000
	RuntimeBootstrapMinimumForceTerminationReserve = 1
)

var (
	ErrInvalidRuntimeBootstrap = errors.New("invalid RuntimeBootstrapV1 document")
	ErrRuntimeBootstrapLimit   = errors.New("RuntimeBootstrapV1 limit exceeded")
	ErrRuntimeBootstrapAck     = errors.New("invalid RuntimeBootstrapAckV1 document")
	ErrRuntimeBootstrapBinding = errors.New("RuntimeBootstrapAckV1 does not bind the expected bootstrap")
	ErrRuntimeBootstrapCommit  = errors.New("invalid RuntimeBootstrapCommitV1 document")

	runtimeBootstrapUUIDV4    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	runtimeBootstrapReleaseID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)
)

// RuntimeBootstrapOptions contains only caller-selected deployment facts. Wire protocol fields are
// fixed by NewRuntimeBootstrap and cannot be selected by its caller.
type RuntimeBootstrapOptions struct {
	BootstrapID                    string
	Role                           Role
	WorkerNodeID                   string
	ReleaseID                      string
	ReleaseTemplateSHA256          string
	InstallationManifestSHA256     string
	PreflightSHA256                string
	NodeBundleSHA256               string
	MaximumQueuedBytesPerDirection int
	GracefulTimeoutMS              int
	ForceTerminationReserveMS      int
	RoleConfigJSON                 []byte
}

type RuntimeBootstrapARWXV1 struct {
	ProtocolMajor                  int `json:"protocolMajor"`
	MinimumMinor                   int `json:"minimumMinor"`
	MaximumMinor                   int `json:"maximumMinor"`
	MaximumFrameBytes              int `json:"maximumFrameBytes"`
	MaximumQueuedBytesPerDirection int `json:"maximumQueuedBytesPerDirection"`
}

type RuntimeBootstrapShutdownV1 struct {
	GracefulTimeoutMS         int `json:"gracefulTimeoutMs"`
	ForceTerminationReserveMS int `json:"forceTerminationReserveMs"`
}

type RuntimeBootstrapRoleConfigV1 struct {
	Base64URL  string `json:"base64Url"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

type RuntimeBootstrapV1 struct {
	ProtocolVersion            string                       `json:"protocolVersion"`
	Type                       string                       `json:"type"`
	BootstrapVersion           int                          `json:"bootstrapVersion"`
	BootstrapID                string                       `json:"bootstrapId"`
	Role                       Role                         `json:"role"`
	WorkerNodeID               string                       `json:"workerNodeId"`
	ReleaseID                  string                       `json:"releaseId"`
	ReleaseTemplateSHA256      string                       `json:"releaseTemplateSha256"`
	InstallationManifestSHA256 string                       `json:"installationManifestSha256"`
	PreflightSHA256            string                       `json:"preflightSha256"`
	NodeBundleSHA256           string                       `json:"nodeBundleSha256"`
	ARWX                       RuntimeBootstrapARWXV1       `json:"arwx"`
	Shutdown                   RuntimeBootstrapShutdownV1   `json:"shutdown"`
	RoleConfig                 RuntimeBootstrapRoleConfigV1 `json:"roleConfig"`
	roleConfigJSON             []byte
}

type RuntimeBootstrapAckV1 struct {
	ProtocolVersion        string `json:"protocolVersion"`
	Type                   string `json:"type"`
	BootstrapVersion       int    `json:"bootstrapVersion"`
	BootstrapID            string `json:"bootstrapId"`
	Role                   Role   `json:"role"`
	BootstrapSHA256        string `json:"bootstrapSha256"`
	Accepted               bool   `json:"accepted"`
	ARWXReceiveLoopStarted bool   `json:"arwxReceiveLoopStarted"`
}

type RuntimeBootstrapCommitV1 struct {
	ProtocolVersion  string `json:"protocolVersion"`
	Type             string `json:"type"`
	BootstrapVersion int    `json:"bootstrapVersion"`
	BootstrapID      string `json:"bootstrapId"`
	Role             Role   `json:"role"`
	BootstrapSHA256  string `json:"bootstrapSha256"`
	Committed        bool   `json:"committed"`
}

func NewRuntimeBootstrap(options RuntimeBootstrapOptions) (RuntimeBootstrapV1, error) {
	if len(options.RoleConfigJSON) > RuntimeBootstrapRoleConfigMaximumBytes {
		return RuntimeBootstrapV1{}, fmt.Errorf("%w: roleConfig", ErrRuntimeBootstrapLimit)
	}
	roleConfigSnapshot := bytes.Clone(options.RoleConfigJSON)
	descriptor, err := describeWorkerAPIBody(roleConfigSnapshot, RuntimeBootstrapRoleConfigMaximumBytes)
	if err != nil {
		return RuntimeBootstrapV1{}, runtimeBootstrapError(err)
	}
	value := RuntimeBootstrapV1{
		ProtocolVersion:            ProtocolVersion,
		Type:                       "runtimeBootstrap",
		BootstrapVersion:           RuntimeBootstrapVersion,
		BootstrapID:                options.BootstrapID,
		Role:                       options.Role,
		WorkerNodeID:               options.WorkerNodeID,
		ReleaseID:                  options.ReleaseID,
		ReleaseTemplateSHA256:      options.ReleaseTemplateSHA256,
		InstallationManifestSHA256: options.InstallationManifestSHA256,
		PreflightSHA256:            options.PreflightSHA256,
		NodeBundleSHA256:           options.NodeBundleSHA256,
		ARWX: RuntimeBootstrapARWXV1{
			ProtocolMajor:                  RuntimeBootstrapARWXProtocolMajor,
			MinimumMinor:                   RuntimeBootstrapARWXMinimumMinor,
			MaximumMinor:                   RuntimeBootstrapARWXMaximumMinor,
			MaximumFrameBytes:              RuntimeBootstrapARWXMaximumFrameBytes,
			MaximumQueuedBytesPerDirection: options.MaximumQueuedBytesPerDirection,
		},
		Shutdown: RuntimeBootstrapShutdownV1{
			GracefulTimeoutMS:         options.GracefulTimeoutMS,
			ForceTerminationReserveMS: options.ForceTerminationReserveMS,
		},
		RoleConfig: RuntimeBootstrapRoleConfigV1{
			Base64URL:  descriptor["base64Url"].(string),
			ByteLength: descriptor["byteLength"].(int),
			SHA256:     descriptor["sha256"].(string),
		},
		roleConfigJSON: roleConfigSnapshot,
	}
	if _, err := EncodeRuntimeBootstrap(value); err != nil {
		return RuntimeBootstrapV1{}, err
	}
	return value, nil
}

func EncodeRuntimeBootstrap(value RuntimeBootstrapV1) ([]byte, error) {
	if _, err := validateRuntimeBootstrap(value); err != nil {
		return nil, err
	}
	document, err := MarshalCanonicalJSON(runtimeBootstrapMap(value), RuntimeBootstrapMaximumBytes)
	if err != nil {
		return nil, runtimeBootstrapError(err)
	}
	return document, nil
}

func DecodeRuntimeBootstrap(document []byte) (RuntimeBootstrapV1, error) {
	if len(document) == 0 || len(document) > RuntimeBootstrapMaximumBytes {
		return RuntimeBootstrapV1{}, fmt.Errorf("%w: document", ErrRuntimeBootstrapLimit)
	}
	snapshot := bytes.Clone(document)
	parsed, err := ParseCanonicalJSON(snapshot, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return RuntimeBootstrapV1{}, runtimeBootstrapError(err)
	}
	if !validRuntimeBootstrapShape(parsed) {
		return RuntimeBootstrapV1{}, fmt.Errorf("%w: schema", ErrInvalidRuntimeBootstrap)
	}
	var value RuntimeBootstrapV1
	if err := decodeExact(snapshot, &value); err != nil {
		return RuntimeBootstrapV1{}, fmt.Errorf("%w: schema", ErrInvalidRuntimeBootstrap)
	}
	roleConfigJSON, err := validateRuntimeBootstrap(value)
	if err != nil {
		return RuntimeBootstrapV1{}, err
	}
	value.roleConfigJSON = roleConfigJSON
	return value, nil
}

// RoleConfigJSON returns a detached copy of the validated exact opaque JSON bytes.
func (value RuntimeBootstrapV1) RoleConfigJSON() []byte {
	return bytes.Clone(value.roleConfigJSON)
}

func NewRuntimeBootstrapAck(bootstrapDocument []byte, expectedRole Role) (RuntimeBootstrapAckV1, error) {
	if len(bootstrapDocument) == 0 || len(bootstrapDocument) > RuntimeBootstrapMaximumBytes {
		return RuntimeBootstrapAckV1{}, fmt.Errorf("%w: document", ErrRuntimeBootstrapLimit)
	}
	snapshot := bytes.Clone(bootstrapDocument)
	bootstrap, err := DecodeRuntimeBootstrap(snapshot)
	if err != nil {
		return RuntimeBootstrapAckV1{}, err
	}
	if !validRuntimeBootstrapRole(expectedRole) || bootstrap.Role != expectedRole {
		return RuntimeBootstrapAckV1{}, fmt.Errorf("%w: role", ErrRuntimeBootstrapBinding)
	}
	digest := sha256.Sum256(snapshot)
	return RuntimeBootstrapAckV1{
		ProtocolVersion:        ProtocolVersion,
		Type:                   "runtimeBootstrapAck",
		BootstrapVersion:       RuntimeBootstrapVersion,
		BootstrapID:            bootstrap.BootstrapID,
		Role:                   bootstrap.Role,
		BootstrapSHA256:        fmt.Sprintf("%x", digest),
		Accepted:               true,
		ARWXReceiveLoopStarted: true,
	}, nil
}

// EncodeRuntimeBootstrapAck constructs and encodes an acknowledgement bound to exact bootstrap
// bytes. It intentionally does not accept a caller-constructed acknowledgement value.
func EncodeRuntimeBootstrapAck(bootstrapDocument []byte, expectedRole Role) ([]byte, error) {
	value, err := NewRuntimeBootstrapAck(bootstrapDocument, expectedRole)
	if err != nil {
		return nil, err
	}
	return encodeRuntimeBootstrapAckValue(value)
}

func encodeRuntimeBootstrapAckValue(value RuntimeBootstrapAckV1) ([]byte, error) {
	if err := validateRuntimeBootstrapAck(value); err != nil {
		return nil, err
	}
	document, err := MarshalCanonicalJSON(map[string]any{
		"accepted":               value.Accepted,
		"arwxReceiveLoopStarted": value.ARWXReceiveLoopStarted,
		"bootstrapId":            value.BootstrapID,
		"bootstrapSha256":        value.BootstrapSHA256,
		"bootstrapVersion":       value.BootstrapVersion,
		"protocolVersion":        value.ProtocolVersion,
		"role":                   string(value.Role),
		"type":                   value.Type,
	}, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return nil, fmt.Errorf("%w: encoding", ErrRuntimeBootstrapAck)
	}
	return document, nil
}

func DecodeRuntimeBootstrapAck(document []byte) (RuntimeBootstrapAckV1, error) {
	if len(document) == 0 || len(document) > RuntimeBootstrapMaximumBytes {
		return RuntimeBootstrapAckV1{}, fmt.Errorf("%w: document", ErrRuntimeBootstrapAck)
	}
	snapshot := bytes.Clone(document)
	parsed, err := ParseCanonicalJSON(snapshot, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return RuntimeBootstrapAckV1{}, fmt.Errorf("%w: canonical document", ErrRuntimeBootstrapAck)
	}
	if _, ok := exactRuntimeBootstrapObject(parsed,
		"accepted", "arwxReceiveLoopStarted", "bootstrapId", "bootstrapSha256",
		"bootstrapVersion", "protocolVersion", "role", "type",
	); !ok {
		return RuntimeBootstrapAckV1{}, fmt.Errorf("%w: schema", ErrRuntimeBootstrapAck)
	}
	var value RuntimeBootstrapAckV1
	if err := decodeExact(snapshot, &value); err != nil {
		return RuntimeBootstrapAckV1{}, fmt.Errorf("%w: schema", ErrRuntimeBootstrapAck)
	}
	if err := validateRuntimeBootstrapAck(value); err != nil {
		return RuntimeBootstrapAckV1{}, err
	}
	return value, nil
}

func ValidateRuntimeBootstrapAck(ackDocument, bootstrapDocument []byte, expectedRole Role) error {
	expected, err := NewRuntimeBootstrapAck(bootstrapDocument, expectedRole)
	if err != nil {
		return err
	}
	actual, err := DecodeRuntimeBootstrapAck(ackDocument)
	if err != nil {
		return err
	}
	if actual.ProtocolVersion != expected.ProtocolVersion || actual.Type != expected.Type ||
		actual.BootstrapVersion != expected.BootstrapVersion || actual.BootstrapID != expected.BootstrapID ||
		actual.Role != expected.Role || actual.Accepted != expected.Accepted ||
		actual.ARWXReceiveLoopStarted != expected.ARWXReceiveLoopStarted ||
		subtle.ConstantTimeCompare([]byte(actual.BootstrapSHA256), []byte(expected.BootstrapSHA256)) != 1 {
		return ErrRuntimeBootstrapBinding
	}
	return nil
}

// EncodeRuntimeBootstrapCommit creates the post-activation commit bound to exact bootstrap bytes.
func EncodeRuntimeBootstrapCommit(bootstrapDocument []byte, expectedRole Role) ([]byte, error) {
	value, err := newRuntimeBootstrapCommit(bootstrapDocument, expectedRole)
	if err != nil {
		return nil, err
	}
	return encodeRuntimeBootstrapCommitValue(value)
}

func DecodeRuntimeBootstrapCommit(document []byte) (RuntimeBootstrapCommitV1, error) {
	if len(document) == 0 || len(document) > RuntimeBootstrapMaximumBytes {
		return RuntimeBootstrapCommitV1{}, fmt.Errorf("%w: document", ErrRuntimeBootstrapCommit)
	}
	snapshot := bytes.Clone(document)
	parsed, err := ParseCanonicalJSON(snapshot, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return RuntimeBootstrapCommitV1{}, fmt.Errorf("%w: canonical document", ErrRuntimeBootstrapCommit)
	}
	if _, ok := exactRuntimeBootstrapObject(parsed,
		"bootstrapId", "bootstrapSha256", "bootstrapVersion", "committed",
		"protocolVersion", "role", "type",
	); !ok {
		return RuntimeBootstrapCommitV1{}, fmt.Errorf("%w: schema", ErrRuntimeBootstrapCommit)
	}
	var value RuntimeBootstrapCommitV1
	if err := decodeExact(snapshot, &value); err != nil || validateRuntimeBootstrapCommit(value) != nil {
		return RuntimeBootstrapCommitV1{}, fmt.Errorf("%w: schema", ErrRuntimeBootstrapCommit)
	}
	return value, nil
}

func ValidateRuntimeBootstrapCommit(
	commitDocument, bootstrapDocument []byte,
	expectedRole Role,
) error {
	expected, err := newRuntimeBootstrapCommit(bootstrapDocument, expectedRole)
	if err != nil {
		return err
	}
	actual, err := DecodeRuntimeBootstrapCommit(commitDocument)
	if err != nil {
		return err
	}
	if actual.ProtocolVersion != expected.ProtocolVersion || actual.Type != expected.Type ||
		actual.BootstrapVersion != expected.BootstrapVersion || actual.BootstrapID != expected.BootstrapID ||
		actual.Role != expected.Role || actual.Committed != expected.Committed ||
		subtle.ConstantTimeCompare([]byte(actual.BootstrapSHA256), []byte(expected.BootstrapSHA256)) != 1 {
		return ErrRuntimeBootstrapBinding
	}
	return nil
}

func newRuntimeBootstrapCommit(
	bootstrapDocument []byte,
	expectedRole Role,
) (RuntimeBootstrapCommitV1, error) {
	if len(bootstrapDocument) == 0 || len(bootstrapDocument) > RuntimeBootstrapMaximumBytes {
		return RuntimeBootstrapCommitV1{}, fmt.Errorf("%w: document", ErrRuntimeBootstrapLimit)
	}
	snapshot := bytes.Clone(bootstrapDocument)
	bootstrap, err := DecodeRuntimeBootstrap(snapshot)
	if err != nil {
		return RuntimeBootstrapCommitV1{}, err
	}
	if !validRuntimeBootstrapRole(expectedRole) || bootstrap.Role != expectedRole {
		return RuntimeBootstrapCommitV1{}, fmt.Errorf("%w: role", ErrRuntimeBootstrapBinding)
	}
	digest := sha256.Sum256(snapshot)
	return RuntimeBootstrapCommitV1{
		ProtocolVersion:  ProtocolVersion,
		Type:             "runtimeBootstrapCommit",
		BootstrapVersion: RuntimeBootstrapVersion,
		BootstrapID:      bootstrap.BootstrapID,
		Role:             bootstrap.Role,
		BootstrapSHA256:  fmt.Sprintf("%x", digest),
		Committed:        true,
	}, nil
}

func encodeRuntimeBootstrapCommitValue(value RuntimeBootstrapCommitV1) ([]byte, error) {
	if err := validateRuntimeBootstrapCommit(value); err != nil {
		return nil, err
	}
	document, err := MarshalCanonicalJSON(map[string]any{
		"bootstrapId":      value.BootstrapID,
		"bootstrapSha256":  value.BootstrapSHA256,
		"bootstrapVersion": value.BootstrapVersion,
		"committed":        value.Committed,
		"protocolVersion":  value.ProtocolVersion,
		"role":             string(value.Role),
		"type":             value.Type,
	}, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return nil, fmt.Errorf("%w: encoding", ErrRuntimeBootstrapCommit)
	}
	return document, nil
}

func validateRuntimeBootstrapCommit(value RuntimeBootstrapCommitV1) error {
	if value.ProtocolVersion != ProtocolVersion || value.Type != "runtimeBootstrapCommit" ||
		value.BootstrapVersion != RuntimeBootstrapVersion || !runtimeBootstrapUUIDV4.MatchString(value.BootstrapID) ||
		!validRuntimeBootstrapRole(value.Role) || !validRuntimeBootstrapDigest(value.BootstrapSHA256) ||
		!value.Committed {
		return ErrRuntimeBootstrapCommit
	}
	return nil
}

func validateRuntimeBootstrap(value RuntimeBootstrapV1) ([]byte, error) {
	if value.ProtocolVersion != ProtocolVersion || value.Type != "runtimeBootstrap" ||
		value.BootstrapVersion != RuntimeBootstrapVersion || !runtimeBootstrapUUIDV4.MatchString(value.BootstrapID) ||
		!validRuntimeBootstrapRole(value.Role) || validateEntityID(value.WorkerNodeID) != nil ||
		!runtimeBootstrapReleaseID.MatchString(value.ReleaseID) ||
		!validRuntimeBootstrapDigest(value.ReleaseTemplateSHA256) ||
		!validRuntimeBootstrapDigest(value.InstallationManifestSHA256) ||
		!validRuntimeBootstrapDigest(value.PreflightSHA256) ||
		!validRuntimeBootstrapDigest(value.NodeBundleSHA256) {
		return nil, ErrInvalidRuntimeBootstrap
	}
	if value.ARWX.ProtocolMajor != RuntimeBootstrapARWXProtocolMajor ||
		value.ARWX.MinimumMinor != RuntimeBootstrapARWXMinimumMinor ||
		value.ARWX.MaximumMinor != RuntimeBootstrapARWXMaximumMinor ||
		value.ARWX.MaximumFrameBytes != RuntimeBootstrapARWXMaximumFrameBytes ||
		value.ARWX.MaximumQueuedBytesPerDirection < RuntimeBootstrapARWXMinimumQueuedBytes ||
		value.ARWX.MaximumQueuedBytesPerDirection > RuntimeBootstrapARWXMaximumQueuedBytes {
		return nil, fmt.Errorf("%w: ARWX limits", ErrInvalidRuntimeBootstrap)
	}
	if value.Shutdown.GracefulTimeoutMS < RuntimeBootstrapMinimumGracefulTimeoutMS ||
		value.Shutdown.GracefulTimeoutMS > RuntimeBootstrapMaximumGracefulTimeoutMS ||
		value.Shutdown.ForceTerminationReserveMS < RuntimeBootstrapMinimumForceTerminationReserve ||
		value.Shutdown.ForceTerminationReserveMS >= value.Shutdown.GracefulTimeoutMS {
		return nil, fmt.Errorf("%w: shutdown limits", ErrInvalidRuntimeBootstrap)
	}
	if len(value.RoleConfig.Base64URL) > RuntimeBootstrapMaximumBytes ||
		value.RoleConfig.ByteLength > RuntimeBootstrapRoleConfigMaximumBytes {
		return nil, fmt.Errorf("%w: roleConfig descriptor", ErrRuntimeBootstrapLimit)
	}
	if len(value.RoleConfig.Base64URL) == 0 || value.RoleConfig.ByteLength < 1 ||
		len(value.RoleConfig.SHA256) != sha256.Size*2 {
		return nil, fmt.Errorf("%w: roleConfig descriptor", ErrInvalidRuntimeBootstrap)
	}
	descriptorDocument, err := MarshalCanonicalJSON(map[string]any{
		"base64Url":  value.RoleConfig.Base64URL,
		"byteLength": value.RoleConfig.ByteLength,
		"sha256":     value.RoleConfig.SHA256,
	}, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return nil, runtimeBootstrapError(err)
	}
	roleConfigJSON, err := decodeWorkerAPIBodyDescriptor(descriptorDocument, RuntimeBootstrapRoleConfigMaximumBytes)
	if err != nil {
		return nil, runtimeBootstrapError(err)
	}
	return bytes.Clone(roleConfigJSON), nil
}

func validateRuntimeBootstrapAck(value RuntimeBootstrapAckV1) error {
	if value.ProtocolVersion != ProtocolVersion || value.Type != "runtimeBootstrapAck" ||
		value.BootstrapVersion != RuntimeBootstrapVersion || !runtimeBootstrapUUIDV4.MatchString(value.BootstrapID) ||
		!validRuntimeBootstrapRole(value.Role) || !validRuntimeBootstrapDigest(value.BootstrapSHA256) ||
		!value.Accepted || !value.ARWXReceiveLoopStarted {
		return ErrRuntimeBootstrapAck
	}
	return nil
}

func runtimeBootstrapMap(value RuntimeBootstrapV1) map[string]any {
	return map[string]any{
		"arwx": map[string]any{
			"maximumFrameBytes":              value.ARWX.MaximumFrameBytes,
			"maximumMinor":                   value.ARWX.MaximumMinor,
			"maximumQueuedBytesPerDirection": value.ARWX.MaximumQueuedBytesPerDirection,
			"minimumMinor":                   value.ARWX.MinimumMinor,
			"protocolMajor":                  value.ARWX.ProtocolMajor,
		},
		"bootstrapId":                value.BootstrapID,
		"bootstrapVersion":           value.BootstrapVersion,
		"installationManifestSha256": value.InstallationManifestSHA256,
		"nodeBundleSha256":           value.NodeBundleSHA256,
		"preflightSha256":            value.PreflightSHA256,
		"protocolVersion":            value.ProtocolVersion,
		"releaseId":                  value.ReleaseID,
		"releaseTemplateSha256":      value.ReleaseTemplateSHA256,
		"role":                       string(value.Role),
		"roleConfig": map[string]any{
			"base64Url":  value.RoleConfig.Base64URL,
			"byteLength": value.RoleConfig.ByteLength,
			"sha256":     value.RoleConfig.SHA256,
		},
		"shutdown": map[string]any{
			"forceTerminationReserveMs": value.Shutdown.ForceTerminationReserveMS,
			"gracefulTimeoutMs":         value.Shutdown.GracefulTimeoutMS,
		},
		"type":         value.Type,
		"workerNodeId": value.WorkerNodeID,
	}
}

func validRuntimeBootstrapRole(role Role) bool {
	return role == RoleControl || role == RoleExecutor
}

func validRuntimeBootstrapShape(value any) bool {
	object, ok := exactRuntimeBootstrapObject(value,
		"arwx", "bootstrapId", "bootstrapVersion", "installationManifestSha256",
		"nodeBundleSha256", "preflightSha256", "protocolVersion", "releaseId",
		"releaseTemplateSha256", "role", "roleConfig", "shutdown", "type", "workerNodeId",
	)
	if !ok {
		return false
	}
	if !runtimeBootstrapJSONNumber(object["bootstrapVersion"]) {
		return false
	}
	arwx, ok := exactRuntimeBootstrapObject(object["arwx"],
		"maximumFrameBytes", "maximumMinor", "maximumQueuedBytesPerDirection",
		"minimumMinor", "protocolMajor",
	)
	if !ok || !runtimeBootstrapJSONNumbers(arwx,
		"maximumFrameBytes", "maximumMinor", "maximumQueuedBytesPerDirection",
		"minimumMinor", "protocolMajor",
	) {
		return false
	}
	shutdown, ok := exactRuntimeBootstrapObject(object["shutdown"],
		"forceTerminationReserveMs", "gracefulTimeoutMs",
	)
	if !ok || !runtimeBootstrapJSONNumbers(shutdown,
		"forceTerminationReserveMs", "gracefulTimeoutMs",
	) {
		return false
	}
	roleConfig, ok := exactRuntimeBootstrapObject(object["roleConfig"], "base64Url", "byteLength", "sha256")
	return ok && runtimeBootstrapJSONNumber(roleConfig["byteLength"])
}

func exactRuntimeBootstrapObject(value any, expected ...string) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	if !ok || len(object) != len(expected) {
		return nil, false
	}
	for _, key := range expected {
		if _, exists := object[key]; !exists {
			return nil, false
		}
	}
	return object, true
}

func runtimeBootstrapJSONNumbers(object map[string]any, keys ...string) bool {
	for _, key := range keys {
		if !runtimeBootstrapJSONNumber(object[key]) {
			return false
		}
	}
	return true
}

func runtimeBootstrapJSONNumber(value any) bool {
	_, ok := value.(json.Number)
	return ok
}

func validRuntimeBootstrapDigest(value string) bool {
	_, err := decodeDigest(value)
	return err == nil
}

func runtimeBootstrapError(err error) error {
	if errors.Is(err, ErrCanonicalJSONLimit) || errors.Is(err, ErrWorkerAPIBodyLimit) {
		return fmt.Errorf("%w: %v", ErrRuntimeBootstrapLimit, err)
	}
	return fmt.Errorf("%w: %v", ErrInvalidRuntimeBootstrap, err)
}
