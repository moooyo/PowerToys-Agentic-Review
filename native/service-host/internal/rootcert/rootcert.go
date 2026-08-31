// Package rootcert parses verified Control server root-certificate content.
// It accepts one exact DER certificate or a strict PEM CERTIFICATE bundle and
// returns detached DER bytes without consulting any operating-system trust store.
package rootcert

import (
	"bytes"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"time"
)

const (
	MaximumCertificates        = 32
	MaximumCertificateDERBytes = 64 * 1024
	MaximumBundleDERBytes      = 512 * 1024

	pemBeginLine = "-----BEGIN CERTIFICATE-----"
	pemEndLine   = "-----END CERTIFICATE-----"

	maximumDERDepth = 64
)

var (
	ErrInvalidContent       = errors.New("invalid root certificate content")
	ErrLimitExceeded        = errors.New("root certificate content limit exceeded")
	ErrDuplicateCertificate = errors.New("duplicate root certificate")
	ErrInvalidCertificate   = errors.New("invalid root CA certificate")
)

type canonicalCertificate struct {
	TBSCertificate     canonicalTBSCertificate
	SignatureAlgorithm pkix.AlgorithmIdentifier
	SignatureValue     asn1.BitString
}

type canonicalTBSCertificate struct {
	Version            int `asn1:"optional,explicit,default:0,tag:0"`
	SerialNumber       *big.Int
	SignatureAlgorithm pkix.AlgorithmIdentifier
	Issuer             asn1.RawValue
	Validity           canonicalValidity
	Subject            asn1.RawValue
	PublicKey          canonicalPublicKeyInfo
	IssuerUniqueID     asn1.BitString   `asn1:"optional,tag:1"`
	SubjectUniqueID    asn1.BitString   `asn1:"optional,tag:2"`
	Extensions         []pkix.Extension `asn1:"omitempty,optional,explicit,tag:3"`
}

type canonicalValidity struct {
	NotBefore time.Time
	NotAfter  time.Time
}

type canonicalPublicKeyInfo struct {
	Algorithm pkix.AlgorithmIdentifier
	PublicKey asn1.BitString
}

type derElement struct {
	class       uint8
	tag         uint64
	constructed bool
	content     []byte
	full        []byte
}

// Parse accepts one exact DER certificate or a PEM-only CERTIFICATE bundle.
// The returned outer and inner slices are newly allocated and do not alias content.
func Parse(content []byte) ([][]byte, error) {
	if len(content) == 0 {
		return nil, fmt.Errorf("%w: content is empty", ErrInvalidContent)
	}

	trimmed := trimPEMWhitespace(content)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("%w: content contains only whitespace", ErrInvalidContent)
	}
	if bytes.HasPrefix(trimmed, []byte("-----BEGIN")) {
		return parsePEMBundle(trimmed)
	}
	return parseSingleDER(content)
}

func parseSingleDER(content []byte) ([][]byte, error) {
	if len(content) > MaximumCertificateDERBytes {
		return nil, fmt.Errorf("%w: DER certificate exceeds %d bytes", ErrLimitExceeded, MaximumCertificateDERBytes)
	}
	der, err := validateAndCloneCertificate(content, 0)
	if err != nil {
		return nil, err
	}
	return [][]byte{der}, nil
}

func parsePEMBundle(content []byte) ([][]byte, error) {
	result := make([][]byte, 0, 1)
	seen := make(map[string]struct{})
	totalDERBytes := 0
	rest := content

	for len(rest) != 0 {
		if len(result) == MaximumCertificates {
			return nil, fmt.Errorf("%w: PEM bundle contains more than %d certificates", ErrLimitExceeded, MaximumCertificates)
		}

		der, consumed, err := decodePEMCertificate(rest)
		if err != nil {
			return nil, err
		}
		if len(der) > MaximumCertificateDERBytes {
			return nil, fmt.Errorf("%w: PEM certificate %d exceeds %d DER bytes", ErrLimitExceeded, len(result), MaximumCertificateDERBytes)
		}
		if len(der) > MaximumBundleDERBytes-totalDERBytes {
			return nil, fmt.Errorf("%w: PEM bundle exceeds %d DER bytes", ErrLimitExceeded, MaximumBundleDERBytes)
		}
		if _, duplicate := seen[string(der)]; duplicate {
			return nil, fmt.Errorf("%w: PEM certificate %d repeats an earlier certificate", ErrDuplicateCertificate, len(result))
		}

		certificate, err := validateAndCloneCertificate(der, len(result))
		if err != nil {
			return nil, err
		}
		seen[string(der)] = struct{}{}
		result = append(result, certificate)
		totalDERBytes += len(der)
		rest = trimPEMWhitespace(rest[consumed:])
	}

	if len(result) == 0 {
		return nil, fmt.Errorf("%w: PEM bundle is empty", ErrInvalidContent)
	}
	return result, nil
}

