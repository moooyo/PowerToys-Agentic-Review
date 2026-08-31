package servicebootstrap

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

const maximumCurrentImagePathUnits = 32_768

type currentImageEvidenceIssuer struct {
	marker byte
}

var successfulCurrentImageEvidenceIssuer = &currentImageEvidenceIssuer{marker: 1}

type currentImageEvidenceState struct {
	issuer                   *currentImageEvidenceIssuer
	bootstrapDigest          [sha256.Size]byte
	processFacts             peerverify.StableProcessFacts
	processPath              string
	finalPathDiagnostic      string
	finalPathDiagnosticError string
	identity                 peerverify.FileIdentity
	size                     uint64
	sha256                   [sha256.Size]byte
	digest                   [sha256.Size]byte
}

// CurrentImageEvidence is an opaque measurement of the current ServiceHost
// image. It proves file identity and content, not Authenticode authorization.
// Final-path text is retained only for diagnostics and is excluded from the
// authority digest.
type CurrentImageEvidence struct {
	state *currentImageEvidenceState
}

// MeasureCurrentImage performs the session's only current-image measurement.
// It is serialized with Close. Every outcome consumes the one-shot attempt.
func (s *bootstrapSession) MeasureCurrentImage() (CurrentImageEvidence, error) {
	if s == nil {
		return CurrentImageEvidence{}, ErrClosed
	}
	s.closeMu.Lock()
	defer s.closeMu.Unlock()

	s.mu.Lock()
	if s.imageMeasurementClosed {
		s.mu.Unlock()
		return CurrentImageEvidence{}, ErrClosed
	}
	if s.imageMeasurementAttempted {
		s.mu.Unlock()
		return CurrentImageEvidence{}, ErrCurrentImageMeasured
	}
	if s.current == nil {
		s.mu.Unlock()
		return CurrentImageEvidence{}, ErrClosed
	}
	s.imageMeasurementAttempted = true
	current := s.current
	s.current = nil
	bootstrap := s.evidence
	s.mu.Unlock()

	evidence, retainedImage, err := measureCurrentImage(current, bootstrap)
	if !isNilInterface(retainedImage) {
		s.mu.Lock()
		s.failedCurrentImageClose = retainedImage
		s.mu.Unlock()
	}
	if err != nil {
		return CurrentImageEvidence{}, err
	}
	return evidence, nil
}

