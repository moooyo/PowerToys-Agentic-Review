//go:build windows

package servicebootstrap

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"golang.org/x/sys/windows"
)

const (
	wrapperProcessOpenAccess = uint32(
		windows.PROCESS_QUERY_LIMITED_INFORMATION |
			windows.SYNCHRONIZE |
			windows.READ_CONTROL |
			windows.WRITE_DAC,
	)
	currentTokenOpenAccess = uint32(
		windows.TOKEN_QUERY |
			windows.READ_CONTROL |
			windows.WRITE_DAC,
	)
	stillActiveExitCode   = uint32(259)
	processWaitPoll       = 100 * time.Millisecond
	initialImagePathUnits = uint32(512)
	maximumImagePathUnits = uint32(32_768)
)

// Open atomically bootstraps the current ServiceHost and its WinSW wrapper.
func Open(options Options) (Session, error) {
	return productionBootstrapGate.open(options, windowsBootstrapPlatform{})
}

type windowsBootstrapPlatform struct{}

func (windowsBootstrapPlatform) OpenSCMService(name string) (scmStatusSource, error) {
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, fmt.Errorf("encode WinSW service name: %w", err)
	}
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, fmt.Errorf("OpenSCManagerW: %w", err)
	}
	service, err := windows.OpenService(manager, namePointer, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		closeErr := closeRejectedWindowsServiceHandle("close rejected SCM manager", manager)
		return nil, errors.Join(fmt.Errorf("OpenServiceW: %w", err), closeErr)
	}
	return &windowsSCMService{manager: manager, service: service}, nil
}

func (windowsBootstrapPlatform) OpenWrapperProcess(processID uint32) (wrapperProcess, error) {
	handle, err := windows.OpenProcess(wrapperProcessOpenAccess, false, processID)
	if err != nil {
		return nil, err
	}
	if handle == 0 {
		return nil, errors.New("OpenProcess returned a null WinSW wrapper handle")
	}
	return &windowsWrapperProcess{handle: handle}, nil
}

func (windowsBootstrapPlatform) CurrentProcess() (currentProcess, error) {
	handle := windows.CurrentProcess()
	if handle == 0 {
		return nil, errors.New("GetCurrentProcess returned a null pseudo-handle")
	}
	return windowsCurrentProcess{handle: handle}, nil
}

func (windowsBootstrapPlatform) OpenCurrentPrimaryToken() (primaryToken, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), currentTokenOpenAccess, &token); err != nil {
		return nil, err
	}
	if token == 0 {
		return nil, errors.New("OpenProcessToken returned a null handle")
	}
	result := &windowsPrimaryToken{handle: windows.Handle(token)}
	var tokenType uint32
	var returnedLength uint32
	if err := windows.GetTokenInformation(
		token,
		windows.TokenType,
		(*byte)(unsafe.Pointer(&tokenType)),
		uint32(unsafe.Sizeof(tokenType)),
		&returnedLength,
	); err != nil {
		return nil, errors.Join(
			fmt.Errorf("query current ServiceHost token type: %w", err),
			closeRejectedResource("close rejected current ServiceHost token", result),
		)
	}
	if returnedLength != uint32(unsafe.Sizeof(tokenType)) || tokenType != windows.TokenPrimary {
		return nil, errors.Join(
			fmt.Errorf("current ServiceHost token type is %d with length %d, want primary", tokenType, returnedLength),
			closeRejectedResource("close rejected current ServiceHost token", result),
		)
	}
	return result, nil
}

type windowsSCMService struct {
	mu       sync.Mutex
	manager  windows.Handle
	service  windows.Handle
	closeSCM func(windows.Handle) error
}

func (s *windowsSCMService) Status() (ServiceObservation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.service == 0 {
		return ServiceObservation{}, ErrClosed
	}
	status := windows.SERVICE_STATUS_PROCESS{}
	var bytesNeeded uint32
	if err := windows.QueryServiceStatusEx(
		s.service,
		windows.SC_STATUS_PROCESS_INFO,
		(*byte)(unsafe.Pointer(&status)),
		uint32(unsafe.Sizeof(status)),
		&bytesNeeded,
	); err != nil {
		return ServiceObservation{}, err
	}
	return ServiceObservation{
		State:     ServiceState(status.CurrentState),
		ProcessID: status.ProcessId,
	}, nil
}

