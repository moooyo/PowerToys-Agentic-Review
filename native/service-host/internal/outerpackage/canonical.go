package outerpackage

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

func marshalCanonical(value any, maximum int) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("%w: serialize canonical document", ErrInvalid)
	}
	document := buffer.Bytes()
	if len(document) == 0 || document[len(document)-1] != '\n' {
		return nil, fmt.Errorf("%w: canonical delimiter is absent", ErrInvalid)
	}
	document = append([]byte(nil), document[:len(document)-1]...)
	if len(document) == 0 || len(document) > maximum {
		return nil, fmt.Errorf("%w: canonical document size is invalid", ErrInvalid)
	}
	return document, nil
}

func parseStrictCanonical(document []byte, maximum int, target any, canonical func() ([]byte, error)) error {
	if len(document) == 0 || len(document) > maximum ||
		bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return fmt.Errorf("%w: document encoding or size is invalid", ErrInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: document is not strict JSON", ErrInvalid)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: document contains trailing content", ErrInvalid)
	}
	normalized, err := canonical()
	if err != nil {
		return err
	}
	if !bytes.Equal(normalized, document) {
		return ErrCanonical
	}
	return nil
}
