//go:build windows

package wincert

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"golang.org/x/sys/windows"
)

const (
	certificateStoreProvider  = uintptr(windows.CERT_STORE_PROV_SYSTEM_W)
	certificateStoreEncoding  = uint32(0)
	certificateStoreOpenFlags = uint32(
		windows.CERT_SYSTEM_STORE_LOCAL_MACHINE |
			windows.CERT_STORE_OPEN_EXISTING_FLAG |
			windows.CERT_STORE_READONLY_FLAG,
	)
	certificateStoreCloseFlags = uint32(0)

	certificateAcquireFlags = uint32(
		windows.CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG |
			windows.CRYPT_ACQUIRE_COMPARE_KEY_FLAG |
			windows.CRYPT_ACQUIRE_NO_HEALING |
			windows.CRYPT_ACQUIRE_SILENT_FLAG,
	)

	localMachineChainEngine              = nativeChainEngine(1)
	certChainCacheOnlyURLRetrieval       = uint32(0x00000004)
	certChainDisableAuthRootAutoUpdate   = uint32(0x00000100)
	certChainDisableAuthorityInformation = uint32(0x00002000)
	certificateChainFlags                = certChainCacheOnlyURLRetrieval |
		certChainDisableAuthRootAutoUpdate |
		certChainDisableAuthorityInformation

	ncryptSilentFlag = uint32(0x00000040)

	ncryptAlgorithmProperty          = "Algorithm Name"
	ncryptLengthProperty             = "Length"
	ncryptExportPolicyProperty       = "Export Policy"
	ncryptKeyUsageProperty           = "Key Usage"
	ncryptKeyTypeProperty            = "Key Type"
	ncryptNameProperty               = "Name"
	ncryptImplementationProperty     = "Impl Type"
	ncryptUniqueNameProperty         = "Unique Name"
	ncryptProviderHandleProperty     = "Provider Handle"
	ncryptSecurityDescriptorProperty = "Security Descr"
	ncryptECCPublicBlob              = "ECCPUBLICBLOB"
	ncryptSoftwareImplementationFlag = uint32(0x00000002)

	maximumAlgorithmPropertyBytes      = uint32(64)
	maximumProviderNamePropertyBytes   = uint32(256)
	uint32PropertyBytes                = uint32(4)
	maximumUniqueNamePropertyBytes     = uint32(2048)
	maximumPublicBlobBytes             = uint32(128)
	maximumProviderInfoBytes           = uint32(4096)
	certificateKeyProviderInfoProperty = uint32(2)
	discardFreeAttempts                = 3
	keySecurityInformation             = uint32(
		windows.OWNER_SECURITY_INFORMATION |
			windows.GROUP_SECURITY_INFORMATION |
			windows.DACL_SECURITY_INFORMATION,
	)
)

var (
	crypt32DLL = windows.NewLazySystemDLL("crypt32.dll")
	ncryptDLL  = windows.NewLazySystemDLL("ncrypt.dll")

	certGetCertificateContextProperty = crypt32DLL.NewProc("CertGetCertificateContextProperty")
	ncryptGetProperty                 = ncryptDLL.NewProc("NCryptGetProperty")
	ncryptExportKey                   = ncryptDLL.NewProc("NCryptExportKey")
	ncryptSignHash                    = ncryptDLL.NewProc("NCryptSignHash")
	ncryptFreeObject                  = ncryptDLL.NewProc("NCryptFreeObject")

	ncryptLoadOnce sync.Once
	ncryptLoadErr  error

	errNoMoreCertificates = errors.New("no more certificates")
)

type nativeStore uintptr
type nativeCertificate = *windows.CertContext
type nativeChain = *windows.CertChainContext
type nativeChainEngine uintptr
type nativeKey uintptr

type nativeAPI interface {
	openStore(uintptr, uint32, string, uint32) (nativeStore, error)
	enumCertificates(nativeStore, nativeCertificate) (nativeCertificate, error)
	duplicateCertificate(nativeCertificate) (nativeCertificate, error)
	certificateDER(nativeCertificate) ([]byte, error)
	readCertificateProviderInfo(nativeCertificate) (certificateProviderInfo, error)
	getCertificateChain(nativeChainEngine, nativeCertificate, nativeStore, uint32) (nativeChain, error)
	certificateChainDER(nativeChain) ([][]byte, error)
	freeCertificateChain(nativeChain)
	acquirePrivateKey(nativeCertificate, uint32) (nativeKey, uint32, bool, error)
	getKeyProperty(nativeKey, string, uint32) ([]byte, error)
	readKeyProviderIdentity(nativeKey) (string, uint32, error)
	readKeySecurityEvidence(nativeKey) (keySecurityEvidence, error)
	exportPublicKey(nativeKey, string, uint32) ([]byte, error)
	signHash(nativeKey, []byte, uint32) ([]byte, error)
	freeKey(nativeKey) error
	freeCertificate(nativeCertificate) error
	closeStore(nativeStore, uint32) error
}

