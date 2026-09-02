package stagedpackage

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicehostreceipt"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

// Validate rechecks every retained handle, directory enumeration, stream set, security
// descriptor, and immutable evidence binding. Success remains observation-only.
func (evidence StagedPackageEvidence) Validate() error {
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
	if validateEvidenceState(state) != nil || state.owner.recheck() != nil {
		return ErrInvalidEvidence
	}
	if err := operation.commit(func() {}); err != nil {
		return ErrCleanupFatal
	}
	return nil
}

// Close reinspects the retained closure and releases every owned handle. A native close that does
// not converge publishes a process-fatal cleanup state and retains the owner for process teardown.
func (evidence StagedPackageEvidence) Close() error {
	state := evidence.state
	if state == nil {
		return ErrInvalidEvidence
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed {
		return nil
	}
	var result error
	if state.owner == nil || state.owner.recheck() != nil {
		result = ErrInvalidEvidence
	}
	cleanupErr, unresolved := state.owner.close()
	state.closed = true
	if unresolved {
		publishCleanupFatal(state.owner)
		return ErrCleanupFatal
	}
	state.owner = nil
	if cleanupErr != nil {
		result = errors.Join(result, ErrCleanup)
	}
	return result
}

// Index returns detached signed index data only while the retained evidence remains valid.
func (evidence StagedPackageEvidence) Index() outerpackage.Index {
	if evidence.Validate() != nil {
		return outerpackage.Index{}
	}
	evidence.state.mu.Lock()
	defer evidence.state.mu.Unlock()
	if evidence.state.closed {
		return outerpackage.Index{}
	}
	return cloneIndex(evidence.state.index)
}

// ControlConfiguration returns a detached canonical bootstrap configuration.
func (evidence StagedPackageEvidence) ControlConfiguration() config.Config {
	if evidence.Validate() != nil {
		return config.Config{}
	}
	evidence.state.mu.Lock()
	defer evidence.state.mu.Unlock()
	if evidence.state.closed {
		return config.Config{}
	}
	return cloneConfig(evidence.state.control)
}

// ExecutorConfiguration returns a detached canonical bootstrap configuration.
func (evidence StagedPackageEvidence) ExecutorConfiguration() config.Config {
	if evidence.Validate() != nil {
		return config.Config{}
	}
	evidence.state.mu.Lock()
	defer evidence.state.mu.Unlock()
	if evidence.state.closed {
		return config.Config{}
	}
	return cloneConfig(evidence.state.executor)
}

// SignerKeyID returns the compiled outer signer SPKI SHA-256 used by admission.
func (evidence StagedPackageEvidence) SignerKeyID() string {
	if evidence.Validate() != nil {
		return ""
	}
	evidence.state.mu.Lock()
	defer evidence.state.mu.Unlock()
	if evidence.state.closed {
		return ""
	}
	return evidence.state.signerKeyID
}

// Roots returns detached audit snapshots for the three retained logical roots.
func (evidence StagedPackageEvidence) Roots() []RootSnapshot {
	if evidence.Validate() != nil {
		return nil
	}
	evidence.state.mu.Lock()
	defer evidence.state.mu.Unlock()
	if evidence.state.closed {
		return nil
	}
	return cloneRootSnapshots(evidence.state.roots)
}

// Files returns detached audit snapshots for every indexed payload, the index, and its envelope.
func (evidence StagedPackageEvidence) Files() []FileSnapshot {
	if evidence.Validate() != nil {
		return nil
	}
	evidence.state.mu.Lock()
	defer evidence.state.mu.Unlock()
	if evidence.state.closed {
		return nil
	}
	return cloneFileSnapshots(evidence.state.files)
}

// MarshalJSON refuses to turn retained staging evidence into a transferable authority token.
func (StagedPackageEvidence) MarshalJSON() ([]byte, error) { return nil, ErrSerialization }

func validateEvidenceState(state *evidenceState) error {
	if state == nil || state.issuer != successfulEvidenceIssuer || state.closed || state.owner == nil ||
		state.digest == ([sha256.Size]byte{}) ||
		!validSHA256(state.signerKeyID) {
		return ErrInvalidEvidence
	}
	if _, err := parseStagedRootPath(state.rootPath); err != nil {
		return ErrInvalidEvidence
	}
	indexDocument, err := outerpackage.MarshalIndexCanonical(state.index)
	if err != nil || len(indexDocument) == 0 {
		return ErrInvalidEvidence
	}
	envelope, err := outerpackage.ParseSignatureEnvelope(state.envelope)
	indexDigest := sha256.Sum256(indexDocument)
	if err != nil || envelope.SignerKeyID != state.signerKeyID ||
		envelope.IndexSHA256 != hex.EncodeToString(indexDigest[:]) {
		return ErrInvalidEvidence
	}
	controlDocument, err := config.MarshalCanonical(state.control)
	if err != nil || len(controlDocument) == 0 {
		return ErrInvalidEvidence
	}
	executorDocument, err := config.MarshalCanonical(state.executor)
	if err != nil || len(executorDocument) == 0 ||
		validateDocumentBindings(state.index, state.control, state.executor, state.documents) != nil {
		return ErrInvalidEvidence
	}
	if len(state.roots) != 3 || len(state.files) != len(state.index.Payloads)+2 {
		return ErrInvalidEvidence
	}
	for index, root := range []outerpackage.Root{
		outerpackage.RootMetadata,
		outerpackage.RootInstallation,
		outerpackage.RootTrustedConfiguration,
	} {
		snapshot := state.roots[index]
		if snapshot.root != root || snapshot.path != joinPath(state.rootPath, string(root)) ||
			validateManagedObject(snapshot.object, snapshot.path, winfile.ObjectKindDirectory) != nil {
			return ErrInvalidEvidence
		}
	}
	expected := make(map[string]outerpackage.Payload, len(state.index.Payloads))
	for _, payload := range state.index.Payloads {
		expected[packageFileKey(payload.Root, payload.Path)] = payload
	}
	seenIndex := false
	seenEnvelope := false
	for _, snapshot := range state.files {
		if validateManagedObject(
			snapshot.object,
			joinPath(joinPath(state.rootPath, string(snapshot.root)), snapshot.path),
			winfile.ObjectKindFile,
		) != nil || snapshot.sha256 == "" || snapshot.size == 0 {
			return ErrInvalidEvidence
		}
		payload, indexed := expected[packageFileKey(snapshot.root, snapshot.path)]
		if indexed {
			size, err := parseCanonicalSize(payload.Size)
			if err != nil || !snapshot.indexed || snapshot.role != payload.Role ||
				snapshot.sha256 != payload.SHA256 || snapshot.size != size ||
				(snapshot.authenticode != nil) != isPortableExecutableRole(payload.Role) {
				return ErrInvalidEvidence
			}
			if snapshot.authenticode != nil && validateAuthenticodeEvidence(
				*snapshot.authenticode,
				state.documents.Descriptor.AuthenticodeLeafSignerCertificateDERSHA256,
			) != nil {
				return ErrInvalidEvidence
			}
			delete(expected, packageFileKey(snapshot.root, snapshot.path))
			continue
		}
		if snapshot.indexed || snapshot.root != outerpackage.RootMetadata || snapshot.role != "" ||
			snapshot.authenticode != nil {
			return ErrInvalidEvidence
		}
		switch snapshot.path {
		case outerpackage.PackageIndexPath:
			digest := sha256.Sum256(indexDocument)
			if seenIndex || snapshot.sha256 != hex.EncodeToString(digest[:]) ||
				snapshot.size != uint64(len(indexDocument)) {
				return ErrInvalidEvidence
			}
			seenIndex = true
		case outerpackage.SignatureEnvelopePath:
			digest := sha256.Sum256(state.envelope)
			if seenEnvelope || snapshot.sha256 != hex.EncodeToString(digest[:]) ||
				snapshot.size != uint64(len(state.envelope)) {
				return ErrInvalidEvidence
			}
			seenEnvelope = true
		default:
			return ErrInvalidEvidence
		}
	}
	if len(expected) != 0 || !seenIndex || !seenEnvelope || digestEvidenceState(state) != state.digest {
		return ErrInvalidEvidence
	}
	return nil
}

func validateManagedObject(
	object secureconfig.ObjectEvidence,
	expectedPath string,
	expectedKind winfile.ObjectKind,
) error {
	canonical, err := secureconfig.NewObjectEvidenceForMode(
		expectedPath,
		winfile.SecurityModeManaged,
		object.Evidence,
	)
	if err != nil || canonical.Evidence.Kind != expectedKind || !reflect.DeepEqual(canonical, object) {
		return ErrInvalidEvidence
	}
	return nil
}

func digestEvidenceState(state *evidenceState) [sha256.Size]byte {
	if state == nil {
		return [sha256.Size]byte{}
	}
	index, err := outerpackage.MarshalIndexCanonical(state.index)
	if err != nil {
		return [sha256.Size]byte{}
	}
	control, err := config.MarshalCanonical(state.control)
	if err != nil {
		return [sha256.Size]byte{}
	}
	executor, err := config.MarshalCanonical(state.executor)
	if err != nil {
		return [sha256.Size]byte{}
	}
	descriptor, err := json.Marshal(state.documents.Descriptor)
	if err != nil {
		return [sha256.Size]byte{}
	}
	manifest, err := releasemanifest.MarshalCanonical(state.documents.Manifest)
	if err != nil {
		return [sha256.Size]byte{}
	}
	build, err := servicehostreceipt.MarshalCanonical(state.documents.ServiceHostBuild)
	if err != nil {
		return [sha256.Size]byte{}
	}
	encoder := evidenceEncoder{hash: sha256.New()}
	encoder.bytes([]byte("AgenticReview retained staged package evidence v1\x00"))
	encoder.text(state.rootPath)
	encoder.text(state.signerKeyID)
	encoder.bytes(index)
	encoder.bytes(state.envelope)
	encoder.bytes(control)
	encoder.bytes(executor)
	encoder.bytes(descriptor)
	encoder.bytes(manifest)
	encoder.bytes(build)
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
		encoder.boolean(file.indexed)
		encoder.bytes(file.object.EvidenceSHA256[:])
		encoder.bytes(file.object.SecurityDescriptorSHA256[:])
		if file.authenticode == nil {
			encoder.bytes(nil)
		} else {
			document, err := json.Marshal(file.authenticode)
			if err != nil {
				return [sha256.Size]byte{}
			}
			encoder.bytes(document)
		}
	}
	var result [sha256.Size]byte
	copy(result[:], encoder.hash.Sum(nil))
	return result
}

