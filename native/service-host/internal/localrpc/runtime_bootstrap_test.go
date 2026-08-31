package localrpc

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestRuntimeBootstrapMatchesSharedCrossLanguageGolden(t *testing.T) {
	golden := runtimeBootstrapGolden(t)
	bootstrap, err := NewRuntimeBootstrap(validRuntimeBootstrapOptions())
	if err != nil {
		t.Fatalf("NewRuntimeBootstrap returned an error: %v", err)
	}
	document, err := EncodeRuntimeBootstrap(bootstrap)
	if err != nil {
		t.Fatalf("EncodeRuntimeBootstrap returned an error: %v", err)
	}
	if !bytes.Equal(document, golden) {
		t.Fatalf("encoded bootstrap = %s, want %s", document, golden)
	}

	decoded, err := DecodeRuntimeBootstrap(golden)
	if err != nil {
		t.Fatalf("DecodeRuntimeBootstrap returned an error: %v", err)
	}
	if decoded.Role != RoleControl || decoded.WorkerNodeID != "powertoys-node:01" ||
		!bytes.Equal(decoded.RoleConfigJSON(), []byte(crossLanguageWorkerAPIBody)) {
		t.Fatalf("decoded bootstrap = %#v, role config = %s", decoded, decoded.RoleConfigJSON())
	}
	roleConfig := decoded.RoleConfigJSON()
	roleConfig[0] = 'X'
	if bytes.Equal(roleConfig, decoded.RoleConfigJSON()) {
		t.Fatal("RoleConfigJSON returned aliased storage")
	}

	ackDocument, err := EncodeRuntimeBootstrapAck(golden, RoleControl)
	if err != nil {
		t.Fatalf("EncodeRuntimeBootstrapAck returned an error: %v", err)
	}
	digest := sha256.Sum256(golden)
	wantAck := fmt.Sprintf(
		`{"accepted":true,"arwxReceiveLoopStarted":true,"bootstrapId":"123e4567-e89b-42d3-a456-426614174000","bootstrapSha256":"%x","bootstrapVersion":1,"protocolVersion":"1.0","role":"control","type":"runtimeBootstrapAck"}`,
		digest,
	)
	if string(ackDocument) != wantAck {
		t.Fatalf("encoded ack = %s, want %s", ackDocument, wantAck)
	}
	if err := ValidateRuntimeBootstrapAck(ackDocument, golden, RoleControl); err != nil {
		t.Fatalf("ValidateRuntimeBootstrapAck returned an error: %v", err)
	}
	commitDocument, err := EncodeRuntimeBootstrapCommit(golden, RoleControl)
	if err != nil {
		t.Fatalf("EncodeRuntimeBootstrapCommit returned an error: %v", err)
	}
	wantCommit := fmt.Sprintf(
		`{"bootstrapId":"123e4567-e89b-42d3-a456-426614174000","bootstrapSha256":"%x","bootstrapVersion":1,"committed":true,"protocolVersion":"1.0","role":"control","type":"runtimeBootstrapCommit"}`,
		digest,
	)
	if string(commitDocument) != wantCommit {
		t.Fatalf("encoded commit = %s, want %s", commitDocument, wantCommit)
	}
	if err := ValidateRuntimeBootstrapCommit(commitDocument, golden, RoleControl); err != nil {
		t.Fatalf("ValidateRuntimeBootstrapCommit returned an error: %v", err)
	}
}

