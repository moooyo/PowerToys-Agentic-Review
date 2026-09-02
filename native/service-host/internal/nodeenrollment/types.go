package nodeenrollment

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

const (
	SchemaVersion             = uint32(1)
	ProfileID                 = "agentic-review-trusted-enrollment-record-v1"
	ServiceIdentityProfileID  = "agentic-review-worker-control-executor-v1"
	PhysicalRootProfileID     = "agentic-review-windows-split-roots-v1"
	CommittedState            = "committed"
	EnrollmentGeneration      = uint32(1)
	MaximumRecordBytes        = 64 * 1024
	MaximumPublicKeySPKIBytes = 4 * 1024

	RecordPath               = `C:\ProgramData\AgenticReview\Installer\Enrollment\record-v1.json`
	ServerBindingReceiptPath = `C:\ProgramData\AgenticReview\Installer\Enrollment\server-binding-receipt-v1.bin`

	ControlServiceName  = "AgenticReview.Worker.Control"
	ExecutorServiceName = "AgenticReview.Worker.Executor"
	ControlServiceSID   = "S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836"
	ExecutorServiceSID  = "S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993"

	InstallationRoot         = `C:\Program Files\AgenticReview\Worker`
	TrustedConfigurationRoot = `C:\ProgramData\AgenticReview\TrustedConfig`
	ControlDataRoot          = `C:\ProgramData\AgenticReview\Control`
	ExecutorDataRoot         = `C:\ProgramData\AgenticReview\Executor`
	ControlWrapperLogRoot    = `C:\ProgramData\AgenticReview\ServiceWrapper\Control`
	ExecutorWrapperLogRoot   = `C:\ProgramData\AgenticReview\ServiceWrapper\Executor`
	InstallerRoot            = `C:\ProgramData\AgenticReview\Installer`
	PackageMetadataParent    = `C:\ProgramData\AgenticReview\Packages`
	StagingParent            = `C:\ProgramData\AgenticReview\Staging`
)

var (
	ErrInvalid                 = errors.New("invalid trusted enrollment record")
	ErrCanonical               = errors.New("trusted enrollment record is not canonical")
	ErrInvalidEvidence         = errors.New("trusted enrollment record evidence is invalid")
	ErrEvidenceNotSerializable = errors.New("trusted enrollment record evidence cannot be serialized")
	ErrUnsupported             = errors.New("trusted enrollment record reading is unsupported on this platform")
	ErrUnavailable             = errors.New("trusted enrollment record reader is unavailable")
)

type TargetArchitecture string

const (
	ArchitectureAMD64 TargetArchitecture = "amd64"
	ArchitectureARM64 TargetArchitecture = "arm64"
)

// LocalAuthorityCNGRecord contains ordinary recorded facts about the enrolled local-authority key.
type LocalAuthorityCNGRecord struct {
	KeyName                  string `json:"keyName"`
	KeyUniqueName            string `json:"keyUniqueName"`
	PublicKeySPKIBase64URL   string `json:"publicKeySpkiBase64Url"`
	PublicKeySPKISHA256      string `json:"publicKeySpkiSha256"`
	SecurityDescriptorSHA256 string `json:"securityDescriptorSha256"`
}

// MTLSClientCredentialRecord contains ordinary recorded facts about the enrolled client key pair.
type MTLSClientCredentialRecord struct {
	CertificateDERSHA256               string `json:"certificateDerSha256"`
	CertificateStore                   string `json:"certificateStore"`
	PrivateKeyPublicKeySPKISHA256      string `json:"privateKeyPublicKeySpkiSha256"`
	PrivateKeySecurityDescriptorSHA256 string `json:"privateKeySecurityDescriptorSha256"`
	PrivateKeyUniqueName               string `json:"privateKeyUniqueName"`
}

// Record is canonical ordinary data. Its validity proves syntax and internal consistency only.
type Record struct {
	EnrollmentGeneration       uint32                     `json:"enrollmentGeneration"`
	InstallationID             string                     `json:"installationId"`
	LocalAuthorityCNG          LocalAuthorityCNGRecord    `json:"localAuthorityCng"`
	MTLSClientCredential       MTLSClientCredentialRecord `json:"mtlsClientCredential"`
	PhysicalRootProfileID      string                     `json:"physicalRootProfileId"`
	ProfileID                  string                     `json:"profileId"`
	SchemaVersion              uint32                     `json:"schemaVersion"`
	ServerBindingReceiptSHA256 string                     `json:"serverBindingReceiptSha256"`
	ServiceIdentityProfileID   string                     `json:"serviceIdentityProfileId"`
	State                      string                     `json:"state"`
	TargetArchitecture         TargetArchitecture         `json:"targetArchitecture"`
	WorkerNodeID               string                     `json:"workerNodeId"`
}

type readerIssuerSeal struct {
	nonce byte
}

type recordSourceProof struct {
	issuer       *readerIssuerSeal
	recordPath   string
	recordSHA256 [sha256.Size]byte
}

type serverBindingProof struct {
	issuer                     *readerIssuerSeal
	receiptPath                string
	serverBindingReceiptSHA256 [sha256.Size]byte
}

type recordEvidenceState struct {
	record         Record
	recordDocument []byte
	sourceProof    recordSourceProof
	bindingProof   serverBindingProof
}

// RecordEvidence is reserved for a future handle-bound fixed-path reader. Its zero value is invalid.
type RecordEvidence struct {
	state *recordEvidenceState
}

// Validate rejects zero, parsed-only, forged, or internally inconsistent evidence.
func (e RecordEvidence) Validate() error {
	if e.state == nil || e.state.sourceProof.issuer == nil || e.state.sourceProof.issuer.nonce != 1 ||
		e.state.sourceProof.issuer != e.state.bindingProof.issuer ||
		e.state.sourceProof.recordPath != RecordPath ||
		e.state.bindingProof.receiptPath != ServerBindingReceiptPath ||
		len(e.state.recordDocument) == 0 {
		return ErrInvalidEvidence
	}
	reparsed, err := Parse(e.state.recordDocument)
	if err != nil || reparsed != e.state.record {
		return fmt.Errorf("%w: record snapshot is invalid", ErrInvalidEvidence)
	}
	canonical, err := MarshalCanonical(e.state.record)
	if err != nil || !bytes.Equal(canonical, e.state.recordDocument) {
		return fmt.Errorf("%w: record snapshot is inconsistent", ErrInvalidEvidence)
	}
	if sha256.Sum256(e.state.recordDocument) != e.state.sourceProof.recordSHA256 {
		return fmt.Errorf("%w: record digest is inconsistent", ErrInvalidEvidence)
	}
	receiptDigest, err := decodeSHA256(e.state.record.ServerBindingReceiptSHA256)
	if err != nil || receiptDigest != e.state.bindingProof.serverBindingReceiptSHA256 {
		return fmt.Errorf("%w: Server binding receipt digest is inconsistent", ErrInvalidEvidence)
	}
	return nil
}

// MarshalJSON refuses to convert opaque evidence into a transferable authority token.
func (RecordEvidence) MarshalJSON() ([]byte, error) {
	return nil, ErrEvidenceNotSerializable
}

func decodeSHA256(value string) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	if !validSHA256(value) {
		return result, ErrInvalid
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return result, ErrInvalid
	}
	copy(result[:], decoded)
	return result, nil
}
