package installerdestination

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash"
	"reflect"
	"strconv"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/stagedpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

// Validate rechecks the live staged gate and every retained destination handle.
func (evidence Evidence) Validate() error {
	return evidence.withValidatedState(func(*evidenceState) {})
}

func (evidence Evidence) withValidatedState(use func(*evidenceState)) error {
	if use == nil {
		return ErrInvalidEvidence
	}
	operation, err := beginCleanupOperation()
	if err != nil {
		return ErrCleanupFatal
	}
	state := evidence.state
	if state == nil {
		return ErrInvalidEvidence
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed {
		return ErrClosed
	}
	if validateEvidenceState(state) != nil {
		return ErrInvalidEvidence
	}
	destinationValid := false
	if err := state.source.commit(operation, func() {
		// See Verify: this callback contains retained-handle queries only, so both live closures
		// are observed under the combined source and cleanup commit barrier.
		if state.owner.recheck() != nil {
			return
		}
		use(state)
		destinationValid = true
	}); err != nil {
		err = translateStagedError(err)
		if errors.Is(err, ErrCleanupFatal) {
			return ErrCleanupFatal
		}
		return ErrInvalidEvidence
	}
	if !destinationValid {
		return ErrInvalidEvidence
	}
	return nil
}

// Close releases destination handles and the originating staged-package handles. It is idempotent.
func (evidence Evidence) Close() error {
	state := evidence.state
	if state == nil {
		return ErrInvalidEvidence
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed {
		return state.closeResult
	}
	var result error
	sourceValidationErr := translateStagedError(state.source.validate())
	if state.owner == nil || state.owner.recheck() != nil || sourceValidationErr != nil {
		result = ErrInvalidEvidence
	}
	if errors.Is(sourceValidationErr, ErrCleanupFatal) {
		result = errors.Join(result, ErrCleanupFatal)
	}
	cleanupErr, unresolved := state.owner.close()
	if cleanupErr != nil {
		result = errors.Join(result, ErrCleanup, cleanupErr)
	}
	if sourceErr := translateStagedError(state.source.close()); sourceErr != nil {
		result = errors.Join(result, ErrCleanup, sourceErr)
		if errors.Is(sourceErr, stagedpackage.ErrCleanupFatal) {
			result = errors.Join(result, ErrCleanupFatal)
		}
	}
	state.closed = true
	if unresolved {
		publishCleanupFatal(state.owner)
		state.closeResult = errors.Join(result, ErrCleanupFatal)
		return state.closeResult
	}
	state.owner = nil
	if !cleanupHealthy() {
		result = errors.Join(result, ErrCleanupFatal)
	}
	state.closeResult = result
	return state.closeResult
}

func (evidence Evidence) PackageID() string {
	var result string
	if evidence.withValidatedState(func(state *evidenceState) {
		result = state.plan.index.PackageID
	}) != nil {
		return ""
	}
	return result
}

func (evidence Evidence) Roots() []RootSnapshot {
	var result []RootSnapshot
	if evidence.withValidatedState(func(state *evidenceState) {
		result = make([]RootSnapshot, len(state.roots))
		for index, value := range state.roots {
			value.object = cloneObjectEvidence(value.object)
			result[index] = value
		}
	}) != nil {
		return nil
	}
	return result
}

func (evidence Evidence) Files() []FileSnapshot {
	var result []FileSnapshot
	if evidence.withValidatedState(func(state *evidenceState) {
		result = make([]FileSnapshot, len(state.files))
		for index, value := range state.files {
			result[index] = cloneFileSnapshot(value)
		}
	}) != nil {
		return nil
	}
	return result
}

func (Evidence) MarshalJSON() ([]byte, error) { return nil, ErrSerialization }

func validateEvidenceState(state *evidenceState) error {
	if state == nil || state.issuer != successfulEvidenceIssuer || state.closed || state.owner == nil ||
		state.source.validate == nil || state.source.close == nil || state.source.commit == nil ||
		state.digest == ([sha256.Size]byte{}) ||
		state.plan.index.SchemaVersion != outerpackage.IndexSchemaVersion ||
		state.plan.index.ProfileID != outerpackage.IndexProfileID || len(state.roots) != 3 ||
		len(state.files) != len(state.plan.index.Payloads)+2 || digestEvidenceState(state) != state.digest {
		return ErrInvalidEvidence
	}
	validatedPlan, err := parseSourcePlan(
		state.plan.indexDocument,
		state.plan.envelopeDocument,
		state.plan.controlDocument,
		state.plan.executorDocument,
		state.plan.signerKeyID,
	)
	if err != nil || !reflect.DeepEqual(validatedPlan.index, state.plan.index) ||
		!reflect.DeepEqual(validatedPlan.control, state.plan.control) ||
		!reflect.DeepEqual(validatedPlan.executor, state.plan.executor) {
		return ErrInvalidEvidence
	}
	for index, root := range []outerpackage.Root{outerpackage.RootMetadata, outerpackage.RootInstallation, outerpackage.RootTrustedConfiguration} {
		expectedPath := rootPath(state.plan.index, root)
		if state.roots[index].root != root || state.roots[index].path != expectedPath ||
			validateManagedObject(state.roots[index].object, expectedPath, winfile.ObjectKindDirectory) != nil {
			return ErrInvalidEvidence
		}
	}
	expected := make(map[string]expectedFile, len(state.plan.index.Payloads)+2)
	indexDigest := sha256.Sum256(state.plan.indexDocument)
	expected[fileKey(string(outerpackage.RootMetadata), outerpackage.PackageIndexPath)] = expectedFile{
		digest: stringLowerHex(indexDigest), size: uint64(len(state.plan.indexDocument)), exact: state.plan.indexDocument,
	}
	envelopeDigest := sha256.Sum256(state.plan.envelopeDocument)
	expected[fileKey(string(outerpackage.RootMetadata), outerpackage.SignatureEnvelopePath)] = expectedFile{
		digest: stringLowerHex(envelopeDigest), size: uint64(len(state.plan.envelopeDocument)), exact: state.plan.envelopeDocument,
	}
	for _, payload := range state.plan.index.Payloads {
		size, err := strconv.ParseUint(payload.Size, 10, 64)
		if err != nil {
			return ErrInvalidEvidence
		}
		expected[fileKey(string(payload.Root), payload.Path)] = expectedFile{
			role: payload.Role, digest: payload.SHA256, size: size,
		}
	}
	seen := make(map[string]struct{}, len(state.files))
	for _, file := range state.files {
		key := fileKey(string(file.root), file.path)
		wanted, ok := expected[key]
		if !ok || file.role != wanted.role || file.sha256 != wanted.digest || file.size != wanted.size ||
			validateManagedObject(file.object, joinPath(rootPath(state.plan.index, file.root), file.path), winfile.ObjectKindFile) != nil {
			return ErrInvalidEvidence
		}
		if _, duplicate := seen[key]; duplicate {
			return ErrInvalidEvidence
		}
		seen[key] = struct{}{}
		if portableExecutableRole(file.role) {
			if file.authenticode == nil || validateAuthenticodeEvidence(
				*file.authenticode,
				state.plan.control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256,
			) != nil {
				return ErrInvalidEvidence
			}
		} else if file.authenticode != nil {
			return ErrInvalidEvidence
		}
	}
	if len(seen) != len(expected) {
		return ErrInvalidEvidence
	}
	return nil
}

func validateManagedObject(object secureconfig.ObjectEvidence, expectedPath string, kind winfile.ObjectKind) error {
	canonical, err := secureconfig.NewObjectEvidenceForMode(expectedPath, winfile.SecurityModeManaged, object.Evidence)
	if err != nil || canonical.Evidence.Kind != kind || !reflect.DeepEqual(canonical, object) {
		return ErrInvalidEvidence
	}
	return nil
}

func stringLowerHex(value [sha256.Size]byte) string {
	const digits = "0123456789abcdef"
	result := make([]byte, sha256.Size*2)
	for index, item := range value {
		result[index*2] = digits[item>>4]
		result[index*2+1] = digits[item&0x0f]
	}
	return string(result)
}

func digestEvidenceState(state *evidenceState) [sha256.Size]byte {
	if state == nil {
		return [sha256.Size]byte{}
	}
	encoder := digestEncoder{hash: sha256.New()}
	encoder.bytes([]byte("AgenticReview installer destination evidence v1\x00"))
	encoder.bytes(state.plan.indexDocument)
	encoder.bytes(state.plan.envelopeDocument)
	encoder.bytes(state.plan.controlDocument)
	encoder.bytes(state.plan.executorDocument)
	encoder.text(state.plan.signerKeyID)
	for _, root := range state.roots {
		encoder.text(string(root.root))
		encoder.text(root.path)
		encoder.bytes(root.object.EvidenceSHA256[:])
		encoder.bytes(root.object.SecurityDescriptorSHA256[:])
	}
	for _, file := range state.files {
		encoder.text(string(file.root))
		encoder.text(file.path)
		encoder.text(string(file.role))
		encoder.text(file.sha256)
		encoder.u64(file.size)
		encoder.bytes(file.object.EvidenceSHA256[:])
		encoder.bytes(file.object.SecurityDescriptorSHA256[:])
		if file.authenticode != nil {
			document, err := json.Marshal(file.authenticode)
			if err != nil {
				return [sha256.Size]byte{}
			}
			encoder.bytes(document)
		} else {
			encoder.bytes(nil)
		}
	}
	var result [sha256.Size]byte
	copy(result[:], encoder.hash.Sum(nil))
	return result
}

type digestEncoder struct{ hash hash.Hash }

func (encoder digestEncoder) u64(value uint64) {
	var buffer [8]byte
	binary.LittleEndian.PutUint64(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder digestEncoder) bytes(value []byte) {
	encoder.u64(uint64(len(value)))
	_, _ = encoder.hash.Write(value)
}

func (encoder digestEncoder) text(value string) { encoder.bytes([]byte(value)) }

func cloneFileSnapshot(value FileSnapshot) FileSnapshot {
	value.object = cloneObjectEvidence(value.object)
	if value.authenticode != nil {
		copy := *value.authenticode
		value.authenticode = &copy
	}
	return value
}
