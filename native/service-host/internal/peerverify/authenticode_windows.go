//go:build windows

package peerverify

import (
	"errors"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
)

type windowsAuthenticodeSubject interface {
	withAuthenticodeSubject(
		func(authenticode.Subject) (authenticode.Evidence, error),
	) (authenticode.Evidence, error)
}

type windowsAuthenticodeVerifier struct {
	verifier authenticode.Verifier
}

// NewWindowsAuthenticodeVerifier constructs the production, handle-bound
// embedded Authenticode verifier used by peer process verification.
func NewWindowsAuthenticodeVerifier() (AuthenticodeVerifier, error) {
	verifier, err := authenticode.NewWindowsVerifier()
	if err != nil {
		return nil, fmt.Errorf("construct Windows Authenticode verifier: %w", err)
	}
	return &windowsAuthenticodeVerifier{verifier: verifier}, nil
}

func (verifier *windowsAuthenticodeVerifier) VerifyAuthenticode(
	subject ImageSubject,
) (AuthenticodeEvidence, error) {
	if verifier == nil || verifier.verifier == nil {
		return AuthenticodeEvidence{}, errors.New("Windows Authenticode verifier is not initialized")
	}
	windowsSubject, ok := subject.(windowsAuthenticodeSubject)
	if !ok || isNilInterface(windowsSubject) {
		return AuthenticodeEvidence{}, fmt.Errorf(
			"%w: ImageSubject does not provide a sealed Windows file-handle capability",
			ErrAuthenticode,
		)
	}
	return windowsSubject.withAuthenticodeSubject(verifier.verifier.Verify)
}

var _ AuthenticodeVerifier = (*windowsAuthenticodeVerifier)(nil)
