//go:build windows

package releasepackage

import (
	"errors"
	"fmt"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
	"golang.org/x/sys/windows"
)

const (
	windowsSystemSID         = "S-1-5-18"
	windowsAdministratorsSID = "S-1-5-32-544"

	fileWriteData           winfile.AccessMask = 0x00000002
	fileAppendData          winfile.AccessMask = 0x00000004
	fileWriteEA             winfile.AccessMask = 0x00000010
	fileDeleteChild         winfile.AccessMask = 0x00000040
	fileWriteAttributes     winfile.AccessMask = 0x00000100
	deleteAccess            winfile.AccessMask = 0x00010000
	writeDACAccess          winfile.AccessMask = 0x00040000
	writeOwnerAccess        winfile.AccessMask = 0x00080000
	windowsFileRead         winfile.AccessMask = 0x00120089
	windowsFileReadExecute  winfile.AccessMask = 0x001200a9
	windowsFileAllAccess    winfile.AccessMask = 0x001f01ff
	windowsObjectInherit                       = uint8(0x01)
	windowsContainerInherit                    = uint8(0x02)
	windowsAllowedACE                          = uint8(0x00)
)

// LoadReviewedClosure reads one independently approved closure through retained component handles.
func LoadReviewedClosure(
	approvalDigestPath string,
	closureDocumentPath string,
) (ReviewedClosureEvidence, error) {
	return runReleaseEvidenceEntry(
		reviewedClosureVerificationError,
		func() (ReviewedClosureEvidence, error) {
			return loadReviewedClosure(
				approvalDigestPath,
				closureDocumentPath,
				productionEvidenceDependencies(),
			)
		},
	)
}

// LoadServiceHostBuildReceipt reads one independently approved controlled-build receipt through
// retained component handles.
func LoadServiceHostBuildReceipt(
	approvalDigestPath string,
	receiptDocumentPath string,
) (ServiceHostBuildEvidence, error) {
	return runReleaseEvidenceEntry(
		serviceHostBuildVerificationError,
		func() (ServiceHostBuildEvidence, error) {
			return loadServiceHostBuildReceipt(
				approvalDigestPath,
				receiptDocumentPath,
				productionEvidenceDependencies(),
			)
		},
	)
}

// VerifyServiceHost binds an approved controlled-build receipt to one final signed PE observed
// through a single retained handle and to the exact prepared release.
func VerifyServiceHost(
	prepared PreparedRelease,
	build ServiceHostBuildEvidence,
	serviceHostPath string,
) (VerifiedServiceHostEvidence, error) {
	return runReleaseEvidenceEntry(
		serviceHostVerificationError,
		func() (VerifiedServiceHostEvidence, error) {
			return verifyServiceHost(
				prepared,
				build,
				serviceHostPath,
				productionEvidenceDependencies(),
			)
		},
	)
}

func runReleaseEvidenceEntry[T any](
	failure func(string) error,
	work func() (T, error),
) (result T, resultErr error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	operation, err := beginReleaseEvidenceOperation()
	if err != nil {
		return result, err
	}
	guard, err := newReleaseThreadGuard()
	if err != nil {
		return result, failure("effective process token was rejected")
	}
	result, resultErr = work()
	guardErr := guard.finish()
	if guardErr != nil {
		result = *new(T)
		return result, failure("effective process token changed or could not be released")
	}
	if resultErr != nil {
		result = *new(T)
		return result, resultErr
	}
	if err := operation.commit(); err != nil {
		result = *new(T)
		return result, err
	}
	return result, nil
}

type releaseThreadGuard struct {
	processToken *ownedWindowsToken
}

type ownedWindowsToken struct {
	mu    sync.Mutex
	token windows.Token
}

func newReleaseThreadGuard() (*releaseThreadGuard, error) {
	if err := requireNoReleaseThreadToken(); err != nil {
		return nil, err
	}
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	owned := &ownedWindowsToken{token: token}
	if err := winidentity.VerifyReleaseProcessToken(token); err != nil {
		return nil, errors.Join(err, closeReleaseCleanupResource(owned))
	}
	return &releaseThreadGuard{processToken: owned}, nil
}

