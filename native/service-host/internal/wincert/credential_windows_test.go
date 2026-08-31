//go:build windows

package wincert

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"golang.org/x/sys/windows"
)

type keyPropertyRequest struct {
	name         string
	maximumBytes uint32
}

type fakeNativeAPI struct {
	storeHandle                  nativeStore
	certificateOrder             []nativeCertificate
	certificateValues            map[nativeCertificate][]byte
	duplicateHandle              nativeCertificate
	providerInfo                 certificateProviderInfo
	chainHandle                  nativeChain
	chainValues                  [][]byte
	keyHandle                    nativeKey
	keySpec                      uint32
	callerFreeKey                bool
	properties                   map[string][]byte
	actualProviderName           string
	actualProviderImplementation uint32
	securityEvidence             keySecurityEvidence
	publicBlob                   []byte
	signature                    []byte
	signingKey                   *ecdsa.PrivateKey
	signStarted                  chan struct{}
	signRelease                  <-chan struct{}
	signStartOnce                sync.Once
	afterSign                    func()

	openProvider      uintptr
	openEncoding      uint32
	openName          string
	openFlags         uint32
	enumIndex         int
	enumCalls         int
	consumed          []nativeCertificate
	duplicateSource   nativeCertificate
	duplicateCalls    int
	providerInfoCert  nativeCertificate
	providerInfoCalls int
	chainEngine       nativeChainEngine
	chainLeaf         nativeCertificate
	chainStore        nativeStore
	chainFlags        uint32
	freedChains       []nativeChain
	acquireCert       nativeCertificate
	acquireFlags      uint32
	propertyReads     []keyPropertyRequest
	providerNameKey   nativeKey
	providerNameReads int
	securityKey       nativeKey
	securityReads     int
	exportKey         nativeKey
	exportType        string
	exportMaximum     uint32
	signKey           nativeKey
	signDigest        []byte
	signFlags         uint32
	signCalls         int
	freedKeys         []nativeKey
	freedCertificates []nativeCertificate
	closedStores      []nativeStore
	closeFlags        []uint32
	releaseEvents     []string

	openErr              error
	duplicateErr         error
	providerInfoErr      error
	chainErr             error
	chainCopyErr         error
	acquireErr           error
	exportErr            error
	providerNameErr      error
	securityErr          error
	signErr              error
	freeKeyErr           error
	freeKeyErrorCount    int
	freeCertErr          error
	freeCertErrorCount   int
	closeStoreErr        error
	closeStoreErrorCount int
}

func (f *fakeNativeAPI) openStore(provider uintptr, encoding uint32, name string, flags uint32) (nativeStore, error) {
	f.openProvider = provider
	f.openEncoding = encoding
	f.openName = name
	f.openFlags = flags
	return f.storeHandle, f.openErr
}

func (f *fakeNativeAPI) enumCertificates(_ nativeStore, previous nativeCertificate) (nativeCertificate, error) {
	f.enumCalls++
	if previous != nil {
		f.consumed = append(f.consumed, previous)
	}
	if f.enumIndex >= len(f.certificateOrder) {
		return nil, errNoMoreCertificates
	}
	certificate := f.certificateOrder[f.enumIndex]
	f.enumIndex++
	return certificate, nil
}

func (f *fakeNativeAPI) duplicateCertificate(certificate nativeCertificate) (nativeCertificate, error) {
	f.duplicateSource = certificate
	f.duplicateCalls++
	return f.duplicateHandle, f.duplicateErr
}

func (f *fakeNativeAPI) certificateDER(certificate nativeCertificate) ([]byte, error) {
	value, exists := f.certificateValues[certificate]
	if !exists {
		return nil, fmt.Errorf("unknown certificate %p", certificate)
	}
	return bytes.Clone(value), nil
}

func (f *fakeNativeAPI) readCertificateProviderInfo(certificate nativeCertificate) (certificateProviderInfo, error) {
	f.providerInfoCert = certificate
	f.providerInfoCalls++
	return f.providerInfo, f.providerInfoErr
}

func (f *fakeNativeAPI) getCertificateChain(
	engine nativeChainEngine,
	leaf nativeCertificate,
	store nativeStore,
	flags uint32,
) (nativeChain, error) {
	f.chainEngine = engine
	f.chainLeaf = leaf
	f.chainStore = store
	f.chainFlags = flags
	return f.chainHandle, f.chainErr
}

func (f *fakeNativeAPI) certificateChainDER(nativeChain) ([][]byte, error) {
	result := make([][]byte, len(f.chainValues))
	for index, der := range f.chainValues {
		result[index] = bytes.Clone(der)
	}
	return result, f.chainCopyErr
}

func (f *fakeNativeAPI) freeCertificateChain(chain nativeChain) {
	f.freedChains = append(f.freedChains, chain)
}

func (f *fakeNativeAPI) acquirePrivateKey(certificate nativeCertificate, flags uint32) (nativeKey, uint32, bool, error) {
	f.acquireCert = certificate
	f.acquireFlags = flags
	return f.keyHandle, f.keySpec, f.callerFreeKey, f.acquireErr
}

func (f *fakeNativeAPI) getKeyProperty(_ nativeKey, name string, maximumBytes uint32) ([]byte, error) {
	f.propertyReads = append(f.propertyReads, keyPropertyRequest{name: name, maximumBytes: maximumBytes})
	value, exists := f.properties[name]
	if !exists {
		return nil, fmt.Errorf("missing property %s", name)
	}
	return bytes.Clone(value), nil
}

func (f *fakeNativeAPI) readKeyProviderIdentity(key nativeKey) (string, uint32, error) {
	f.providerNameKey = key
	f.providerNameReads++
	return f.actualProviderName, f.actualProviderImplementation, f.providerNameErr
}

func (f *fakeNativeAPI) readKeySecurityEvidence(key nativeKey) (keySecurityEvidence, error) {
	f.securityKey = key
	f.securityReads++
	evidence := f.securityEvidence
	evidence.raw = bytes.Clone(evidence.raw)
	evidence.entries = append([]keySecurityACE(nil), evidence.entries...)
	return evidence, f.securityErr
}

