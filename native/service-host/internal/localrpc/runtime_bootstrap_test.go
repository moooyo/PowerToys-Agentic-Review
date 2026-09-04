package localrpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestRuntimeBootstrapMatchesSharedCrossLanguageGolden(t *testing.T) {
	golden := runtimeBootstrapGolden(t)
	bootstrap, err := newRuntimeBootstrap(validRuntimeBootstrapOptions())
	if err != nil {
		t.Fatalf("newRuntimeBootstrap returned an error: %v", err)
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
	expectedRoleConfig, err := foundationRoleConfigJSON(validFoundationRuntimeBootstrapOptions(RoleControl))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Role != RoleControl || decoded.WorkerNodeID != "powertoys-node:01" ||
		!bytes.Equal(decoded.RoleConfigJSON(), expectedRoleConfig) {
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

func TestLaunchRuntimeBootstrapExposesNoConstructibleAuthorityFields(t *testing.T) {
	typeOfValue := reflect.TypeOf(LaunchRuntimeBootstrap{})
	if typeOfValue.NumField() != 1 || typeOfValue.Field(0).IsExported() {
		t.Fatalf("LaunchRuntimeBootstrap fields = %v", typeOfValue)
	}
}

func TestRuntimeBootstrapSupportsBothRoles(t *testing.T) {
	options := validRuntimeBootstrapOptions()
	options.Role = RoleExecutor
	bootstrap, err := newRuntimeBootstrap(options)
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

func TestFoundationRuntimeBootstrapFixesUUIDRoleConfigAndTotalShutdown(t *testing.T) {
	tests := []struct {
		name        string
		role        Role
		entropy     []byte
		bootstrapID string
	}{
		{
			name:        "control zero entropy",
			role:        RoleControl,
			entropy:     make([]byte, 16),
			bootstrapID: "00000000-0000-4000-8000-000000000000",
		},
		{
			name:        "executor maximum entropy",
			role:        RoleExecutor,
			entropy:     bytes.Repeat([]byte{0xff}, 16),
			bootstrapID: "ffffffff-ffff-4fff-bfff-ffffffffffff",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := validFoundationRuntimeBootstrapOptions(test.role)
			roleConfig, err := foundationRoleConfigJSON(options)
			if err != nil {
				t.Fatal(err)
			}
			roleDigest := sha256.Sum256(roleConfig)
			bootstrap, err := newFoundationRuntimeBootstrap(options, bytes.NewReader(test.entropy))
			if err != nil {
				t.Fatal(err)
			}
			if bootstrap.BootstrapID != test.bootstrapID || bootstrap.Role != test.role {
				t.Fatalf("bootstrap identity = (%q, %q)", bootstrap.BootstrapID, bootstrap.Role)
			}
			if !bytes.Equal(bootstrap.RoleConfigJSON(), roleConfig) ||
				bootstrap.RoleConfig.ByteLength != len(roleConfig) ||
				bootstrap.RoleConfig.SHA256 != hex.EncodeToString(roleDigest[:]) {
				t.Fatalf("roleConfig = (%s, %#v)", bootstrap.RoleConfigJSON(), bootstrap.RoleConfig)
			}
			if bootstrap.Shutdown.GracefulTimeoutMS != options.TotalShutdownTimeoutMS ||
				bootstrap.Shutdown.ForceTerminationReserveMS != options.ForceTerminationReserveMS {
				t.Fatalf("shutdown limits = %#v, options = %#v", bootstrap.Shutdown, options)
			}
		})
	}
}

func TestFoundationRuntimeBootstrapUsesPrivateEntropyAndFailsClosed(t *testing.T) {
	options := validFoundationRuntimeBootstrapOptions(RoleControl)
	bootstrap, err := NewFoundationRuntimeBootstrap(options)
	if err != nil {
		t.Fatal(err)
	}
	if !runtimeBootstrapUUIDV4.MatchString(bootstrap.BootstrapID) {
		t.Fatalf("public factory bootstrapId = %q", bootstrap.BootstrapID)
	}

	if _, err := newFoundationRuntimeBootstrap(options, nil); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("nil entropy error = %v", err)
	}
	if _, err := newFoundationRuntimeBootstrap(options, bytes.NewReader(make([]byte, 15))); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("short entropy error = %v", err)
	}
	for _, role := range []Role{"", "Control", "other"} {
		invalidRole := options
		invalidRole.Role = role
		reader := &countingRuntimeBootstrapEntropy{}
		if _, err := newFoundationRuntimeBootstrap(invalidRole, reader); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
			t.Fatalf("invalid role %q error = %v", role, err)
		}
		if reader.reads != 0 {
			t.Fatalf("invalid role %q consumed entropy %d times", role, reader.reads)
		}
	}
	entropyFailure := errors.New("entropy failed")
	if _, err := newFoundationRuntimeBootstrap(
		options,
		runtimeBootstrapEntropyError{err: entropyFailure},
	); !errors.Is(err, ErrInvalidRuntimeBootstrap) || !errors.Is(err, entropyFailure) {
		t.Fatalf("entropy failure error = %v", err)
	}
}

