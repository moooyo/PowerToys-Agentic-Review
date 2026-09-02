// Package peimage validates the bounded PE32+ shape used by ServiceHost release artifacts.
package peimage

import (
	"crypto/sha256"
	"debug/pe"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sort"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

const (
	pe32PlusChecksumOffset           = uint64(64)
	pe32PlusDataDirectoryOffset      = uint64(112)
	securityDataDirectoryIndex       = uint64(4)
	imageDataDirectoryBytes          = uint64(8)
	minimumWinCertificateBytes       = uint64(8)
	winCertificateRevision20         = uint16(0x0200)
	winCertificateTypePKCSSignedData = uint16(0x0002)
)

type fileRange struct {
	start uint64
	end   uint64
}

// ValidateServiceHost requires a bounded executable PE32+ image for the selected architecture.
func ValidateServiceHost(reader io.ReaderAt, size int64, architecture string) error {
	if reader == nil || size <= 0 || uint64(size) > releaseprofile.MaximumServiceHostBytes {
		return errors.New("PE image size is outside the supported range")
	}
	total := uint64(size)
	bounded := io.NewSectionReader(reader, 0, size)
	var dosHeader [64]byte
	if _, err := bounded.ReadAt(dosHeader[:], 0); err != nil {
		return fmt.Errorf("read DOS header: %w", err)
	}
	if dosHeader[0] != 'M' || dosHeader[1] != 'Z' {
		return errors.New("PE image omits the DOS signature")
	}
	peOffset := uint64(binary.LittleEndian.Uint32(dosHeader[0x3c:]))
	if peOffset < uint64(len(dosHeader)) || !checkedFileRange(peOffset, 4+20, total) {
		return errors.New("PE signature or COFF header is outside the image")
	}
	var signature [4]byte
	if _, err := bounded.ReadAt(signature[:], int64(peOffset)); err != nil || signature != [4]byte{'P', 'E', 0, 0} {
		return errors.New("PE image has an invalid PE signature")
	}
	var coffHeader [20]byte
	if _, err := bounded.ReadAt(coffHeader[:], int64(peOffset+4)); err != nil {
		return fmt.Errorf("read COFF header: %w", err)
	}
	machine := binary.LittleEndian.Uint16(coffHeader[0:2])
	sectionCount := binary.LittleEndian.Uint16(coffHeader[2:4])
	optionalHeaderSize := binary.LittleEndian.Uint16(coffHeader[16:18])
	characteristics := binary.LittleEndian.Uint16(coffHeader[18:20])
	expectedMachine, err := ExpectedMachine(architecture)
	if err != nil {
		return err
	}
	if machine != expectedMachine {
		return fmt.Errorf("PE machine %#x does not match %s", machine, architecture)
	}
	if characteristics&0x0002 == 0 {
		return errors.New("PE image does not have the executable-image characteristic")
	}
	if sectionCount == 0 || optionalHeaderSize < 112 {
		return errors.New("PE image has no sections or an undersized PE32+ optional header")
	}
	optionalHeaderOffset := peOffset + 4 + 20
	sectionTableOffset := optionalHeaderOffset + uint64(optionalHeaderSize)
	sectionTableBytes := uint64(sectionCount) * 40
	if !checkedFileRange(optionalHeaderOffset, uint64(optionalHeaderSize), total) ||
		!checkedFileRange(sectionTableOffset, sectionTableBytes, total) {
		return errors.New("PE optional header or section table is outside the image")
	}
	image, err := pe.NewFile(bounded)
	if err != nil {
		return fmt.Errorf("parse PE image: %w", err)
	}
	defer image.Close()
	optionalHeader, ok := image.OptionalHeader.(*pe.OptionalHeader64)
	if !ok || optionalHeader == nil || optionalHeader.Magic != 0x20b {
		return errors.New("PE image is not PE32+")
	}
	minimumSecurityDirectoryBytes := pe32PlusDataDirectoryOffset +
		(securityDataDirectoryIndex+1)*imageDataDirectoryBytes
	if uint64(optionalHeaderSize) < minimumSecurityDirectoryBytes ||
		optionalHeader.NumberOfRvaAndSizes <= uint32(securityDataDirectoryIndex) {
		return errors.New("PE32+ optional header omits the certificate-table directory")
	}
	if image.Machine != expectedMachine || image.NumberOfSections != sectionCount ||
		image.SizeOfOptionalHeader != optionalHeaderSize || image.Characteristics != characteristics {
		return errors.New("parsed PE header differs from the retained header bytes")
	}
	sectionTableEnd := sectionTableOffset + sectionTableBytes
	if uint64(optionalHeader.SizeOfHeaders) < sectionTableEnd || uint64(optionalHeader.SizeOfHeaders) > total {
		return errors.New("PE SizeOfHeaders does not bound the retained headers")
	}
	if len(image.Sections) != int(sectionCount) {
		return errors.New("parsed PE section count is inconsistent")
	}
	rawRanges := make([]fileRange, 0, len(image.Sections))
	for _, section := range image.Sections {
		if section == nil {
			return errors.New("PE image contains a nil section")
		}
		offset := uint64(section.Offset)
		length := uint64(section.Size)
		if length == 0 {
			if offset > total {
				return fmt.Errorf("PE section %q has an out-of-range empty offset", section.Name)
			}
		} else {
			if offset < uint64(optionalHeader.SizeOfHeaders) || !checkedFileRange(offset, length, total) {
				return fmt.Errorf("PE section %q raw data is outside the image", section.Name)
			}
			rawRanges = append(rawRanges, fileRange{start: offset, end: offset + length})
		}
		if !checkedFileRange(
			uint64(section.PointerToRelocations),
			uint64(section.NumberOfRelocations)*10,
			total,
		) || !checkedFileRange(
			uint64(section.PointerToLineNumbers),
			uint64(section.NumberOfLineNumbers)*6,
			total,
		) {
			return fmt.Errorf("PE section %q relocation or line table is outside the image", section.Name)
		}
	}
	sort.Slice(rawRanges, func(left, right int) bool {
		return rawRanges[left].start < rawRanges[right].start
	})
	for index := 1; index < len(rawRanges); index++ {
		if rawRanges[index].start < rawRanges[index-1].end {
			return errors.New("PE raw sections overlap")
		}
	}
	return nil
}

// ExpectedMachine returns the only COFF machine values accepted by the release profile.
func ExpectedMachine(architecture string) (uint16, error) {
	switch architecture {
	case "amd64":
		return pe.IMAGE_FILE_MACHINE_AMD64, nil
	case "arm64":
		return pe.IMAGE_FILE_MACHINE_ARM64, nil
	default:
		return 0, fmt.Errorf("unsupported PE architecture %q", architecture)
	}
}

// SigningInvariantSHA256 hashes every byte that must remain stable across Authenticode signing.
// It normalizes the PE checksum and certificate-table directory to zero and excludes the single
// terminal WIN_CERTIFICATE table. The boolean reports whether that table is present.
func SigningInvariantSHA256(
	reader io.ReaderAt,
	size int64,
	architecture string,
) ([sha256.Size]byte, bool, error) {
	var zero [sha256.Size]byte
	if err := ValidateServiceHost(reader, size, architecture); err != nil {
		return zero, false, err
	}
	bounded := io.NewSectionReader(reader, 0, size)
	var dosHeader [64]byte
	if _, err := bounded.ReadAt(dosHeader[:], 0); err != nil {
		return zero, false, fmt.Errorf("read DOS header for signing invariant: %w", err)
	}
	peOffset := uint64(binary.LittleEndian.Uint32(dosHeader[0x3c:]))
	optionalHeaderOffset := peOffset + 4 + 20
	checksumOffset := optionalHeaderOffset + pe32PlusChecksumOffset
	securityDirectoryOffset := optionalHeaderOffset + pe32PlusDataDirectoryOffset +
		securityDataDirectoryIndex*imageDataDirectoryBytes
	if !checkedFileRange(checksumOffset, 4, uint64(size)) ||
		!checkedFileRange(securityDirectoryOffset, imageDataDirectoryBytes, uint64(size)) ||
		checksumOffset+4 > securityDirectoryOffset {
		return zero, false, errors.New("PE signing-invariant fields are outside the image")
	}
	var directory [imageDataDirectoryBytes]byte
	if _, err := bounded.ReadAt(directory[:], int64(securityDirectoryOffset)); err != nil {
		return zero, false, fmt.Errorf("read PE certificate-table directory: %w", err)
	}
	certificateOffset := uint64(binary.LittleEndian.Uint32(directory[0:4]))
	certificateSize := uint64(binary.LittleEndian.Uint32(directory[4:8]))
	image, err := pe.NewFile(bounded)
	if err != nil {
		return zero, false, fmt.Errorf("parse PE image for signing invariant: %w", err)
	}
	defer image.Close()
	optionalHeader, ok := image.OptionalHeader.(*pe.OptionalHeader64)
	if !ok || optionalHeader == nil ||
		uint64(optionalHeader.DataDirectory[securityDataDirectoryIndex].VirtualAddress) != certificateOffset ||
		uint64(optionalHeader.DataDirectory[securityDataDirectoryIndex].Size) != certificateSize {
		return zero, false, errors.New("parsed PE certificate-table directory differs from retained bytes")
	}
	physicalImageEnd := uint64(optionalHeader.SizeOfHeaders)
	for _, section := range image.Sections {
		if section == nil {
			return zero, false, errors.New("parsed PE contains a nil section")
		}
		sectionEnd := uint64(section.Offset) + uint64(section.Size)
		if sectionEnd > physicalImageEnd {
			physicalImageEnd = sectionEnd
		}
	}
	present := certificateOffset != 0 || certificateSize != 0
	contentEnd := uint64(size)
	if present {
		if certificateOffset == 0 || certificateSize < minimumWinCertificateBytes ||
			certificateOffset%8 != 0 || !checkedFileRange(certificateOffset, certificateSize, uint64(size)) ||
			certificateOffset+certificateSize != uint64(size) || certificateOffset < securityDirectoryOffset+imageDataDirectoryBytes {
			return zero, false, errors.New("PE certificate table is not one bounded terminal table")
		}
		var header [minimumWinCertificateBytes]byte
		if _, err := bounded.ReadAt(header[:], int64(certificateOffset)); err != nil {
			return zero, false, fmt.Errorf("read WIN_CERTIFICATE header: %w", err)
		}
		certificateLength := uint64(binary.LittleEndian.Uint32(header[0:4]))
		alignedLength, ok := alignToEight(certificateLength)
		if !ok || certificateLength < minimumWinCertificateBytes || alignedLength != certificateSize ||
			binary.LittleEndian.Uint16(header[4:6]) != winCertificateRevision20 ||
			binary.LittleEndian.Uint16(header[6:8]) != winCertificateTypePKCSSignedData {
			return zero, false, errors.New("PE WIN_CERTIFICATE header is invalid or ambiguous")
		}
		padding := make([]byte, certificateSize-certificateLength)
		if len(padding) != 0 {
			if _, err := bounded.ReadAt(padding, int64(certificateOffset+certificateLength)); err != nil {
				return zero, false, fmt.Errorf("read WIN_CERTIFICATE alignment padding: %w", err)
			}
			for _, value := range padding {
				if value != 0 {
					return zero, false, errors.New("PE WIN_CERTIFICATE alignment padding is nonzero")
				}
			}
		}
		if certificateOffset != physicalImageEnd {
			return zero, false, errors.New("PE image contains an overlay before its certificate table")
		}
		contentEnd = certificateOffset
	} else if physicalImageEnd != uint64(size) {
		return zero, false, errors.New("unsigned PE image contains an overlay")
	}

	digest := sha256.New()
	if err := hashRange(digest, bounded, 0, checksumOffset); err != nil {
		return zero, false, err
	}
	_, _ = digest.Write(make([]byte, 4))
	if err := hashRange(digest, bounded, checksumOffset+4, securityDirectoryOffset); err != nil {
		return zero, false, err
	}
	_, _ = digest.Write(make([]byte, imageDataDirectoryBytes))
	if err := hashRange(digest, bounded, securityDirectoryOffset+imageDataDirectoryBytes, contentEnd); err != nil {
		return zero, false, err
	}
	copy(zero[:], digest.Sum(nil))
	return zero, present, nil
}

func hashRange(destination io.Writer, source io.ReaderAt, start, end uint64) error {
	if end < start || end-start > uint64(^uint64(0)>>1) {
		return errors.New("PE signing-invariant range is invalid")
	}
	length := int64(end - start)
	written, err := io.CopyN(destination, io.NewSectionReader(source, int64(start), length), length)
	if err != nil || written != length {
		return fmt.Errorf("hash PE signing-invariant range: read %d of %d bytes: %w", written, length, err)
	}
	return nil
}

func alignToEight(value uint64) (uint64, bool) {
	if value > ^uint64(0)-7 {
		return 0, false
	}
	return (value + 7) &^ 7, true
}

func checkedFileRange(offset, length, total uint64) bool {
	return offset <= total && length <= total-offset
}
