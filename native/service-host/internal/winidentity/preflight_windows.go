//go:build windows

package winidentity

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
	maximumSIDBytes                 = 68
	minimumSIDBytes                 = 8
	maximumAccountDomainUnits       = 256
	maximumPrivilegeNameUnits       = 256
	maximumServiceConfigBytes       = 64 * 1024
	maximumServiceAccountUnits      = 512
	maximumTokenInformationBytes    = 1024 * 1024
	maximumTokenSIDEntries          = 4096
	maximumTokenPrivilegeEntries    = 4096
	maximumTokenInformationAttempts = 3
	tokenStatisticsSize             = 56
	serviceSIDInfoSize              = 4
)

type serviceSIDInfo struct {
	SIDType uint32
}

type tokenStatistics struct {
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
	_ [serviceSIDInfoSize - unsafe.Sizeof(serviceSIDInfo{})]byte
	_ [unsafe.Sizeof(serviceSIDInfo{}) - serviceSIDInfoSize]byte
	_ [tokenStatisticsSize - unsafe.Sizeof(tokenStatistics{})]byte
	_ [unsafe.Sizeof(tokenStatistics{}) - tokenStatisticsSize]byte

	identityAdvapi32     = windows.NewLazySystemDLL("advapi32.dll")
	lookupPrivilegeNameW = identityAdvapi32.NewProc("LookupPrivilegeNameW")
)

// Preflight verifies both SCM service SID configurations and the current
// process primary token using only query access. Service and token handles stay
// open until the complete snapshot has been rechecked.
func Preflight(options Options) (evidence Evidence, err error) {
	if err := validateOptions(options); err != nil {
		return Evidence{}, err
	}
	if err := lookupPrivilegeNameW.Find(); err != nil {
		return Evidence{}, fmt.Errorf("resolve LookupPrivilegeNameW: %w", err)
	}

	manager, err := windows.OpenSCManager(nil, nil, serviceManagerConnectAccess)
	if err != nil {
		return Evidence{}, fmt.Errorf("open local Service Control Manager: %w", err)
	}
	var ownService windows.Handle
	var peerService windows.Handle
	var token windows.Token
	defer func() {
		closeErr := errors.Join(
			closeTokenHandle(token),
			closeSCMHandle(peerService, "close peer service query handle"),
			closeSCMHandle(ownService, "close own service query handle"),
			closeSCMHandle(manager, "close Service Control Manager handle"),
		)
		err = errors.Join(err, closeErr)
		evidence = cloneEvidence(evidence)
	}()

	ownService, err = openServiceForIdentityQuery(manager, options.OwnService.Name)
	if err != nil {
		return evidence, fmt.Errorf("open own service %q: %w", options.OwnService.Name, err)
	}
	peerService, err = openServiceForIdentityQuery(manager, options.PeerService.Name)
	if err != nil {
		return evidence, fmt.Errorf("open peer service %q: %w", options.PeerService.Name, err)
	}

	evidence.ProcessID = windows.GetCurrentProcessId()
	evidence.OwnService, err = inspectServiceIdentity(ownService, options.OwnService.Name)
	if err != nil {
		return evidence, fmt.Errorf("inspect own service identity: %w", err)
	}
	evidence.PeerService, err = inspectServiceIdentity(peerService, options.PeerService.Name)
	if err != nil {
		return evidence, fmt.Errorf("inspect peer service identity: %w", err)
	}
	if err := validateServiceEvidence("own", options.OwnService, evidence.OwnService); err != nil {
		return evidence, err
	}
	if err := validateServiceEvidence("peer", options.PeerService, evidence.PeerService); err != nil {
		return evidence, err
	}

	if err := windows.OpenProcessToken(windows.CurrentProcess(), tokenQueryAccess, &token); err != nil {
		return evidence, fmt.Errorf("open current process token with TOKEN_QUERY: %w", err)
	}
	evidence.Token, err = inspectToken(token)
	if err != nil {
		return evidence, err
	}

	ownSIDType, err := queryServiceSIDType(ownService)
	if err != nil {
		return evidence, fmt.Errorf("recheck own service SID type: %w", err)
	}
	ownConfiguration, err := queryServiceConfiguration(ownService)
	if err != nil {
		return evidence, fmt.Errorf("recheck own service configuration: %w", err)
	}
	peerSIDType, err := queryServiceSIDType(peerService)
	if err != nil {
		return evidence, fmt.Errorf("recheck peer service SID type: %w", err)
	}
	peerConfiguration, err := queryServiceConfiguration(peerService)
	if err != nil {
		return evidence, fmt.Errorf("recheck peer service configuration: %w", err)
	}
	if ownSIDType != evidence.OwnService.SIDType ||
		peerSIDType != evidence.PeerService.SIDType ||
		ownConfiguration.serviceType != evidence.OwnService.ServiceType ||
		peerConfiguration.serviceType != evidence.PeerService.ServiceType ||
		ownConfiguration.startAccount != evidence.OwnService.StartAccount ||
		peerConfiguration.startAccount != evidence.PeerService.StartAccount {
		return evidence, fmt.Errorf(
			"%w: service configuration changed from own=(0x%x,%d,%q) peer=(0x%x,%d,%q) to own=(0x%x,%d,%q) peer=(0x%x,%d,%q)",
			ErrUnstableEvidence,
			evidence.OwnService.ServiceType,
			evidence.OwnService.SIDType,
			evidence.OwnService.StartAccount,
			evidence.PeerService.ServiceType,
			evidence.PeerService.SIDType,
			evidence.PeerService.StartAccount,
			ownConfiguration.serviceType,
			ownSIDType,
			ownConfiguration.startAccount,
			peerConfiguration.serviceType,
			peerSIDType,
			peerConfiguration.startAccount,
		)
	}

	if err := validateEvidence(options, evidence); err != nil {
		return evidence, err
	}
	return evidence, nil
}

