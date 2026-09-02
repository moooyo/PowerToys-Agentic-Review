package servicehostreceipt

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestReceiptRoundTripsCanonicalDocument(t *testing.T) {
	value := validReceipt()
	document, err := MarshalCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Parse(document)
	if err != nil {
		t.Fatal(err)
	}
	if parsed != value || bytes.HasSuffix(document, []byte{'\n'}) {
		t.Fatalf("receipt did not round trip canonically: %#v", parsed)
	}
}

func TestReceiptRejectsNoncanonicalAndInvalidLineage(t *testing.T) {
	valid := validReceipt()
	for _, test := range []struct {
		name   string
		mutate func(*Receipt)
	}{
		{name: "profile", mutate: func(value *Receipt) { value.PackageProfile = "other" }},
		{name: "architecture", mutate: func(value *Receipt) { value.TargetArchitecture = "386" }},
		{name: "source", mutate: func(value *Receipt) { value.Source.Commit = strings.Repeat("A", 40) }},
		{name: "template", mutate: func(value *Receipt) { value.CompiledReleaseTemplateSHA256 = strings.Repeat("A", 64) }},
		{name: "invariant", mutate: func(value *Receipt) { value.SigningInvariantSHA256 = strings.Repeat("a", 63) }},
		{name: "unsigned digest", mutate: func(value *Receipt) { value.UnsignedSHA256 = strings.Repeat("g", 64) }},
		{name: "unsigned size", mutate: func(value *Receipt) { value.UnsignedSize = "01" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := valid
			test.mutate(&value)
			if _, err := MarshalCanonical(value); !errors.Is(err, ErrInvalid) {
				t.Fatalf("MarshalCanonical returned %v, want ErrInvalid", err)
			}
		})
	}
	document, err := MarshalCanonical(valid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(append(append([]byte(nil), document...), '\n')); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Parse accepted a noncanonical trailing newline: %v", err)
	}
}

func validReceipt() Receipt {
	return Receipt{
		CompiledReleaseTemplateSHA256: strings.Repeat("c", 64),
		PackageProfile:                PackageProfile,
		ReleaseID:                     "worker-2026.09.02.1",
		SchemaVersion:                 SchemaVersion,
		SigningInvariantSHA256:        strings.Repeat("d", 64),
		Source: Source{
			Commit: strings.Repeat("a", 40),
			Tree:   strings.Repeat("b", 40),
		},
		TargetArchitecture: "amd64",
		UnsignedSHA256:     strings.Repeat("e", 64),
		UnsignedSize:       "4096",
	}
}