type evidenceEncoder struct {
	hash hash.Hash
}

func (encoder evidenceEncoder) u64(value uint64) {
	var buffer [8]byte
	binary.LittleEndian.PutUint64(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder evidenceEncoder) boolean(value bool) {
	if value {
		encoder.u64(1)
		return
	}
	encoder.u64(0)
}

func (encoder evidenceEncoder) text(value string) { encoder.bytes([]byte(value)) }

func (encoder evidenceEncoder) bytes(value []byte) {
	encoder.u64(uint64(len(value)))
	_, _ = encoder.hash.Write(value)
}

func cloneIndex(value outerpackage.Index) outerpackage.Index {
	document, err := outerpackage.MarshalIndexCanonical(value)
	if err != nil {
		return outerpackage.Index{}
	}
	cloned, err := outerpackage.ParseIndex(document)
	if err != nil {
		return outerpackage.Index{}
	}
	return cloned
}

func cloneConfig(value config.Config) config.Config {
	document, err := config.MarshalCanonical(value)
	if err != nil {
		return config.Config{}
	}
	cloned, err := config.Parse(document)
	if err != nil {
		return config.Config{}
	}
	return cloned
}

func cloneRootSnapshots(values []RootSnapshot) []RootSnapshot {
	result := make([]RootSnapshot, len(values))
	for index, value := range values {
		value.object = cloneObjectEvidence(value.object)
		result[index] = value
	}
	return result
}

func cloneFileSnapshots(values []FileSnapshot) []FileSnapshot {
	result := make([]FileSnapshot, len(values))
	for index, value := range values {
		result[index] = cloneFileSnapshot(value)
	}
	return result
}

func validSHA256(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == hex.EncodeToString(decoded)
}