type systemAPI struct{}

// Credential owns shared private state for one selected certificate and CNG
// key. Accidental value copies retain the same lock and native ownership.
type Credential struct {
	state *credentialState
}

type credentialState struct {
	mu sync.Mutex

	api           nativeAPI
	store         nativeStore
	certificate   nativeCertificate
	key           nativeKey
	callerFreeKey bool
	closed        bool

	tlsCertificate tls.Certificate
	publicKey      ecdsa.PublicKey
	keyIdentity    KeyIdentity
	validFrom      time.Time
	validUntil     time.Time
}

type cryptKeyProviderParameter struct {
	parameter uint32
	data      *byte
	dataBytes uint32
	flags     uint32
}

type cryptKeyProviderInfo struct {
	containerName  *uint16
	providerName   *uint16
	providerType   uint32
	flags          uint32
	parameterCount uint32
	parameters     *cryptKeyProviderParameter
	keySpec        uint32
}

// Acquire opens LocalMachine/MY and selects the unique exact DER digest. Only
// after selection does it validate leaf validity and client usage, then the
// non-exportable CNG P-256 signing key and matching public key.
func Acquire(config Config) (*Credential, error) {
	if _, err := validateConfig(config); err != nil {
		return nil, err
	}
	if err := ensureNCryptAvailable(); err != nil {
		return nil, err
	}
	return acquireWithAPI(systemAPI{}, config)
}

func acquireWithAPI(api nativeAPI, config Config) (*Credential, error) {
	expectedDigest, err := validateConfig(config)
	if err != nil {
		return nil, err
	}
	store, err := api.openStore(
		certificateStoreProvider,
		certificateStoreEncoding,
		config.StoreName,
		certificateStoreOpenFlags,
	)
	if err != nil {
		return nil, fmt.Errorf("open Local Machine certificate store: %w", err)
	}
	if store == 0 {
		return nil, errors.New("CertOpenStore returned a null handle")
	}

	state := &credentialState{api: api, store: store}
	credential := &Credential{state: state}
	cleanup := func(primary error) error {
		return errors.Join(primary, discardCredential(credential))
	}

	certificate, selectedDER, err := findPinnedCertificate(api, state.store, expectedDigest)
	if err != nil {
		return nil, cleanup(err)
	}
	state.certificate = certificate
	providerInfo, err := api.readCertificateProviderInfo(state.certificate)
	if err != nil {
		return nil, cleanup(fmt.Errorf("read certificate key provider information: %w", err))
	}
	if err := validateCertificateProviderInfo(providerInfo); err != nil {
		return nil, cleanup(err)
	}

	chain, err := api.getCertificateChain(
		localMachineChainEngine,
		state.certificate,
		state.store,
		certificateChainFlags,
	)
	if err != nil {
		if chain != nil {
			api.freeCertificateChain(chain)
		}
		return nil, cleanup(fmt.Errorf("build local certificate chain: %w", err))
	}
	if chain == nil {
		return nil, cleanup(errors.New("CertGetCertificateChain returned a null context"))
	}
	// The local engine supplies certificates only. Its trust status is not an
	// authorization input; prepareTLSCertificate validates the detached path,
	// while the remote Server remains the trust and revocation authority.
	chainDER, chainErr := api.certificateChainDER(chain)
	api.freeCertificateChain(chain)
	if chainErr != nil {
		return nil, cleanup(fmt.Errorf("copy local certificate chain: %w", chainErr))
	}
	tlsCertificate, certificatePublicKey, err := prepareTLSCertificate(chainDER, selectedDER)
	if err != nil {
		return nil, cleanup(err)
	}
	validFrom, validUntil, err := certificateValidityWindow(tlsCertificate.Certificate)
	if err != nil {
		return nil, cleanup(err)
	}

	var keySpec uint32
	state.key, keySpec, state.callerFreeKey, err = api.acquirePrivateKey(
		state.certificate,
		certificateAcquireFlags,
	)
	if err != nil {
		return nil, cleanup(fmt.Errorf("acquire certificate CNG private key: %w", err))
	}
	if state.key == 0 {
		return nil, cleanup(errors.New("CryptAcquireCertificatePrivateKey returned a null handle"))
	}
	if keySpec != windows.CERT_NCRYPT_KEY_SPEC {
		return nil, cleanup(fmt.Errorf("%w: acquired key spec is 0x%08x instead of CERT_NCRYPT_KEY_SPEC", ErrInvalidKey, keySpec))
	}

	keyIdentity, err := validateNativeKey(api, state.key, &certificatePublicKey, providerInfo, config)
	if err != nil {
		return nil, cleanup(err)
	}

	state.tlsCertificate = tlsCertificate
	state.publicKey = certificatePublicKey
	state.keyIdentity = keyIdentity
	state.validFrom = validFrom
	state.validUntil = validUntil
	return credential, nil
}

