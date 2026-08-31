package winfile

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"
)

func TestDirectoryEnumerationBuilderSortsAndChargesNames(t *testing.T) {
	options := DirectoryEnumerationOptions{
		MaximumEntries:             4,
		MaximumNameUTF16Units:      32,
		MaximumTotalNameUTF16Units: 64,
	}
	builder, err := newDirectoryEnumerationBuilder(options)
	if err != nil {
		t.Fatal(err)
	}
	entries := []DirectoryEntry{
		{Name: "zeta.txt", Kind: ObjectKindFile, Identity: testDirectoryIdentity(1)},
		{Name: "Alpha", Kind: ObjectKindDirectory, Identity: testDirectoryIdentity(2)},
		{Name: "beta.txt", Kind: ObjectKindFile, Identity: testDirectoryIdentity(3)},
	}
	for _, entry := range entries {
		if err := builder.add(rawDirectoryEntry{entry: entry, nameUnits: nameUTF16Units(entry.Name)}); err != nil {
			t.Fatal(err)
		}
	}
	listing := builder.finish()
	wantNames := []string{"Alpha", "beta.txt", "zeta.txt"}
	gotNames := make([]string, len(listing.Entries))
	for index, entry := range listing.Entries {
		gotNames[index] = entry.Name
	}
	if !reflect.DeepEqual(gotNames, wantNames) {
		t.Fatalf("entry order = %v, want %v", gotNames, wantNames)
	}
	wantUnits := uint64(nameUTF16Units("zeta.txt") + nameUTF16Units("Alpha") + nameUTF16Units("beta.txt"))
	if listing.NameUTF16Units != wantUnits {
		t.Fatalf("name units = %d, want %d", listing.NameUTF16Units, wantUnits)
	}
}

func TestDirectoryEnumerationBuilderRejectsCaseCollision(t *testing.T) {
	builder, err := newDirectoryEnumerationBuilder(DirectoryEnumerationOptions{
		MaximumEntries:             2,
		MaximumNameUTF16Units:      32,
		MaximumTotalNameUTF16Units: 64,
	})
	if err != nil {
		t.Fatal(err)
	}
	first := DirectoryEntry{Name: "Readme.txt", Kind: ObjectKindFile, Identity: testDirectoryIdentity(1)}
	second := DirectoryEntry{Name: "README.TXT", Kind: ObjectKindFile, Identity: testDirectoryIdentity(2)}
	if err := builder.add(rawDirectoryEntry{entry: first, nameUnits: nameUTF16Units(first.Name)}); err != nil {
		t.Fatal(err)
	}
	if err := builder.add(rawDirectoryEntry{entry: second, nameUnits: nameUTF16Units(second.Name)}); !errors.Is(err, ErrDirectoryCaseCollision) {
		t.Fatalf("case collision error = %v", err)
	}
}

func TestDirectoryEnumerationBuilderEnforcesEveryBudget(t *testing.T) {
	tests := []struct {
		name    string
		options DirectoryEnumerationOptions
		entries []string
	}{
		{
			name: "entry count",
			options: DirectoryEnumerationOptions{
				MaximumEntries: 1, MaximumNameUTF16Units: 10, MaximumTotalNameUTF16Units: 20,
			},
			entries: []string{"a", "b"},
		},
		{
			name: "single name",
			options: DirectoryEnumerationOptions{
				MaximumEntries: 2, MaximumNameUTF16Units: 1, MaximumTotalNameUTF16Units: 20,
			},
			entries: []string{"ab"},
		},
		{
			name: "aggregate names",
			options: DirectoryEnumerationOptions{
				MaximumEntries: 2, MaximumNameUTF16Units: 10, MaximumTotalNameUTF16Units: 3,
			},
			entries: []string{"ab", "cd"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			builder, err := newDirectoryEnumerationBuilder(test.options)
			if err != nil {
				t.Fatal(err)
			}
			var observed error
			for index, name := range test.entries {
				entry := DirectoryEntry{Name: name, Kind: ObjectKindFile, Identity: testDirectoryIdentity(byte(index + 1))}
				observed = builder.add(rawDirectoryEntry{entry: entry, nameUnits: nameUTF16Units(name)})
				if observed != nil {
					break
				}
			}
			if !errors.Is(observed, ErrDirectoryBudget) {
				t.Fatalf("budget error = %v", observed)
			}
		})
	}
}

