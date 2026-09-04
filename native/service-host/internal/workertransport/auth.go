package workertransport

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"unicode/utf8"

	roleconfig "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

const (
	WorkerAuthProfileID            = roleconfig.WorkerAuthenticationProfileBearerTokenV1
	WorkerAuthProfilePath          = roleconfig.WorkerAuthenticationProfilePath
	MaximumWorkerAuthDocumentBytes = 4 * 1024
	workerTokenPrefix              = "arw1_"
	workerTokenEncodedBytes        = 43
	workerTokenBytes               = 32
	workerTokenLength              = len(workerTokenPrefix) + workerTokenEncodedBytes
)

var ErrInvalidWorkerAuth = errors.New("invalid Worker authentication profile")

// WorkerAuth is an opaque, copy-safe authentication profile. Its formatting methods never expose
// the Token. The Token is available only to this package when constructing Worker API requests.
type WorkerAuth struct {
	workerNodeID string
	token        [workerTokenLength]byte
	valid        bool
}

// WorkerNodeID returns the non-secret Worker node identity bound to the Token profile.
func (auth WorkerAuth) WorkerNodeID() string {
	if !auth.valid {
		return ""
	}
	return auth.workerNodeID
}

func (auth WorkerAuth) String() string {
	if !auth.valid {
		return "WorkerAuth<invalid>"
	}
	return fmt.Sprintf("WorkerAuth<workerNodeId=%s, token=redacted>", auth.workerNodeID)
}

func (auth WorkerAuth) GoString() string { return auth.String() }

func (auth WorkerAuth) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(auth.String()))
}

// MarshalWorkerAuth validates the fixed profile fields and returns the only accepted canonical
// JSON encoding for the Worker authentication profile.
func MarshalWorkerAuth(workerNodeID string, token string) ([]byte, error) {
	if err := validateEntityID(workerNodeID); err != nil {
		return nil, workerAuthError("Worker node ID is invalid")
	}
	if !validWorkerToken(token) {
		return nil, workerAuthError("Token is invalid")
	}

	document := make([]byte, 0, len(WorkerAuthProfileID)+len(workerNodeID)+len(token)+48)
	document = append(document, `{"profileId":"`...)
	document = append(document, WorkerAuthProfileID...)
	document = append(document, `","token":"`...)
	document = append(document, token...)
	document = append(document, `","workerNodeId":"`...)
	document = append(document, workerNodeID...)
	document = append(document, `"}`...)

	if _, err := parseWorkerAuth(document); err != nil {
		clear(document)
		return nil, err
	}
	return document, nil
}

// LoadWorkerAuth loads the only production Worker Token source. It accepts no alternate path,
// environment variable, command-line value, package field, or registry source.
func LoadWorkerAuth() (WorkerAuth, error) {
	return loadWorkerAuthFile(WorkerAuthProfilePath)
}

func loadWorkerAuthFile(path string) (WorkerAuth, error) {
	file, err := os.Open(path)
	if err != nil {
		return WorkerAuth{}, workerAuthError("open fixed profile")
	}

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 ||
		info.Size() > MaximumWorkerAuthDocumentBytes {
		_ = file.Close()
		return WorkerAuth{}, workerAuthError("fixed profile must be a bounded regular file")
	}
	document, err := io.ReadAll(io.LimitReader(file, MaximumWorkerAuthDocumentBytes+1))
	closeErr := file.Close()
	if err != nil || closeErr != nil || len(document) > MaximumWorkerAuthDocumentBytes {
		clear(document)
		return WorkerAuth{}, workerAuthError("read fixed profile")
	}
	auth, parseErr := parseWorkerAuth(document)
	clear(document)
	return auth, parseErr
}

// parseWorkerAuth parses the fixed v1 plaintext profile without retaining or reporting the source
// document. It remains package-private so production callers cannot create an alternate Token
// source. Only the unique fixed-order, whitespace-free JSON encoding is accepted.
func parseWorkerAuth(document []byte) (WorkerAuth, error) {
	if len(document) == 0 || len(document) > MaximumWorkerAuthDocumentBytes ||
		bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return WorkerAuth{}, workerAuthError("profile must be bounded UTF-8 without a byte-order mark")
	}

	decoder := json.NewDecoder(bytes.NewReader(document))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return WorkerAuth{}, workerAuthError("profile must be one JSON object")
	}

	values := make(map[string]string, 3)
	for decoder.More() {
		member, err := decoder.Token()
		name, ok := member.(string)
		if err != nil || !ok {
			return WorkerAuth{}, workerAuthError("profile contains an invalid member name")
		}
		if _, duplicate := values[name]; duplicate {
			return WorkerAuth{}, workerAuthError("profile contains a duplicate member")
		}
		switch name {
		case "profileId", "token", "workerNodeId":
		default:
			return WorkerAuth{}, workerAuthError("profile contains an unknown member")
		}
		var value string
		if err := decoder.Decode(&value); err != nil {
			return WorkerAuth{}, workerAuthError("profile member must be a string")
		}
		values[name] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return WorkerAuth{}, workerAuthError("profile object is incomplete")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return WorkerAuth{}, workerAuthError("profile contains trailing content")
	}
	if len(values) != 3 || values["profileId"] != WorkerAuthProfileID {
		return WorkerAuth{}, workerAuthError("profile members are incomplete or use the wrong profile ID")
	}
	if err := validateEntityID(values["workerNodeId"]); err != nil {
		return WorkerAuth{}, workerAuthError("profile Worker node ID is invalid")
	}
	if !validWorkerToken(values["token"]) {
		return WorkerAuth{}, workerAuthError("profile Token is invalid")
	}
	canonical := make([]byte, 0, len(document))
	canonical = append(canonical, `{"profileId":"`...)
	canonical = append(canonical, WorkerAuthProfileID...)
	canonical = append(canonical, `","token":"`...)
	canonical = append(canonical, values["token"]...)
	canonical = append(canonical, `","workerNodeId":"`...)
	canonical = append(canonical, values["workerNodeId"]...)
	canonical = append(canonical, `"}`...)
	if !bytes.Equal(document, canonical) {
		clear(canonical)
		return WorkerAuth{}, workerAuthError("profile is not canonically encoded")
	}
	clear(canonical)

	auth := WorkerAuth{workerNodeID: values["workerNodeId"], valid: true}
	copy(auth.token[:], values["token"])
	return auth, nil
}

func (auth WorkerAuth) validate() error {
	if !auth.valid || validateEntityID(auth.workerNodeID) != nil || !validWorkerToken(string(auth.token[:])) {
		return workerAuthError("profile is absent or invalid")
	}
	return nil
}

func (auth WorkerAuth) tokenBytes() []byte {
	if auth.validate() != nil {
		return nil
	}
	return bytes.Clone(auth.token[:])
}

func validWorkerToken(value string) bool {
	if len(value) != workerTokenLength || value[:len(workerTokenPrefix)] != workerTokenPrefix {
		return false
	}
	encoded := value[len(workerTokenPrefix):]
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && len(decoded) == workerTokenBytes &&
		base64.RawURLEncoding.EncodeToString(decoded) == encoded
}

func workerAuthError(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidWorkerAuth, message)
}
