//go:build windows

package winfile

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	extendedDirectoryEntryHeaderBytes = 88
	streamInformationHeaderBytes      = 24
	directoryInformationBufferBytes   = 64 * 1024
	initialStreamInformationBytes     = 1024
	maximumStreamInformationBytes     = 64 * 1024
)

type objectAuxiliarySnapshot struct {
	streams                []DataStream
	caseSensitiveDirectory bool
}

func (directory *Directory) Enumerate(options DirectoryEnumerationOptions) (DirectoryEnumeration, error) {
	if directory == nil {
		return DirectoryEnumeration{}, ErrClosed
	}
	builder, err := newDirectoryEnumerationBuilder(options)
	if err != nil {
		return DirectoryEnumeration{}, err
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.closed || directory.handle == 0 {
		return DirectoryEnumeration{}, ErrClosed
	}
	if !directory.enumerationAllowed {
		return DirectoryEnumeration{}, fmt.Errorf("%w: directory was not opened with enumeration access", ErrInvalidOptions)
	}
	volumeSerial := directory.evidence.Identity.VolumeSerialNumber
	if err := enumerateDirectoryHandle(directory.handle, builder, volumeSerial); err != nil {
		return DirectoryEnumeration{}, err
	}
	return builder.finish(), nil
}

func enumerateDirectoryHandle(
	handle windows.Handle,
	builder *directoryEnumerationBuilder,
	volumeSerial uint64,
) error {
	restart := true
	for calls := uint32(0); ; calls++ {
		if calls > builder.options.MaximumEntries+1 {
			return fmt.Errorf("%w: directory scan did not terminate within the entry budget", ErrDirectoryBudget)
		}
		buffer := make([]byte, directoryInformationBufferBytes)
		informationClass := uint32(windows.FileIdExtdDirectoryInfo)
		if restart {
			informationClass = uint32(windows.FileIdExtdDirectoryRestartInfo)
		}
		err := windows.GetFileInformationByHandleEx(
			handle,
			informationClass,
			&buffer[0],
			uint32(len(buffer)),
		)
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%w: GetFileInformationByHandleEx(FileIdExtdDirectoryInfo): %w", ErrDirectoryEnumeration, err)
		}
		restart = false
		if err := parseExtendedDirectoryInformation(buffer, func(raw rawDirectoryEntry) error {
			raw.entry.Identity.VolumeSerialNumber = volumeSerial
			return builder.add(raw)
		}); err != nil {
			return err
		}
	}
}

func parseExtendedDirectoryInformation(buffer []byte, visit func(rawDirectoryEntry) error) error {
	if len(buffer) < extendedDirectoryEntryHeaderBytes || visit == nil {
		return fmt.Errorf("%w: directory information buffer is incomplete", ErrDirectoryEnumeration)
	}
	for offset := 0; ; {
		if offset > len(buffer)-extendedDirectoryEntryHeaderBytes {
			return fmt.Errorf("%w: directory entry header exceeds its buffer", ErrDirectoryEnumeration)
		}
		record := buffer[offset:]
		nextOffset := binary.LittleEndian.Uint32(record[0:4])
		endOfFile := int64(binary.LittleEndian.Uint64(record[40:48]))
		attributes := binary.LittleEndian.Uint32(record[56:60])
		nameBytes := binary.LittleEndian.Uint32(record[60:64])
		if endOfFile < 0 || nameBytes == 0 || nameBytes%2 != 0 {
			return fmt.Errorf("%w: directory entry contains invalid size metadata", ErrDirectoryEnumeration)
		}
		nameEnd := uint64(extendedDirectoryEntryHeaderBytes) + uint64(nameBytes)
		if nameEnd > uint64(len(record)) {
			return fmt.Errorf("%w: directory entry name exceeds its buffer", ErrDirectoryEnumeration)
		}
		if nextOffset != 0 {
			minimumOffset := alignToEight(uint32(nameEnd))
			if nextOffset < minimumOffset || nextOffset%8 != 0 || uint64(nextOffset) > uint64(len(record)) {
				return fmt.Errorf("%w: directory entry offset is invalid", ErrDirectoryEnumeration)
			}
		}
		name, err := decodeNativeUTF16(record[extendedDirectoryEntryHeaderBytes:nameEnd])
		if err != nil {
			return fmt.Errorf("%w: decode directory entry name: %w", ErrDirectoryEnumeration, err)
		}
		kind := ObjectKindFile
		if attributes&fileAttributeDirectory != 0 {
			kind = ObjectKindDirectory
		}
		entry := rawDirectoryEntry{
			entry: DirectoryEntry{
				Name:       name,
				Kind:       kind,
				Attributes: attributes,
				Size:       uint64(endOfFile),
			},
			nameUnits: nameBytes / 2,
		}
		copy(entry.entry.Identity.FileID[:], record[72:88])
		if err := visit(entry); err != nil {
			return err
		}
		if nextOffset == 0 {
			return nil
		}
		offset += int(nextOffset)
	}
}

func queryObjectAuxiliarySnapshot(
	handle windows.Handle,
	kind ObjectKind,
	objectSize uint64,
) (objectAuxiliarySnapshot, error) {
	streams, err := queryDataStreams(handle, kind, objectSize)
	if err != nil {
		return objectAuxiliarySnapshot{}, err
	}
	result := objectAuxiliarySnapshot{streams: streams}
	if kind == ObjectKindDirectory {
		caseSensitive, err := queryCaseSensitiveDirectory(handle)
		if err != nil {
			return objectAuxiliarySnapshot{}, err
		}
		result.caseSensitiveDirectory = caseSensitive
	}
	return result, nil
}

