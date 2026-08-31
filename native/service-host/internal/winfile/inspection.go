package winfile

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"sort"
	"unicode"
	"unicode/utf16"
)

const (
	maximumStreamingHashBytes = uint64(^uint64(0) >> 1)
	streamingHashBufferBytes  = 128 * 1024
	defaultDataStreamName     = "::$DATA"
	caseSensitiveDirectoryBit = uint32(0x00000001)
)

type rawDirectoryEntry struct {
	entry     DirectoryEntry
	nameUnits uint32
}

type directoryEnumerationBuilder struct {
	options    DirectoryEnumerationOptions
	entries    []DirectoryEntry
	totalUnits uint64
	seen       map[string]string
}

func validateDirectoryEnumerationOptions(options DirectoryEnumerationOptions) error {
	if options.MaximumEntries == 0 || options.MaximumEntries > MaximumDirectoryEntries {
		return fmt.Errorf("%w: maximum entries is outside the supported range", ErrInvalidOptions)
	}
	if options.MaximumNameUTF16Units == 0 ||
		options.MaximumNameUTF16Units > MaximumDirectoryEntryNameUTF16Units {
		return fmt.Errorf("%w: maximum name length is outside the supported range", ErrInvalidOptions)
	}
	if options.MaximumTotalNameUTF16Units == 0 ||
		options.MaximumTotalNameUTF16Units > MaximumDirectoryNameUTF16Units {
		return fmt.Errorf("%w: maximum aggregate name length is outside the supported range", ErrInvalidOptions)
	}
	return nil
}

func newDirectoryEnumerationBuilder(options DirectoryEnumerationOptions) (*directoryEnumerationBuilder, error) {
	if err := validateDirectoryEnumerationOptions(options); err != nil {
		return nil, err
	}
	capacity := int(options.MaximumEntries)
	if capacity > 256 {
		capacity = 256
	}
	return &directoryEnumerationBuilder{
		options: options,
		entries: make([]DirectoryEntry, 0, capacity),
		seen:    make(map[string]string),
	}, nil
}

func (builder *directoryEnumerationBuilder) add(raw rawDirectoryEntry) error {
	name := raw.entry.Name
	if name == "." || name == ".." {
		return nil
	}
	if raw.nameUnits == 0 || raw.nameUnits > builder.options.MaximumNameUTF16Units {
		return fmt.Errorf("%w: name %q contains %d UTF-16 units", ErrDirectoryBudget, name, raw.nameUnits)
	}
	if uint64(raw.nameUnits) > builder.options.MaximumTotalNameUTF16Units-builder.totalUnits {
		return fmt.Errorf("%w: aggregate UTF-16 name budget exceeded", ErrDirectoryBudget)
	}
	if uint32(len(builder.entries)) >= builder.options.MaximumEntries {
		return fmt.Errorf("%w: entry count exceeded", ErrDirectoryBudget)
	}
	if err := validatePathComponent(name); err != nil {
		return fmt.Errorf("%w: unsafe entry name %q: %w", ErrDirectoryEnumeration, name, err)
	}
	if raw.entry.Kind != ObjectKindFile && raw.entry.Kind != ObjectKindDirectory {
		return fmt.Errorf("%w: entry %q has unknown object kind", ErrDirectoryEnumeration, name)
	}
	if raw.entry.Attributes&fileAttributeReparsePoint != 0 {
		return fmt.Errorf("%w: entry %q: %w", ErrDirectoryEnumeration, name, ErrReparsePoint)
	}
	if raw.entry.Identity.FileID == ([16]byte{}) {
		return fmt.Errorf("%w: entry %q has an empty file ID", ErrDirectoryEnumeration, name)
	}
	folded := simpleFoldKey(name)
	if previous, exists := builder.seen[folded]; exists {
		return fmt.Errorf("%w: %q collides with %q", ErrDirectoryCaseCollision, previous, name)
	}
	builder.seen[folded] = name
	builder.totalUnits += uint64(raw.nameUnits)
	builder.entries = append(builder.entries, raw.entry)
	return nil
}

func (builder *directoryEnumerationBuilder) finish() DirectoryEnumeration {
	sort.Slice(builder.entries, func(left int, right int) bool {
		leftFolded := simpleFoldKey(builder.entries[left].Name)
		rightFolded := simpleFoldKey(builder.entries[right].Name)
		if leftFolded == rightFolded {
			return builder.entries[left].Name < builder.entries[right].Name
		}
		return leftFolded < rightFolded
	})
	return DirectoryEnumeration{
		Entries:        append([]DirectoryEntry(nil), builder.entries...),
		NameUTF16Units: builder.totalUnits,
	}
}

