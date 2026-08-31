//go:build windows

package cng

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"errors"
	"fmt"
	"runtime"
	"sync"
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

	ncryptAlgorithmProperty          = "Algorithm Name"
	ncryptLengthProperty             = "Length"
	ncryptExportPolicyProperty       = "Export Policy"
	ncryptKeyUsageProperty           = "Key Usage"
	ncryptKeyTypeProperty            = "Key Type"
	ncryptNameProperty               = "Name"
	ncryptUniqueNameProperty         = "Unique Name"
	ncryptImplementationProperty     = "Impl Type"
	ncryptSecurityDescriptorProperty = "Security Descr"
	ncryptECCPublicBlob              = "ECCPUBLICBLOB"

	maximumAlgorithmPropertyBytes    = uint32(64)
	maximumNamePropertyBytes         = uint32(1024)
	maximumPublicBlobBytes           = uint32(128)
	uint32PropertyBytes              = uint32(4)
	securityDescriptorPropertyFlags  = uint32(0x00000001 | 0x00000002 | 0x00000004)
	ncryptSoftwareImplementationFlag = uint32(0x00000002)
	discardFreeAttempts              = 3
)

var (
	ncryptDLL = windows.NewLazySystemDLL("ncrypt.dll")

	ncryptOpenStorageProvider = ncryptDLL.NewProc("NCryptOpenStorageProvider")
	ncryptOpenKey             = ncryptDLL.NewProc("NCryptOpenKey")
	ncryptGetProperty         = ncryptDLL.NewProc("NCryptGetProperty")
	ncryptExportKey           = ncryptDLL.NewProc("NCryptExportKey")
	ncryptSignHash            = ncryptDLL.NewProc("NCryptSignHash")
	ncryptFreeObject          = ncryptDLL.NewProc("NCryptFreeObject")

	ncryptLoadOnce sync.Once
	ncryptLoadErr  error
)

type nativeHandle uintptr

type nativeCNG interface {
	openStorageProvider(string, uint32) (nativeHandle, error)
	openKey(nativeHandle, string, uint32) (nativeHandle, error)
	getProperty(nativeHandle, string, uint32, uint32) ([]byte, error)
	exportPublicKey(nativeHandle, string, uint32) ([]byte, error)
	signHash(nativeHandle, []byte, uint32) ([]byte, error)
	freeObject(nativeHandle) error
}

type systemCNG struct{}

// Signer owns shared private state for one validated persisted CNG P-256 key.
// Accidental value copies retain the same lock and native-handle ownership.
type Signer struct {
	state *signerState
}

type signerState struct {
	mu          sync.Mutex
	api         nativeCNG
	provider    nativeHandle
	key         nativeHandle
	closed      bool
	attestation Attestation
	publicKey   ecdsa.PublicKey
}

// Open opens one persisted Local Machine CNG key and validates its security-sensitive properties.
func Open(options Options) (*Signer, error) {
	if _, err := validateOptions(options); err != nil {
		return nil, err
	}
	if err := ensureNCryptAvailable(); err != nil {
		return nil, err
	}
	return openWithAPI(systemCNG{}, options)
}

func openWithAPI(api nativeCNG, options Options) (*Signer, error) {
	expectedSecurityDigest, err := validateOptions(options)
	if err != nil {
		return nil, err
	}

	provider, err := api.openStorageProvider(approvedKeyStorageProvider, providerOpenFlags)
	if err != nil {
		return nil, fmt.Errorf("open CNG storage provider: %w", err)
	}
	if provider == 0 {
		return nil, errors.New("NCryptOpenStorageProvider returned a null handle")
	}

	key, err := api.openKey(provider, options.KeyName, keyOpenFlags)
	if err != nil {
		cleanupErr := discardNativeHandle(api, "CNG storage provider", provider)
		return nil, errors.Join(fmt.Errorf("open CNG key: %w", err), cleanupErr)
	}
	if key == 0 {
		cleanupErr := discardNativeHandle(api, "CNG storage provider", provider)
		return nil, errors.Join(errors.New("NCryptOpenKey returned a null handle"), cleanupErr)
	}

	state := &signerState{api: api, provider: provider, key: key}
	signer := &Signer{state: state}
	_, publicKey, err := state.validateKey(options, expectedSecurityDigest)
	if err != nil {
		return nil, errors.Join(err, discardSigner(signer))
	}
	state.publicKey = *publicKey
	return signer, nil
}

// Identity returns a detached identity with no native CNG handle.
func (s *Signer) Identity() KeyIdentity {
	if s == nil || s.state == nil {
		return KeyIdentity{}
	}
	return s.state.attestation.KeyIdentity()
}

// PublicKeySPKISHA256 returns the SHA-256 digest of canonical PKIX SPKI DER.
// The fixed-size value is detached and contains no native key material.
func (s *Signer) PublicKeySPKISHA256() [DigestSize]byte {
	if s == nil || s.state == nil {
		return [DigestSize]byte{}
	}
	return s.state.attestation.PublicKeySPKISHA256()
}

