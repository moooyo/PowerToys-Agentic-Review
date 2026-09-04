package releasepackage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

// Prepare validates one explicit dependency closure and constructs the exact compiled template
// plus a canonical receipt for the later ServiceHost finalization phase.
func Prepare(request PrepareRequest) (PreparedRelease, error) {
	if err := validateContext(
		request.ReleaseID,
		request.TargetArchitecture,
		request.Source,
		request.AuthenticodeLeafSignerCertificateDERSHA256,
	); err != nil {
		return PreparedRelease{}, err
	}
	closure, err := validateReviewedClosure(request.ReviewedClosure)
	if err != nil {
		return PreparedRelease{}, err
	}
	dependencies, err := validateDependencyClosure(
		request.ReleaseID,
		closure,
		request.Dependencies,
	)
	if err != nil {
		return PreparedRelease{}, err
	}
	templateDocument, err := releaseprofile.BuildTemplate(releaseprofile.TemplateOptions{
		ReleaseID: request.ReleaseID,
		AuthenticodeLeafSignerCertificateDERSHA256: request.AuthenticodeLeafSignerCertificateDERSHA256,
		Dependencies: dependencies,
	})
	if err != nil {
		return PreparedRelease{}, fmt.Errorf("%w: build compiled release template: %v", ErrInvalid, err)
	}
	templateDigest := sha256.Sum256(templateDocument)
	receipt := prepareReceiptDocument{
		AuthenticodeLeafSignerCertificateDERSHA256: request.AuthenticodeLeafSignerCertificateDERSHA256,
		CompiledReleaseTemplateSHA256:              hex.EncodeToString(templateDigest[:]),
		Dependencies:                               cloneDependencies(dependencies),
		ExecutionAuthority:                         false,
		FoundationVersion:                          FoundationVersion,
		PackageProfile:                             PackageProfile,
		ReleaseID:                                  request.ReleaseID,
		ReviewedClosurePolicyID:                    closure.value.PolicyID,
		ReviewedClosurePolicyVersion:               closure.value.PolicyVersion,
		ReviewedClosureSHA256:                      hex.EncodeToString(closure.sha256[:]),
		SchemaVersion:                              PrepareReceiptSchemaVersion,
		Source:                                     request.Source,
		TargetArchitecture:                         request.TargetArchitecture,
	}
	receiptDocument, err := marshalCanonical(receipt)
	if err != nil {
		return PreparedRelease{}, err
	}
	return newPreparedRelease(
		receiptDocument,
		receipt,
		templateDocument,
		templateDigest,
		ReviewedClosureEvidence{state: closure},
	), nil
}

// ParsePrepareReceipt accepts only the exact canonical receipt and reconstructs its compiled
// template independently before returning opaque prepared state. The same independently checked
// reviewed closure used by Prepare is required; receipt bytes alone are insufficient evidence.
func ParsePrepareReceipt(
	document []byte,
	reviewed ReviewedClosureEvidence,
) (PreparedRelease, error) {
	var receipt prepareReceiptDocument
	if err := parseCanonical(document, &receipt); err != nil {
		return PreparedRelease{}, err
	}
	return preparedFromReceipt(document, receipt, reviewed)
}