func simpleFoldKey(value string) string {
	folded := make([]rune, 0, len(value))
	for _, character := range value {
		minimum := character
		for candidate := unicode.SimpleFold(character); candidate != character; candidate = unicode.SimpleFold(candidate) {
			if candidate < minimum {
				minimum = candidate
			}
		}
		folded = append(folded, minimum)
	}
	return string(folded)
}

func nameUTF16Units(value string) uint32 {
	return uint32(len(utf16.Encode([]rune(value))))
}

func validateHashOptions(options HashOptions) error {
	if options.MaximumBytes == 0 || options.MaximumBytes > maximumStreamingHashBytes {
		return fmt.Errorf("%w: maximum hash bytes is outside the supported range", ErrInvalidOptions)
	}
	if options.ExpectedSize > options.MaximumBytes {
		return fmt.Errorf("%w: expected size exceeds the hash byte limit", ErrInvalidOptions)
	}
	if options.PrefixBytes > MaximumHashPrefixBytes {
		return fmt.Errorf("%w: hash prefix limit is outside the supported range", ErrInvalidOptions)
	}
	return nil
}

func hashExact(reader io.Reader, options HashOptions) (HashResult, error) {
	if err := validateHashOptions(options); err != nil {
		return HashResult{}, err
	}
	hasher := sha256.New()
	prefixCapacity := uint64(options.PrefixBytes)
	if prefixCapacity > options.ExpectedSize {
		prefixCapacity = options.ExpectedSize
	}
	prefix := make([]byte, 0, int(prefixCapacity))
	buffer := make([]byte, streamingHashBufferBytes)
	remaining := options.ExpectedSize
	for remaining != 0 {
		readSize := uint64(len(buffer))
		if remaining < readSize {
			readSize = remaining
		}
		read, err := reader.Read(buffer[:int(readSize)])
		if read < 0 || read > int(readSize) {
			return HashResult{}, fmt.Errorf("hash reader returned invalid byte count %d", read)
		}
		if read != 0 {
			chunk := buffer[:read]
			_, _ = hasher.Write(chunk)
			if len(prefix) < int(prefixCapacity) {
				needed := int(prefixCapacity) - len(prefix)
				if needed > len(chunk) {
					needed = len(chunk)
				}
				prefix = append(prefix, chunk[:needed]...)
			}
			remaining -= uint64(read)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if remaining != 0 {
					return HashResult{}, fmt.Errorf("%w: stream ended after %d of %d bytes", ErrSizeMismatch, options.ExpectedSize-remaining, options.ExpectedSize)
				}
				break
			}
			return HashResult{}, err
		}
		if read == 0 {
			return HashResult{}, io.ErrNoProgress
		}
	}

	var extra [1]byte
	read, err := reader.Read(extra[:])
	if read != 0 {
		return HashResult{}, fmt.Errorf("%w: stream contains more than %d bytes", ErrSizeMismatch, options.ExpectedSize)
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return HashResult{}, err
	}
	if err == nil {
		return HashResult{}, io.ErrNoProgress
	}

	result := HashResult{Size: options.ExpectedSize, Prefix: prefix}
	copy(result.SHA256[:], hasher.Sum(nil))
	return result, nil
}

func validateDataStreams(kind ObjectKind, objectSize uint64, streams []DataStream) error {
	if kind != ObjectKindFile && kind != ObjectKindDirectory {
		return fmt.Errorf("%w: unknown object kind", ErrStreamEnumeration)
	}
	if len(streams) == 0 {
		if kind == ObjectKindDirectory {
			return nil
		}
		return fmt.Errorf("%w: regular file has no default data stream", ErrStreamEnumeration)
	}
	if len(streams) != 1 || streams[0].Name != defaultDataStreamName {
		for _, stream := range streams {
			if stream.Name != defaultDataStreamName {
				return fmt.Errorf("%w: observed stream %q", ErrNamedDataStream, stream.Name)
			}
		}
		return fmt.Errorf("%w: duplicate default data streams", ErrStreamEnumeration)
	}
	if kind == ObjectKindFile && streams[0].Size != objectSize {
		return fmt.Errorf("%w: default stream size %d differs from file size %d", ErrObjectChanged, streams[0].Size, objectSize)
	}
	return nil
}

func compareDataStreams(before []DataStream, after []DataStream) error {
	if len(before) != len(after) {
		return ErrObjectChanged
	}
	for index := range before {
		if before[index] != after[index] {
			return ErrObjectChanged
		}
	}
	return nil
}

func validateCaseSensitiveDirectoryFlags(flags uint32) error {
	if flags&caseSensitiveDirectoryBit != 0 {
		return ErrCaseSensitiveDirectory
	}
	if flags&^caseSensitiveDirectoryBit != 0 {
		return fmt.Errorf("%w: unknown case-sensitivity flags 0x%x", ErrCaseSensitiveDirectory, flags)
	}
	return nil
}
