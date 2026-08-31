//go:build windows

package authenticode

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wssVerifySpecific         = uint32(0x00000001)
	wssGetSecondarySigCount   = uint32(0x00000002)
	certStrongSignOIDInfo     = uint32(2)
	cryptProviderChoiceSIP    = uint32(1)
	maximumSignerAttributes   = uint32(256)
	maximumAttributeValues    = uint32(64)
	maximumObjectIdentifier   = uintptr(128)
	maximumIssuerNameBytes    = uint32(64 << 10)
	maximumCertificateSerial  = uint32(128)
	minimumProviderDataSize   = uint32(unsafe.Sizeof(cryptProviderData{}))
	minimumProviderSIPSize    = uint32(unsafe.Sizeof(providerDataSIP{}))
	minimumProviderSignerSize = uint32(unsafe.Sizeof(cryptProviderSigner{}))
	minimumProviderCertSize   = uint32(unsafe.Sizeof(cryptProviderCert{}))
)

const nestedSignatureObjectIdentifier = "1.3.6.1.4.1.311.2.4.1"

const strongSignOSCurrentObjectIdentifier = "1.3.6.1.4.1.311.72.1.1"

var strongSignOSCurrentObjectIdentifierBytes = []byte(strongSignOSCurrentObjectIdentifier + "\x00")

// winTrustKnownSubjectPEImage is the PE SIP v2 known-subject GUID C689AAB8.
// It was historically published as CRYPT_SUBJTYPE_PE_IMAGE and is not the
// legacy WIN_TRUST_SUBJTYPE_PE_IMAGE GUID 43C9A1E0.
var winTrustKnownSubjectPEImage = windows.GUID{
	Data1: 0xc689aab8,
	Data2: 0x8e78,
	Data3: 0x11d0,
	Data4: [8]byte{0x8c, 0x47, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee},
}

type winTrustFileInfo struct {
	Size         uint32
	FilePath     *uint16
	File         windows.Handle
	KnownSubject *windows.GUID
}

type winTrustSignatureSettings struct {
	Size                    uint32
	Index                   uint32
	Flags                   uint32
	SecondarySignatureCount uint32
	VerifiedSignatureIndex  uint32
	CryptoPolicy            *windows.CertStrongSignPara
}

type winTrustData struct {
	Size               uint32
	PolicyCallbackData unsafe.Pointer
	SIPClientData      unsafe.Pointer
	UIChoice           uint32
	RevocationChecks   uint32
	UnionChoice        uint32
	File               *winTrustFileInfo
	StateAction        uint32
	StateData          windows.Handle
	URLReference       *uint16
	ProviderFlags      uint32
	UIContext          uint32
	SignatureSettings  *winTrustSignatureSettings
}

type cryptProviderData struct {
	Size                     uint32
	WinTrustData             *winTrustData
	OpenedFile               int32
	ParentWindow             windows.HWND
	ActionID                 *windows.GUID
	Provider                 windows.Handle
	Error                    uint32
	RegistrySecuritySettings uint32
	RegistryPolicySettings   uint32
	Functions                unsafe.Pointer
	TrustStepErrorCount      uint32
	TrustStepErrors          *uint32
	StoreCount               uint32
	Stores                   *windows.Handle
	Encoding                 uint32
	Message                  windows.Handle
	SignerCount              uint32
	Signers                  *cryptProviderSigner
	PrivateDataCount         uint32
	PrivateData              unsafe.Pointer
	SubjectChoice            uint32
	SIPData                  *providerDataSIP
}

type providerDataSIP struct {
	Size               uint32
	Subject            windows.GUID
	Dispatch           unsafe.Pointer
	CatalogDispatch    unsafe.Pointer
	SubjectInfo        unsafe.Pointer
	CatalogSubjectInfo unsafe.Pointer
	IndirectData       *spcIndirectDataContent
}

