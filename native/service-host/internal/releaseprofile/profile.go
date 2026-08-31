package releaseprofile

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

const (
	SchemaVersion           = uint32(1)
	ProductionProfileID     = "static-review-v1"
	ServiceHostRelativePath = `native\AgenticReview.ServiceHost.exe`
	MaximumDocumentBytes    = releasemanifest.MaximumDocumentBytes
	MaximumServiceHostBytes = uint64(512 * 1024 * 1024)
)

var (
	// ErrUnavailable means this binary was not compiled with a release template.
	ErrUnavailable = errors.New("compiled release template is unavailable")
	// ErrInvalid means a compiled or build-time release template is invalid.
	ErrInvalid = errors.New("compiled release template is invalid")
	// ErrInvalidEvidence means a zero or internally inconsistent Evidence was used.
	ErrInvalidEvidence = errors.New("compiled release template evidence is invalid")
)

// Dependency is one non-ServiceHost file committed by the compiled release
// template. Size is canonical unsigned decimal.
type Dependency struct {
	Root   releasemanifest.FileRoot `json:"root"`
	Path   string                   `json:"path"`
	Role   releasemanifest.FileRole `json:"role"`
	SHA256 string                   `json:"sha256"`
	Size   string                   `json:"size"`
}

// SelfRequirement identifies the only ServiceHost manifest entry. Its digest
// and size are deliberately absent because embedding either final value in the
// same executable would create a cryptographic self-reference.
type SelfRequirement struct {
	Root releasemanifest.FileRoot `json:"root"`
	Path string                   `json:"path"`
	Role releasemanifest.FileRole `json:"role"`
}

type templateDocument struct {
	AuthenticodeLeafSignerCertificateDERSHA256 string                        `json:"authenticodeLeafSignerCertificateDerSha256"`
	Compatibility                              releasemanifest.Compatibility `json:"compatibility"`
	Dependencies                               []Dependency                  `json:"dependencies"`
	ProfileID                                  string                        `json:"profileId"`
	ReleaseID                                  string                        `json:"releaseId"`
	SchemaVersion                              uint32                        `json:"schemaVersion"`
	ServiceHost                                SelfRequirement               `json:"serviceHost"`
}

type evidenceState struct {
	document  []byte
	digest    [sha256.Size]byte
	template  templateDocument
	validated bool
}

// Evidence is immutable authorization input derived only from the release
// template compiled into the current ServiceHost binary. Its zero value and
// caller-assembled values are invalid.
type Evidence struct {
	state *evidenceState
}

