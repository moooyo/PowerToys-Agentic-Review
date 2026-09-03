package peerverify

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

func validateVerificationOptions(options verificationOptions) error {
	if options.PipePeer != PipePeerClient && options.PipePeer != PipePeerServer {
		return invalidOptions("pipe peer must select the client or server endpoint")
	}
	if options.LocalProcessID == 0 {
		return invalidOptions("local process ID must be nonzero")
	}
	if err := validateServiceSID(options.ExpectedServiceSID); err != nil {
		return invalidOptions("expected peer service SID must be canonical")
	}
	if isNilInterface(options.TokenVerifier) {
		return invalidOptions("token verifier is required")
	}
	return nil
}

func validateServiceSID(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) != 9 || parts[0] != "S" || parts[1] != "1" || parts[2] != "5" || parts[3] != "80" {
		return ErrTokenMismatch
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return ErrTokenMismatch
		}
	}
	return nil
}

func invalidOptions(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidOptions, message)
}

func isNilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}
