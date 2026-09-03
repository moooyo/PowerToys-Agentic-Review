package installverify

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installerprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func normalizeOptions(options Options) (Options, error) {
	if options.Role != config.RoleControl && options.Role != config.RoleExecutor {
		return Options{}, verificationError(ErrorInput, "role must be control or executor", ErrInvalidOptions)
	}
	selectedRole, err := RoleFromBootstrapPath(options.ActualBootstrapPath)
	if err != nil {
		return Options{}, verificationError(ErrorInput, "actual bootstrap path is invalid", err)
	}
	if options.Role != selectedRole {
		return Options{}, verificationError(ErrorInput, "actual bootstrap path does not match the selected role", ErrInvalidOptions)
	}
	if options.Limits == (Limits{}) {
		options.Limits = ProductionLimits()
	}
	if err := validateLimits(options.Limits); err != nil {
		return Options{}, verificationError(ErrorInput, "installation verification limits are invalid", err)
	}
	parsedBootstrap, err := parseWindowsPath(options.ActualBootstrapPath, true)
	if err != nil || uint32(len(parsedBootstrap.components)) > options.Limits.MaximumPathDepth+1 {
		return Options{}, verificationError(ErrorInput, "actual bootstrap path exceeds its depth limit", errors.Join(ErrInvalidOptions, err))
	}
	return options, nil
}

func validateLimits(value Limits) error {
	maximum := ProductionLimits()
	if value.MaximumDirectories == 0 || value.MaximumDirectories > maximum.MaximumDirectories ||
		value.MaximumEntriesPerDirectory == 0 || value.MaximumEntriesPerDirectory > maximum.MaximumEntriesPerDirectory ||
		value.MaximumTotalEntries == 0 || value.MaximumTotalEntries > maximum.MaximumTotalEntries ||
		value.MaximumNameUTF16Units == 0 || value.MaximumNameUTF16Units > maximum.MaximumNameUTF16Units ||
		value.MaximumTotalNameUTF16Units == 0 || value.MaximumTotalNameUTF16Units > maximum.MaximumTotalNameUTF16Units ||
		value.MaximumPathDepth == 0 || value.MaximumPathDepth > maximum.MaximumPathDepth ||
		value.MaximumFileBytes == 0 || value.MaximumFileBytes > maximum.MaximumFileBytes ||
		value.MaximumTotalFileBytes == 0 || value.MaximumTotalFileBytes > maximum.MaximumTotalFileBytes {
		return ErrInvalidOptions
	}
	return nil
}

func validateDependencies(value dependencies) error {
	if value.identityPreflight == nil || value.newSecurityPolicy == nil ||
		value.newAuthenticodeVerifier == nil || value.managedAnchor == nil ||
		value.secureRead == nil || value.openTraversalRoot == nil {
		return verificationError(ErrorInput, "installation verification dependencies are incomplete", ErrInvalidOptions)
	}
	return nil
}

