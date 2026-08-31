package localrpc

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

const crossLanguageWorkerAPIBody = `{"confidence":0.8,"maximum":1.7976931348623157e+308,"minimum":5e-324}`

func TestCopyWorkerAPIBodyPreservesExactJSONBytes(t *testing.T) {
	body := []byte(crossLanguageWorkerAPIBody)
	copy, err := CopyWorkerAPIBody(body, len(body))
	if err != nil {
		t.Fatalf("CopyWorkerAPIBody returned an error: %v", err)
	}
	if len(copy) != 69 || !bytes.Equal(copy, body) {
		t.Fatalf("body copy = %q (%d bytes)", copy, len(copy))
	}
	copy[1] = 'X'
	if body[1] != '"' {
		t.Fatal("body copy aliases caller storage")
	}

	noncanonical := []byte(" { \"z\" : -0, \"a\" : 1e0, \"escaped\" : \"\\u0061\" } \n")
	if copy, err := CopyWorkerAPIBody(noncanonical, len(noncanonical)); err != nil || !bytes.Equal(copy, noncanonical) {
		t.Fatalf("noncanonical exact JSON returned (%q, %v)", copy, err)
	}
	underflow := []byte(`{"value":1e-4000}`)
	if _, err := CopyWorkerAPIBody(underflow, len(underflow)); err != nil {
		t.Fatalf("finite underflow was rejected: %v", err)
	}
	escapes := []byte(`{"quote":"\\\"","slash":"\\\\"}`)
	if _, err := CopyWorkerAPIBody(escapes, len(escapes)); err != nil {
		t.Fatalf("valid escaped quote or slash was rejected: %v", err)
	}
}

func TestCopyWorkerAPIBodyRejectsInvalidOrAmbiguousJSON(t *testing.T) {
	tooLongNumber := `{"value":` + `1.` + strings.Repeat("0", 63) + `}`
	invalid := [][]byte{
		nil,
		{},
		[]byte(`[]`),
		[]byte(`null`),
		[]byte(`{"value":1}{"value":2}`),
		[]byte(`{"value":1,"value":2}`),
		[]byte(`{"a":1,"\u0061":2}`),
		[]byte(`{"nested":{"value":1,"value":2}}`),
		[]byte(`{"value":1e309}`),
		[]byte(tooLongNumber),
		[]byte("\xef\xbb\xbf{}"),
		{'{', '"', 'v', '"', ':', '"', 0xff, '"', '}'},
		[]byte(`{"value":"\ud800"}`),
		[]byte(`{"value":"\udc00"}`),
		[]byte(`{"value":"\ud800\u0041"}`),
	}
	for _, body := range invalid {
		if _, err := CopyWorkerAPIBody(body, max(1, len(body))); !errors.Is(err, ErrInvalidWorkerAPIBody) {
			t.Errorf("CopyWorkerAPIBody(%q) error = %v", body, err)
		}
	}

	validPair := []byte(`{"value":"\ud83d\ude00"}`)
	if _, err := CopyWorkerAPIBody(validPair, len(validPair)); err != nil {
		t.Fatalf("valid surrogate pair was rejected: %v", err)
	}
}

func TestCopyWorkerAPIBodyEnforcesDepthAndByteLimits(t *testing.T) {
	atLimit := []byte(`{"value":` + strings.Repeat("[", maximumWorkerAPIJSONDepth-1) +
		`0` + strings.Repeat("]", maximumWorkerAPIJSONDepth-1) + `}`)
	if _, err := CopyWorkerAPIBody(atLimit, len(atLimit)); err != nil {
		t.Fatalf("depth limit was rejected: %v", err)
	}
	overLimit := []byte(`{"value":` + strings.Repeat("[", maximumWorkerAPIJSONDepth) +
		`0` + strings.Repeat("]", maximumWorkerAPIJSONDepth) + `}`)
	if _, err := CopyWorkerAPIBody(overLimit, len(overLimit)); !errors.Is(err, ErrInvalidWorkerAPIBody) {
		t.Fatalf("excess depth error = %v", err)
	}

	body := []byte(`{"value":1}`)
	if _, err := CopyWorkerAPIBody(body, len(body)-1); !errors.Is(err, ErrWorkerAPIBodyLimit) {
		t.Fatalf("oversized body error = %v", err)
	}
}