func (s *windowsSCMService) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	closeSCM := s.closeSCM
	if closeSCM == nil {
		closeSCM = windows.CloseServiceHandle
	}
	var serviceErr error
	if s.service != 0 {
		if err := closeSCM(s.service); err != nil {
			serviceErr = fmt.Errorf("close WinSW service status handle: %w", err)
		} else {
			s.service = 0
		}
	}
	var managerErr error
	if s.manager != 0 {
		if err := closeSCM(s.manager); err != nil {
			managerErr = fmt.Errorf("close SCM manager handle: %w", err)
		} else {
			s.manager = 0
		}
	}
	return errors.Join(serviceErr, managerErr)
}

type windowsCurrentProcess struct {
	handle windows.Handle
}

func (p windowsCurrentProcess) HandleProcessID() (uint32, error) {
	return windows.GetProcessId(p.handle)
}

func (p windowsCurrentProcess) StillActive() (bool, error) {
	return windowsProcessStillActive(p.handle)
}

func (p windowsCurrentProcess) HandleCreationTime() (time.Time, error) {
	return queryWindowsProcessCreationTime(p.handle)
}

func (p windowsCurrentProcess) HandleStartKey() (peerverify.ProcessStartKey, error) {
	return queryWindowsProcessStartKey(p.handle)
}

func (p windowsCurrentProcess) DirectParentProcessID() (uint32, error) {
	return queryWindowsDirectParentProcessID(p.handle)
}

func (p windowsCurrentProcess) ApplyAndVerifyDACL(policy daclPolicy) (DACLEvidence, error) {
	return setAndReadBackWindowsDACL(p.handle, policy)
}

type windowsPrimaryToken struct {
	mu          sync.Mutex
	handle      windows.Handle
	closeHandle func(windows.Handle) error
}

func (t *windowsPrimaryToken) ApplyAndVerifyDACL(policy daclPolicy) (DACLEvidence, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.handle == 0 {
		return DACLEvidence{}, ErrClosed
	}
	return setAndReadBackWindowsDACL(t.handle, policy)
}

func (t *windowsPrimaryToken) Close() error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.handle == 0 {
		return nil
	}
	closeHandle := t.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	if err := closeHandle(t.handle); err != nil {
		return fmt.Errorf("CloseHandle primary token: %w", err)
	}
	t.handle = 0
	return nil
}

type windowsWrapperProcess struct {
	mu          sync.Mutex
	handle      windows.Handle
	closeHandle func(windows.Handle) error
}

func (p *windowsWrapperProcess) HandleProcessID() (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return 0, ErrClosed
	}
	return windows.GetProcessId(p.handle)
}

func (p *windowsWrapperProcess) StillActive() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return false, ErrClosed
	}
	return windowsProcessStillActive(p.handle)
}

func (p *windowsWrapperProcess) HandleCreationTime() (time.Time, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return time.Time{}, ErrClosed
	}
	return queryWindowsProcessCreationTime(p.handle)
}

func (p *windowsWrapperProcess) HandleStartKey() (peerverify.ProcessStartKey, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return peerverify.ProcessStartKey{}, ErrClosed
	}
	return queryWindowsProcessStartKey(p.handle)
}

func (p *windowsWrapperProcess) ApplyAndVerifyDACL(policy daclPolicy) (DACLEvidence, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return DACLEvidence{}, ErrClosed
	}
	return setAndReadBackWindowsDACL(p.handle, policy)
}

func (p *windowsWrapperProcess) ImagePathDiagnostic() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return "", ErrClosed
	}
	return queryWindowsProcessImagePath(p.handle)
}

func (p *windowsWrapperProcess) OpenImage() (peerverify.ImageSubject, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return nil, ErrClosed
	}
	path, err := queryWindowsProcessImagePath(p.handle)
	if err != nil {
		return nil, err
	}
	return openWindowsImage(path)
}

func (p *windowsWrapperProcess) Wait(ctx context.Context) error {
	if ctx == nil {
		return errors.New("wrapper wait context is required")
	}
	for {
		p.mu.Lock()
		if p.handle == 0 {
			p.mu.Unlock()
			return ErrClosed
		}
		status, err := windows.WaitForSingleObject(p.handle, uint32(processWaitPoll/time.Millisecond))
		p.mu.Unlock()
		if err != nil {
			return fmt.Errorf("wait for retained WinSW wrapper process: %w", err)
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			return nil
		case uint32(windows.WAIT_TIMEOUT):
			if err := ctx.Err(); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unexpected WinSW wrapper wait status 0x%x", status)
		}
	}
}