func (guard *releaseThreadGuard) finish() error {
	if guard == nil || guard.processToken == nil {
		return errors.New("release thread guard is absent")
	}
	var result error
	if err := requireNoReleaseThreadToken(); err != nil {
		result = errors.Join(result, err)
	}
	guard.processToken.mu.Lock()
	token := guard.processToken.token
	guard.processToken.mu.Unlock()
	if token == 0 {
		result = errors.Join(result, errors.New("release process token closed before final audit"))
	} else if err := winidentity.VerifyReleaseProcessToken(token); err != nil {
		result = errors.Join(result, err)
	}
	return errors.Join(result, closeReleaseCleanupResource(guard.processToken))
}

func requireNoReleaseThreadToken() error {
	var token windows.Token
	// Open as the process identity so a hostile impersonation token cannot deny query access to itself.
	err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &token)
	if errors.Is(err, windows.ERROR_NO_TOKEN) {
		return nil
	}
	if err != nil {
		return err
	}
	owned := &ownedWindowsToken{token: token}
	return errors.Join(
		errors.New("release evidence reader must not run under a thread token"),
		closeReleaseCleanupResource(owned),
	)
}

func (token *ownedWindowsToken) Close() error {
	if token == nil {
		return nil
	}
	token.mu.Lock()
	defer token.mu.Unlock()
	if token.token == 0 {
		return nil
	}
	if err := token.token.Close(); err != nil {
		return err
	}
	token.token = 0
	return nil
}

func productionEvidenceDependencies() evidenceDependencies {
	return evidenceDependencies{
		openFile:                 openRetainedWindowsPath,
		checkIndependentApproval: checkIndependentApproval,
		newAuthenticodeVerifier:  authenticode.NewWindowsVerifier,
	}
}

type retainedWindowsPath struct {
	mu                sync.Mutex
	directories       []*winfile.Directory
	directoryEvidence []winfile.Evidence
	file              *winfile.File
	fileEvidence      winfile.Evidence
	rechecked         bool
	recheckErr        error
}

func openRetainedWindowsPath(
	path string,
	options winfile.OpenOptions,
) (retainedReleaseFile, error) {
	if options != releaseInputOpenOptions() {
		return nil, errors.New("release file options are not fixed")
	}
	root, components, err := splitReleaseWindowsPath(path)
	if err != nil {
		return nil, err
	}
	retained := &retainedWindowsPath{}
	rootDirectory, err := winfile.OpenTraversalRoot(root, winfile.OpenOptions{
		VolumeUse:    winfile.VolumeUseReadOnly,
		SecurityMode: winfile.SecurityModeAmbientAncestor,
	})
	if err != nil {
		return nil, err
	}
	retained.directories = append(retained.directories, rootDirectory)
	retained.directoryEvidence = append(retained.directoryEvidence, rootDirectory.Evidence())
	parent := rootDirectory
	for _, component := range components[:len(components)-1] {
		child, openErr := parent.OpenDirectoryComponent(component, winfile.OpenOptions{
			VolumeUse:    winfile.VolumeUseReadOnly,
			SecurityMode: winfile.SecurityModeManaged,
		})
		if openErr != nil {
			retained.rechecked = true
			_ = closeRetainedReleaseFiles([]retainedReleaseFile{retained})
			return nil, openErr
		}
		retained.directories = append(retained.directories, child)
		retained.directoryEvidence = append(retained.directoryEvidence, child.Evidence())
		parent = child
	}
	file, err := parent.OpenFileComponent(components[len(components)-1], options)
	if err != nil {
		retained.rechecked = true
		_ = closeRetainedReleaseFiles([]retainedReleaseFile{retained})
		return nil, err
	}
	retained.file = file
	retained.fileEvidence = file.Evidence()
	if err := retained.validateOpenedPath(); err != nil {
		retained.rechecked = true
		_ = closeRetainedReleaseFiles([]retainedReleaseFile{retained})
		return nil, err
	}
	return retained, nil
}