type cryptProviderSigner struct {
	Size               uint32
	VerifyAsOf         windows.Filetime
	CertificateCount   uint32
	CertificateChain   *cryptProviderCert
	SignerType         uint32
	SignerInfo         *cryptMessageSignerInfo
	Error              uint32
	CounterSignerCount uint32
	CounterSigners     *cryptProviderSigner
	ChainContext       *windows.CertChainContext
}

type cryptProviderCert struct {
	Size            uint32
	Certificate     *windows.CertContext
	Commercial      int32
	TrustedRoot     int32
	SelfSigned      int32
	TestCertificate int32
	RevokedReason   uint32
	Confidence      uint32
	Error           uint32
}

type cryptDataBlob struct {
	Size uint32
	Data *byte
}

type cryptAlgorithmIdentifier struct {
	ObjectIdentifier *byte
	Parameters       cryptDataBlob
}

type cryptAttributeTypeValue struct {
	ObjectIdentifier *byte
	Value            cryptDataBlob
}

type spcIndirectDataContent struct {
	Data            cryptAttributeTypeValue
	DigestAlgorithm cryptAlgorithmIdentifier
	Digest          cryptDataBlob
}

type cryptAttribute struct {
	ObjectIdentifier *byte
	ValueCount       uint32
	Values           *cryptDataBlob
}

type cryptAttributes struct {
	Count      uint32
	Attributes *cryptAttribute
}

type cryptMessageSignerInfo struct {
	Version                 uint32
	Issuer                  cryptDataBlob
	SerialNumber            cryptDataBlob
	HashAlgorithm           cryptAlgorithmIdentifier
	HashEncryptionAlgorithm cryptAlgorithmIdentifier
	EncryptedHash           cryptDataBlob
	AuthenticatedAttributes cryptAttributes
	UnauthenticatedAttrs    cryptAttributes
}

type windowsTrustAPI interface {
	WinVerifyTrust(*windows.GUID, *winTrustData) int32
	ProviderDataFromStateData(windows.Handle) *cryptProviderData
	SignerFromChain(*cryptProviderData, uint32, bool, uint32) *cryptProviderSigner
	CertificateFromChain(*cryptProviderSigner, uint32) *cryptProviderCert
}

type windowsVerifier struct {
	api windowsTrustAPI
}

// NewWindowsVerifier creates the production embedded Authenticode verifier.
func NewWindowsVerifier() (Verifier, error) {
	api, err := newNativeWindowsTrustAPI()
	if err != nil {
		return nil, err
	}
	return &windowsVerifier{api: api}, nil
}

func (verifier *windowsVerifier) Verify(subject Subject) (Evidence, error) {
	if verifier == nil || verifier.api == nil {
		return Evidence{}, errors.New("Authenticode verifier is not initialized")
	}
	handle, release, err := subject.borrowHandle()
	if err != nil {
		return Evidence{}, err
	}
	defer release()
	return verifier.verifyFileHandle(handle)
}

