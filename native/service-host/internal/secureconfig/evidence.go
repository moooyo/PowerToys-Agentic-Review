package secureconfig

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	fileAttributeReparsePoint  uint32 = 0x00000400
	filePersistentACLs         uint32 = 0x00000008
	driveTypeFixed             uint32 = 3
	securityDACLPresent        uint16 = 0x0004
	securityDACLProtected      uint16 = 0x1000
	securityDescriptorRelative uint16 = 0x8000
)

type objectIdentity struct {
	volume uint64
	fileID [16]byte
}

func makeObjectEvidence(path string, evidence winfile.Evidence) ObjectEvidence {
	detached := cloneEvidence(evidence)
	return ObjectEvidence{
		Path:                     path,
		Evidence:                 detached,
		EvidenceSHA256:           digestObjectEvidence(path, detached),
		SecurityDescriptorSHA256: DigestSecurityDescriptor(detached.Security.SelfRelativeDescriptor),
	}
}

// NewObjectEvidence validates one detached winfile snapshot and applies the
// canonical secureconfig evidence digest. It does not prove where the snapshot
// came from; callers must retain their own opaque authorization provenance.
func NewObjectEvidence(path string, evidence winfile.Evidence) (ObjectEvidence, error) {
	if err := validateObjectEvidence(path, evidence.Kind, evidence, ^uint64(0)); err != nil {
		return ObjectEvidence{}, err
	}
	return makeObjectEvidence(path, evidence), nil
}

// DigestSecurityDescriptor returns the SHA-256 digest of a self-relative
// security descriptor byte sequence.
func DigestSecurityDescriptor(descriptor []byte) Digest {
	return Digest(sha256.Sum256(descriptor))
}

func validateObjectEvidence(path string, kind winfile.ObjectKind, evidence winfile.Evidence, maximumBytes uint64) error {
	if evidence.Kind != kind {
		return fmt.Errorf("%w: %s reports kind %s", ErrInvalidEvidence, path, evidence.Kind)
	}
	if evidence.Path.RequestedPath != path {
		return fmt.Errorf("%w: evidence path %q does not match %q", ErrInvalidEvidence, evidence.Path.RequestedPath, path)
	}
	if !evidence.Path.TerminalComponentReparseFree || evidence.Path.Ancestors != winfile.AncestorValidationNotPerformed {
		return fmt.Errorf("%w: %s lacks the expected terminal-only reparse proof", ErrInvalidEvidence, path)
	}
	if evidence.Attributes&fileAttributeReparsePoint != 0 {
		return fmt.Errorf("%w: %w: %s", ErrInvalidEvidence, winfile.ErrReparsePoint, path)
	}
	if kind == winfile.ObjectKindFile {
		if evidence.LinkCount != 1 {
			return fmt.Errorf("%w: %w: %s reports %d links", ErrInvalidEvidence, winfile.ErrHardLinkedFile, path, evidence.LinkCount)
		}
		if evidence.Size > maximumBytes {
			return fmt.Errorf("%w: %s reports %d bytes", winfile.ErrTooLarge, path, evidence.Size)
		}
	}
	if !strings.EqualFold(evidence.Volume.FileSystem, "NTFS") ||
		evidence.Volume.FileSystemFlags&filePersistentACLs == 0 ||
		!evidence.Volume.PersistentACLs || evidence.Volume.DriveType != driveTypeFixed {
		return fmt.Errorf("%w: %w: %s is not on a fixed NTFS volume with persistent ACLs", ErrInvalidEvidence, winfile.ErrUnsupportedVolume, path)
	}
	if !evidence.Volume.PathIdentityCrossCheck || evidence.Volume.HandleSerialNumber != evidence.Volume.PathSerialNumber {
		return fmt.Errorf("%w: %w: %s lacks a successful path-to-handle volume check", ErrInvalidEvidence, winfile.ErrVolumeIdentityMismatch, path)
	}
	if evidence.Volume.RequiredUse != winfile.VolumeUseReadOnly {
		return fmt.Errorf("%w: %s was not inspected for read-only use", ErrInvalidEvidence, path)
	}
	security := evidence.Security
	requiredControl := securityDACLPresent | securityDACLProtected | securityDescriptorRelative
	if security.OwnerSID == "" || security.GroupSID == "" || !security.DACLPresent || security.DACLNull ||
		!security.DACLProtected || security.Control&requiredControl != requiredControl ||
		len(security.SelfRelativeDescriptor) == 0 {
		return fmt.Errorf("%w: %w: %s has incomplete security descriptor evidence", ErrInvalidEvidence, winfile.ErrUnsafeSecurityDescriptor, path)
	}
	return nil
}

func compareVolumeEvidence(baseline ObjectEvidence, current ObjectEvidence) error {
	left := baseline.Evidence
	right := current.Evidence
	if left.Identity.VolumeSerialNumber != right.Identity.VolumeSerialNumber ||
		!strings.EqualFold(left.Volume.FileSystem, right.Volume.FileSystem) ||
		left.Volume.FileSystemFlags != right.Volume.FileSystemFlags ||
		left.Volume.HandleSerialNumber != right.Volume.HandleSerialNumber ||
		left.Volume.PathSerialNumber != right.Volume.PathSerialNumber ||
		left.Volume.DriveType != right.Volume.DriveType ||
		left.Volume.PersistentACLs != right.Volume.PersistentACLs ||
		left.Volume.ReadOnly != right.Volume.ReadOnly {
		return fmt.Errorf(
			"%w: %w: %s differs from volume-root evidence",
			ErrVolumeChanged,
			winfile.ErrVolumeIdentityMismatch,
			current.Path,
		)
	}
	return nil
}

