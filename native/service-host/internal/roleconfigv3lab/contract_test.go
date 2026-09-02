package roleconfigv3lab

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	cryptorand "crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
)

const testLocalAuthorityPublicKeySPKIBase64URL = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li_hp_m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q"

func TestSharedGoldenRoundTripsRoleConfigsAndBootstraps(t *testing.T) {
	lines := goldenLines(t)
	publicKey := testPublicKeySPKI(t)
	control, err := NewControlRoleConfig(strings.Repeat("6", 64), "5cd252fb0ce8932436faf8ccd1040981b89ee4ad6b9fe9e2a2b7e71aacb27cd3")
	if err != nil {
		t.Fatal(err)
	}
	executor, err := NewExecutorRoleConfig(strings.Repeat("6", 64), publicKey)
	if err != nil {
		t.Fatal(err)
	}
	for index, fixture := range []struct {
		role   Role
		config RoleConfig
	}{
		{RoleControl, control},
		{RoleExecutor, executor},
	} {
		document, err := fixture.config.CanonicalJSON()
		if err != nil || !bytes.Equal(document, lines[index]) {
			t.Fatalf("RoleConfig golden %d differs: %v\n%s", index, err, document)
		}
		parsed, err := ParseRoleConfig(lines[index], fixture.role)
		if err != nil {
			t.Fatalf("parse RoleConfig golden %d: %v", index, err)
		}
		if role, roleErr := parsed.Role(); roleErr != nil || role != fixture.role {
			t.Fatalf("RoleConfig role %d = %q, %v", index, role, roleErr)
		}
	}

	for index, fixture := range []struct {
		role        Role
		config      RoleConfig
		bootstrapID string
	}{
		{RoleControl, control, "123e4567-e89b-42d3-a456-426614174000"},
		{RoleExecutor, executor, "123e4567-e89b-42d3-a456-426614174001"},
	} {
		bootstrap, err := NewRuntimeBootstrap(goldenBootstrapFacts(fixture.role, fixture.bootstrapID, fixture.config))
		if err != nil {
			t.Fatalf("create RuntimeBootstrap golden %d: %v", index, err)
		}
		document, err := bootstrap.CanonicalJSON()
		if err != nil || !bytes.Equal(document, lines[index+2]) {
			t.Fatalf("RuntimeBootstrap golden %d differs: %v\n%s", index, err, document)
		}
		parsed, err := ParseRuntimeBootstrap(lines[index+2], fixture.role)
		if err != nil {
			t.Fatalf("parse RuntimeBootstrap golden %d: %v", index, err)
		}
		if parsed.ExecutionAuthority() {
			t.Fatal("RuntimeBootstrapV2 lab gained execution authority")
		}
		projection := parsed.DisabledReadiness()
		if projection.Ready || projection.ExecutionAuthority || projection.AvailableSlots != 0 ||
			projection.ReasonCode != DisabledReasonCode {
			t.Fatalf("disabled readiness projection = %#v", projection)
		}
	}
}

func TestLegalOppositeRoleIsDistinctFromMalformedRole(t *testing.T) {
	lines := goldenLines(t)
	for _, fixture := range []struct {
		name         string
		document     []byte
		opposite     []byte
		malformedKey string
		parse        func([]byte) error
	}{
		{"RoleConfig", lines[0], lines[1], "localAuthorityPublicKeySpki", func(document []byte) error {
			_, err := ParseRoleConfig(document, RoleControl)
			return err
		}},
		{"RuntimeBootstrap", lines[2], lines[3], "roleConfig", func(document []byte) error {
			_, err := ParseRuntimeBootstrap(document, RoleControl)
			return err
		}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			if err := fixture.parse(fixture.opposite); !errors.Is(err, ErrRoleMismatch) {
				t.Fatalf("legal opposite role returned %v", err)
			}
			for index, mutate := range []func(map[string]any){
				func(value map[string]any) { delete(value, fixture.malformedKey) },
				func(value map[string]any) { value["extra"] = true },
			} {
				malformedOpposite := mutateCanonical(t, fixture.opposite, mutate)
				if err := fixture.parse(malformedOpposite); err == nil || errors.Is(err, ErrRoleMismatch) {
					t.Fatalf("malformed opposite role %d returned %v", index, err)
				}
			}
			for _, malformed := range []any{nil, 1, "CONTROL", "unknown"} {
				document := mutateCanonical(t, fixture.document, func(value map[string]any) {
					value["role"] = malformed
				})
				if err := fixture.parse(document); err == nil || errors.Is(err, ErrRoleMismatch) {
					t.Fatalf("malformed role %#v returned %v", malformed, err)
				}
			}
			missing := mutateCanonical(t, fixture.document, func(value map[string]any) {
				delete(value, "role")
			})
			if err := fixture.parse(missing); err == nil || errors.Is(err, ErrRoleMismatch) {
				t.Fatalf("missing role returned %v", err)
			}
		})
	}
}

