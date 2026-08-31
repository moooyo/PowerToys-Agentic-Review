//go:build windows

package cng

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"testing"
)

type propertyRequest struct {
	handle       nativeHandle
	name         string
	flags        uint32
	maximumBytes uint32
}

type fakeNativeCNG struct {
	providerHandle     nativeHandle
	keyHandle          nativeHandle
	providerProperties map[string][]byte
	properties         map[string][]byte
	signature          []byte
	publicBlob         []byte
	signingKey         *ecdsa.PrivateKey

	providerName  string
	providerFlags uint32
	keyProvider   nativeHandle
	keyName       string
	keyFlags      uint32
	propertyReads []propertyRequest
	exportKey     nativeHandle
	exportType    string
	exportMaximum uint32
	signKey       nativeHandle
	signDigest    []byte
	signFlags     uint32
	signCalls     int
	afterSign     func()
	freed         []nativeHandle

	openProviderErr error
	openKeyErr      error
	signErr         error
	freeErrors      map[nativeHandle]error
	freeErrorCounts map[nativeHandle]int
}

func (f *fakeNativeCNG) openStorageProvider(name string, flags uint32) (nativeHandle, error) {
	f.providerName = name
	f.providerFlags = flags
	return f.providerHandle, f.openProviderErr
}

func (f *fakeNativeCNG) openKey(provider nativeHandle, name string, flags uint32) (nativeHandle, error) {
	f.keyProvider = provider
	f.keyName = name
	f.keyFlags = flags
	return f.keyHandle, f.openKeyErr
}

func (f *fakeNativeCNG) getProperty(handle nativeHandle, name string, flags uint32, maximumBytes uint32) ([]byte, error) {
	f.propertyReads = append(f.propertyReads, propertyRequest{handle: handle, name: name, flags: flags, maximumBytes: maximumBytes})
	properties := f.properties
	if handle == f.providerHandle {
		properties = f.providerProperties
	}
	value, exists := properties[name]
	if !exists {
		return nil, fmt.Errorf("property %s is unavailable", name)
	}
	return append([]byte(nil), value...), nil
}

func (f *fakeNativeCNG) exportPublicKey(key nativeHandle, blobType string, maximumBytes uint32) ([]byte, error) {
	f.exportKey = key
	f.exportType = blobType
	f.exportMaximum = maximumBytes
	return append([]byte(nil), f.publicBlob...), nil
}

func (f *fakeNativeCNG) signHash(key nativeHandle, digest []byte, flags uint32) ([]byte, error) {
	f.signKey = key
	f.signDigest = append([]byte(nil), digest...)
	f.signFlags = flags
	f.signCalls++
	var signature []byte
	var err error
	if f.signErr != nil || f.signature != nil {
		signature = append([]byte(nil), f.signature...)
		err = f.signErr
	} else {
		var r, s *big.Int
		r, s, err = ecdsa.Sign(rand.Reader, f.signingKey, digest)
		if err == nil {
			signature = joinScalars(r.FillBytes(make([]byte, DigestSize)), s.FillBytes(make([]byte, DigestSize)))
		}
	}
	if f.afterSign != nil {
		f.afterSign()
	}
	return signature, err
}

func (f *fakeNativeCNG) freeObject(handle nativeHandle) error {
	f.freed = append(f.freed, handle)
	if remaining, exists := f.freeErrorCounts[handle]; exists {
		if remaining > 0 {
			f.freeErrorCounts[handle] = remaining - 1
			return f.freeErrors[handle]
		}
		return nil
	}
	return f.freeErrors[handle]
}

