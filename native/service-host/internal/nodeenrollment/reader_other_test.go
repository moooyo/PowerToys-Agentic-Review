//go:build !windows

package nodeenrollment

import (
	"errors"
	"testing"
)

func TestNonWindowsReadFailsUnsupported(t *testing.T) {
	evidence, err := Read()
	if !errors.Is(err, ErrUnsupported) || evidence.state != nil {
		t.Fatalf("Read returned evidence=%#v err=%v", evidence, err)
	}
}