func findPinnedCertificate(
	api nativeAPI,
	store nativeStore,
	expectedDigest [p256DigestBytes]byte,
) (nativeCertificate, []byte, error) {
	var previous nativeCertificate
	var selected nativeCertificate
	var selectedDER []byte
	releaseSelected := func(primary error) error {
		return errors.Join(primary, freeNativeCertificate(api, selected))
	}
	for count := 0; count < maximumStoreCertificates; count++ {
		current, err := api.enumCertificates(store, previous)
		previous = nil
		if err != nil {
			if errors.Is(err, errNoMoreCertificates) {
				if selected != nil {
					return selected, selectedDER, nil
				}
				return nil, nil, ErrCertificateNotFound
			}
			return nil, nil, releaseSelected(fmt.Errorf("enumerate Local Machine certificate store: %w", err))
		}
		if current == nil {
			return nil, nil, releaseSelected(errors.New("CertEnumCertificatesInStore returned a null context without an error"))
		}
		previous = current
		der, err := api.certificateDER(current)
		if err != nil {
			previous = nil
			return nil, nil, errors.Join(
				fmt.Errorf("copy certificate DER: %w", err),
				freeNativeCertificate(api, current),
				freeNativeCertificate(api, selected),
			)
		}
		if len(der) == 0 || len(der) > maximumCertificateDERBytes {
			previous = nil
			return nil, nil, errors.Join(
				fmt.Errorf("%w: store certificate DER size is outside the supported range", ErrInvalidCertificate),
				freeNativeCertificate(api, current),
				freeNativeCertificate(api, selected),
			)
		}
		if certificateDigestMatches(expectedDigest, der) {
			if selected != nil {
				previous = nil
				return nil, nil, errors.Join(
					ErrDuplicateCertificate,
					freeNativeCertificate(api, current),
					freeNativeCertificate(api, selected),
				)
			}
			duplicate, err := api.duplicateCertificate(current)
			if err != nil {
				previous = nil
				return nil, nil, errors.Join(
					fmt.Errorf("duplicate pinned certificate context: %w", err),
					freeNativeCertificate(api, current),
				)
			}
			if duplicate == nil {
				previous = nil
				return nil, nil, errors.Join(
					errors.New("CertDuplicateCertificateContext returned a null context"),
					freeNativeCertificate(api, current),
				)
			}
			selected = duplicate
			selectedDER = der
		}
	}
	return nil, nil, errors.Join(
		ErrEnumerationLimit,
		freeNativeCertificate(api, previous),
		freeNativeCertificate(api, selected),
	)
}

