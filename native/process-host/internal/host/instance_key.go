package host

import "errors"

const instanceKeyLength = 64

var ErrInstanceMutexAlreadyHeld = errors.New("process-host instance mutex already held")

func ValidInstanceKey(value string) bool {
	if len(value) != instanceKeyLength {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