func TestFoundationRuntimeBootstrapRejectsInvalidFactsBeforeEntropy(t *testing.T) {
	tests := []struct {
		name   string
		role   Role
		mutate func(*FoundationRuntimeBootstrapOptions)
	}{
		{
			name: "invalid role",
			role: RoleControl,
			mutate: func(value *FoundationRuntimeBootstrapOptions) {
				value.Role = Role("invalid")
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := validFoundationRuntimeBootstrapOptions(test.role)
			test.mutate(&options)
			entropy := &countingRuntimeBootstrapEntropy{}
			if _, err := newFoundationRuntimeBootstrap(options, entropy); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
				t.Fatalf("invalid role facts error = %v", err)
			}
			if entropy.reads != 0 {
				t.Fatalf("invalid role facts consumed entropy %d times", entropy.reads)
			}
		})
	}
}

func TestRuntimeBootstrapOutboundAuthorityRejectsDecodedOrMutatedValues(t *testing.T) {
	issued, err := newFoundationRuntimeBootstrap(
		validFoundationRuntimeBootstrapOptions(RoleControl),
		bytes.NewReader(make([]byte, 16)),
	)
	if err != nil {
		t.Fatal(err)
	}
	document, err := EncodeRuntimeBootstrap(issued)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeRuntimeBootstrap(document)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EncodeRuntimeBootstrap(decoded); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("decoded bootstrap encode error = %v", err)
	}
	if _, err := BindRuntimeBootstrapToLaunch(
		decoded,
		validFoundationRuntimeBootstrapOptions(decoded.Role),
	); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("decoded bootstrap launch binding error = %v", err)
	}
	otherRoleConfigDescriptor, err := describeWorkerAPIBody(
		[]byte(` { "executionEnabled" : false, "foundationVersion" : 1, "role" : "control" } `),
		RuntimeBootstrapRoleConfigMaximumBytes,
	)
	if err != nil {
		t.Fatal(err)
	}
	otherRoleConfig := RuntimeBootstrapRoleConfigV1{
		Base64URL:  otherRoleConfigDescriptor["base64Url"].(string),
		ByteLength: otherRoleConfigDescriptor["byteLength"].(int),
		SHA256:     otherRoleConfigDescriptor["sha256"].(string),
	}

	mutations := []struct {
		name   string
		mutate func(*RuntimeBootstrapV1)
	}{
		{"worker node", func(value *RuntimeBootstrapV1) { value.WorkerNodeID = "other-node" }},
		{"queue", func(value *RuntimeBootstrapV1) { value.ARWX.MaximumQueuedBytesPerDirection++ }},
		{"role config", func(value *RuntimeBootstrapV1) { value.RoleConfig = otherRoleConfig }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			candidate := issued
			test.mutate(&candidate)
			if _, err := EncodeRuntimeBootstrap(candidate); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
				t.Fatalf("mutated bootstrap encode error = %v", err)
			}
		})
	}
}