func validateNativeKey(
	api nativeAPI,
	key nativeKey,
	certificatePublicKey *ecdsa.PublicKey,
	providerInfo certificateProviderInfo,
	config Config,
) (KeyIdentity, error) {
	algorithm, err := api.getKeyProperty(key, ncryptAlgorithmProperty, maximumAlgorithmPropertyBytes)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read CNG Algorithm property: %w", err)
	}
	length, err := api.getKeyProperty(key, ncryptLengthProperty, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read CNG Length property: %w", err)
	}
	exportPolicy, err := api.getKeyProperty(key, ncryptExportPolicyProperty, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read CNG Export Policy property: %w", err)
	}
	keyUsage, err := api.getKeyProperty(key, ncryptKeyUsageProperty, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read CNG Key Usage property: %w", err)
	}
	keyTypeValue, err := api.getKeyProperty(key, ncryptKeyTypeProperty, uint32PropertyBytes)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read CNG Key Type property: %w", err)
	}
	keyType, err := decodeUint32Property(keyTypeValue)
	if err != nil || keyType != cryptMachineKeysetFlag {
		return KeyIdentity{}, fmt.Errorf("%w: Key Type is not machine-key only", ErrInvalidKey)
	}
	uniqueNameValue, err := api.getKeyProperty(key, ncryptUniqueNameProperty, maximumUniqueNamePropertyBytes)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read CNG Unique Name property: %w", err)
	}
	uniqueName, err := decodeUTF16Property(uniqueNameValue)
	if err != nil || !validCNGName(uniqueName, 256) {
		return KeyIdentity{}, fmt.Errorf("%w: Unique Name is missing or invalid", ErrInvalidKey)
	}
	keyNameValue, err := api.getKeyProperty(key, ncryptNameProperty, maximumUniqueNamePropertyBytes)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read CNG Name property: %w", err)
	}
	keyName, err := decodeUTF16Property(keyNameValue)
	if err != nil || keyName != providerInfo.containerName {
		return KeyIdentity{}, fmt.Errorf("%w: key Name does not match the certificate container", ErrInvalidKey)
	}
	actualProviderName, providerImplementation, err := api.readKeyProviderIdentity(key)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read acquired CNG provider name: %w", err)
	}
	if actualProviderName != approvedKeyStorageProvider || actualProviderName != providerInfo.providerName ||
		providerImplementation != ncryptSoftwareImplementationFlag {
		return KeyIdentity{}, fmt.Errorf("%w: acquired key provider is not the approved certificate provider", ErrInvalidKey)
	}
	properties, err := parseKeyProperties(algorithm, length, exportPolicy, keyUsage)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("%w: %v", ErrInvalidKey, err)
	}
	if err := validateP256SigningProperties(properties); err != nil {
		return KeyIdentity{}, err
	}

	publicBlob, err := api.exportPublicKey(key, ncryptECCPublicBlob, maximumPublicBlobBytes)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("export CNG public key: %w", err)
	}
	cngPublicKey, err := parseP256PublicBlob(publicBlob)
	if err != nil {
		return KeyIdentity{}, err
	}
	if err := validateMatchingPublicKeys(certificatePublicKey, cngPublicKey); err != nil {
		return KeyIdentity{}, err
	}
	securityEvidence, err := api.readKeySecurityEvidence(key)
	if err != nil {
		return KeyIdentity{}, fmt.Errorf("read CNG key security descriptor: %w", err)
	}
	if err := validateKeySecurityEvidence(
		securityEvidence,
		config.ExpectedKeySecurityDescriptorSHA256,
		config.ControlServiceSID,
		config.ExecutorServiceSID,
	); err != nil {
		return KeyIdentity{}, err
	}
	return KeyIdentity{
		ProviderName: actualProviderName,
		UniqueName:   uniqueName,
		MachineKey:   true,
	}, nil
}

// TLSCertificate returns a detached copy of the leaf-first certificate chain.
// A self-signed root is never included in the returned chain.
func (c *Credential) TLSCertificate() tls.Certificate {
	if c == nil || c.state == nil {
		return tls.Certificate{}
	}
	return cloneTLSCertificate(c.state.tlsCertificate, c)
}

// Public returns a detached copy of the certificate's ECDSA P-256 public key.
func (c *Credential) Public() crypto.PublicKey {
	if c == nil || c.state == nil {
		return nil
	}
	publicKey := clonePublicKey(&c.state.publicKey)
	return &publicKey
}

// Identity returns detached, non-secret identity for the persisted CNG key.
func (c *Credential) Identity() KeyIdentity {
	if c == nil || c.state == nil {
		return KeyIdentity{}
	}
	return c.state.keyIdentity
}

// KeyIdentity returns the same detached identity as Identity.
func (c *Credential) KeyIdentity() KeyIdentity {
	return c.Identity()
}

// Sign signs an exactly 32-byte SHA-256 digest and returns ASN.1 DER ECDSA.
func (c *Credential) Sign(_ io.Reader, digest []byte, options crypto.SignerOpts) ([]byte, error) {
	if len(digest) != p256DigestBytes {
		return nil, ErrInvalidDigest
	}
	var digestSnapshot [p256DigestBytes]byte
	copy(digestSnapshot[:], digest)
	if options == nil || options.HashFunc() != crypto.SHA256 {
		return nil, ErrUnsupportedSignerOptions
	}
	if c == nil || c.state == nil {
		return nil, ErrClosed
	}

	state := c.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed || state.key == 0 {
		return nil, ErrClosed
	}
	now := time.Now()
	if now.Before(state.validFrom) || now.After(state.validUntil) {
		return nil, fmt.Errorf("%w: transmitted certificate chain is not currently valid", ErrInvalidCertificate)
	}
	signature, err := state.api.signHash(state.key, digestSnapshot[:], ncryptSilentFlag)
	if err != nil {
		return nil, fmt.Errorf("sign certificate digest with CNG: %w", err)
	}
	encoded, err := p256SignatureToASN1(signature)
	if err != nil {
		return nil, err
	}
	if !ecdsa.VerifyASN1(&state.publicKey, digestSnapshot[:], encoded) {
		return nil, fmt.Errorf("%w: signature does not verify against the pinned certificate", ErrInvalidSignature)
	}
	return encoded, nil
}

