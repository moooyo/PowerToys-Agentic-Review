package nodeenrollment

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// MarshalCanonical validates and serializes ordinary enrollment-record data.
func MarshalCanonical(value Record) ([]byte, error) {
	if err := value.Validate(); err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("%w: serialize record", ErrInvalid)
	}
	document := buffer.Bytes()
	if len(document) == 0 || document[len(document)-1] != '\n' {
		return nil, fmt.Errorf("%w: canonical delimiter is absent", ErrInvalid)
	}
	document = append([]byte(nil), document[:len(document)-1]...)
	if len(document) == 0 || len(document) > MaximumRecordBytes {
		return nil, fmt.Errorf("%w: document size is outside the supported range", ErrInvalid)
	}
	return document, nil
}

// Parse accepts only the exact canonical representation of one ordinary enrollment record.
func Parse(document []byte) (Record, error) {
	if len(document) == 0 || len(document) > MaximumRecordBytes ||
		bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return Record{}, fmt.Errorf("%w: document encoding or size is invalid", ErrInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	var value Record
	if err := decoder.Decode(&value); err != nil {
		return Record{}, fmt.Errorf("%w: document is not strict JSON", ErrInvalid)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Record{}, fmt.Errorf("%w: document contains trailing content", ErrInvalid)
	}
	canonical, err := MarshalCanonical(value)
	if err != nil {
		return Record{}, err
	}
	if !bytes.Equal(canonical, document) {
		return Record{}, ErrCanonical
	}
	return value, nil
}

// Validate proves record syntax and internal consistency only. It never validates provenance.
func (record Record) Validate() error {
	if record.SchemaVersion != SchemaVersion || record.ProfileID != ProfileID ||
		record.EnrollmentGeneration != EnrollmentGeneration || record.State != CommittedState ||
		record.ServiceIdentityProfileID != ServiceIdentityProfileID ||
		record.PhysicalRootProfileID != PhysicalRootProfileID ||
		!validPackageComponentID(record.InstallationID) || !validEntityID(record.WorkerNodeID) ||
		!validArchitecture(record.TargetArchitecture) ||
		!validSHA256(record.ServerBindingReceiptSHA256) {
		return fmt.Errorf("%w: top-level identity fields are invalid", ErrInvalid)
	}
	local := record.LocalAuthorityCNG
	if !validBoundedASCIIText(local.KeyName, 256) || strings.TrimSpace(local.KeyName) != local.KeyName ||
		!validBoundedASCIIText(local.KeyUniqueName, 256) || strings.TrimSpace(local.KeyUniqueName) != local.KeyUniqueName ||
		!validSHA256(local.PublicKeySPKISHA256) || !validSHA256(local.SecurityDescriptorSHA256) ||
		validatePublicKeySPKI(local.PublicKeySPKIBase64URL, local.PublicKeySPKISHA256) != nil {
		return fmt.Errorf("%w: local-authority CNG fields are invalid", ErrInvalid)
	}
	mtls := record.MTLSClientCredential
	if mtls.CertificateStore != "MY" || !validSHA256(mtls.CertificateDERSHA256) ||
		!validSHA256(mtls.PrivateKeyPublicKeySPKISHA256) ||
		!validSHA256(mtls.PrivateKeySecurityDescriptorSHA256) ||
		!validBoundedASCIIText(mtls.PrivateKeyUniqueName, 256) ||
		strings.TrimSpace(mtls.PrivateKeyUniqueName) != mtls.PrivateKeyUniqueName {
		return fmt.Errorf("%w: mTLS credential fields are invalid", ErrInvalid)
	}
	if local.KeyUniqueName == mtls.PrivateKeyUniqueName ||
		local.PublicKeySPKISHA256 == mtls.PrivateKeyPublicKeySPKISHA256 {
		return fmt.Errorf("%w: local-authority and mTLS keys are not distinct", ErrInvalid)
	}
	return nil
}

func validatePublicKeySPKI(encoded string, expectedSHA256 string) error {
	if encoded == "" || len(encoded) > base64.RawURLEncoding.EncodedLen(MaximumPublicKeySPKIBytes) {
		return ErrInvalid
	}
	spki, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(spki) == 0 || len(spki) > MaximumPublicKeySPKIBytes ||
		base64.RawURLEncoding.EncodeToString(spki) != encoded {
		return ErrInvalid
	}
	parsed, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		return ErrInvalid
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key == nil || key.Curve == nil || key.X == nil || key.Y == nil ||
		key.Curve.Params().Name != elliptic.P256().Params().Name ||
		key.X.Sign() <= 0 || key.Y.Sign() <= 0 || !elliptic.P256().IsOnCurve(key.X, key.Y) {
		return ErrInvalid
	}
	canonical, err := x509.MarshalPKIXPublicKey(key)
	if err != nil || !bytes.Equal(canonical, spki) {
		return ErrInvalid
	}
	digest := sha256.Sum256(spki)
	if hex.EncodeToString(digest[:]) != expectedSHA256 {
		return ErrInvalid
	}
	return nil
}

func validArchitecture(value TargetArchitecture) bool {
	return value == ArchitectureAMD64 || value == ArchitectureARM64
}

func validSHA256(value string) bool {
	return len(value) == sha256.Size*2 && validLowerHex(value)
}

func validLowerHex(value string) bool {
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func validEntityID(value string) bool {
	if len(value) == 0 || len(value) > 128 || !asciiAlphaNumeric(value[0]) {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if asciiAlphaNumeric(character) || strings.ContainsRune("._:-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validPackageComponentID(value string) bool {
	if len(value) == 0 || len(value) > 128 ||
		!(value[0] >= 'a' && value[0] <= 'z' || value[0] >= '0' && value[0] <= '9') ||
		invalidPathComponent(value) {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			strings.ContainsRune("._+-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func invalidPathComponent(component string) bool {
	if component == "" || component == "." || component == ".." || strings.HasSuffix(component, ".") ||
		strings.HasSuffix(component, " ") || strings.ContainsAny(component, `<>"|?*`) {
		return true
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
		return true
	}
	return len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
		base[3] >= '1' && base[3] <= '9'
}

func validBoundedASCIIText(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return false
		}
	}
	return true
}

func asciiAlphaNumeric(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' ||
		value >= '0' && value <= '9'
}