func openServiceForIdentityQuery(manager windows.Handle, name string) (windows.Handle, error) {
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, fmt.Errorf("encode service name: %w", err)
	}
	handle, err := windows.OpenService(manager, namePointer, serviceQueryConfigAccess)
	runtime.KeepAlive(namePointer)
	return handle, err
}

func inspectServiceIdentity(service windows.Handle, name string) (ServiceEvidence, error) {
	sidType, err := queryServiceSIDType(service)
	if err != nil {
		return ServiceEvidence{}, fmt.Errorf("query SERVICE_CONFIG_SERVICE_SID_INFO: %w", err)
	}
	configuration, err := queryServiceConfiguration(service)
	if err != nil {
		return ServiceEvidence{}, fmt.Errorf("query service configuration: %w", err)
	}
	sid, domain, accountType, err := resolveServiceSID(name)
	if err != nil {
		return ServiceEvidence{}, err
	}
	return ServiceEvidence{
		Name:         name,
		SID:          sid,
		SIDType:      sidType,
		ServiceType:  configuration.serviceType,
		StartAccount: configuration.startAccount,
		Domain:       domain,
		AccountType:  accountType,
	}, nil
}

func queryServiceSIDType(service windows.Handle) (ServiceSIDType, error) {
	info := serviceSIDInfo{}
	bufferSize := uint32(unsafe.Sizeof(info))
	var bytesNeeded uint32
	err := windows.QueryServiceConfig2(
		service,
		serviceSIDInfoLevel,
		(*byte)(unsafe.Pointer(&info)),
		bufferSize,
		&bytesNeeded,
	)
	if err != nil {
		if errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return ServiceSIDTypeNone, fmt.Errorf(
				"QueryServiceConfig2W reported %d bytes, fixed limit is %d: %w",
				bytesNeeded,
				bufferSize,
				err,
			)
		}
		return ServiceSIDTypeNone, err
	}
	if bytesNeeded != 0 && bytesNeeded != bufferSize {
		return ServiceSIDTypeNone, fmt.Errorf(
			"QueryServiceConfig2W returned an unexpected SERVICE_SID_INFO size of %d bytes",
			bytesNeeded,
		)
	}
	sidType := ServiceSIDType(info.SIDType)
	runtime.KeepAlive(&info)
	return sidType, nil
}

type queriedServiceConfiguration struct {
	serviceType  uint32
	startAccount string
}