// Attestation returns one atomic, detached snapshot of the values read and
// validated for the currently usable key.
func (s *Signer) Attestation() (Attestation, error) {
	if s == nil || s.state == nil {
		return Attestation{}, ErrClosed
	}
	state := s.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed {
		return Attestation{}, ErrClosed
	}
	if state.key == 0 || state.provider == 0 || !state.attestation.isComplete() {
		return Attestation{}, ErrAttestationUnavailable
	}
	return state.attestation, nil
}

// IsOpen reports whether the validated key and provider handles remain usable. It does not
// expose either handle and is serialized with signing and closing.
func (s *Signer) IsOpen() bool {
	if s == nil || s.state == nil {
		return false
	}
	state := s.state
	state.mu.Lock()
	defer state.mu.Unlock()
	return !state.closed && state.key != 0 && state.provider != 0
}

// SignDigest signs one SHA-256-sized prehash without hashing it again.
//
// The result is exactly 64 bytes in P1363 r || s form with canonical low-S.
func (s *Signer) SignDigest(digest []byte) ([]byte, error) {
	if len(digest) != DigestSize {
		return nil, ErrInvalidDigest
	}
	var digestSnapshot [DigestSize]byte
	copy(digestSnapshot[:], digest)
	if s == nil || s.state == nil {
		return nil, ErrClosed
	}

	state := s.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed || state.key == 0 {
		return nil, ErrClosed
	}

	signature, err := state.api.signHash(state.key, digestSnapshot[:], signHashFlags)
	if err != nil {
		return nil, fmt.Errorf("sign CNG digest: %w", err)
	}
	canonical, err := canonicalizeP256Signature(signature)
	if err != nil {
		return nil, err
	}
	if err := verifyP256Signature(&state.publicKey, digestSnapshot[:], canonical); err != nil {
		return nil, err
	}
	return canonical, nil
}

// Close releases the key and provider handles. Repeated calls are safe.
func (s *Signer) Close() error {
	if s == nil || s.state == nil {
		return nil
	}

	state := s.state
	state.mu.Lock()
	defer state.mu.Unlock()
	state.closed = true
	var result error
	if state.key != 0 {
		if err := freeNativeHandle(state.api, "CNG key", state.key); err != nil {
			result = errors.Join(result, err)
		} else {
			state.key = 0
		}
	}
	if state.provider != 0 {
		if err := freeNativeHandle(state.api, "CNG storage provider", state.provider); err != nil {
			result = errors.Join(result, err)
		} else {
			state.provider = 0
		}
	}
	return result
}

func (s *signerState) validateKey(
	options Options,
	expectedSecurityDigest [DigestSize]byte,
) (KeyIdentity, *ecdsa.PublicKey, error) {
	providerNameValue, err := s.api.getProperty(s.provider, ncryptNameProperty, 0, maximumNamePropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG provider Name property: %w", err)
	}
	providerName, err := decodeUTF16Property(providerNameValue)
	if err != nil || providerName != approvedKeyStorageProvider {
		return KeyIdentity{}, nil, fmt.Errorf("%w: provider Name is %q", ErrInvalidKey, providerName)
	}
	implementationValue, err := s.api.getProperty(s.provider, ncryptImplementationProperty, 0, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG provider Impl Type property: %w", err)
	}
	implementation, err := decodeUint32Property(implementationValue)
	if err != nil || implementation != ncryptSoftwareImplementationFlag {
		return KeyIdentity{}, nil, fmt.Errorf("%w: provider Impl Type is 0x%08x", ErrInvalidKey, implementation)
	}

	algorithm, err := s.api.getProperty(s.key, ncryptAlgorithmProperty, 0, maximumAlgorithmPropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG Algorithm property: %w", err)
	}
	length, err := s.api.getProperty(s.key, ncryptLengthProperty, 0, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG Length property: %w", err)
	}
	exportPolicy, err := s.api.getProperty(s.key, ncryptExportPolicyProperty, 0, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG Export Policy property: %w", err)
	}
	keyUsage, err := s.api.getProperty(s.key, ncryptKeyUsageProperty, 0, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG Key Usage property: %w", err)
	}
	properties, err := parseKeyProperties(algorithm, length, exportPolicy, keyUsage)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("%w: %v", ErrInvalidKey, err)
	}
	if err := validateP256SigningProperties(properties); err != nil {
		return KeyIdentity{}, nil, err
	}

	keyTypeValue, err := s.api.getProperty(s.key, ncryptKeyTypeProperty, 0, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG Key Type property: %w", err)
	}
	keyType, err := decodeUint32Property(keyTypeValue)
	if err != nil || keyType != ncryptMachineKeyFlag {
		return KeyIdentity{}, nil, fmt.Errorf("%w: Key Type is 0x%08x instead of machine-key only", ErrInvalidKey, keyType)
	}
	nameValue, err := s.api.getProperty(s.key, ncryptNameProperty, 0, maximumNamePropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG Name property: %w", err)
	}
	name, err := decodeUTF16Property(nameValue)
	if err != nil || name != options.KeyName {
		return KeyIdentity{}, nil, fmt.Errorf("%w: Name is %q instead of the selected key name", ErrInvalidKey, name)
	}
	uniqueNameValue, err := s.api.getProperty(s.key, ncryptUniqueNameProperty, 0, maximumNamePropertyBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG Unique Name property: %w", err)
	}
	uniqueName, err := decodeUTF16Property(uniqueNameValue)
	if err != nil || !validCNGName(uniqueName, 256) {
		return KeyIdentity{}, nil, fmt.Errorf("%w: Unique Name is missing or invalid", ErrInvalidKey)
	}

	descriptorValue, err := s.api.getProperty(
		s.key,
		ncryptSecurityDescriptorProperty,
		securityDescriptorPropertyFlags,
		maximumKeySecurityDescriptorBytes,
	)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("read CNG Security Descr property: %w", err)
	}
	securityEvidence, err := parseKeySecurityDescriptor(descriptorValue)
	if err != nil {
		return KeyIdentity{}, nil, err
	}
	if err := validateKeySecurityEvidence(
		securityEvidence,
		expectedSecurityDigest,
		options.ControlServiceSID,
		options.ExecutorServiceSID,
	); err != nil {
		return KeyIdentity{}, nil, err
	}

	publicBlob, err := s.api.exportPublicKey(s.key, ncryptECCPublicBlob, maximumPublicBlobBytes)
	if err != nil {
		return KeyIdentity{}, nil, fmt.Errorf("export CNG public key: %w", err)
	}
	publicKey, err := parseP256PublicBlob(publicBlob)
	if err != nil {
		return KeyIdentity{}, nil, err
	}
	publicKeyDigest, err := p256PublicKeySPKISHA256(publicKey)
	if err != nil {
		return KeyIdentity{}, nil, err
	}
	identity := KeyIdentity{
		ProviderName: providerName,
		UniqueName:   uniqueName,
		MachineKey:   true,
	}
	s.attestation = Attestation{
		keyName:                     name,
		keySecurityDescriptorSHA256: sha256.Sum256(descriptorValue),
		keyIdentity:                 identity,
		publicKeySPKISHA256:         publicKeyDigest,
		validatedControlServiceSID:  options.ControlServiceSID,
		validatedExecutorServiceSID: options.ExecutorServiceSID,
		algorithm:                   properties.algorithm,
		keyLengthBits:               properties.length,
		exportPolicy:                properties.exportPolicy,
		keyUsage:                    properties.keyUsage,
		validated:                   true,
	}
	return identity, publicKey, nil
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