func (f *fakeNativeAPI) exportPublicKey(key nativeKey, blobType string, maximumBytes uint32) ([]byte, error) {
	f.exportKey = key
	f.exportType = blobType
	f.exportMaximum = maximumBytes
	return bytes.Clone(f.publicBlob), f.exportErr
}

func (f *fakeNativeAPI) signHash(key nativeKey, digest []byte, flags uint32) ([]byte, error) {
	f.signKey = key
	f.signDigest = bytes.Clone(digest)
	f.signFlags = flags
	f.signCalls++
	if f.signStarted != nil {
		f.signStartOnce.Do(func() { close(f.signStarted) })
	}
	if f.signRelease != nil {
		<-f.signRelease
	}
	if f.afterSign != nil {
		f.afterSign()
	}
	return bytes.Clone(f.signature), f.signErr
}

func (f *fakeNativeAPI) freeKey(key nativeKey) error {
	f.freedKeys = append(f.freedKeys, key)
	f.releaseEvents = append(f.releaseEvents, "key")
	if f.freeKeyErr != nil && f.freeKeyErrorCount != 0 {
		if f.freeKeyErrorCount > 0 {
			f.freeKeyErrorCount--
		}
		return f.freeKeyErr
	}
	return nil
}

func (f *fakeNativeAPI) freeCertificate(certificate nativeCertificate) error {
	f.freedCertificates = append(f.freedCertificates, certificate)
	f.releaseEvents = append(f.releaseEvents, "certificate")
	if f.freeCertErr != nil && f.freeCertErrorCount != 0 {
		if f.freeCertErrorCount > 0 {
			f.freeCertErrorCount--
		}
		return f.freeCertErr
	}
	return nil
}

func (f *fakeNativeAPI) closeStore(store nativeStore, flags uint32) error {
	f.closedStores = append(f.closedStores, store)
	f.closeFlags = append(f.closeFlags, flags)
	f.releaseEvents = append(f.releaseEvents, "store")
	if f.closeStoreErr != nil && f.closeStoreErrorCount != 0 {
		if f.closeStoreErrorCount > 0 {
			f.closeStoreErrorCount--
		}
		return f.closeStoreErr
	}
	return nil
}

func TestWindowsAcquireUsesPinnedRestrictedStoreAndCNGContract(t *testing.T) {
	api, config, selectedHandle := validFakeNativeAPI(t)
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}

	if api.openProvider != certificateStoreProvider || api.openEncoding != certificateStoreEncoding ||
		api.openName != LocalMachinePersonalStore || api.openFlags != certificateStoreOpenFlags {
		t.Fatalf("unexpected store open contract: provider=%d encoding=%d name=%q flags=0x%x", api.openProvider, api.openEncoding, api.openName, api.openFlags)
	}
	if api.enumCalls != 3 || !reflect.DeepEqual(api.consumed, api.certificateOrder) {
		t.Fatalf("unexpected enumeration ownership: calls=%d consumed=%v", api.enumCalls, api.consumed)
	}
	if api.duplicateSource != api.certificateOrder[1] || api.duplicateCalls != 1 {
		t.Fatalf("pinned context was not duplicated exactly once: source=%p calls=%d", api.duplicateSource, api.duplicateCalls)
	}
	if api.providerInfoCert != selectedHandle || api.providerInfoCalls != 1 {
		t.Fatalf("certificate provider info was not read from the selected context: certificate=%p calls=%d", api.providerInfoCert, api.providerInfoCalls)
	}
	if api.chainEngine != localMachineChainEngine || api.chainLeaf != selectedHandle ||
		api.chainStore != api.storeHandle || api.chainFlags != certificateChainFlags {
		t.Fatalf("unexpected chain contract: engine=%d leaf=%p store=%d flags=0x%x", api.chainEngine, api.chainLeaf, api.chainStore, api.chainFlags)
	}
	if !reflect.DeepEqual(api.freedChains, []nativeChain{api.chainHandle}) {
		t.Fatalf("chain context was not released exactly once: %v", api.freedChains)
	}
	if api.acquireCert != selectedHandle || api.acquireFlags != certificateAcquireFlags {
		t.Fatalf("unexpected private-key acquisition: certificate=%p flags=0x%x", api.acquireCert, api.acquireFlags)
	}
	expectedProperties := []keyPropertyRequest{
		{name: ncryptAlgorithmProperty, maximumBytes: maximumAlgorithmPropertyBytes},
		{name: ncryptLengthProperty, maximumBytes: uint32PropertyBytes},
		{name: ncryptExportPolicyProperty, maximumBytes: uint32PropertyBytes},
		{name: ncryptKeyUsageProperty, maximumBytes: uint32PropertyBytes},
		{name: ncryptKeyTypeProperty, maximumBytes: uint32PropertyBytes},
		{name: ncryptUniqueNameProperty, maximumBytes: maximumUniqueNamePropertyBytes},
		{name: ncryptNameProperty, maximumBytes: maximumUniqueNamePropertyBytes},
	}
	if !reflect.DeepEqual(api.propertyReads, expectedProperties) {
		t.Fatalf("unexpected CNG property reads: %#v", api.propertyReads)
	}
	if api.exportKey != api.keyHandle || api.exportType != ncryptECCPublicBlob || api.exportMaximum != maximumPublicBlobBytes {
		t.Fatalf("unexpected public-key export: key=%d type=%q maximum=%d", api.exportKey, api.exportType, api.exportMaximum)
	}
	if api.securityKey != api.keyHandle || api.securityReads != 1 {
		t.Fatalf("key security descriptor was not read exactly once: key=%d reads=%d", api.securityKey, api.securityReads)
	}
	if api.providerNameKey != api.keyHandle || api.providerNameReads != 1 {
		t.Fatalf("actual CNG provider name was not read exactly once: key=%d reads=%d", api.providerNameKey, api.providerNameReads)
	}
	if identity := credential.KeyIdentity(); identity != (KeyIdentity{
		ProviderName: approvedKeyStorageProvider,
		UniqueName:   "machine-key-unique-name",
		MachineKey:   true,
	}) {
		t.Fatalf("unexpected key identity: %#v", identity)
	}
	if credential.Identity() != credential.KeyIdentity() {
		t.Fatal("Identity and KeyIdentity returned different values")
	}

	first := credential.TLSCertificate()
	second := credential.TLSCertificate()
	if len(first.Certificate) != 2 || first.PrivateKey != credential || first.Leaf == nil {
		t.Fatalf("TLSCertificate returned an incomplete client credential: %#v", first)
	}
	first.Certificate[0][0] ^= 0xff
	first.Leaf.Raw[1] ^= 0xff
	if bytes.Equal(first.Certificate[0], second.Certificate[0]) || bytes.Equal(first.Leaf.Raw, second.Leaf.Raw) {
		t.Fatal("TLSCertificate returned aliased DER or parsed leaf data")
	}
	firstPublic := credential.Public().(*ecdsa.PublicKey)
	firstPublic.X.SetInt64(1)
	secondPublic := credential.Public().(*ecdsa.PublicKey)
	if secondPublic.X.Cmp(big.NewInt(1)) == 0 {
		t.Fatal("Public returned an aliased coordinate")
	}

	if err := credential.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("repeated Close returned an error: %v", err)
	}
	if !reflect.DeepEqual(api.releaseEvents, []string{"key", "certificate", "store"}) {
		t.Fatalf("native resources were not released in order: %v", api.releaseEvents)
	}
	if !reflect.DeepEqual(api.freedKeys, []nativeKey{api.keyHandle}) ||
		!reflect.DeepEqual(api.freedCertificates, []nativeCertificate{selectedHandle}) ||
		!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) ||
		!reflect.DeepEqual(api.closeFlags, []uint32{certificateStoreCloseFlags}) {
		t.Fatalf("unexpected native cleanup: keys=%v certificates=%v stores=%v flags=%v", api.freedKeys, api.freedCertificates, api.closedStores, api.closeFlags)
	}
}

