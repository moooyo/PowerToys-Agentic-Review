package nodeenrollment

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

type frozenJSONField struct {
	name   string
	tag    string
	typeOf reflect.Type
}

func TestRecordTypesHaveExactFrozenJSONFields(t *testing.T) {
	assertFrozenJSONFields(t, reflect.TypeOf(LocalAuthorityCNGRecord{}), []frozenJSONField{
		{name: "KeyName", tag: "keyName", typeOf: reflect.TypeOf("")},
		{name: "KeyUniqueName", tag: "keyUniqueName", typeOf: reflect.TypeOf("")},
		{name: "PublicKeySPKIBase64URL", tag: "publicKeySpkiBase64Url", typeOf: reflect.TypeOf("")},
		{name: "PublicKeySPKISHA256", tag: "publicKeySpkiSha256", typeOf: reflect.TypeOf("")},
		{name: "SecurityDescriptorSHA256", tag: "securityDescriptorSha256", typeOf: reflect.TypeOf("")},
	})
	assertFrozenJSONFields(t, reflect.TypeOf(MTLSClientCredentialRecord{}), []frozenJSONField{
		{name: "CertificateDERSHA256", tag: "certificateDerSha256", typeOf: reflect.TypeOf("")},
		{name: "CertificateStore", tag: "certificateStore", typeOf: reflect.TypeOf("")},
		{name: "PrivateKeyPublicKeySPKISHA256", tag: "privateKeyPublicKeySpkiSha256", typeOf: reflect.TypeOf("")},
		{name: "PrivateKeySecurityDescriptorSHA256", tag: "privateKeySecurityDescriptorSha256", typeOf: reflect.TypeOf("")},
		{name: "PrivateKeyUniqueName", tag: "privateKeyUniqueName", typeOf: reflect.TypeOf("")},
	})
	assertFrozenJSONFields(t, reflect.TypeOf(Record{}), []frozenJSONField{
		{name: "EnrollmentGeneration", tag: "enrollmentGeneration", typeOf: reflect.TypeOf(uint32(0))},
		{name: "InstallationID", tag: "installationId", typeOf: reflect.TypeOf("")},
		{name: "LocalAuthorityCNG", tag: "localAuthorityCng", typeOf: reflect.TypeOf(LocalAuthorityCNGRecord{})},
		{name: "MTLSClientCredential", tag: "mtlsClientCredential", typeOf: reflect.TypeOf(MTLSClientCredentialRecord{})},
		{name: "PhysicalRootProfileID", tag: "physicalRootProfileId", typeOf: reflect.TypeOf("")},
		{name: "ProfileID", tag: "profileId", typeOf: reflect.TypeOf("")},
		{name: "SchemaVersion", tag: "schemaVersion", typeOf: reflect.TypeOf(uint32(0))},
		{name: "ServerBindingReceiptSHA256", tag: "serverBindingReceiptSha256", typeOf: reflect.TypeOf("")},
		{name: "ServiceIdentityProfileID", tag: "serviceIdentityProfileId", typeOf: reflect.TypeOf("")},
		{name: "State", tag: "state", typeOf: reflect.TypeOf("")},
		{name: "TargetArchitecture", tag: "targetArchitecture", typeOf: reflect.TypeOf(TargetArchitecture(""))},
		{name: "WorkerNodeID", tag: "workerNodeId", typeOf: reflect.TypeOf("")},
	})
}

func assertFrozenJSONFields(t *testing.T, actual reflect.Type, expected []frozenJSONField) {
	t.Helper()
	if actual.NumField() != len(expected) {
		t.Fatalf("%s fields=%d, want %d", actual, actual.NumField(), len(expected))
	}
	for index, want := range expected {
		field := actual.Field(index)
		if field.Name != want.name || field.Type != want.typeOf || field.Tag.Get("json") != want.tag ||
			field.Tag != reflect.StructTag(`json:"`+want.tag+`"`) {
			t.Fatalf("%s field %d = name:%s type:%s tag:%q", actual, index, field.Name, field.Type, field.Tag)
		}
	}
}

