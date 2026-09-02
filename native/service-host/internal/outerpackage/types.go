// Package outerpackage defines the canonical, signed outer Worker package contract.
// Its pure validation results are data checks only and never authorize installation.
package outerpackage

import "errors"

const (
	IndexSchemaVersion     = uint32(1)
	IndexProfileID         = "agentic-review-worker-outer-package-v1"
	SignatureSchemaVersion = uint32(1)
	SignatureAlgorithm     = "ecdsa-p256-sha256-p1363-low-s"
	MaximumIndexBytes      = 8 * 1024 * 1024
	MaximumEnvelopeBytes   = 4 * 1024
	MaximumPayloads        = 8_200
	MaximumPathBytes       = 4_096
	MaximumPayloadBytes    = uint64(8 * 1024 * 1024 * 1024)
	MaximumTotalBytes      = uint64(32 * 1024 * 1024 * 1024)

	PackageIndexPath            = `package-index.json`
	SignatureEnvelopePath       = `package-index.signature.json`
	PackageDescriptorPath       = `package-descriptor.json`
	PrepareReceiptPath          = `prepare-receipt.json`
	ReviewedClosurePath         = `reviewed-closure.json`
	CompiledReleaseTemplatePath = `compiled-release-template.json`
	ServiceHostBuildReceiptPath = `servicehost-build-receipt.json`
	RuntimeManifestPath         = `release-manifest.json`
	ControlBootstrapPath        = `control-service-host.json`
	ExecutorBootstrapPath       = `executor-service-host.json`
	MTLSCertificateStore        = "MY"
)

var (
	ErrInvalid   = errors.New("invalid outer Worker package")
	ErrCanonical = errors.New("outer Worker package document is not canonical")
	ErrMismatch  = errors.New("outer Worker package differs from finalized release")
	ErrSignature = errors.New("outer Worker package signature is invalid")
)

type Root string

const (
	RootMetadata             Root = "metadata"
	RootInstallation         Root = "installation"
	RootTrustedConfiguration Root = "trusted-configuration"
)

type TargetArchitecture string

const (
	ArchitectureAMD64 TargetArchitecture = "amd64"
	ArchitectureARM64 TargetArchitecture = "arm64"
)

type Role string

const (
	RolePackageDescriptor       Role = "package-descriptor"
	RolePrepareReceipt          Role = "prepare-receipt"
	RoleReviewedClosure         Role = "reviewed-closure"
	RoleCompiledReleaseTemplate Role = "compiled-release-template"
	RoleServiceHostBuildReceipt Role = "servicehost-build-receipt"
	RoleRuntimeManifest         Role = "runtime-manifest"
	RoleControlBootstrap        Role = "control-bootstrap"
	RoleExecutorBootstrap       Role = "executor-bootstrap"

	RoleServiceWrapper Role = "service-wrapper"
	RoleServiceHost    Role = "service-host"
	RoleNodeRuntime    Role = "node-runtime"
	RoleControlBundle  Role = "control-bundle"
	RoleExecutorBundle Role = "executor-bundle"
	RoleProcessHost    Role = "process-host"
	RoleCodexCLI       Role = "codex-cli"
	RoleGitCLI         Role = "git-cli"
	RoleGitHelper      Role = "git-helper"
	RoleCodexRuntime   Role = "codex-runtime"
	RoleNativeLibrary  Role = "native-library"
	RoleCABundle       Role = "ca-bundle"
	RoleServiceConfig  Role = "service-config"
	RoleTrustedConfig  Role = "trusted-config"
	RolePolicy         Role = "policy"
	RoleSchema         Role = "schema"
	RolePrompt         Role = "prompt"
	RoleRecipe         Role = "recipe"
	RoleRuntimeData    Role = "runtime-data"
	RoleLicense        Role = "license"
)

type SourceIdentity struct {
	Commit string `json:"commit"`
	Tree   string `json:"tree"`
}

type NodeSpecificSPKI struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type LocalAuthorityCNGIdentity struct {
	KeyName                  string `json:"keyName"`
	SecurityDescriptorSHA256 string `json:"securityDescriptorSha256"`
}

type MTLSCredentialIdentity struct {
	CertificateDERSHA256               string `json:"certificateDerSha256"`
	CertificateStore                   string `json:"certificateStore"`
	PrivateKeySecurityDescriptorSHA256 string `json:"privateKeySecurityDescriptorSha256"`
}

type TargetRoots struct {
	Installation         string `json:"installation"`
	Metadata             string `json:"metadata"`
	TrustedConfiguration string `json:"trustedConfiguration"`
}

type Payload struct {
	Path               string              `json:"path"`
	Role               Role                `json:"role"`
	Root               Root                `json:"root"`
	SHA256             string              `json:"sha256"`
	Size               string              `json:"size"`
	TargetArchitecture *TargetArchitecture `json:"targetArchitecture,omitempty"`
}

type Index struct {
	InstallationID                       string                    `json:"installationId"`
	LocalAuthorityCNG                    LocalAuthorityCNGIdentity `json:"localAuthorityCng"`
	MTLSClientCredential                 MTLSCredentialIdentity    `json:"mtlsClientCredential"`
	NodeSpecificLocalAuthorityPublicSPKI NodeSpecificSPKI          `json:"nodeSpecificLocalAuthorityPublicKeySpki"`
	PackageID                            string                    `json:"packageId"`
	Payloads                             []Payload                 `json:"payloads"`
	ProfileID                            string                    `json:"profileId"`
	ReleaseID                            string                    `json:"releaseId"`
	SchemaVersion                        uint32                    `json:"schemaVersion"`
	Source                               SourceIdentity            `json:"source"`
	TargetArchitecture                   TargetArchitecture        `json:"targetArchitecture"`
	TargetRoots                          TargetRoots               `json:"targetRoots"`
	WorkerNodeID                         string                    `json:"workerNodeId"`
}

type BootstrapPayload struct {
	SHA256 string
	Size   string
}

// BuildOptions contains ordinary assembler-supplied node and bootstrap facts. BuildIndex commits
// them to the index but does not independently establish their filesystem or authority provenance.
type BuildOptions struct {
	PackageID            string
	InstallationID       string
	WorkerNodeID         string
	LocalAuthorityCNG    LocalAuthorityCNGIdentity
	MTLSClientCredential MTLSCredentialIdentity
	TargetRoots          TargetRoots
	ControlBootstrap     BootstrapPayload
	ExecutorBootstrap    BootstrapPayload
}

type SignatureEnvelope struct {
	Algorithm     string `json:"algorithm"`
	IndexSHA256   string `json:"indexSha256"`
	SchemaVersion uint32 `json:"schemaVersion"`
	Signature     string `json:"signature"`
	SignerKeyID   string `json:"signerKeyId"`
}