func TestDirectoryEnumerationOptionsRejectUnsafeLimits(t *testing.T) {
	valid := DirectoryEnumerationOptions{
		MaximumEntries:             1,
		MaximumNameUTF16Units:      1,
		MaximumTotalNameUTF16Units: 1,
	}
	tests := []DirectoryEnumerationOptions{
		{},
		{MaximumEntries: MaximumDirectoryEntries + 1, MaximumNameUTF16Units: 1, MaximumTotalNameUTF16Units: 1},
		{MaximumEntries: 1, MaximumNameUTF16Units: MaximumDirectoryEntryNameUTF16Units + 1, MaximumTotalNameUTF16Units: 1},
		{MaximumEntries: 1, MaximumNameUTF16Units: 1, MaximumTotalNameUTF16Units: MaximumDirectoryNameUTF16Units + 1},
	}
	if err := validateDirectoryEnumerationOptions(valid); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
	for _, options := range tests {
		if err := validateDirectoryEnumerationOptions(options); !errors.Is(err, ErrInvalidOptions) {
			t.Fatalf("options %+v returned %v", options, err)
		}
	}
}

func TestHashExactStreamsExpectedBytesAndPrefix(t *testing.T) {
	data := []byte(strings.Repeat("0123456789", 40_000))
	result, err := hashExact(iotest.OneByteReader(bytes.NewReader(data)), HashOptions{
		ExpectedSize: uint64(len(data)),
		MaximumBytes: uint64(len(data)),
		PrefixBytes:  5,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantDigest := sha256.Sum256(data)
	if result.SHA256 != wantDigest || result.Size != uint64(len(data)) || !bytes.Equal(result.Prefix, data[:5]) {
		t.Fatalf("unexpected hash result: %+v", result)
	}
}

func TestHashExactRejectsShortAndLongStreams(t *testing.T) {
	for _, test := range []struct {
		name     string
		data     string
		expected uint64
	}{
		{name: "short", data: "abc", expected: 4},
		{name: "long", data: "abcde", expected: 4},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := hashExact(strings.NewReader(test.data), HashOptions{
				ExpectedSize: test.expected,
				MaximumBytes: 8,
			})
			if !errors.Is(err, ErrSizeMismatch) {
				t.Fatalf("size error = %v", err)
			}
		})
	}
}

func TestHashOptionsRejectUnboundedInputs(t *testing.T) {
	tests := []HashOptions{
		{},
		{ExpectedSize: 2, MaximumBytes: 1},
		{MaximumBytes: maximumStreamingHashBytes + 1},
		{MaximumBytes: 1, PrefixBytes: MaximumHashPrefixBytes + 1},
	}
	for _, options := range tests {
		if err := validateHashOptions(options); !errors.Is(err, ErrInvalidOptions) {
			t.Fatalf("options %+v returned %v", options, err)
		}
	}
}

func TestDataStreamPolicyAllowsOnlyDefaultData(t *testing.T) {
	valid := []DataStream{{Name: defaultDataStreamName, Size: 10, AllocationSize: 16}}
	if err := validateDataStreams(ObjectKindFile, 10, valid); err != nil {
		t.Fatalf("default stream rejected: %v", err)
	}
	if err := validateDataStreams(ObjectKindDirectory, 0, nil); err != nil {
		t.Fatalf("empty directory stream set rejected: %v", err)
	}
	if err := validateDataStreams(ObjectKindFile, 10, []DataStream{{Name: ":Zone.Identifier:$DATA"}}); !errors.Is(err, ErrNamedDataStream) {
		t.Fatalf("named stream error = %v", err)
	}
	if err := validateDataStreams(ObjectKindFile, 10, nil); !errors.Is(err, ErrStreamEnumeration) {
		t.Fatalf("missing default stream error = %v", err)
	}
	if err := validateDataStreams(ObjectKindFile, 9, valid); !errors.Is(err, ErrObjectChanged) {
		t.Fatalf("stream size error = %v", err)
	}
}

func TestCaseSensitiveDirectoryFlagsFailClosed(t *testing.T) {
	if err := validateCaseSensitiveDirectoryFlags(0); err != nil {
		t.Fatal(err)
	}
	for _, flags := range []uint32{caseSensitiveDirectoryBit, 2} {
		if err := validateCaseSensitiveDirectoryFlags(flags); !errors.Is(err, ErrCaseSensitiveDirectory) {
			t.Fatalf("flags 0x%x returned %v", flags, err)
		}
	}
}

func testDirectoryIdentity(id byte) FileIdentity {
	return FileIdentity{VolumeSerialNumber: 1, FileID: [16]byte{id}}
}