func TestRuntimeBootstrapSupportsBothRoles(t *testing.T) {
	options := validRuntimeBootstrapOptions()
	options.Role = RoleExecutor
	bootstrap, err := NewRuntimeBootstrap(options)
	if err != nil {
		t.Fatal(err)
	}
	document, err := EncodeRuntimeBootstrap(bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeRuntimeBootstrap(document)
	if err != nil || decoded.Role != RoleExecutor {
		t.Fatalf("DecodeRuntimeBootstrap = (%#v, %v)", decoded, err)
	}
}

func TestRuntimeBootstrapAckBindsOpaqueRoleConfigExactBytes(t *testing.T) {
	firstOptions := validRuntimeBootstrapOptions()
	firstOptions.RoleConfigJSON = []byte(`{"confidence":0.8}`)
	secondOptions := firstOptions
	secondOptions.RoleConfigJSON = []byte(` { "confidence" : 0.8 } `)

	first, err := NewRuntimeBootstrap(firstOptions)
	if err != nil {
		t.Fatal(err)
	}
	firstDocument, err := EncodeRuntimeBootstrap(first)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewRuntimeBootstrap(secondOptions)
	if err != nil {
		t.Fatal(err)
	}
	secondDocument, err := EncodeRuntimeBootstrap(second)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(firstDocument, secondDocument) {
		t.Fatal("distinct roleConfig bytes produced the same bootstrap")
	}
	ack, err := EncodeRuntimeBootstrapAck(firstDocument, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateRuntimeBootstrapAck(ack, secondDocument, RoleControl); !errors.Is(err, ErrRuntimeBootstrapBinding) {
		t.Fatalf("exact-byte binding error = %v", err)
	}
}

func TestRuntimeBootstrapRejectsEveryWireFieldMutation(t *testing.T) {
	valid, err := NewRuntimeBootstrap(validRuntimeBootstrapOptions())
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*RuntimeBootstrapV1)
	}{
		{"protocol version", func(v *RuntimeBootstrapV1) { v.ProtocolVersion = "1.1" }},
		{"type", func(v *RuntimeBootstrapV1) { v.Type = "bootstrap" }},
		{"bootstrap version", func(v *RuntimeBootstrapV1) { v.BootstrapVersion = 2 }},
		{"bootstrap ID", func(v *RuntimeBootstrapV1) { v.BootstrapID = "123e4567-e89b-12d3-a456-426614174000" }},
		{"role", func(v *RuntimeBootstrapV1) { v.Role = Role("other") }},
		{"worker node ID", func(v *RuntimeBootstrapV1) { v.WorkerNodeID = "bad node" }},
		{"release ID", func(v *RuntimeBootstrapV1) { v.ReleaseID = "bad release" }},
		{"release template digest", func(v *RuntimeBootstrapV1) { v.ReleaseTemplateSHA256 = strings.Repeat("A", 64) }},
		{"installation manifest digest", func(v *RuntimeBootstrapV1) { v.InstallationManifestSHA256 = strings.Repeat("A", 64) }},
		{"preflight digest", func(v *RuntimeBootstrapV1) { v.PreflightSHA256 = strings.Repeat("A", 64) }},
		{"Node bundle digest", func(v *RuntimeBootstrapV1) { v.NodeBundleSHA256 = strings.Repeat("A", 64) }},
		{"ARWX protocol major", func(v *RuntimeBootstrapV1) { v.ARWX.ProtocolMajor = 2 }},
		{"ARWX minimum minor", func(v *RuntimeBootstrapV1) { v.ARWX.MinimumMinor = 1 }},
		{"ARWX maximum minor", func(v *RuntimeBootstrapV1) { v.ARWX.MaximumMinor = 1 }},
		{"ARWX frame maximum", func(v *RuntimeBootstrapV1) { v.ARWX.MaximumFrameBytes-- }},
		{"ARWX queue minimum", func(v *RuntimeBootstrapV1) {
			v.ARWX.MaximumQueuedBytesPerDirection = RuntimeBootstrapARWXMinimumQueuedBytes - 1
		}},
		{"ARWX queue maximum", func(v *RuntimeBootstrapV1) {
			v.ARWX.MaximumQueuedBytesPerDirection = RuntimeBootstrapARWXMaximumQueuedBytes + 1
		}},
		{"graceful timeout minimum", func(v *RuntimeBootstrapV1) {
			v.Shutdown.GracefulTimeoutMS = RuntimeBootstrapMinimumGracefulTimeoutMS - 1
		}},
		{"graceful timeout", func(v *RuntimeBootstrapV1) {
			v.Shutdown.GracefulTimeoutMS = RuntimeBootstrapMaximumGracefulTimeoutMS + 1
		}},
		{"force reserve minimum", func(v *RuntimeBootstrapV1) { v.Shutdown.ForceTerminationReserveMS = 0 }},
		{"force reserve", func(v *RuntimeBootstrapV1) { v.Shutdown.ForceTerminationReserveMS = v.Shutdown.GracefulTimeoutMS }},
		{"role config encoding", func(v *RuntimeBootstrapV1) { v.RoleConfig.Base64URL = "e30=" }},
		{"role config length", func(v *RuntimeBootstrapV1) { v.RoleConfig.ByteLength++ }},
		{"role config digest", func(v *RuntimeBootstrapV1) { v.RoleConfig.SHA256 = strings.Repeat("0", 64) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			if _, err := EncodeRuntimeBootstrap(candidate); err == nil {
				t.Fatal("EncodeRuntimeBootstrap accepted a mutated field")
			}
		})
	}
}