func TestWindowsAttestationReportsObservedValuesAndReturnsCopies(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	defer credential.Close()

	attestation, err := credential.Attestation()
	if err != nil {
		t.Fatalf("Attestation returned an error: %v", err)
	}
	expectedCertificateDigest := sha256.Sum256(api.certificateValues[api.certificateOrder[1]])
	expectedSecurityDigest := sha256.Sum256(api.securityEvidence.raw)
	expectedContainerName := api.providerInfo.containerName
	expectedPublicDigest, err := p256PublicKeySPKISHA256(&api.signingKey.PublicKey)
	if err != nil {
		t.Fatalf("derive expected public-key digest: %v", err)
	}
	expectedIdentity := KeyIdentity{
		ProviderName: approvedKeyStorageProvider,
		UniqueName:   "machine-key-unique-name",
		MachineKey:   true,
	}
	if attestation.StoreScope() != LocalMachineStoreScope ||
		attestation.StoreName() != LocalMachinePersonalStore ||
		attestation.CertificateDERSHA256() != expectedCertificateDigest ||
		attestation.ContainerName() != expectedContainerName ||
		attestation.KeyName() != "machine-key" ||
		attestation.KeySecurityDescriptorSHA256() != expectedSecurityDigest ||
		attestation.KeyIdentity() != expectedIdentity ||
		attestation.PublicKeySPKISHA256() != expectedPublicDigest ||
		attestation.ValidatedControlServiceSID() != config.ControlServiceSID ||
		attestation.ValidatedExecutorServiceSID() != config.ExecutorServiceSID ||
		attestation.Algorithm() != "ECDSA_P256" ||
		attestation.KeyLengthBits() != 256 ||
		attestation.ExportPolicy() != 0 ||
		attestation.KeyUsage() != ncryptAllowSigningFlag {
		t.Fatalf("Attestation returned unexpected observed values: %#v", attestation)
	}

	var crossPurposeDigest [cng.DigestSize]byte = attestation.PublicKeySPKISHA256()
	if crossPurposeDigest != expectedPublicDigest {
		t.Fatal("public SPKI digest cannot be compared across credential purposes")
	}

	config.StoreName = "changed-store"
	config.CertificateSHA256 = strings.Repeat("0", 64)
	config.ExpectedKeySecurityDescriptorSHA256 = strings.Repeat("1", 64)
	config.ControlServiceSID = "S-1-5-80-11-12-13-14-15"
	config.ExecutorServiceSID = "S-1-5-80-16-17-18-19-20"
	api.providerInfo.containerName = "changed-container"
	api.actualProviderName = "changed-provider"
	api.properties[ncryptNameProperty] = encodeUTF16Property("changed-key")
	api.properties[ncryptAlgorithmProperty] = encodeUTF16Property("ECDSA_P384")
	api.properties[ncryptLengthProperty] = encodeUint32Property(384)
	api.properties[ncryptExportPolicyProperty] = encodeUint32Property(1)
	api.properties[ncryptKeyUsageProperty] = encodeUint32Property(0)
	api.securityEvidence.raw[0] ^= 0xff
	api.publicBlob[0] ^= 0xff
	api.certificateValues[api.certificateOrder[1]][0] ^= 0xff
	cached, err := credential.Attestation()
	if err != nil || cached != attestation {
		t.Fatalf("Attestation reread mutable native or configuration values: %#v, %v", cached, err)
	}

	attestation.storeScope = "mutated"
	attestation.containerName = "mutated"
	attestation.certificateDERSHA256[0] ^= 0xff
	attestation.keySecurityDescriptorSHA256[0] ^= 0xff
	attestation.publicKeySPKISHA256[0] ^= 0xff
	attestation.keyIdentity.UniqueName = "mutated"
	again, err := credential.Attestation()
	if err != nil {
		t.Fatalf("second Attestation returned an error: %v", err)
	}
	if again.StoreScope() != LocalMachineStoreScope ||
		again.ContainerName() != expectedContainerName ||
		again.CertificateDERSHA256() != expectedCertificateDigest ||
		again.KeySecurityDescriptorSHA256() != expectedSecurityDigest ||
		again.PublicKeySPKISHA256() != expectedPublicDigest ||
		again.KeyIdentity() != expectedIdentity {
		t.Fatal("Attestation returned state aliased by an earlier value")
	}
}

