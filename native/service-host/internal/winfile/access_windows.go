//go:build windows

package winfile

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	advapi32DLL     = windows.NewLazySystemDLL("advapi32.dll")
	procAccessCheck = advapi32DLL.NewProc("AccessCheck")
)

type stableAccessTokenState struct {
	mu     sync.Mutex
	token  windows.Token
	closed bool
}

type nativeGenericMapping struct {
	GenericRead    uint32
	GenericWrite   uint32
	GenericExecute uint32
	GenericAll     uint32
}

// NewStableAccessToken immediately duplicates source as an independently
// owned SecurityImpersonation token with TOKEN_QUERY and TOKEN_DUPLICATE. The
// source handle is borrowed only for this call and is never retained.
func NewStableAccessToken(source windows.Token) (*StableAccessToken, error) {
	if source == 0 {
		return nil, fmt.Errorf("%w: source token is required", ErrAccessCheck)
	}
	duplicate, err := duplicateImpersonationToken(source)
	if err != nil {
		return nil, err
	}
	return &StableAccessToken{state: &stableAccessTokenState{token: duplicate}}, nil
}

// Duplicate returns another independently owned impersonation-token handle.
func (token *StableAccessToken) Duplicate() (*StableAccessToken, error) {
	if token == nil || token.state == nil {
		return nil, ErrAccessTokenClosed
	}
	token.state.mu.Lock()
	defer token.state.mu.Unlock()
	if token.state.closed || token.state.token == 0 {
		return nil, ErrAccessTokenClosed
	}
	duplicate, err := duplicateImpersonationToken(token.state.token)
	if err != nil {
		return nil, err
	}
	return &StableAccessToken{state: &stableAccessTokenState{token: duplicate}}, nil
}

// CheckAccess evaluates the retained token with Windows AccessCheck.
func (token *StableAccessToken) CheckAccess(
	security SecurityDescriptorEvidence,
	desiredAccess AccessMask,
	mapping GenericMapping,
) (AccessCheckDecision, error) {
	if err := validateAccessEvaluation(security, desiredAccess, mapping); err != nil {
		return AccessCheckDecision{}, err
	}
	if token == nil || token.state == nil {
		return AccessCheckDecision{}, ErrAccessTokenClosed
	}
	token.state.mu.Lock()
	defer token.state.mu.Unlock()
	if token.state.closed || token.state.token == 0 {
		return AccessCheckDecision{}, ErrAccessTokenClosed
	}
	return checkAccessWithToken(token.state.token, security, desiredAccess, mapping)
}

// Close permanently releases the owned token handle. It is idempotent.
func (token *StableAccessToken) Close() error {
	if token == nil || token.state == nil {
		return nil
	}
	token.state.mu.Lock()
	defer token.state.mu.Unlock()
	if token.state.closed || token.state.token == 0 {
		token.state.closed = true
		return nil
	}
	token.state.closed = true
	handle := token.state.token
	token.state.token = 0
	if err := handle.Close(); err != nil {
		return fmt.Errorf("close stable access token: %w", err)
	}
	return nil
}

func duplicateImpersonationToken(source windows.Token) (windows.Token, error) {
	var duplicate windows.Token
	if err := windows.DuplicateTokenEx(
		source,
		windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE,
		nil,
		windows.SecurityImpersonation,
		windows.TokenImpersonation,
		&duplicate,
	); err != nil {
		return 0, fmt.Errorf("%w: duplicate impersonation token: %v", ErrAccessCheck, err)
	}
	if err := validateImpersonationToken(duplicate); err != nil {
		return 0, errors.Join(err, duplicate.Close())
	}
	return duplicate, nil
}