func validateSecureRead(
	label string,
	expectedPath string,
	managedAnchor string,
	read secureconfig.Result,
	maximumBytes uint64,
) error {
	if len(read.Data) == 0 || uint64(len(read.Data)) > maximumBytes {
		return fmt.Errorf("%s data is empty or exceeds its byte limit", label)
	}
	if !windowsPathEqual(read.File.Path, expectedPath) || uint64(len(read.Data)) != read.File.Evidence.Size {
		return fmt.Errorf("%s path or size does not match its file evidence", label)
	}
	digest := sha256.Sum256(read.Data)
	if subtle.ConstantTimeCompare(digest[:], read.ContentSHA256[:]) != 1 {
		return fmt.Errorf("%s content digest does not match its bytes", label)
	}
	canonicalFile, err := secureconfig.NewObjectEvidenceForMode(
		read.File.Path,
		winfile.SecurityModeManaged,
		read.File.Evidence,
	)
	if err != nil || !sameObjectEvidence(canonicalFile, read.File) {
		return fmt.Errorf("%s file evidence is invalid: %w", label, err)
	}
	if len(read.Ancestors) == 0 {
		return fmt.Errorf("%s has no retained ancestor evidence", label)
	}
	seen := make(map[winfile.FileIdentity]string, len(read.Ancestors)+1)
	managed := false
	for index, ancestor := range read.Ancestors {
		if windowsPathEqual(ancestor.Path, managedAnchor) {
			managed = true
		}
		expectedMode := winfile.SecurityModeAmbientAncestor
		if managed {
			expectedMode = winfile.SecurityModeManaged
		}
		canonical, err := secureconfig.NewObjectEvidenceForMode(ancestor.Path, expectedMode, ancestor.Evidence)
		if err != nil || !sameObjectEvidence(canonical, ancestor) || ancestor.Evidence.Kind != winfile.ObjectKindDirectory {
			return fmt.Errorf("%s ancestor evidence is invalid: %w", label, err)
		}
		if index > 0 && !directChild(read.Ancestors[index-1].Path, ancestor.Path) {
			return fmt.Errorf("%s ancestor chain is not component-relative", label)
		}
		if err := registerIdentity(seen, ancestor.Path, ancestor.Evidence.Identity); err != nil {
			return err
		}
		if ancestor.Evidence.Identity.VolumeSerialNumber != read.File.Evidence.Identity.VolumeSerialNumber {
			return fmt.Errorf("%s spans more than one volume", label)
		}
	}
	if !directChild(read.Ancestors[len(read.Ancestors)-1].Path, read.File.Path) {
		return fmt.Errorf("%s file is not a direct child of its retained parent", label)
	}
	if !managed {
		return fmt.Errorf("%s ancestor chain does not contain its managed anchor", label)
	}
	return registerIdentity(seen, read.File.Path, read.File.Evidence.Identity)
}

func validateConfigurationPair(control, executor config.Config) error {
	mismatch := func(field string) error {
		return fmt.Errorf("%w: Control and Executor configurations disagree on %s", ErrConfiguration, field)
	}
	if control.Role != config.RoleControl || executor.Role != config.RoleExecutor {
		return mismatch("role")
	}
	if control.SchemaVersion != executor.SchemaVersion {
		return mismatch("schemaVersion")
	}
	if control.OwnService != executor.PeerService || control.PeerService != executor.OwnService {
		return mismatch("mutual service identities")
	}
	if control.WorkerNodeID != executor.WorkerNodeID {
		return mismatch("workerNodeId")
	}
	if control.PipeName != executor.PipeName {
		return mismatch("pipe name")
	}
	if !windowsPathEqual(control.Installation.Root, executor.Installation.Root) {
		return mismatch("installation root")
	}
	if !windowsPathEqual(control.Installation.TrustedConfigurationRoot, executor.Installation.TrustedConfigurationRoot) {
		return mismatch("trusted configuration root")
	}
	if control.Installation.ReleaseID != executor.Installation.ReleaseID ||
		!windowsPathEqual(control.Installation.ManifestPath, executor.Installation.ManifestPath) ||
		control.Installation.ManifestSHA256 != executor.Installation.ManifestSHA256 ||
		control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 !=
			executor.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 {
		return mismatch("release identity")
	}
	if windowsPathsOverlap(control.Node.DataRoot, executor.Node.DataRoot) {
		return mismatch("distinct data roots")
	}
	if control.Control == nil || executor.Executor == nil ||
		control.Control.LocalAuthorityPublicKeySHA256 != executor.Executor.LocalAuthorityPublicKeySHA256 {
		return mismatch("local authority public key digest")
	}
	if control.Limits.MaximumFrameBytes != executor.Limits.MaximumFrameBytes {
		return mismatch("limits.maximumFrameBytes")
	}
	if control.Limits.MaximumQueuedBytesPerDirection != executor.Limits.MaximumQueuedBytesPerDirection {
		return mismatch("limits.maximumQueuedBytesPerDirection")
	}
	if control.Limits.ConnectTimeoutMilliseconds != executor.Limits.ConnectTimeoutMilliseconds {
		return mismatch("limits.connectTimeoutMilliseconds")
	}
	if control.Limits.ShutdownTimeoutMilliseconds != executor.Limits.ShutdownTimeoutMilliseconds {
		return mismatch("limits.shutdownTimeoutMilliseconds")
	}
	if control.Limits.ForceTerminationReserveMilliseconds !=
		executor.Limits.ForceTerminationReserveMilliseconds {
		return mismatch("limits.forceTerminationReserveMilliseconds")
	}
	if installerprofile.ValidateBootstrapPair(
		installerprofile.ProfileID,
		control,
		executor,
	) != nil {
		return mismatch("installer profile")
	}
	return nil
}

