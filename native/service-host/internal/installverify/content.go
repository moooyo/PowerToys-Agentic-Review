package installverify

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
)

const (
	maximumControlRootCertificateBytes = uint64(64 * 1024)
	maximumExecutorCodexPolicyBytes    = uint64(1024 * 1024)
)

type verifiedContentTarget struct {
	root         releasemanifest.FileRoot
	path         string
	absolutePath string
	role         releasemanifest.FileRole
	sha256       string
	maximumBytes uint64
}

type verifiedContentState struct {
	file FileSnapshot
	data []byte
}

// VerifiedContent is an opaque, immutable copy of one bounded runtime input
// read from the same retained handle used for installation verification.
type VerifiedContent struct {
	state *verifiedContentState
}

// Validate rejects the zero value or internally inconsistent content.
func (content VerifiedContent) Validate() error {
	if content.state == nil {
		return ErrVerifiedContentUnavailable
	}
	file := content.state.file
	if file.root != releasemanifest.RootTrustedConfiguration || file.path == "" ||
		file.absolutePath == "" || file.sha256 == "" || file.size == 0 ||
		uint64(len(content.state.data)) != file.size {
		return ErrVerifiedContentUnavailable
	}
	digest := sha256.Sum256(content.state.data)
	if !equalDigest(digest, file.sha256) {
		return ErrVerifiedContentUnavailable
	}
	return nil
}

func (content VerifiedContent) Root() releasemanifest.FileRoot {
	if content.state == nil {
		return ""
	}
	return content.state.file.root
}

func (content VerifiedContent) Path() string {
	if content.state == nil {
		return ""
	}
	return content.state.file.path
}

func (content VerifiedContent) AbsolutePath() string {
	if content.state == nil {
		return ""
	}
	return content.state.file.absolutePath
}

func (content VerifiedContent) Role() releasemanifest.FileRole {
	if content.state == nil {
		return ""
	}
	return content.state.file.role
}

func (content VerifiedContent) SHA256() string {
	if content.state == nil {
		return ""
	}
	return content.state.file.sha256
}

func (content VerifiedContent) Size() uint64 {
	if content.state == nil {
		return 0
	}
	return content.state.file.size
}

func (content VerifiedContent) Object() secureconfig.ObjectEvidence {
	if content.state == nil {
		return secureconfig.ObjectEvidence{}
	}
	return cloneObjectEvidence(content.state.file.object)
}

// Bytes returns a detached copy. Callers never receive verifier-owned storage.
func (content VerifiedContent) Bytes() []byte {
	if content.state == nil {
		return nil
	}
	return append([]byte(nil), content.state.data...)
}

// VerifiedContent returns only a role-required trusted runtime input. Path is
// the canonical manifest-relative path; arbitrary manifest files are never
// cached or exposed through this method.
func (e Evidence) VerifiedContent(
	root releasemanifest.FileRoot,
	path string,
) (VerifiedContent, error) {
	if e.state == nil || root != releasemanifest.RootTrustedConfiguration ||
		validateRelativeContentPath(path) != nil {
		return VerifiedContent{}, ErrVerifiedContentUnavailable
	}
	content, exists := e.state.contents[manifestFileKey(root, path)]
	if !exists || content.Validate() != nil {
		return VerifiedContent{}, ErrVerifiedContentUnavailable
	}
	return cloneVerifiedContent(content), nil
}

func (v *verifier) prepareVerifiedContentTargets() error {
	targets, err := requiredVerifiedContentTargets(v.options.Role, v.controlConfig, v.executorConfig)
	if err != nil {
		return err
	}
	v.contentTargets = targets
	return nil
}

func requiredVerifiedContentTargets(
	role config.Role,
	controlConfig config.Config,
	executorConfig config.Config,
) (map[string]verifiedContentTarget, error) {
	targets := make(map[string]verifiedContentTarget, 2)
	add := func(
		absolutePath string,
		role releasemanifest.FileRole,
		digest string,
		maximumBytes uint64,
	) error {
		relative, err := relativePath(controlConfig.Installation.TrustedConfigurationRoot, absolutePath)
		if err != nil {
			return err
		}
		target := verifiedContentTarget{
			root: releasemanifest.RootTrustedConfiguration, path: relative,
			absolutePath: absolutePath, role: role, sha256: digest, maximumBytes: maximumBytes,
		}
		key := manifestFileKey(target.root, target.path)
		if _, duplicate := targets[key]; duplicate {
			return errors.New("runtime trusted content paths are not distinct")
		}
		targets[key] = target
		return nil
	}

	switch role {
	case config.RoleControl:
		if controlConfig.Control == nil {
			return nil, errors.New("Control runtime content configuration is absent")
		}
		control := controlConfig.Control
		if err := add(
			control.RootCertificatePath,
			releasemanifest.RoleCABundle,
			control.RootCertificateSHA256,
			maximumControlRootCertificateBytes,
		); err != nil {
			return nil, err
		}
	case config.RoleExecutor:
		if executorConfig.Executor == nil {
			return nil, errors.New("Executor runtime content configuration is absent")
		}
		executor := executorConfig.Executor
		if err := add(
			executor.CodexPolicyPath,
			releasemanifest.RolePolicy,
			executor.CodexPolicySHA256,
			maximumExecutorCodexPolicyBytes,
		); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("runtime content role is unsupported")
	}
	return targets, nil
}

