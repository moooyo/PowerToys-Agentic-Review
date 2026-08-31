//go:build windows

package authenticode

import (
	"crypto/sha256"
	"errors"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

type fakeWindowsTrustAPI struct {
	verifyStatus           int32
	closeStatus            int32
	secondarySignatures    uint32
	verifiedSignatureIndex uint32
	verifyCalls            int
	closeCalls             int
	verifyAction           windows.GUID
	verifyData             winTrustData
	verifyFile             winTrustFileInfo
	verifySettings         winTrustSignatureSettings
	verifyStrongPolicy     windows.CertStrongSignPara
	providerData           cryptProviderData
	sipData                providerDataSIP
	indirectData           spcIndirectDataContent
	signerInfo             cryptMessageSignerInfo
	signer                 cryptProviderSigner
	counterSignerInfo      cryptMessageSignerInfo
	counterSigner          cryptProviderSigner
	counterSignerMissing   bool
	extraCounterSigner     *cryptProviderSigner
	extraSigner            *cryptProviderSigner
	primaryChain           windows.CertChainContext
	counterSignerChain     windows.CertChainContext
	certificateDER         []byte
	issuer                 []byte
	serial                 []byte
	sha256ObjectID         []byte
	fileDigest             []byte
	certificateInfo        windows.CertInfo
	certificateContext     windows.CertContext
	providerCertificate    cryptProviderCert
	attributeObjectID      []byte
	attributes             []cryptAttribute
	mismatchedSerial       []byte
}

func newFakeWindowsTrustAPI(t *testing.T) *fakeWindowsTrustAPI {
	t.Helper()
	api := &fakeWindowsTrustAPI{
		certificateDER: makeTestCertificateDER(t),
		issuer:         []byte{0x30, 0x03, 0x31, 0x01, 0x00},
		serial:         []byte{0x2a},
		sha256ObjectID: append([]byte(SHA256ObjectIdentifier), 0),
		fileDigest:     make([]byte, sha256.Size),
	}
	api.signerInfo.Issuer = blobFromBytes(api.issuer)
	api.signerInfo.SerialNumber = blobFromBytes(api.serial)
	api.signerInfo.HashAlgorithm.ObjectIdentifier = &api.sha256ObjectID[0]
	api.counterSignerInfo.Issuer = blobFromBytes(api.issuer)
	api.counterSignerInfo.SerialNumber = blobFromBytes(api.serial)
	api.counterSignerInfo.HashAlgorithm.ObjectIdentifier = &api.sha256ObjectID[0]
	api.certificateInfo.Issuer = windows.CertNameBlob{
		Size: uint32(len(api.issuer)),
		Data: &api.issuer[0],
	}
	api.certificateInfo.SerialNumber = windows.CryptIntegerBlob{
		Size: uint32(len(api.serial)),
		Data: &api.serial[0],
	}
	api.certificateContext = windows.CertContext{
		EncodingType: windows.X509_ASN_ENCODING | windows.PKCS_7_ASN_ENCODING,
		EncodedCert:  &api.certificateDER[0],
		Length:       uint32(len(api.certificateDER)),
		CertInfo:     &api.certificateInfo,
	}
	api.primaryChain = windows.CertChainContext{
		Size:       uint32(unsafe.Sizeof(windows.CertChainContext{})),
		ChainCount: 1,
	}
	api.counterSignerChain = windows.CertChainContext{
		Size:       uint32(unsafe.Sizeof(windows.CertChainContext{})),
		ChainCount: 1,
	}
	api.signer = cryptProviderSigner{
		Size:               uint32(unsafe.Sizeof(cryptProviderSigner{})),
		CertificateCount:   2,
		SignerInfo:         &api.signerInfo,
		CounterSignerCount: 1,
		ChainContext:       &api.primaryChain,
	}
	api.counterSigner = cryptProviderSigner{
		Size:             uint32(unsafe.Sizeof(cryptProviderSigner{})),
		CertificateCount: 2,
		SignerType:       signerTypeTimestamp,
		SignerInfo:       &api.counterSignerInfo,
		ChainContext:     &api.counterSignerChain,
	}
	api.providerCertificate = cryptProviderCert{
		Size:        uint32(unsafe.Sizeof(cryptProviderCert{})),
		Certificate: &api.certificateContext,
	}
	api.indirectData = spcIndirectDataContent{
		DigestAlgorithm: cryptAlgorithmIdentifier{ObjectIdentifier: &api.sha256ObjectID[0]},
		Digest:          blobFromBytes(api.fileDigest),
	}
	api.sipData = providerDataSIP{
		Size:         uint32(unsafe.Sizeof(providerDataSIP{})),
		Subject:      winTrustKnownSubjectPEImage,
		IndirectData: &api.indirectData,
	}
	api.providerData = cryptProviderData{
		Size:          uint32(unsafe.Sizeof(cryptProviderData{})),
		Encoding:      windows.X509_ASN_ENCODING | windows.PKCS_7_ASN_ENCODING,
		Message:       windows.Handle(1),
		SignerCount:   1,
		SubjectChoice: cryptProviderChoiceSIP,
		SIPData:       &api.sipData,
	}
	return api
}

func blobFromBytes(value []byte) cryptDataBlob {
	if len(value) == 0 {
		return cryptDataBlob{}
	}
	return cryptDataBlob{Size: uint32(len(value)), Data: &value[0]}
}

func (api *fakeWindowsTrustAPI) WinVerifyTrust(action *windows.GUID, data *winTrustData) int32 {
	switch data.StateAction {
	case windows.WTD_STATEACTION_VERIFY:
		api.verifyCalls++
		api.verifyAction = *action
		api.verifyData = *data
		if data.File != nil {
			api.verifyFile = *data.File
		}
		if data.SignatureSettings != nil {
			data.SignatureSettings.SecondarySignatureCount = api.secondarySignatures
			data.SignatureSettings.VerifiedSignatureIndex = api.verifiedSignatureIndex
			api.verifySettings = *data.SignatureSettings
			if data.SignatureSettings.CryptoPolicy != nil {
				api.verifyStrongPolicy = *data.SignatureSettings.CryptoPolicy
			}
		}
		api.providerData.WinTrustData = data
		data.StateData = windows.Handle(0x1234)
		return api.verifyStatus
	case windows.WTD_STATEACTION_CLOSE:
		api.closeCalls++
		return api.closeStatus
	default:
		return -1
	}
}

func (api *fakeWindowsTrustAPI) ProviderDataFromStateData(windows.Handle) *cryptProviderData {
	return &api.providerData
}

func (api *fakeWindowsTrustAPI) SignerFromChain(
	_ *cryptProviderData,
	signerIndex uint32,
	counterSigner bool,
	counterSignerIndex uint32,
) *cryptProviderSigner {
	if counterSigner {
		if signerIndex != 0 {
			return nil
		}
		if counterSignerIndex == 0 && !api.counterSignerMissing {
			return &api.counterSigner
		}
		if counterSignerIndex == 1 {
			return api.extraCounterSigner
		}
		return nil
	}
	if signerIndex == 0 {
		return &api.signer
	}
	if signerIndex == 1 {
		return api.extraSigner
	}
	return nil
}

func (api *fakeWindowsTrustAPI) CertificateFromChain(
	_ *cryptProviderSigner,
	certificateIndex uint32,
) *cryptProviderCert {
	if certificateIndex != 0 {
		return nil
	}
	return &api.providerCertificate
}

func TestWindowsVerifierUsesOnlyBorrowedHandleAndDeterministicRuntimePolicy(t *testing.T) {
	api := newFakeWindowsTrustAPI(t)
	verifier := &windowsVerifier{api: api}
	evidence, err := WithBorrowedFileHandle(windows.Handle(77), verifier.Verify)
	if err != nil {
		t.Fatalf("Verify returned an error: %v", err)
	}
	if api.verifyCalls != 1 || api.closeCalls != 1 {
		t.Fatalf("WinVerifyTrust calls = verify %d, close %d", api.verifyCalls, api.closeCalls)
	}
	if api.verifyAction != windows.WINTRUST_ACTION_GENERIC_VERIFY_V2 {
		t.Fatal("unexpected WinVerifyTrust action")
	}
	if api.verifyFile.File != windows.Handle(77) || api.verifyFile.FilePath != nil {
		t.Fatalf("file input = handle %d, path %p", api.verifyFile.File, api.verifyFile.FilePath)
	}
	if api.verifyFile.KnownSubject == nil || *api.verifyFile.KnownSubject != winTrustKnownSubjectPEImage {
		t.Fatal("file input does not require the PE image subject")
	}
	if api.verifyData.PolicyCallbackData != nil ||
		api.verifyData.SIPClientData != nil ||
		api.verifyData.URLReference != nil ||
		api.verifyData.UIChoice != windows.WTD_UI_NONE ||
		api.verifyData.RevocationChecks != windows.WTD_REVOKE_NONE ||
		api.verifyData.UnionChoice != windows.WTD_CHOICE_FILE ||
		api.verifyData.UIContext != windows.WTD_UICONTEXT_EXECUTE {
		t.Fatalf("unexpected WinVerifyTrust data: %+v", api.verifyData)
	}
	wantFlags := uint32(windows.WTD_REVOCATION_CHECK_NONE | windows.WTD_CACHE_ONLY_URL_RETRIEVAL | windows.WTD_DISABLE_MD2_MD4)
	if api.verifyData.ProviderFlags != wantFlags {
		t.Fatalf("provider flags = 0x%x, want 0x%x", api.verifyData.ProviderFlags, wantFlags)
	}
	if api.verifySettings.Index != 0 ||
		api.verifySettings.Flags != wssVerifySpecific|wssGetSecondarySigCount ||
		api.verifySettings.CryptoPolicy == nil {
		t.Fatalf("unexpected signature settings: %+v", api.verifySettings)
	}
	if api.verifyStrongPolicy.Size != uint32(unsafe.Sizeof(windows.CertStrongSignPara{})) ||
		api.verifyStrongPolicy.InfoChoice != certStrongSignOIDInfo {
		t.Fatalf("unexpected strong-sign policy: %+v", api.verifyStrongPolicy)
	}
	strongPolicyOID, err := readBoundedObjectIdentifier(
		(*byte)(api.verifyStrongPolicy.InfoOrSerializedInfoOrOID),
	)
	if err != nil || strongPolicyOID != strongSignOSCurrentObjectIdentifier {
		t.Fatalf("strong-sign policy OID = %q, %v", strongPolicyOID, err)
	}
	if !evidence.Trusted || evidence.TimestampCounterSignerCount != 1 ||
		evidence.DigestPolicy != DigestPolicySHA256Only ||
		evidence.StrongSignaturePolicy != StrongSignaturePolicyWindowsOSCurrent ||
		evidence.SignerDigestAlgorithmOID != SHA256ObjectIdentifier ||
		evidence.FileDigestAlgorithmOID != SHA256ObjectIdentifier {
		t.Fatalf("unexpected evidence: %+v", evidence)
	}
}

func TestWindowsVerifierAlwaysClosesStateAndPreservesCloseFailure(t *testing.T) {
	tests := []struct {
		name         string
		verifyStatus int32
		closeStatus  int32
		want         error
	}{
		{name: "verification failure", verifyStatus: -1, want: ErrUntrustedSignature},
		{name: "close failure", closeStatus: -1, want: ErrStateCleanup},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			api := newFakeWindowsTrustAPI(t)
			api.verifyStatus = test.verifyStatus
			api.closeStatus = test.closeStatus
			verifier := &windowsVerifier{api: api}
			evidence, err := WithBorrowedFileHandle(windows.Handle(78), verifier.Verify)
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			if evidence != (Evidence{}) {
				t.Fatalf("failure returned evidence: %+v", evidence)
			}
			if api.closeCalls != 1 {
				t.Fatalf("state close calls = %d, want 1", api.closeCalls)
			}
		})
	}
}

