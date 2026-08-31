package wincert

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
)

const (
	// LocalMachineStoreScope identifies the fixed native certificate-store scope.
	LocalMachineStoreScope = "LocalMachine"
	// LocalMachinePersonalStore is the only certificate store accepted by Acquire.
	LocalMachinePersonalStore = "MY"

	maximumStoreCertificates   = 1024
	maximumCertificateDERBytes = 64 * 1024
	maximumChainCertificates   = 16
	maximumChainDERBytes       = 512 * 1024

	p256DigestBytes    = sha256.Size
	p256SignatureBytes = 2 * p256DigestBytes

	ncryptAllowSigningFlag = uint32(0x00000002)
	ecdsaPublicP256Magic   = uint32(0x31534345)
	cryptMachineKeysetFlag = uint32(0x00000020)
	cngProviderKeySpec     = uint32(0)

	approvedKeyStorageProvider = "Microsoft Software Key Storage Provider"
	systemSID                  = "S-1-5-18"
	administratorsSID          = "S-1-5-32-544"

	securityDACLPresent               = uint16(0x0004)
	securityDACLDefaulted             = uint16(0x0008)
	securityDACLProtected             = uint16(0x1000)
	securityDescriptorSelfRelative    = uint16(0x8000)
	securityOwnerDefaulted            = uint16(0x0001)
	accessAllowedACEType              = uint8(0)
	aclRevision                       = uint8(2)
	aclRevisionDS                     = uint8(4)
	maximumKeySecurityACEs            = 16
	maximumKeySecurityDescriptorBytes = 64 * 1024

	genericAllAccess    = uint32(0x10000000)
	genericWriteAccess  = uint32(0x40000000)
	genericReadAccess   = uint32(0x80000000)
	deleteAccess        = uint32(0x00010000)
	readControlAccess   = uint32(0x00020000)
	writeDACLAccess     = uint32(0x00040000)
	writeOwnerAccess    = uint32(0x00080000)
	synchronizeAccess   = uint32(0x00100000)
	standardFullControl = deleteAccess | readControlAccess | writeDACLAccess | writeOwnerAccess
)

var (
	ErrUnsupportedPlatform      = errors.New("Windows certificate acquisition is unsupported on this platform")
	ErrInvalidConfiguration     = errors.New("invalid Windows certificate configuration")
	ErrCertificateNotFound      = errors.New("pinned certificate was not found")
	ErrDuplicateCertificate     = errors.New("pinned certificate appears more than once")
	ErrEnumerationLimit         = errors.New("certificate-store enumeration limit reached")
	ErrInvalidCertificate       = errors.New("certificate does not satisfy the P-256 client policy")
	ErrInvalidProviderInfo      = errors.New("certificate key provider information is invalid")
	ErrInvalidKey               = errors.New("CNG key does not satisfy the P-256 signing policy")
	ErrInvalidKeySecurity       = errors.New("CNG key security descriptor is invalid")
	ErrInvalidDigest            = errors.New("certificate signing requires an exactly 32-byte digest")
	ErrUnsupportedSignerOptions = errors.New("certificate signing requires SHA-256 signer options")
	ErrInvalidSignature         = errors.New("CNG returned an invalid P-256 signature")
	ErrClosed                   = errors.New("Windows certificate credential is closed")
	ErrAttestationUnavailable   = errors.New("Windows certificate credential attestation is unavailable")
)

// Config selects one certificate by the SHA-256 digest of its exact DER form
// and binds the expected key DACL to the independently verified service SIDs.
// StoreName currently accepts only the Local Machine MY store.
type Config struct {
	StoreName         string
	CertificateSHA256 string
	// ExpectedKeySecurityDescriptorSHA256 pins the exact self-relative
	// OWNER/GROUP/DACL bytes returned by the CNG key storage provider.
	ExpectedKeySecurityDescriptorSHA256 string
	// ControlServiceSID and ExecutorServiceSID must already be independently
	// verified individual service SIDs.
	ControlServiceSID  string
	ExecutorServiceSID string
}

// KeyIdentity is the shared detached CNG identity used to reject key reuse
// across the mTLS and local-authority purposes.
type KeyIdentity = cng.KeyIdentity

// Attestation is a detached snapshot of the native certificate and key values
// that were observed and validated during acquisition. Its fields are private;
// every accessor returns a value copy.
type Attestation struct {
	storeScope                  string
	storeName                   string
	certificateDERSHA256        [sha256.Size]byte
	containerName               string
	keyName                     string
	keySecurityDescriptorSHA256 [sha256.Size]byte
	keyIdentity                 KeyIdentity
	publicKeySPKISHA256         [sha256.Size]byte
	validatedControlServiceSID  string
	validatedExecutorServiceSID string
	algorithm                   string
	keyLengthBits               uint32
	exportPolicy                uint32
	keyUsage                    uint32
	validated                   bool
}

