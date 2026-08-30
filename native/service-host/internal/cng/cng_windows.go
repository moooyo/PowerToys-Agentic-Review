//go:build windows

package cng

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	ncryptMachineKeyFlag = uint32(0x00000020)
	ncryptSilentFlag     = uint32(0x00000040)

	// NCryptOpenStorageProvider currently requires dwFlags to be zero.
	providerOpenFlags = uint32(0)
	keyOpenFlags      = ncryptMachineKeyFlag | ncryptSilentFlag
	signHashFlags     = ncryptSilentFlag

	ncryptAlgorithmProperty    = "Algorithm Name"
	ncryptLengthProperty       = "Length"
	ncryptExportPolicyProperty = "Export Policy"
	ncryptKeyUsageProperty     = "Key Usage"

	maximumAlgorithmPropertyBytes = uint32(64)
	uint32PropertyBytes           = uint32(4)
)

var (
	ncryptDLL = windows.NewLazySystemDLL("ncrypt.dll")

	ncryptOpenStorageProvider = ncryptDLL.NewProc("NCryptOpenStorageProvider")
	ncryptOpenKey             = ncryptDLL.NewProc("NCryptOpenKey")
	ncryptGetProperty         = ncryptDLL.NewProc("NCryptGetProperty")
	ncryptSignHash            = ncryptDLL.NewProc("NCryptSignHash")
	ncryptFreeObject          = ncryptDLL.NewProc("NCryptFreeObject")

	ncryptLoadOnce sync.Once
	ncryptLoadErr  error
)

type nativeHandle uintptr

type nativeCNG interface {
	openStorageProvider(string, uint32) (nativeHandle, error)
	openKey(nativeHandle, string, uint32) (nativeHandle, error)
	getProperty(nativeHandle, string, uint32) ([]byte, error)
	signHash(nativeHandle, []byte, uint32) ([]byte, error)
	freeObject(nativeHandle) error
}

type systemCNG struct{}

// Signer owns a validated persisted CNG P-256 key handle.
type Signer struct {
	mu       sync.Mutex
	api      nativeCNG
	provider nativeHandle
	key      nativeHandle
}

// Open opens one persisted Local Machine CNG key and validates its security-sensitive properties.
func Open(providerName string, keyName string) (*Signer, error) {
	if err := validateOpenNames(providerName, keyName); err != nil {
		return nil, err
	}
	if err := ensureNCryptAvailable(); err != nil {
		return nil, err
	}
	return openWithAPI(systemCNG{}, providerName, keyName)
}

func openWithAPI(api nativeCNG, providerName string, keyName string) (*Signer, error) {
	if err := validateOpenNames(providerName, keyName); err != nil {
		return nil, err
	}

	provider, err := api.openStorageProvider(providerName, providerOpenFlags)
	if err != nil {
		return nil, fmt.Errorf("open CNG storage provider: %w", err)
	}
	if provider == 0 {
		return nil, errors.New("NCryptOpenStorageProvider returned a null handle")
	}

	key, err := api.openKey(provider, keyName, keyOpenFlags)
	if err != nil {
		cleanupErr := freeNativeHandle(api, "CNG storage provider", provider)
		return nil, errors.Join(fmt.Errorf("open CNG key: %w", err), cleanupErr)
	}
	if key == 0 {
		cleanupErr := freeNativeHandle(api, "CNG storage provider", provider)
		return nil, errors.Join(errors.New("NCryptOpenKey returned a null handle"), cleanupErr)
	}

	signer := &Signer{api: api, provider: provider, key: key}
	if err := signer.validateKeyProperties(); err != nil {
		return nil, errors.Join(err, signer.Close())
	}
	return signer, nil
}

