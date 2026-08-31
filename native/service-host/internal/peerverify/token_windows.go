//go:build windows

package peerverify

import (
	"errors"
	"fmt"
	"runtime"
	"sort"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	maximumTokenInformationBytes    = uint32(1024 * 1024)
	maximumTokenEntries             = uint32(4096)
	maximumTokenInformationAttempts = 3
	maximumTokenSIDBytes            = 68
	minimumTokenSIDBytes            = 8
	maximumPrivilegeNameUnits       = uint32(256)
	tokenStatisticsSize             = 56
)

type nativeTokenStatistics struct {
	TokenID            windows.LUID
	AuthenticationID   windows.LUID
	ExpirationTime     int64
	TokenType          uint32
	ImpersonationLevel uint32
	DynamicCharged     uint32
	DynamicAvailable   uint32
	GroupCount         uint32
	PrivilegeCount     uint32
	ModifiedID         windows.LUID
}

var (
	_ [tokenStatisticsSize - unsafe.Sizeof(nativeTokenStatistics{})]byte
	_ [unsafe.Sizeof(nativeTokenStatistics{}) - tokenStatisticsSize]byte

	peerIdentityAdvapi32     = windows.NewLazySystemDLL("advapi32.dll")
	peerLookupPrivilegeNameW = peerIdentityAdvapi32.NewProc("LookupPrivilegeNameW")
)

func queryWindowsTokenSnapshot(token windows.Token) (TokenSnapshot, error) {
	if err := peerLookupPrivilegeNameW.Find(); err != nil {
		return TokenSnapshot{}, fmt.Errorf("resolve LookupPrivilegeNameW: %w", err)
	}
	before, err := queryWindowsTokenStatistics(token)
	if err != nil {
		return TokenSnapshot{}, fmt.Errorf("read initial TokenStatistics: %w", err)
	}
	userBuffer, err := queryWindowsTokenInformation(token, windows.TokenUser, "TokenUser")
	if err != nil {
		return TokenSnapshot{}, err
	}
	user, err := parseWindowsTokenUser(userBuffer)
	if err != nil {
		return TokenSnapshot{}, fmt.Errorf("parse TokenUser: %w", err)
	}
	groupBuffer, err := queryWindowsTokenInformation(token, windows.TokenGroups, "TokenGroups")
	if err != nil {
		return TokenSnapshot{}, err
	}
	groups, err := parseWindowsTokenSIDEntries(groupBuffer, "TokenGroups")
	if err != nil {
		return TokenSnapshot{}, err
	}
	restrictedBuffer, err := queryWindowsTokenInformation(token, windows.TokenRestrictedSids, "TokenRestrictedSids")
	if err != nil {
		return TokenSnapshot{}, err
	}
	restrictedSIDs, err := parseWindowsTokenSIDEntries(restrictedBuffer, "TokenRestrictedSids")
	if err != nil {
		return TokenSnapshot{}, err
	}
	privilegeBuffer, err := queryWindowsTokenInformation(token, windows.TokenPrivileges, "TokenPrivileges")
	if err != nil {
		return TokenSnapshot{}, err
	}
	privileges, err := parseWindowsTokenPrivileges(privilegeBuffer)
	if err != nil {
		return TokenSnapshot{}, err
	}
	hasRestrictions, err := queryWindowsTokenUint32(token, windows.TokenHasRestrictions, "TokenHasRestrictions")
	if err != nil {
		return TokenSnapshot{}, err
	}
	after, err := queryWindowsTokenStatistics(token)
	if err != nil {
		return TokenSnapshot{}, fmt.Errorf("read final TokenStatistics: %w", err)
	}
	if before != after {
		return TokenSnapshot{}, fmt.Errorf("%w: native TokenStatistics changed during inspection", ErrPeerUnstable)
	}

	return TokenSnapshot{
		StatisticsBefore: detachTokenStatistics(before),
		StatisticsAfter:  detachTokenStatistics(after),
		HasRestrictions:  hasRestrictions != 0,
		User:             user,
		Groups:           groups,
		RestrictedSIDs:   restrictedSIDs,
		Privileges:       privileges,
	}, nil
}

func queryWindowsTokenStatistics(token windows.Token) (nativeTokenStatistics, error) {
	statistics := nativeTokenStatistics{}
	bufferSize := uint32(unsafe.Sizeof(statistics))
	var returnedSize uint32
	if err := windows.GetTokenInformation(
		token,
		windows.TokenStatistics,
		(*byte)(unsafe.Pointer(&statistics)),
		bufferSize,
		&returnedSize,
	); err != nil {
		return nativeTokenStatistics{}, err
	}
	if returnedSize != bufferSize {
		return nativeTokenStatistics{}, fmt.Errorf("TokenStatistics returned %d bytes, want %d", returnedSize, bufferSize)
	}
	return statistics, nil
}