func compareSecurityEvidence(
	path string,
	baseline winfile.SecurityDescriptorEvidence,
	current winfile.SecurityDescriptorEvidence,
) error {
	baselineBytes := baseline.SelfRelativeDescriptor
	currentBytes := current.SelfRelativeDescriptor
	if baseline.OwnerSID != current.OwnerSID ||
		baseline.GroupSID != current.GroupSID ||
		baseline.OwnerDefaulted != current.OwnerDefaulted ||
		baseline.GroupDefaulted != current.GroupDefaulted ||
		baseline.DACLPresent != current.DACLPresent ||
		baseline.DACLNull != current.DACLNull ||
		baseline.DACLDefaulted != current.DACLDefaulted ||
		baseline.DACLProtected != current.DACLProtected ||
		baseline.Control != current.Control ||
		baseline.Revision != current.Revision ||
		!bytes.Equal(baselineBytes, currentBytes) {
		return fmt.Errorf("%w: %s", ErrSecurityChanged, path)
	}
	return nil
}

func registerIdentity(seen map[objectIdentity]string, object ObjectEvidence) error {
	identity := objectIdentity{
		volume: object.Evidence.Identity.VolumeSerialNumber,
		fileID: object.Evidence.Identity.FileID,
	}
	if previous, exists := seen[identity]; exists {
		return fmt.Errorf(
			"%w: %w: %s and %s identify the same object",
			ErrDuplicateIdentity,
			winfile.ErrIdentityChanged,
			previous,
			object.Path,
		)
	}
	seen[identity] = object.Path
	return nil
}

func cloneEvidence(value winfile.Evidence) winfile.Evidence {
	value.Security.SelfRelativeDescriptor = append(
		[]byte(nil),
		value.Security.SelfRelativeDescriptor...,
	)
	return value
}

func cloneObjectEvidence(value ObjectEvidence) ObjectEvidence {
	value.Evidence = cloneEvidence(value.Evidence)
	return value
}

func digestObjectEvidence(path string, evidence winfile.Evidence) Digest {
	encoder := evidenceDigestEncoder{hash: sha256.New()}
	encoder.bytes([]byte("secureconfig-object-evidence-v1"))
	encoder.text(path)
	encoder.u8(uint8(evidence.Kind))
	encoder.u64(evidence.Identity.VolumeSerialNumber)
	encoder.bytes(evidence.Identity.FileID[:])
	encoder.u32(evidence.Attributes)
	encoder.u64(evidence.Size)
	encoder.u32(evidence.LinkCount)
	encoder.boolean(evidence.Path.TerminalComponentReparseFree)
	encoder.u8(uint8(evidence.Path.Ancestors))
	encoder.text(evidence.Volume.FileSystem)
	encoder.u32(evidence.Volume.FileSystemFlags)
	encoder.u32(evidence.Volume.HandleSerialNumber)
	encoder.u32(evidence.Volume.PathSerialNumber)
	encoder.u32(evidence.Volume.DriveType)
	encoder.boolean(evidence.Volume.PersistentACLs)
	encoder.boolean(evidence.Volume.ReadOnly)
	encoder.u8(uint8(evidence.Volume.RequiredUse))
	encoder.boolean(evidence.Volume.PathIdentityCrossCheck)
	encoder.text(evidence.Security.OwnerSID)
	encoder.text(evidence.Security.GroupSID)
	encoder.boolean(evidence.Security.OwnerDefaulted)
	encoder.boolean(evidence.Security.GroupDefaulted)
	encoder.boolean(evidence.Security.DACLPresent)
	encoder.boolean(evidence.Security.DACLNull)
	encoder.boolean(evidence.Security.DACLDefaulted)
	encoder.boolean(evidence.Security.DACLProtected)
	encoder.u16(evidence.Security.Control)
	encoder.u32(evidence.Security.Revision)
	encoder.bytes(evidence.Security.SelfRelativeDescriptor)
	var digest Digest
	copy(digest[:], encoder.hash.Sum(nil))
	return digest
}

type evidenceDigestEncoder struct {
	hash hash.Hash
}

func (encoder evidenceDigestEncoder) u8(value uint8) {
	_, _ = encoder.hash.Write([]byte{value})
}

func (encoder evidenceDigestEncoder) u16(value uint16) {
	var buffer [2]byte
	binary.LittleEndian.PutUint16(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder evidenceDigestEncoder) u32(value uint32) {
	var buffer [4]byte
	binary.LittleEndian.PutUint32(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder evidenceDigestEncoder) u64(value uint64) {
	var buffer [8]byte
	binary.LittleEndian.PutUint64(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder evidenceDigestEncoder) boolean(value bool) {
	if value {
		encoder.u8(1)
		return
	}
	encoder.u8(0)
}

func (encoder evidenceDigestEncoder) text(value string) {
	encoder.bytes([]byte(value))
}

func (encoder evidenceDigestEncoder) bytes(value []byte) {
	encoder.u64(uint64(len(value)))
	_, _ = encoder.hash.Write(value)
}
