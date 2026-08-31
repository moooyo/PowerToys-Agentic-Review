package preflight

import (
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
)

func cloneConfig(value config.Config) config.Config {
	result := value
	if value.Node.Environment != nil {
		result.Node.Environment = make(map[string]string, len(value.Node.Environment))
		for name, environmentValue := range value.Node.Environment {
			result.Node.Environment[name] = environmentValue
		}
	}
	if value.Control != nil {
		control := *value.Control
		result.Control = &control
	}
	if value.Executor != nil {
		executor := *value.Executor
		result.Executor = &executor
	}
	return result
}

func cloneObject(value secureconfig.ObjectEvidence) secureconfig.ObjectEvidence {
	value.Evidence.Security.SelfRelativeDescriptor = append(
		[]byte(nil),
		value.Evidence.Security.SelfRelativeDescriptor...,
	)
	return value
}

func cloneRead(value secureconfig.Result) secureconfig.Result {
	result := value
	result.Data = append([]byte(nil), value.Data...)
	result.File = cloneObject(value.File)
	result.Ancestors = make([]secureconfig.ObjectEvidence, len(value.Ancestors))
	for index, ancestor := range value.Ancestors {
		result.Ancestors[index] = cloneObject(ancestor)
	}
	return result
}

func cloneManifest(value releasemanifest.Manifest) releasemanifest.Manifest {
	value.Files = append([]releasemanifest.File(nil), value.Files...)
	return value
}

func cloneRoot(value VerifiedRoot) VerifiedRoot {
	value.Object = cloneObject(value.Object)
	return value
}

func cloneRoots(values []VerifiedRoot) []VerifiedRoot {
	result := make([]VerifiedRoot, len(values))
	for index, value := range values {
		result[index] = cloneRoot(value)
	}
	return result
}

func cloneFile(value VerifiedFile) VerifiedFile {
	value.Object = cloneObject(value.Object)
	return value
}

func cloneFiles(values []VerifiedFile) []VerifiedFile {
	result := make([]VerifiedFile, len(values))
	for index, value := range values {
		result[index] = cloneFile(value)
	}
	return result
}

func cloneProfile(value ReleaseProfile) ReleaseProfile {
	value.Dependencies = append(
		[]releasemanifest.FileBindingRequirement(nil),
		value.Dependencies...,
	)
	return value
}

func cloneConfigurationEvidence(value ConfigurationEvidence) ConfigurationEvidence {
	value.Configuration = cloneConfig(value.Configuration)
	value.Read = cloneRead(value.Read)
	return value
}

func cloneManifestEvidence(value ManifestEvidence) ManifestEvidence {
	value.Manifest = cloneManifest(value.Manifest)
	value.Read = cloneRead(value.Read)
	return value
}

func cloneBindings(values []FileBindingEvidence) []FileBindingEvidence {
	result := make([]FileBindingEvidence, len(values))
	for index, value := range values {
		value.VerifiedFile = cloneFile(value.VerifiedFile)
		result[index] = value
	}
	return result
}

func cloneControlCredentials(value *ControlCredentialEvidence) *ControlCredentialEvidence {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