func (verifier *windowsVerifier) verifyFileHandle(handle windows.Handle) (evidence Evidence, err error) {
	fileInfo := &winTrustFileInfo{
		Size:         uint32(unsafe.Sizeof(winTrustFileInfo{})),
		File:         handle,
		KnownSubject: &winTrustKnownSubjectPEImage,
	}
	strongSignPolicy := &windows.CertStrongSignPara{
		Size:                      uint32(unsafe.Sizeof(windows.CertStrongSignPara{})),
		InfoChoice:                certStrongSignOIDInfo,
		InfoOrSerializedInfoOrOID: unsafe.Pointer(&strongSignOSCurrentObjectIdentifierBytes[0]),
	}
	signatureSettings := &winTrustSignatureSettings{
		Size:         uint32(unsafe.Sizeof(winTrustSignatureSettings{})),
		Index:        0,
		Flags:        wssVerifySpecific | wssGetSecondarySigCount,
		CryptoPolicy: strongSignPolicy,
	}
	trustData := &winTrustData{
		Size:              uint32(unsafe.Sizeof(winTrustData{})),
		UIChoice:          windows.WTD_UI_NONE,
		RevocationChecks:  windows.WTD_REVOKE_NONE,
		UnionChoice:       windows.WTD_CHOICE_FILE,
		File:              fileInfo,
		StateAction:       windows.WTD_STATEACTION_VERIFY,
		ProviderFlags:     windows.WTD_REVOCATION_CHECK_NONE | windows.WTD_CACHE_ONLY_URL_RETRIEVAL | windows.WTD_DISABLE_MD2_MD4,
		UIContext:         windows.WTD_UICONTEXT_EXECUTE,
		SignatureSettings: signatureSettings,
	}
	var pinner runtime.Pinner
	pinner.Pin(fileInfo)
	pinner.Pin(strongSignPolicy)
	pinner.Pin(&strongSignOSCurrentObjectIdentifierBytes[0])
	pinner.Pin(signatureSettings)
	pinner.Pin(trustData)
	defer pinner.Unpin()

	status := verifier.api.WinVerifyTrust(&windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, trustData)
	if validTrustStateHandle(trustData.StateData) {
		defer func() {
			if closeErr := verifier.closeTrustState(trustData); closeErr != nil {
				evidence = Evidence{}
				err = errors.Join(err, closeErr)
			}
		}()
	}
	if status != 0 {
		return Evidence{}, errors.Join(
			ErrUntrustedSignature,
			winTrustStatusError("WinVerifyTrust verification", status),
		)
	}
	if !validTrustStateHandle(trustData.StateData) {
		return Evidence{}, fmt.Errorf("%w: WinVerifyTrust returned no provider state", ErrSignerBinding)
	}

	providerData := verifier.api.ProviderDataFromStateData(trustData.StateData)
	if providerData == nil {
		return Evidence{}, fmt.Errorf("%w: WTHelperProvDataFromStateData returned nil", ErrSignerBinding)
	}
	if err := validateProviderState(providerData, trustData); err != nil {
		return Evidence{}, err
	}
	primarySigner := verifier.api.SignerFromChain(providerData, 0, false, 0)
	if primarySigner == nil {
		return Evidence{}, fmt.Errorf("%w: verified provider state has no primary signer", ErrSignerBinding)
	}
	primarySignerCount := providerData.SignerCount
	secondPrimarySigner := verifier.api.SignerFromChain(providerData, 1, false, 0)
	if secondPrimarySigner != nil && primarySignerCount < 2 {
		primarySignerCount = 2
	}
	if secondPrimarySigner == nil && primarySignerCount > 1 {
		return Evidence{}, fmt.Errorf("%w: provider primary signer count is inconsistent", ErrSignerBinding)
	}
	if primarySigner.Size < minimumProviderSignerSize || primarySigner.SignerInfo == nil {
		return Evidence{}, fmt.Errorf("%w: primary signer state is incomplete", ErrSignerBinding)
	}
	if err := validateSHA256SignerInfo("primary signer", primarySigner.SignerInfo); err != nil {
		return Evidence{}, err
	}

	nestedSignature, nestedErr := hasNestedSignatureAttribute(primarySigner.SignerInfo)
	if nestedErr != nil {
		return Evidence{}, nestedErr
	}
	facts := signaturePolicyFacts{
		VerifiedSignatureIndex:      signatureSettings.VerifiedSignatureIndex,
		SecondarySignatureCount:     signatureSettings.SecondarySignatureCount,
		PrimarySignerCount:          primarySignerCount,
		SignerType:                  primarySigner.SignerType,
		SignerError:                 primarySigner.Error,
		CertificateChainCount:       primarySigner.CertificateCount,
		TimestampCounterSignerCount: primarySigner.CounterSignerCount,
		NestedSignaturePresent:      nestedSignature,
	}
	if err := validateSignaturePolicy(facts); err != nil {
		return Evidence{}, err
	}
	if err := validateChainStrength("primary signer", primarySigner.ChainContext); err != nil {
		return Evidence{}, err
	}
	if err := verifier.validateTimestampCounterSigners(providerData, primarySigner); err != nil {
		return Evidence{}, err
	}

	leaf, err := verifier.providerLeafCertificate("primary signer", primarySigner)
	if err != nil {
		return Evidence{}, err
	}
	if err := bindLeafCertificate(primarySigner.SignerInfo, leaf.Certificate); err != nil {
		return Evidence{}, err
	}
	der, err := copyCertificateDER(leaf.Certificate)
	if err != nil {
		return Evidence{}, err
	}
	return evidenceFromLeafCertificate(der, primarySigner.CounterSignerCount)
}