func detachTokenStatistics(statistics nativeTokenStatistics) TokenStatistics {
	return TokenStatistics{
		TokenID:            detachWindowsLUID(statistics.TokenID),
		AuthenticationID:   detachWindowsLUID(statistics.AuthenticationID),
		ModifiedID:         detachWindowsLUID(statistics.ModifiedID),
		Type:               statistics.TokenType,
		ImpersonationLevel: statistics.ImpersonationLevel,
		GroupCount:         statistics.GroupCount,
		PrivilegeCount:     statistics.PrivilegeCount,
	}
}

func queryWindowsTokenUint32(token windows.Token, class uint32, description string) (uint32, error) {
	var value uint32
	bufferSize := uint32(unsafe.Sizeof(value))
	var returnedSize uint32
	if err := windows.GetTokenInformation(
		token,
		class,
		(*byte)(unsafe.Pointer(&value)),
		bufferSize,
		&returnedSize,
	); err != nil {
		return 0, fmt.Errorf("query %s: %w", description, err)
	}
	if returnedSize != bufferSize {
		return 0, fmt.Errorf("%s returned %d bytes, want %d", description, returnedSize, bufferSize)
	}
	return value, nil
}

func queryWindowsTokenInformation(token windows.Token, class uint32, description string) ([]byte, error) {
	var requiredSize uint32
	err := windows.GetTokenInformation(token, class, nil, 0, &requiredSize)
	if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
		if err == nil {
			return nil, fmt.Errorf("%s size query unexpectedly succeeded", description)
		}
		return nil, fmt.Errorf("query %s size: %w", description, err)
	}
	if requiredSize == 0 || requiredSize > maximumTokenInformationBytes {
		return nil, fmt.Errorf("%w: %s requires invalid size %d", ErrTokenMismatch, description, requiredSize)
	}
	for attempt := 0; attempt < maximumTokenInformationAttempts; attempt++ {
		buffer := make([]byte, requiredSize)
		var returnedSize uint32
		err = windows.GetTokenInformation(token, class, &buffer[0], uint32(len(buffer)), &returnedSize)
		if err == nil {
			if returnedSize == 0 || returnedSize > uint32(len(buffer)) {
				return nil, fmt.Errorf("%w: %s returned invalid size %d", ErrTokenMismatch, description, returnedSize)
			}
			return buffer[:returnedSize], nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return nil, fmt.Errorf("query %s: %w", description, err)
		}
		if returnedSize <= uint32(len(buffer)) || returnedSize > maximumTokenInformationBytes {
			return nil, fmt.Errorf("%w: %s changed to invalid size %d", ErrPeerUnstable, description, returnedSize)
		}
		requiredSize = returnedSize
	}
	return nil, fmt.Errorf("%w: %s changed size repeatedly", ErrPeerUnstable, description)
}

func parseWindowsTokenUser(buffer []byte) (SIDAttributes, error) {
	if uintptr(len(buffer)) < unsafe.Sizeof(windows.Tokenuser{}) {
		return SIDAttributes{}, errors.New("TokenUser buffer is too small")
	}
	user := (*windows.Tokenuser)(unsafe.Pointer(&buffer[0]))
	sid, err := tokenSIDStringWithinBuffer(user.User.Sid, buffer)
	if err != nil {
		return SIDAttributes{}, err
	}
	entry := SIDAttributes{SID: sid, Attributes: user.User.Attributes}
	runtime.KeepAlive(buffer)
	return entry, nil
}

func parseWindowsTokenSIDEntries(buffer []byte, description string) ([]SIDAttributes, error) {
	headerSize := unsafe.Offsetof(windows.Tokengroups{}.Groups)
	if uintptr(len(buffer)) < headerSize {
		return nil, fmt.Errorf("%w: %s buffer is smaller than its header", ErrTokenMismatch, description)
	}
	count := *(*uint32)(unsafe.Pointer(&buffer[0]))
	if count > maximumTokenEntries {
		return nil, fmt.Errorf("%w: %s contains %d entries", ErrTokenMismatch, description, count)
	}
	entrySize := unsafe.Sizeof(windows.SIDAndAttributes{})
	if headerSize+uintptr(count)*entrySize > uintptr(len(buffer)) {
		return nil, fmt.Errorf("%w: %s entry array exceeds its buffer", ErrTokenMismatch, description)
	}
	result := make([]SIDAttributes, 0, count)
	if count != 0 {
		first := (*windows.SIDAndAttributes)(unsafe.Add(unsafe.Pointer(&buffer[0]), headerSize))
		for _, nativeEntry := range unsafe.Slice(first, int(count)) {
			sid, err := tokenSIDStringWithinBuffer(nativeEntry.Sid, buffer)
			if err != nil {
				return nil, fmt.Errorf("%s SID: %w", description, err)
			}
			result = append(result, SIDAttributes{SID: sid, Attributes: nativeEntry.Attributes})
		}
	}
	runtime.KeepAlive(buffer)
	sort.Slice(result, func(left int, right int) bool {
		if result[left].SID == result[right].SID {
			return result[left].Attributes < result[right].Attributes
		}
		return result[left].SID < result[right].SID
	})
	return result, nil
}

