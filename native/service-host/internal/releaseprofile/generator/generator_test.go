package generator

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
)

func TestValidateRejectsGeneratedSourceWithExecutableContent(t *testing.T) {
	document := []byte("canonical-template")
	digest := fmt.Sprintf("%x", sha256.Sum256(document))
	formatted, err := renderCanonicalSource(document, digest)
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(formatted, document, digest); err != nil {
		t.Fatal(err)
	}
	for _, addition := range []string{
		"\nfunc init() {}\n",
		"\nvar injected = true\n",
		"\ntype injected struct{}\n",
		"\nconst injected = \"value\"\n",
	} {
		candidate := append(append([]byte(nil), formatted...), addition...)
		if err := Validate(candidate, document, digest); err == nil {
			t.Fatalf("Validate accepted appended executable content %q", strings.TrimSpace(addition))
		}
	}
	if err := Validate(bytes.Replace(
		formatted,
		[]byte("package releaseprofile"),
		[]byte("package releaseprofile\n\nimport _ \"unsafe\""),
		1,
	), document, digest); err == nil {
		t.Fatal("Validate accepted an injected import")
	}
}
