package serverbindingauthorityv1

import (
	"errors"
	"time"
)

const (
	SchemaVersion        = uint32(1)
	BindingRevision      = uint32(1)
	EnrollmentGeneration = uint32(1)
	MaximumDocumentBytes = 4 * 1024

	SignatureAlgorithm    = "ecdsa-p256-sha256-p1363-low-s"
	Issuer                = "agentic-review-server-enrollment-binding-authority-v1"
	ReceiptProfileID      = "agentic-review-server-binding-receipt-v1"
	ActiveStatusProfileID = "agentic-review-server-binding-active-status-v1"

	ReceiptStatementType      = "durable-binding-created"
	ActiveStatusStatementType = "active-binding-current"

	MaximumActiveStatusLifetime = 60 * time.Second
	MaximumClockSkew            = 5 * time.Second
)

var (
	ErrInvalid           = errors.New("invalid Server enrollment-binding authority v1 document")
	ErrCanonical         = errors.New("Server enrollment-binding authority v1 document is not canonical")
	ErrSignature         = errors.New("Server enrollment-binding authority v1 signature is invalid")
	ErrUnavailable       = errors.New("production Server enrollment-binding authority v1 verifier is unavailable")
	ErrInvalidVerifier   = errors.New("Server enrollment-binding authority v1 verifier is invalid")
	ErrInvalidChallenge  = errors.New("Server enrollment-binding authority v1 challenge is invalid")
	ErrChallengeConsumed = errors.New("Server enrollment-binding authority v1 challenge is no longer usable")
	ErrInvalidEvidence   = errors.New("Server enrollment-binding authority v1 evidence is invalid")
	ErrEvidenceConsumed  = errors.New("Server enrollment-binding authority v1 evidence is no longer usable")
	ErrNotSerializable   = errors.New("Server enrollment-binding authority v1 opaque value cannot be serialized")
	ErrExpired           = errors.New("Server enrollment-binding authority v1 active status is expired")
	ErrCanceled          = errors.New("Server enrollment-binding authority v1 operation was canceled")
)

// ServerBindingReceiptStatementV1 is ordinary immutable reservation data.
type ServerBindingReceiptStatementV1 struct {
	BindingID            string `json:"bindingId"`
	BindingRevision      uint32 `json:"bindingRevision"`
	BoundAt              string `json:"boundAt"`
	CertificateDERSHA256 string `json:"certificateDerSha256"`
	EnrollmentGeneration uint32 `json:"enrollmentGeneration"`
	InstallationID       string `json:"installationId"`
	StatementType        string `json:"statementType"`
	WorkerNodeID         string `json:"workerNodeId"`
}

// ServerBindingReceiptV1 is the exact signed historical reservation document.
type ServerBindingReceiptV1 struct {
	Algorithm     string                          `json:"algorithm"`
	Issuer        string                          `json:"issuer"`
	IssuerKeyID   string                          `json:"issuerKeyId"`
	ProfileID     string                          `json:"profileId"`
	SchemaVersion uint32                          `json:"schemaVersion"`
	Signature     string                          `json:"signature"`
	Statement     ServerBindingReceiptStatementV1 `json:"statement"`
}

// ServerBindingActiveStatusStatementV1 is ordinary challenge-bound status data.
type ServerBindingActiveStatusStatementV1 struct {
	BindingID               string `json:"bindingId"`
	BindingRevision         uint32 `json:"bindingRevision"`
	CertificateDERSHA256    string `json:"certificateDerSha256"`
	ChallengeNonceBase64URL string `json:"challengeNonceBase64Url"`
	EnrollmentGeneration    uint32 `json:"enrollmentGeneration"`
	ExpiresAt               string `json:"expiresAt"`
	InstallationID          string `json:"installationId"`
	IssuedAt                string `json:"issuedAt"`
	ReceiptSHA256           string `json:"receiptSha256"`
	RecordDocumentSHA256    string `json:"recordDocumentSha256"`
	StatementType           string `json:"statementType"`
	WorkerNodeID            string `json:"workerNodeId"`
}

// ServerBindingActiveStatusV1 is the exact signed fresh-status document.
type ServerBindingActiveStatusV1 struct {
	Algorithm     string                               `json:"algorithm"`
	Issuer        string                               `json:"issuer"`
	IssuerKeyID   string                               `json:"issuerKeyId"`
	ProfileID     string                               `json:"profileId"`
	SchemaVersion uint32                               `json:"schemaVersion"`
	Signature     string                               `json:"signature"`
	Statement     ServerBindingActiveStatusStatementV1 `json:"statement"`
}

// ActiveStatusExpectation fixes every binding value a caller expects from a fresh assertion.
// It is ordinary comparison input and is not evidence or authority.
type ActiveStatusExpectation struct {
	BindingID            string
	BindingRevision      uint32
	CertificateDERSHA256 string
	EnrollmentGeneration uint32
	InstallationID       string
	ReceiptSHA256        string
	RecordDocumentSHA256 string
	WorkerNodeID         string
}