func checkAccessWithToken(
	token windows.Token,
	security SecurityDescriptorEvidence,
	desired AccessMask,
	mapping GenericMapping,
) (AccessCheckDecision, error) {
	descriptorBytes := append([]byte(nil), security.SelfRelativeDescriptor...)
	descriptor := (*windows.SECURITY_DESCRIPTOR)(unsafe.Pointer(&descriptorBytes[0]))
	if !descriptor.IsValid() || descriptor.Length() != uint32(len(descriptorBytes)) {
		return AccessCheckDecision{}, fmt.Errorf("%w: self-relative security descriptor is invalid", ErrAccessCheck)
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return AccessCheckDecision{}, fmt.Errorf("%w: read security descriptor control: %v", ErrAccessCheck, err)
	}
	requiredControl := windows.SECURITY_DESCRIPTOR_CONTROL(
		windows.SE_DACL_PRESENT | windows.SE_DACL_PROTECTED | windows.SE_SELF_RELATIVE,
	)
	if control&requiredControl != requiredControl {
		return AccessCheckDecision{}, fmt.Errorf("%w: security descriptor lacks a protected DACL", ErrAccessCheck)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil {
		return AccessCheckDecision{}, fmt.Errorf("%w: security descriptor has no usable DACL", ErrAccessCheck)
	}

	nativeMapping := nativeGenericMapping{
		GenericRead:    uint32(mapping.Read),
		GenericWrite:   uint32(mapping.Write),
		GenericExecute: uint32(mapping.Execute),
		GenericAll:     uint32(mapping.All),
	}
	desiredAccess := uint32(mapRequestedAccess(desired, mapping))
	if AccessMask(desiredAccess)&genericRightsMask != 0 {
		return AccessCheckDecision{}, fmt.Errorf("%w: generic rights remain after mapping", ErrAccessCheck)
	}

	privilegeBytes := 1_024
	for privilegeBytes <= maximumPrivilegeBytes {
		buffer := make([]byte, privilegeBytes)
		bufferLength := uint32(len(buffer))
		var grantedAccess uint32
		var accessStatus int32
		result, _, callErr := procAccessCheck.Call(
			uintptr(unsafe.Pointer(descriptor)),
			uintptr(token),
			uintptr(desiredAccess),
			uintptr(unsafe.Pointer(&nativeMapping)),
			uintptr(unsafe.Pointer(&buffer[0])),
			uintptr(unsafe.Pointer(&bufferLength)),
			uintptr(unsafe.Pointer(&grantedAccess)),
			uintptr(unsafe.Pointer(&accessStatus)),
		)
		runtime.KeepAlive(descriptorBytes)
		runtime.KeepAlive(buffer)
		if result != 0 {
			return AccessCheckDecision{
				Allowed:       accessStatus != 0,
				GrantedAccess: AccessMask(grantedAccess),
			}, nil
		}
		if !errors.Is(callErr, windows.ERROR_INSUFFICIENT_BUFFER) {
			return AccessCheckDecision{}, fmt.Errorf("%w: AccessCheck: %v", ErrAccessCheck, callErr)
		}
		if bufferLength <= uint32(privilegeBytes) || bufferLength > maximumPrivilegeBytes {
			return AccessCheckDecision{}, fmt.Errorf("%w: invalid privilege-set size %d", ErrAccessCheck, bufferLength)
		}
		privilegeBytes = int(bufferLength)
	}
	return AccessCheckDecision{}, fmt.Errorf("%w: privilege set exceeds %d bytes", ErrAccessCheck, maximumPrivilegeBytes)
}

func validateImpersonationToken(token windows.Token) error {
	var tokenType uint32
	var returned uint32
	if err := windows.GetTokenInformation(
		token,
		windows.TokenType,
		(*byte)(unsafe.Pointer(&tokenType)),
		uint32(unsafe.Sizeof(tokenType)),
		&returned,
	); err != nil {
		return fmt.Errorf("%w: query token type: %v", ErrAccessCheck, err)
	}
	if returned != uint32(unsafe.Sizeof(tokenType)) || tokenType != windows.TokenImpersonation {
		return fmt.Errorf("%w: AccessCheck requires an impersonation token", ErrAccessCheck)
	}
	var level uint32
	if err := windows.GetTokenInformation(
		token,
		windows.TokenImpersonationLevel,
		(*byte)(unsafe.Pointer(&level)),
		uint32(unsafe.Sizeof(level)),
		&returned,
	); err != nil {
		return fmt.Errorf("%w: query token impersonation level: %v", ErrAccessCheck, err)
	}
	if returned != uint32(unsafe.Sizeof(level)) || level < uint32(windows.SecurityIdentification) ||
		level > uint32(windows.SecurityDelegation) {
		return fmt.Errorf("%w: token impersonation level is unsupported", ErrAccessCheck)
	}
	return nil
}