func TestWindowsAttestationFailsForNilIncompleteClosedAndExpiredCredentials(t *testing.T) {
	var nilCredential *Credential
	if _, err := nilCredential.Attestation(); !errors.Is(err, ErrClosed) {
		t.Fatalf("nil Attestation error = %v, want ErrClosed", err)
	}
	if _, err := (&Credential{}).Attestation(); !errors.Is(err, ErrClosed) {
		t.Fatalf("empty Attestation error = %v, want ErrClosed", err)
	}
	incomplete := &Credential{state: &credentialState{
		store:       1,
		certificate: &windows.CertContext{},
		key:         2,
	}}
	if _, err := incomplete.Attestation(); !errors.Is(err, ErrAttestationUnavailable) {
		t.Fatalf("incomplete Attestation error = %v, want ErrAttestationUnavailable", err)
	}

	api, config, _ := validFakeNativeAPI(t)
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	credential.state.mu.Lock()
	credential.state.validUntil = time.Now().Add(-time.Second)
	credential.state.mu.Unlock()
	if _, err := credential.Attestation(); !errors.Is(err, ErrInvalidCertificate) {
		t.Fatalf("expired Attestation error = %v, want ErrInvalidCertificate", err)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if _, err := credential.Attestation(); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed Attestation error = %v, want ErrClosed", err)
	}
}

func TestWindowsAttestationAndCloseAreConcurrentSafe(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}

	start := make(chan struct{})
	errorsSeen := make(chan error, 16)
	var readers sync.WaitGroup
	for range 16 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			<-start
			for range 100 {
				_, attestationErr := credential.Attestation()
				if attestationErr != nil && !errors.Is(attestationErr, ErrClosed) {
					errorsSeen <- attestationErr
					return
				}
			}
		}()
	}
	close(start)
	if err := credential.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	readers.Wait()
	close(errorsSeen)
	for attestationErr := range errorsSeen {
		t.Fatalf("concurrent Attestation returned an unexpected error: %v", attestationErr)
	}
	if _, err := credential.Attestation(); !errors.Is(err, ErrClosed) {
		t.Fatalf("Attestation after Close error = %v, want ErrClosed", err)
	}
}

func TestWindowsCallerFreeFalseNeverFreesBorrowedKey(t *testing.T) {
	api, config, selectedHandle := validFakeNativeAPI(t)
	api.callerFreeKey = false
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if len(api.freedKeys) != 0 {
		t.Fatalf("Close freed a borrowed CNG key: %v", api.freedKeys)
	}
	if !reflect.DeepEqual(api.freedCertificates, []nativeCertificate{selectedHandle}) ||
		!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
		t.Fatalf("Close did not release context and store: certificates=%v stores=%v", api.freedCertificates, api.closedStores)
	}
}

func TestWindowsBorrowedKeyRemainsBoundToRetryableCertificateContext(t *testing.T) {
	api, config, selectedHandle := validFakeNativeAPI(t)
	api.callerFreeKey = false
	api.freeCertErr = errors.New("free certificate")
	api.freeCertErrorCount = 1
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	if err := credential.Close(); err == nil {
		t.Fatal("Close hid certificate-context release failure")
	}
	if credential.state.key == 0 || credential.state.certificate == nil {
		t.Fatal("failed certificate release discarded borrowed-key lifetime")
	}
	if len(api.freedKeys) != 0 {
		t.Fatalf("Close freed a borrowed CNG key: %v", api.freedKeys)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("Close did not retry certificate context: %v", err)
	}
	if credential.state.key != 0 || credential.state.certificate != nil {
		t.Fatal("successful certificate release retained borrowed-key state")
	}
	if !reflect.DeepEqual(api.freedCertificates, []nativeCertificate{selectedHandle, selectedHandle}) ||
		!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
		t.Fatalf("borrowed-key cleanup retries were not exact: certificates=%v stores=%v", api.freedCertificates, api.closedStores)
	}
}

func TestWindowsDuplicatePinnedDERFailsClosed(t *testing.T) {
	api, config, selectedHandle := validFakeNativeAPI(t)
	secondMatch := &windows.CertContext{Length: 104}
	originalMatch := api.certificateOrder[1]
	api.certificateOrder = []nativeCertificate{originalMatch, secondMatch}
	api.certificateValues[secondMatch] = bytes.Clone(api.certificateValues[originalMatch])

	_, err := acquireWithAPI(api, config)
	if !errors.Is(err, ErrDuplicateCertificate) {
		t.Fatalf("expected ErrDuplicateCertificate, got %v", err)
	}
	if api.enumCalls != 2 || !reflect.DeepEqual(api.consumed, []nativeCertificate{originalMatch}) {
		t.Fatalf("unexpected duplicate enumeration ownership: calls=%d consumed=%v", api.enumCalls, api.consumed)
	}
	if !reflect.DeepEqual(api.freedCertificates, []nativeCertificate{secondMatch, selectedHandle}) {
		t.Fatalf("duplicate contexts were not released: %v", api.freedCertificates)
	}
	if len(api.freedChains) != 0 || api.acquireCert != nil ||
		!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
		t.Fatalf("duplicate certificate progressed or leaked the store: chains=%v acquire=%p stores=%v", api.freedChains, api.acquireCert, api.closedStores)
	}
}

