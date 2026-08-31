package cng

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	approvedKeyStorageProvider = "Microsoft Software Key Storage Provider"
	systemSID                  = "S-1-5-18"
	administratorsSID          = "S-1-5-32-544"

	ecdsaPublicP256Magic = uint32(0x31534345)

	securityOwnerDefaulted         = uint16(0x0001)
	securityDACLPresent            = uint16(0x0004)
	securityDACLDefaulted          = uint16(0x0008)
	securityDACLProtected          = uint16(0x1000)
	securityDescriptorSelfRelative = uint16(0x8000)
	accessAllowedACEType           = uint8(0)
	aclRevision                    = uint8(2)
	aclRevisionDS                  = uint8(4)

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
	mappedGenericRead   = uint32(0x00000089) | readControlAccess | synchronizeAccess
)

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

func validateOptions(options Options) ([sha256.Size]byte, error) {
	if !validCNGName(options.KeyName, 256) {
		return [sha256.Size]byte{}, fmt.Errorf("%w: KeyName must be bounded canonical text", ErrInvalidOptions)
	}
	digest, err := decodeExpectedSHA256(options.ExpectedSecurityDescriptorSHA256)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	if err := validateCanonicalServiceSID(options.ControlServiceSID); err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("%w: ControlServiceSID: %v", ErrInvalidOptions, err)
	}
	if err := validateCanonicalServiceSID(options.ExecutorServiceSID); err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("%w: ExecutorServiceSID: %v", ErrInvalidOptions, err)
	}
	if options.ControlServiceSID == options.ExecutorServiceSID {
		return [sha256.Size]byte{}, fmt.Errorf("%w: service SIDs must be distinct", ErrInvalidOptions)
	}
	return digest, nil
}