func TestRoleConfigRejectsFixedFieldAndClosedSetDrift(t *testing.T) {
	golden := goldenLines(t)[0]
	mutations := []func(map[string]any){
		func(value map[string]any) { value["extra"] = true },
		func(value map[string]any) { delete(value, "activationState") },
		func(value map[string]any) { value["activationState"] = "ready" },
		func(value map[string]any) { value["availableSlots"] = 1 },
		func(value map[string]any) { value["completionMode"] = "inline_result_v1" },
		func(value map[string]any) { value["disabledReasonCode"] = "execution_disabled" },
		func(value map[string]any) { value["executionAuthority"] = true },
		func(value map[string]any) { value["executionEnabled"] = true },
		func(value map[string]any) { value["foundationVersion"] = 2 },
		func(value map[string]any) { value["globalRolloutDefault"] = "on" },
		func(value map[string]any) { value["jobExecutionEnvelopeVersion"] = 1 },
		func(value map[string]any) { value["maximumSlots"] = 0 },
		func(value map[string]any) { value["profile"] = "execution-lab-v1" },
		func(value map[string]any) { value["requiredRuntimeBootstrapVersion"] = 1 },
		func(value map[string]any) { value["requiredWorkerApiVersion"] = "1.0" },
		func(value map[string]any) { value["executorPolicySha256"] = strings.Repeat("A", 64) },
		func(value map[string]any) { nestedObject(t, value, "arwx")["minimumMinor"] = 0 },
		func(value map[string]any) { nestedObject(t, value, "hostControl")["protocolVersion"] = "1.0" },
		func(value map[string]any) { reverseList(t, nestedObject(t, value, "hostControl"), "operations") },
		func(value map[string]any) { removeLast(t, value, "missingPrerequisites") },
		func(value map[string]any) { reverseList(t, value, "missingPrerequisites") },
		func(value map[string]any) { value["missingPrerequisites"] = nil },
	}
	for index, mutate := range mutations {
		document := mutateCanonical(t, golden, mutate)
		if _, err := ParseRoleConfig(document, RoleControl); err == nil {
			t.Errorf("mutation %d was accepted", index)
		}
	}
}