// StoreScope returns the fixed scope selector used by the successful native store open.
func (a Attestation) StoreScope() string { return a.storeScope }

// StoreName returns the fixed name selector used by the successful native store open.
func (a Attestation) StoreName() string { return a.storeName }

// CertificateDERSHA256 returns the digest of the selected certificate's observed DER.
func (a Attestation) CertificateDERSHA256() [sha256.Size]byte { return a.certificateDERSHA256 }

// ContainerName returns the container name observed in CERT_KEY_PROV_INFO.
func (a Attestation) ContainerName() string { return a.containerName }

// KeyName returns the key name observed from the acquired CNG key.
func (a Attestation) KeyName() string { return a.keyName }

// KeySecurityDescriptorSHA256 returns the digest of the observed key security descriptor.
func (a Attestation) KeySecurityDescriptorSHA256() [sha256.Size]byte {
	return a.keySecurityDescriptorSHA256
}

// KeyIdentity returns the observed persisted CNG key identity.
func (a Attestation) KeyIdentity() KeyIdentity { return a.keyIdentity }

// PublicKeySPKISHA256 returns the digest of canonical PKIX SPKI DER for the observed key.
func (a Attestation) PublicKeySPKISHA256() [sha256.Size]byte { return a.publicKeySPKISHA256 }

// ValidatedControlServiceSID returns the policy SID used to validate the observed key DACL.
func (a Attestation) ValidatedControlServiceSID() string { return a.validatedControlServiceSID }

// ValidatedExecutorServiceSID returns the exclusion SID used to validate the observed key DACL.
func (a Attestation) ValidatedExecutorServiceSID() string { return a.validatedExecutorServiceSID }

// Algorithm returns the observed CNG algorithm name.
func (a Attestation) Algorithm() string { return a.algorithm }

// KeyLengthBits returns the observed CNG key length in bits.
func (a Attestation) KeyLengthBits() uint32 { return a.keyLengthBits }

// ExportPolicy returns the observed CNG export policy.
func (a Attestation) ExportPolicy() uint32 { return a.exportPolicy }

// KeyUsage returns the observed CNG key usage policy.
func (a Attestation) KeyUsage() uint32 { return a.keyUsage }

func (a Attestation) isComplete() bool {
	if !a.validated || a.storeScope != LocalMachineStoreScope ||
		a.storeName != LocalMachinePersonalStore ||
		!validCNGName(a.containerName, 256) || a.keyName != a.containerName ||
		a.keyIdentity.ProviderName != approvedKeyStorageProvider ||
		!validCNGName(a.keyIdentity.UniqueName, 256) || !a.keyIdentity.MachineKey ||
		a.algorithm != "ECDSA_P256" || a.keyLengthBits != 256 ||
		a.exportPolicy != 0 || a.keyUsage != ncryptAllowSigningFlag ||
		validateCanonicalServiceSID(a.validatedControlServiceSID) != nil ||
		validateCanonicalServiceSID(a.validatedExecutorServiceSID) != nil ||
		a.validatedControlServiceSID == a.validatedExecutorServiceSID {
		return false
	}
	return true
}

type certificateProviderInfo struct {
	containerName         string
	providerName          string
	providerType          uint32
	flags                 uint32
	parameterCount        uint32
	hasProviderParameters bool
	keySpec               uint32
}

type keySecurityACE struct {
	sid     string
	mask    uint32
	aceType uint8
	flags   uint8
}

type keySecurityEvidence struct {
	raw            []byte
	control        uint16
	ownerSID       string
	ownerDefaulted bool
	daclPresent    bool
	daclNull       bool
	daclDefaulted  bool
	entries        []keySecurityACE
}

type keyProperties struct {
	algorithm    string
	length       uint32
	exportPolicy uint32
	keyUsage     uint32
}

type ecdsaASN1Signature struct {
	R *big.Int
	S *big.Int
}