func TestWindowsOpenContract(t *testing.T) {
	api := validFakeNativeCNG()
	options, _ := validTestOptions()
	signer, err := openWithAPI(api, options)
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	if api.providerName != approvedKeyStorageProvider || api.providerFlags != 0 {
		t.Fatalf("provider open contract was wrong: name=%q flags=0x%08x", api.providerName, api.providerFlags)
	}
	if api.keyProvider != api.providerHandle || api.keyName != options.KeyName {
		t.Fatalf("key open contract was wrong: provider=%d name=%q", api.keyProvider, api.keyName)
	}
	if api.keyFlags != ncryptMachineKeyFlag|ncryptSilentFlag {
		t.Fatalf("key open flags were 0x%08x", api.keyFlags)
	}

	expectedReads := []propertyRequest{
		{handle: api.providerHandle, name: ncryptNameProperty, maximumBytes: maximumNamePropertyBytes},
		{handle: api.providerHandle, name: ncryptImplementationProperty, maximumBytes: uint32PropertyBytes},
		{handle: api.keyHandle, name: ncryptAlgorithmProperty, maximumBytes: maximumAlgorithmPropertyBytes},
		{handle: api.keyHandle, name: ncryptLengthProperty, maximumBytes: uint32PropertyBytes},
		{handle: api.keyHandle, name: ncryptExportPolicyProperty, maximumBytes: uint32PropertyBytes},
		{handle: api.keyHandle, name: ncryptKeyUsageProperty, maximumBytes: uint32PropertyBytes},
		{handle: api.keyHandle, name: ncryptKeyTypeProperty, maximumBytes: uint32PropertyBytes},
		{handle: api.keyHandle, name: ncryptNameProperty, maximumBytes: maximumNamePropertyBytes},
		{handle: api.keyHandle, name: ncryptUniqueNameProperty, maximumBytes: maximumNamePropertyBytes},
		{handle: api.keyHandle, name: ncryptSecurityDescriptorProperty, flags: securityDescriptorPropertyFlags, maximumBytes: maximumKeySecurityDescriptorBytes},
	}
	if fmt.Sprint(api.propertyReads) != fmt.Sprint(expectedReads) {
		t.Fatalf("property reads were %#v", api.propertyReads)
	}
	if api.exportKey != api.keyHandle || api.exportType != ncryptECCPublicBlob || api.exportMaximum != maximumPublicBlobBytes {
		t.Fatalf("public key export contract was wrong: key=%d type=%q maximum=%d", api.exportKey, api.exportType, api.exportMaximum)
	}
	identity := signer.Identity()
	if identity != (KeyIdentity{ProviderName: approvedKeyStorageProvider, UniqueName: "test-unique-key", MachineKey: true}) {
		t.Fatalf("Identity returned %#v", identity)
	}
	expectedSPKIDigest, err := p256PublicKeySPKISHA256(&api.signingKey.PublicKey)
	if err != nil {
		t.Fatalf("derive expected SPKI digest: %v", err)
	}
	if digest := signer.PublicKeySPKISHA256(); digest != expectedSPKIDigest {
		t.Fatalf("PublicKeySPKISHA256 returned %x, want %x", digest, expectedSPKIDigest)
	}
	if !signer.IsOpen() {
		t.Fatal("validated signer did not report itself open")
	}

	if err := signer.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("repeated Close returned an error: %v", err)
	}
	if signer.IsOpen() {
		t.Fatal("closed signer reported itself open")
	}
	if fmt.Sprint(api.freed) != fmt.Sprint([]nativeHandle{api.keyHandle, api.providerHandle}) {
		t.Fatalf("handles were not freed exactly once in key/provider order: %v", api.freed)
	}
}

func TestWindowsIsOpenAndCloseAreConcurrentSafe(t *testing.T) {
	api := validFakeNativeCNG()
	options, _ := validTestOptions()
	signer, err := openWithAPI(api, options)
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}

	start := make(chan struct{})
	var readers sync.WaitGroup
	for range 16 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			<-start
			for range 100 {
				_ = signer.IsOpen()
			}
		}()
	}
	close(start)
	if err := signer.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	readers.Wait()
	if signer.IsOpen() {
		t.Fatal("signer remained open after concurrent Close")
	}
}