func (p *windowsWrapperProcess) Close() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return nil
	}
	closeHandle := p.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	if err := closeHandle(p.handle); err != nil {
		return fmt.Errorf("CloseHandle retained WinSW wrapper process: %w", err)
	}
	p.handle = 0
	return nil
}

func windowsProcessStillActive(handle windows.Handle) (bool, error) {
	status, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return false, nil
	case uint32(windows.WAIT_TIMEOUT):
		var exitCode uint32
		if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
			return false, err
		}
		return exitCode == stillActiveExitCode, nil
	default:
		return false, fmt.Errorf("unexpected process wait status 0x%x", status)
	}
}

func queryWindowsProcessCreationTime(handle windows.Handle) (time.Time, error) {
	var created windows.Filetime
	var exited windows.Filetime
	var kernel windows.Filetime
	var user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return time.Time{}, err
	}
	return time.Unix(0, created.Nanoseconds()).UTC(), nil
}

func queryWindowsProcessStartKey(handle windows.Handle) (peerverify.ProcessStartKey, error) {
	var sequenceNumber uint64
	err := windows.NtQueryInformationProcess(
		handle,
		windows.ProcessSequenceNumber,
		unsafe.Pointer(&sequenceNumber),
		uint32(unsafe.Sizeof(sequenceNumber)),
		nil,
	)
	if errors.Is(err, windows.STATUS_INVALID_INFO_CLASS) || errors.Is(err, windows.STATUS_NOT_SUPPORTED) {
		return peerverify.ProcessStartKey{}, nil
	}
	if err != nil {
		return peerverify.ProcessStartKey{}, err
	}
	if sequenceNumber == 0 {
		return peerverify.ProcessStartKey{}, errors.New("ProcessSequenceNumber returned zero")
	}
	return peerverify.ProcessStartKey{Available: true, SequenceNumber: sequenceNumber}, nil
}

func queryWindowsDirectParentProcessID(handle windows.Handle) (uint32, error) {
	information := windows.PROCESS_BASIC_INFORMATION{}
	informationSize := uint32(unsafe.Sizeof(information))
	var returnedSize uint32
	if err := windows.NtQueryInformationProcess(
		handle,
		windows.ProcessBasicInformation,
		unsafe.Pointer(&information),
		informationSize,
		&returnedSize,
	); err != nil {
		return 0, err
	}
	if returnedSize != informationSize {
		return 0, fmt.Errorf("NtQueryInformationProcess returned %d bytes, expected %d", returnedSize, informationSize)
	}
	parent := information.InheritedFromUniqueProcessId
	if parent == 0 || uint64(parent) > uint64(^uint32(0)) {
		return 0, fmt.Errorf("NtQueryInformationProcess returned invalid parent PID %d", parent)
	}
	return uint32(parent), nil
}

func queryWindowsProcessImagePath(handle windows.Handle) (string, error) {
	for units := initialImagePathUnits; units <= maximumImagePathUnits; units *= 2 {
		buffer := make([]uint16, units)
		length := units
		err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &length)
		if err == nil {
			if length == 0 || length >= units {
				return "", fmt.Errorf("QueryFullProcessImageNameW returned invalid length %d", length)
			}
			return windows.UTF16ToString(buffer[:length]), nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return "", err
		}
		if units > maximumImagePathUnits/2 {
			break
		}
	}
	return "", fmt.Errorf("QueryFullProcessImageNameW exceeded %d UTF-16 units", maximumImagePathUnits)
}

func setAndReadBackWindowsDACL(handle windows.Handle, policy daclPolicy) (DACLEvidence, error) {
	acl, err := buildWindowsACL(policy)
	if err != nil {
		return DACLEvidence{}, err
	}
	securityInformation := windows.SECURITY_INFORMATION(
		windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION,
	)
	if err := windows.SetSecurityInfo(
		handle,
		windows.SE_KERNEL_OBJECT,
		securityInformation,
		nil,
		nil,
		acl,
		nil,
	); err != nil {
		return DACLEvidence{}, fmt.Errorf("SetSecurityInfo protected DACL: %w", err)
	}
	runtime.KeepAlive(acl)
	return readWindowsDACL(handle)
}

