package workerpackage

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode/utf8"
)

// ParseManifest accepts only one canonical UTF-8 manifest with exact schema fields.
func ParseManifest(document []byte) (Manifest, error) {
	if len(document) == 0 {
		return Manifest{}, newError(ErrManifest, "", "manifest must not be empty", nil)
	}
	if len(document) > MaximumManifestBytes {
		return Manifest{}, newError(ErrLimit, "", "manifest exceeds byte limit", nil)
	}
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return Manifest{}, newError(ErrManifest, "", "manifest must be UTF-8 without BOM", nil)
	}

	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()

	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, newError(ErrManifest, "", "manifest is not strict JSON", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("multiple JSON values")
		}
		return Manifest{}, newError(ErrManifest, "", "manifest contains trailing content", err)
	}

	normalized, err := normalizeManifest(manifest)
	if err != nil {
		return Manifest{}, err
	}
	canonical, err := marshalNormalizedManifest(normalized)
	if err != nil {
		return Manifest{}, err
	}
	if !bytes.Equal(document, canonical) {
		return Manifest{}, newError(ErrCanonical, "", "manifest does not use canonical JSON", nil)
	}
	return normalized, nil
}

// MarshalManifestCanonical validates and serializes a manifest in canonical JSON form.
func MarshalManifestCanonical(value Manifest) ([]byte, error) {
	normalized, err := normalizeManifest(value)
	if err != nil {
		return nil, err
	}
	return marshalNormalizedManifest(normalized)
}

func normalizeManifest(value Manifest) (Manifest, error) {
	if !validReleaseID(value.ReleaseID) {
		return Manifest{}, newError(ErrManifest, "releaseId", "releaseId is invalid", nil)
	}
	if value.Architecture != ArchitectureAMD64 && value.Architecture != ArchitectureARM64 {
		return Manifest{}, newError(ErrManifest, "architecture", "architecture must be amd64 or arm64", nil)
	}
	if len(value.Files) == 0 {
		return Manifest{}, newError(ErrManifest, "files", "files must not be empty", nil)
	}
	if len(value.Files) > MaximumFiles {
		return Manifest{}, newError(ErrLimit, "files", "manifest contains too many files", nil)
	}

	files := append([]File(nil), value.Files...)
	seen := make(map[string]struct{}, len(files))
	for index := range files {
		file := &files[index]
		if err := validateRelativePath(file.RelativePath); err != nil {
			return Manifest{}, err
		}
		if file.Size > MaximumFileBytes {
			return Manifest{}, newError(ErrLimit, file.RelativePath, "file size exceeds limit", nil)
		}
		if !validSHA256(file.SHA256) {
			return Manifest{}, newError(ErrManifest, file.RelativePath, "sha256 must be 64 lowercase hex characters", nil)
		}
		identity := windowsCaseFold(file.RelativePath)
		if _, exists := seen[identity]; exists {
			return Manifest{}, newError(ErrManifest, file.RelativePath, "relativePath values must be case-insensitively unique", nil)
		}
		seen[identity] = struct{}{}
	}

	sort.Slice(files, func(left, right int) bool {
		leftKey := windowsCaseFold(files[left].RelativePath)
		rightKey := windowsCaseFold(files[right].RelativePath)
		if leftKey != rightKey {
			return leftKey < rightKey
		}
		return files[left].RelativePath < files[right].RelativePath
	})

	value.Files = files
	return value, nil
}

func marshalNormalizedManifest(value Manifest) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, newError(ErrManifest, "", "failed to serialize manifest", err)
	}
	document := buffer.Bytes()
	if len(document) == 0 || document[len(document)-1] != '\n' {
		return nil, newError(ErrManifest, "", "serialized manifest is malformed", nil)
	}
	document = append([]byte(nil), document[:len(document)-1]...)
	if len(document) > MaximumManifestBytes {
		return nil, newError(ErrLimit, "", "manifest exceeds byte limit", nil)
	}
	return document, nil
}

func validateRelativePath(path string) error {
	if path == "" {
		return newError(ErrManifest, "relativePath", "relativePath must not be empty", nil)
	}
	if len(path) > MaximumPathBytes {
		return newError(ErrLimit, path, "relativePath exceeds byte limit", nil)
	}
	if !utf8.ValidString(path) || strings.ContainsRune(path, '\x00') {
		return newError(ErrManifest, path, "relativePath must be valid UTF-8", nil)
	}
	if strings.ContainsRune(path, '\\') {
		return newError(ErrManifest, path, "relativePath must use forward slashes", nil)
	}
	if strings.HasPrefix(path, "/") {
		return newError(ErrManifest, path, "relativePath must not be absolute", nil)
	}
	if strings.ContainsRune(path, ':') {
		return newError(ErrManifest, path, "relativePath must not contain ':'", nil)
	}

	components := strings.Split(path, "/")
	for _, component := range components {
		if component == "" || component == "." || component == ".." {
			return newError(ErrManifest, path, "relativePath contains an unsafe segment", nil)
		}
		if strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
			return newError(ErrManifest, path, "relativePath segment ends with dot or space", nil)
		}
		if reservedDeviceName(component) {
			return newError(ErrManifest, path, "relativePath contains a reserved Windows device name", nil)
		}
		for _, character := range component {
			if character < 0x20 || strings.ContainsRune(`<>:"|?*`, character) {
				return newError(ErrManifest, path, "relativePath contains invalid Windows characters", nil)
			}
		}
	}
	return nil
}

func validReleaseID(value string) bool {
	if len(value) == 0 || len(value) > MaximumReleaseIDBytes || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if isASCIIAlphaNumeric(character) || strings.ContainsRune("._+-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func reservedDeviceName(component string) bool {
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
		return true
	}
	if !strings.HasPrefix(base, "COM") && !strings.HasPrefix(base, "LPT") {
		return false
	}
	suffix := base[3:]
	return len(suffix) == 1 && suffix[0] >= '1' && suffix[0] <= '9' ||
		suffix == "¹" || suffix == "²" || suffix == "³"
}

func windowsCaseFold(value string) string {
	return strings.ToUpper(value)
}

func isASCIIAlphaNumeric(character byte) bool {
	return character >= 'A' && character <= 'Z' ||
		character >= 'a' && character <= 'z' ||
		character >= '0' && character <= '9'
}

func manifestPath(root, relativePath string) string {
	if root == "" {
		return relativePath
	}
	return fmt.Sprintf("%s/%s", root, relativePath)
}