// SignDigest signs one SHA-256-sized prehash without hashing it again.
//
// The result is exactly 64 bytes in P1363 r || s form with canonical low-S.
func (s *Signer) SignDigest(digest []byte) ([]byte, error) {
	if len(digest) != DigestSize {
		return nil, ErrInvalidDigest
	}
	if s == nil {
		return nil, ErrClosed
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key == 0 {
		return nil, ErrClosed
	}

	signature, err := s.api.signHash(s.key, digest, signHashFlags)
	if err != nil {
		return nil, fmt.Errorf("sign CNG digest: %w", err)
	}
	return canonicalizeP256Signature(signature)
}

// Close releases the key and provider handles. Repeated calls are safe.
func (s *Signer) Close() error {
	if s == nil {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.key
	provider := s.provider
	s.key = 0
	s.provider = 0
	return errors.Join(
		freeNativeHandle(s.api, "CNG key", key),
		freeNativeHandle(s.api, "CNG storage provider", provider),
	)
}

func (s *Signer) validateKeyProperties() error {
	algorithm, err := s.api.getProperty(s.key, ncryptAlgorithmProperty, maximumAlgorithmPropertyBytes)
	if err != nil {
		return fmt.Errorf("read CNG Algorithm property: %w", err)
	}
	length, err := s.api.getProperty(s.key, ncryptLengthProperty, uint32PropertyBytes)
	if err != nil {
		return fmt.Errorf("read CNG Length property: %w", err)
	}
	exportPolicy, err := s.api.getProperty(s.key, ncryptExportPolicyProperty, uint32PropertyBytes)
	if err != nil {
		return fmt.Errorf("read CNG Export Policy property: %w", err)
	}
	keyUsage, err := s.api.getProperty(s.key, ncryptKeyUsageProperty, uint32PropertyBytes)
	if err != nil {
		return fmt.Errorf("read CNG Key Usage property: %w", err)
	}

	properties, err := parseKeyProperties(algorithm, length, exportPolicy, keyUsage)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidKey, err)
	}
	return validateP256SigningProperties(properties)
}

func validateOpenNames(providerName string, keyName string) error {
	if err := validateOpenName("provider", providerName); err != nil {
		return err
	}
	return validateOpenName("key", keyName)
}

func validateOpenName(label string, value string) error {
	if value == "" {
		return fmt.Errorf("CNG %s name is required", label)
	}
	if !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') {
		return fmt.Errorf("CNG %s name is not valid text", label)
	}
	return nil
}

func freeNativeHandle(api nativeCNG, description string, handle nativeHandle) error {
	if handle == 0 {
		return nil
	}
	if err := api.freeObject(handle); err != nil {
		return fmt.Errorf("free %s: %w", description, err)
	}
	return nil
}

func ensureNCryptAvailable() error {
	ncryptLoadOnce.Do(func() {
		if err := ncryptDLL.Load(); err != nil {
			ncryptLoadErr = fmt.Errorf("load ncrypt.dll: %w", err)
			return
		}
		for _, procedure := range []*windows.LazyProc{
			ncryptOpenStorageProvider,
			ncryptOpenKey,
			ncryptGetProperty,
			ncryptSignHash,
			ncryptFreeObject,
		} {
			if err := procedure.Find(); err != nil {
				ncryptLoadErr = fmt.Errorf("resolve %s: %w", procedure.Name, err)
				return
			}
		}
	})
	return ncryptLoadErr
}

func (systemCNG) openStorageProvider(providerName string, flags uint32) (nativeHandle, error) {
	providerNamePointer, err := windows.UTF16PtrFromString(providerName)
	if err != nil {
		return 0, fmt.Errorf("encode CNG provider name: %w", err)
	}
	var provider nativeHandle
	status, _, _ := ncryptOpenStorageProvider.Call(
		uintptr(unsafe.Pointer(&provider)),
		uintptr(unsafe.Pointer(providerNamePointer)),
		uintptr(flags),
	)
	runtime.KeepAlive(providerNamePointer)
	if err := securityStatusError("NCryptOpenStorageProvider", status); err != nil {
		return 0, err
	}
	if provider == 0 {
		return 0, errors.New("NCryptOpenStorageProvider returned a null handle")
	}
	return provider, nil
}

