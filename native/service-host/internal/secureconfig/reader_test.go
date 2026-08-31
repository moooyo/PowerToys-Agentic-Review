package secureconfig

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestReadWithBackendRetainsHandlesAndReturnsDetachedEvidence(t *testing.T) {
	path := `C:\trusted\config\service.json`
	events := make([]string, 0)
	backend := newFixtureBackend(path, []byte("config"), &events)
	policy := &fixturePolicy{events: &events, mutateRequests: true}

	result, err := readWithBackend(path, Options{MaximumBytes: 64, Policy: policy}, backend)
	if err != nil {
		t.Fatalf("readWithBackend returned an error: %v", err)
	}
	wantEvents := []string{
		`open-root:C:\`,
		`policy-ancestor:C:\`,
		`open-directory:C:\->trusted`,
		`policy-ancestor:C:\trusted`,
		`open-directory:C:\trusted->config`,
		`policy-ancestor:C:\trusted\config`,
		`open-file:C:\trusted\config->service.json`,
		`policy-file:C:\trusted\config\service.json`,
		`read-file:C:\trusted\config\service.json`,
		`verify-file:C:\trusted\config\service.json`,
		`security-file:C:\trusted\config\service.json`,
		`verify-directory:C:\trusted\config`,
		`security-directory:C:\trusted\config`,
		`verify-directory:C:\trusted`,
		`security-directory:C:\trusted`,
		`verify-directory:C:\`,
		`security-directory:C:\`,
		`close-file:C:\trusted\config\service.json`,
		`close-directory:C:\trusted\config`,
		`close-directory:C:\trusted`,
		`close-directory:C:\`,
	}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events =\n%q\nwant\n%q", events, wantEvents)
	}
	if string(result.Data) != "config" {
		t.Fatalf("data = %q", result.Data)
	}
	if result.ContentSHA256 != Digest(sha256.Sum256([]byte("config"))) {
		t.Fatalf("content digest = %s", result.ContentSHA256)
	}
	if len(result.Ancestors) != 3 || result.Ancestors[0].Path != `C:\` ||
		result.Ancestors[2].Path != `C:\trusted\config` {
		t.Fatalf("ancestors = %#v", result.Ancestors)
	}
	if result.File.Path != path || result.File.EvidenceSHA256 == (Digest{}) ||
		result.File.SecurityDescriptorSHA256 == (Digest{}) {
		t.Fatalf("file evidence is incomplete: %#v", result.File)
	}
	if result.File.Evidence.Security.SelfRelativeDescriptor[0] == 0xff {
		t.Fatal("policy mutation escaped its detached evidence request")
	}

	backend.data[0] = 'X'
	backend.file.evidence.Security.SelfRelativeDescriptor[0] = 0xee
	if string(result.Data) != "config" {
		t.Fatal("result data aliases backend storage")
	}
	if result.File.Evidence.Security.SelfRelativeDescriptor[0] == 0xee {
		t.Fatal("result evidence aliases backend storage")
	}
}

func TestReadWithBackendRejectsVolumeAndIdentityDrift(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fixtureBackend)
		want   error
	}{
		{
			name: "volume",
			mutate: func(backend *fixtureBackend) {
				backend.file.evidence.Identity.VolumeSerialNumber++
			},
			want: ErrVolumeChanged,
		},
		{
			name: "identity",
			mutate: func(backend *fixtureBackend) {
				backend.directories[1].evidence.Identity = backend.directories[0].evidence.Identity
			},
			want: ErrDuplicateIdentity,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events := make([]string, 0)
			backend := newFixtureBackend(`C:\trusted\service.json`, []byte("abc"), &events)
			test.mutate(backend)
			_, err := readWithBackend(
				`C:\trusted\service.json`,
				Options{MaximumBytes: 8, Policy: &fixturePolicy{events: &events}},
				backend,
			)
			if !errors.Is(err, test.want) {
				t.Fatalf("readWithBackend returned %v, want %v", err, test.want)
			}
			if backend.file.reads != 0 {
				t.Fatal("unsafe file was read")
			}
			for _, directory := range backend.directories {
				if directory.opens != directory.closes {
					t.Fatalf("directory %s opens=%d closes=%d", directory.path, directory.opens, directory.closes)
				}
			}
			if backend.file.opens != backend.file.closes {
				t.Fatalf("file opens=%d closes=%d", backend.file.opens, backend.file.closes)
			}
		})
	}
}

func TestReadWithBackendRejectsPolicyBeforeDescending(t *testing.T) {
	events := make([]string, 0)
	backend := newFixtureBackend(`C:\trusted\config\service.json`, []byte("abc"), &events)
	policyErr := errors.New("unexpected ACL")
	policy := &fixturePolicy{events: &events, rejectAncestor: `C:\trusted`, err: policyErr}

	_, err := readWithBackend(
		`C:\trusted\config\service.json`,
		Options{MaximumBytes: 8, Policy: policy},
		backend,
	)
	if !errors.Is(err, ErrPolicyRejected) || !errors.Is(err, policyErr) {
		t.Fatalf("readWithBackend returned %v", err)
	}
	if backend.directories[2].opens != 0 || backend.file.opens != 0 {
		t.Fatal("reader descended past a rejected ancestor")
	}
	if backend.directories[0].closes != 1 || backend.directories[1].closes != 1 {
		t.Fatal("opened ancestors were not closed")
	}
}

func TestReadWithBackendRejectsOversizeAndUnstableObjects(t *testing.T) {
	t.Run("oversize", func(t *testing.T) {
		events := make([]string, 0)
		backend := newFixtureBackend(`C:\trusted\service.json`, []byte("abc"), &events)
		_, err := readWithBackend(
			`C:\trusted\service.json`,
			Options{MaximumBytes: 2, Policy: &fixturePolicy{events: &events}},
			backend,
		)
		if !errors.Is(err, winfile.ErrTooLarge) || backend.file.reads != 0 {
			t.Fatalf("oversize read returned %v with %d reads", err, backend.file.reads)
		}
	})

	t.Run("file changed", func(t *testing.T) {
		events := make([]string, 0)
		backend := newFixtureBackend(`C:\trusted\service.json`, []byte("abc"), &events)
		backend.file.verifyErr = winfile.ErrObjectChanged
		_, err := readWithBackend(
			`C:\trusted\service.json`,
			Options{MaximumBytes: 8, Policy: &fixturePolicy{events: &events}},
			backend,
		)
		if !errors.Is(err, winfile.ErrObjectChanged) {
			t.Fatalf("unstable file returned %v", err)
		}
	})

	t.Run("ancestor changed", func(t *testing.T) {
		events := make([]string, 0)
		backend := newFixtureBackend(`C:\trusted\service.json`, []byte("abc"), &events)
		backend.directories[0].verifyErr = winfile.ErrIdentityChanged
		_, err := readWithBackend(
			`C:\trusted\service.json`,
			Options{MaximumBytes: 8, Policy: &fixturePolicy{events: &events}},
			backend,
		)
		if !errors.Is(err, winfile.ErrIdentityChanged) {
			t.Fatalf("unstable ancestor returned %v", err)
		}
	})

	t.Run("security changed", func(t *testing.T) {
		events := make([]string, 0)
		backend := newFixtureBackend(`C:\trusted\service.json`, []byte("abc"), &events)
		changed := cloneSecurityEvidence(backend.directories[1].evidence.Security)
		changed.SelfRelativeDescriptor[0]++
		backend.directories[1].securityOverride = &changed
		_, err := readWithBackend(
			`C:\trusted\service.json`,
			Options{MaximumBytes: 8, Policy: &fixturePolicy{events: &events}},
			backend,
		)
		if !errors.Is(err, ErrSecurityChanged) {
			t.Fatalf("changed security descriptor returned %v", err)
		}
	})
}

func TestReadWithBackendTreatsCloseFailureAsFatal(t *testing.T) {
	events := make([]string, 0)
	backend := newFixtureBackend(`C:\trusted\service.json`, []byte("abc"), &events)
	closeErr := errors.New("close failed")
	backend.directories[0].closeErr = closeErr

	result, err := readWithBackend(
		`C:\trusted\service.json`,
		Options{MaximumBytes: 8, Policy: &fixturePolicy{events: &events}},
		backend,
	)
	if !errors.Is(err, closeErr) {
		t.Fatalf("close failure returned %v", err)
	}
	if len(result.Data) != 0 || len(result.Ancestors) != 0 {
		t.Fatalf("close failure returned a usable result: %#v", result)
	}
}

func TestReadWithBackendValidatesOptionsBeforeOpening(t *testing.T) {
	backend := newFixtureBackend(`C:\trusted\service.json`, []byte("abc"), &[]string{})
	tests := []Options{
		{},
		{MaximumBytes: 8},
		{MaximumBytes: maximumReadableBytes() + 1, Policy: &fixturePolicy{}},
	}
	for _, options := range tests {
		if _, err := readWithBackend(`C:\trusted\service.json`, options, backend); !errors.Is(err, ErrInvalidOptions) {
			t.Fatalf("options %#v returned %v", options, err)
		}
	}
	if backend.directories[0].opens != 0 {
		t.Fatal("invalid options opened a filesystem object")
	}
}

type fixtureBackend struct {
	events      *[]string
	directories []*fixtureDirectory
	file        *fixtureFile
	data        []byte
}

func newFixtureBackend(path string, data []byte, events *[]string) *fixtureBackend {
	plan, err := planCanonicalFilePath(path)
	if err != nil {
		panic(err)
	}
	backend := &fixtureBackend{events: events, data: append([]byte(nil), data...)}
	for index, ancestor := range plan.ancestors {
		backend.directories = append(backend.directories, &fixtureDirectory{
			path:     ancestor,
			evidence: fixtureEvidence(ancestor, winfile.ObjectKindDirectory, byte(index+1), 0),
			events:   events,
		})
	}
	backend.file = &fixtureFile{
		path:     path,
		evidence: fixtureEvidence(path, winfile.ObjectKindFile, byte(len(plan.ancestors)+1), uint64(len(data))),
		data:     backend.data,
		events:   events,
	}
	return backend
}

func (backend *fixtureBackend) OpenRoot(path string) (directoryHandle, error) {
	if len(backend.directories) == 0 || backend.directories[0].path != path {
		return nil, fmt.Errorf("unexpected root %s", path)
	}
	directory := backend.directories[0]
	directory.opens++
	*backend.events = append(*backend.events, "open-root:"+path)
	return directory, nil
}

func (backend *fixtureBackend) OpenDirectory(parent directoryHandle, component string) (directoryHandle, error) {
	parentPath := parent.Evidence().Path.RequestedPath
	path := parentPath + `\` + component
	if len(parentPath) == 3 {
		path = parentPath + component
	}
	for _, directory := range backend.directories {
		if directory.path == path {
			directory.opens++
			*backend.events = append(*backend.events, "open-directory:"+parentPath+"->"+component)
			return directory, nil
		}
	}
	return nil, fmt.Errorf("unexpected directory %s", path)
}

func (backend *fixtureBackend) OpenFile(parent directoryHandle, component string) (fileHandle, error) {
	parentPath := parent.Evidence().Path.RequestedPath
	path := parentPath + `\` + component
	if len(parentPath) == 3 {
		path = parentPath + component
	}
	if backend.file.path != path {
		return nil, fmt.Errorf("unexpected file %s", path)
	}
	backend.file.opens++
	*backend.events = append(*backend.events, "open-file:"+parentPath+"->"+component)
	return backend.file, nil
}

type fixtureDirectory struct {
	path             string
	evidence         winfile.Evidence
	events           *[]string
	verifyErr        error
	closeErr         error
	securityOverride *winfile.SecurityDescriptorEvidence
	securityErr      error
	opens            int
	closes           int
}

func (directory *fixtureDirectory) Evidence() winfile.Evidence {
	return directory.evidence
}

func (directory *fixtureDirectory) VerifyUnchanged() error {
	*directory.events = append(*directory.events, "verify-directory:"+directory.path)
	return directory.verifyErr
}

func (directory *fixtureDirectory) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	*directory.events = append(*directory.events, "security-directory:"+directory.path)
	if directory.securityErr != nil {
		return winfile.SecurityDescriptorEvidence{}, directory.securityErr
	}
	if directory.securityOverride != nil {
		return cloneSecurityEvidence(*directory.securityOverride), nil
	}
	return cloneSecurityEvidence(directory.evidence.Security), nil
}

func (directory *fixtureDirectory) Close() error {
	directory.closes++
	*directory.events = append(*directory.events, "close-directory:"+directory.path)
	return directory.closeErr
}

type fixtureFile struct {
	path             string
	evidence         winfile.Evidence
	data             []byte
	events           *[]string
	verifyErr        error
	closeErr         error
	securityOverride *winfile.SecurityDescriptorEvidence
	securityErr      error
	opens            int
	closes           int
	reads            int
}

func (file *fixtureFile) Evidence() winfile.Evidence {
	return file.evidence
}

func (file *fixtureFile) ReadAll(uint64) ([]byte, error) {
	file.reads++
	*file.events = append(*file.events, "read-file:"+file.path)
	return file.data, nil
}

func (file *fixtureFile) VerifyUnchanged() error {
	*file.events = append(*file.events, "verify-file:"+file.path)
	return file.verifyErr
}

func (file *fixtureFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	*file.events = append(*file.events, "security-file:"+file.path)
	if file.securityErr != nil {
		return winfile.SecurityDescriptorEvidence{}, file.securityErr
	}
	if file.securityOverride != nil {
		return cloneSecurityEvidence(*file.securityOverride), nil
	}
	return cloneSecurityEvidence(file.evidence.Security), nil
}

func (file *fixtureFile) Close() error {
	file.closes++
	*file.events = append(*file.events, "close-file:"+file.path)
	return file.closeErr
}

type fixturePolicy struct {
	events         *[]string
	rejectAncestor string
	err            error
	mutateRequests bool
}

func (policy *fixturePolicy) CheckAncestor(request AncestorSecurityRequest) error {
	if policy.events != nil {
		*policy.events = append(*policy.events, "policy-ancestor:"+request.Object.Path)
	}
	if policy.mutateRequests {
		request.Object.Evidence.Security.SelfRelativeDescriptor[0] = 0xff
	}
	if request.Object.Path == policy.rejectAncestor {
		return policy.err
	}
	return nil
}

func (policy *fixturePolicy) CheckFile(request FileSecurityRequest) error {
	if policy.events != nil {
		*policy.events = append(*policy.events, "policy-file:"+request.Object.Path)
	}
	if policy.mutateRequests {
		request.Object.Evidence.Security.SelfRelativeDescriptor[0] = 0xff
	}
	return nil
}

func fixtureEvidence(path string, kind winfile.ObjectKind, identityByte byte, size uint64) winfile.Evidence {
	attributes := uint32(0x20)
	linkCount := uint32(1)
	if kind == winfile.ObjectKindDirectory {
		attributes = 0x10
		linkCount = 7
	}
	fileID := [16]byte{}
	fileID[0] = identityByte
	return winfile.Evidence{
		Kind:       kind,
		Identity:   winfile.FileIdentity{VolumeSerialNumber: 0x1020304050607080, FileID: fileID},
		Attributes: attributes,
		Size:       size,
		LinkCount:  linkCount,
		Path: winfile.PathEvidence{
			RequestedPath:                path,
			TerminalComponentReparseFree: true,
			Ancestors:                    winfile.AncestorValidationNotPerformed,
		},
		Volume: winfile.VolumeEvidence{
			FileSystem:             "NTFS",
			FileSystemFlags:        0x00000008,
			HandleSerialNumber:     0x12345678,
			PathSerialNumber:       0x12345678,
			VolumePath:             `C:\`,
			DriveType:              driveTypeFixed,
			PersistentACLs:         true,
			RequiredUse:            winfile.VolumeUseReadOnly,
			PathIdentityCrossCheck: true,
		},
		Security: winfile.SecurityDescriptorEvidence{
			OwnerSID:               "S-1-5-18",
			GroupSID:               "S-1-5-32-544",
			DACLPresent:            true,
			DACLProtected:          true,
			Control:                securityDACLPresent | securityDACLProtected | securityDescriptorRelative,
			Revision:               1,
			SelfRelativeDescriptor: []byte{identityByte, 2, 3, 4},
		},
	}
}