func decodePEMCertificate(content []byte) ([]byte, int, error) {
	if !bytes.HasPrefix(content, []byte(pemBeginLine)) {
		return nil, 0, fmt.Errorf("%w: PEM bundle contains junk or a non-CERTIFICATE block", ErrInvalidContent)
	}

	position := len(pemBeginLine)
	switch {
	case position < len(content) && content[position] == '\n':
		position++
	case position+1 < len(content) && content[position] == '\r' && content[position+1] == '\n':
		position += 2
	default:
		return nil, 0, fmt.Errorf("%w: PEM begin marker is not followed by a line ending", ErrInvalidContent)
	}

	maximumEncodedBytes := base64.StdEncoding.EncodedLen(MaximumCertificateDERBytes)
	encoded := make([]byte, 0, min(maximumEncodedBytes, 4*1024))
	for {
		line, next, terminated, err := readPEMLine(content, position)
		if err != nil {
			return nil, 0, err
		}
		if bytes.Equal(line, []byte(pemEndLine)) {
			if len(encoded) == 0 {
				return nil, 0, fmt.Errorf("%w: PEM certificate body is empty", ErrInvalidContent)
			}
			der := make([]byte, base64.StdEncoding.DecodedLen(len(encoded)))
			decoded, decodeErr := base64.StdEncoding.Strict().Decode(der, encoded)
			if decodeErr != nil {
				return nil, 0, fmt.Errorf("%w: PEM certificate body is not strict base64", ErrInvalidContent)
			}
			der = der[:decoded]
			if len(der) > MaximumCertificateDERBytes {
				return nil, 0, fmt.Errorf("%w: PEM certificate exceeds %d DER bytes", ErrLimitExceeded, MaximumCertificateDERBytes)
			}
			return der, next, nil
		}
		if !terminated {
			return nil, 0, fmt.Errorf("%w: PEM certificate lacks an end marker", ErrInvalidContent)
		}
		if len(line) == 0 {
			return nil, 0, fmt.Errorf("%w: PEM certificate body contains an empty line", ErrInvalidContent)
		}
		if bytes.ContainsRune(line, ':') {
			return nil, 0, fmt.Errorf("%w: PEM headers are not permitted", ErrInvalidContent)
		}
		if len(line) > maximumEncodedBytes-len(encoded) {
			return nil, 0, fmt.Errorf("%w: PEM certificate encoding exceeds its DER limit", ErrLimitExceeded)
		}
		encoded = append(encoded, line...)
		position = next
	}
}

func readPEMLine(content []byte, start int) ([]byte, int, bool, error) {
	if start > len(content) {
		return nil, 0, false, fmt.Errorf("%w: invalid PEM line offset", ErrInvalidContent)
	}
	remainder := content[start:]
	newline := bytes.IndexByte(remainder, '\n')
	if newline < 0 {
		if bytes.IndexByte(remainder, '\r') >= 0 {
			return nil, 0, false, fmt.Errorf("%w: PEM uses a bare carriage return", ErrInvalidContent)
		}
		return remainder, len(content), false, nil
	}

	end := start + newline
	line := content[start:end]
	if len(line) != 0 && line[len(line)-1] == '\r' {
		line = line[:len(line)-1]
	}
	if bytes.IndexByte(line, '\r') >= 0 {
		return nil, 0, false, fmt.Errorf("%w: PEM uses a bare carriage return", ErrInvalidContent)
	}
	return line, end + 1, true, nil
}

