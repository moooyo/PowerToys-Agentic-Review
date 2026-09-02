package nodeenrollment

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

const goldenRecordDocument = `{"enrollmentGeneration":1,"installationId":"installation-node-001","localAuthorityCng":{"keyName":"AgenticReview.Worker.Control.LocalAuthority","keyUniqueName":"machine-key-local-authority-001","publicKeySpkiBase64Url":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li_hp_m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q","publicKeySpkiSha256":"5cd252fb0ce8932436faf8ccd1040981b89ee4ad6b9fe9e2a2b7e71aacb27cd3","securityDescriptorSha256":"1111111111111111111111111111111111111111111111111111111111111111"},"mtlsClientCredential":{"certificateDerSha256":"2222222222222222222222222222222222222222222222222222222222222222","certificateStore":"MY","privateKeyPublicKeySpkiSha256":"3333333333333333333333333333333333333333333333333333333333333333","privateKeySecurityDescriptorSha256":"4444444444444444444444444444444444444444444444444444444444444444","privateKeyUniqueName":"machine-key-mtls-001"},"physicalRootProfileId":"agentic-review-windows-split-roots-v1","profileId":"agentic-review-trusted-enrollment-record-v1","schemaVersion":1,"serverBindingReceiptSha256":"5555555555555555555555555555555555555555555555555555555555555555","serviceIdentityProfileId":"agentic-review-worker-control-executor-v1","state":"committed","targetArchitecture":"amd64","workerNodeId":"windows-worker:001"}`

func TestRecordCanonicalRoundTripIsOrdinaryData(t *testing.T) {
	record := validRecord(t)
	document, err := MarshalCanonical(record)
	if err != nil {
		t.Fatal(err)
	}
	if string(document) != goldenRecordDocument {
		t.Fatalf("canonical document differs from the frozen golden:\n%s", document)
	}
	parsed, err := Parse([]byte(goldenRecordDocument))
	if err != nil {
		t.Fatal(err)
	}
	if parsed != record || bytes.HasSuffix(document, []byte{'\n'}) {
		t.Fatalf("unexpected canonical round trip: %#v", parsed)
	}
}