func queryServiceConfiguration(service windows.Handle) (queriedServiceConfiguration, error) {
	var requiredSize uint32
	err := windows.QueryServiceConfig(service, nil, 0, &requiredSize)
	if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
		if err == nil {
			return queriedServiceConfiguration{}, errors.New("QueryServiceConfigW size query unexpectedly succeeded")
		}
		return queriedServiceConfiguration{}, fmt.Errorf("query service configuration size: %w", err)
	}
	minimumSize := uint32(unsafe.Sizeof(windows.QUERY_SERVICE_CONFIG{}))
	if requiredSize < minimumSize || requiredSize > maximumServiceConfigBytes {
		return queriedServiceConfiguration{}, fmt.Errorf(
			"service configuration requires %d bytes, supported range is %d through %d",
			requiredSize,
			minimumSize,
			maximumServiceConfigBytes,
		)
	}

	for attempt := 0; attempt < maximumTokenInformationAttempts; attempt++ {
		buffer := make([]byte, requiredSize)
		configuration := (*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&buffer[0]))
		var returnedSize uint32
		err = windows.QueryServiceConfig(
			service,
			configuration,
			uint32(len(buffer)),
			&returnedSize,
		)
		if err == nil {
			serviceType := configuration.ServiceType
			account, parseErr := boundedUTF16String(
				configuration.ServiceStartName,
				buffer,
				maximumServiceAccountUnits,
				"service start account",
			)
			runtime.KeepAlive(buffer)
			if parseErr != nil {
				return queriedServiceConfiguration{}, parseErr
			}
			return queriedServiceConfiguration{
				serviceType:  serviceType,
				startAccount: account,
			}, nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return queriedServiceConfiguration{}, fmt.Errorf("QueryServiceConfigW: %w", err)
		}
		if returnedSize <= uint32(len(buffer)) || returnedSize > maximumServiceConfigBytes {
			return queriedServiceConfiguration{}, fmt.Errorf(
				"%w: service configuration changed to invalid size %d: %v",
				ErrUnstableEvidence,
				returnedSize,
				err,
			)
		}
		requiredSize = returnedSize
	}
	return queriedServiceConfiguration{}, fmt.Errorf("%w: service configuration changed size repeatedly", ErrUnstableEvidence)
}

func resolveServiceSID(serviceName string) (string, string, uint32, error) {
	accountName := serviceAccountName(serviceName)
	accountNamePointer, err := windows.UTF16PtrFromString(accountName)
	if err != nil {
		return "", "", 0, fmt.Errorf("encode service account name: %w", err)
	}

	var sidBuffer [maximumSIDBytes]byte
	var domainBuffer [maximumAccountDomainUnits]uint16
	sidSize := uint32(len(sidBuffer))
	domainSize := uint32(len(domainBuffer))
	var accountType uint32
	sid := (*windows.SID)(unsafe.Pointer(&sidBuffer[0]))
	err = windows.LookupAccountName(
		nil,
		accountNamePointer,
		sid,
		&sidSize,
		&domainBuffer[0],
		&domainSize,
		&accountType,
	)
	runtime.KeepAlive(accountNamePointer)
	if err != nil {
		if errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return "", "", 0, fmt.Errorf(
				"LookupAccountNameW exceeded bounded buffers: SID=%d bytes domain=%d UTF-16 units: %w",
				sidSize,
				domainSize,
				err,
			)
		}
		return "", "", 0, fmt.Errorf("resolve %s: %w", accountName, err)
	}
	if sidSize < minimumSIDBytes || sidSize > uint32(len(sidBuffer)) ||
		domainSize == 0 || domainSize > uint32(len(domainBuffer)) {
		return "", "", 0, errors.New("LookupAccountNameW returned invalid output lengths")
	}
	if !sid.IsValid() || sid.Len() != int(sidSize) {
		return "", "", 0, errors.New("LookupAccountNameW returned an invalid or noncanonical SID length")
	}
	sidString := sid.String()
	if sidString == "" {
		return "", "", 0, errors.New("resolved service SID cannot be rendered")
	}
	if err := validateCanonicalServiceSID(sidString); err != nil {
		return "", "", 0, fmt.Errorf("resolved service SID %q %v", sidString, err)
	}
	domain := windows.UTF16ToString(domainBuffer[:domainSize])
	if domain != serviceAccountDomain {
		return "", "", 0, fmt.Errorf("service SID resolved in unexpected domain %q", domain)
	}
	runtime.KeepAlive(sidBuffer)
	runtime.KeepAlive(domainBuffer)
	return sidString, domain, accountType, nil
}