func TestWindowsVerifierRejectsAmbiguousSignatureSelection(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fakeWindowsTrustAPI)
	}{
		{name: "secondary signature", mutate: func(api *fakeWindowsTrustAPI) { api.secondarySignatures = 1 }},
		{name: "different verified index", mutate: func(api *fakeWindowsTrustAPI) { api.verifiedSignatureIndex = 1 }},
		{name: "second primary signer", mutate: func(api *fakeWindowsTrustAPI) {
			extra := api.signer
			api.extraSigner = &extra
		}},
		{name: "nested signature attribute", mutate: func(api *fakeWindowsTrustAPI) {
			api.attributeObjectID = append([]byte(nestedSignatureObjectIdentifier), 0)
			api.attributes = []cryptAttribute{{ObjectIdentifier: &api.attributeObjectID[0]}}
			api.signerInfo.UnauthenticatedAttrs = cryptAttributes{
				Count:      uint32(len(api.attributes)),
				Attributes: &api.attributes[0],
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			api := newFakeWindowsTrustAPI(t)
			test.mutate(api)
			verifier := &windowsVerifier{api: api}
			if _, err := WithBorrowedFileHandle(windows.Handle(79), verifier.Verify); !errors.Is(err, ErrAmbiguousSignature) {
				t.Fatalf("error = %v, want ErrAmbiguousSignature", err)
			}
			if api.closeCalls != 1 {
				t.Fatalf("state close calls = %d, want 1", api.closeCalls)
			}
		})
	}
}