func buildWindowsACL(policy daclPolicy) (*windows.ACL, error) {
	explicitEntries := make([]windows.EXPLICIT_ACCESS, len(policy.entries))
	sids := make([]*windows.SID, len(policy.entries))
	for index, policyEntry := range policy.entries {
		sid, err := windows.StringToSid(policyEntry.SID)
		if err != nil || sid == nil || !sid.IsValid() || sid.String() != policyEntry.SID {
			return nil, fmt.Errorf("Windows rejected canonical SID %s", policyEntry.SID)
		}
		sids[index] = sid
		explicitEntries[index] = windows.EXPLICIT_ACCESS{
			AccessPermissions: windows.ACCESS_MASK(policyEntry.Mask),
			AccessMode:        windows.SET_ACCESS,
			Inheritance:       windows.NO_INHERITANCE,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_UNKNOWN,
				TrusteeValue: windows.TrusteeValueFromSID(sid),
			},
		}
	}
	acl, err := windows.ACLFromEntries(explicitEntries, nil)
	runtime.KeepAlive(sids)
	if err != nil {
		return nil, err
	}
	return acl, nil
}

func readWindowsDACL(handle windows.Handle) (DACLEvidence, error) {
	descriptor, err := windows.GetSecurityInfo(
		handle,
		windows.SE_KERNEL_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return DACLEvidence{}, fmt.Errorf("GetSecurityInfo DACL: %w", err)
	}
	if descriptor == nil || !descriptor.IsValid() {
		return DACLEvidence{}, errors.New("GetSecurityInfo returned a missing or invalid descriptor")
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return DACLEvidence{}, fmt.Errorf("read security descriptor control: %w", err)
	}
	evidence := DACLEvidence{
		Control:   uint16(control),
		Present:   control&windows.SE_DACL_PRESENT != 0,
		Protected: control&windows.SE_DACL_PROTECTED != 0,
	}
	dacl, defaulted, err := descriptor.DACL()
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return evidence, nil
	}
	if err != nil {
		return DACLEvidence{}, fmt.Errorf("read security descriptor DACL: %w", err)
	}
	evidence.Null = dacl == nil
	evidence.Defaulted = defaulted
	if dacl != nil {
		evidence.AccessRules = make([]AccessEntry, 0, int(dacl.AceCount))
		for index := uint32(0); index < uint32(dacl.AceCount); index++ {
			entry, err := readWindowsAllowedACE(dacl, index)
			if err != nil {
				return DACLEvidence{}, err
			}
			evidence.AccessRules = append(evidence.AccessRules, entry)
		}
	}
	runtime.KeepAlive(descriptor)
	return evidence, nil
}

func readWindowsAllowedACE(acl *windows.ACL, index uint32) (AccessEntry, error) {
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(acl, index, &ace); err != nil {
		return AccessEntry{}, fmt.Errorf("read DACL ACE %d: %w", index, err)
	}
	if ace == nil {
		return AccessEntry{}, fmt.Errorf("DACL ACE %d is null", index)
	}
	sidOffset := int(unsafe.Offsetof(ace.SidStart))
	if int(ace.Header.AceSize) < sidOffset+8 {
		return AccessEntry{}, fmt.Errorf("DACL ACE %d is too small for a SID", index)
	}
	sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if !sid.IsValid() || sid.String() == "" {
		return AccessEntry{}, fmt.Errorf("DACL ACE %d contains an invalid SID", index)
	}
	if int(ace.Header.AceSize) != sidOffset+sid.Len() {
		return AccessEntry{}, fmt.Errorf("DACL ACE %d has a noncanonical size", index)
	}
	return AccessEntry{
		SID:     sid.String(),
		Mask:    uint32(ace.Mask),
		ACEType: ace.Header.AceType,
		Flags:   ace.Header.AceFlags,
	}, nil
}

func closeRejectedWindowsServiceHandle(label string, handle windows.Handle) error {
	if handle == 0 {
		return nil
	}
	var failures []error
	for attempt := 1; attempt <= rejectedResourceCloseAttempts; attempt++ {
		if err := windows.CloseServiceHandle(handle); err != nil {
			failures = append(failures, fmt.Errorf("%s attempt %d: %w", label, attempt, err))
			continue
		}
		return errors.Join(failures...)
	}
	return errors.Join(failures...)
}

var (
	_ bootstrapPlatform = windowsBootstrapPlatform{}
	_ scmStatusSource   = (*windowsSCMService)(nil)
	_ currentProcess    = windowsCurrentProcess{}
	_ primaryToken      = (*windowsPrimaryToken)(nil)
	_ wrapperProcess    = (*windowsWrapperProcess)(nil)
)