func splitReleaseWindowsPath(path string) (string, []string, error) {
	if len(path) < 6 || path[0] < 'A' || path[0] > 'Z' || path[1] != ':' || path[2] != '\\' ||
		strings.Contains(path, "/") || strings.HasSuffix(path, `\`) {
		return "", nil, errors.New("release input path is not a canonical absolute Windows file path")
	}
	components := strings.Split(path[3:], `\`)
	if len(components) < 2 {
		return "", nil, errors.New("release input path must have a managed parent directory")
	}
	for _, component := range components {
		if component == "" {
			return "", nil, errors.New("release input path contains an empty component")
		}
	}
	return path[:3], components, nil
}

func (retained *retainedWindowsPath) Evidence() winfile.Evidence {
	if retained == nil || retained.file == nil {
		return winfile.Evidence{}
	}
	return retained.file.Evidence()
}

func (retained *retainedWindowsPath) AncestorEvidence() []winfile.Evidence {
	if retained == nil {
		return nil
	}
	result := make([]winfile.Evidence, len(retained.directories))
	for index, directory := range retained.directories {
		result[index] = directory.Evidence()
	}
	return result
}

func (retained *retainedWindowsPath) ReadAll(maximum uint64) ([]byte, error) {
	if retained == nil || retained.file == nil {
		return nil, winfile.ErrClosed
	}
	return retained.file.ReadAll(maximum)
}

func (retained *retainedWindowsPath) HashSHA256(options winfile.HashOptions) (winfile.HashResult, error) {
	if retained == nil || retained.file == nil {
		return winfile.HashResult{}, winfile.ErrClosed
	}
	return retained.file.HashSHA256(options)
}

func (retained *retainedWindowsPath) VerifyAuthenticode(
	verifier authenticode.Verifier,
) (authenticode.Evidence, error) {
	if retained == nil || retained.file == nil {
		return authenticode.Evidence{}, winfile.ErrClosed
	}
	return retained.file.VerifyAuthenticode(verifier)
}

func (retained *retainedWindowsPath) VerifyUnchanged() error {
	if retained == nil {
		return winfile.ErrClosed
	}
	return retained.verifyPath()
}

func (retained *retainedWindowsPath) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	if retained == nil || retained.file == nil {
		return winfile.SecurityDescriptorEvidence{}, winfile.ErrClosed
	}
	return retained.file.ReinspectSecurity()
}

func (retained *retainedWindowsPath) Close() error {
	if retained == nil {
		return nil
	}
	retained.mu.Lock()
	defer retained.mu.Unlock()
	if !retained.rechecked {
		retained.recheckErr = retained.verifyPath()
		retained.rechecked = true
	}
	var closeErr error
	if retained.file != nil {
		if err := retained.file.Close(); err != nil {
			closeErr = errors.Join(closeErr, err)
		} else {
			retained.file = nil
		}
	}
	for index := len(retained.directories) - 1; index >= 0; index-- {
		if retained.directories[index] == nil {
			continue
		}
		if err := retained.directories[index].Close(); err != nil {
			closeErr = errors.Join(closeErr, err)
		} else {
			retained.directories[index] = nil
		}
	}
	return errors.Join(retained.recheckErr, closeErr)
}

func (retained *retainedWindowsPath) validateOpenedPath() error {
	if retained.file == nil || len(retained.directories) < 2 ||
		len(retained.directories) != len(retained.directoryEvidence) {
		return errors.New("retained release path is incomplete")
	}
	seen := make(map[winfile.FileIdentity]struct{}, len(retained.directories)+1)
	volume := retained.fileEvidence.Identity.VolumeSerialNumber
	for index, evidence := range retained.directoryEvidence {
		expectedMode := winfile.SecurityModeAmbientAncestor
		if index != 0 {
			expectedMode = winfile.SecurityModeManaged
		}
		if evidence.Kind != winfile.ObjectKindDirectory || evidence.Identity == (winfile.FileIdentity{}) ||
			evidence.Identity.VolumeSerialNumber != volume || evidence.SecurityMode != expectedMode ||
			!evidence.Path.TerminalComponentReparseFree || !evidence.Volume.PathIdentityCrossCheck {
			return errors.New("retained release ancestor evidence is invalid")
		}
		if _, duplicate := seen[evidence.Identity]; duplicate {
			return errors.New("retained release path reuses an object identity")
		}
		seen[evidence.Identity] = struct{}{}
	}
	if retained.fileEvidence.Identity == (winfile.FileIdentity{}) ||
		retained.fileEvidence.SecurityMode != winfile.SecurityModeManaged {
		return errors.New("retained release file evidence is invalid")
	}
	if _, duplicate := seen[retained.fileEvidence.Identity]; duplicate {
		return errors.New("retained release file reuses an ancestor identity")
	}
	return nil
}

func (retained *retainedWindowsPath) verifyPath() error {
	if retained.file == nil || len(retained.directories) != len(retained.directoryEvidence) {
		return winfile.ErrClosed
	}
	var result error
	if err := retained.file.VerifyUnchanged(); err != nil {
		result = errors.Join(result, err)
	}
	if security, err := retained.file.ReinspectSecurity(); err != nil ||
		!reflect.DeepEqual(security, retained.fileEvidence.Security) {
		result = errors.Join(result, errors.New("retained release file security changed"))
	}
	if _, err := retained.file.ReinspectDataStreams(); err != nil {
		result = errors.Join(result, err)
	}
	for index, directory := range retained.directories {
		if directory == nil {
			result = errors.Join(result, winfile.ErrClosed)
			continue
		}
		if err := directory.VerifyUnchanged(); err != nil {
			result = errors.Join(result, err)
		}
		if security, err := directory.ReinspectSecurity(); err != nil ||
			!reflect.DeepEqual(security, retained.directoryEvidence[index].Security) {
			result = errors.Join(result, errors.New("retained release ancestor security changed"))
		}
		if _, err := directory.ReinspectDataStreams(); err != nil {
			result = errors.Join(result, err)
		}
		if caseSensitive, err := directory.ReinspectCaseSensitivity(); err != nil || caseSensitive {
			result = errors.Join(result, errors.New("retained release ancestor case mode changed"))
		}
	}
	return result
}

func checkIndependentApproval(file retainedReleaseFile) (resultErr error) {
	if file == nil {
		return errors.New("approval file is absent")
	}
	fileEvidence := file.Evidence()
	ancestors := file.AncestorEvidence()
	if len(ancestors) < 2 || !approvedAuthorityOwner(fileEvidence.Security.OwnerSID) {
		return errors.New("approval file owner is not trusted")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil || !user.User.Sid.IsValid() {
		return errors.New("approval reader identity is unavailable")
	}
	userSID := user.User.Sid.String()
	if userSID == "" || approvedAuthorityOwner(userSID) {
		return errors.New("approval reader must use a dedicated non-authority identity")
	}
	if err := auditApprovalACL(fileEvidence.Security, userSID, false); err != nil {
		return err
	}
	for index := 1; index < len(ancestors); index++ {
		ancestor := ancestors[index]
		if ancestor.SecurityMode != winfile.SecurityModeManaged ||
			!approvedAuthorityOwner(ancestor.Security.OwnerSID) {
			return errors.New("approval ancestor owner is not trusted")
		}
		if err := auditApprovalACL(ancestor.Security, userSID, true); err != nil {
			return err
		}
	}
	token, err := winfile.NewStableAccessToken(windows.GetCurrentProcessToken())
	if err != nil {
		return errors.New("approval access token could not be stabilized")
	}
	defer func() {
		if err := closeReleaseCleanupResource(token); err != nil {
			resultErr = errors.Join(resultErr, errors.New("approval access token cleanup failed"))
		}
	}()
	fileMasks := []winfile.AccessMask{
		fileWriteData, fileAppendData, fileWriteEA, fileWriteAttributes,
		deleteAccess, writeDACAccess, writeOwnerAccess,
	}
	directoryMasks := []winfile.AccessMask{
		fileWriteData, fileAppendData, fileDeleteChild, fileWriteEA, fileWriteAttributes,
		deleteAccess, writeDACAccess, writeOwnerAccess,
	}
	if err := requireDeniedMutationAccess(token, fileEvidence.Security, fileMasks); err != nil {
		return err
	}
	for index := 1; index < len(ancestors); index++ {
		if err := requireDeniedMutationAccess(token, ancestors[index].Security, directoryMasks); err != nil {
			return err
		}
	}
	return nil
}

func approvedAuthorityOwner(value string) bool {
	return value == windowsSystemSID || value == windowsAdministratorsSID
}

func auditApprovalACL(
	security winfile.SecurityDescriptorEvidence,
	readerSID string,
	directory bool,
) error {
	if len(security.SelfRelativeDescriptor) == 0 || !security.DACLPresent || security.DACLNull ||
		!security.DACLProtected || security.OwnerDefaulted || security.GroupDefaulted ||
		security.DACLDefaulted {
		return errors.New("approval security descriptor is incomplete")
	}
	descriptorBytes := append([]byte(nil), security.SelfRelativeDescriptor...)
	descriptor := (*windows.SECURITY_DESCRIPTOR)(unsafe.Pointer(&descriptorBytes[0]))
	if !descriptor.IsValid() || descriptor.Length() != uint32(len(descriptorBytes)) {
		return errors.New("approval security descriptor is invalid")
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 3 {
		return errors.New("approval DACL is not the exact three-principal policy")
	}
	readerMask := windowsFileRead
	expectedFlags := uint8(0)
	if directory {
		readerMask = windowsFileReadExecute
		expectedFlags = windowsObjectInherit | windowsContainerInherit
	}
	expected := map[string]winfile.AccessMask{
		windowsSystemSID:         windowsFileAllAccess,
		windowsAdministratorsSID: windowsFileAllAccess,
		readerSID:                readerMask,
	}
	seen := make(map[string]struct{}, len(expected))
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil || ace == nil ||
			ace.Header.AceType != windowsAllowedACE || uint8(ace.Header.AceFlags) != expectedFlags {
			return errors.New("approval DACL contains an unsupported ACE")
		}
		sidOffset := int(unsafe.Offsetof(ace.SidStart))
		if int(ace.Header.AceSize) < sidOffset+8 {
			return errors.New("approval DACL contains a truncated SID")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsValid() || int(ace.Header.AceSize) != sidOffset+sid.Len() {
			return errors.New("approval DACL contains an invalid SID")
		}
		value := sid.String()
		mask, exists := expected[value]
		if !exists || winfile.AccessMask(ace.Mask) != mask {
			return errors.New("approval DACL grants an unapproved trustee or access mask")
		}
		if _, duplicate := seen[value]; duplicate {
			return errors.New("approval DACL repeats an approved trustee")
		}
		seen[value] = struct{}{}
	}
	runtime.KeepAlive(descriptorBytes)
	if len(seen) != len(expected) {
		return errors.New("approval DACL omits an approved trustee")
	}
	return nil
}

func requireDeniedMutationAccess(
	token *winfile.StableAccessToken,
	security winfile.SecurityDescriptorEvidence,
	masks []winfile.AccessMask,
) error {
	for _, mask := range masks {
		decision, err := token.CheckAccess(security, mask, winfile.GenericMapping{})
		if err != nil || decision.Allowed || decision.GrantedAccess != 0 {
			return fmt.Errorf("current release process can mutate an independently approved object")
		}
	}
	return nil
}

var _ retainedReleaseFile = (*retainedWindowsPath)(nil)