func validateAuthenticodeEvidence(evidence authenticode.Evidence, expectedSigner string) error {
	if !evidence.Trusted || evidence.SignatureKind != authenticode.SignatureKindEmbedded ||
		evidence.SignatureCount != 1 || evidence.VerifiedSignatureIndex != 0 ||
		evidence.RevocationPolicy != authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck ||
		evidence.DigestPolicy != authenticode.DigestPolicySHA256Only ||
		evidence.StrongSignaturePolicy != authenticode.StrongSignaturePolicyWindowsOSCurrent ||
		evidence.SignerDigestAlgorithmOID != authenticode.SHA256ObjectIdentifier ||
		evidence.FileDigestAlgorithmOID != authenticode.SHA256ObjectIdentifier ||
		strings.TrimSpace(evidence.SignerIdentity) == "" ||
		subtle.ConstantTimeCompare(
			[]byte(evidence.VerifiedLeafSignerCertificateDERSHA256),
			[]byte(expectedSigner),
		) != 1 {
		return ErrAuthenticode
	}
	return nil
}

func requiresAuthenticode(role releasemanifest.FileRole) bool {
	switch role {
	case releasemanifest.RoleServiceHost,
		releasemanifest.RoleNodeRuntime,
		releasemanifest.RoleProcessHost,
		releasemanifest.RoleCodexCLI,
		releasemanifest.RoleGitCLI,
		releasemanifest.RoleGitHelper,
		releasemanifest.RoleCodexRuntime,
		releasemanifest.RoleNativeLibrary:
		return true
	default:
		return false
	}
}

func directChild(parent, child string) bool {
	parentPath, parentErr := parseWindowsPath(parent, false)
	childPath, childErr := parseWindowsPath(child, false)
	if parentErr != nil || childErr != nil || !strings.EqualFold(parentPath.drive, childPath.drive) ||
		len(childPath.components) != len(parentPath.components)+1 {
		return false
	}
	for index := range parentPath.components {
		if !strings.EqualFold(parentPath.components[index], childPath.components[index]) {
			return false
		}
	}
	return true
}

func windowsPathsOverlap(left, right string) bool {
	leftPath, leftErr := parseWindowsPath(left, false)
	rightPath, rightErr := parseWindowsPath(right, false)
	if leftErr != nil || rightErr != nil || !strings.EqualFold(leftPath.drive, rightPath.drive) {
		return false
	}
	minimum := len(leftPath.components)
	if len(rightPath.components) < minimum {
		minimum = len(rightPath.components)
	}
	for index := 0; index < minimum; index++ {
		if !strings.EqualFold(leftPath.components[index], rightPath.components[index]) {
			return false
		}
	}
	return true
}

func sameObjectEvidence(left, right secureconfig.ObjectEvidence) bool {
	return left.Path == right.Path && left.EvidenceSHA256 == right.EvidenceSHA256 &&
		left.SecurityDescriptorSHA256 == right.SecurityDescriptorSHA256 &&
		reflect.DeepEqual(left.Evidence, right.Evidence)
}

func registerIdentity(seen map[winfile.FileIdentity]string, path string, identity winfile.FileIdentity) error {
	if identity.FileID == ([16]byte{}) {
		return fmt.Errorf("%w: %s has an empty file ID", ErrFileIdentity, path)
	}
	if previous, exists := seen[identity]; exists {
		if windowsPathEqual(previous, path) {
			return nil
		}
		return fmt.Errorf("%w: %s and %s identify the same object", ErrFileIdentity, previous, path)
	}
	seen[identity] = path
	return nil
}

func equalDigest(actual [sha256.Size]byte, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(fmt.Sprintf("%x", actual)), []byte(expected)) == 1
}

func isNilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}

func verificationError(code ErrorCode, message string, cause error) error {
	return &Error{Code: code, Message: message, Cause: cause}
}
