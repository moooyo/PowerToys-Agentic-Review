package dataroot

import (
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
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

func cloneWinfileEvidence(value winfile.Evidence) winfile.Evidence {
	value.Security.SelfRelativeDescriptor = append(
		[]byte(nil),
		value.Security.SelfRelativeDescriptor...,
	)
	return value
}

func cloneObjectSnapshot(value ObjectSnapshot) ObjectSnapshot {
	value.evidence = cloneWinfileEvidence(value.evidence)
	return value
}

func cloneObjectSnapshotSlice(values []ObjectSnapshot) []ObjectSnapshot {
	result := append([]ObjectSnapshot(nil), values...)
	for index := range result {
		result[index] = cloneObjectSnapshot(result[index])
	}
	return result
}

func cloneRootSnapshot(value RootSnapshot) RootSnapshot {
	value.ancestors = cloneObjectSnapshotSlice(value.ancestors)
	value.object = cloneObjectSnapshot(value.object)
	return value
}

func cloneRuntimePaths(values []RuntimePathSnapshot) []RuntimePathSnapshot {
	result := append([]RuntimePathSnapshot(nil), values...)
	for index := range result {
		result[index].object = cloneObjectSnapshot(result[index].object)
	}
	return result
}

func cloneInstallationBindings(values []InstallationRootBinding) []InstallationRootBinding {
	result := append([]InstallationRootBinding(nil), values...)
	for index := range result {
		result[index].ancestorPaths = append([]string(nil), result[index].ancestorPaths...)
		result[index].ancestors = append([]winfile.FileIdentity(nil), result[index].ancestors...)
	}
	return result
}