func discardNativeHandle(api nativeCNG, description string, handle nativeHandle) error {
	var failures error
	for attempt := 0; attempt < discardFreeAttempts; attempt++ {
		err := freeNativeHandle(api, description, handle)
		if err == nil {
			return nil
		}
		failures = errors.Join(failures, err)
	}
	return failures
}

func discardSigner(signer *Signer) error {
	var failures error
	for attempt := 0; attempt < discardFreeAttempts; attempt++ {
		err := signer.Close()
		if err == nil {
			return nil
		}
		failures = errors.Join(failures, err)
	}
	return failures
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
			ncryptExportKey,
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

func (systemCNG) getProperty(
	handle nativeHandle,
	propertyName string,
	flags uint32,
	maximumBytes uint32,
) ([]byte, error) {
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
		uintptr(flags),
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
		uintptr(flags),
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

func (systemCNG) exportPublicKey(handle nativeHandle, blobType string, maximumBytes uint32) ([]byte, error) {
	blobTypePointer, err := windows.UTF16PtrFromString(blobType)
	if err != nil {
		return nil, fmt.Errorf("encode CNG blob type: %w", err)
	}
	var requiredBytes uint32
	status, _, _ := ncryptExportKey.Call(
		uintptr(handle),
		0,
		uintptr(unsafe.Pointer(blobTypePointer)),
		0,
		0,
		0,
		uintptr(unsafe.Pointer(&requiredBytes)),
		0,
	)
	runtime.KeepAlive(blobTypePointer)
	if err := securityStatusError("NCryptExportKey", status); err != nil {
		return nil, err
	}
	if requiredBytes == 0 || requiredBytes > maximumBytes {
		return nil, fmt.Errorf("NCryptExportKey reported an invalid public blob size of %d bytes", requiredBytes)
	}

	value := make([]byte, requiredBytes)
	var writtenBytes uint32
	status, _, _ = ncryptExportKey.Call(
		uintptr(handle),
		0,
		uintptr(unsafe.Pointer(blobTypePointer)),
		0,
		uintptr(unsafe.Pointer(&value[0])),
		uintptr(len(value)),
		uintptr(unsafe.Pointer(&writtenBytes)),
		0,
	)
	runtime.KeepAlive(blobTypePointer)
	runtime.KeepAlive(value)
	if err := securityStatusError("NCryptExportKey", status); err != nil {
		return nil, err
	}
	if writtenBytes != requiredBytes {
		return nil, fmt.Errorf("NCryptExportKey changed the public blob size from %d to %d bytes", requiredBytes, writtenBytes)
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