func TestRuntimeBootstrapLaunchBindingMatchesEveryExpectedFact(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(*FoundationRuntimeBootstrapOptions)
	}{
		{"role", func(value *FoundationRuntimeBootstrapOptions) { value.Role = RoleExecutor }},
		{"worker node", func(value *FoundationRuntimeBootstrapOptions) { value.WorkerNodeID = "other-node" }},
		{"queue", func(value *FoundationRuntimeBootstrapOptions) { value.MaximumQueuedBytesPerDirection++ }},
		{"shutdown", func(value *FoundationRuntimeBootstrapOptions) { value.TotalShutdownTimeoutMS++ }},
		{"reserve", func(value *FoundationRuntimeBootstrapOptions) { value.ForceTerminationReserveMS++ }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			expected := validFoundationRuntimeBootstrapOptions(RoleControl)
			issued, err := newFoundationRuntimeBootstrap(expected, bytes.NewReader(make([]byte, 16)))
			if err != nil {
				t.Fatal(err)
			}
			mismatch := expected
			test.mutate(&mismatch)
			if _, err := BindRuntimeBootstrapToLaunch(issued, mismatch); !errors.Is(err, ErrRuntimeBootstrapBinding) {
				t.Fatalf("mismatched launch binding error = %v", err)
			}
			if _, err := BindRuntimeBootstrapToLaunch(issued, expected); err != nil {
				t.Fatalf("failed mismatch burned issuance: %v", err)
			}
		})
	}
}

func TestRuntimeBootstrapLaunchBindingCopiesAreImmutableAndSingleUse(t *testing.T) {
	expected := validFoundationRuntimeBootstrapOptions(RoleControl)
	issued, err := newFoundationRuntimeBootstrap(expected, bytes.NewReader(make([]byte, 16)))
	if err != nil {
		t.Fatal(err)
	}
	document, err := EncodeRuntimeBootstrap(issued)
	if err != nil {
		t.Fatal(err)
	}
	issuedCopy := issued
	bound, err := BindRuntimeBootstrapToLaunch(issued, expected)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := BindRuntimeBootstrapToLaunch(issuedCopy, expected); !errors.Is(err, ErrRuntimeBootstrapBinding) {
		t.Fatalf("issued copy rebound error = %v", err)
	}
	boundCopy := bound
	issued.WorkerNodeID = "mutated-after-binding"
	decoded, consumedDocument, err := consumeLaunchRuntimeBootstrapIssuance(bound)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.WorkerNodeID != expected.WorkerNodeID || !bytes.Equal(consumedDocument, document) {
		t.Fatal("bound bootstrap did not retain immutable canonical bytes")
	}
	if _, _, err := consumeLaunchRuntimeBootstrapIssuance(boundCopy); !errors.Is(err, ErrRuntimeBootstrapBinding) {
		t.Fatalf("bound copy reuse error = %v", err)
	}
}

func TestRuntimeBootstrapLaunchBindingRejectsConcurrentCopies(t *testing.T) {
	expected := validFoundationRuntimeBootstrapOptions(RoleControl)
	issued, err := newFoundationRuntimeBootstrap(expected, bytes.NewReader(make([]byte, 16)))
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var group sync.WaitGroup
	for range 2 {
		candidate := issued
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			_, bindErr := BindRuntimeBootstrapToLaunch(candidate, expected)
			results <- bindErr
		}()
	}
	close(start)
	group.Wait()
	close(results)
	succeeded := 0
	rejected := 0
	for result := range results {
		switch {
		case result == nil:
			succeeded++
		case errors.Is(result, ErrRuntimeBootstrapBinding):
			rejected++
		default:
			t.Fatalf("concurrent bind error = %v", result)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent bind outcomes = success:%d rejected:%d", succeeded, rejected)
	}
}