func TestRuntimeBootstrapRejectsSelectionAuthorityAndDescriptorDrift(t *testing.T) {
	lines := goldenLines(t)
	golden := lines[2]
	mutations := []func(map[string]any){
		func(value map[string]any) { value["extra"] = true },
		func(value map[string]any) { value["protocolVersion"] = "1.0" },
		func(value map[string]any) { value["bootstrapVersion"] = 1 },
		func(value map[string]any) { value["executionAuthority"] = true },
		func(value map[string]any) { value["completionMode"] = "inline_result_v1" },
		func(value map[string]any) { value["jobExecutionEnvelopeVersion"] = 1 },
		func(value map[string]any) { nestedObject(t, value, "arwx")["minimumMinor"] = 0 },
		func(value map[string]any) { nestedObject(t, value, "arwx")["maximumMinor"] = 0 },
		func(value map[string]any) { nestedObject(t, value, "hostControl")["protocolVersion"] = "1.1" },
		func(value map[string]any) { reverseList(t, nestedObject(t, value, "hostControl"), "operations") },
		func(value map[string]any) { nestedObject(t, value, "roleConfig")["byteLength"] = 1 },
		func(value map[string]any) { nestedObject(t, value, "roleConfig")["sha256"] = strings.Repeat("0", 64) },
		func(value map[string]any) { nestedObject(t, value, "roleConfig")["base64Url"] = "AA==" },
		func(value map[string]any) {
			value["shutdown"] = map[string]any{"forceTerminationReserveMs": 120000, "gracefulTimeoutMs": 120000}
		},
	}
	for index, mutate := range mutations {
		document := mutateCanonical(t, golden, mutate)
		if _, err := ParseRuntimeBootstrap(document, RoleControl); err == nil {
			t.Errorf("mutation %d was accepted", index)
		}
	}
	executor := canonicalMap(t, lines[3])
	executorDescriptor := executor["roleConfig"]
	changedRoleConfig := mutateCanonical(t, golden, func(value map[string]any) {
		value["roleConfig"] = executorDescriptor
	})
	if _, err := ParseRuntimeBootstrap(changedRoleConfig, RoleControl); err == nil ||
		errors.Is(err, ErrRoleMismatch) {
		t.Fatalf("Control bootstrap opposite embedded RoleConfig returned %v", err)
	}
	parsedExecutor, err := ParseRoleConfig(lines[1], RoleExecutor)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewRuntimeBootstrap(goldenBootstrapFacts(
		RoleControl,
		"123e4567-e89b-42d3-a456-426614174000",
		parsedExecutor,
	)); err == nil || !errors.Is(err, ErrInvalidRoleConfig) || errors.Is(err, ErrRoleMismatch) {
		t.Fatalf("factory opposite RoleConfig returned %v", err)
	}
}

func TestGoDecodersRejectNullForEveryScalarZeroValueField(t *testing.T) {
	lines := goldenLines(t)
	roleMutations := []func(map[string]any){
		func(value map[string]any) { value["availableSlots"] = nil },
		func(value map[string]any) { value["executionAuthority"] = nil },
		func(value map[string]any) { value["executionEnabled"] = nil },
		func(value map[string]any) { value["foundationVersion"] = nil },
		func(value map[string]any) { value["jobExecutionEnvelopeVersion"] = nil },
		func(value map[string]any) { value["maximumSlots"] = nil },
		func(value map[string]any) { value["requiredRuntimeBootstrapVersion"] = nil },
		func(value map[string]any) { nestedObject(t, value, "arwx")["maximumMinor"] = nil },
		func(value map[string]any) { nestedObject(t, value, "arwx")["minimumMinor"] = nil },
		func(value map[string]any) { nestedObject(t, value, "arwx")["protocolMajor"] = nil },
	}
	for index, mutate := range roleMutations {
		if _, err := ParseRoleConfig(mutateCanonical(t, lines[0], mutate), RoleControl); err == nil {
			t.Errorf("RoleConfig null mutation %d was accepted", index)
		}
	}
	executorNullLength := mutateCanonical(t, lines[1], func(value map[string]any) {
		nestedObject(t, value, "localAuthorityPublicKeySpki")["byteLength"] = nil
	})
	if _, err := ParseRoleConfig(executorNullLength, RoleExecutor); err == nil {
		t.Error("Executor accepted null public-key byteLength")
	}

	bootstrapMutations := []func(map[string]any){
		func(value map[string]any) { value["bootstrapVersion"] = nil },
		func(value map[string]any) { value["executionAuthority"] = nil },
		func(value map[string]any) { value["jobExecutionEnvelopeVersion"] = nil },
		func(value map[string]any) { nestedObject(t, value, "arwx")["maximumFrameBytes"] = nil },
		func(value map[string]any) { nestedObject(t, value, "arwx")["maximumMinor"] = nil },
		func(value map[string]any) { nestedObject(t, value, "arwx")["maximumQueuedBytesPerDirection"] = nil },
		func(value map[string]any) { nestedObject(t, value, "arwx")["minimumMinor"] = nil },
		func(value map[string]any) { nestedObject(t, value, "arwx")["protocolMajor"] = nil },
		func(value map[string]any) { nestedObject(t, value, "roleConfig")["byteLength"] = nil },
		func(value map[string]any) { nestedObject(t, value, "shutdown")["forceTerminationReserveMs"] = nil },
		func(value map[string]any) { nestedObject(t, value, "shutdown")["gracefulTimeoutMs"] = nil },
	}
	for index, mutate := range bootstrapMutations {
		if _, err := ParseRuntimeBootstrap(mutateCanonical(t, lines[2], mutate), RoleControl); err == nil {
			t.Errorf("RuntimeBootstrap null mutation %d was accepted", index)
		}
	}
}

