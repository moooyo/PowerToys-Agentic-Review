package serverbindingauthorityv1

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const canonicalUTCMillisecondsLayout = "2006-01-02T15:04:05.000Z"

var uuidV4Pattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

// MarshalReceiptCanonical returns the only accepted receipt representation.
func MarshalReceiptCanonical(value ServerBindingReceiptV1) ([]byte, error) {
	if err := validateReceipt(value); err != nil {
		return nil, err
	}
	return marshalCanonical(value)
}

// ParseReceipt accepts only exact bounded canonical receipt JSON.
func ParseReceipt(document []byte) (ServerBindingReceiptV1, error) {
	if len(document) == 0 || len(document) > MaximumDocumentBytes {
		return ServerBindingReceiptV1{}, fmt.Errorf("%w: document size is invalid", ErrInvalid)
	}
	document = bytes.Clone(document)
	var value ServerBindingReceiptV1
	if err := parseStrictCanonical(document, &value, func() ([]byte, error) {
		return MarshalReceiptCanonical(value)
	}); err != nil {
		return ServerBindingReceiptV1{}, err
	}
	return value, nil
}

// MarshalActiveStatusCanonical returns the only accepted active-status representation.
func MarshalActiveStatusCanonical(value ServerBindingActiveStatusV1) ([]byte, error) {
	if err := validateActiveStatus(value); err != nil {
		return nil, err
	}
	return marshalCanonical(value)
}

// ParseActiveStatus accepts only exact bounded canonical active-status JSON.
func ParseActiveStatus(document []byte) (ServerBindingActiveStatusV1, error) {
	if len(document) == 0 || len(document) > MaximumDocumentBytes {
		return ServerBindingActiveStatusV1{}, fmt.Errorf("%w: document size is invalid", ErrInvalid)
	}
	document = bytes.Clone(document)
	var value ServerBindingActiveStatusV1
	if err := parseStrictCanonical(document, &value, func() ([]byte, error) {
		return MarshalActiveStatusCanonical(value)
	}); err != nil {
		return ServerBindingActiveStatusV1{}, err
	}
	return value, nil
}

func marshalReceiptStatement(value ServerBindingReceiptStatementV1) ([]byte, error) {
	if err := validateReceiptStatement(value); err != nil {
		return nil, err
	}
	return marshalCanonical(value)
}

func marshalActiveStatusStatement(value ServerBindingActiveStatusStatementV1) ([]byte, error) {
	if err := validateActiveStatusStatement(value); err != nil {
		return nil, err
	}
	return marshalCanonical(value)
}

func marshalCanonical(value any) ([]byte, error) {
	document, err := json.Marshal(value)
	if err != nil || len(document) == 0 || len(document) > MaximumDocumentBytes || !asciiBytes(document) {
		return nil, fmt.Errorf("%w: canonical encoding failed", ErrInvalid)
	}
	return document, nil
}

func parseStrictCanonical(document []byte, target any, remarshal func() ([]byte, error)) error {
	if len(document) == 0 || len(document) > MaximumDocumentBytes ||
		bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) || !asciiBytes(document) {
		return fmt.Errorf("%w: document encoding or size is invalid", ErrInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: document is not strict JSON", ErrInvalid)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: document contains trailing content", ErrInvalid)
	}
	canonical, err := remarshal()
	if err != nil {
		return err
	}
	if !bytes.Equal(canonical, document) {
		return ErrCanonical
	}
	return nil
}

func validateReceipt(value ServerBindingReceiptV1) error {
	if value.Algorithm != SignatureAlgorithm || value.Issuer != Issuer ||
		value.ProfileID != ReceiptProfileID || value.SchemaVersion != SchemaVersion ||
		!validSHA256(value.IssuerKeyID) || validateP1363Signature(value.Signature) != nil ||
		validateReceiptStatement(value.Statement) != nil {
		return fmt.Errorf("%w: receipt fields are invalid", ErrInvalid)
	}
	return nil
}