// Close permanently disables signing, releases every native resource it can,
// and retains failed releases for a later retry. It is safe to call
// concurrently with Sign and to call repeatedly or through a value copy.
func (c *Credential) Close() error {
	if c == nil || c.state == nil {
		return nil
	}
	state := c.state
	state.mu.Lock()
	defer state.mu.Unlock()
	state.closed = true

	var result error
	if state.key != 0 && state.callerFreeKey {
		if err := freeNativeKey(state.api, state.key, true); err != nil {
			result = errors.Join(result, err)
		} else {
			state.key = 0
			state.callerFreeKey = false
		}
	}
	if state.certificate != nil {
		if err := freeNativeCertificate(state.api, state.certificate); err != nil {
			result = errors.Join(result, err)
		} else {
			state.certificate = nil
			if !state.callerFreeKey {
				state.key = 0
			}
		}
	}
	if state.certificate == nil && !state.callerFreeKey {
		state.key = 0
	}
	if state.store != 0 {
		if err := closeNativeStore(state.api, state.store); err != nil {
			result = errors.Join(result, err)
		} else {
			state.store = 0
		}
	}
	if state.key == 0 {
		state.callerFreeKey = false
	}
	return result
}

func discardCredential(credential *Credential) error {
	var failures error
	for attempt := 0; attempt < discardFreeAttempts; attempt++ {
		err := credential.Close()
		if err == nil {
			return nil
		}
		failures = errors.Join(failures, err)
	}
	return failures
}

func freeNativeKey(api nativeAPI, key nativeKey, callerFree bool) error {
	if key == 0 || !callerFree {
		return nil
	}
	if err := api.freeKey(key); err != nil {
		return fmt.Errorf("free acquired CNG key: %w", err)
	}
	return nil
}

func freeNativeCertificate(api nativeAPI, certificate nativeCertificate) error {
	if certificate == nil {
		return nil
	}
	if err := api.freeCertificate(certificate); err != nil {
		return fmt.Errorf("free certificate context: %w", err)
	}
	return nil
}

func closeNativeStore(api nativeAPI, store nativeStore) error {
	if store == 0 {
		return nil
	}
	if err := api.closeStore(store, certificateStoreCloseFlags); err != nil {
		return fmt.Errorf("close certificate store: %w", err)
	}
	return nil
}