func TestWindowsSignAcceptsOnlySHA256DigestAndReturnsLowSASN1(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	n := elliptic.P256().Params().N
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	defer credential.Close()

	digest := sha256.Sum256([]byte("TLS CertificateVerify"))
	r, s, err := ecdsa.Sign(rand.Reader, api.signingKey, digest[:])
	if err != nil {
		t.Fatalf("create test signature: %v", err)
	}
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(n), 1)
	if s.Cmp(halfOrder) > 0 {
		s.Sub(n, s)
	}
	highS := new(big.Int).Sub(new(big.Int).Set(n), s)
	api.signature = append(fixedWidthScalar(r), fixedWidthScalar(highS)...)
	encoded, err := credential.Sign(nil, digest[:], crypto.SHA256)
	if err != nil {
		t.Fatalf("Sign returned an error: %v", err)
	}
	var signature ecdsaASN1Signature
	rest, err := asn1.Unmarshal(encoded, &signature)
	if err != nil || len(rest) != 0 || signature.R.Cmp(r) != 0 || signature.S.Cmp(s) != 0 {
		t.Fatalf("Sign returned invalid or noncanonical ASN.1: signature=%#v rest=%x err=%v", signature, rest, err)
	}
	if api.signKey != api.keyHandle || !bytes.Equal(api.signDigest, digest[:]) || api.signFlags != ncryptSilentFlag {
		t.Fatalf("unexpected NCryptSignHash call: key=%d digest=%x flags=0x%x", api.signKey, api.signDigest, api.signFlags)
	}

	if _, err := credential.Sign(nil, digest[:31], crypto.SHA256); !errors.Is(err, ErrInvalidDigest) {
		t.Fatalf("Sign returned the wrong short-digest error: %v", err)
	}
	if _, err := credential.Sign(nil, digest[:], nil); !errors.Is(err, ErrUnsupportedSignerOptions) {
		t.Fatalf("Sign returned the wrong nil-options error: %v", err)
	}
	if _, err := credential.Sign(nil, digest[:], crypto.SHA384); !errors.Is(err, ErrUnsupportedSignerOptions) {
		t.Fatalf("Sign returned the wrong hash-options error: %v", err)
	}
	if api.signCalls != 1 {
		t.Fatalf("invalid signing inputs reached CNG: %d calls", api.signCalls)
	}
	credential.state.validUntil = time.Now().Add(-time.Minute)
	if _, err := credential.Sign(nil, digest[:], crypto.SHA256); !errors.Is(err, ErrInvalidCertificate) {
		t.Fatalf("Sign returned the wrong expired-chain error: %v", err)
	}
	if api.signCalls != 1 {
		t.Fatalf("an expired transmitted chain reached CNG: %d calls", api.signCalls)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if _, err := credential.Sign(nil, digest[:], crypto.SHA256); !errors.Is(err, ErrClosed) {
		t.Fatalf("Sign returned the wrong use-after-close error: %v", err)
	}
}

func TestWindowsSignRejectsCNGSignatureThatDoesNotMatchPinnedKey(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	one := fixedWidthScalar(big.NewInt(1))
	api.signature = append(bytes.Clone(one), one...)
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	defer credential.Close()
	digest := sha256.Sum256([]byte("mismatched signature"))
	if _, err := credential.Sign(nil, digest[:], crypto.SHA256); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
}

func TestWindowsSignUsesFixedDigestSnapshotDuringCallerMutation(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	defer credential.Close()

	digest := sha256.Sum256([]byte("mutable caller digest"))
	expected := digest
	r, s, err := ecdsa.Sign(rand.Reader, api.signingKey, expected[:])
	if err != nil {
		t.Fatalf("create test signature: %v", err)
	}
	api.signature = append(fixedWidthScalar(r), fixedWidthScalar(s)...)
	api.afterSign = func() {
		mutated := make(chan struct{})
		go func() {
			for index := range digest {
				digest[index] ^= 0xff
			}
			close(mutated)
		}()
		<-mutated
	}

	encoded, err := credential.Sign(nil, digest[:], crypto.SHA256)
	if err != nil {
		t.Fatalf("Sign did not isolate the caller digest: %v", err)
	}
	if !bytes.Equal(api.signDigest, expected[:]) {
		t.Fatalf("CNG received %x, want snapshot %x", api.signDigest, expected)
	}
	if !ecdsa.VerifyASN1(&api.signingKey.PublicKey, expected[:], encoded) {
		t.Fatal("signature does not verify against the digest snapshot")
	}
}

func TestWindowsCloseWaitsForInFlightSignBeforeReleasingKey(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	digest := sha256.Sum256([]byte("concurrent close"))
	r, s, err := ecdsa.Sign(rand.Reader, api.signingKey, digest[:])
	if err != nil {
		t.Fatalf("create test signature: %v", err)
	}
	n := elliptic.P256().Params().N
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(n), 1)
	if s.Cmp(halfOrder) > 0 {
		s.Sub(n, s)
	}
	api.signature = append(fixedWidthScalar(r), fixedWidthScalar(s)...)
	api.signStarted = make(chan struct{})
	signRelease := make(chan struct{})
	api.signRelease = signRelease

	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	signDone := make(chan error, 1)
	go func() {
		_, signErr := credential.Sign(nil, digest[:], crypto.SHA256)
		signDone <- signErr
	}()
	<-api.signStarted

	closeAttempted := make(chan struct{})
	closeDone := make(chan error, 1)
	go func() {
		close(closeAttempted)
		closeDone <- credential.Close()
	}()
	<-closeAttempted
	select {
	case err := <-closeDone:
		t.Fatalf("Close released resources before Sign completed: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	if len(api.freedKeys) != 0 {
		t.Fatalf("key was freed during Sign: %v", api.freedKeys)
	}

	close(signRelease)
	if err := <-signDone; err != nil {
		t.Fatalf("in-flight Sign returned an error: %v", err)
	}
	if err := <-closeDone; err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if !reflect.DeepEqual(api.releaseEvents, []string{"key", "certificate", "store"}) {
		t.Fatalf("resources were not released after Sign: %v", api.releaseEvents)
	}
}