func parseWindowsTokenPrivileges(buffer []byte) ([]PrivilegeEvidence, error) {
	headerSize := unsafe.Offsetof(windows.Tokenprivileges{}.Privileges)
	if uintptr(len(buffer)) < headerSize {
		return nil, fmt.Errorf("%w: TokenPrivileges buffer is smaller than its header", ErrTokenMismatch)
	}
	count := *(*uint32)(unsafe.Pointer(&buffer[0]))
	if count > maximumTokenEntries {
		return nil, fmt.Errorf("%w: TokenPrivileges contains %d entries", ErrTokenMismatch, count)
	}
	entrySize := unsafe.Sizeof(windows.LUIDAndAttributes{})
	if headerSize+uintptr(count)*entrySize > uintptr(len(buffer)) {
		return nil, fmt.Errorf("%w: TokenPrivileges entry array exceeds its buffer", ErrTokenMismatch)
	}
	result := make([]PrivilegeEvidence, 0, count)
	if count != 0 {
		first := (*windows.LUIDAndAttributes)(unsafe.Add(unsafe.Pointer(&buffer[0]), headerSize))
		for _, nativeEntry := range unsafe.Slice(first, int(count)) {
			name, err := lookupWindowsPrivilegeName(nativeEntry.Luid)
			if err != nil {
				return nil, err
			}
			result = append(result, PrivilegeEvidence{
				Name:       name,
				LUID:       detachWindowsLUID(nativeEntry.Luid),
				Attributes: nativeEntry.Attributes,
			})
		}
	}
	runtime.KeepAlive(buffer)
	sort.Slice(result, func(left int, right int) bool {
		if result[left].Name == result[right].Name {
			if result[left].LUID.HighPart == result[right].LUID.HighPart {
				return result[left].LUID.LowPart < result[right].LUID.LowPart
			}
			return result[left].LUID.HighPart < result[right].LUID.HighPart
		}
		return result[left].Name < result[right].Name
	})
	return result, nil
}

func tokenSIDStringWithinBuffer(sid *windows.SID, buffer []byte) (string, error) {
	if sid == nil || len(buffer) < minimumTokenSIDBytes {
		return "", errors.New("SID pointer is null or its containing buffer is too small")
	}
	bufferStart := uintptr(unsafe.Pointer(&buffer[0]))
	bufferEnd := bufferStart + uintptr(len(buffer))
	sidStart := uintptr(unsafe.Pointer(sid))
	if sidStart < bufferStart || sidStart > bufferEnd-minimumTokenSIDBytes {
		return "", errors.New("SID pointer is outside its token information buffer")
	}
	sidLength := sid.Len()
	if sidLength < minimumTokenSIDBytes || sidLength > maximumTokenSIDBytes ||
		sidStart+uintptr(sidLength) > bufferEnd {
		return "", errors.New("SID length is outside its token information buffer")
	}
	if !sid.IsValid() {
		return "", errors.New("token information contains an invalid SID")
	}
	value := sid.String()
	if value == "" {
		return "", errors.New("token SID cannot be rendered")
	}
	runtime.KeepAlive(buffer)
	return value, nil
}

func lookupWindowsPrivilegeName(luid windows.LUID) (string, error) {
	buffer := make([]uint16, maximumPrivilegeNameUnits)
	length := uint32(len(buffer))
	result, _, callErr := peerLookupPrivilegeNameW.Call(
		0,
		uintptr(unsafe.Pointer(&luid)),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&length)),
	)
	runtime.KeepAlive(luid)
	if result == 0 {
		if callErr == nil || errors.Is(callErr, syscall.Errno(0)) {
			return "", errors.New("LookupPrivilegeNameW failed without an error code")
		}
		return "", fmt.Errorf("LookupPrivilegeNameW: %w", callErr)
	}
	if length == 0 || length > uint32(len(buffer)) {
		return "", fmt.Errorf("LookupPrivilegeNameW returned invalid length %d", length)
	}
	name := windows.UTF16ToString(buffer[:length])
	if name == "" {
		return "", errors.New("LookupPrivilegeNameW returned an empty name")
	}
	runtime.KeepAlive(buffer)
	return name, nil
}

func detachWindowsLUID(value windows.LUID) LUID {
	return LUID{LowPart: value.LowPart, HighPart: value.HighPart}
}