func TestRuntimeBootstrapAckBindsOpaqueRoleConfigExactBytes(t *testing.T) {
	firstOptions := validRuntimeBootstrapOptions()
	firstOptions.RoleConfigJSON = []byte(`{"confidence":0.8}`)
	secondOptions := firstOptions
	secondOptions.RoleConfigJSON = []byte(` { "confidence" : 0.8 } `)

	first, err := newRuntimeBootstrap(firstOptions)
	if err != nil {
		t.Fatal(err)
	}
	firstDocument, err := EncodeRuntimeBootstrap(first)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newRuntimeBootstrap(secondOptions)
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
	valid, err := newRuntimeBootstrap(validRuntimeBootstrapOptions())
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
		mutate func(*runtimeBootstrapOptions)
	}{
		{"minimums", func(options *runtimeBootstrapOptions) {
			options.MaximumQueuedBytesPerDirection = RuntimeBootstrapARWXMinimumQueuedBytes
			options.GracefulTimeoutMS = RuntimeBootstrapMinimumGracefulTimeoutMS
			options.ForceTerminationReserveMS = RuntimeBootstrapMinimumForceTerminationReserve
		}},
		{"maximums", func(options *runtimeBootstrapOptions) {
			options.MaximumQueuedBytesPerDirection = RuntimeBootstrapARWXMaximumQueuedBytes
			options.GracefulTimeoutMS = RuntimeBootstrapMaximumGracefulTimeoutMS
			options.ForceTerminationReserveMS = RuntimeBootstrapMaximumGracefulTimeoutMS - 1
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := validRuntimeBootstrapOptions()
			test.mutate(&options)
			bootstrap, err := newRuntimeBootstrap(options)
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
	if _, err := newRuntimeBootstrap(invalidRoleConfig); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("array role config error = %v", err)
	}
	maximumRoleConfig, err := newRuntimeBootstrap(valid)
	if err != nil {
		t.Fatalf("maximum roleConfig was rejected: %v", err)
	}
	maximumDocument, err := EncodeRuntimeBootstrap(maximumRoleConfig)
	if err != nil || len(maximumDocument) > RuntimeBootstrapMaximumBytes {
		t.Fatalf("maximum roleConfig envelope = %d bytes, error %v", len(maximumDocument), err)
	}
	valid.RoleConfigJSON = append(atDecodedLimit, ' ')
	if _, err := newRuntimeBootstrap(valid); !errors.Is(err, ErrRuntimeBootstrapLimit) {
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

func validRuntimeBootstrapOptions() runtimeBootstrapOptions {
	foundation := validFoundationRuntimeBootstrapOptions(RoleControl)
	roleConfig, err := foundationRoleConfigJSON(foundation)
	if err != nil {
		panic(err)
	}
	return runtimeBootstrapOptions{
		BootstrapID:                    "123e4567-e89b-42d3-a456-426614174000",
		Role:                           RoleControl,
		WorkerNodeID:                   "powertoys-node:01",
		MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		GracefulTimeoutMS:              120_000,
		ForceTerminationReserveMS:      15_000,
		RoleConfigJSON:                 roleConfig,
	}
}

func validFoundationRuntimeBootstrapOptions(role Role) FoundationRuntimeBootstrapOptions {
	return FoundationRuntimeBootstrapOptions{
		Role:                           role,
		WorkerNodeID:                   "powertoys-node:01",
		MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		TotalShutdownTimeoutMS:         120_000,
		ForceTerminationReserveMS:      15_000,
	}
}

type countingRuntimeBootstrapEntropy struct {
	reads int
}

func (reader *countingRuntimeBootstrapEntropy) Read(buffer []byte) (int, error) {
	reader.reads++
	clear(buffer)
	return len(buffer), nil
}

type runtimeBootstrapEntropyError struct {
	err error
}

type noIORuntimeBootstrapChannel struct{}

func (noIORuntimeBootstrapChannel) ReadContext(context.Context, []byte) (int, error) {
	panic("unsealed bootstrap reached channel read")
}

func (noIORuntimeBootstrapChannel) WriteContext(context.Context, []byte) (int, error) {
	panic("unsealed bootstrap reached channel write")
}

func (reader runtimeBootstrapEntropyError) Read([]byte) (int, error) {
	return 0, reader.err
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