func TestRuntimeBootstrapAcceptsExactLimitEndpoints(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*RuntimeBootstrapOptions)
	}{
		{"minimums", func(options *RuntimeBootstrapOptions) {
			options.MaximumQueuedBytesPerDirection = RuntimeBootstrapARWXMinimumQueuedBytes
			options.GracefulTimeoutMS = RuntimeBootstrapMinimumGracefulTimeoutMS
			options.ForceTerminationReserveMS = RuntimeBootstrapMinimumForceTerminationReserve
		}},
		{"maximums", func(options *RuntimeBootstrapOptions) {
			options.MaximumQueuedBytesPerDirection = RuntimeBootstrapARWXMaximumQueuedBytes
			options.GracefulTimeoutMS = RuntimeBootstrapMaximumGracefulTimeoutMS
			options.ForceTerminationReserveMS = RuntimeBootstrapMaximumGracefulTimeoutMS - 1
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := validRuntimeBootstrapOptions()
			test.mutate(&options)
			bootstrap, err := NewRuntimeBootstrap(options)
			if err != nil {
				t.Fatal(err)
			}
			document, err := EncodeRuntimeBootstrap(bootstrap)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := DecodeRuntimeBootstrap(document); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRuntimeBootstrapRejectsEveryMissingWireField(t *testing.T) {
	fields := []struct {
		parent string
		key    string
	}{
		{key: "protocolVersion"},
		{key: "type"},
		{key: "bootstrapVersion"},
		{key: "bootstrapId"},
		{key: "role"},
		{key: "workerNodeId"},
		{key: "releaseId"},
		{key: "releaseTemplateSha256"},
		{key: "installationManifestSha256"},
		{key: "preflightSha256"},
		{key: "nodeBundleSha256"},
		{key: "arwx"},
		{key: "shutdown"},
		{key: "roleConfig"},
		{parent: "arwx", key: "protocolMajor"},
		{parent: "arwx", key: "minimumMinor"},
		{parent: "arwx", key: "maximumMinor"},
		{parent: "arwx", key: "maximumFrameBytes"},
		{parent: "arwx", key: "maximumQueuedBytesPerDirection"},
		{parent: "shutdown", key: "gracefulTimeoutMs"},
		{parent: "shutdown", key: "forceTerminationReserveMs"},
		{parent: "roleConfig", key: "base64Url"},
		{parent: "roleConfig", key: "byteLength"},
		{parent: "roleConfig", key: "sha256"},
	}
	for _, field := range fields {
		name := field.key
		if field.parent != "" {
			name = field.parent + "." + field.key
		}
		t.Run(name, func(t *testing.T) {
			parsed, err := ParseCanonicalJSON(runtimeBootstrapGolden(t), RuntimeBootstrapMaximumBytes)
			if err != nil {
				t.Fatal(err)
			}
			object := parsed.(map[string]any)
			target := object
			if field.parent != "" {
				target = object[field.parent].(map[string]any)
			}
			delete(target, field.key)
			if _, err := DecodeRuntimeBootstrap(canonicalForTest(t, object)); err == nil {
				t.Fatal("DecodeRuntimeBootstrap accepted a missing field")
			}
		})
	}
}

func TestRuntimeBootstrapRejectsNullNumericFields(t *testing.T) {
	for _, field := range []string{"minimumMinor", "maximumMinor"} {
		t.Run(field, func(t *testing.T) {
			parsed, err := ParseCanonicalJSON(runtimeBootstrapGolden(t), RuntimeBootstrapMaximumBytes)
			if err != nil {
				t.Fatal(err)
			}
			object := parsed.(map[string]any)
			object["arwx"].(map[string]any)[field] = nil
			if _, err := DecodeRuntimeBootstrap(canonicalForTest(t, object)); err == nil {
				t.Fatal("DecodeRuntimeBootstrap accepted a null numeric field")
			}
		})
	}
}

func TestRuntimeBootstrapRejectsAmbiguousOrOversizedDocuments(t *testing.T) {
	golden := runtimeBootstrapGolden(t)
	parsed, err := ParseCanonicalJSON(golden, RuntimeBootstrapMaximumBytes)
	if err != nil {
		t.Fatal(err)
	}
	object := parsed.(map[string]any)
	object["extra"] = true
	unknown := canonicalForTest(t, object)

	roleConfigArray := []byte(`[0.8,1.7976931348623157e+308,5e-324]`)
	invalidRoleConfig := validRuntimeBootstrapOptions()
	invalidRoleConfig.RoleConfigJSON = roleConfigArray

	valid := validRuntimeBootstrapOptions()
	valid.Role = RoleExecutor
	valid.WorkerNodeID = "n" + strings.Repeat("a", 127)
	valid.ReleaseID = "r" + strings.Repeat("a", 127)
	valid.MaximumQueuedBytesPerDirection = RuntimeBootstrapARWXMaximumQueuedBytes
	valid.GracefulTimeoutMS = RuntimeBootstrapMaximumGracefulTimeoutMS
	valid.ForceTerminationReserveMS = RuntimeBootstrapMaximumGracefulTimeoutMS - 1
	atDecodedLimit := []byte(`{"padding":"` + strings.Repeat("x", RuntimeBootstrapRoleConfigMaximumBytes-14) + `"}`)
	if len(atDecodedLimit) != RuntimeBootstrapRoleConfigMaximumBytes {
		t.Fatalf("role config fixture length = %d", len(atDecodedLimit))
	}
	valid.RoleConfigJSON = atDecodedLimit

	tests := []struct {
		name     string
		document []byte
	}{
		{"unknown field", unknown},
		{"duplicate field", bytes.Replace(golden, []byte(`"role":"control"`), []byte(`"role":"control","role":"control"`), 1)},
		{"noncanonical whitespace", append(bytes.Clone(golden), ' ')},
		{"unsafe integer", bytes.Replace(golden, []byte(`4194304`), []byte(`9007199254740992`), 1)},
		{"oversized document", bytes.Repeat([]byte{'x'}, RuntimeBootstrapMaximumBytes+1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := DecodeRuntimeBootstrap(test.document); err == nil {
				t.Fatal("DecodeRuntimeBootstrap accepted an invalid document")
			}
		})
	}
	if _, err := NewRuntimeBootstrap(invalidRoleConfig); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("array role config error = %v", err)
	}
	maximumRoleConfig, err := NewRuntimeBootstrap(valid)
	if err != nil {
		t.Fatalf("maximum roleConfig was rejected: %v", err)
	}
	maximumDocument, err := EncodeRuntimeBootstrap(maximumRoleConfig)
	if err != nil || len(maximumDocument) > RuntimeBootstrapMaximumBytes {
		t.Fatalf("maximum roleConfig envelope = %d bytes, error %v", len(maximumDocument), err)
	}
	valid.RoleConfigJSON = append(atDecodedLimit, ' ')
	if _, err := NewRuntimeBootstrap(valid); !errors.Is(err, ErrRuntimeBootstrapLimit) {
		t.Fatalf("decoded role config limit error = %v, want ErrRuntimeBootstrapLimit", err)
	}
}

func TestRuntimeBootstrapAckRejectsMutationAndNegativeAcknowledgement(t *testing.T) {
	golden := runtimeBootstrapGolden(t)
	valid, err := NewRuntimeBootstrapAck(golden, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*RuntimeBootstrapAckV1)
	}{
		{"protocol version", func(v *RuntimeBootstrapAckV1) { v.ProtocolVersion = "1.1" }},
		{"type", func(v *RuntimeBootstrapAckV1) { v.Type = "ack" }},
		{"bootstrap version", func(v *RuntimeBootstrapAckV1) { v.BootstrapVersion = 2 }},
		{"bootstrap ID", func(v *RuntimeBootstrapAckV1) { v.BootstrapID = "bad" }},
		{"bootstrap digest", func(v *RuntimeBootstrapAckV1) { v.BootstrapSHA256 = strings.Repeat("A", 64) }},
		{"negative acknowledgement", func(v *RuntimeBootstrapAckV1) { v.Accepted = false }},
		{"ARWX receive loop not started", func(v *RuntimeBootstrapAckV1) { v.ARWXReceiveLoopStarted = false }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			if _, err := encodeRuntimeBootstrapAckValue(candidate); err == nil {
				t.Fatal("EncodeRuntimeBootstrapAck accepted a mutated field")
			}
		})
	}

	tampered := valid
	tampered.BootstrapID = "123e4567-e89b-42d3-b456-426614174000"
	tamperedDocument, err := encodeRuntimeBootstrapAckValue(tampered)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateRuntimeBootstrapAck(tamperedDocument, golden, RoleControl); !errors.Is(err, ErrRuntimeBootstrapBinding) {
		t.Fatalf("binding error = %v", err)
	}
	tamperedRole := valid
	tamperedRole.Role = RoleExecutor
	tamperedRoleDocument, err := encodeRuntimeBootstrapAckValue(tamperedRole)
	if err != nil {
		t.Fatalf("encode schema-valid mismatched role: %v", err)
	}
	if err := ValidateRuntimeBootstrapAck(tamperedRoleDocument, golden, RoleControl); !errors.Is(err, ErrRuntimeBootstrapBinding) {
		t.Fatalf("role binding validation error = %v", err)
	}
	if _, err := NewRuntimeBootstrapAck(golden, RoleExecutor); !errors.Is(err, ErrRuntimeBootstrapBinding) {
		t.Fatalf("role binding error = %v", err)
	}

	validDocument, err := encodeRuntimeBootstrapAckValue(valid)
	if err != nil {
		t.Fatal(err)
	}
	unknown := bytes.Replace(validDocument, []byte(`{"accepted":true`), []byte(`{"accepted":true,"extra":true`), 1)
	duplicate := bytes.Replace(validDocument, []byte(`"accepted":true`), []byte(`"accepted":true,"accepted":true`), 1)
	for _, document := range [][]byte{unknown, duplicate, append(bytes.Clone(validDocument), ' ')} {
		if _, err := DecodeRuntimeBootstrapAck(document); err == nil {
			t.Fatalf("DecodeRuntimeBootstrapAck accepted %s", document)
		}
	}
	for _, key := range []string{
		"accepted", "arwxReceiveLoopStarted", "bootstrapId", "bootstrapSha256",
		"bootstrapVersion", "protocolVersion", "role", "type",
	} {
		parsed, err := ParseCanonicalJSON(validDocument, RuntimeBootstrapMaximumBytes)
		if err != nil {
			t.Fatal(err)
		}
		object := parsed.(map[string]any)
		delete(object, key)
		if _, err := DecodeRuntimeBootstrapAck(canonicalForTest(t, object)); err == nil {
			t.Fatalf("DecodeRuntimeBootstrapAck accepted missing %s", key)
		}
	}
}

func validRuntimeBootstrapOptions() RuntimeBootstrapOptions {
	return RuntimeBootstrapOptions{
		BootstrapID:                    "123e4567-e89b-42d3-a456-426614174000",
		Role:                           RoleControl,
		WorkerNodeID:                   "powertoys-node:01",
		ReleaseID:                      "2026.08.31-test+1",
		ReleaseTemplateSHA256:          strings.Repeat("1", 64),
		InstallationManifestSHA256:     strings.Repeat("2", 64),
		PreflightSHA256:                strings.Repeat("3", 64),
		NodeBundleSHA256:               strings.Repeat("4", 64),
		MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		GracefulTimeoutMS:              120_000,
		ForceTerminationReserveMS:      15_000,
		RoleConfigJSON:                 []byte(crossLanguageWorkerAPIBody),
	}
}

func runtimeBootstrapGolden(t *testing.T) []byte {
	t.Helper()
	document, err := os.ReadFile("testdata/runtime_bootstrap_v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(document) < 2 || document[len(document)-1] != '\n' || document[len(document)-2] == '\r' {
		t.Fatal("runtime bootstrap golden must have exactly one LF repository delimiter")
	}
	return bytes.Clone(document[:len(document)-1])
}
