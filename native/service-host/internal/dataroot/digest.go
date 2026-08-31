package dataroot

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func digestEvidenceState(state *evidenceState) ([32]byte, error) {
	currentDocument, err := config.MarshalCanonical(state.current)
	if err != nil {
		return [32]byte{}, fmt.Errorf("canonicalize current configuration: %w", err)
	}
	peerDocument, err := config.MarshalCanonical(state.peer)
	if err != nil {
		return [32]byte{}, fmt.Errorf("canonicalize peer configuration: %w", err)
	}
	encoder := digestEncoder{hash: sha256.New()}
	encoder.text("agentic-review/data-root-evidence/v2")
	encoder.text(string(state.role))
	encoder.bytes(currentDocument)
	encoder.bytes(peerDocument)
	encoder.text(string(state.peerObservation))
	encodeObject(&encoder, state.root.object)
	encoder.u64(uint64(len(state.root.ancestors)))
	for _, ancestor := range state.root.ancestors {
		encodeObject(&encoder, ancestor)
	}
	encoder.u64(uint64(len(state.paths)))
	for _, path := range state.paths {
		encoder.text(string(path.purpose))
		encoder.text(string(path.class))
		encoder.text(path.path)
		encoder.text(path.relative)
		encoder.u8(uint8(path.kind))
		encodeObject(&encoder, path.object)
	}
	encoder.u64(uint64(len(state.objects)))
	for _, object := range state.objects {
		encodeObject(&encoder, object)
	}
	encoder.u64(uint64(len(state.installation)))
	for _, root := range state.installation {
		encoder.text(string(root.root))
		encoder.text(root.path)
		encoder.identity(root.target.VolumeSerialNumber, root.target.FileID)
		encoder.u64(uint64(len(root.ancestors)))
		if len(root.ancestorPaths) != len(root.ancestors) {
			return [32]byte{}, fmt.Errorf("installation root %s has inconsistent ancestor evidence", root.root)
		}
		for index, identity := range root.ancestors {
			encoder.text(root.ancestorPaths[index])
			encoder.identity(identity.VolumeSerialNumber, identity.FileID)
		}
	}
	var result [32]byte
	copy(result[:], encoder.hash.Sum(nil))
	return result, nil
}

func encodeObject(encoder *digestEncoder, object ObjectSnapshot) {
	encoder.text(object.path)
	encoder.identity(
		object.evidence.Identity.VolumeSerialNumber,
		object.evidence.Identity.FileID,
	)
	encoder.bytes(object.evidenceSHA256[:])
	encoder.bytes(object.securityDescriptorSHA256[:])
}

func digestObjectSnapshot(path string, evidence winfile.Evidence) [32]byte {
	encoder := digestEncoder{hash: sha256.New()}
	encoder.text("agentic-review/data-root-object-evidence/v1")
	encoder.text(path)
	encoder.u8(uint8(evidence.Kind))
	encoder.u8(uint8(evidence.SecurityMode))
	encoder.identity(evidence.Identity.VolumeSerialNumber, evidence.Identity.FileID)
	encoder.u32(evidence.Attributes)
	encoder.u64(evidence.Size)
	encoder.u32(evidence.LinkCount)
	encoder.text(evidence.Path.RequestedPath)
	encoder.boolean(evidence.Path.TerminalComponentReparseFree)
	encoder.u8(uint8(evidence.Path.Ancestors))
	encoder.text(evidence.Path.FinalPathDiagnostic)
	encoder.text(evidence.Path.FinalPathDiagnosticError)
	encoder.text(evidence.Volume.FileSystem)
	encoder.u32(evidence.Volume.FileSystemFlags)
	encoder.u32(evidence.Volume.HandleSerialNumber)
	encoder.u32(evidence.Volume.PathSerialNumber)
	encoder.text(evidence.Volume.VolumePath)
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
	var result [32]byte
	copy(result[:], encoder.hash.Sum(nil))
	return result
}

type digestEncoder struct {
	hash hash.Hash
}

func (encoder *digestEncoder) u8(value uint8) {
	_, _ = encoder.hash.Write([]byte{value})
}

func (encoder *digestEncoder) u16(value uint16) {
	var buffer [2]byte
	binary.LittleEndian.PutUint16(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder *digestEncoder) u32(value uint32) {
	var buffer [4]byte
	binary.LittleEndian.PutUint32(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder *digestEncoder) u64(value uint64) {
	var buffer [8]byte
	binary.LittleEndian.PutUint64(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder *digestEncoder) bytes(value []byte) {
	encoder.u64(uint64(len(value)))
	_, _ = encoder.hash.Write(value)
}

func (encoder *digestEncoder) text(value string) {
	encoder.bytes([]byte(value))
}

func (encoder *digestEncoder) boolean(value bool) {
	if value {
		encoder.u8(1)
		return
	}
	encoder.u8(0)
}

func (encoder *digestEncoder) identity(volume uint64, fileID [16]byte) {
	encoder.u64(volume)
	encoder.bytes(fileID[:])
}