func inspectToken(token windows.Token) (TokenEvidence, error) {
	before, err := queryTokenStatistics(token)
	if err != nil {
		return TokenEvidence{}, fmt.Errorf("read initial TokenStatistics: %w", err)
	}

	userBuffer, err := queryVariableTokenInformation(token, windows.TokenUser, "TokenUser")
	if err != nil {
		return TokenEvidence{}, err
	}
	user, err := parseTokenUser(userBuffer)
	if err != nil {
		return TokenEvidence{}, fmt.Errorf("parse TokenUser: %w", err)
	}

	groupBuffer, err := queryVariableTokenInformation(token, windows.TokenGroups, "TokenGroups")
	if err != nil {
		return TokenEvidence{}, err
	}
	groups, err := parseTokenSIDEntries(groupBuffer, "TokenGroups")
	if err != nil {
		return TokenEvidence{}, err
	}

	restrictedBuffer, err := queryVariableTokenInformation(token, windows.TokenRestrictedSids, "TokenRestrictedSids")
	if err != nil {
		return TokenEvidence{}, err
	}
	restrictedSIDs, err := parseTokenSIDEntries(restrictedBuffer, "TokenRestrictedSids")
	if err != nil {
		return TokenEvidence{}, err
	}

	privilegeBuffer, err := queryVariableTokenInformation(token, windows.TokenPrivileges, "TokenPrivileges")
	if err != nil {
		return TokenEvidence{}, err
	}
	privileges, err := parseTokenPrivileges(privilegeBuffer)
	if err != nil {
		return TokenEvidence{}, err
	}

	hasRestrictionsValue, err := queryTokenUint32(token, windows.TokenHasRestrictions, "TokenHasRestrictions")
	if err != nil {
		return TokenEvidence{}, err
	}
	after, err := queryTokenStatistics(token)
	if err != nil {
		return TokenEvidence{}, fmt.Errorf("read final TokenStatistics: %w", err)
	}

	evidence := tokenEvidenceFromStatistics(before)
	evidence.HasRestrictions = hasRestrictionsValue != 0
	evidence.User = user
	evidence.Groups = groups
	evidence.RestrictedSIDs = restrictedSIDs
	evidence.Privileges = privileges
	if before != after {
		return evidence, fmt.Errorf("%w: TokenStatistics changed during inspection", ErrUnstableEvidence)
	}
	if before.GroupCount != uint32(len(groups)) || before.PrivilegeCount != uint32(len(privileges)) {
		return evidence, fmt.Errorf(
			"%w: TokenStatistics counts groups=%d privileges=%d, parsed groups=%d privileges=%d",
			ErrUnstableEvidence,
			before.GroupCount,
			before.PrivilegeCount,
			len(groups),
			len(privileges),
		)
	}
	return evidence, nil
}

func tokenEvidenceFromStatistics(statistics tokenStatistics) TokenEvidence {
	return TokenEvidence{
		TokenID:            detachLUID(statistics.TokenID),
		AuthenticationID:   detachLUID(statistics.AuthenticationID),
		ModifiedID:         detachLUID(statistics.ModifiedID),
		Type:               statistics.TokenType,
		ImpersonationLevel: statistics.ImpersonationLevel,
	}
}

func queryTokenStatistics(token windows.Token) (tokenStatistics, error) {
	statistics := tokenStatistics{}
	bufferSize := uint32(unsafe.Sizeof(statistics))
	var returnedSize uint32
	if err := windows.GetTokenInformation(
		token,
		windows.TokenStatistics,
		(*byte)(unsafe.Pointer(&statistics)),
		bufferSize,
		&returnedSize,
	); err != nil {
		return tokenStatistics{}, err
	}
	if returnedSize != bufferSize {
		return tokenStatistics{}, fmt.Errorf("TokenStatistics returned %d bytes, want %d", returnedSize, bufferSize)
	}
	return statistics, nil
}