func TestWindowsSignDigestContractAndVerification(t *testing.T) {
	api := validFakeNativeCNG()
	options, _ := validTestOptions()
	signer, err := openWithAPI(api, options)
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	defer signer.Close()

	// This is the local-protocol ExecutionCapabilityV1 cross-language golden digest.
	digest, err := hex.DecodeString("8015fc8eed1746d31de5c250d13be33d732131da4c7a02899c6d9f697b32b139")
	if err != nil {
		t.Fatalf("decode golden digest: %v", err)
	}
	signature, err := signer.SignDigest(digest)
	if err != nil {
		t.Fatalf("SignDigest returned an error: %v", err)
	}
	if len(signature) != SignatureSize {
		t.Fatalf("SignDigest returned %d bytes", len(signature))
	}
	if bytes.Compare(signature[DigestSize:], p256HalfOrder[:]) > 0 {
		t.Fatalf("SignDigest returned a high-S signature: %x", signature)
	}
	if err := verifyP256Signature(&api.signingKey.PublicKey, digest, signature); err != nil {
		t.Fatalf("SignDigest returned an unverifiable signature: %v", err)
	}
	if api.signKey != api.keyHandle || !bytes.Equal(api.signDigest, digest) {
		t.Fatalf("SignDigest passed the wrong key or digest: key=%d digest=%x", api.signKey, api.signDigest)
	}
	if api.signFlags != ncryptSilentFlag {
		t.Fatalf("SignDigest flags were 0x%08x", api.signFlags)
	}

	for _, invalid := range [][]byte{nil, make([]byte, DigestSize-1), make([]byte, DigestSize+1)} {
		if _, err := signer.SignDigest(invalid); !errors.Is(err, ErrInvalidDigest) {
			t.Fatalf("SignDigest returned the wrong error for %d bytes: %v", len(invalid), err)
		}
	}
	if api.signCalls != 1 {
		t.Fatalf("invalid digests reached CNG; sign call count is %d", api.signCalls)
	}
}

func TestWindowsSignDigestUsesFixedInputSnapshot(t *testing.T) {
	api := validFakeNativeCNG()
	options, _ := validTestOptions()
	signer, err := openWithAPI(api, options)
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	defer signer.Close()

	digest := sha256.Sum256([]byte("mutable caller digest"))
	expected := digest
	api.afterSign = func() {
		for index := range digest {
			digest[index] ^= 0xff
		}
	}
	signature, err := signer.SignDigest(digest[:])
	if err != nil {
		t.Fatalf("SignDigest did not isolate the caller buffer: %v", err)
	}
	if !bytes.Equal(api.signDigest, expected[:]) {
		t.Fatalf("CNG received %x, want snapshot %x", api.signDigest, expected)
	}
	if err := verifyP256Signature(&api.signingKey.PublicKey, expected[:], signature); err != nil {
		t.Fatalf("signature does not verify against the input snapshot: %v", err)
	}
}

func TestWindowsSignDigestRejectsSignatureFromAnotherKey(t *testing.T) {
	api := validFakeNativeCNG()
	other := testSigningKey(2)
	digest := make([]byte, DigestSize)
	r, s, err := ecdsa.Sign(rand.Reader, other, digest)
	if err != nil {
		t.Fatalf("sign fixture digest: %v", err)
	}
	api.signature = joinScalars(r.FillBytes(make([]byte, DigestSize)), s.FillBytes(make([]byte, DigestSize)))
	options, _ := validTestOptions()
	signer, err := openWithAPI(api, options)
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	defer signer.Close()
	if _, err := signer.SignDigest(digest); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
}

func TestWindowsOpenRejectsEveryKeyPropertyMismatch(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string][]byte)
	}{
		{name: "algorithm", mutate: func(values map[string][]byte) {
			values[ncryptAlgorithmProperty] = encodeUTF16Property("ECDSA_P384")
		}},
		{name: "length", mutate: func(values map[string][]byte) {
			values[ncryptLengthProperty] = encodeUint32Property(384)
		}},
		{name: "export policy", mutate: func(values map[string][]byte) {
			values[ncryptExportPolicyProperty] = encodeUint32Property(1)
		}},
		{name: "additional usage", mutate: func(values map[string][]byte) {
			values[ncryptKeyUsageProperty] = encodeUint32Property(ncryptAllowSigningFlag | 1)
		}},
		{name: "malformed width", mutate: func(values map[string][]byte) {
			values[ncryptLengthProperty] = []byte{0, 1, 2}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			api := validFakeNativeCNG()
			test.mutate(api.properties)
			options, _ := validTestOptions()
			_, err := openWithAPI(api, options)
			if !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("expected ErrInvalidKey, got %v", err)
			}
			expected := []nativeHandle{api.keyHandle, api.providerHandle}
			if fmt.Sprint(api.freed) != fmt.Sprint(expected) {
				t.Fatalf("rejected key handles were not released: %v", api.freed)
			}
		})
	}
}

