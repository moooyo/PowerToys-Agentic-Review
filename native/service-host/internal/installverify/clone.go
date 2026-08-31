package installverify

import (
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
)

func cloneConfig(value config.Config) config.Config {
	value.Node.Environment = cloneStringMap(value.Node.Environment)
	if value.Control != nil {
		copy := *value.Control
		value.Control = &copy
	}
	if value.Executor != nil {
		copy := *value.Executor
		value.Executor = &copy
	}
	return value
}

func cloneStringMap(value map[string]string) map[string]string {
	if value == nil {
		return nil
	}
	copy := make(map[string]string, len(value))
	for key, item := range value {
		copy[key] = item
	}
	return copy
}

func cloneManifest(value releasemanifest.Manifest) releasemanifest.Manifest {
	value.Files = append([]releasemanifest.File(nil), value.Files...)
	return value
}

func cloneObjectEvidence(value secureconfig.ObjectEvidence) secureconfig.ObjectEvidence {
	value.Evidence.Security.SelfRelativeDescriptor = append(
		[]byte(nil),
		value.Evidence.Security.SelfRelativeDescriptor...,
	)
	return value
}

func cloneObjectEvidenceSlice(values []secureconfig.ObjectEvidence) []secureconfig.ObjectEvidence {
	result := append([]secureconfig.ObjectEvidence(nil), values...)
	for index := range result {
		result[index] = cloneObjectEvidence(result[index])
	}
	return result
}

func cloneSecureResult(value secureconfig.Result) secureconfig.Result {
	value.Data = append([]byte(nil), value.Data...)
	value.File = cloneObjectEvidence(value.File)
	value.Ancestors = append([]secureconfig.ObjectEvidence(nil), value.Ancestors...)
	for index := range value.Ancestors {
		value.Ancestors[index] = cloneObjectEvidence(value.Ancestors[index])
	}
	return value
}

func cloneRoots(values []RootSnapshot) []RootSnapshot {
	result := append([]RootSnapshot(nil), values...)
	for index := range result {
		result[index].ancestors = cloneObjectEvidenceSlice(result[index].ancestors)
		result[index].object = cloneObjectEvidence(result[index].object)
	}
	return result
}

func cloneFiles(values []FileSnapshot) []FileSnapshot {
	result := append([]FileSnapshot(nil), values...)
	for index := range result {
		result[index].object = cloneObjectEvidence(result[index].object)
		if result[index].authenticode != nil {
			copy := *result[index].authenticode
			result[index].authenticode = &copy
		}
	}
	return result
}