func queryTokenUint32(token windows.Token, class uint32, description string) (uint32, error) {
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

func queryVariableTokenInformation(token windows.Token, class uint32, description string) ([]byte, error) {
	var requiredSize uint32
	err := windows.GetTokenInformation(token, class, nil, 0, &requiredSize)
	if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
		if err == nil {
			return nil, fmt.Errorf("%s size query unexpectedly succeeded", description)
		}
		return nil, fmt.Errorf("query %s size: %w", description, err)
	}
	if requiredSize == 0 || requiredSize > maximumTokenInformationBytes {
		return nil, fmt.Errorf(
			"%w: %s requires %d bytes, supported maximum is %d",
			ErrUnsafeToken,
			description,
			requiredSize,
			maximumTokenInformationBytes,
		)
	}

	for attempt := 0; attempt < maximumTokenInformationAttempts; attempt++ {
		buffer := make([]byte, requiredSize)
		var returnedSize uint32
		err = windows.GetTokenInformation(token, class, &buffer[0], uint32(len(buffer)), &returnedSize)
		if err == nil {
			if returnedSize == 0 || returnedSize > uint32(len(buffer)) {
				return nil, fmt.Errorf("%w: %s returned invalid length %d", ErrUnsafeToken, description, returnedSize)
			}
			return buffer[:returnedSize], nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return nil, fmt.Errorf("query %s: %w", description, err)
		}
		if returnedSize <= uint32(len(buffer)) || returnedSize > maximumTokenInformationBytes {
			return nil, fmt.Errorf(
				"%w: %s changed to invalid size %d: %v",
				ErrUnstableEvidence,
				description,
				returnedSize,
				err,
			)
		}
		requiredSize = returnedSize
	}
	return nil, fmt.Errorf("%w: %s changed size repeatedly", ErrUnstableEvidence, description)
}

func parseTokenUser(buffer []byte) (SIDEntry, error) {
	if uintptr(len(buffer)) < unsafe.Sizeof(windows.Tokenuser{}) {
		return SIDEntry{}, errors.New("TokenUser buffer is too small")
	}
	user := (*windows.Tokenuser)(unsafe.Pointer(&buffer[0]))
	sid, err := sidStringWithinBuffer(user.User.Sid, buffer)
	if err != nil {
		return SIDEntry{}, err
	}
	entry := SIDEntry{SID: sid, Attributes: user.User.Attributes}
	runtime.KeepAlive(buffer)
	return entry, nil
}

