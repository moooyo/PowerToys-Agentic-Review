// Package releasepackage defines the canonical, node-specific Worker release contract and the
// Windows evidence boundaries that bind independently approved build lineage to signed bytes.
package releasepackage

import (
	"crypto/sha256"
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

const (
	ReviewedClosureSchemaVersion   = uint32(1)
	ReviewedClosurePolicyID        = "role-config-v2-package-files"
	ReviewedClosurePolicyVersion   = uint32(1)
	PrepareReceiptSchemaVersion    = uint32(1)
	PackageDescriptorSchemaVersion = uint32(2)
	PackageProfile                 = "role-config-v2-node-specific"
	FoundationVersion              = uint32(2)
	MaximumCanonicalDocumentBytes  = releasemanifest.MaximumDocumentBytes

	ControlBundlePath  = `app\control.mjs`
	ExecutorBundlePath = `app\executor.mjs`
)

var (
	ErrInvalid                      = errors.New("invalid Worker release package input")
	ErrMismatch                     = errors.New("Worker release package phase mismatch")
	ErrUnsupportedPlatform          = errors.New("Worker release evidence verification requires Windows")
	ErrReviewedClosureVerification  = errors.New("reviewed closure approval verification failed")
	ErrServiceHostBuildVerification = errors.New("ServiceHost build receipt verification failed")
	ErrServiceHostVerification      = errors.New("ServiceHost artifact verification failed")
	ErrReleaseCleanupFatal          = errors.New("release evidence handle cleanup is unresolved; process must exit")
)

type TargetArchitecture string

const (
	ArchitectureAMD64 TargetArchitecture = "amd64"
	ArchitectureARM64 TargetArchitecture = "arm64"
)

// SourceReceipt binds all package phases to one exact Git commit and tree.
type SourceReceipt struct {
	Commit string `json:"commit"`
	Tree   string `json:"tree"`
}

// DependencyIdentity is the release-reviewed target identity of one non-ServiceHost file.
type DependencyIdentity struct {
	Root releasemanifest.FileRoot `json:"root"`
	Path string                   `json:"path"`
	Role releasemanifest.FileRole `json:"role"`
}

type reviewedClosureDocument struct {
	Dependencies   []DependencyIdentity `json:"dependencies"`
	PackageProfile string               `json:"packageProfile"`
	PolicyID       string               `json:"policyId"`
	PolicyVersion  uint32               `json:"policyVersion"`
	SchemaVersion  uint32               `json:"schemaVersion"`
}

type reviewedClosureState struct {
	document []byte
	sha256   [sha256.Size]byte
	value    reviewedClosureDocument
}

// ReviewedClosureEvidence is an opaque, canonical dependency-identity closure. Production code
// can mint it only through LoadReviewedClosure's independent approval-file verification.
type ReviewedClosureEvidence struct {
	state *reviewedClosureState
}

// ServiceHostBuildEvidence is an opaque, independently approved receipt from the controlled
// ServiceHost builder. Receipt bytes or a caller-computed digest cannot mint this value.
type ServiceHostBuildEvidence struct {
	state *serviceHostBuildState
}

// NodeSpecificSPKI binds the per-node local-authority public key deliberately retained in this
// node-specific release manifest.
type NodeSpecificSPKI struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// PrepareRequest supplies an independently reviewed closure and separately observed file metadata.
// Dependencies must match the reviewed identities exactly and in canonical order.
type PrepareRequest struct {
	ReleaseID                                  string
	TargetArchitecture                         TargetArchitecture
	Source                                     SourceReceipt
	AuthenticodeLeafSignerCertificateDERSHA256 string
	NodeSpecificSPKI                           NodeSpecificSPKI
	ReviewedClosure                            ReviewedClosureEvidence
	Dependencies                               []releaseprofile.Dependency
}

type serviceHostMetadata struct {
	ReleaseID                                    string             `json:"releaseId"`
	TargetArchitecture                           TargetArchitecture `json:"targetArchitecture"`
	Source                                       SourceReceipt      `json:"source"`
	CompiledReleaseTemplateSHA256                string             `json:"compiledReleaseTemplateSha256"`
	VerifiedAuthenticodeLeafCertificateDERSHA256 string             `json:"verifiedAuthenticodeLeafCertificateDerSha256"`
	SHA256                                       string             `json:"sha256"`
	Size                                         string             `json:"size"`
}

// VerifiedServiceHostEvidence is opaque output from VerifyServiceHost. Its zero value is invalid,
// and detached metadata cannot be converted into evidence.
type VerifiedServiceHostEvidence struct {
	state *verifiedServiceHostState
}

// FinalizeRequest repeats every mutable phase input so finalize can reject mixed releases,
// architectures, source identities, node keys, inventories, and ServiceHost artifacts.
type FinalizeRequest struct {
	ReleaseID                                  string
	TargetArchitecture                         TargetArchitecture
	Source                                     SourceReceipt
	AuthenticodeLeafSignerCertificateDERSHA256 string
	NodeSpecificSPKI                           NodeSpecificSPKI
	Dependencies                               []releaseprofile.Dependency
	ServiceHostBuild                           ServiceHostBuildEvidence
	ServiceHost                                VerifiedServiceHostEvidence
}

// PackageDescriptor is the non-authorizing outer package identity. FoundationVersion and
// ExecutionAuthority are constants emitted by Finalize and are never accepted as input.
type PackageDescriptor struct {
	AuthenticodeLeafSignerCertificateDERSHA256 string               `json:"authenticodeLeafSignerCertificateDerSha256"`
	CompiledReleaseTemplateSHA256              string               `json:"compiledReleaseTemplateSha256"`
	ExecutionAuthority                         bool                 `json:"executionAuthority"`
	FoundationVersion                          uint32               `json:"foundationVersion"`
	NodeSpecificSPKI                           NodeSpecificSPKI     `json:"nodeSpecificLocalAuthorityPublicKeySpki"`
	PackageProfile                             string               `json:"packageProfile"`
	PrepareReceiptSHA256                       string               `json:"prepareReceiptSha256"`
	ReleaseID                                  string               `json:"releaseId"`
	ReviewedClosurePolicyID                    string               `json:"reviewedClosurePolicyId"`
	ReviewedClosurePolicyVersion               uint32               `json:"reviewedClosurePolicyVersion"`
	ReviewedClosureSHA256                      string               `json:"reviewedClosureSha256"`
	RuntimeManifestSHA256                      string               `json:"runtimeManifestSha256"`
	SchemaVersion                              uint32               `json:"schemaVersion"`
	ServiceHost                                releasemanifest.File `json:"serviceHost"`
	ServiceHostBuildReceiptSHA256              string               `json:"serviceHostBuildReceiptSha256"`
	Source                                     SourceReceipt        `json:"source"`
	TargetArchitecture                         TargetArchitecture   `json:"targetArchitecture"`
}

type prepareReceiptDocument struct {
	AuthenticodeLeafSignerCertificateDERSHA256 string                      `json:"authenticodeLeafSignerCertificateDerSha256"`
	CompiledReleaseTemplateSHA256              string                      `json:"compiledReleaseTemplateSha256"`
	Dependencies                               []releaseprofile.Dependency `json:"dependencies"`
	ExecutionAuthority                         bool                        `json:"executionAuthority"`
	FoundationVersion                          uint32                      `json:"foundationVersion"`
	NodeSpecificSPKI                           NodeSpecificSPKI            `json:"nodeSpecificLocalAuthorityPublicKeySpki"`
	PackageProfile                             string                      `json:"packageProfile"`
	ReleaseID                                  string                      `json:"releaseId"`
	ReviewedClosurePolicyID                    string                      `json:"reviewedClosurePolicyId"`
	ReviewedClosurePolicyVersion               uint32                      `json:"reviewedClosurePolicyVersion"`
	ReviewedClosureSHA256                      string                      `json:"reviewedClosureSha256"`
	SchemaVersion                              uint32                      `json:"schemaVersion"`
	Source                                     SourceReceipt               `json:"source"`
	TargetArchitecture                         TargetArchitecture          `json:"targetArchitecture"`
}

type preparedState struct {
	receiptDocument  []byte
	receiptSHA256    [sha256.Size]byte
	templateDocument []byte
	templateSHA256   [sha256.Size]byte
	receipt          prepareReceiptDocument
	closure          ReviewedClosureEvidence
}

// PreparedRelease is opaque validated output from Prepare or ParsePrepareReceipt.
type PreparedRelease struct {
	state *preparedState
}

type finalizedState struct {
	reviewedClosureDocument         []byte
	reviewedClosureSHA256           [sha256.Size]byte
	prepareReceiptDocument          []byte
	prepareReceiptSHA256            [sha256.Size]byte
	compiledTemplateDocument        []byte
	compiledTemplateSHA256          [sha256.Size]byte
	serviceHostBuildReceiptDocument []byte
	serviceHostBuildReceiptSHA256   [sha256.Size]byte
	manifestDocument                []byte
	manifestSHA256                  [sha256.Size]byte
	descriptorDocument              []byte
	descriptorSHA256                [sha256.Size]byte
	descriptor                      PackageDescriptor
}

// FinalizedRelease is a canonical unsigned package candidate. External signing and Windows
// verification remain mandatory before publication or installation.
type FinalizedRelease struct {
	state *finalizedState
}

// AssemblySnapshot is an opaque, immutable copy of one internally consistent finalized release.
// SnapshotForAssembly is the only production constructor. The snapshot carries data, not
// installation or execution authority.
type AssemblySnapshot struct {
	state *finalizedState
}
