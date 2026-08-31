package winacl

import (
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
)

func parseSIDAt(raw []byte, offset uint32) (string, int, error) {
	if offset < securityDescriptorRelativeSize || offset%4 != 0 {
		return "", 0, fmt.Errorf("offset %d is missing or not DWORD-aligned", offset)
	}
	start, err := checkedOffset(raw, offset, 8)
	if err != nil {
		return "", 0, err
	}
	sid, length, err := parseSID(raw[start:])
	if err != nil {
		return "", 0, err
	}
	return sid, length, nil
}

func parseSID(raw []byte) (string, int, error) {
	if len(raw) < 8 {
		return "", 0, errorsForSID("header is truncated")
	}
	if raw[0] != 1 {
		return "", 0, errorsForSID("revision %d is unsupported", raw[0])
	}
	count := int(raw[1])
	if count > maximumSIDSubAuthorities {
		return "", 0, errorsForSID("sub-authority count %d exceeds %d", count, maximumSIDSubAuthorities)
	}
	length := 8 + 4*count
	if length > len(raw) {
		return "", 0, errorsForSID("body is truncated")
	}

	authority := uint64(0)
	for _, value := range raw[2:8] {
		authority = authority<<8 | uint64(value)
	}
	authorityText := strconv.FormatUint(authority, 10)
	if authority > uint64(^uint32(0)) {
		authorityText = fmt.Sprintf("0x%012x", authority)
	}

	var builder strings.Builder
	builder.WriteString("S-1-")
	builder.WriteString(authorityText)
	for index := 0; index < count; index++ {
		builder.WriteByte('-')
		subAuthority := binary.LittleEndian.Uint32(raw[8+index*4 : 12+index*4])
		builder.WriteString(strconv.FormatUint(uint64(subAuthority), 10))
	}
	return builder.String(), length, nil
}

func checkedOffset(raw []byte, offset uint32, minimum int) (int, error) {
	start := uint64(offset)
	if start > uint64(len(raw)) || uint64(minimum) > uint64(len(raw))-start {
		return 0, fmt.Errorf("offset %d exceeds the descriptor", offset)
	}
	return int(start), nil
}

func errorsForSID(format string, arguments ...any) error {
	return fmt.Errorf("invalid SID: %s", fmt.Sprintf(format, arguments...))
}