func (verifier *windowsVerifier) closeTrustState(trustData *winTrustData) error {
	trustData.StateAction = windows.WTD_STATEACTION_CLOSE
	status := verifier.api.WinVerifyTrust(&windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, trustData)
	if status != 0 {
		return errors.Join(
			ErrStateCleanup,
			winTrustStatusError("WinVerifyTrust state close", status),
		)
	}
	trustData.StateData = 0
	return nil
}

func validTrustStateHandle(handle windows.Handle) bool {
	return handle != 0 && handle != windows.InvalidHandle
}

func winTrustStatusError(operation string, status int32) error {
	code := uint32(status)
	return fmt.Errorf("%s returned 0x%08x: %w", operation, code, windows.Errno(code))
}

func validateProviderState(providerData *cryptProviderData, trustData *winTrustData) error {
	if providerData.Size < minimumProviderDataSize || providerData.WinTrustData == nil {
		return fmt.Errorf("%w: WinVerifyTrust provider state is incomplete", ErrSignerBinding)
	}
	providerTrustData := providerData.WinTrustData
	if providerTrustData.UnionChoice != windows.WTD_CHOICE_FILE ||
		providerTrustData.File == nil || trustData.File == nil ||
		providerTrustData.File.File != trustData.File.File ||
		providerTrustData.File.FilePath != nil {
		return fmt.Errorf("%w: provider state is not bound to the borrowed file handle", ErrSignerBinding)
	}
	if providerData.Encoding&(windows.X509_ASN_ENCODING|windows.PKCS_7_ASN_ENCODING) !=
		(windows.X509_ASN_ENCODING|windows.PKCS_7_ASN_ENCODING) || providerData.Message == 0 {
		return fmt.Errorf("%w: provider state has no decoded Authenticode message", ErrSignerBinding)
	}
	if providerData.SubjectChoice != cryptProviderChoiceSIP || providerData.SIPData == nil ||
		providerData.SIPData.Size < minimumProviderSIPSize {
		return fmt.Errorf("%w: provider state has no complete SIP data", ErrSignerBinding)
	}
	if providerData.SIPData.Subject != winTrustKnownSubjectPEImage ||
		providerData.SIPData.IndirectData == nil {
		return fmt.Errorf("%w: provider state is not a PE indirect-data subject", ErrSignerBinding)
	}
	indirectData := providerData.SIPData.IndirectData
	objectIdentifier, err := readBoundedObjectIdentifier(indirectData.DigestAlgorithm.ObjectIdentifier)
	if err != nil {
		return fmt.Errorf("%w: read PE indirect-data digest algorithm: %v", ErrWeakAlgorithm, err)
	}
	if objectIdentifier != SHA256ObjectIdentifier {
		return fmt.Errorf(
			"%w: PE indirect-data digest algorithm is %q, not SHA-256",
			ErrWeakAlgorithm,
			objectIdentifier,
		)
	}
	if indirectData.Digest.Size != sha256.Size || indirectData.Digest.Data == nil {
		return fmt.Errorf(
			"%w: PE indirect-data SHA-256 digest has length %d",
			ErrSignerBinding,
			indirectData.Digest.Size,
		)
	}
	return nil
}