func TestWindowsVerifierRequiresSHA256ForSignerFileAndChain(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fakeWindowsTrustAPI)
		want   error
	}{
		{
			name: "SHA-1 primary SignerInfo",
			mutate: func(api *fakeWindowsTrustAPI) {
				api.attributeObjectID = append([]byte("1.3.14.3.2.26"), 0)
				api.signerInfo.HashAlgorithm.ObjectIdentifier = &api.attributeObjectID[0]
			},
			want: ErrWeakAlgorithm,
		},
		{
			name: "SHA-1 PE indirect digest",
			mutate: func(api *fakeWindowsTrustAPI) {
				api.attributeObjectID = append([]byte("1.3.14.3.2.26"), 0)
				api.indirectData.DigestAlgorithm.ObjectIdentifier = &api.attributeObjectID[0]
			},
			want: ErrWeakAlgorithm,
		},
		{
			name: "short PE indirect digest",
			mutate: func(api *fakeWindowsTrustAPI) {
				api.indirectData.Digest.Size = sha256.Size - 1
			},
			want: ErrSignerBinding,
		},
		{
			name: "weak primary chain",
			mutate: func(api *fakeWindowsTrustAPI) {
				api.primaryChain.TrustStatus.ErrorStatus = windows.CERT_TRUST_HAS_WEAK_SIGNATURE
			},
			want: ErrWeakAlgorithm,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			api := newFakeWindowsTrustAPI(t)
			test.mutate(api)
			verifier := &windowsVerifier{api: api}
			if _, err := WithBorrowedFileHandle(windows.Handle(83), verifier.Verify); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			if api.closeCalls != 1 {
				t.Fatalf("state close calls = %d, want 1", api.closeCalls)
			}
		})
	}
}