func (v *verifier) captureVerifiedContent(
	file *openedFile,
	expected releasemanifest.File,
	size uint64,
	verifiedDigest [sha256.Size]byte,
	fileSnapshot FileSnapshot,
) error {
	key := manifestFileKey(expected.Root, expected.Path)
	target, required := v.contentTargets[key]
	if !required {
		return nil
	}
	if target.root != expected.Root || target.role != expected.Role ||
		!strings.EqualFold(target.path, expected.Path) ||
		!windowsPathEqual(target.absolutePath, file.object.Path) ||
		subtle.ConstantTimeCompare([]byte(target.sha256), []byte(expected.SHA256)) != 1 {
		return verificationError(ErrorFile, "runtime trusted content binding is inconsistent", ErrFileContent)
	}
	if size == 0 || size > target.maximumBytes {
		return verificationError(
			ErrorFile,
			fmt.Sprintf("runtime trusted content exceeds its fixed %d-byte limit", target.maximumBytes),
			ErrFileContent,
		)
	}
	data, err := file.handle.ReadAll(target.maximumBytes)
	if err != nil {
		return verificationError(ErrorFile, "read runtime trusted content from retained handle", errors.Join(ErrFileContent, err))
	}
	digest := sha256.Sum256(data)
	if uint64(len(data)) != size || digest != verifiedDigest ||
		subtle.ConstantTimeCompare([]byte(fmt.Sprintf("%x", digest)), []byte(target.sha256)) != 1 {
		return verificationError(ErrorFile, "runtime trusted content changed after manifest hashing", ErrFileContent)
	}
	if _, duplicate := v.verifiedContents[key]; duplicate {
		return verificationError(ErrorFile, "runtime trusted content was captured more than once", ErrFileContent)
	}
	v.verifiedContents[key] = VerifiedContent{state: &verifiedContentState{
		file: cloneFileSnapshot(fileSnapshot), data: append([]byte(nil), data...),
	}}
	return nil
}

func validateVerifiedContents(state *evidenceState) error {
	if state == nil {
		return ErrVerifiedContentUnavailable
	}
	expected, err := requiredVerifiedContentTargets(state.role, state.controlConfig, state.executorConfig)
	if err != nil {
		return errors.Join(ErrVerifiedContentUnavailable, err)
	}
	if len(state.contents) != len(expected) {
		return ErrVerifiedContentUnavailable
	}
	for key, target := range expected {
		content, exists := state.contents[key]
		if !exists || content.Validate() != nil || content.state.file.root != target.root ||
			content.state.file.role != target.role || !strings.EqualFold(content.state.file.path, target.path) ||
			!windowsPathEqual(content.state.file.absolutePath, target.absolutePath) ||
			content.state.file.sha256 != target.sha256 || content.state.file.size > target.maximumBytes {
			return ErrVerifiedContentUnavailable
		}
		manifestFile, exists := state.manifest.LookupFile(target.root, target.path)
		if !exists || manifestFile.Role != target.role || manifestFile.SHA256 != target.sha256 ||
			manifestFile.Size != fmt.Sprintf("%d", content.state.file.size) {
			return ErrVerifiedContentUnavailable
		}
		matched := false
		for _, file := range state.files {
			if manifestFileKey(file.root, file.path) == key &&
				file.role == content.state.file.role && file.sha256 == content.state.file.sha256 &&
				file.size == content.state.file.size && sameObjectEvidence(file.object, content.state.file.object) {
				matched = true
				break
			}
		}
		if !matched {
			return ErrVerifiedContentUnavailable
		}
	}
	return nil
}

func validateRelativeContentPath(path string) error {
	if path == "" || strings.HasPrefix(path, `\`) || strings.Contains(path, "/") || strings.Contains(path, ":") {
		return errors.New("content path is not a canonical relative Windows path")
	}
	for _, component := range strings.Split(path, `\`) {
		if err := validatePathComponent(component); err != nil {
			return err
		}
	}
	return nil
}

func cloneFileSnapshot(value FileSnapshot) FileSnapshot {
	value.object = cloneObjectEvidence(value.object)
	if value.authenticode != nil {
		copy := *value.authenticode
		value.authenticode = &copy
	}
	return value
}

func cloneVerifiedContent(value VerifiedContent) VerifiedContent {
	if value.state == nil {
		return VerifiedContent{}
	}
	return VerifiedContent{state: &verifiedContentState{
		file: cloneFileSnapshot(value.state.file),
		data: append([]byte(nil), value.state.data...),
	}}
}

func cloneVerifiedContents(values map[string]VerifiedContent) map[string]VerifiedContent {
	if values == nil {
		return nil
	}
	result := make(map[string]VerifiedContent, len(values))
	for key, value := range values {
		result[key] = cloneVerifiedContent(value)
	}
	return result
}