func validateSHA256SignerInfo(label string, signerInfo *cryptMessageSignerInfo) error {
	if signerInfo == nil {
		return fmt.Errorf("%w: %s has no SignerInfo", ErrSignerBinding, label)
	}
	objectIdentifier, err := readBoundedObjectIdentifier(signerInfo.HashAlgorithm.ObjectIdentifier)
	if err != nil {
		return fmt.Errorf("%w: read %s digest algorithm: %v", ErrWeakAlgorithm, label, err)
	}
	if objectIdentifier != SHA256ObjectIdentifier {
		return fmt.Errorf(
			"%w: %s digest algorithm is %q, not SHA-256",
			ErrWeakAlgorithm,
			label,
			objectIdentifier,
		)
	}
	return nil
}

func validateChainStrength(label string, chain *windows.CertChainContext) error {
	if chain == nil || chain.Size < uint32(unsafe.Sizeof(windows.CertChainContext{})) ||
		chain.ChainCount == 0 || chain.ChainCount > maximumCertificateChain {
		return fmt.Errorf("%w: %s certificate chain context is incomplete", ErrSignerBinding, label)
	}
	if chain.TrustStatus.ErrorStatus&windows.CERT_TRUST_HAS_WEAK_SIGNATURE != 0 {
		return fmt.Errorf("%w: %s certificate chain reports a weak signature", ErrWeakAlgorithm, label)
	}
	return nil
}