func TestWindowsAcquisitionRejectsWrongKeySpecAndCleansExactOwnership(t *testing.T) {
	for _, callerFree := range []bool{false, true} {
		t.Run(fmt.Sprintf("callerFree=%t", callerFree), func(t *testing.T) {
			api, config, selectedHandle := validFakeNativeAPI(t)
			api.callerFreeKey = callerFree
			api.keySpec = windows.AT_SIGNATURE
			_, err := acquireWithAPI(api, config)
			if !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("expected ErrInvalidKey, got %v", err)
			}
			expectedKeys := []nativeKey(nil)
			if callerFree {
				expectedKeys = []nativeKey{api.keyHandle}
			}
			if !reflect.DeepEqual(api.freedKeys, expectedKeys) ||
				!reflect.DeepEqual(api.freedCertificates, []nativeCertificate{selectedHandle}) ||
				!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
				t.Fatalf("unexpected cleanup: keys=%v certificates=%v stores=%v", api.freedKeys, api.freedCertificates, api.closedStores)
			}
		})
	}
}

func TestWindowsAcquisitionRejectsPropertyOrPublicKeyMismatch(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fakeNativeAPI)
	}{
		{name: "algorithm", mutate: func(api *fakeNativeAPI) { api.properties[ncryptAlgorithmProperty] = encodeUTF16Property("ECDSA_P384") }},
		{name: "length", mutate: func(api *fakeNativeAPI) { api.properties[ncryptLengthProperty] = encodeUint32Property(384) }},
		{name: "exportable", mutate: func(api *fakeNativeAPI) { api.properties[ncryptExportPolicyProperty] = encodeUint32Property(1) }},
		{name: "key usage", mutate: func(api *fakeNativeAPI) { api.properties[ncryptKeyUsageProperty] = encodeUint32Property(3) }},
		{name: "user key type", mutate: func(api *fakeNativeAPI) { api.properties[ncryptKeyTypeProperty] = encodeUint32Property(0) }},
		{name: "empty unique name", mutate: func(api *fakeNativeAPI) { api.properties[ncryptUniqueNameProperty] = encodeUTF16Property("") }},
		{name: "container mismatch", mutate: func(api *fakeNativeAPI) { api.properties[ncryptNameProperty] = encodeUTF16Property("other-key") }},
		{name: "actual provider", mutate: func(api *fakeNativeAPI) { api.actualProviderName = "Unapproved KSP" }},
		{name: "provider implementation", mutate: func(api *fakeNativeAPI) { api.actualProviderImplementation = 1 }},
		{name: "public key", mutate: func(api *fakeNativeAPI) {
			otherKey, err := ecdsa.GenerateKey(elliptic.P256(), bytes.NewReader(bytes.Repeat([]byte{7}, 128)))
			if err != nil {
				api.publicBlob[0] = 0
				return
			}
			api.publicBlob = encodeP256PublicBlob(&otherKey.PublicKey)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			api, config, selectedHandle := validFakeNativeAPI(t)
			test.mutate(api)
			_, err := acquireWithAPI(api, config)
			if !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("expected ErrInvalidKey, got %v", err)
			}
			if !reflect.DeepEqual(api.freedKeys, []nativeKey{api.keyHandle}) ||
				!reflect.DeepEqual(api.freedCertificates, []nativeCertificate{selectedHandle}) ||
				!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
				t.Fatalf("rejected key resources leaked: keys=%v certificates=%v stores=%v", api.freedKeys, api.freedCertificates, api.closedStores)
			}
		})
	}
}

func TestWindowsAcquisitionRejectsUnapprovedProviderInfo(t *testing.T) {
	api, config, selectedHandle := validFakeNativeAPI(t)
	api.providerInfo.providerName = "Unapproved KSP"
	_, err := acquireWithAPI(api, config)
	if !errors.Is(err, ErrInvalidProviderInfo) {
		t.Fatalf("expected ErrInvalidProviderInfo, got %v", err)
	}
	if api.acquireCert != nil || len(api.freedKeys) != 0 ||
		!reflect.DeepEqual(api.freedCertificates, []nativeCertificate{selectedHandle}) ||
		!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
		t.Fatalf("provider rejection progressed or leaked resources: acquire=%p keys=%v certificates=%v stores=%v", api.acquireCert, api.freedKeys, api.freedCertificates, api.closedStores)
	}
}

func TestWindowsAcquisitionRejectsMispinnedUnsafeKeyDACL(t *testing.T) {
	api, config, selectedHandle := validFakeNativeAPI(t)
	api.securityEvidence.entries[2].sid = testExecutorServiceSID
	_, err := acquireWithAPI(api, config)
	if !errors.Is(err, ErrInvalidKeySecurity) {
		t.Fatalf("expected ErrInvalidKeySecurity, got %v", err)
	}
	if !reflect.DeepEqual(api.freedKeys, []nativeKey{api.keyHandle}) ||
		!reflect.DeepEqual(api.freedCertificates, []nativeCertificate{selectedHandle}) ||
		!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
		t.Fatalf("security rejection leaked resources: keys=%v certificates=%v stores=%v", api.freedKeys, api.freedCertificates, api.closedStores)
	}
}

func TestWindowsEnumerationIsBounded(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	unmatchedDER := bytes.Clone(api.chainValues[len(api.chainValues)-1])
	api.certificateOrder = make([]nativeCertificate, maximumStoreCertificates)
	api.certificateValues = make(map[nativeCertificate][]byte, maximumStoreCertificates)
	for index := range api.certificateOrder {
		handle := &windows.CertContext{Length: uint32(index + 1)}
		api.certificateOrder[index] = handle
		api.certificateValues[handle] = unmatchedDER
	}

	_, err := acquireWithAPI(api, config)
	if !errors.Is(err, ErrEnumerationLimit) {
		t.Fatalf("expected ErrEnumerationLimit, got %v", err)
	}
	if api.enumCalls != maximumStoreCertificates {
		t.Fatalf("enumeration made %d calls instead of %d", api.enumCalls, maximumStoreCertificates)
	}
	lastCertificate := api.certificateOrder[len(api.certificateOrder)-1]
	if !reflect.DeepEqual(api.freedCertificates, []nativeCertificate{lastCertificate}) {
		t.Fatalf("last unconsumed context was not released: %v", api.freedCertificates)
	}
	if !reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
		t.Fatalf("store was not closed: %v", api.closedStores)
	}
}