func TestRecordRejectsUnknownDuplicateTrailingAndNoncanonicalJSON(t *testing.T) {
	document, err := MarshalCanonical(validRecord(t))
	if err != nil {
		t.Fatal(err)
	}
	candidates := [][]byte{
		append([]byte{0xef, 0xbb, 0xbf}, document...),
		append(append([]byte(nil), document...), '\n'),
		append(append([]byte(nil), document...), []byte(`{}`)...),
		[]byte(strings.Replace(string(document), `"schemaVersion":1`, `"unknown":true,"schemaVersion":1`, 1)),
		[]byte(strings.Replace(string(document), `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1)),
		[]byte(strings.Replace(string(document), `,"installationId"`, `, "installationId"`, 1)),
		[]byte(strings.Replace(string(document), `"keyName":`, `"nestedUnknown":true,"keyName":`, 1)),
		[]byte(strings.Replace(string(document), `"certificateDerSha256":`, `"nestedUnknown":true,"certificateDerSha256":`, 1)),
	}
	for index, candidate := range candidates {
		if parsed, err := Parse(candidate); err == nil || parsed != (Record{}) {
			t.Fatalf("candidate %d parsed as %#v with err=%v", index, parsed, err)
		}
	}
}

func TestRecordRejectsAuthorityAndProfileInjection(t *testing.T) {
	document, err := MarshalCanonical(validRecord(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{
		"executionEnabled", "maximumSlots", "claimAuthority", "serviceStartMode", "targetRoots",
	} {
		candidate := []byte(strings.Replace(
			string(document),
			`{"enrollmentGeneration":1`,
			`{"`+field+`":true,"enrollmentGeneration":1`,
			1,
		))
		if _, err := Parse(candidate); !errors.Is(err, ErrInvalid) {
			t.Fatalf("field %s returned %v, want ErrInvalid", field, err)
		}
	}
}

func TestRecordValidationPinsEveryEnrollmentProfile(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Record)
	}{
		{name: "schema", mutate: func(value *Record) { value.SchemaVersion++ }},
		{name: "profile", mutate: func(value *Record) { value.ProfileID = "other" }},
		{name: "generation", mutate: func(value *Record) { value.EnrollmentGeneration++ }},
		{name: "state", mutate: func(value *Record) { value.State = "pending" }},
		{name: "service profile", mutate: func(value *Record) { value.ServiceIdentityProfileID = "other" }},
		{name: "root profile", mutate: func(value *Record) { value.PhysicalRootProfileID = "other" }},
		{name: "installation ID", mutate: func(value *Record) { value.InstallationID = "CON" }},
		{name: "worker ID", mutate: func(value *Record) { value.WorkerNodeID = "../worker" }},
		{name: "architecture", mutate: func(value *Record) { value.TargetArchitecture = "386" }},
		{name: "receipt digest", mutate: func(value *Record) { value.ServerBindingReceiptSHA256 = strings.Repeat("A", 64) }},
		{name: "key name", mutate: func(value *Record) { value.LocalAuthorityCNG.KeyName = " key" }},
		{name: "non-ASCII key name", mutate: func(value *Record) { value.LocalAuthorityCNG.KeyName = "key-\u00e9" }},
		{name: "key unique name", mutate: func(value *Record) { value.LocalAuthorityCNG.KeyUniqueName = "" }},
		{name: "SPKI encoding", mutate: func(value *Record) { value.LocalAuthorityCNG.PublicKeySPKIBase64URL += "=" }},
		{name: "SPKI digest", mutate: func(value *Record) { value.LocalAuthorityCNG.PublicKeySPKISHA256 = strings.Repeat("0", 64) }},
		{name: "certificate store", mutate: func(value *Record) { value.MTLSClientCredential.CertificateStore = "CurrentUser\\MY" }},
		{name: "certificate digest", mutate: func(value *Record) { value.MTLSClientCredential.CertificateDERSHA256 = "0" }},
		{name: "reused identity", mutate: func(value *Record) {
			value.MTLSClientCredential.PrivateKeyUniqueName = value.LocalAuthorityCNG.KeyUniqueName
		}},
		{name: "reused public key", mutate: func(value *Record) {
			value.MTLSClientCredential.PrivateKeyPublicKeySPKISHA256 = value.LocalAuthorityCNG.PublicKeySPKISHA256
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := validRecord(t)
			test.mutate(&value)
			if err := value.Validate(); !errors.Is(err, ErrInvalid) {
				t.Fatalf("Validate returned %v, want ErrInvalid", err)
			}
		})
	}
}

func validRecord(t *testing.T) Record {
	t.Helper()
	return Record{
		EnrollmentGeneration: EnrollmentGeneration,
		InstallationID:       "installation-node-001",
		LocalAuthorityCNG: LocalAuthorityCNGRecord{
			KeyName:                  "AgenticReview.Worker.Control.LocalAuthority",
			KeyUniqueName:            "machine-key-local-authority-001",
			PublicKeySPKIBase64URL:   "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li_hp_m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q",
			PublicKeySPKISHA256:      "5cd252fb0ce8932436faf8ccd1040981b89ee4ad6b9fe9e2a2b7e71aacb27cd3",
			SecurityDescriptorSHA256: strings.Repeat("1", 64),
		},
		MTLSClientCredential: MTLSClientCredentialRecord{
			CertificateDERSHA256:               strings.Repeat("2", 64),
			CertificateStore:                   "MY",
			PrivateKeyPublicKeySPKISHA256:      strings.Repeat("3", 64),
			PrivateKeySecurityDescriptorSHA256: strings.Repeat("4", 64),
			PrivateKeyUniqueName:               "machine-key-mtls-001",
		},
		PhysicalRootProfileID:      PhysicalRootProfileID,
		ProfileID:                  ProfileID,
		SchemaVersion:              SchemaVersion,
		ServerBindingReceiptSHA256: strings.Repeat("5", 64),
		ServiceIdentityProfileID:   ServiceIdentityProfileID,
		State:                      CommittedState,
		TargetArchitecture:         ArchitectureAMD64,
		WorkerNodeID:               "windows-worker:001",
	}
}