func validateAndCloneCertificate(der []byte, index int) ([]byte, error) {
	if len(der) == 0 {
		return nil, fmt.Errorf("%w: certificate %d is empty", ErrInvalidCertificate, index)
	}
	if !isCanonicalCertificateDER(der) {
		return nil, fmt.Errorf("%w: certificate %d is not one exact canonical DER value", ErrInvalidCertificate, index)
	}

	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("%w: parse certificate %d: %v", ErrInvalidCertificate, index, err)
	}
	if !bytes.Equal(certificate.Raw, der) {
		return nil, fmt.Errorf("%w: certificate %d DER differs from the parsed value", ErrInvalidCertificate, index)
	}
	if !certificate.BasicConstraintsValid {
		return nil, fmt.Errorf("%w: certificate %d lacks basic constraints", ErrInvalidCertificate, index)
	}
	if !certificate.IsCA {
		return nil, fmt.Errorf("%w: certificate %d is not a CA", ErrInvalidCertificate, index)
	}
	if certificate.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, fmt.Errorf("%w: certificate %d lacks CertSign key usage", ErrInvalidCertificate, index)
	}
	return bytes.Clone(der), nil
}

func isCanonicalCertificateDER(der []byte) bool {
	if !validateDERDocument(der) {
		return false
	}

	var certificate canonicalCertificate
	rest, err := asn1.Unmarshal(der, &certificate)
	if err != nil || len(rest) != 0 {
		return false
	}
	canonical, err := asn1.Marshal(certificate)
	if err != nil || !bytes.Equal(canonical, der) {
		return false
	}
	if !validateName(certificate.TBSCertificate.Issuer.FullBytes) ||
		!validateName(certificate.TBSCertificate.Subject.FullBytes) {
		return false
	}
	for _, extension := range certificate.TBSCertificate.Extensions {
		if !validateSingleDERValue(extension.Value) {
			return false
		}
	}
	return true
}

func validateName(der []byte) bool {
	name, rest, ok := readDERElement(der)
	if !ok || len(rest) != 0 || name.class != 0 || name.tag != asn1.TagSequence || !name.constructed {
		return false
	}
	rdns, ok := splitDERElements(name.content)
	if !ok {
		return false
	}
	for _, rdn := range rdns {
		if rdn.class != 0 || rdn.tag != asn1.TagSet || !rdn.constructed {
			return false
		}
		attributes, ok := splitDERElements(rdn.content)
		if !ok || len(attributes) == 0 {
			return false
		}
		for _, attribute := range attributes {
			if attribute.class != 0 || attribute.tag != asn1.TagSequence || !attribute.constructed {
				return false
			}
			fields, ok := splitDERElements(attribute.content)
			if !ok || len(fields) != 2 || fields[0].class != 0 || fields[0].tag != asn1.TagOID {
				return false
			}
		}
	}
	return true
}

func validateDERDocument(der []byte) bool {
	element, rest, ok := readDERElement(der)
	return ok && len(rest) == 0 && element.class == 0 &&
		element.tag == asn1.TagSequence && element.constructed && validateDERElement(element, 0)
}

func validateSingleDERValue(der []byte) bool {
	element, rest, ok := readDERElement(der)
	return ok && len(rest) == 0 && validateDERElement(element, 0)
}

func validateDERElement(element derElement, depth int) bool {
	if depth > maximumDERDepth {
		return false
	}
	if element.class == 0 {
		switch element.tag {
		case asn1.TagSequence, asn1.TagSet:
			if !element.constructed {
				return false
			}
		case asn1.TagBoolean, asn1.TagInteger, asn1.TagBitString, asn1.TagOctetString,
			asn1.TagNull, asn1.TagOID, asn1.TagEnum, asn1.TagUTF8String,
			asn1.TagNumericString, asn1.TagPrintableString, asn1.TagT61String,
			asn1.TagIA5String, asn1.TagUTCTime, asn1.TagGeneralizedTime,
			asn1.TagGeneralString, asn1.TagBMPString:
			if element.constructed {
				return false
			}
		}
	}

	if element.constructed {
		children, ok := splitDERElements(element.content)
		if !ok {
			return false
		}
		for index, child := range children {
			if !validateDERElement(child, depth+1) {
				return false
			}
			if element.class == 0 && element.tag == asn1.TagSet && index > 0 &&
				bytes.Compare(children[index-1].full, child.full) > 0 {
				return false
			}
		}
	}

	if element.class != 0 {
		return true
	}
	switch element.tag {
	case 0:
		return false
	case asn1.TagBoolean:
		return len(element.content) == 1 && (element.content[0] == 0 || element.content[0] == 0xff)
	case asn1.TagInteger, asn1.TagEnum:
		return validDERInteger(element.content)
	case asn1.TagBitString:
		return validDERBitString(element.content)
	case asn1.TagNull:
		return len(element.content) == 0
	case asn1.TagOID:
		return validDERObjectIdentifier(element.content)
	case asn1.TagUTCTime:
		return validDERTime(element.content, "060102150405Z", 13)
	case asn1.TagGeneralizedTime:
		return validDERTime(element.content, "20060102150405Z", 15)
	}
	return true
}

