//go:build windows

package cng

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"
)

type propertyRequest struct {
	name         string
	maximumBytes uint32
}

type fakeNativeCNG struct {
	providerHandle nativeHandle
	keyHandle      nativeHandle
	properties     map[string][]byte
	signature      []byte

	providerName  string
	providerFlags uint32
	keyProvider   nativeHandle
	keyName       string
	keyFlags      uint32
	propertyReads []propertyRequest
	signKey       nativeHandle
	signDigest    []byte
	signFlags     uint32
	signCalls     int
	freed         []nativeHandle

	openProviderErr error
	openKeyErr      error
	signErr         error
	freeErrors      map[nativeHandle]error
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

func (f *fakeNativeCNG) getProperty(_ nativeHandle, name string, maximumBytes uint32) ([]byte, error) {
	f.propertyReads = append(f.propertyReads, propertyRequest{name: name, maximumBytes: maximumBytes})
	value, exists := f.properties[name]
	if !exists {
		return nil, fmt.Errorf("property %s is unavailable", name)
	}
	return append([]byte(nil), value...), nil
}

func (f *fakeNativeCNG) signHash(key nativeHandle, digest []byte, flags uint32) ([]byte, error) {
	f.signKey = key
	f.signDigest = append([]byte(nil), digest...)
	f.signFlags = flags
	f.signCalls++
	return append([]byte(nil), f.signature...), f.signErr
}

func (f *fakeNativeCNG) freeObject(handle nativeHandle) error {
	f.freed = append(f.freed, handle)
	return f.freeErrors[handle]
}

func TestWindowsOpenContract(t *testing.T) {
	api := validFakeNativeCNG()
	signer, err := openWithAPI(api, "provider-name", "key-name")
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	if api.providerName != "provider-name" || api.providerFlags != 0 {
		t.Fatalf("provider open contract was wrong: name=%q flags=0x%08x", api.providerName, api.providerFlags)
	}
	if api.keyProvider != api.providerHandle || api.keyName != "key-name" {
		t.Fatalf("key open contract was wrong: provider=%d name=%q", api.keyProvider, api.keyName)
	}
	if api.keyFlags != ncryptMachineKeyFlag|ncryptSilentFlag {
		t.Fatalf("key open flags were 0x%08x", api.keyFlags)
	}

	expectedReads := []propertyRequest{
		{name: ncryptAlgorithmProperty, maximumBytes: maximumAlgorithmPropertyBytes},
		{name: ncryptLengthProperty, maximumBytes: uint32PropertyBytes},
		{name: ncryptExportPolicyProperty, maximumBytes: uint32PropertyBytes},
		{name: ncryptKeyUsageProperty, maximumBytes: uint32PropertyBytes},
	}
	if fmt.Sprint(api.propertyReads) != fmt.Sprint(expectedReads) {
		t.Fatalf("property reads were %#v", api.propertyReads)
	}

	if err := signer.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("repeated Close returned an error: %v", err)
	}
	if fmt.Sprint(api.freed) != fmt.Sprint([]nativeHandle{api.keyHandle, api.providerHandle}) {
		t.Fatalf("handles were not freed exactly once in key/provider order: %v", api.freed)
	}
}

func TestWindowsSignDigestContractAndLowS(t *testing.T) {
	api := validFakeNativeCNG()
	highS := p256Order
	decrementBigEndian(highS[:])
	one := scalarOne()
	api.signature = joinScalars(one[:], highS[:])
	signer, err := openWithAPI(api, "provider", "key")
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
	if !bytes.Equal(signature[:DigestSize], one[:]) || !bytes.Equal(signature[DigestSize:], one[:]) {
		t.Fatalf("SignDigest returned a noncanonical signature: %x", signature)
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
			_, err := openWithAPI(api, "provider", "key")
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
			if _, err := openWithAPI(api, "provider", "key"); err == nil {
				t.Fatal("openWithAPI accepted a failed native open")
			}
			if fmt.Sprint(api.freed) != fmt.Sprint(test.expectedFreed) {
				t.Fatalf("unexpected cleanup handles: %v", api.freed)
			}
		})
	}
}

func TestWindowsCloseAttemptsBothHandlesAfterFailure(t *testing.T) {
	api := validFakeNativeCNG()
	api.freeErrors = map[nativeHandle]error{api.keyHandle: errors.New("free key")}
	signer, err := openWithAPI(api, "provider", "key")
	if err != nil {
		t.Fatalf("openWithAPI returned an error: %v", err)
	}
	if err := signer.Close(); err == nil {
		t.Fatal("Close hid a native handle release failure")
	}
	if fmt.Sprint(api.freed) != fmt.Sprint([]nativeHandle{api.keyHandle, api.providerHandle}) {
		t.Fatalf("Close did not attempt both handles: %v", api.freed)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("repeated Close retried released ownership: %v", err)
	}
	if len(api.freed) != 2 {
		t.Fatalf("repeated Close called freeObject again: %v", api.freed)
	}
}

func TestWindowsSignerRejectsUseAfterClose(t *testing.T) {
	api := validFakeNativeCNG()
	signer, err := openWithAPI(api, "provider", "key")
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

func TestWindowsOpenRejectsInvalidNamesBeforeNativeCalls(t *testing.T) {
	tests := []struct {
		provider string
		key      string
	}{
		{provider: "", key: "key"},
		{provider: "provider", key: ""},
		{provider: "provider\x00suffix", key: "key"},
		{provider: "provider", key: string([]byte{0xff})},
	}
	for _, test := range tests {
		api := validFakeNativeCNG()
		if _, err := openWithAPI(api, test.provider, test.key); err == nil {
			t.Fatal("openWithAPI accepted an invalid name")
		}
		if api.providerName != "" {
			t.Fatal("invalid names reached the native API")
		}
	}
}

func validFakeNativeCNG() *fakeNativeCNG {
	one := scalarOne()
	return &fakeNativeCNG{
		providerHandle: 1,
		keyHandle:      2,
		properties: map[string][]byte{
			ncryptAlgorithmProperty:    encodeUTF16Property("ECDSA_P256"),
			ncryptLengthProperty:       encodeUint32Property(256),
			ncryptExportPolicyProperty: encodeUint32Property(0),
			ncryptKeyUsageProperty:     encodeUint32Property(ncryptAllowSigningFlag),
		},
		signature:  joinScalars(one[:], one[:]),
		freeErrors: make(map[nativeHandle]error),
	}
}
