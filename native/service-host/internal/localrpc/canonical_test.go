package localrpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestCanonicalJSONMatchesTypeScriptRepresentation(t *testing.T) {
	supplementary := "\U0001f600"
	privateUse := "\ue000"
	value := map[string]any{
		privateUse:    json.Number("2"),
		supplementary: json.Number("1"),
		"text":        "<>&\u2028\n",
	}
	want := "{\"text\":\"<>&\u2028\\n\"," + quoteForTest(supplementary) + ":1," +
		quoteForTest(privateUse) + ":2}"
	document, err := MarshalCanonicalJSON(value, 1024)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSON returned an error: %v", err)
	}
	if string(document) != want {
		t.Fatalf("canonical document = %q, want %q", document, want)
	}
	parsed, err := ParseCanonicalJSON(document, 1024)
	if err != nil || parsed == nil {
		t.Fatalf("ParseCanonicalJSON = (%#v, %v)", parsed, err)
	}
}

func TestCanonicalJSONRejectsAlternativeRepresentations(t *testing.T) {
	invalid := [][]byte{
		[]byte(` {"a":1}`),
		[]byte(`{"a":1,"a":1}`),
		[]byte(`{"a":1e0}`),
		[]byte(`{"a":-0}`),
		[]byte(`{"a":9007199254740992}`),
		[]byte("{\"a\":1}\n"),
		{0xef, 0xbb, 0xbf, '{', '}'},
		{0xff},
	}
	for _, document := range invalid {
		if _, err := ParseCanonicalJSON(document, 1024); err == nil {
			t.Errorf("ParseCanonicalJSON accepted %q", document)
		}
	}
}

func TestCanonicalJSONBoundsDepthAndSize(t *testing.T) {
	value := any(nil)
	for range canonicalMaximumDepth + 2 {
		value = []any{value}
	}
	if _, err := MarshalCanonicalJSON(value, 1<<20); !errors.Is(err, ErrCanonicalJSONLimit) {
		t.Fatalf("depth error = %v, want ErrCanonicalJSONLimit", err)
	}
	if _, err := ParseCanonicalJSON([]byte(`{"value":1}`), 2); !errors.Is(err, ErrCanonicalJSONLimit) {
		t.Fatalf("size error = %v, want ErrCanonicalJSONLimit", err)
	}
	if _, err := MarshalCanonicalJSON(map[string]any{"value": 1.5}, 1024); !errors.Is(err, ErrInvalidCanonicalJSON) {
		t.Fatalf("float error = %v, want ErrInvalidCanonicalJSON", err)
	}
}

func quoteForTest(value string) string {
	var builder strings.Builder
	if err := appendJSONString(&builder, value); err != nil {
		panic(err)
	}
	return builder.String()
}

func TestCanonicalJSONDoesNotMutateInput(t *testing.T) {
	document := []byte(`{"a":[1,2,3]}`)
	copyBefore := bytes.Clone(document)
	if _, err := ParseCanonicalJSON(document, 1024); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(document, copyBefore) {
		t.Fatal("ParseCanonicalJSON mutated its input")
	}
}