func decodeExpectedSHA256(value string) ([sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	if len(value) != hex.EncodedLen(sha256.Size) {
		return digest, fmt.Errorf("%w: ExpectedSecurityDescriptorSHA256 must be a 64-character lowercase hexadecimal digest", ErrInvalidOptions)
	}
	for _, character := range value {
		if character >= '0' && character <= '9' || character >= 'a' && character <= 'f' {
			continue
		}
		return digest, fmt.Errorf("%w: ExpectedSecurityDescriptorSHA256 must be lowercase hexadecimal", ErrInvalidOptions)
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return digest, fmt.Errorf("%w: decode ExpectedSecurityDescriptorSHA256: %v", ErrInvalidOptions, err)
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
		raw:            append([]byte(nil), raw...),
		control:        control,
		ownerDefaulted: control&securityOwnerDefaulted != 0,
		daclPresent:    control&securityDACLPresent != 0,
		daclDefaulted:  control&securityDACLDefaulted != 0,
	}
	if ownerOffset == 0 {
		return keySecurityEvidence{}, fmt.Errorf("%w: descriptor owner is absent", ErrInvalidKeySecurity)
	}
	ownerSID, _, err := decodeSIDAt(raw, ownerOffset)
	if err != nil {
		return keySecurityEvidence{}, fmt.Errorf("%w: descriptor owner: %v", ErrInvalidKeySecurity, err)
	}
	evidence.ownerSID = ownerSID
	if !evidence.daclPresent || daclOffset == 0 {
		evidence.daclNull = evidence.daclPresent && daclOffset == 0
		return evidence, nil
	}
	entries, err := parseDACL(raw, daclOffset)
	if err != nil {
		return keySecurityEvidence{}, err
	}
	evidence.entries = entries
	return evidence, nil
}

func parseDACL(raw []byte, offset uint32) ([]keySecurityACE, error) {
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
		sid, sidBytes, err := decodeSIDAt(acl[:int(aclSize)], uint32(cursor+8))
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

func decodeSIDAt(raw []byte, offset uint32) (string, int, error) {
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
	expectedDigest [sha256.Size]byte,
	controlServiceSID string,
	executorServiceSID string,
) error {
	actual := sha256.Sum256(evidence.raw)
	if !bytes.Equal(actual[:], expectedDigest[:]) {
		return fmt.Errorf("%w: descriptor digest differs from the expected digest", ErrInvalidKeySecurity)
	}
	requiredControl := securityDACLPresent | securityDACLProtected | securityDescriptorSelfRelative
	if evidence.control&requiredControl != requiredControl || evidence.control&securityDACLDefaulted != 0 ||
		!evidence.daclPresent || evidence.daclNull || evidence.daclDefaulted {
		return fmt.Errorf("%w: descriptor does not contain a protected non-defaulted self-relative DACL", ErrInvalidKeySecurity)
	}
	if evidence.ownerDefaulted || (evidence.ownerSID != systemSID && evidence.ownerSID != administratorsSID) {
		return fmt.Errorf("%w: owner %q is not an approved non-defaulted recovery owner", ErrInvalidKeySecurity, evidence.ownerSID)
	}
	if len(evidence.entries) != 3 {
		return fmt.Errorf("%w: DACL contains %d ACEs instead of the three approved trustees", ErrInvalidKeySecurity, len(evidence.entries))
	}

	approved := map[string]bool{systemSID: false, administratorsSID: false, controlServiceSID: false}
	for _, entry := range evidence.entries {
		if entry.sid == executorServiceSID {
			return fmt.Errorf("%w: Executor service SID has a DACL ACE", ErrInvalidKeySecurity)
		}
		seen, exists := approved[entry.sid]
		if !exists {
			return fmt.Errorf("%w: DACL grants an unapproved trustee %q", ErrInvalidKeySecurity, entry.sid)
		}
		if seen {
			return fmt.Errorf("%w: DACL contains duplicate trustee %q", ErrInvalidKeySecurity, entry.sid)
		}
		if entry.aceType != accessAllowedACEType || entry.flags != 0 || entry.mask == 0 {
			return fmt.Errorf("%w: DACL ACE for %q has invalid type, flags, or access mask", ErrInvalidKeySecurity, entry.sid)
		}
		if entry.sid == controlServiceSID {
			allowed := genericReadAccess | mappedGenericRead
			forbidden := genericAllAccess | genericWriteAccess | deleteAccess | writeDACLAccess | writeOwnerAccess
			hasKeyRead := entry.mask&genericReadAccess != 0 || entry.mask&mappedGenericRead == mappedGenericRead
			if !hasKeyRead || entry.mask&forbidden != 0 || entry.mask & ^allowed != 0 {
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

func parseP256PublicBlob(blob []byte) (*ecdsa.PublicKey, error) {
	const headerBytes = 8
	if len(blob) < headerBytes {
		return nil, fmt.Errorf("%w: public blob is too short", ErrInvalidKey)
	}
	magic := binary.LittleEndian.Uint32(blob[:4])
	coordinateBytes := binary.LittleEndian.Uint32(blob[4:8])
	if magic != ecdsaPublicP256Magic || coordinateBytes != DigestSize {
		return nil, fmt.Errorf("%w: public blob does not describe ECDSA P-256", ErrInvalidKey)
	}
	expectedBytes := headerBytes + 2*DigestSize
	if len(blob) != expectedBytes {
		return nil, fmt.Errorf("%w: public blob has %d bytes instead of %d", ErrInvalidKey, len(blob), expectedBytes)
	}
	x := new(big.Int).SetBytes(blob[headerBytes : headerBytes+DigestSize])
	y := new(big.Int).SetBytes(blob[headerBytes+DigestSize:])
	curve := elliptic.P256()
	if x.Sign() <= 0 || y.Sign() <= 0 || !curve.IsOnCurve(x, y) {
		return nil, fmt.Errorf("%w: public blob point is not on P-256", ErrInvalidKey)
	}
	return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
}

func p256PublicKeySPKISHA256(publicKey *ecdsa.PublicKey) ([sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	if publicKey == nil || publicKey.Curve == nil || publicKey.X == nil || publicKey.Y == nil ||
		publicKey.Curve.Params().Name != elliptic.P256().Params().Name ||
		!elliptic.P256().IsOnCurve(publicKey.X, publicKey.Y) {
		return digest, fmt.Errorf("%w: public key is not canonical P-256", ErrInvalidKey)
	}
	spki, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return digest, fmt.Errorf("%w: encode public key SPKI: %v", ErrInvalidKey, err)
	}
	return sha256.Sum256(spki), nil
}

func verifyP256Signature(publicKey *ecdsa.PublicKey, digest []byte, signature []byte) error {
	if publicKey == nil || publicKey.Curve == nil || publicKey.X == nil || publicKey.Y == nil ||
		len(digest) != DigestSize || len(signature) != SignatureSize {
		return ErrInvalidSignature
	}
	r := new(big.Int).SetBytes(signature[:DigestSize])
	s := new(big.Int).SetBytes(signature[DigestSize:])
	if !ecdsa.Verify(publicKey, digest, r, s) {
		return fmt.Errorf("%w: signature does not verify against the opened key", ErrInvalidSignature)
	}
	return nil
}