// Production loads the canonical release template compiled into this binary.
// It never reads a runtime file, environment variable, command-line argument,
// ServiceHost bootstrap configuration, or installed release manifest.
func Production() (Evidence, error) {
	if compiledReleaseTemplateDocument == "" && compiledReleaseTemplateSHA256 == "" {
		return Evidence{}, ErrUnavailable
	}
	expected, err := decodeSHA256(compiledReleaseTemplateSHA256)
	if err != nil {
		return Evidence{}, fmt.Errorf("%w: embedded digest: %v", ErrInvalid, err)
	}
	actual := sha256.Sum256([]byte(compiledReleaseTemplateDocument))
	if subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
		return Evidence{}, fmt.Errorf("%w: embedded document digest mismatch", ErrInvalid)
	}
	state, err := parseCanonicalDocument([]byte(compiledReleaseTemplateDocument))
	if err != nil {
		return Evidence{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if subtle.ConstantTimeCompare(state.digest[:], expected[:]) != 1 {
		return Evidence{}, fmt.Errorf("%w: parsed document digest mismatch", ErrInvalid)
	}
	return Evidence{state: state}, nil
}

// ValidateDocument validates a build-time template without turning it into
// runtime authorization evidence. The release generator uses this function.
func ValidateDocument(document []byte) error {
	_, err := parseCanonicalDocument(document)
	return err
}

// Validate proves that Evidence is nonzero and still matches its private
// canonical document and deterministic digest.
func (e Evidence) Validate() error {
	if e.state == nil || !e.state.validated || len(e.state.document) == 0 ||
		e.state.digest == ([sha256.Size]byte{}) {
		return ErrInvalidEvidence
	}
	reparsed, err := parseCanonicalDocument(e.state.document)
	if err != nil || !sameState(e.state, reparsed) {
		return errors.Join(ErrInvalidEvidence, err)
	}
	return nil
}

// Digest returns the SHA-256 of the exact canonical compiled template.
func (e Evidence) Digest() ([sha256.Size]byte, error) {
	if err := e.Validate(); err != nil {
		return [sha256.Size]byte{}, err
	}
	return e.state.digest, nil
}

func (e Evidence) SchemaVersion() uint32 {
	if e.Validate() != nil {
		return 0
	}
	return e.state.template.SchemaVersion
}

func (e Evidence) ProfileID() string {
	if e.Validate() != nil {
		return ""
	}
	return e.state.template.ProfileID
}

func (e Evidence) ReleaseID() string {
	if e.Validate() != nil {
		return ""
	}
	return e.state.template.ReleaseID
}

func (e Evidence) Compatibility() releasemanifest.Compatibility {
	if e.Validate() != nil {
		return releasemanifest.Compatibility{}
	}
	return e.state.template.Compatibility
}

func (e Evidence) AuthenticodeLeafSignerCertificateDERSHA256() string {
	if e.Validate() != nil {
		return ""
	}
	return e.state.template.AuthenticodeLeafSignerCertificateDERSHA256
}

func (e Evidence) Dependencies() []Dependency {
	if e.Validate() != nil {
		return nil
	}
	return append([]Dependency(nil), e.state.template.Dependencies...)
}

func (e Evidence) ServiceHost() SelfRequirement {
	if e.Validate() != nil {
		return SelfRequirement{}
	}
	return e.state.template.ServiceHost
}

func parseCanonicalDocument(document []byte) (*evidenceState, error) {
	if len(document) == 0 {
		return nil, fmt.Errorf("%w: document must not be empty", ErrInvalid)
	}
	if len(document) > MaximumDocumentBytes {
		return nil, fmt.Errorf("%w: document exceeds %d bytes", ErrInvalid, MaximumDocumentBytes)
	}
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return nil, fmt.Errorf("%w: document must be UTF-8 without a byte-order mark", ErrInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	var value templateDocument
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("%w: document is not strict JSON: %v", ErrInvalid, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("multiple JSON values")
		}
		return nil, fmt.Errorf("%w: document contains trailing content: %v", ErrInvalid, err)
	}

	normalized, err := normalizeDocument(value)
	if err != nil {
		return nil, err
	}
	canonical, err := marshalNormalized(normalized)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(document, canonical) {
		return nil, fmt.Errorf("%w: document is not canonical", ErrInvalid)
	}
	digest := sha256.Sum256(canonical)
	return &evidenceState{
		document:  append([]byte(nil), canonical...),
		digest:    digest,
		template:  cloneTemplate(normalized),
		validated: true,
	}, nil
}

func normalizeDocument(value templateDocument) (templateDocument, error) {
	if value.SchemaVersion != SchemaVersion {
		return templateDocument{}, fmt.Errorf("%w: schemaVersion must be %d", ErrInvalid, SchemaVersion)
	}
	if value.ProfileID != ProductionProfileID {
		return templateDocument{}, fmt.Errorf("%w: profileId must be %q", ErrInvalid, ProductionProfileID)
	}
	if !validSHA256(value.AuthenticodeLeafSignerCertificateDERSHA256) {
		return templateDocument{}, fmt.Errorf("%w: Authenticode leaf signer digest is invalid", ErrInvalid)
	}
	expectedSelf := SelfRequirement{
		Root: releasemanifest.RootInstallation,
		Path: ServiceHostRelativePath,
		Role: releasemanifest.RoleServiceHost,
	}
	if value.ServiceHost != expectedSelf {
		return templateDocument{}, fmt.Errorf("%w: serviceHost must be the fixed ServiceHost descriptor", ErrInvalid)
	}
	if len(value.Dependencies) == 0 || len(value.Dependencies) >= releasemanifest.MaximumFiles {
		return templateDocument{}, fmt.Errorf("%w: dependency count is outside the supported range", ErrInvalid)
	}

	seen := make(map[string]struct{}, len(value.Dependencies))
	files := make([]releasemanifest.File, 0, len(value.Dependencies)+1)
	for _, dependency := range value.Dependencies {
		if dependency.Role == releasemanifest.RoleServiceHost {
			return templateDocument{}, fmt.Errorf("%w: dependencies must not contain a service-host role", ErrInvalid)
		}
		key := string(dependency.Root) + "\x00" + strings.ToLower(dependency.Path)
		if _, exists := seen[key]; exists {
			return templateDocument{}, fmt.Errorf("%w: dependencies contain a duplicate root and path", ErrInvalid)
		}
		seen[key] = struct{}{}
		if dependency.Root == expectedSelf.Root && strings.EqualFold(dependency.Path, expectedSelf.Path) {
			return templateDocument{}, fmt.Errorf("%w: dependencies must not contain the ServiceHost path", ErrInvalid)
		}
		files = append(files, releasemanifest.File{
			Root: dependency.Root, Path: dependency.Path, Role: dependency.Role,
			SHA256: dependency.SHA256, Size: dependency.Size,
		})
	}

	validationDigest := sha256.Sum256([]byte("AgenticReview release-template self validation"))
	files = append(files, releasemanifest.File{
		Root: expectedSelf.Root, Path: expectedSelf.Path, Role: expectedSelf.Role,
		SHA256: hex.EncodeToString(validationDigest[:]),
		Size:   strconv.FormatUint(MaximumServiceHostBytes, 10),
	})
	manifest := releasemanifest.Manifest{
		Compatibility:   value.Compatibility,
		Files:           files,
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       value.ReleaseID,
		SchemaVersion:   releasemanifest.SchemaVersion,
	}
	canonicalManifest, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		return templateDocument{}, fmt.Errorf("%w: dependencies do not form a valid release manifest: %v", ErrInvalid, err)
	}
	normalizedManifest, err := releasemanifest.Parse(canonicalManifest)
	if err != nil {
		return templateDocument{}, fmt.Errorf("%w: validate normalized dependencies: %v", ErrInvalid, err)
	}
	normalizedDependencies := make([]Dependency, 0, len(value.Dependencies))
	selfCount := 0
	for _, file := range normalizedManifest.Files {
		if file.Role == releasemanifest.RoleServiceHost {
			selfCount++
			if file.Root != expectedSelf.Root || file.Path != expectedSelf.Path {
				return templateDocument{}, fmt.Errorf("%w: normalized ServiceHost descriptor changed", ErrInvalid)
			}
			continue
		}
		normalizedDependencies = append(normalizedDependencies, Dependency{
			Root: file.Root, Path: file.Path, Role: file.Role, SHA256: file.SHA256, Size: file.Size,
		})
	}
	if selfCount != 1 || len(normalizedDependencies) != len(value.Dependencies) {
		return templateDocument{}, fmt.Errorf("%w: release template must contain exactly one ServiceHost descriptor", ErrInvalid)
	}
	value.Dependencies = normalizedDependencies
	value.ServiceHost = expectedSelf
	return value, nil
}

func marshalNormalized(value templateDocument) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("%w: serialize canonical document: %v", ErrInvalid, err)
	}
	document := buffer.Bytes()
	if len(document) == 0 || document[len(document)-1] != '\n' {
		return nil, fmt.Errorf("%w: serialized document lacks final delimiter", ErrInvalid)
	}
	document = append([]byte(nil), document[:len(document)-1]...)
	if len(document) > MaximumDocumentBytes {
		return nil, fmt.Errorf("%w: canonical document exceeds %d bytes", ErrInvalid, MaximumDocumentBytes)
	}
	return document, nil
}

func sameState(left, right *evidenceState) bool {
	return left != nil && right != nil && left.validated && right.validated &&
		left.digest == right.digest && bytes.Equal(left.document, right.document) &&
		reflect.DeepEqual(left.template, right.template)
}

func cloneTemplate(value templateDocument) templateDocument {
	value.Dependencies = append([]Dependency(nil), value.Dependencies...)
	return value
}

func decodeSHA256(value string) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	if !validSHA256(value) {
		return result, errors.New("digest must contain 64 lowercase hexadecimal characters")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return result, errors.New("digest must contain 64 lowercase hexadecimal characters")
	}
	copy(result[:], decoded)
	return result, nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}
