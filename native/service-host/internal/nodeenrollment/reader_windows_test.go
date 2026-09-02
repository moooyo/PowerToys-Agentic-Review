//go:build windows

package nodeenrollment

import (
	"errors"
	"testing"
)

func TestWindowsReadRemainsUnavailableWithoutAuthorityVerifier(t *testing.T) {
	evidence, err := Read()
	if !errors.Is(err, ErrUnavailable) || evidence.state != nil {
		t.Fatalf("Read returned evidence=%#v err=%v", evidence, err)
	}
}