func ensureNCryptAvailable() error {
	ncryptLoadOnce.Do(func() {
		if err := crypt32DLL.Load(); err != nil {
			ncryptLoadErr = fmt.Errorf("load crypt32.dll: %w", err)
			return
		}
		if err := certGetCertificateContextProperty.Find(); err != nil {
			ncryptLoadErr = fmt.Errorf("resolve %s: %w", certGetCertificateContextProperty.Name, err)
			return
		}
		if err := ncryptDLL.Load(); err != nil {
			ncryptLoadErr = fmt.Errorf("load ncrypt.dll: %w", err)
			return
		}
		for _, procedure := range []*windows.LazyProc{
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

func (systemAPI) openStore(provider uintptr, encoding uint32, name string, flags uint32) (nativeStore, error) {
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, fmt.Errorf("encode certificate store name: %w", err)
	}
	store, err := windows.CertOpenStore(
		provider,
		encoding,
		0,
		flags,
		uintptr(unsafe.Pointer(namePointer)),
	)
	runtime.KeepAlive(namePointer)
	if err != nil {
		return 0, err
	}
	if store == 0 {
		return 0, errors.New("CertOpenStore returned a null handle")
	}
	return nativeStore(store), nil
}

func (systemAPI) enumCertificates(store nativeStore, previous nativeCertificate) (nativeCertificate, error) {
	context, err := windows.CertEnumCertificatesInStore(windows.Handle(store), previous)
	runtime.KeepAlive(previous)
	if err != nil {
		if errors.Is(err, syscall.Errno(windows.CRYPT_E_NOT_FOUND)) {
			return nil, errNoMoreCertificates
		}
		return nil, err
	}
	if context == nil {
		return nil, errors.New("CertEnumCertificatesInStore returned a null context")
	}
	return context, nil
}

func (systemAPI) duplicateCertificate(certificate nativeCertificate) (nativeCertificate, error) {
	duplicate := windows.CertDuplicateCertificateContext(certificate)
	if duplicate == nil {
		return nil, errors.New("CertDuplicateCertificateContext returned a null context")
	}
	return duplicate, nil
}

func (systemAPI) certificateDER(certificate nativeCertificate) ([]byte, error) {
	context := certificate
	if context == nil || context.EncodedCert == nil || context.Length == 0 ||
		context.Length > maximumCertificateDERBytes {
		return nil, errors.New("certificate context contains an invalid DER buffer")
	}
	der := append([]byte(nil), unsafe.Slice(context.EncodedCert, int(context.Length))...)
	runtime.KeepAlive(context)
	return der, nil
}

func (systemAPI) readCertificateProviderInfo(certificate nativeCertificate) (certificateProviderInfo, error) {
	context := certificate
	var requiredBytes uint32
	result, _, callErr := certGetCertificateContextProperty.Call(
		uintptr(unsafe.Pointer(context)),
		uintptr(certificateKeyProviderInfoProperty),
		0,
		uintptr(unsafe.Pointer(&requiredBytes)),
	)
	runtime.KeepAlive(context)
	if result == 0 {
		return certificateProviderInfo{}, win32CallError("CertGetCertificateContextProperty", callErr)
	}
	minimumBytes := uint32(unsafe.Sizeof(cryptKeyProviderInfo{}))
	if requiredBytes < minimumBytes || requiredBytes > maximumProviderInfoBytes {
		return certificateProviderInfo{}, fmt.Errorf("CertGetCertificateContextProperty reported an invalid provider-info size of %d bytes", requiredBytes)
	}

	value := make([]byte, requiredBytes)
	writtenBytes := requiredBytes
	result, _, callErr = certGetCertificateContextProperty.Call(
		uintptr(unsafe.Pointer(context)),
		uintptr(certificateKeyProviderInfoProperty),
		uintptr(unsafe.Pointer(&value[0])),
		uintptr(unsafe.Pointer(&writtenBytes)),
	)
	runtime.KeepAlive(context)
	if result == 0 {
		return certificateProviderInfo{}, win32CallError("CertGetCertificateContextProperty", callErr)
	}
	if writtenBytes != requiredBytes {
		return certificateProviderInfo{}, fmt.Errorf("CertGetCertificateContextProperty changed the provider-info size from %d to %d bytes", requiredBytes, writtenBytes)
	}

	nativeInfo := (*cryptKeyProviderInfo)(unsafe.Pointer(&value[0]))
	containerName, err := utf16StringWithinBuffer(value, nativeInfo.containerName, 256)
	if err != nil {
		return certificateProviderInfo{}, fmt.Errorf("decode CNG container name: %w", err)
	}
	providerName, err := utf16StringWithinBuffer(value, nativeInfo.providerName, 128)
	if err != nil {
		return certificateProviderInfo{}, fmt.Errorf("decode CNG provider name: %w", err)
	}
	info := certificateProviderInfo{
		containerName:         containerName,
		providerName:          providerName,
		providerType:          nativeInfo.providerType,
		flags:                 nativeInfo.flags,
		parameterCount:        nativeInfo.parameterCount,
		hasProviderParameters: nativeInfo.parameters != nil,
		keySpec:               nativeInfo.keySpec,
	}
	runtime.KeepAlive(value)
	return info, nil
}

func utf16StringWithinBuffer(value []byte, pointer *uint16, maximumUnits int) (string, error) {
	if len(value) == 0 || pointer == nil || maximumUnits <= 0 {
		return "", errors.New("string pointer is missing")
	}
	base := uintptr(unsafe.Pointer(&value[0]))
	end := base + uintptr(len(value))
	address := uintptr(unsafe.Pointer(pointer))
	if end < base || address < base || address >= end || (address-base)%2 != 0 {
		return "", errors.New("string pointer is outside the provider-info buffer")
	}
	availableUnits := int((end - address) / 2)
	if availableUnits > maximumUnits {
		availableUnits = maximumUnits
	}
	units := unsafe.Slice(pointer, availableUnits)
	terminator := -1
	for index, unit := range units {
		if unit == 0 {
			terminator = index
			break
		}
	}
	if terminator < 0 {
		return "", errors.New("string is not null-terminated within its bound")
	}
	encoded := make([]byte, 2*(terminator+1))
	copy(encoded, unsafe.Slice((*byte)(unsafe.Pointer(pointer)), len(encoded)))
	return decodeUTF16Property(encoded)
}

func win32CallError(operation string, callErr error) error {
	if callErr == nil || errors.Is(callErr, windows.ERROR_SUCCESS) {
		return fmt.Errorf("%s failed without a Win32 error", operation)
	}
	return fmt.Errorf("%s failed: %w", operation, callErr)
}

func (systemAPI) getCertificateChain(
	engine nativeChainEngine,
	certificate nativeCertificate,
	additionalStore nativeStore,
	flags uint32,
) (nativeChain, error) {
	parameters := windows.CertChainPara{Size: uint32(unsafe.Sizeof(windows.CertChainPara{}))}
	var chain *windows.CertChainContext
	err := windows.CertGetCertificateChain(
		windows.Handle(engine),
		certificate,
		nil,
		windows.Handle(additionalStore),
		&parameters,
		flags,
		0,
		&chain,
	)
	runtime.KeepAlive(parameters)
	if err != nil {
		if chain != nil {
			return chain, err
		}
		return nil, err
	}
	if chain == nil {
		return nil, errors.New("CertGetCertificateChain returned a null context")
	}
	return chain, nil
}

func (systemAPI) certificateChainDER(chain nativeChain) ([][]byte, error) {
	context := chain
	if context == nil || context.ChainCount != 1 || context.Chains == nil {
		return nil, errors.New("certificate chain does not contain exactly one simple chain")
	}
	chains := unsafe.Slice(context.Chains, int(context.ChainCount))
	if chains[0] == nil || chains[0].NumElements == 0 ||
		chains[0].NumElements > maximumChainCertificates || chains[0].Elements == nil {
		return nil, errors.New("certificate simple chain has an invalid element count")
	}
	elements := unsafe.Slice(chains[0].Elements, int(chains[0].NumElements))
	result := make([][]byte, len(elements))
	totalBytes := 0
	for index, element := range elements {
		if element == nil || element.CertContext == nil {
			return nil, errors.New("certificate chain contains a null element")
		}
		der, err := (systemAPI{}).certificateDER(element.CertContext)
		if err != nil {
			return nil, fmt.Errorf("copy certificate chain element %d: %w", index, err)
		}
		totalBytes += len(der)
		if totalBytes > maximumChainDERBytes {
			return nil, errors.New("certificate chain exceeds its aggregate byte limit")
		}
		result[index] = der
	}
	runtime.KeepAlive(context)
	return result, nil
}

func (systemAPI) freeCertificateChain(chain nativeChain) {
	if chain != nil {
		windows.CertFreeCertificateChain(chain)
	}
}

func (systemAPI) acquirePrivateKey(
	certificate nativeCertificate,
	flags uint32,
) (nativeKey, uint32, bool, error) {
	var key windows.Handle
	var keySpec uint32
	var callerFree bool
	err := windows.CryptAcquireCertificatePrivateKey(
		certificate,
		flags,
		nil,
		&key,
		&keySpec,
		&callerFree,
	)
	if err != nil {
		return 0, 0, false, err
	}
	return nativeKey(key), keySpec, callerFree, nil
}

func (systemAPI) getKeyProperty(key nativeKey, name string, maximumBytes uint32) ([]byte, error) {
	return readNativeKeyProperty(key, name, maximumBytes, ncryptSilentFlag)
}

func (systemAPI) readKeyProviderIdentity(key nativeKey) (string, uint32, error) {
	propertyPointer, err := windows.UTF16PtrFromString(ncryptProviderHandleProperty)
	if err != nil {
		return "", 0, fmt.Errorf("encode CNG provider-handle property name: %w", err)
	}
	var provider nativeKey
	var writtenBytes uint32
	status, _, _ := ncryptGetProperty.Call(
		uintptr(key),
		uintptr(unsafe.Pointer(propertyPointer)),
		uintptr(unsafe.Pointer(&provider)),
		unsafe.Sizeof(provider),
		uintptr(unsafe.Pointer(&writtenBytes)),
		uintptr(ncryptSilentFlag),
	)
	runtime.KeepAlive(propertyPointer)
	if statusErr := securityStatusError("NCryptGetProperty", status); statusErr != nil {
		if provider != 0 {
			return "", 0, errors.Join(statusErr, (systemAPI{}).freeKey(provider))
		}
		return "", 0, statusErr
	}
	if provider == 0 || writtenBytes != uint32(unsafe.Sizeof(provider)) {
		invalidErr := errors.New("NCryptGetProperty returned an invalid provider handle")
		if provider != 0 {
			return "", 0, errors.Join(invalidErr, (systemAPI{}).freeKey(provider))
		}
		return "", 0, invalidErr
	}

	nameValue, nameErr := readNativeKeyProperty(
		provider,
		ncryptNameProperty,
		maximumProviderNamePropertyBytes,
		ncryptSilentFlag,
	)
	implementationValue, implementationErr := readNativeKeyProperty(
		provider,
		ncryptImplementationProperty,
		uint32PropertyBytes,
		ncryptSilentFlag,
	)
	freeErr := (systemAPI{}).freeKey(provider)
	if nameErr != nil || implementationErr != nil {
		return "", 0, errors.Join(nameErr, implementationErr, freeErr)
	}
	name, decodeErr := decodeUTF16Property(nameValue)
	if decodeErr != nil {
		return "", 0, errors.Join(fmt.Errorf("decode CNG provider name: %w", decodeErr), freeErr)
	}
	implementation, decodeImplementationErr := decodeUint32Property(implementationValue)
	if decodeImplementationErr != nil {
		return "", 0, errors.Join(fmt.Errorf("decode CNG provider implementation: %w", decodeImplementationErr), freeErr)
	}
	if freeErr != nil {
		return "", 0, fmt.Errorf("free CNG provider handle: %w", freeErr)
	}
	return name, implementation, nil
}

func readNativeKeyProperty(key nativeKey, name string, maximumBytes uint32, flags uint32) ([]byte, error) {
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, fmt.Errorf("encode CNG property name: %w", err)
	}
	var requiredBytes uint32
	status, _, _ := ncryptGetProperty.Call(
		uintptr(key),
		uintptr(unsafe.Pointer(namePointer)),
		0,
		0,
		uintptr(unsafe.Pointer(&requiredBytes)),
		uintptr(flags),
	)
	runtime.KeepAlive(namePointer)
	if err := securityStatusError("NCryptGetProperty", status); err != nil {
		return nil, err
	}
	if requiredBytes == 0 || requiredBytes > maximumBytes {
		return nil, fmt.Errorf("NCryptGetProperty reported an invalid %s size of %d bytes", name, requiredBytes)
	}

	value := make([]byte, requiredBytes)
	var writtenBytes uint32
	status, _, _ = ncryptGetProperty.Call(
		uintptr(key),
		uintptr(unsafe.Pointer(namePointer)),
		uintptr(unsafe.Pointer(&value[0])),
		uintptr(len(value)),
		uintptr(unsafe.Pointer(&writtenBytes)),
		uintptr(flags),
	)
	runtime.KeepAlive(namePointer)
	runtime.KeepAlive(value)
	if err := securityStatusError("NCryptGetProperty", status); err != nil {
		return nil, err
	}
	if writtenBytes != requiredBytes {
		return nil, fmt.Errorf("NCryptGetProperty changed the %s size from %d to %d bytes", name, requiredBytes, writtenBytes)
	}
	return value, nil
}

func (systemAPI) readKeySecurityEvidence(key nativeKey) (keySecurityEvidence, error) {
	value, err := readNativeKeyProperty(
		key,
		ncryptSecurityDescriptorProperty,
		maximumKeySecurityDescriptorBytes,
		keySecurityInformation,
	)
	if err != nil {
		return keySecurityEvidence{}, err
	}
	return parseKeySecurityDescriptor(value)
}

func (systemAPI) exportPublicKey(key nativeKey, blobType string, maximumBytes uint32) ([]byte, error) {
	blobTypePointer, err := windows.UTF16PtrFromString(blobType)
	if err != nil {
		return nil, fmt.Errorf("encode CNG blob type: %w", err)
	}
	var requiredBytes uint32
	status, _, _ := ncryptExportKey.Call(
		uintptr(key),
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
		uintptr(key),
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

func (systemAPI) signHash(key nativeKey, digest []byte, flags uint32) ([]byte, error) {
	if len(digest) != p256DigestBytes {
		return nil, ErrInvalidDigest
	}
	var requiredBytes uint32
	status, _, _ := ncryptSignHash.Call(
		uintptr(key),
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
	if requiredBytes != p256SignatureBytes {
		return nil, fmt.Errorf("NCryptSignHash reported a %d-byte signature instead of %d bytes", requiredBytes, p256SignatureBytes)
	}

	signature := make([]byte, p256SignatureBytes)
	var writtenBytes uint32
	status, _, _ = ncryptSignHash.Call(
		uintptr(key),
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
	if writtenBytes != p256SignatureBytes {
		return nil, fmt.Errorf("NCryptSignHash wrote a %d-byte signature instead of %d bytes", writtenBytes, p256SignatureBytes)
	}
	return signature, nil
}

func (systemAPI) freeKey(key nativeKey) error {
	status, _, _ := ncryptFreeObject.Call(uintptr(key))
	return securityStatusError("NCryptFreeObject", status)
}

func (systemAPI) freeCertificate(certificate nativeCertificate) error {
	return windows.CertFreeCertificateContext(certificate)
}

func (systemAPI) closeStore(store nativeStore, flags uint32) error {
	return windows.CertCloseStore(windows.Handle(store), flags)
}

func securityStatusError(operation string, status uintptr) error {
	code := uint32(status)
	if code == 0 {
		return nil
	}
	return &cng.StatusError{Operation: operation, Code: code}
}

var _ crypto.Signer = (*Credential)(nil)