func queryDataStreams(handle windows.Handle, kind ObjectKind, objectSize uint64) ([]DataStream, error) {
	for size := initialStreamInformationBytes; size <= maximumStreamInformationBytes; size *= 2 {
		buffer := make([]byte, size)
		err := windows.GetFileInformationByHandleEx(
			handle,
			windows.FileStreamInfo,
			&buffer[0],
			uint32(len(buffer)),
		)
		if errors.Is(err, windows.ERROR_HANDLE_EOF) || errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			if err := validateDataStreams(kind, objectSize, nil); err != nil {
				return nil, err
			}
			return nil, nil
		}
		if errors.Is(err, windows.ERROR_MORE_DATA) || errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			if size > maximumStreamInformationBytes/2 {
				break
			}
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("%w: GetFileInformationByHandleEx(FileStreamInfo): %w", ErrStreamEnumeration, err)
		}
		streams, err := parseStreamInformation(buffer)
		if err != nil {
			return nil, err
		}
		if err := validateDataStreams(kind, objectSize, streams); err != nil {
			return nil, err
		}
		sort.Slice(streams, func(left int, right int) bool {
			return streams[left].Name < streams[right].Name
		})
		return streams, nil
	}
	return nil, fmt.Errorf("%w: stream information exceeds %d bytes", ErrStreamEnumeration, maximumStreamInformationBytes)
}

func parseStreamInformation(buffer []byte) ([]DataStream, error) {
	if len(buffer) < streamInformationHeaderBytes {
		return nil, fmt.Errorf("%w: stream information buffer is incomplete", ErrStreamEnumeration)
	}
	if zeroNativeRecord(buffer[:streamInformationHeaderBytes]) {
		return nil, nil
	}
	streams := make([]DataStream, 0, 1)
	for offset := 0; ; {
		if offset > len(buffer)-streamInformationHeaderBytes {
			return nil, fmt.Errorf("%w: stream header exceeds its buffer", ErrStreamEnumeration)
		}
		record := buffer[offset:]
		nextOffset := binary.LittleEndian.Uint32(record[0:4])
		nameBytes := binary.LittleEndian.Uint32(record[4:8])
		streamSize := int64(binary.LittleEndian.Uint64(record[8:16]))
		allocationSize := int64(binary.LittleEndian.Uint64(record[16:24]))
		if nameBytes == 0 || nameBytes%2 != 0 || streamSize < 0 || allocationSize < 0 {
			return nil, fmt.Errorf("%w: stream entry contains invalid metadata", ErrStreamEnumeration)
		}
		nameEnd := uint64(streamInformationHeaderBytes) + uint64(nameBytes)
		if nameEnd > uint64(len(record)) {
			return nil, fmt.Errorf("%w: stream name exceeds its buffer", ErrStreamEnumeration)
		}
		if nextOffset != 0 {
			minimumOffset := alignToEight(uint32(nameEnd))
			if nextOffset < minimumOffset || nextOffset%8 != 0 || uint64(nextOffset) > uint64(len(record)) {
				return nil, fmt.Errorf("%w: stream entry offset is invalid", ErrStreamEnumeration)
			}
		}
		name, err := decodeNativeUTF16(record[streamInformationHeaderBytes:nameEnd])
		if err != nil {
			return nil, fmt.Errorf("%w: decode stream name: %w", ErrStreamEnumeration, err)
		}
		streams = append(streams, DataStream{
			Name:           name,
			Size:           uint64(streamSize),
			AllocationSize: uint64(allocationSize),
		})
		if nextOffset == 0 {
			return streams, nil
		}
		offset += int(nextOffset)
	}
}

func queryCaseSensitiveDirectory(handle windows.Handle) (bool, error) {
	var flags uint32
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileCaseSensitiveInfo,
		(*byte)(unsafe.Pointer(&flags)),
		uint32(unsafe.Sizeof(flags)),
	); err != nil {
		return false, fmt.Errorf("query FileCaseSensitiveInfo: %w", err)
	}
	if err := validateCaseSensitiveDirectoryFlags(flags); err != nil {
		return false, err
	}
	return flags&caseSensitiveDirectoryBit != 0, nil
}

func compareObjectAuxiliarySnapshots(before, after objectAuxiliarySnapshot) error {
	if before.caseSensitiveDirectory != after.caseSensitiveDirectory {
		return ErrObjectChanged
	}
	return compareDataStreams(before.streams, after.streams)
}

func cloneDataStreams(streams []DataStream) []DataStream {
	return append([]DataStream(nil), streams...)
}

func decodeNativeUTF16(encoded []byte) (string, error) {
	if len(encoded) == 0 || len(encoded)%2 != 0 {
		return "", errors.New("UTF-16 byte sequence is empty or odd-sized")
	}
	units := make([]uint16, len(encoded)/2)
	for index := range units {
		units[index] = binary.LittleEndian.Uint16(encoded[index*2 : index*2+2])
	}
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if unit == 0 {
			return "", errors.New("UTF-16 byte sequence contains NUL")
		}
		if unit >= 0xd800 && unit <= 0xdbff {
			if index+1 >= len(units) || units[index+1] < 0xdc00 || units[index+1] > 0xdfff {
				return "", errors.New("UTF-16 byte sequence contains an unpaired high surrogate")
			}
			index++
			continue
		}
		if unit >= 0xdc00 && unit <= 0xdfff {
			return "", errors.New("UTF-16 byte sequence contains an unpaired low surrogate")
		}
	}
	return string(utf16.Decode(units)), nil
}

func alignToEight(value uint32) uint32 {
	return (value + 7) &^ 7
}

func zeroNativeRecord(buffer []byte) bool {
	for _, value := range buffer {
		if value != 0 {
			return false
		}
	}
	return true
}
