package localrpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	canonicalMaximumDepth = 64
	maximumSafeInteger    = int64(9_007_199_254_740_991)
)

var (
	ErrInvalidCanonicalJSON = errors.New("local RPC payload is not canonical JSON")
	ErrCanonicalJSONLimit   = errors.New("local RPC canonical JSON limit exceeded")
)

// ParseCanonicalJSON accepts one exact UTF-8 canonical JSON value. The representation matches
// the TypeScript local protocol: object keys use UTF-16 code-unit order, numbers are safe
// integers, strings use JSON.stringify-compatible escaping, and no insignificant whitespace is
// permitted.
func ParseCanonicalJSON(document []byte, maximumBytes int) (any, error) {
	if maximumBytes <= 0 {
		return nil, errors.New("canonical JSON maximum must be positive")
	}
	if len(document) == 0 || len(document) > maximumBytes {
		return nil, ErrCanonicalJSONLimit
	}
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return nil, fmt.Errorf("%w: invalid UTF-8", ErrInvalidCanonicalJSON)
	}

	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("%w: invalid syntax", ErrInvalidCanonicalJSON)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("%w: multiple values", ErrInvalidCanonicalJSON)
		}
		return nil, fmt.Errorf("%w: trailing content", ErrInvalidCanonicalJSON)
	}

	canonical, err := MarshalCanonicalJSON(value, maximumBytes)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(document, canonical) {
		return nil, ErrInvalidCanonicalJSON
	}
	return value, nil
}

// MarshalCanonicalJSON serializes a JSON-domain value using the local RPC canonical form.
func MarshalCanonicalJSON(value any, maximumBytes int) ([]byte, error) {
	if maximumBytes <= 0 {
		return nil, errors.New("canonical JSON maximum must be positive")
	}
	var builder strings.Builder
	if err := appendCanonicalValue(&builder, value, 0); err != nil {
		return nil, err
	}
	if builder.Len() == 0 || builder.Len() > maximumBytes {
		return nil, ErrCanonicalJSONLimit
	}
	return []byte(builder.String()), nil
}

func appendCanonicalValue(builder *strings.Builder, value any, depth int) error {
	if depth > canonicalMaximumDepth {
		return ErrCanonicalJSONLimit
	}
	switch typed := value.(type) {
	case nil:
		builder.WriteString("null")
	case bool:
		if typed {
			builder.WriteString("true")
		} else {
			builder.WriteString("false")
		}
	case string:
		return appendJSONString(builder, typed)
	case json.Number:
		integer, err := strconv.ParseInt(string(typed), 10, 64)
		if err != nil || integer < -maximumSafeInteger || integer > maximumSafeInteger {
			return fmt.Errorf("%w: number is not a safe integer", ErrInvalidCanonicalJSON)
		}
		builder.WriteString(strconv.FormatInt(integer, 10))
	case int:
		return appendSignedInteger(builder, int64(typed))
	case int8:
		return appendSignedInteger(builder, int64(typed))
	case int16:
		return appendSignedInteger(builder, int64(typed))
	case int32:
		return appendSignedInteger(builder, int64(typed))
	case int64:
		return appendSignedInteger(builder, typed)
	case uint:
		return appendUnsignedInteger(builder, uint64(typed))
	case uint8:
		return appendUnsignedInteger(builder, uint64(typed))
	case uint16:
		return appendUnsignedInteger(builder, uint64(typed))
	case uint32:
		return appendUnsignedInteger(builder, uint64(typed))
	case uint64:
		return appendUnsignedInteger(builder, typed)
	case []any:
		builder.WriteByte('[')
		for index, item := range typed {
			if index != 0 {
				builder.WriteByte(',')
			}
			if err := appendCanonicalValue(builder, item, depth+1); err != nil {
				return err
			}
		}
		builder.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			if !utf8.ValidString(key) {
				return fmt.Errorf("%w: object key is not valid Unicode", ErrInvalidCanonicalJSON)
			}
			keys = append(keys, key)
		}
		sort.Slice(keys, func(left, right int) bool {
			return compareUTF16(keys[left], keys[right]) < 0
		})
		builder.WriteByte('{')
		for index, key := range keys {
			if index != 0 {
				builder.WriteByte(',')
			}
			if err := appendJSONString(builder, key); err != nil {
				return err
			}
			builder.WriteByte(':')
			if err := appendCanonicalValue(builder, typed[key], depth+1); err != nil {
				return err
			}
		}
		builder.WriteByte('}')
	default:
		reflected := reflect.ValueOf(value)
		switch reflected.Kind() {
		case reflect.String:
			return appendJSONString(builder, reflected.String())
		case reflect.Bool:
			if reflected.Bool() {
				builder.WriteString("true")
			} else {
				builder.WriteString("false")
			}
			return nil
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			return appendSignedInteger(builder, reflected.Int())
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			return appendUnsignedInteger(builder, reflected.Uint())
		default:
			return fmt.Errorf("%w: unsupported value type %T", ErrInvalidCanonicalJSON, value)
		}
	}
	return nil
}

func appendSignedInteger(builder *strings.Builder, value int64) error {
	if value < -maximumSafeInteger || value > maximumSafeInteger {
		return fmt.Errorf("%w: number is not a safe integer", ErrInvalidCanonicalJSON)
	}
	builder.WriteString(strconv.FormatInt(value, 10))
	return nil
}

func appendUnsignedInteger(builder *strings.Builder, value uint64) error {
	if value > uint64(maximumSafeInteger) {
		return fmt.Errorf("%w: number is not a safe integer", ErrInvalidCanonicalJSON)
	}
	builder.WriteString(strconv.FormatUint(value, 10))
	return nil
}

func appendJSONString(builder *strings.Builder, value string) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("%w: string is not valid Unicode", ErrInvalidCanonicalJSON)
	}
	builder.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"', '\\':
			builder.WriteByte('\\')
			builder.WriteRune(character)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		default:
			if character < 0x20 {
				builder.WriteString(`\u00`)
				const hexadecimal = "0123456789abcdef"
				builder.WriteByte(hexadecimal[byte(character)>>4])
				builder.WriteByte(hexadecimal[byte(character)&0x0f])
			} else {
				builder.WriteRune(character)
			}
		}
	}
	builder.WriteByte('"')
	return nil
}

func compareUTF16(left, right string) int {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	for index := 0; index < len(leftUnits) && index < len(rightUnits); index++ {
		if leftUnits[index] < rightUnits[index] {
			return -1
		}
		if leftUnits[index] > rightUnits[index] {
			return 1
		}
	}
	if len(leftUnits) < len(rightUnits) {
		return -1
	}
	if len(leftUnits) > len(rightUnits) {
		return 1
	}
	return 0
}