func TestExecutorRequiresCanonicalP256SPKIAndRoleSeparation(t *testing.T) {
	lines := goldenLines(t)
	control := canonicalMap(t, lines[0])
	executor := canonicalMap(t, lines[1])
	control["localAuthorityPublicKeySpki"] = executor["localAuthorityPublicKeySpki"]
	if _, err := ParseRoleConfig(marshalCanonical(t, control, RoleConfigMaximumBytes), RoleControl); err == nil {
		t.Fatal("Control accepted public-key bytes")
	}
	delete(executor, "localAuthorityPublicKeySpki")
	if _, err := ParseRoleConfig(marshalCanonical(t, executor, RoleConfigMaximumBytes), RoleExecutor); err == nil {
		t.Fatal("Executor accepted a missing public key")
	}
	for index, mutate := range []func(map[string]any){
		func(value map[string]any) {
			descriptor := nestedObject(t, value, "localAuthorityPublicKeySpki")
			descriptor["base64Url"] = descriptor["base64Url"].(string) + "="
		},
		func(value map[string]any) { nestedObject(t, value, "localAuthorityPublicKeySpki")["byteLength"] = 90 },
		func(value map[string]any) {
			nestedObject(t, value, "localAuthorityPublicKeySpki")["sha256"] = strings.Repeat("0", 64)
		},
		func(value map[string]any) { value["localAuthorityKeyId"] = strings.Repeat("0", 64) },
	} {
		value := canonicalMap(t, lines[1])
		mutate(value)
		if _, err := ParseRoleConfig(marshalCanonical(t, value, RoleConfigMaximumBytes), RoleExecutor); err == nil {
			t.Errorf("Executor descriptor mutation %d was accepted", index)
		}
	}

	rsaKey, err := rsa.GenerateKey(cryptorand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p384Key, err := ecdsa.GenerateKey(elliptic.P384(), cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []any{&rsaKey.PublicKey, &p384Key.PublicKey} {
		document, err := x509.MarshalPKIXPublicKey(key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := NewExecutorRoleConfig(strings.Repeat("6", 64), document); !errors.Is(err, ErrInvalidPublicKey) {
			t.Fatalf("non-P256 key returned %v", err)
		}
	}
	if _, err := NewExecutorRoleConfig(
		strings.Repeat("6", 64),
		testCompressedPublicKeySPKI(t),
	); !errors.Is(err, ErrInvalidPublicKey) {
		t.Fatalf("compressed P-256 key returned %v", err)
	}
	noncanonical := append(testPublicKeySPKI(t), 0)
	if _, err := NewExecutorRoleConfig(strings.Repeat("6", 64), noncanonical); !errors.Is(err, ErrInvalidPublicKey) {
		t.Fatalf("noncanonical P-256 key returned %v", err)
	}
}

func TestCanonicalSizeDuplicateAndAliasBoundaries(t *testing.T) {
	lines := goldenLines(t)
	for _, fixture := range []struct {
		name       string
		document   []byte
		maximum    int
		parse      func([]byte) error
		roleMarker []byte
	}{
		{"RoleConfig", lines[0], RoleConfigMaximumBytes, func(document []byte) error {
			_, err := ParseRoleConfig(document, RoleControl)
			return err
		}, []byte(`"role":"control"`)},
		{"RuntimeBootstrap", lines[2], RuntimeBootstrapMaximumBytes, func(document []byte) error {
			_, err := ParseRuntimeBootstrap(document, RoleControl)
			return err
		}, []byte(`"role":"control"`)},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			duplicate := bytes.Replace(
				fixture.document,
				fixture.roleMarker,
				append(bytes.Clone(fixture.roleMarker), append([]byte(","), fixture.roleMarker...)...),
				1,
			)
			for _, document := range [][]byte{
				append(bytes.Clone(fixture.document), ' '),
				append([]byte{0xef, 0xbb, 0xbf}, fixture.document...),
				{0xff},
				bytes.Repeat([]byte{' '}, fixture.maximum),
				bytes.Repeat([]byte{' '}, fixture.maximum+1),
				duplicate,
				nil,
			} {
				if err := fixture.parse(document); err == nil {
					t.Errorf("invalid canonical/size document of %d bytes was accepted", len(document))
				}
			}
		})
	}

	publicKey := testPublicKeySPKI(t)
	executor, err := NewExecutorRoleConfig(strings.Repeat("6", 64), publicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicKey[0] ^= 0xff
	first, err := executor.CanonicalJSON()
	if err != nil {
		t.Fatal(err)
	}
	first[0] ^= 0xff
	second, err := executor.CanonicalJSON()
	if err != nil || !bytes.Equal(second, lines[1]) {
		t.Fatalf("RoleConfig alias isolation failed: %v", err)
	}

	bootstrap, err := NewRuntimeBootstrap(goldenBootstrapFacts(
		RoleExecutor,
		"123e4567-e89b-42d3-a456-426614174001",
		executor,
	))
	if err != nil {
		t.Fatal(err)
	}
	bootstrapDocument, err := bootstrap.CanonicalJSON()
	if err != nil {
		t.Fatal(err)
	}
	bootstrapDocument[0] ^= 0xff
	again, err := bootstrap.CanonicalJSON()
	if err != nil || !bytes.Equal(again, lines[3]) {
		t.Fatalf("RuntimeBootstrap alias isolation failed: %v", err)
	}
}

func TestZeroValuesNeverProduceAuthorityOrWireReadiness(t *testing.T) {
	var roleConfig RoleConfig
	if _, err := roleConfig.CanonicalJSON(); !errors.Is(err, ErrInvalidRoleConfig) {
		t.Fatalf("zero RoleConfig canonical JSON returned %v", err)
	}
	if _, err := roleConfig.Role(); !errors.Is(err, ErrInvalidRoleConfig) {
		t.Fatalf("zero RoleConfig role returned %v", err)
	}
	if _, err := roleConfig.SHA256(); !errors.Is(err, ErrInvalidRoleConfig) {
		t.Fatalf("zero RoleConfig digest returned %v", err)
	}

	var bootstrap RuntimeBootstrap
	if bootstrap.ExecutionAuthority() {
		t.Fatal("zero RuntimeBootstrap gained authority")
	}
	projection := bootstrap.DisabledReadiness()
	if projection.Ready || projection.ExecutionAuthority || projection.AvailableSlots != 0 ||
		projection.ReasonCode != DisabledReasonCode {
		t.Fatalf("zero RuntimeBootstrap projection = %#v", projection)
	}
	if _, err := bootstrap.CanonicalJSON(); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("zero RuntimeBootstrap canonical JSON returned %v", err)
	}
	if _, err := bootstrap.Role(); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("zero RuntimeBootstrap role returned %v", err)
	}
	if _, err := bootstrap.RoleConfig(); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("zero RuntimeBootstrap RoleConfig returned %v", err)
	}
	if _, err := bootstrap.SHA256(); !errors.Is(err, ErrInvalidRuntimeBootstrap) {
		t.Fatalf("zero RuntimeBootstrap digest returned %v", err)
	}
}