func splitDERElements(content []byte) ([]derElement, bool) {
	var elements []derElement
	for len(content) != 0 {
		element, rest, ok := readDERElement(content)
		if !ok {
			return nil, false
		}
		elements = append(elements, element)
		content = rest
	}
	return elements, true
}

func readDERElement(document []byte) (derElement, []byte, bool) {
	if len(document) < 2 {
		return derElement{}, nil, false
	}

	identifier := document[0]
	position := 1
	tag := uint64(identifier & 0x1f)
	if tag == 0x1f {
		tag = 0
		groups := 0
		for {
			if position >= len(document) || groups == 10 {
				return derElement{}, nil, false
			}
			value := document[position]
			position++
			if groups == 0 && value&0x7f == 0 || tag > ^uint64(0)>>7 {
				return derElement{}, nil, false
			}
			tag = tag<<7 | uint64(value&0x7f)
			groups++
			if value&0x80 == 0 {
				break
			}
		}
		if tag < 0x1f {
			return derElement{}, nil, false
		}
	}
	if position >= len(document) {
		return derElement{}, nil, false
	}

	firstLengthByte := document[position]
	position++
	length := uint64(firstLengthByte)
	if firstLengthByte&0x80 != 0 {
		lengthBytes := int(firstLengthByte & 0x7f)
		if lengthBytes == 0 || lengthBytes > 8 || lengthBytes > len(document)-position || document[position] == 0 {
			return derElement{}, nil, false
		}
		length = 0
		for _, value := range document[position : position+lengthBytes] {
			length = length<<8 | uint64(value)
		}
		if length < 128 {
			return derElement{}, nil, false
		}
		position += lengthBytes
	}
	if length > uint64(len(document)-position) {
		return derElement{}, nil, false
	}
	end := position + int(length)
	return derElement{
		class:       identifier >> 6,
		tag:         tag,
		constructed: identifier&0x20 != 0,
		content:     document[position:end],
		full:        document[:end],
	}, document[end:], true
}

func validDERInteger(content []byte) bool {
	if len(content) == 0 {
		return false
	}
	if len(content) == 1 {
		return true
	}
	return !(content[0] == 0 && content[1]&0x80 == 0 ||
		content[0] == 0xff && content[1]&0x80 != 0)
}

func validDERBitString(content []byte) bool {
	if len(content) == 0 || content[0] > 7 {
		return false
	}
	if len(content) == 1 {
		return content[0] == 0
	}
	if content[0] == 0 {
		return true
	}
	mask := byte(1<<content[0]) - 1
	return content[len(content)-1]&mask == 0
}

func validDERObjectIdentifier(content []byte) bool {
	if len(content) == 0 {
		return false
	}
	firstInComponent := true
	for _, value := range content {
		if firstInComponent && value == 0x80 {
			return false
		}
		firstInComponent = value&0x80 == 0
	}
	return firstInComponent
}

func validDERTime(content []byte, layout string, size int) bool {
	if len(content) != size || content[len(content)-1] != 'Z' {
		return false
	}
	for _, value := range content[:len(content)-1] {
		if value < '0' || value > '9' {
			return false
		}
	}
	_, err := time.Parse(layout, string(content))
	return err == nil
}

func trimPEMWhitespace(content []byte) []byte {
	start := 0
	for start < len(content) && isPEMWhitespace(content[start]) {
		start++
	}
	end := len(content)
	for end > start && isPEMWhitespace(content[end-1]) {
		end--
	}
	return content[start:end]
}

func isPEMWhitespace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}
