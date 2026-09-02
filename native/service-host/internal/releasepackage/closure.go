package releasepackage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

// parseReviewedClosure accepts only the canonical reviewed identity document whose SHA-256
// matches a digest supplied independently of the document itself. It remains package-private
// until a handle-bound independent approval reader can be the sole production caller.
func parseReviewedClosure(
	document []byte,
	independentlyExpectedSHA256 string,
) (ReviewedClosureEvidence, error) {
	if !validSHA256(independentlyExpectedSHA256) {
		return ReviewedClosureEvidence{}, fmt.Errorf("%w: independently expected closure digest is invalid", ErrInvalid)
	}
	if len(document) == 0 || len(document) > MaximumCanonicalDocumentBytes {
		return ReviewedClosureEvidence{}, fmt.Errorf("%w: reviewed closure document size is invalid", ErrInvalid)
	}
	digest := sha256.Sum256(document)
	if hex.EncodeToString(digest[:]) != independentlyExpectedSHA256 {
		return ReviewedClosureEvidence{}, fmt.Errorf("%w: reviewed closure digest differs from independent review", ErrMismatch)
	}

	var value reviewedClosureDocument
	if err := parseCanonical(document, &value); err != nil {
		return ReviewedClosureEvidence{}, err
	}
	if value.SchemaVersion != ReviewedClosureSchemaVersion ||
		value.PackageProfile != PackageProfile ||
		value.PolicyID != ReviewedClosurePolicyID ||
		value.PolicyVersion != ReviewedClosurePolicyVersion {
		return ReviewedClosureEvidence{}, fmt.Errorf("%w: reviewed closure policy fields are invalid", ErrInvalid)
	}
	identities, err := validateCanonicalDependencyIdentities(value.Dependencies)
	if err != nil {
		return ReviewedClosureEvidence{}, err
	}
	value.Dependencies = cloneDependencyIdentities(identities)
	return ReviewedClosureEvidence{state: &reviewedClosureState{
		document: append([]byte(nil), document...),
		sha256:   digest,
		value:    cloneReviewedClosureDocument(value),
	}}, nil
}

func validateCanonicalDependencyIdentities(
	identities []DependencyIdentity,
) ([]DependencyIdentity, error) {
	dependencies := make([]releaseprofile.Dependency, len(identities))
	for index, identity := range identities {
		dependencies[index] = releaseprofile.Dependency{
			Root: identity.Root, Path: identity.Path, Role: identity.Role,
			SHA256: strings.Repeat("0", sha256.Size*2), Size: "1",
		}
	}
	canonical, err := validateCanonicalDependencies("reviewed-closure", dependencies)
	if err != nil {
		return nil, err
	}
	result := make([]DependencyIdentity, len(canonical))
	for index, dependency := range canonical {
		result[index] = dependencyIdentity(dependency)
	}
	if !sameDependencyIdentities(result, identities) {
		return nil, fmt.Errorf("%w: reviewed closure identities are not in canonical order", ErrInvalid)
	}
	return cloneDependencyIdentities(result), nil
}

func validateReviewedClosure(evidence ReviewedClosureEvidence) (*reviewedClosureState, error) {
	if evidence.state == nil {
		return nil, fmt.Errorf("%w: reviewed closure evidence is absent", ErrInvalid)
	}
	reparsed, err := parseReviewedClosure(
		evidence.state.document,
		hex.EncodeToString(evidence.state.sha256[:]),
	)
	if err != nil || reparsed.state == nil ||
		evidence.state.sha256 != reparsed.state.sha256 ||
		!bytes.Equal(evidence.state.document, reparsed.state.document) ||
		!sameReviewedClosureDocument(evidence.state.value, reparsed.state.value) {
		return nil, fmt.Errorf("%w: reviewed closure evidence is inconsistent: %v", ErrInvalid, err)
	}
	return reparsed.state, nil
}

func (evidence ReviewedClosureEvidence) Document() []byte {
	if evidence.state == nil {
		return nil
	}
	return append([]byte(nil), evidence.state.document...)
}

func (evidence ReviewedClosureEvidence) SHA256() [sha256.Size]byte {
	if evidence.state == nil {
		return [sha256.Size]byte{}
	}
	return evidence.state.sha256
}

func dependencyIdentity(value releaseprofile.Dependency) DependencyIdentity {
	return DependencyIdentity{Root: value.Root, Path: value.Path, Role: value.Role}
}

func sameDependencyIdentities(left, right []DependencyIdentity) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func sameReviewedClosureDocument(left, right reviewedClosureDocument) bool {
	return left.PackageProfile == right.PackageProfile && left.PolicyID == right.PolicyID &&
		left.PolicyVersion == right.PolicyVersion && left.SchemaVersion == right.SchemaVersion &&
		sameDependencyIdentities(left.Dependencies, right.Dependencies)
}

func cloneDependencyIdentities(values []DependencyIdentity) []DependencyIdentity {
	return append([]DependencyIdentity(nil), values...)
}

func cloneReviewedClosureDocument(value reviewedClosureDocument) reviewedClosureDocument {
	value.Dependencies = cloneDependencyIdentities(value.Dependencies)
	return value
}

func cloneReviewedClosure(evidence ReviewedClosureEvidence) ReviewedClosureEvidence {
	if evidence.state == nil {
		return ReviewedClosureEvidence{}
	}
	return ReviewedClosureEvidence{state: &reviewedClosureState{
		document: append([]byte(nil), evidence.state.document...),
		sha256:   evidence.state.sha256,
		value:    cloneReviewedClosureDocument(evidence.state.value),
	}}
}