func TestWindowsOpenRejectsProviderScopeIdentityAndSecurityMismatch(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fakeNativeCNG, *Options)
	}{
		{name: "provider name", mutate: func(api *fakeNativeCNG, _ *Options) {
			api.providerProperties[ncryptNameProperty] = encodeUTF16Property("Other Provider")
		}},
		{name: "provider implementation", mutate: func(api *fakeNativeCNG, _ *Options) {
			api.providerProperties[ncryptImplementationProperty] = encodeUint32Property(1)
		}},
		{name: "user key", mutate: func(api *fakeNativeCNG, _ *Options) {
			api.properties[ncryptKeyTypeProperty] = encodeUint32Property(0)
		}},
		{name: "reported key name", mutate: func(api *fakeNativeCNG, _ *Options) {
			api.properties[ncryptNameProperty] = encodeUTF16Property("Other Key")
		}},
		{name: "missing unique name", mutate: func(api *fakeNativeCNG, _ *Options) {
			api.properties[ncryptUniqueNameProperty] = encodeUTF16Property("")
		}},
		{name: "descriptor digest", mutate: func(api *fakeNativeCNG, _ *Options) {
			api.properties[ncryptSecurityDescriptorProperty][0] ^= 1
		}},
		{name: "executor DACL", mutate: func(api *fakeNativeCNG, options *Options) {
			descriptor := encodeTestSecurityDescriptor(systemSID, []keySecurityACE{
				{sid: systemSID, mask: genericAllAccess, aceType: accessAllowedACEType},
				{sid: administratorsSID, mask: genericAllAccess, aceType: accessAllowedACEType},
				{sid: testExecutorSID, mask: genericReadAccess, aceType: accessAllowedACEType},
			})
			digest := sha256.Sum256(descriptor)
			options.ExpectedSecurityDescriptorSHA256 = hex.EncodeToString(digest[:])
			api.properties[ncryptSecurityDescriptorProperty] = descriptor
		}},
		{name: "public key blob", mutate: func(api *fakeNativeCNG, _ *Options) {
			api.publicBlob = []byte{1, 2, 3}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			api := validFakeNativeCNG()
			options, _ := validTestOptions()
			test.mutate(api, &options)
			if _, err := openWithAPI(api, options); err == nil {
				t.Fatal("openWithAPI accepted invalid provider or key evidence")
			}
			expected := []nativeHandle{api.keyHandle, api.providerHandle}
			if fmt.Sprint(api.freed) != fmt.Sprint(expected) {
				t.Fatalf("rejected key handles were not released: %v", api.freed)
			}
		})
	}
}

func TestWindowsOpenCleansUpPartialFailures(t *testing.T) {
	openFailure := errors.New("open failure")
	tests := []struct {
		name          string
		mutate        func(*fakeNativeCNG)
		expectedFreed []nativeHandle
	}{
		{name: "provider error", mutate: func(api *fakeNativeCNG) {
			api.openProviderErr = openFailure
		}, expectedFreed: nil},
		{name: "null provider", mutate: func(api *fakeNativeCNG) {
			api.providerHandle = 0
		}, expectedFreed: nil},
		{name: "key error", mutate: func(api *fakeNativeCNG) {
			api.openKeyErr = openFailure
		}, expectedFreed: []nativeHandle{1}},
		{name: "null key", mutate: func(api *fakeNativeCNG) {
			api.keyHandle = 0
		}, expectedFreed: []nativeHandle{1}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			api := validFakeNativeCNG()
			test.mutate(api)
			options, _ := validTestOptions()
			if _, err := openWithAPI(api, options); err == nil {
				t.Fatal("openWithAPI accepted a failed native open")
			}
			if fmt.Sprint(api.freed) != fmt.Sprint(test.expectedFreed) {
				t.Fatalf("unexpected cleanup handles: %v", api.freed)
			}
		})
	}
}