func measureCurrentImage(
	current currentProcess,
	bootstrap Evidence,
) (result CurrentImageEvidence, retained peerverify.ImageSubject, err error) {
	if isNilInterface(current) {
		return CurrentImageEvidence{}, nil, errors.New("current ServiceHost process adapter is missing")
	}
	if err := bootstrap.Validate(); err != nil {
		return CurrentImageEvidence{}, nil, fmt.Errorf("validate bootstrap source evidence: %w", err)
	}
	bootstrapDigest, err := bootstrap.Digest()
	if err != nil {
		return CurrentImageEvidence{}, nil, fmt.Errorf("read bootstrap source digest: %w", err)
	}
	wantFacts := bootstrap.StableServiceHostFacts()
	beforeFacts, err := inspectStableProcess(current, wantFacts.ProcessID, "current ServiceHost before image measurement")
	if err != nil {
		return CurrentImageEvidence{}, nil, err
	}
	if err := requireSameProcessFacts(wantFacts, beforeFacts, "current ServiceHost bootstrap-to-image"); err != nil {
		return CurrentImageEvidence{}, nil, err
	}

	firstPath, err := current.ImagePathDiagnostic()
	if err != nil {
		return CurrentImageEvidence{}, nil, fmt.Errorf("query current ServiceHost image path before reopening: %w", err)
	}
	canonicalPath, err := canonicalWindowsAbsoluteImagePath(firstPath)
	if err != nil {
		return CurrentImageEvidence{}, nil, fmt.Errorf("validate current ServiceHost image path: %w", err)
	}

	image, err := current.OpenImage()
	if err != nil {
		return CurrentImageEvidence{}, nil, fmt.Errorf("reopen current ServiceHost image: %w", err)
	}
	if isNilInterface(image) {
		return CurrentImageEvidence{}, nil, fmt.Errorf("%w: current process returned no image object", ErrCurrentImageMismatch)
	}
	retained = image
	defer func() {
		if isNilInterface(retained) {
			return
		}
		if closeErr := retained.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close current ServiceHost image after measurement: %w", closeErr))
			return
		}
		retained = nil
	}()

	reopenedPath, err := canonicalWindowsAbsoluteImagePath(image.ProcessPathDiagnostic())
	if err != nil || !strings.EqualFold(canonicalPath, reopenedPath) {
		return CurrentImageEvidence{}, retained, errors.Join(
			ErrCurrentImageMismatch,
			fmt.Errorf("reopened image path differs from retained process path: %w", err),
		)
	}
	identity := image.Identity()
	if identity.VolumeSerialNumber == 0 || identity.FileID == ([16]byte{}) {
		return CurrentImageEvidence{}, retained, fmt.Errorf("%w: reopened image identity is incomplete", ErrCurrentImageMismatch)
	}
	size := image.Size()
	if size <= 0 || uint64(size) > releaseprofile.MaximumServiceHostBytes {
		return CurrentImageEvidence{}, retained, fmt.Errorf("%w: reopened image size %d is outside the supported range", ErrCurrentImageMismatch, size)
	}

	hasher := sha256.New()
	written, err := io.Copy(hasher, io.NewSectionReader(image, 0, size))
	if err != nil {
		return CurrentImageEvidence{}, retained, fmt.Errorf("hash reopened current ServiceHost image: %w", err)
	}
	if written != size {
		return CurrentImageEvidence{}, retained, fmt.Errorf("%w: hashed %d of %d image bytes", ErrCurrentImageMismatch, written, size)
	}
	var imageDigest [sha256.Size]byte
	copy(imageDigest[:], hasher.Sum(nil))

	finalPath, finalPathErr := image.FinalPathDiagnostic()
	finalPathError := ""
	if finalPathErr != nil {
		finalPathError = finalPathErr.Error()
	}
	afterFacts, err := inspectStableProcess(current, wantFacts.ProcessID, "current ServiceHost after image measurement")
	if err != nil {
		return CurrentImageEvidence{}, retained, err
	}
	if err := requireSameProcessFacts(wantFacts, afterFacts, "current ServiceHost bootstrap-to-image final"); err != nil {
		return CurrentImageEvidence{}, retained, err
	}
	if err := requireSameProcessFacts(beforeFacts, afterFacts, "current ServiceHost image measurement"); err != nil {
		return CurrentImageEvidence{}, retained, err
	}
	secondPath, err := current.ImagePathDiagnostic()
	if err != nil {
		return CurrentImageEvidence{}, retained, fmt.Errorf("requery current ServiceHost image path: %w", err)
	}
	canonicalSecondPath, err := canonicalWindowsAbsoluteImagePath(secondPath)
	if err != nil || !strings.EqualFold(canonicalPath, canonicalSecondPath) {
		return CurrentImageEvidence{}, retained, errors.Join(
			ErrCurrentImageMismatch,
			fmt.Errorf("current ServiceHost image path changed during measurement: %w", err),
		)
	}
	if err := image.VerifyUnchanged(); err != nil {
		return CurrentImageEvidence{}, retained, errors.Join(
			ErrCurrentImageMismatch,
			fmt.Errorf("reopened current ServiceHost image changed during measurement: %w", err),
		)
	}
	if err := image.Close(); err != nil {
		return CurrentImageEvidence{}, retained, fmt.Errorf("close current ServiceHost image before issuing evidence: %w", err)
	}
	retained = nil
	evidence, err := issueCurrentImageEvidence(currentImageEvidenceState{
		bootstrapDigest:          bootstrapDigest,
		processFacts:             afterFacts,
		processPath:              canonicalPath,
		finalPathDiagnostic:      finalPath,
		finalPathDiagnosticError: finalPathError,
		identity:                 identity,
		size:                     uint64(size),
		sha256:                   imageDigest,
	})
	return evidence, nil, err
}

func issueCurrentImageEvidence(value currentImageEvidenceState) (CurrentImageEvidence, error) {
	value.issuer = successfulCurrentImageEvidenceIssuer
	value.digest = digestCurrentImageEvidence(&value)
	evidence := CurrentImageEvidence{state: &value}
	if err := evidence.Validate(); err != nil {
		return CurrentImageEvidence{}, err
	}
	return evidence, nil
}

