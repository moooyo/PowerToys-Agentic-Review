package localrpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"unicode/utf8"
)

const (
	maximumWorkerAPIJSONDepth       = 64
	maximumWorkerAPIJSONNumberBytes = 64
)

var (
	ErrInvalidWorkerAPIBody = errors.New("worker API body is not a valid JSON object")
	ErrWorkerAPIBodyLimit   = errors.New("worker API body exceeds its byte limit")
)

// CopyWorkerAPIBody validates one opaque Worker API JSON object and returns detached exact bytes.
// It never interprets application fields or reserializes the document. Its caller hashes these
// exact bytes rather than a JCS or other normalized representation.
func CopyWorkerAPIBody(document []byte, maximumBytes int) ([]byte, error) {
	if maximumBytes <= 0 {
		return nil, errors.New("worker API body maximum must be positive")
	}
	if len(document) > maximumBytes {
		return nil, ErrWorkerAPIBodyLimit
	}
	snapshot := bytes.Clone(document)
	if err := validateWorkerAPIBody(snapshot); err != nil {
		return nil, err
	}
	return snapshot, nil
}

func validateWorkerAPIBody(document []byte) error {
	if len(document) == 0 || bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) ||
		!validWorkerAPIJSONUnicode(document) {
		return ErrInvalidWorkerAPIBody
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	kind, err := validateWorkerAPIJSONValue(decoder, 0)
	if err != nil || kind != jsonObjectValue {
		return ErrInvalidWorkerAPIBody
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalidWorkerAPIBody
	}
	return nil
}

type jsonValueKind uint8

const (
	jsonScalarValue jsonValueKind = iota
	jsonObjectValue
	jsonArrayValue
)

func validateWorkerAPIJSONValue(decoder *json.Decoder, depth int) (jsonValueKind, error) {
	if depth > maximumWorkerAPIJSONDepth {
		return jsonScalarValue, ErrInvalidWorkerAPIBody
	}
	token, err := decoder.Token()
	if err != nil {
		return jsonScalarValue, err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		if number, ok := token.(json.Number); ok {
			lexeme := string(number)
			if len(lexeme) == 0 || len(lexeme) > maximumWorkerAPIJSONNumberBytes {
				return jsonScalarValue, ErrInvalidWorkerAPIBody
			}
			value, parseErr := strconv.ParseFloat(lexeme, 64)
			if parseErr != nil {
				var numberError *strconv.NumError
				if !errors.As(parseErr, &numberError) || !errors.Is(numberError.Err, strconv.ErrRange) {
					return jsonScalarValue, ErrInvalidWorkerAPIBody
				}
			}
			if math.IsInf(value, 0) || math.IsNaN(value) {
				return jsonScalarValue, ErrInvalidWorkerAPIBody
			}
		}
		return jsonScalarValue, nil
	}

	switch delimiter {
	case '{':
		keys := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return jsonObjectValue, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return jsonObjectValue, ErrInvalidWorkerAPIBody
			}
			if _, exists := keys[key]; exists {
				return jsonObjectValue, ErrInvalidWorkerAPIBody
			}
			keys[key] = struct{}{}
			if _, err := validateWorkerAPIJSONValue(decoder, depth+1); err != nil {
				return jsonObjectValue, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return jsonObjectValue, ErrInvalidWorkerAPIBody
		}
		return jsonObjectValue, nil
	case '[':
		for decoder.More() {
			if _, err := validateWorkerAPIJSONValue(decoder, depth+1); err != nil {
				return jsonArrayValue, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return jsonArrayValue, ErrInvalidWorkerAPIBody
		}
		return jsonArrayValue, nil
	default:
		return jsonScalarValue, ErrInvalidWorkerAPIBody
	}
}

func validWorkerAPIJSONUnicode(document []byte) bool {
	if !utf8.Valid(document) {
		return false
	}
	inString := false
	for index := 0; index < len(document); index++ {
		switch document[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(document) {
				continue
			}
			if document[index+1] != 'u' {
				index++
				continue
			}
			codeUnit, ok := decodeWorkerAPIJSONCodeUnit(document, index+2)
			if !ok || codeUnit >= 0xdc00 && codeUnit <= 0xdfff {
				return false
			}
			if codeUnit >= 0xd800 && codeUnit <= 0xdbff {
				if index+11 >= len(document) || document[index+6] != '\\' || document[index+7] != 'u' {
					return false
				}
				low, lowOK := decodeWorkerAPIJSONCodeUnit(document, index+8)
				if !lowOK || low < 0xdc00 || low > 0xdfff {
					return false
				}
				index += 11
				continue
			}
			index += 5
		}
	}
	return true
}

func decodeWorkerAPIJSONCodeUnit(document []byte, offset int) (uint16, bool) {
	if offset < 0 || offset+4 > len(document) {
		return 0, false
	}
	var value uint16
	for _, character := range document[offset : offset+4] {
		value <<= 4
		switch {
		case character >= '0' && character <= '9':
			value |= uint16(character - '0')
		case character >= 'a' && character <= 'f':
			value |= uint16(character-'a') + 10
		case character >= 'A' && character <= 'F':
			value |= uint16(character-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}