func (verifier *windowsVerifier) validateTimestampCounterSigners(
	providerData *cryptProviderData,
	primarySigner *cryptProviderSigner,
) error {
	for index := uint32(0); index < primarySigner.CounterSignerCount; index++ {
		counterSigner := verifier.api.SignerFromChain(providerData, 0, true, index)
		label := fmt.Sprintf("timestamp countersigner %d", index)
		if counterSigner == nil || counterSigner.Size < minimumProviderSignerSize ||
			counterSigner.SignerInfo == nil {
			return fmt.Errorf("%w: %s state is incomplete", ErrSignerBinding, label)
		}
		if counterSigner.SignerType != signerTypeTimestamp {
			return fmt.Errorf("%w: countersigner %d is not a timestamp signer", ErrSignerBinding, index)
		}
		if counterSigner.Error != 0 {
			return fmt.Errorf(
				"%w: %s state has error 0x%08x",
				ErrUntrustedSignature,
				label,
				counterSigner.Error,
			)
		}
		if counterSigner.CounterSignerCount != 0 ||
			counterSigner.CertificateCount == 0 ||
			counterSigner.CertificateCount > maximumCertificateChain {
			return fmt.Errorf("%w: %s chain or nesting is invalid", ErrAmbiguousSignature, label)
		}
		if err := validateSHA256SignerInfo(label, counterSigner.SignerInfo); err != nil {
			return err
		}
		nested, err := hasNestedSignatureAttribute(counterSigner.SignerInfo)
		if err != nil {
			return err
		}
		if nested {
			return fmt.Errorf("%w: %s contains a nested signature", ErrAmbiguousSignature, label)
		}
		if err := validateChainStrength(label, counterSigner.ChainContext); err != nil {
			return err
		}
		leaf, err := verifier.providerLeafCertificate(label, counterSigner)
		if err != nil {
			return err
		}
		if err := bindLeafCertificate(counterSigner.SignerInfo, leaf.Certificate); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	if verifier.api.SignerFromChain(providerData, 0, true, primarySigner.CounterSignerCount) != nil {
		return fmt.Errorf("%w: provider countersigner count is inconsistent", ErrSignerBinding)
	}
	return nil
}

func (verifier *windowsVerifier) providerLeafCertificate(
	label string,
	signer *cryptProviderSigner,
) (*cryptProviderCert, error) {
	leaf := verifier.api.CertificateFromChain(signer, 0)
	if leaf == nil || leaf.Size < minimumProviderCertSize || leaf.Certificate == nil {
		return nil, fmt.Errorf("%w: %s chain has no complete leaf certificate", ErrSignerBinding, label)
	}
	if leaf.Error != 0 {
		return nil, fmt.Errorf(
			"%w: %s leaf state has error 0x%08x",
			ErrUntrustedSignature,
			label,
			leaf.Error,
		)
	}
	return leaf, nil
}

func hasNestedSignatureAttribute(signerInfo *cryptMessageSignerInfo) (bool, error) {
	authenticated, err := attributesContainObjectIdentifier(
		signerInfo.AuthenticatedAttributes,
		nestedSignatureObjectIdentifier,
	)
	if err != nil || authenticated {
		return authenticated, err
	}
	return attributesContainObjectIdentifier(
		signerInfo.UnauthenticatedAttrs,
		nestedSignatureObjectIdentifier,
	)
}

func attributesContainObjectIdentifier(attributes cryptAttributes, expected string) (bool, error) {
	if attributes.Count > maximumSignerAttributes {
		return false, fmt.Errorf(
			"%w: SignerInfo attribute count %d exceeds the supported limit",
			ErrAmbiguousSignature,
			attributes.Count,
		)
	}
	if attributes.Count == 0 {
		return false, nil
	}
	if attributes.Attributes == nil {
		return false, fmt.Errorf("%w: SignerInfo attributes pointer is nil", ErrSignerBinding)
	}
	for index := uint32(0); index < attributes.Count; index++ {
		attribute := (*cryptAttribute)(unsafe.Add(
			unsafe.Pointer(attributes.Attributes),
			uintptr(index)*unsafe.Sizeof(cryptAttribute{}),
		))
		if attribute.ValueCount > maximumAttributeValues ||
			(attribute.ValueCount != 0 && attribute.Values == nil) {
			return false, fmt.Errorf("%w: SignerInfo attribute %d has invalid values", ErrSignerBinding, index)
		}
		objectIdentifier, err := readBoundedObjectIdentifier(attribute.ObjectIdentifier)
		if err != nil {
			return false, fmt.Errorf("%w: SignerInfo attribute %d: %v", ErrSignerBinding, index, err)
		}
		if objectIdentifier == expected {
			return true, nil
		}
	}
	return false, nil
}

func readBoundedObjectIdentifier(pointer *byte) (string, error) {
	if pointer == nil {
		return "", errors.New("object identifier pointer is nil")
	}
	var buffer [maximumObjectIdentifier]byte
	for index := uintptr(0); index < maximumObjectIdentifier; index++ {
		value := *(*byte)(unsafe.Add(unsafe.Pointer(pointer), index))
		if value == 0 {
			if index == 0 {
				return "", errors.New("object identifier is empty")
			}
			return string(buffer[:index]), nil
		}
		buffer[index] = value
	}
	return "", fmt.Errorf("object identifier exceeds %d bytes", maximumObjectIdentifier-1)
}

func bindLeafCertificate(signerInfo *cryptMessageSignerInfo, certificate *windows.CertContext) error {
	if certificate.CertInfo == nil {
		return fmt.Errorf("%w: leaf certificate has no CERT_INFO", ErrSignerBinding)
	}
	if certificate.EncodingType&windows.X509_ASN_ENCODING == 0 {
		return fmt.Errorf("%w: leaf certificate does not use X.509 encoding", ErrSignerBinding)
	}
	signerIssuer, err := boundedBlob(
		"SignerInfo issuer",
		signerInfo.Issuer.Size,
		signerInfo.Issuer.Data,
		maximumIssuerNameBytes,
	)
	if err != nil {
		return err
	}
	certificateIssuer, err := boundedBlob(
		"leaf certificate issuer",
		certificate.CertInfo.Issuer.Size,
		certificate.CertInfo.Issuer.Data,
		maximumIssuerNameBytes,
	)
	if err != nil {
		return err
	}
	signerSerial, err := boundedBlob(
		"SignerInfo serial number",
		signerInfo.SerialNumber.Size,
		signerInfo.SerialNumber.Data,
		maximumCertificateSerial,
	)
	if err != nil {
		return err
	}
	certificateSerial, err := boundedBlob(
		"leaf certificate serial number",
		certificate.CertInfo.SerialNumber.Size,
		certificate.CertInfo.SerialNumber.Data,
		maximumCertificateSerial,
	)
	if err != nil {
		return err
	}
	if !bytes.Equal(signerIssuer, certificateIssuer) || !bytes.Equal(signerSerial, certificateSerial) {
		return fmt.Errorf(
			"%w: primary SignerInfo issuer and serial do not identify the chain leaf",
			ErrSignerBinding,
		)
	}
	return nil
}

func boundedBlob(label string, size uint32, data *byte, maximum uint32) ([]byte, error) {
	if size == 0 || size > maximum {
		return nil, fmt.Errorf(
			"%w: %s length %d is outside the supported range",
			ErrSignerBinding,
			label,
			size,
		)
	}
	if data == nil {
		return nil, fmt.Errorf("%w: %s pointer is nil", ErrSignerBinding, label)
	}
	return unsafe.Slice(data, int(size)), nil
}

func copyCertificateDER(certificate *windows.CertContext) ([]byte, error) {
	if certificate.Length == 0 || certificate.Length > maximumCertificateDERBytes {
		return nil, fmt.Errorf(
			"%w: leaf certificate DER length %d is outside the supported range",
			ErrInvalidCertificate,
			certificate.Length,
		)
	}
	if certificate.EncodedCert == nil {
		return nil, fmt.Errorf("%w: leaf certificate DER pointer is nil", ErrInvalidCertificate)
	}
	return bytes.Clone(unsafe.Slice(certificate.EncodedCert, int(certificate.Length))), nil
}

type nativeWindowsTrustAPI struct{}

func newNativeWindowsTrustAPI() (windowsTrustAPI, error) {
	procedures := []struct {
		name      string
		procedure *windows.LazyProc
	}{
		{"WinVerifyTrust", procWinVerifyTrust},
		{"WTHelperProvDataFromStateData", procWTHelperProvDataFromStateData},
		{"WTHelperGetProvSignerFromChain", procWTHelperGetProvSignerFromChain},
		{"WTHelperGetProvCertFromChain", procWTHelperGetProvCertFromChain},
	}
	for _, entry := range procedures {
		if err := entry.procedure.Find(); err != nil {
			return nil, fmt.Errorf("resolve %s from wintrust.dll: %w", entry.name, err)
		}
	}
	return nativeWindowsTrustAPI{}, nil
}

func (nativeWindowsTrustAPI) WinVerifyTrust(action *windows.GUID, data *winTrustData) int32 {
	result := winVerifyTrust(windows.InvalidHWND, action, data)
	runtime.KeepAlive(action)
	runtime.KeepAlive(data)
	return result
}

func (nativeWindowsTrustAPI) ProviderDataFromStateData(state windows.Handle) *cryptProviderData {
	return pointerFromNativeResult[cryptProviderData](providerDataFromStateDataRaw(state))
}

func (nativeWindowsTrustAPI) SignerFromChain(
	providerData *cryptProviderData,
	signerIndex uint32,
	counterSigner bool,
	counterSignerIndex uint32,
) *cryptProviderSigner {
	result := pointerFromNativeResult[cryptProviderSigner](
		signerFromChainRaw(providerData, signerIndex, counterSigner, counterSignerIndex),
	)
	runtime.KeepAlive(providerData)
	return result
}

func (nativeWindowsTrustAPI) CertificateFromChain(
	signer *cryptProviderSigner,
	certificateIndex uint32,
) *cryptProviderCert {
	result := pointerFromNativeResult[cryptProviderCert](
		certificateFromChainRaw(signer, certificateIndex),
	)
	runtime.KeepAlive(signer)
	return result
}

func pointerFromNativeResult[T any](value uintptr) *T {
	// The result identifies WinTrust-owned memory, not a Go allocation. It is
	// consumed only while the pinned WinVerifyTrust state remains open.
	return *(**T)(unsafe.Pointer(&value))
}