func preparedFromReceipt(
	document []byte,
	receipt prepareReceiptDocument,
	reviewed ReviewedClosureEvidence,
) (PreparedRelease, error) {
	if receipt.SchemaVersion != PrepareReceiptSchemaVersion || receipt.PackageProfile != PackageProfile ||
		receipt.FoundationVersion != FoundationVersion || receipt.ExecutionAuthority {
		return PreparedRelease{}, fmt.Errorf("%w: prepare receipt authority fields are invalid", ErrInvalid)
	}
	closure, err := validateReviewedClosure(reviewed)
	if err != nil {
		return PreparedRelease{}, err
	}
	if receipt.ReviewedClosurePolicyID != closure.value.PolicyID ||
		receipt.ReviewedClosurePolicyVersion != closure.value.PolicyVersion ||
		receipt.ReviewedClosureSHA256 != hex.EncodeToString(closure.sha256[:]) {
		return PreparedRelease{}, fmt.Errorf("%w: prepare receipt reviewed closure differs from evidence", ErrMismatch)
	}
	if err := validateContext(
		receipt.ReleaseID,
		receipt.TargetArchitecture,
		receipt.Source,
		receipt.AuthenticodeLeafSignerCertificateDERSHA256,
	); err != nil {
		return PreparedRelease{}, err
	}
	dependencies, err := validateDependencyClosure(
		receipt.ReleaseID,
		closure,
		receipt.Dependencies,
	)
	if err != nil {
		return PreparedRelease{}, err
	}
	templateDocument, err := releaseprofile.BuildTemplate(releaseprofile.TemplateOptions{
		ReleaseID: receipt.ReleaseID,
		AuthenticodeLeafSignerCertificateDERSHA256: receipt.AuthenticodeLeafSignerCertificateDERSHA256,
		Dependencies: dependencies,
	})
	if err != nil {
		return PreparedRelease{}, fmt.Errorf("%w: reconstruct compiled release template: %v", ErrInvalid, err)
	}
	templateDigest := sha256.Sum256(templateDocument)
	if hex.EncodeToString(templateDigest[:]) != receipt.CompiledReleaseTemplateSHA256 {
		return PreparedRelease{}, fmt.Errorf("%w: compiled release template digest differs from receipt", ErrMismatch)
	}
	receipt.Dependencies = cloneDependencies(dependencies)
	return newPreparedRelease(
		document,
		receipt,
		templateDocument,
		templateDigest,
		ReviewedClosureEvidence{state: closure},
	), nil
}

func newPreparedRelease(
	document []byte,
	receipt prepareReceiptDocument,
	templateDocument []byte,
	templateDigest [sha256.Size]byte,
	reviewed ReviewedClosureEvidence,
) PreparedRelease {
	receiptDigest := sha256.Sum256(document)
	return PreparedRelease{state: &preparedState{
		receiptDocument:  append([]byte(nil), document...),
		receiptSHA256:    receiptDigest,
		templateDocument: append([]byte(nil), templateDocument...),
		templateSHA256:   templateDigest,
		receipt:          cloneReceipt(receipt),
		closure:          cloneReviewedClosure(reviewed),
	}}
}

func validatePrepared(prepared PreparedRelease) (*preparedState, error) {
	if prepared.state == nil {
		return nil, fmt.Errorf("%w: prepare receipt is absent", ErrInvalid)
	}
	reparsed, err := ParsePrepareReceipt(prepared.state.receiptDocument, prepared.state.closure)
	if err != nil || reparsed.state == nil ||
		prepared.state.receiptSHA256 != reparsed.state.receiptSHA256 ||
		prepared.state.templateSHA256 != reparsed.state.templateSHA256 ||
		!bytes.Equal(prepared.state.templateDocument, reparsed.state.templateDocument) ||
		!sameReceipt(prepared.state.receipt, reparsed.state.receipt) {
		return nil, fmt.Errorf("%w: prepare receipt state is inconsistent: %v", ErrInvalid, err)
	}
	return prepared.state, nil
}

func (prepared PreparedRelease) ReceiptDocument() []byte {
	if prepared.state == nil {
		return nil
	}
	return append([]byte(nil), prepared.state.receiptDocument...)
}

func (prepared PreparedRelease) ReceiptSHA256() [sha256.Size]byte {
	if prepared.state == nil {
		return [sha256.Size]byte{}
	}
	return prepared.state.receiptSHA256
}

func (prepared PreparedRelease) CompiledTemplateDocument() []byte {
	if prepared.state == nil {
		return nil
	}
	return append([]byte(nil), prepared.state.templateDocument...)
}

func (prepared PreparedRelease) CompiledTemplateSHA256() [sha256.Size]byte {
	if prepared.state == nil {
		return [sha256.Size]byte{}
	}
	return prepared.state.templateSHA256
}