func (systemCNG) openKey(provider nativeHandle, keyName string, flags uint32) (nativeHandle, error) {
	keyNamePointer, err := windows.UTF16PtrFromString(keyName)
	if err != nil {
		return 0, fmt.Errorf("encode CNG key name: %w", err)
	}
	var key nativeHandle
	status, _, _ := ncryptOpenKey.Call(
		uintptr(provider),
		uintptr(unsafe.Pointer(&key)),
		uintptr(unsafe.Pointer(keyNamePointer)),
		0,
		uintptr(flags),
	)
	runtime.KeepAlive(keyNamePointer)
	if err := securityStatusError("NCryptOpenKey", status); err != nil {
		return 0, err
	}
	if key == 0 {
		return 0, errors.New("NCryptOpenKey returned a null handle")
	}
	return key, nil
}

func (systemCNG) getProperty(handle nativeHandle, propertyName string, maximumBytes uint32) ([]byte, error) {
	propertyNamePointer, err := windows.UTF16PtrFromString(propertyName)
	if err != nil {
		return nil, fmt.Errorf("encode CNG property name: %w", err)
	}

	var requiredBytes uint32
	status, _, _ := ncryptGetProperty.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(propertyNamePointer)),
		0,
		0,
		uintptr(unsafe.Pointer(&requiredBytes)),
		0,
	)
	runtime.KeepAlive(propertyNamePointer)
	if err := securityStatusError("NCryptGetProperty", status); err != nil {
		return nil, err
	}
	if requiredBytes == 0 || requiredBytes > maximumBytes {
		return nil, fmt.Errorf("NCryptGetProperty reported an invalid %s size of %d bytes", propertyName, requiredBytes)
	}

	value := make([]byte, requiredBytes)
	var writtenBytes uint32
	status, _, _ = ncryptGetProperty.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(propertyNamePointer)),
		uintptr(unsafe.Pointer(&value[0])),
		uintptr(len(value)),
		uintptr(unsafe.Pointer(&writtenBytes)),
		0,
	)
	runtime.KeepAlive(propertyNamePointer)
	runtime.KeepAlive(value)
	if err := securityStatusError("NCryptGetProperty", status); err != nil {
		return nil, err
	}
	if writtenBytes != requiredBytes {
		return nil, fmt.Errorf("NCryptGetProperty changed the %s size from %d to %d bytes", propertyName, requiredBytes, writtenBytes)
	}
	return value, nil
}

func (systemCNG) signHash(handle nativeHandle, digest []byte, flags uint32) ([]byte, error) {
	if len(digest) != DigestSize {
		return nil, ErrInvalidDigest
	}

	var requiredBytes uint32
	status, _, _ := ncryptSignHash.Call(
		uintptr(handle),
		0,
		uintptr(unsafe.Pointer(&digest[0])),
		uintptr(len(digest)),
		0,
		0,
		uintptr(unsafe.Pointer(&requiredBytes)),
		uintptr(flags),
	)
	runtime.KeepAlive(digest)
	if err := securityStatusError("NCryptSignHash", status); err != nil {
		return nil, err
	}
	if requiredBytes != SignatureSize {
		return nil, fmt.Errorf("NCryptSignHash reported a %d-byte signature instead of %d bytes", requiredBytes, SignatureSize)
	}

	signature := make([]byte, SignatureSize)
	var writtenBytes uint32
	status, _, _ = ncryptSignHash.Call(
		uintptr(handle),
		0,
		uintptr(unsafe.Pointer(&digest[0])),
		uintptr(len(digest)),
		uintptr(unsafe.Pointer(&signature[0])),
		uintptr(len(signature)),
		uintptr(unsafe.Pointer(&writtenBytes)),
		uintptr(flags),
	)
	runtime.KeepAlive(digest)
	runtime.KeepAlive(signature)
	if err := securityStatusError("NCryptSignHash", status); err != nil {
		return nil, err
	}
	if writtenBytes != SignatureSize {
		return nil, fmt.Errorf("NCryptSignHash wrote a %d-byte signature instead of %d bytes", writtenBytes, SignatureSize)
	}
	return signature, nil
}

func (systemCNG) freeObject(handle nativeHandle) error {
	status, _, _ := ncryptFreeObject.Call(uintptr(handle))
	return securityStatusError("NCryptFreeObject", status)
}

func securityStatusError(operation string, status uintptr) error {
	code := uint32(status)
	if code == 0 {
		return nil
	}
	return &StatusError{Operation: operation, Code: code}
}