func goldenLines(t *testing.T) [][]byte {
	t.Helper()
	document, err := os.ReadFile("testdata/role_config_v3_lab.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if len(document) < 2 || document[len(document)-1] != '\n' ||
		document[len(document)-2] == '\r' || bytes.ContainsRune(document, '\r') {
		t.Fatal("RoleConfig v3 lab golden must use one LF delimiter per record")
	}
	lines := bytes.Split(document[:len(document)-1], []byte{'\n'})
	if len(lines) != 4 {
		t.Fatalf("golden line count = %d, want 4", len(lines))
	}
	expected := []struct {
		kind string
		role Role
	}{
		{"", RoleControl},
		{"", RoleExecutor},
		{"runtimeBootstrap", RoleControl},
		{"runtimeBootstrap", RoleExecutor},
	}
	for index, line := range lines {
		parsed := canonicalMap(t, line)
		kind, _ := parsed["type"].(string)
		role, _ := parsed["role"].(string)
		if kind != expected[index].kind || Role(role) != expected[index].role {
			t.Fatalf("golden record %d has kind %q role %q", index, kind, role)
		}
		lines[index] = bytes.Clone(line)
	}
	return lines
}

func goldenBootstrapFacts(role Role, bootstrapID string, config RoleConfig) RuntimeBootstrapFacts {
	return RuntimeBootstrapFacts{
		BootstrapID:                    bootstrapID,
		ForceTerminationReserveMS:      15_000,
		GracefulTimeoutMS:              120_000,
		InstallationManifestSHA256:     strings.Repeat("2", 64),
		MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		NodeBundleSHA256:               strings.Repeat("4", 64),
		PreflightSHA256:                strings.Repeat("3", 64),
		ReleaseID:                      "2026.09.03-lab+1",
		ReleaseTemplateSHA256:          strings.Repeat("1", 64),
		Role:                           role,
		RoleConfig:                     config,
		WorkerNodeID:                   "powertoys-node:01",
	}
}

func testPublicKeySPKI(t *testing.T) []byte {
	t.Helper()
	document, err := base64.RawURLEncoding.DecodeString(testLocalAuthorityPublicKeySPKIBase64URL)
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func testCompressedPublicKeySPKI(t *testing.T) []byte {
	t.Helper()
	document, err := os.ReadFile("testdata/p256_compressed_spki.base64url")
	if err != nil {
		t.Fatal(err)
	}
	if len(document) < 2 || document[len(document)-1] != '\n' || document[len(document)-2] == '\r' {
		t.Fatal("compressed P-256 SPKI fixture must end in one LF")
	}
	encoded := string(document[:len(document)-1])
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != encoded {
		t.Fatalf("decode compressed P-256 SPKI fixture: %v", err)
	}
	return decoded
}

func canonicalMap(t *testing.T, document []byte) map[string]any {
	t.Helper()
	value, err := localrpc.ParseCanonicalJSON(document, RuntimeBootstrapMaximumBytes)
	if err != nil {
		t.Fatal(err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatal("golden or mutation is not an object")
	}
	return object
}

func mutateCanonical(t *testing.T, document []byte, mutate func(map[string]any)) []byte {
	t.Helper()
	value := canonicalMap(t, document)
	mutate(value)
	return marshalCanonical(t, value, RuntimeBootstrapMaximumBytes)
}

func marshalCanonical(t *testing.T, value any, maximum int) []byte {
	t.Helper()
	document, err := localrpc.MarshalCanonicalJSON(value, maximum)
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func nestedObject(t *testing.T, value map[string]any, key string) map[string]any {
	t.Helper()
	nested, ok := value[key].(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object", key)
	}
	return nested
}

func reverseList(t *testing.T, value map[string]any, key string) {
	t.Helper()
	list, ok := value[key].([]any)
	if !ok {
		t.Fatalf("%s is not an array", key)
	}
	for left, right := 0, len(list)-1; left < right; left, right = left+1, right-1 {
		list[left], list[right] = list[right], list[left]
	}
}

func removeLast(t *testing.T, value map[string]any, key string) {
	t.Helper()
	list, ok := value[key].([]any)
	if !ok || len(list) == 0 {
		t.Fatalf("%s is not a non-empty array", key)
	}
	value[key] = list[:len(list)-1]
}