func TestWindowsOpenFailureRetriesDiscardWithoutDoubleFree(t *testing.T) {
	options, _ := validTestOptions()
	api := validFakeNativeCNG()
	api.properties[ncryptAlgorithmProperty] = encodeUTF16Property("ECDSA_P384")
	api.freeErrors[api.keyHandle] = errors.New("transient key free")
	api.freeErrorCounts[api.keyHandle] = 1
	if _, err := openWithAPI(api, options); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("expected ErrInvalidKey, got %v", err)
	}
	expected := []nativeHandle{api.keyHandle, api.providerHandle, api.keyHandle}
	if fmt.Sprint(api.freed) != fmt.Sprint(expected) {
		t.Fatalf("discard did not retry only the retained key handle: %v", api.freed)
	}

	api = validFakeNativeCNG()
	api.openKeyErr = errors.New("open key")
	api.freeErrors[api.providerHandle] = errors.New("transient provider free")
	api.freeErrorCounts[api.providerHandle] = 1
	if _, err := openWithAPI(api, options); err == nil {
		t.Fatal("openWithAPI accepted an open-key failure")
	}
	if fmt.Sprint(api.freed) != fmt.Sprint([]nativeHandle{api.providerHandle, api.providerHandle}) {
		t.Fatalf("partial-open discard did not retry the provider handle: %v", api.freed)
	}
}

func TestWindowsOpenFailureBoundsPersistentDiscardErrors(t *testing.T) {
	options, _ := validTestOptions()
	api := validFakeNativeCNG()
	api.properties[ncryptAlgorithmProperty] = encodeUTF16Property("ECDSA_P384")
	api.freeErrors[api.keyHandle] = errors.New("persistent key free")
	_, err := openWithAPI(api, options)
	if !errors.Is(err, ErrInvalidKey) || err == nil {
		t.Fatalf("expected validation and discard errors, got %v", err)
	}
	expected := []nativeHandle{
		api.keyHandle,
		api.providerHandle,
		api.keyHandle,
		api.keyHandle,
	}
	if fmt.Sprint(api.freed) != fmt.Sprint(expected) {
		t.Fatalf("persistent discard was not bounded to %d attempts: %v", discardFreeAttempts, api.freed)
	}
}

func TestWindowsCloseAttemptsBothHandlesAfterFailure(t *testing.T) {
	api := validFakeNativeCNG()
	api.freeErrors = map[nativeHandle]error{api.keyHandle: errors.New("free key")}
	api.freeErrorCounts[api.keyHandle] = 1
	options, _ := validTestOptions()
	signer, err := openWithAPI(api, options)
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	if err := signer.Close(); err == nil {
		t.Fatal("Close hid a native handle release failure")
	}
	if fmt.Sprint(api.freed) != fmt.Sprint([]nativeHandle{api.keyHandle, api.providerHandle}) {
		t.Fatalf("Close did not attempt both handles: %v", api.freed)
	}
	if _, err := signer.SignDigest(make([]byte, DigestSize)); !errors.Is(err, ErrClosed) {
		t.Fatalf("failed Close left the signer usable: %v", err)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("repeated Close did not recover the retained handle: %v", err)
	}
	expected := []nativeHandle{api.keyHandle, api.providerHandle, api.keyHandle}
	if fmt.Sprint(api.freed) != fmt.Sprint(expected) {
		t.Fatalf("repeated Close did not retry only the failed handle: %v", api.freed)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("Close after complete release returned an error: %v", err)
	}
	if fmt.Sprint(api.freed) != fmt.Sprint(expected) {
		t.Fatalf("Close retried handles after complete release: %v", api.freed)
	}
}

func TestWindowsSignerValueCopiesShareHandleOwnership(t *testing.T) {
	api := validFakeNativeCNG()
	options, _ := validTestOptions()
	signer, err := openWithAPI(api, options)
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	copyByValue := *signer
	if copyByValue.state != signer.state {
		t.Fatal("Signer value copy did not retain shared private state")
	}
	if copyByValue.Identity() != signer.Identity() ||
		copyByValue.PublicKeySPKISHA256() != signer.PublicKeySPKISHA256() {
		t.Fatal("Signer value copy changed detached evidence")
	}
	if err := copyByValue.Close(); err != nil {
		t.Fatalf("Close through value copy returned an error: %v", err)
	}
	if _, err := signer.SignDigest(make([]byte, DigestSize)); !errors.Is(err, ErrClosed) {
		t.Fatalf("original signer remained usable after copied signer closed: %v", err)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("Close through original signer returned an error: %v", err)
	}
	if fmt.Sprint(api.freed) != fmt.Sprint([]nativeHandle{api.keyHandle, api.providerHandle}) {
		t.Fatalf("value copies freed shared handles more than once: %v", api.freed)
	}
}