func validateActiveStatus(value ServerBindingActiveStatusV1) error {
	if value.Algorithm != SignatureAlgorithm || value.Issuer != Issuer ||
		value.ProfileID != ActiveStatusProfileID || value.SchemaVersion != SchemaVersion ||
		!validSHA256(value.IssuerKeyID) || validateP1363Signature(value.Signature) != nil ||
		validateActiveStatusStatement(value.Statement) != nil {
		return fmt.Errorf("%w: active-status fields are invalid", ErrInvalid)
	}
	return nil
}

func validateReceiptStatement(value ServerBindingReceiptStatementV1) error {
	if !validUUIDV4(value.BindingID) || value.BindingRevision != BindingRevision ||
		!validCanonicalUTCMilliseconds(value.BoundAt) || !validSHA256(value.CertificateDERSHA256) ||
		value.EnrollmentGeneration != EnrollmentGeneration || !validPackageComponentID(value.InstallationID) ||
		value.StatementType != ReceiptStatementType || !validEntityID(value.WorkerNodeID) {
		return fmt.Errorf("%w: receipt statement fields are invalid", ErrInvalid)
	}
	return nil
}

func validateActiveStatusStatement(value ServerBindingActiveStatusStatementV1) error {
	issuedAt, issuedErr := parseCanonicalUTCMilliseconds(value.IssuedAt)
	expiresAt, expiresErr := parseCanonicalUTCMilliseconds(value.ExpiresAt)
	if !validUUIDV4(value.BindingID) || value.BindingRevision != BindingRevision ||
		!validSHA256(value.CertificateDERSHA256) || !validNonce(value.ChallengeNonceBase64URL) ||
		value.EnrollmentGeneration != EnrollmentGeneration || issuedErr != nil || expiresErr != nil ||
		!expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > MaximumActiveStatusLifetime ||
		!validPackageComponentID(value.InstallationID) || !validSHA256(value.ReceiptSHA256) ||
		!validSHA256(value.RecordDocumentSHA256) || value.StatementType != ActiveStatusStatementType ||
		!validEntityID(value.WorkerNodeID) {
		return fmt.Errorf("%w: active-status statement fields are invalid", ErrInvalid)
	}
	return nil
}

func validateExpectation(value ActiveStatusExpectation) error {
	if !validUUIDV4(value.BindingID) || value.BindingRevision != BindingRevision ||
		!validSHA256(value.CertificateDERSHA256) || value.EnrollmentGeneration != EnrollmentGeneration ||
		!validPackageComponentID(value.InstallationID) || !validSHA256(value.ReceiptSHA256) ||
		!validSHA256(value.RecordDocumentSHA256) || !validEntityID(value.WorkerNodeID) {
		return ErrInvalid
	}
	return nil
}

func validNonce(value string) bool {
	if len(value) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func validCanonicalUTCMilliseconds(value string) bool {
	_, err := parseCanonicalUTCMilliseconds(value)
	return err == nil
}

func parseCanonicalUTCMilliseconds(value string) (time.Time, error) {
	if len(value) != len(canonicalUTCMillisecondsLayout) ||
		value[4] != '-' || value[7] != '-' || value[10] != 'T' || value[13] != ':' ||
		value[16] != ':' || value[19] != '.' || value[23] != 'Z' {
		return time.Time{}, ErrInvalid
	}
	for _, index := range [...]int{0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22} {
		if value[index] < '0' || value[index] > '9' {
			return time.Time{}, ErrInvalid
		}
	}
	parsed, err := time.Parse(canonicalUTCMillisecondsLayout, value)
	if err != nil || parsed.Year() < 1 || parsed.UTC().Format(canonicalUTCMillisecondsLayout) != value {
		return time.Time{}, ErrInvalid
	}
	return parsed, nil
}

func validUUIDV4(value string) bool {
	return uuidV4Pattern.MatchString(value)
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
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

func asciiAlphaNumeric(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' || value >= '0' && value <= '9'
}

func asciiBytes(value []byte) bool {
	for _, character := range value {
		if character > 0x7f {
			return false
		}
	}
	return true
}