func TestWindowsVerifierValidatesEveryTimestampCounterSigner(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fakeWindowsTrustAPI)
		want   error
	}{
		{name: "missing countersigner", mutate: func(api *fakeWindowsTrustAPI) { api.counterSignerMissing = true }, want: ErrSignerBinding},
		{name: "short countersigner structure", mutate: func(api *fakeWindowsTrustAPI) { api.counterSigner.Size = 0 }, want: ErrSignerBinding},
		{name: "non-timestamp countersigner", mutate: func(api *fakeWindowsTrustAPI) { api.counterSigner.SignerType = 0 }, want: ErrSignerBinding},
		{name: "countersigner trust error", mutate: func(api *fakeWindowsTrustAPI) { api.counterSigner.Error = 1 }, want: ErrUntrustedSignature},
		{name: "missing countersigner SignerInfo", mutate: func(api *fakeWindowsTrustAPI) { api.counterSigner.SignerInfo = nil }, want: ErrSignerBinding},
		{name: "nested countersigner", mutate: func(api *fakeWindowsTrustAPI) { api.counterSigner.CounterSignerCount = 1 }, want: ErrAmbiguousSignature},
		{name: "missing countersigner chain", mutate: func(api *fakeWindowsTrustAPI) { api.counterSigner.ChainContext = nil }, want: ErrSignerBinding},
		{name: "weak countersigner chain", mutate: func(api *fakeWindowsTrustAPI) {
			api.counterSignerChain.TrustStatus.ErrorStatus = windows.CERT_TRUST_HAS_WEAK_SIGNATURE
		}, want: ErrWeakAlgorithm},
		{name: "SHA-1 countersigner", mutate: func(api *fakeWindowsTrustAPI) {
			api.attributeObjectID = append([]byte("1.3.14.3.2.26"), 0)
			api.counterSignerInfo.HashAlgorithm.ObjectIdentifier = &api.attributeObjectID[0]
		}, want: ErrWeakAlgorithm},
		{name: "extra countersigner", mutate: func(api *fakeWindowsTrustAPI) {
			extra := api.counterSigner
			api.extraCounterSigner = &extra
		}, want: ErrSignerBinding},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			api := newFakeWindowsTrustAPI(t)
			test.mutate(api)
			verifier := &windowsVerifier{api: api}
			if _, err := WithBorrowedFileHandle(windows.Handle(84), verifier.Verify); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			if api.closeCalls != 1 {
				t.Fatalf("state close calls = %d, want 1", api.closeCalls)
			}
		})
	}
}

