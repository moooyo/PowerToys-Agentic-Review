package releaseprofile

import (
	"bytes"
	"testing"
)

func TestBuildTemplateFixesNonAuthorizingReleaseStructure(t *testing.T) {
	fixture := testTemplate(t)
	normalized, err := normalizeDocument(fixture)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := marshalNormalized(normalized)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := BuildTemplate(TemplateOptions{
		ReleaseID: fixture.ReleaseID,
		AuthenticodeLeafSignerCertificateDERSHA256: fixture.AuthenticodeLeafSignerCertificateDERSHA256,
		Dependencies: fixture.Dependencies,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatalf("BuildTemplate = %s, want %s", actual, expected)
	}
	fixture.Dependencies[0].SHA256 = "invalid"
	if err := ValidateDocument(actual); err != nil {
		t.Fatalf("built template aliased caller dependencies: %v", err)
	}
}
