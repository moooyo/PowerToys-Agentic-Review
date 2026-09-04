// Package servicehostreceipt defines the canonical output receipt emitted by the controlled
// ServiceHost release builder before Authenticode signing.
package servicehostreceipt

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

const (
	SchemaVersion        = uint32(1)
	PackageProfile       = "worker-release-v1"
	MaximumDocumentBytes = uint64(64 * 1024)
)

var ErrInvalid = errors.New("invalid ServiceHost build receipt")

type Source struct {
	Commit string `json:"commit"`
	Tree   string `json:"tree"`
}

// Receipt binds one controlled source snapshot and compiled template to the exact unsigned PE
// and to the byte identity that must remain stable after Authenticode signing.
type Receipt struct {
	CompiledReleaseTemplateSHA256 string `json:"compiledReleaseTemplateSha256"`
	PackageProfile                string `json:"packageProfile"`
	ReleaseID                     string `json:"releaseId"`
	SchemaVersion                 uint32 `json:"schemaVersion"`
	SigningInvariantSHA256        string `json:"signingInvariantSha256"`
	Source                        Source `json:"source"`
	TargetArchitecture            string `json:"targetArchitecture"`
	UnsignedSHA256                string `json:"unsignedSha256"`
	UnsignedSize                  string `json:"unsignedSize"`
}

// MarshalCanonical validates and serializes one receipt without a trailing newline.
func MarshalCanonical(value Receipt) ([]byte, error) {
	if err := validate(value); err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("%w: serialize receipt", ErrInvalid)
	}
	document := buffer.Bytes()
	if len(document) == 0 || document[len(document)-1] != '\n' {
		return nil, fmt.Errorf("%w: canonical delimiter is absent", ErrInvalid)
	}
	document = append([]byte(nil), document[:len(document)-1]...)
	if uint64(len(document)) == 0 || uint64(len(document)) > MaximumDocumentBytes {
		return nil, fmt.Errorf("%w: canonical document size is invalid", ErrInvalid)
	}
	return document, nil
}

// Parse accepts only the exact canonical receipt encoding.
func Parse(document []byte) (Receipt, error) {
	if len(document) == 0 || uint64(len(document)) > MaximumDocumentBytes ||
		bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return Receipt{}, fmt.Errorf("%w: document encoding is invalid", ErrInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	var value Receipt
	if err := decoder.Decode(&value); err != nil {
		return Receipt{}, fmt.Errorf("%w: document is not strict JSON", ErrInvalid)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Receipt{}, fmt.Errorf("%w: document contains trailing content", ErrInvalid)
	}
	canonical, err := MarshalCanonical(value)
	if err != nil || !bytes.Equal(canonical, document) {
		return Receipt{}, fmt.Errorf("%w: document is not canonical", ErrInvalid)
	}
	return value, nil
}

func validate(value Receipt) error {
	if value.SchemaVersion != SchemaVersion || value.PackageProfile != PackageProfile ||
		!validReleaseID(value.ReleaseID) || !validArchitecture(value.TargetArchitecture) ||
		!validGitObjectID(value.Source.Commit) || !validGitObjectID(value.Source.Tree) ||
		len(value.Source.Commit) != len(value.Source.Tree) ||
		!validSHA256(value.CompiledReleaseTemplateSHA256) ||
		!validSHA256(value.SigningInvariantSHA256) || !validSHA256(value.UnsignedSHA256) ||
		!validUnsignedSize(value.UnsignedSize) {
		return ErrInvalid
	}
	return nil
}

func validArchitecture(value string) bool { return value == "amd64" || value == "arm64" }

func validGitObjectID(value string) bool {
	return (len(value) == 40 || len(value) == 64) && validLowerHex(value)
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

func validReleaseID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for index, character := range []byte(value) {
		if character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' || index > 0 &&
			(character == '.' || character == '_' || character == '+' || character == '-') {
			continue
		}
		return false
	}
	return true
}

func validUnsignedSize(value string) bool {
	if value == "" || value == "0" || len(value) > 20 || value[0] == '0' {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	size, err := strconv.ParseUint(value, 10, 64)
	return err == nil && size > 0 && size <= releaseprofile.MaximumServiceHostBytes
}
