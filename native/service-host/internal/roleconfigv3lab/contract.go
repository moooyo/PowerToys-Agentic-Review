// Package roleconfigv3lab defines dormant, permanently disabled RoleConfig v3 and
// RuntimeBootstrapV2 lab documents. It grants no production or Claim authority.
package roleconfigv3lab

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
)

const (
	RoleConfigMaximumBytes                    = 16 * 1024
	PublicKeyMaximumBytes                     = 4 * 1024
	RoleConfigProfile                         = "disabled-execution-lab-v1"
	DisabledReasonCode                        = "EXECUTION_DISABLED"
	FoundationVersion                         = 3
	HostControlProtocolVersion                = "2.0"
	ARWXProtocolMajor                         = 1
	ARWXProtocolMinor                         = 1
	JobExecutionEnvelopeVersion               = 2
	CompletionMode                            = "result_artifact_v1"
	RequiredRuntimeBootstrapVersion           = 2
	RequiredWorkerAPIVersion                  = "1.1"
	RuntimeBootstrapVersion                   = 2
	RuntimeBootstrapHostControlRPCVersion     = "2.0"
	RuntimeBootstrapMaximumBytes              = 64 * 1024
	RuntimeBootstrapARWXMaximumFrameBytes     = 1_048_576
	RuntimeBootstrapARWXMinimumQueuedBytes    = RuntimeBootstrapARWXMaximumFrameBytes
	RuntimeBootstrapARWXMaximumQueuedBytes    = 64 * 1024 * 1024
	RuntimeBootstrapMinimumGracefulTimeoutMS  = 1_000
	RuntimeBootstrapMaximumGracefulTimeoutMS  = 300_000
	RuntimeBootstrapMinimumTerminationReserve = 1
)

const canonicalP256SPKIPrefixHex = "3059301306072a8648ce3d020106082a8648ce3d03010703420004"

type Role string

const (
	RoleControl  Role = "control"
	RoleExecutor Role = "executor"
)

var (
	ErrInvalidRoleConfig       = errors.New("invalid RoleConfig v3 lab document")
	ErrInvalidPublicKey        = errors.New("invalid RoleConfig v3 lab public key")
	ErrRoleMismatch            = errors.New("RoleConfig v3 lab role mismatch")
	ErrInvalidRuntimeBootstrap = errors.New("invalid RuntimeBootstrapV2 lab document")

	entityIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	releaseIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)
	uuidV4Pattern    = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
	)
)

var hostControlOperations = [...]string{
	"CreateArtifactUpload",
	"PutArtifactChunk",
	"FinalizeArtifactUpload",
	"TerminateArtifactUpload",
	"CompleteArtifactRun",
}

var missingPrerequisites = [...]string{
	"artifact_readiness_attestation",
	"arwx_1_1_semantic_verifiers",
	"enrollment_live_evidence",
	"hostcontrol_v2_production_composition",
	"job_execution_envelope_v2_claim_selection",
	"migration_inventory_gate_off_rollback_binary",
	"persistent_exact_node_allowlist",
	"release_compatibility_profile_v2",
	"role_config_v3_production_authority",
	"runtime_bootstrap_v2_production_exchange",
	"server_global_rollout_gate_default_off",
	"server_binding_receipt",
	"signed_matching_packages",
	"signed_node_attestation",
	"windows_arm64_signed_install_attack_rollback_evidence",
	"windows_x64_signed_install_attack_rollback_evidence",
	"worker_api_1_1",
	"worker_claim_envelope_v2_consumer",
}

type arwxSelection struct {
	MaximumMinor  int `json:"maximumMinor"`
	MinimumMinor  int `json:"minimumMinor"`
	ProtocolMajor int `json:"protocolMajor"`
}

type hostControlSelection struct {
	Operations      []string `json:"operations"`
	ProtocolVersion string   `json:"protocolVersion"`
}

type publicKeyDescriptor struct {
	Base64URL  string `json:"base64Url"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

type bodyDescriptor struct {
	Base64URL  string `json:"base64Url"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

func validRole(role Role) bool {
	return role == RoleControl || role == RoleExecutor
}

func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func equalStrings(actual []string, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	for index := range expected {
		if actual[index] != expected[index] {
			return false
		}
	}
	return true
}

func stringsAsAny(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func exactObject(value any, keys ...string) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	if !ok || len(object) != len(keys) {
		return nil, false
	}
	for _, key := range keys {
		if _, exists := object[key]; !exists {
			return nil, false
		}
	}
	return object, true
}

func isJSONNumber(value any) bool {
	_, ok := value.(json.Number)
	return ok
}

func isJSONStringArray(value any) bool {
	items, ok := value.([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		if _, ok := item.(string); !ok {
			return false
		}
	}
	return true
}

func decodeExact(document []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("document contains trailing JSON")
	}
	return nil
}
