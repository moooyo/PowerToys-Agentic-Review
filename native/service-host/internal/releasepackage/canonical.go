package releasepackage

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

func marshalCanonical(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("%w: serialize canonical document: %v", ErrInvalid, err)
	}
	document := buffer.Bytes()
	if len(document) == 0 || document[len(document)-1] != '\n' {
		return nil, fmt.Errorf("%w: canonical document lacks final delimiter", ErrInvalid)
	}
	document = append([]byte(nil), document[:len(document)-1]...)
	if len(document) == 0 || len(document) > MaximumCanonicalDocumentBytes {
		return nil, fmt.Errorf("%w: canonical document exceeds its byte limit", ErrInvalid)
	}
	return document, nil
}

func parseCanonical(document []byte, target any) error {
	if len(document) == 0 || len(document) > MaximumCanonicalDocumentBytes ||
		bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return fmt.Errorf("%w: canonical document encoding is invalid", ErrInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: canonical document is not strict JSON: %v", ErrInvalid, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: canonical document contains trailing content", ErrInvalid)
	}
	canonical, err := marshalCanonical(target)
	if err != nil {
		return err
	}
	if !bytes.Equal(document, canonical) {
		return fmt.Errorf("%w: document is not canonical", ErrInvalid)
	}
	return nil
}