func validateConfig(config Config) ([sha256.Size]byte, error) {
	if config.StoreName != LocalMachinePersonalStore {
		return [sha256.Size]byte{}, fmt.Errorf("%w: StoreName must be %q", ErrInvalidConfiguration, LocalMachinePersonalStore)
	}
	digest, err := decodeConfigSHA256("CertificateSHA256", config.CertificateSHA256)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	if _, err := decodeConfigSHA256(
		"ExpectedKeySecurityDescriptorSHA256",
		config.ExpectedKeySecurityDescriptorSHA256,
	); err != nil {
		return [sha256.Size]byte{}, err
	}
	if err := validateCanonicalServiceSID(config.ControlServiceSID); err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("%w: ControlServiceSID: %v", ErrInvalidConfiguration, err)
	}
	if err := validateCanonicalServiceSID(config.ExecutorServiceSID); err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("%w: ExecutorServiceSID: %v", ErrInvalidConfiguration, err)
	}
	if config.ControlServiceSID == config.ExecutorServiceSID {
		return [sha256.Size]byte{}, fmt.Errorf("%w: service SIDs must be distinct", ErrInvalidConfiguration)
	}
	return digest, nil
}

func decodeConfigSHA256(name string, value string) ([sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	if len(value) != hex.EncodedLen(sha256.Size) {
		return digest, fmt.Errorf("%w: %s must be a 64-character lowercase hexadecimal digest", ErrInvalidConfiguration, name)
	}
	for _, character := range value {
		if character >= '0' && character <= '9' || character >= 'a' && character <= 'f' {
			continue
		}
		return digest, fmt.Errorf("%w: %s must be lowercase hexadecimal", ErrInvalidConfiguration, name)
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return digest, fmt.Errorf("%w: decode %s: %v", ErrInvalidConfiguration, name, err)
	}
	copy(digest[:], decoded)
	return digest, nil
}

func validateCanonicalServiceSID(value string) error {
	const prefix = "S-1-5-80-"
	if !strings.HasPrefix(value, prefix) {
		return errors.New("value is not an individual service SID")
	}
	components := strings.Split(value[len(prefix):], "-")
	if len(components) != 5 {
		return errors.New("value does not contain five service SID components")
	}
	for _, component := range components {
		parsed, err := strconv.ParseUint(component, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != component {
			return errors.New("value is not a canonical service SID")
		}
	}
	return nil
}

func validateCertificateProviderInfo(info certificateProviderInfo) error {
	if !validCNGName(info.containerName, 256) {
		return fmt.Errorf("%w: CNG container name is missing or invalid", ErrInvalidProviderInfo)
	}
	if info.providerName != approvedKeyStorageProvider {
		return fmt.Errorf("%w: provider is %q instead of the approved KSP", ErrInvalidProviderInfo, info.providerName)
	}
	if info.providerType != 0 {
		return fmt.Errorf("%w: legacy provider type is %d", ErrInvalidProviderInfo, info.providerType)
	}
	if info.flags != cryptMachineKeysetFlag {
		return fmt.Errorf("%w: provider flags are 0x%08x instead of machine-key only", ErrInvalidProviderInfo, info.flags)
	}
	if info.parameterCount != 0 || info.hasProviderParameters {
		return fmt.Errorf("%w: provider parameters are not permitted", ErrInvalidProviderInfo)
	}
	if info.keySpec != cngProviderKeySpec {
		return fmt.Errorf("%w: legacy key spec is 0x%08x instead of zero", ErrInvalidProviderInfo, info.keySpec)
	}
	return nil
}

func validCNGName(value string, maximumUnits int) bool {
	if value == "" || !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') ||
		strings.TrimSpace(value) != value || len(utf16.Encode([]rune(value))) > maximumUnits {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func parseKeySecurityDescriptor(raw []byte) (keySecurityEvidence, error) {
	const relativeHeaderBytes = 20
	if len(raw) < relativeHeaderBytes || len(raw) > maximumKeySecurityDescriptorBytes {
		return keySecurityEvidence{}, fmt.Errorf("%w: descriptor size is outside the supported range", ErrInvalidKeySecurity)
	}
	if raw[0] != 1 || raw[1] != 0 {
		return keySecurityEvidence{}, fmt.Errorf("%w: descriptor header is not canonical revision 1", ErrInvalidKeySecurity)
	}

	control := binary.LittleEndian.Uint16(raw[2:4])
	ownerOffset := binary.LittleEndian.Uint32(raw[4:8])
	daclOffset := binary.LittleEndian.Uint32(raw[16:20])
	evidence := keySecurityEvidence{
		raw:            bytes.Clone(raw),
		control:        control,
		ownerDefaulted: control&securityOwnerDefaulted != 0,
		daclPresent:    control&securityDACLPresent != 0,
		daclDefaulted:  control&securityDACLDefaulted != 0,
	}
	if ownerOffset == 0 {
		return keySecurityEvidence{}, fmt.Errorf("%w: descriptor owner is absent", ErrInvalidKeySecurity)
	}
	ownerSID, _, err := decodeSecuritySID(raw, ownerOffset)
	if err != nil {
		return keySecurityEvidence{}, fmt.Errorf("%w: descriptor owner: %v", ErrInvalidKeySecurity, err)
	}
	evidence.ownerSID = ownerSID
	if !evidence.daclPresent || daclOffset == 0 {
		evidence.daclNull = evidence.daclPresent && daclOffset == 0
		return evidence, nil
	}
	entries, err := parseKeyDACL(raw, daclOffset)
	if err != nil {
		return keySecurityEvidence{}, err
	}
	evidence.entries = entries
	return evidence, nil
}

func parseKeyDACL(raw []byte, offset uint32) ([]keySecurityACE, error) {
	const aclHeaderBytes = 8
	start := uint64(offset)
	if start > uint64(len(raw)) || uint64(len(raw))-start < aclHeaderBytes {
		return nil, fmt.Errorf("%w: DACL header is outside the descriptor", ErrInvalidKeySecurity)
	}
	acl := raw[int(start):]
	if (acl[0] != aclRevision && acl[0] != aclRevisionDS) || acl[1] != 0 ||
		binary.LittleEndian.Uint16(acl[6:8]) != 0 {
		return nil, fmt.Errorf("%w: DACL header is not canonical", ErrInvalidKeySecurity)
	}
	aclSize := uint64(binary.LittleEndian.Uint16(acl[2:4]))
	aceCount := uint64(binary.LittleEndian.Uint16(acl[4:6]))
	if aclSize < aclHeaderBytes || aclSize > uint64(len(raw))-start || aceCount > maximumKeySecurityACEs {
		return nil, fmt.Errorf("%w: DACL size or ACE count is outside the supported range", ErrInvalidKeySecurity)
	}

	entries := make([]keySecurityACE, 0, int(aceCount))
	cursor := uint64(aclHeaderBytes)
	for index := uint64(0); index < aceCount; index++ {
		if cursor > aclSize || aclSize-cursor < 8 {
			return nil, fmt.Errorf("%w: DACL ACE %d header is truncated", ErrInvalidKeySecurity, index)
		}
		ace := acl[int(cursor):]
		aceSize := uint64(binary.LittleEndian.Uint16(ace[2:4]))
		if aceSize < 16 || aceSize > aclSize-cursor {
			return nil, fmt.Errorf("%w: DACL ACE %d size is invalid", ErrInvalidKeySecurity, index)
		}
		sid, sidBytes, err := decodeSecuritySID(acl[:int(aclSize)], uint32(cursor+8))
		if err != nil {
			return nil, fmt.Errorf("%w: DACL ACE %d SID: %v", ErrInvalidKeySecurity, index, err)
		}
		if uint64(8+sidBytes) != aceSize {
			return nil, fmt.Errorf("%w: DACL ACE %d has a noncanonical size", ErrInvalidKeySecurity, index)
		}
		entries = append(entries, keySecurityACE{
			sid:     sid,
			mask:    binary.LittleEndian.Uint32(ace[4:8]),
			aceType: ace[0],
			flags:   ace[1],
		})
		cursor += aceSize
	}
	if cursor != aclSize {
		return nil, fmt.Errorf("%w: DACL contains trailing bytes outside its ACEs", ErrInvalidKeySecurity)
	}
	return entries, nil
}

func decodeSecuritySID(raw []byte, offset uint32) (string, int, error) {
	start := uint64(offset)
	if start > uint64(len(raw)) || uint64(len(raw))-start < 8 {
		return "", 0, errors.New("SID header is outside the descriptor")
	}
	value := raw[int(start):]
	if value[0] != 1 || value[1] > 15 {
		return "", 0, errors.New("SID revision or subauthority count is invalid")
	}
	length := 8 + int(value[1])*4
	if length > len(value) {
		return "", 0, errors.New("SID is truncated")
	}
	authority := uint64(0)
	for _, octet := range value[2:8] {
		authority = authority<<8 | uint64(octet)
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "S-1-%d", authority)
	for index := 0; index < int(value[1]); index++ {
		subauthority := binary.LittleEndian.Uint32(value[8+index*4:])
		fmt.Fprintf(&builder, "-%d", subauthority)
	}
	return builder.String(), length, nil
}

func validateKeySecurityEvidence(
	evidence keySecurityEvidence,
	expectedDigest string,
	controlServiceSID string,
	executorServiceSID string,
) error {
	if len(evidence.raw) < 20 || len(evidence.raw) > maximumKeySecurityDescriptorBytes {
		return fmt.Errorf("%w: descriptor size is outside the supported range", ErrInvalidKeySecurity)
	}
	digest, err := decodeConfigSHA256("ExpectedKeySecurityDescriptorSHA256", expectedDigest)
	if err != nil {
		return err
	}
	actual := sha256.Sum256(evidence.raw)
	if !bytes.Equal(actual[:], digest[:]) {
		return fmt.Errorf("%w: descriptor digest differs from the configured digest", ErrInvalidKeySecurity)
	}
	requiredControl := securityDACLPresent | securityDACLProtected | securityDescriptorSelfRelative
	if evidence.control&requiredControl != requiredControl ||
		evidence.control&securityDACLDefaulted != 0 ||
		!evidence.daclPresent || evidence.daclNull || evidence.daclDefaulted {
		return fmt.Errorf("%w: descriptor does not contain a protected non-defaulted DACL", ErrInvalidKeySecurity)
	}
	if evidence.ownerDefaulted ||
		(evidence.ownerSID != systemSID && evidence.ownerSID != administratorsSID) {
		return fmt.Errorf("%w: owner %q is not an approved non-defaulted owner", ErrInvalidKeySecurity, evidence.ownerSID)
	}
	if len(evidence.entries) != 3 || len(evidence.entries) > maximumKeySecurityACEs {
		return fmt.Errorf("%w: DACL contains %d ACEs instead of the three approved trustees", ErrInvalidKeySecurity, len(evidence.entries))
	}

	approved := map[string]bool{
		systemSID:         false,
		administratorsSID: false,
		controlServiceSID: false,
	}
	for _, entry := range evidence.entries {
		if entry.sid == executorServiceSID {
			return fmt.Errorf("%w: Executor service SID has a DACL ACE", ErrInvalidKeySecurity)
		}
		if entry.aceType != accessAllowedACEType || entry.flags != 0 || entry.mask == 0 {
			return fmt.Errorf("%w: DACL ACE for %q has invalid type, flags, or access mask", ErrInvalidKeySecurity, entry.sid)
		}
		seen, exists := approved[entry.sid]
		if !exists {
			return fmt.Errorf("%w: DACL grants an unapproved trustee %q", ErrInvalidKeySecurity, entry.sid)
		}
		if seen {
			return fmt.Errorf("%w: DACL contains duplicate trustee %q", ErrInvalidKeySecurity, entry.sid)
		}
		if entry.sid == controlServiceSID {
			allowed := genericReadAccess | readControlAccess | synchronizeAccess
			forbidden := genericAllAccess | genericWriteAccess | deleteAccess | writeDACLAccess | writeOwnerAccess
			if entry.mask&genericReadAccess == 0 || entry.mask&forbidden != 0 || entry.mask & ^allowed != 0 {
				return fmt.Errorf("%w: Control service SID is not restricted to key-use access", ErrInvalidKeySecurity)
			}
		} else if entry.mask&genericAllAccess == 0 && entry.mask&standardFullControl != standardFullControl {
			return fmt.Errorf("%w: recovery trustee %q lacks full control", ErrInvalidKeySecurity, entry.sid)
		}
		approved[entry.sid] = true
	}
	for sid, seen := range approved {
		if !seen {
			return fmt.Errorf("%w: DACL lacks required trustee %q", ErrInvalidKeySecurity, sid)
		}
	}
	return nil
}

func certificateDigestMatches(expected [sha256.Size]byte, der []byte) bool {
	actual := sha256.Sum256(der)
	return bytes.Equal(actual[:], expected[:])
}

func parseKeyProperties(
	algorithmValue []byte,
	lengthValue []byte,
	exportPolicyValue []byte,
	keyUsageValue []byte,
) (keyProperties, error) {
	algorithm, err := decodeUTF16Property(algorithmValue)
	if err != nil {
		return keyProperties{}, fmt.Errorf("decode Algorithm property: %w", err)
	}
	length, err := decodeUint32Property(lengthValue)
	if err != nil {
		return keyProperties{}, fmt.Errorf("decode Length property: %w", err)
	}
	exportPolicy, err := decodeUint32Property(exportPolicyValue)
	if err != nil {
		return keyProperties{}, fmt.Errorf("decode Export Policy property: %w", err)
	}
	keyUsage, err := decodeUint32Property(keyUsageValue)
	if err != nil {
		return keyProperties{}, fmt.Errorf("decode Key Usage property: %w", err)
	}
	return keyProperties{
		algorithm:    algorithm,
		length:       length,
		exportPolicy: exportPolicy,
		keyUsage:     keyUsage,
	}, nil
}

func validateP256SigningProperties(properties keyProperties) error {
	if properties.algorithm != "ECDSA_P256" {
		return fmt.Errorf("%w: Algorithm is %q", ErrInvalidKey, properties.algorithm)
	}
	if properties.length != 256 {
		return fmt.Errorf("%w: Length is %d", ErrInvalidKey, properties.length)
	}
	if properties.exportPolicy != 0 {
		return fmt.Errorf("%w: Export Policy is 0x%08x", ErrInvalidKey, properties.exportPolicy)
	}
	if properties.keyUsage != ncryptAllowSigningFlag {
		return fmt.Errorf("%w: Key Usage is 0x%08x", ErrInvalidKey, properties.keyUsage)
	}
	return nil
}

func decodeUTF16Property(value []byte) (string, error) {
	if len(value) < 2 || len(value)%2 != 0 {
		return "", errors.New("value is not a non-empty sequence of UTF-16 code units")
	}
	units := make([]uint16, len(value)/2)
	for index := range units {
		units[index] = binary.LittleEndian.Uint16(value[index*2:])
	}
	if units[len(units)-1] != 0 {
		return "", errors.New("value is not null-terminated")
	}
	units = units[:len(units)-1]
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if unit == 0 {
			return "", errors.New("value contains an embedded null")
		}
		if unit >= 0xd800 && unit <= 0xdbff {
			if index+1 >= len(units) || units[index+1] < 0xdc00 || units[index+1] > 0xdfff {
				return "", errors.New("value contains an unpaired UTF-16 surrogate")
			}
			index++
			continue
		}
		if unit >= 0xdc00 && unit <= 0xdfff {
			return "", errors.New("value contains an unpaired UTF-16 surrogate")
		}
	}
	return string(utf16.Decode(units)), nil
}

func decodeUint32Property(value []byte) (uint32, error) {
	if len(value) != 4 {
		return 0, fmt.Errorf("value has %d bytes instead of 4", len(value))
	}
	return binary.LittleEndian.Uint32(value), nil
}

func parseP256PublicBlob(blob []byte) (*ecdsa.PublicKey, error) {
	const headerBytes = 8
	if len(blob) < headerBytes {
		return nil, fmt.Errorf("%w: public blob is too short", ErrInvalidKey)
	}
	magic := binary.LittleEndian.Uint32(blob[:4])
	coordinateBytes := binary.LittleEndian.Uint32(blob[4:8])
	if magic != ecdsaPublicP256Magic || coordinateBytes != p256DigestBytes {
		return nil, fmt.Errorf("%w: public blob does not describe ECDSA P-256", ErrInvalidKey)
	}
	expectedBytes := headerBytes + 2*p256DigestBytes
	if len(blob) != expectedBytes {
		return nil, fmt.Errorf("%w: public blob has %d bytes instead of %d", ErrInvalidKey, len(blob), expectedBytes)
	}
	x := new(big.Int).SetBytes(blob[headerBytes : headerBytes+p256DigestBytes])
	y := new(big.Int).SetBytes(blob[headerBytes+p256DigestBytes:])
	curve := elliptic.P256()
	if x.Sign() <= 0 || y.Sign() <= 0 || !curve.IsOnCurve(x, y) {
		return nil, fmt.Errorf("%w: public blob point is not on P-256", ErrInvalidKey)
	}
	return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
}

func validateMatchingPublicKeys(certificateKey *ecdsa.PublicKey, cngKey *ecdsa.PublicKey) error {
	if !isP256PublicKey(certificateKey) {
		return fmt.Errorf("%w: certificate public key is not P-256", ErrInvalidCertificate)
	}
	if !isP256PublicKey(cngKey) || certificateKey.X.Cmp(cngKey.X) != 0 || certificateKey.Y.Cmp(cngKey.Y) != 0 {
		return fmt.Errorf("%w: public key does not match the certificate", ErrInvalidKey)
	}
	return nil
}

func p256PublicKeySPKISHA256(publicKey *ecdsa.PublicKey) ([sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	if !isP256PublicKey(publicKey) {
		return digest, fmt.Errorf("%w: public key is not canonical P-256", ErrInvalidKey)
	}
	spki, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return digest, fmt.Errorf("%w: encode public key SPKI: %v", ErrInvalidKey, err)
	}
	return sha256.Sum256(spki), nil
}

func isP256PublicKey(publicKey *ecdsa.PublicKey) bool {
	if publicKey == nil || publicKey.Curve == nil || publicKey.X == nil || publicKey.Y == nil {
		return false
	}
	curve := elliptic.P256()
	return publicKey.Curve.Params().Name == curve.Params().Name &&
		publicKey.X.Sign() > 0 && publicKey.Y.Sign() > 0 && curve.IsOnCurve(publicKey.X, publicKey.Y)
}

func prepareTLSCertificate(chainDER [][]byte, selectedDER []byte) (tls.Certificate, ecdsa.PublicKey, error) {
	if len(chainDER) == 0 || len(chainDER) > maximumChainCertificates {
		return tls.Certificate{}, ecdsa.PublicKey{}, fmt.Errorf("%w: chain certificate count is outside the supported range", ErrInvalidCertificate)
	}
	if !bytes.Equal(chainDER[0], selectedDER) {
		return tls.Certificate{}, ecdsa.PublicKey{}, fmt.Errorf("%w: chain leaf differs from the pinned certificate", ErrInvalidCertificate)
	}

	encoded := make([][]byte, len(chainDER))
	parsed := make([]*x509.Certificate, len(chainDER))
	totalBytes := 0
	for index, der := range chainDER {
		if len(der) == 0 || len(der) > maximumCertificateDERBytes {
			return tls.Certificate{}, ecdsa.PublicKey{}, fmt.Errorf("%w: chain certificate size is outside the supported range", ErrInvalidCertificate)
		}
		totalBytes += len(der)
		if totalBytes > maximumChainDERBytes {
			return tls.Certificate{}, ecdsa.PublicKey{}, fmt.Errorf("%w: chain exceeds its aggregate byte limit", ErrInvalidCertificate)
		}
		encoded[index] = bytes.Clone(der)
		certificate, err := x509.ParseCertificate(encoded[index])
		if err != nil {
			return tls.Certificate{}, ecdsa.PublicKey{}, fmt.Errorf("%w: parse chain certificate %d: %v", ErrInvalidCertificate, index, err)
		}
		parsed[index] = certificate
	}
	leafPublicKey, ok := parsed[0].PublicKey.(*ecdsa.PublicKey)
	if !ok || !isP256PublicKey(leafPublicKey) {
		return tls.Certificate{}, ecdsa.PublicKey{}, fmt.Errorf("%w: leaf public key is not ECDSA P-256", ErrInvalidCertificate)
	}
	if err := validateCertificateChain(parsed, time.Now()); err != nil {
		return tls.Certificate{}, ecdsa.PublicKey{}, err
	}
	publicKey := clonePublicKey(leafPublicKey)
	if len(parsed) > 1 {
		encoded = encoded[:len(encoded)-1]
	}
	return tls.Certificate{
		Certificate: encoded,
		Leaf:        parsed[0],
		SupportedSignatureAlgorithms: []tls.SignatureScheme{
			tls.ECDSAWithP256AndSHA256,
		},
	}, publicKey, nil
}

func validateCertificateChain(chain []*x509.Certificate, currentTime time.Time) error {
	if len(chain) == 0 {
		return fmt.Errorf("%w: parsed chain is empty", ErrInvalidCertificate)
	}
	for index, certificate := range chain {
		if certificate == nil {
			return fmt.Errorf("%w: chain element %d is missing", ErrInvalidCertificate, index)
		}
		if currentTime.Before(certificate.NotBefore) || currentTime.After(certificate.NotAfter) {
			return fmt.Errorf("%w: chain element %d is not currently valid", ErrInvalidCertificate, index)
		}
		if len(certificate.UnhandledCriticalExtensions) != 0 {
			return fmt.Errorf("%w: chain element %d contains unhandled critical extensions", ErrInvalidCertificate, index)
		}
		if index > 0 && (!certificate.BasicConstraintsValid || !certificate.IsCA ||
			certificate.KeyUsage&x509.KeyUsageCertSign == 0) {
			return fmt.Errorf("%w: chain issuer %d lacks CA basic constraints or CertSign usage", ErrInvalidCertificate, index)
		}
	}
	if err := validateClientLeaf(chain[0], currentTime); err != nil {
		return err
	}
	for index := 0; index+1 < len(chain); index++ {
		if !bytes.Equal(chain[index].RawIssuer, chain[index+1].RawSubject) ||
			chain[index].CheckSignatureFrom(chain[index+1]) != nil {
			return fmt.Errorf("%w: chain element %d is not issued by element %d", ErrInvalidCertificate, index, index+1)
		}
	}
	root := chain[len(chain)-1]
	if !isSelfSigned(root) {
		return fmt.Errorf("%w: local chain does not end at a self-signed root", ErrInvalidCertificate)
	}

	roots := x509.NewCertPool()
	roots.AddCert(root)
	intermediates := x509.NewCertPool()
	for index := 1; index+1 < len(chain); index++ {
		intermediates.AddCert(chain[index])
	}
	if _, err := chain[0].Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: intermediates,
		CurrentTime:   currentTime,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		return fmt.Errorf("%w: verify detached local chain: %v", ErrInvalidCertificate, err)
	}
	return nil
}

func certificateValidityWindow(encoded [][]byte) (time.Time, time.Time, error) {
	if len(encoded) == 0 {
		return time.Time{}, time.Time{}, fmt.Errorf("%w: transmitted chain is empty", ErrInvalidCertificate)
	}
	var notBefore time.Time
	var notAfter time.Time
	for index, der := range encoded {
		certificate, err := x509.ParseCertificate(der)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("%w: parse transmitted chain element %d: %v", ErrInvalidCertificate, index, err)
		}
		if index == 0 || certificate.NotBefore.After(notBefore) {
			notBefore = certificate.NotBefore
		}
		if index == 0 || certificate.NotAfter.Before(notAfter) {
			notAfter = certificate.NotAfter
		}
	}
	return notBefore, notAfter, nil
}

func validateClientLeaf(certificate *x509.Certificate, currentTime time.Time) error {
	if certificate == nil {
		return fmt.Errorf("%w: leaf is missing", ErrInvalidCertificate)
	}
	if certificate.IsCA {
		return fmt.Errorf("%w: leaf is a CA certificate", ErrInvalidCertificate)
	}
	if currentTime.Before(certificate.NotBefore) || currentTime.After(certificate.NotAfter) {
		return fmt.Errorf("%w: leaf is not currently valid", ErrInvalidCertificate)
	}
	if certificate.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		return fmt.Errorf("%w: leaf lacks DigitalSignature key usage", ErrInvalidCertificate)
	}
	for _, usage := range certificate.ExtKeyUsage {
		if usage == x509.ExtKeyUsageClientAuth {
			return nil
		}
	}
	return fmt.Errorf("%w: leaf lacks ClientAuth extended key usage", ErrInvalidCertificate)
}