func parseTokenSIDEntries(buffer []byte, description string) ([]SIDEntry, error) {
	headerSize := unsafe.Offsetof(windows.Tokengroups{}.Groups)
	if uintptr(len(buffer)) < headerSize {
		return nil, fmt.Errorf("%w: %s buffer is smaller than its header", ErrUnsafeToken, description)
	}
	count := *(*uint32)(unsafe.Pointer(&buffer[0]))
	if count > maximumTokenSIDEntries {
		return nil, fmt.Errorf("%w: %s contains %d entries", ErrUnsafeToken, description, count)
	}
	entrySize := unsafe.Sizeof(windows.SIDAndAttributes{})
	requiredSize := headerSize + uintptr(count)*entrySize
	if requiredSize > uintptr(len(buffer)) {
		return nil, fmt.Errorf("%w: %s entry array exceeds its buffer", ErrUnsafeToken, description)
	}

	result := make([]SIDEntry, 0, count)
	if count > 0 {
		first := (*windows.SIDAndAttributes)(unsafe.Add(unsafe.Pointer(&buffer[0]), headerSize))
		for _, nativeEntry := range unsafe.Slice(first, int(count)) {
			sid, err := sidStringWithinBuffer(nativeEntry.Sid, buffer)
			if err != nil {
				return nil, fmt.Errorf("%s SID: %w", description, err)
			}
			result = append(result, SIDEntry{SID: sid, Attributes: nativeEntry.Attributes})
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

func parseTokenPrivileges(buffer []byte) ([]PrivilegeEvidence, error) {
	headerSize := unsafe.Offsetof(windows.Tokenprivileges{}.Privileges)
	if uintptr(len(buffer)) < headerSize {
		return nil, fmt.Errorf("%w: TokenPrivileges buffer is smaller than its header", ErrUnsafeToken)
	}
	count := *(*uint32)(unsafe.Pointer(&buffer[0]))
	if count > maximumTokenPrivilegeEntries {
		return nil, fmt.Errorf("%w: TokenPrivileges contains %d entries", ErrUnsafeToken, count)
	}
	entrySize := unsafe.Sizeof(windows.LUIDAndAttributes{})
	requiredSize := headerSize + uintptr(count)*entrySize
	if requiredSize > uintptr(len(buffer)) {
		return nil, fmt.Errorf("%w: TokenPrivileges entry array exceeds its buffer", ErrUnsafeToken)
	}

	result := make([]PrivilegeEvidence, 0, count)
	if count > 0 {
		first := (*windows.LUIDAndAttributes)(unsafe.Add(unsafe.Pointer(&buffer[0]), headerSize))
		for _, nativeEntry := range unsafe.Slice(first, int(count)) {
			name, err := lookupPrivilegeName(nativeEntry.Luid)
			if err != nil {
				return nil, err
			}
			result = append(result, PrivilegeEvidence{
				Name:       name,
				LUID:       detachLUID(nativeEntry.Luid),
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

func sidStringWithinBuffer(sid *windows.SID, buffer []byte) (string, error) {
	if sid == nil || len(buffer) < minimumSIDBytes {
		return "", errors.New("SID pointer is null or its containing buffer is too small")
	}
	bufferStart := uintptr(unsafe.Pointer(&buffer[0]))
	bufferEnd := bufferStart + uintptr(len(buffer))
	sidStart := uintptr(unsafe.Pointer(sid))
	if sidStart < bufferStart || sidStart > bufferEnd-minimumSIDBytes {
		return "", errors.New("SID pointer is outside its token information buffer")
	}
	sidLength := sid.Len()
	if sidLength < minimumSIDBytes || sidLength > maximumSIDBytes || sidStart+uintptr(sidLength) > bufferEnd {
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

func boundedUTF16String(pointer *uint16, buffer []byte, maximumUnits int, description string) (string, error) {
	if pointer == nil || len(buffer) < 2 || maximumUnits <= 0 {
		return "", fmt.Errorf("%s pointer or bounds are invalid", description)
	}
	bufferStart := uintptr(unsafe.Pointer(&buffer[0]))
	bufferEnd := bufferStart + uintptr(len(buffer))
	stringStart := uintptr(unsafe.Pointer(pointer))
	if stringStart < bufferStart || stringStart > bufferEnd-2 || (stringStart-bufferStart)%2 != 0 {
		return "", fmt.Errorf("%s pointer is outside or misaligned within its buffer", description)
	}
	availableUnits := int((bufferEnd - stringStart) / 2)
	inspectionUnits := availableUnits
	if inspectionUnits > maximumUnits+1 {
		inspectionUnits = maximumUnits + 1
	}
	units := unsafe.Slice(pointer, inspectionUnits)
	for index, unit := range units {
		if unit != 0 {
			continue
		}
		if index == 0 {
			return "", fmt.Errorf("%s is empty", description)
		}
		value := windows.UTF16ToString(units[:index])
		runtime.KeepAlive(buffer)
		if value == "" {
			return "", fmt.Errorf("%s cannot be decoded", description)
		}
		return value, nil
	}
	if availableUnits > maximumUnits {
		return "", fmt.Errorf("%s exceeds %d UTF-16 units", description, maximumUnits)
	}
	return "", fmt.Errorf("%s is not NUL-terminated within its buffer", description)
}

func lookupPrivilegeName(luid windows.LUID) (string, error) {
	var buffer [maximumPrivilegeNameUnits]uint16
	length := uint32(len(buffer))
	result, _, callErr := lookupPrivilegeNameW.Call(
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

func detachLUID(value windows.LUID) LUID {
	return LUID{LowPart: value.LowPart, HighPart: value.HighPart}
}

func closeTokenHandle(token windows.Token) error {
	if token == 0 {
		return nil
	}
	if err := token.Close(); err != nil {
		return fmt.Errorf("close current process token handle: %w", err)
	}
	return nil
}

func closeSCMHandle(handle windows.Handle, operation string) error {
	if handle == 0 {
		return nil
	}
	if err := windows.CloseServiceHandle(handle); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}