func TestWindowsVerifierBindsLeafToPrimarySignerInfo(t *testing.T) {
	api := newFakeWindowsTrustAPI(t)
	api.mismatchedSerial = []byte{0x2b}
	api.signerInfo.SerialNumber = blobFromBytes(api.mismatchedSerial)
	verifier := &windowsVerifier{api: api}
	if _, err := WithBorrowedFileHandle(windows.Handle(80), verifier.Verify); !errors.Is(err, ErrSignerBinding) {
		t.Fatalf("error = %v, want ErrSignerBinding", err)
	}
	if api.closeCalls != 1 {
		t.Fatalf("state close calls = %d, want 1", api.closeCalls)
	}
}

func TestWindowsVerifierRejectsTimestampAsPrimarySigner(t *testing.T) {
	api := newFakeWindowsTrustAPI(t)
	api.signer.SignerType = signerTypeTimestamp
	verifier := &windowsVerifier{api: api}
	if _, err := WithBorrowedFileHandle(windows.Handle(81), verifier.Verify); !errors.Is(err, ErrSignerBinding) {
		t.Fatalf("error = %v, want ErrSignerBinding", err)
	}
}

func TestBorrowedFileHandleSubjectIsSingleUseAndCallbackScoped(t *testing.T) {
	var retained Subject
	_, err := WithBorrowedFileHandle(windows.Handle(82), func(subject Subject) (Evidence, error) {
		retained = subject
		handle, release, borrowErr := subject.borrowHandle()
		if borrowErr != nil {
			return Evidence{}, borrowErr
		}
		if handle != windows.Handle(82) {
			t.Fatalf("borrowed handle = %d", handle)
		}
		release()
		_, _, secondErr := subject.borrowHandle()
		return Evidence{}, secondErr
	})
	if !errors.Is(err, ErrSubjectConsumed) {
		t.Fatalf("second borrow error = %v, want ErrSubjectConsumed", err)
	}
	if _, _, err := retained.borrowHandle(); !errors.Is(err, ErrInvalidSubject) {
		t.Fatalf("post-callback borrow error = %v, want ErrInvalidSubject", err)
	}
}

func TestWindowsNativeLayoutsMatchWinTrustHeaders(t *testing.T) {
	wantPESubject := windows.GUID{
		Data1: 0xc689aab8,
		Data2: 0x8e78,
		Data3: 0x11d0,
		Data4: [8]byte{0x8c, 0x47, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee},
	}
	if winTrustKnownSubjectPEImage != wantPESubject {
		t.Fatalf("PE SIP subject GUID = %v", winTrustKnownSubjectPEImage)
	}
	pointerSize := unsafe.Sizeof(uintptr(0))
	type layout struct {
		name   string
		got    uintptr
		want64 uintptr
		want32 uintptr
	}
	layouts := []layout{
		{name: "WINTRUST_FILE_INFO", got: unsafe.Sizeof(winTrustFileInfo{}), want64: 32, want32: 16},
		{name: "WINTRUST_SIGNATURE_SETTINGS", got: unsafe.Sizeof(winTrustSignatureSettings{}), want64: 32, want32: 24},
		{name: "WINTRUST_DATA", got: unsafe.Sizeof(winTrustData{}), want64: 88, want32: 52},
		{name: "CERT_STRONG_SIGN_PARA", got: unsafe.Sizeof(windows.CertStrongSignPara{}), want64: 16, want32: 12},
		{name: "CRYPT_PROVIDER_DATA prefix", got: unsafe.Sizeof(cryptProviderData{}), want64: 168, want32: 88},
		{name: "PROVDATA_SIP", got: unsafe.Sizeof(providerDataSIP{}), want64: 64, want32: 40},
		{name: "CRYPT_PROVIDER_SGNR", got: unsafe.Sizeof(cryptProviderSigner{}), want64: 64, want32: 44},
		{name: "CRYPT_PROVIDER_CERT prefix", got: unsafe.Sizeof(cryptProviderCert{}), want64: 48, want32: 36},
		{name: "CRYPT_ATTRIBUTE_TYPE_VALUE", got: unsafe.Sizeof(cryptAttributeTypeValue{}), want64: 24, want32: 12},
		{name: "SPC_INDIRECT_DATA_CONTENT", got: unsafe.Sizeof(spcIndirectDataContent{}), want64: 64, want32: 32},
		{name: "CMSG_SIGNER_INFO", got: unsafe.Sizeof(cryptMessageSignerInfo{}), want64: 136, want32: 68},
	}
	for _, value := range layouts {
		want := value.want64
		if pointerSize == 4 {
			want = value.want32
		}
		if value.got != want {
			t.Errorf("%s size = %d, want %d", value.name, value.got, want)
		}
	}
}