func TestFixedProfilesMatchTheServiceHostContract(t *testing.T) {
	if ControlServiceName != config.ControlServiceName || ControlServiceSID != config.ControlServiceSID ||
		ExecutorServiceName != config.ExecutorServiceName || ExecutorServiceSID != config.ExecutorServiceSID {
		t.Fatal("enrollment service identity profile differs from the ServiceHost contract")
	}
	expectedRoots := []string{
		`C:\Program Files\AgenticReview\Worker`,
		`C:\ProgramData\AgenticReview\TrustedConfig`,
		`C:\ProgramData\AgenticReview\Control`,
		`C:\ProgramData\AgenticReview\Executor`,
		`C:\ProgramData\AgenticReview\ServiceWrapper\Control`,
		`C:\ProgramData\AgenticReview\ServiceWrapper\Executor`,
		`C:\ProgramData\AgenticReview\Installer`,
		`C:\ProgramData\AgenticReview\Packages`,
		`C:\ProgramData\AgenticReview\Staging`,
	}
	actualRoots := []string{
		InstallationRoot,
		TrustedConfigurationRoot,
		ControlDataRoot,
		ExecutorDataRoot,
		ControlWrapperLogRoot,
		ExecutorWrapperLogRoot,
		InstallerRoot,
		PackageMetadataParent,
		StagingParent,
	}
	if !reflect.DeepEqual(actualRoots, expectedRoots) {
		t.Fatalf("fixed root profile = %#v, want %#v", actualRoots, expectedRoots)
	}
	if RecordPath != InstallerRoot+`\Enrollment\record-v1.json` ||
		ServerBindingReceiptPath != InstallerRoot+`\Enrollment\server-binding-receipt-v1.bin` {
		t.Fatal("fixed enrollment paths escape the installer root")
	}
}

func TestRecordSchemaContainsNoExecutionOrInstallationMutationField(t *testing.T) {
	typeOfRecord := reflect.TypeOf(Record{})
	for index := 0; index < typeOfRecord.NumField(); index++ {
		field := strings.ToLower(typeOfRecord.Field(index).Name)
		for _, forbidden := range []string{
			"claim", "execution", "slot", "scm", "servicestart", "targetroot",
		} {
			if strings.Contains(field, forbidden) {
				t.Fatalf("Record field %s introduces forbidden authority", typeOfRecord.Field(index).Name)
			}
		}
	}
}

func TestRecordEvidenceRequiresFutureFilesystemAndServerVerification(t *testing.T) {
	record := validRecord(t)
	document, err := MarshalCanonical(record)
	if err != nil {
		t.Fatal(err)
	}
	receiptDigest, err := decodeSHA256(record.ServerBindingReceiptSHA256)
	if err != nil {
		t.Fatal(err)
	}
	newEvidence := func() RecordEvidence {
		issuer := &readerIssuerSeal{nonce: 1}
		return RecordEvidence{state: &recordEvidenceState{
			record:         record,
			recordDocument: append([]byte(nil), document...),
			sourceProof: recordSourceProof{
				issuer: issuer, recordPath: RecordPath, recordSHA256: sha256.Sum256(document),
			},
			bindingProof: serverBindingProof{
				issuer: issuer, receiptPath: ServerBindingReceiptPath,
				serverBindingReceiptSHA256: receiptDigest,
			},
		}}
	}
	if err := newEvidence().Validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*recordEvidenceState){
		func(state *recordEvidenceState) { state.sourceProof.issuer = nil },
		func(state *recordEvidenceState) { state.bindingProof.issuer = &readerIssuerSeal{nonce: 1} },
		func(state *recordEvidenceState) { state.sourceProof.recordPath = `C:\caller\record.json` },
		func(state *recordEvidenceState) { state.bindingProof.receiptPath = `C:\caller\receipt.bin` },
		func(state *recordEvidenceState) { state.recordDocument[0] ^= 1 },
		func(state *recordEvidenceState) { state.sourceProof.recordSHA256[0] ^= 1 },
		func(state *recordEvidenceState) { state.bindingProof.serverBindingReceiptSHA256[0] ^= 1 },
	} {
		evidence := newEvidence()
		mutate(evidence.state)
		if err := evidence.Validate(); !errors.Is(err, ErrInvalidEvidence) {
			t.Fatalf("mutated evidence returned %v, want ErrInvalidEvidence", err)
		}
	}
	if err := (RecordEvidence{}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero evidence returned %v", err)
	}
	if document, err := json.Marshal(newEvidence()); !errors.Is(err, ErrEvidenceNotSerializable) || document != nil {
		t.Fatalf("Marshal returned %q, %v", document, err)
	}
}