func TestWindowsChainContextIsReleasedOnCopyFailure(t *testing.T) {
	api, config, selectedHandle := validFakeNativeAPI(t)
	api.chainCopyErr = errors.New("copy failure")
	_, err := acquireWithAPI(api, config)
	if err == nil {
		t.Fatal("acquireWithAPI hid a chain copy failure")
	}
	if !reflect.DeepEqual(api.freedChains, []nativeChain{api.chainHandle}) ||
		!reflect.DeepEqual(api.freedCertificates, []nativeCertificate{selectedHandle}) ||
		!reflect.DeepEqual(api.closedStores, []nativeStore{api.storeHandle}) {
		t.Fatalf("chain failure leaked resources: chains=%v certificates=%v stores=%v", api.freedChains, api.freedCertificates, api.closedStores)
	}
}

func TestWindowsCloseRetainsFailedResourcesForRetry(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	api.freeKeyErr = errors.New("free key")
	api.freeKeyErrorCount = 1
	api.freeCertErr = errors.New("free certificate")
	api.freeCertErrorCount = 1
	api.closeStoreErr = errors.New("close store")
	api.closeStoreErrorCount = 1
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	if err := credential.Close(); err == nil {
		t.Fatal("Close hid native cleanup failures")
	}
	state := credential.state
	if !state.closed || state.key == 0 || state.certificate == nil || state.store == 0 {
		t.Fatalf("failed Close discarded retryable ownership: key=%d certificate=%p store=%d", state.key, state.certificate, state.store)
	}
	if _, err := credential.Sign(nil, make([]byte, p256DigestBytes), crypto.SHA256); !errors.Is(err, ErrClosed) {
		t.Fatalf("failed Close left credential usable: %v", err)
	}
	if _, err := credential.Attestation(); !errors.Is(err, ErrClosed) {
		t.Fatalf("failed Close left attestation available: %v", err)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("second Close did not release retained resources: %v", err)
	}
	if state.key != 0 || state.certificate != nil || state.store != 0 {
		t.Fatalf("successful retry retained resources: key=%d certificate=%p store=%d", state.key, state.certificate, state.store)
	}
	expectedEvents := []string{"key", "certificate", "store", "key", "certificate", "store"}
	if !reflect.DeepEqual(api.releaseEvents, expectedEvents) {
		t.Fatalf("Close retries were not exact: %v", api.releaseEvents)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("Close after complete release returned an error: %v", err)
	}
	if !reflect.DeepEqual(api.releaseEvents, expectedEvents) {
		t.Fatalf("Close retried resources after complete release: %v", api.releaseEvents)
	}
}

func TestWindowsCredentialValueCopiesShareStateAndOwnership(t *testing.T) {
	api, config, _ := validFakeNativeAPI(t)
	credential, err := acquireWithAPI(api, config)
	if err != nil {
		t.Fatalf("acquireWithAPI returned an error: %v", err)
	}
	copyByValue := *credential
	if copyByValue.state != credential.state {
		t.Fatal("Credential value copy did not retain shared private state")
	}
	if copyByValue.Identity() != credential.Identity() {
		t.Fatal("Credential value copy changed detached identity")
	}
	originalAttestation, err := credential.Attestation()
	if err != nil {
		t.Fatalf("Attestation through original credential returned an error: %v", err)
	}
	copyAttestation, err := copyByValue.Attestation()
	if err != nil || copyAttestation != originalAttestation {
		t.Fatalf("Credential value copy changed attestation: %#v, %v", copyAttestation, err)
	}
	if err := copyByValue.Close(); err != nil {
		t.Fatalf("Close through value copy returned an error: %v", err)
	}
	if _, err := credential.Sign(nil, make([]byte, p256DigestBytes), crypto.SHA256); !errors.Is(err, ErrClosed) {
		t.Fatalf("original credential remained usable after copy closed: %v", err)
	}
	if _, err := credential.Attestation(); !errors.Is(err, ErrClosed) {
		t.Fatalf("original credential retained attestation after copy closed: %v", err)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("Close through original credential returned an error: %v", err)
	}
	if !reflect.DeepEqual(api.releaseEvents, []string{"key", "certificate", "store"}) {
		t.Fatalf("value copies released shared resources more than once: %v", api.releaseEvents)
	}
}

func TestWindowsNativeConstantsAndSecurityStatus(t *testing.T) {
	if certificateStoreProvider != 10 || certificateStoreEncoding != 0 ||
		certificateStoreOpenFlags != 0x0002c000 || certificateStoreCloseFlags != 0 {
		t.Fatalf("store constants changed: provider=%d encoding=%d open=0x%x close=0x%x", certificateStoreProvider, certificateStoreEncoding, certificateStoreOpenFlags, certificateStoreCloseFlags)
	}
	if certificateAcquireFlags != 0x0004004c || certificateChainFlags != 0x00002104 ||
		localMachineChainEngine != 1 || ncryptSilentFlag != 0x40 {
		t.Fatalf("native flags changed: acquire=0x%x chain=0x%x engine=%d sign=0x%x", certificateAcquireFlags, certificateChainFlags, localMachineChainEngine, ncryptSilentFlag)
	}
	if certificateKeyProviderInfoProperty != 2 || keySecurityInformation != 7 {
		t.Fatalf("provider/security property constants changed: provider=%d security=0x%x", certificateKeyProviderInfoProperty, keySecurityInformation)
	}
	if err := securityStatusError("NCryptTest", 0); err != nil {
		t.Fatalf("zero SECURITY_STATUS returned an error: %v", err)
	}
	err := securityStatusError("NCryptTest", uintptr(uint32(0x80090016)))
	var statusError *cng.StatusError
	if !errors.As(err, &statusError) || statusError.Code != 0x80090016 || statusError.Operation != "NCryptTest" {
		t.Fatalf("SECURITY_STATUS was not preserved: %#v", err)
	}
}