func (e CurrentImageEvidence) Validate() error {
	state := e.state
	if state == nil || state.issuer != successfulCurrentImageEvidenceIssuer ||
		state.bootstrapDigest == ([sha256.Size]byte{}) || state.digest == ([sha256.Size]byte{}) {
		return invalidCurrentImageEvidence("evidence was not issued by a successful measurement", nil)
	}
	if err := validateStableProcessFacts(state.processFacts, "measured current ServiceHost"); err != nil {
		return invalidCurrentImageEvidence("process facts are invalid", err)
	}
	canonicalPath, err := canonicalWindowsAbsoluteImagePath(state.processPath)
	if err != nil || canonicalPath != state.processPath {
		return invalidCurrentImageEvidence("process path is invalid", err)
	}
	if state.identity.VolumeSerialNumber == 0 || state.identity.FileID == ([16]byte{}) {
		return invalidCurrentImageEvidence("file identity is incomplete", nil)
	}
	if state.size == 0 || state.size > releaseprofile.MaximumServiceHostBytes || state.sha256 == ([sha256.Size]byte{}) {
		return invalidCurrentImageEvidence("file size or SHA-256 is invalid", nil)
	}
	if state.finalPathDiagnostic != "" {
		if !utf8.ValidString(state.finalPathDiagnostic) || strings.ContainsRune(state.finalPathDiagnostic, '\x00') {
			return invalidCurrentImageEvidence("final-path diagnostic is invalid", nil)
		}
	}
	if !utf8.ValidString(state.finalPathDiagnosticError) || strings.ContainsRune(state.finalPathDiagnosticError, '\x00') {
		return invalidCurrentImageEvidence("final-path diagnostic error is invalid", nil)
	}
	if digestCurrentImageEvidence(state) != state.digest {
		return invalidCurrentImageEvidence("authority facts differ from their sealed digest", nil)
	}
	return nil
}

func (e CurrentImageEvidence) Digest() ([sha256.Size]byte, error) {
	if err := e.Validate(); err != nil {
		return [sha256.Size]byte{}, err
	}
	return e.state.digest, nil
}

func (e CurrentImageEvidence) BootstrapDigest() [sha256.Size]byte {
	if e.Validate() != nil {
		return [sha256.Size]byte{}
	}
	return e.state.bootstrapDigest
}

func (e CurrentImageEvidence) ProcessFacts() peerverify.StableProcessFacts {
	if e.Validate() != nil {
		return peerverify.StableProcessFacts{}
	}
	return e.state.processFacts
}

func (e CurrentImageEvidence) ProcessPath() string {
	if e.Validate() != nil {
		return ""
	}
	return e.state.processPath
}

func (e CurrentImageEvidence) FinalPathDiagnostic() (string, string) {
	if e.Validate() != nil {
		return "", ""
	}
	return e.state.finalPathDiagnostic, e.state.finalPathDiagnosticError
}

func (e CurrentImageEvidence) Identity() peerverify.FileIdentity {
	if e.Validate() != nil {
		return peerverify.FileIdentity{}
	}
	return e.state.identity
}

func (e CurrentImageEvidence) Size() uint64 {
	if e.Validate() != nil {
		return 0
	}
	return e.state.size
}

func (e CurrentImageEvidence) SHA256() [sha256.Size]byte {
	if e.Validate() != nil {
		return [sha256.Size]byte{}
	}
	return e.state.sha256
}

func digestCurrentImageEvidence(state *currentImageEvidenceState) [sha256.Size]byte {
	encoder := evidenceDigestEncoder{hash: sha256.New()}
	encoder.text("agentic-review/current-servicehost-image-evidence/v1")
	encoder.bytes(state.bootstrapDigest[:])
	encodeStableProcessFacts(&encoder, state.processFacts)
	encoder.text(state.processPath)
	encoder.u64(state.identity.VolumeSerialNumber)
	encoder.bytes(state.identity.FileID[:])
	encoder.u64(state.size)
	encoder.bytes(state.sha256[:])
	var result [sha256.Size]byte
	copy(result[:], encoder.hash.Sum(nil))
	return result
}

func canonicalWindowsAbsoluteImagePath(value string) (string, error) {
	if value == "" || !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') ||
		len(utf16.Encode([]rune(value))) > maximumCurrentImagePathUnits {
		return "", errors.New("path is empty, invalid, or too long")
	}
	value = strings.ReplaceAll(value, "/", `\`)
	lower := strings.ToLower(value)
	switch {
	case strings.HasPrefix(lower, `\\?\unc\`):
		value = `\\` + value[len(`\\?\unc\`):]
	case strings.HasPrefix(lower, `\\?\`):
		value = value[len(`\\?\`):]
	case strings.HasPrefix(lower, `\??\`):
		value = value[len(`\??\`):]
	}
	if len(value) >= 3 && isASCIIAlpha(value[0]) && value[1] == ':' && value[2] == '\\' {
		return value, nil
	}
	if strings.HasPrefix(value, `\\`) {
		components := strings.Split(value[2:], `\`)
		if len(components) >= 2 && components[0] != "" && components[1] != "" {
			return value, nil
		}
	}
	return "", errors.New("path is not an absolute DOS or UNC path")
}

func isASCIIAlpha(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}

func invalidCurrentImageEvidence(message string, cause error) error {
	if cause != nil {
		return fmt.Errorf("%w: %s: %w", ErrInvalidCurrentImageEvidence, message, cause)
	}
	return fmt.Errorf("%w: %s", ErrInvalidCurrentImageEvidence, message)
}

func isNilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	return reflected.Kind() == reflect.Pointer && reflected.IsNil()
}