func isSelfSigned(certificate *x509.Certificate) bool {
	return certificate != nil && bytes.Equal(certificate.RawSubject, certificate.RawIssuer) &&
		certificate.CheckSignatureFrom(certificate) == nil
}

func cloneTLSCertificate(source tls.Certificate, privateKey crypto.PrivateKey) tls.Certificate {
	result := source
	result.Certificate = make([][]byte, len(source.Certificate))
	for index, der := range source.Certificate {
		result.Certificate[index] = bytes.Clone(der)
	}
	result.PrivateKey = privateKey
	result.OCSPStaple = bytes.Clone(source.OCSPStaple)
	result.SignedCertificateTimestamps = make([][]byte, len(source.SignedCertificateTimestamps))
	for index, timestamp := range source.SignedCertificateTimestamps {
		result.SignedCertificateTimestamps[index] = bytes.Clone(timestamp)
	}
	result.SupportedSignatureAlgorithms = append([]tls.SignatureScheme(nil), source.SupportedSignatureAlgorithms...)
	result.Leaf = nil
	if len(result.Certificate) != 0 {
		result.Leaf, _ = x509.ParseCertificate(result.Certificate[0])
	}
	return result
}

func clonePublicKey(source *ecdsa.PublicKey) ecdsa.PublicKey {
	if source == nil {
		return ecdsa.PublicKey{}
	}
	result := ecdsa.PublicKey{Curve: source.Curve}
	if source.X != nil {
		result.X = new(big.Int).Set(source.X)
	}
	if source.Y != nil {
		result.Y = new(big.Int).Set(source.Y)
	}
	return result
}

func p256SignatureToASN1(signature []byte) ([]byte, error) {
	if len(signature) != p256SignatureBytes {
		return nil, fmt.Errorf("%w: signature has %d bytes instead of %d", ErrInvalidSignature, len(signature), p256SignatureBytes)
	}
	n := elliptic.P256().Params().N
	r := new(big.Int).SetBytes(signature[:p256DigestBytes])
	s := new(big.Int).SetBytes(signature[p256DigestBytes:])
	if r.Sign() <= 0 || r.Cmp(n) >= 0 {
		return nil, fmt.Errorf("%w: r is outside the P-256 scalar range", ErrInvalidSignature)
	}
	if s.Sign() <= 0 || s.Cmp(n) >= 0 {
		return nil, fmt.Errorf("%w: s is outside the P-256 scalar range", ErrInvalidSignature)
	}
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(n), 1)
	if s.Cmp(halfOrder) > 0 {
		s.Sub(n, s)
	}
	encoded, err := asn1.Marshal(ecdsaASN1Signature{R: r, S: s})
	if err != nil {
		return nil, fmt.Errorf("encode P-256 signature: %w", err)
	}
	return encoded, nil
}