func TestWindowsSignerRejectsUseAfterClose(t *testing.T) {
	api := validFakeNativeCNG()
	options, _ := validTestOptions()
	signer, err := openWithAPI(api, options)
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if _, err := signer.SignDigest(make([]byte, DigestSize)); !errors.Is(err, ErrClosed) {
		t.Fatalf("SignDigest returned the wrong error after Close: %v", err)
	}
}

func TestWindowsNativeConstantsAndSecurityStatus(t *testing.T) {
	if providerOpenFlags != 0 || keyOpenFlags != 0x60 || signHashFlags != 0x40 {
		t.Fatalf("native flags changed: provider=0x%x key=0x%x sign=0x%x", providerOpenFlags, keyOpenFlags, signHashFlags)
	}
	if err := securityStatusError("NCryptTest", 0); err != nil {
		t.Fatalf("zero SECURITY_STATUS returned an error: %v", err)
	}
	err := securityStatusError("NCryptTest", uintptr(uint32(0x80090016)))
	var statusErr *StatusError
	if !errors.As(err, &statusErr) || statusErr.Code != 0x80090016 || statusErr.Operation != "NCryptTest" {
		t.Fatalf("SECURITY_STATUS was not preserved: %#v", err)
	}
}

func TestWindowsOpenRejectsInvalidOptionsBeforeNativeCalls(t *testing.T) {
	options, _ := validTestOptions()
	options.KeyName = ""
	api := validFakeNativeCNG()
	if _, err := openWithAPI(api, options); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("expected ErrInvalidOptions, got %v", err)
	}
	if api.providerName != "" {
		t.Fatal("invalid options reached the native API")
	}
}

func validFakeNativeCNG() *fakeNativeCNG {
	options, descriptor := validTestOptions()
	key := testSigningKey(1)
	return &fakeNativeCNG{
		providerHandle: 1,
		keyHandle:      2,
		providerProperties: map[string][]byte{
			ncryptNameProperty:           encodeUTF16Property(approvedKeyStorageProvider),
			ncryptImplementationProperty: encodeUint32Property(ncryptSoftwareImplementationFlag),
		},
		properties: map[string][]byte{
			ncryptAlgorithmProperty:          encodeUTF16Property("ECDSA_P256"),
			ncryptLengthProperty:             encodeUint32Property(256),
			ncryptExportPolicyProperty:       encodeUint32Property(0),
			ncryptKeyUsageProperty:           encodeUint32Property(ncryptAllowSigningFlag),
			ncryptKeyTypeProperty:            encodeUint32Property(ncryptMachineKeyFlag),
			ncryptNameProperty:               encodeUTF16Property(options.KeyName),
			ncryptUniqueNameProperty:         encodeUTF16Property("test-unique-key"),
			ncryptSecurityDescriptorProperty: descriptor,
		},
		publicBlob:      encodeTestP256PublicBlob(&key.PublicKey),
		signingKey:      key,
		freeErrors:      make(map[nativeHandle]error),
		freeErrorCounts: make(map[nativeHandle]int),
	}
}

func testSigningKey(value int64) *ecdsa.PrivateKey {
	d := big.NewInt(value)
	x, y := elliptic.P256().ScalarBaseMult(d.FillBytes(make([]byte, DigestSize)))
	return &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y},
		D:         d,
	}
}

func encodeTestP256PublicBlob(key *ecdsa.PublicKey) []byte {
	value := make([]byte, 8+2*DigestSize)
	binary.LittleEndian.PutUint32(value[:4], ecdsaPublicP256Magic)
	binary.LittleEndian.PutUint32(value[4:8], DigestSize)
	key.X.FillBytes(value[8 : 8+DigestSize])
	key.Y.FillBytes(value[8+DigestSize:])
	return value
}