func TestWindowsSecurityDescriptorParserReadsProtectedKeyDACL(t *testing.T) {
	sddl := "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;" + testControlServiceSID + ")"
	descriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatalf("create test security descriptor: %v", err)
	}
	length := descriptor.Length()
	value := append(
		[]byte(nil),
		unsafe.Slice((*byte)(unsafe.Pointer(descriptor)), int(length))...,
	)
	evidence, err := parseKeySecurityDescriptor(value)
	if err != nil {
		t.Fatalf("parseKeySecurityDescriptor returned an error: %v", err)
	}
	digest := sha256.Sum256(value)
	if err := validateKeySecurityEvidence(
		evidence,
		hex.EncodeToString(digest[:]),
		testControlServiceSID,
		testExecutorServiceSID,
	); err != nil {
		t.Fatalf("validateKeySecurityEvidence rejected parsed DACL: %v", err)
	}
}

func TestWindowsProviderInfoStringsMustPointInsidePropertyBuffer(t *testing.T) {
	encoded := encodeUTF16Property(approvedKeyStorageProvider)
	value := make([]byte, 8+len(encoded))
	copy(value[8:], encoded)
	pointer := (*uint16)(unsafe.Pointer(&value[8]))
	decoded, err := utf16StringWithinBuffer(value, pointer, 128)
	if err != nil || decoded != approvedKeyStorageProvider {
		t.Fatalf("utf16StringWithinBuffer returned %q, %v", decoded, err)
	}
	outside := new(uint16)
	if _, err := utf16StringWithinBuffer(value, outside, 128); err == nil {
		t.Fatal("utf16StringWithinBuffer accepted an out-of-buffer pointer")
	}
}

func TestWindowsProviderInfoNativeLayout(t *testing.T) {
	wantSize := uintptr(28)
	wantProviderOffset := uintptr(4)
	wantParameterOffset := uintptr(20)
	wantKeySpecOffset := uintptr(24)
	if unsafe.Sizeof(uintptr(0)) == 8 {
		wantSize = 48
		wantProviderOffset = 8
		wantParameterOffset = 32
		wantKeySpecOffset = 40
	}
	var value cryptKeyProviderInfo
	if unsafe.Sizeof(value) != wantSize ||
		unsafe.Offsetof(value.providerName) != wantProviderOffset ||
		unsafe.Offsetof(value.parameters) != wantParameterOffset ||
		unsafe.Offsetof(value.keySpec) != wantKeySpecOffset {
		t.Fatalf(
			"CRYPT_KEY_PROV_INFO layout changed: size=%d provider=%d parameters=%d keySpec=%d",
			unsafe.Sizeof(value),
			unsafe.Offsetof(value.providerName),
			unsafe.Offsetof(value.parameters),
			unsafe.Offsetof(value.keySpec),
		)
	}
}

func validFakeNativeAPI(t *testing.T) (*fakeNativeAPI, Config, nativeCertificate) {
	t.Helper()
	chain, leafKey := testCertificateChain(t)
	const (
		storeHandle = nativeStore(100)
		keyHandle   = nativeKey(300)
	)
	unmatchedHandle := &windows.CertContext{Length: 101}
	leafHandle := &windows.CertContext{Length: 102}
	duplicateHandle := &windows.CertContext{Length: 103}
	chainHandle := &windows.CertChainContext{Size: 200}
	one := fixedWidthScalar(big.NewInt(1))
	api := &fakeNativeAPI{
		storeHandle:      storeHandle,
		certificateOrder: []nativeCertificate{unmatchedHandle, leafHandle},
		certificateValues: map[nativeCertificate][]byte{
			unmatchedHandle: chain[len(chain)-1],
			leafHandle:      chain[0],
		},
		duplicateHandle: duplicateHandle,
		providerInfo: certificateProviderInfo{
			containerName: "machine-key",
			providerName:  approvedKeyStorageProvider,
			flags:         cryptMachineKeysetFlag,
			keySpec:       cngProviderKeySpec,
		},
		chainHandle:   chainHandle,
		chainValues:   chain,
		keyHandle:     keyHandle,
		keySpec:       windows.CERT_NCRYPT_KEY_SPEC,
		callerFreeKey: true,
		properties: map[string][]byte{
			ncryptAlgorithmProperty:    encodeUTF16Property("ECDSA_P256"),
			ncryptLengthProperty:       encodeUint32Property(256),
			ncryptExportPolicyProperty: encodeUint32Property(0),
			ncryptKeyUsageProperty:     encodeUint32Property(ncryptAllowSigningFlag),
			ncryptKeyTypeProperty:      encodeUint32Property(cryptMachineKeysetFlag),
			ncryptUniqueNameProperty:   encodeUTF16Property("machine-key-unique-name"),
			ncryptNameProperty:         encodeUTF16Property("machine-key"),
		},
		actualProviderName:           approvedKeyStorageProvider,
		actualProviderImplementation: ncryptSoftwareImplementationFlag,
		securityEvidence:             validTestKeySecurityEvidence(),
		publicBlob:                   encodeP256PublicBlob(&leafKey.PublicKey),
		signature:                    append(bytes.Clone(one), one...),
		signingKey:                   leafKey,
	}
	digest := sha256.Sum256(chain[0])
	securityDigest := sha256.Sum256(api.securityEvidence.raw)
	config := Config{
		StoreName:                           LocalMachinePersonalStore,
		CertificateSHA256:                   hex.EncodeToString(digest[:]),
		ExpectedKeySecurityDescriptorSHA256: hex.EncodeToString(securityDigest[:]),
		ControlServiceSID:                   testControlServiceSID,
		ExecutorServiceSID:                  testExecutorServiceSID,
	}
	return api, config, duplicateHandle
}
