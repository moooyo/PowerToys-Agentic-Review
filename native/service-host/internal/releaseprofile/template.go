package releaseprofile

import "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"

// TemplateOptions contains the release-controlled inputs used to construct one canonical
// compiled release template. Schema, profile, compatibility, and ServiceHost identity are fixed
// by this package and cannot be supplied by callers.
type TemplateOptions struct {
	ReleaseID                                  string
	AuthenticodeLeafSignerCertificateDERSHA256 string
	Dependencies                               []Dependency
}

// BuildTemplate constructs the exact canonical document embedded by the controlled
// ServiceHost release build.
func BuildTemplate(options TemplateOptions) ([]byte, error) {
	value := templateDocument{
		AuthenticodeLeafSignerCertificateDERSHA256: options.AuthenticodeLeafSignerCertificateDERSHA256,
		Compatibility: releasemanifest.RequiredCompatibility(),
		Dependencies:  append([]Dependency(nil), options.Dependencies...),
		ProfileID:     ProductionProfileID,
		ReleaseID:     options.ReleaseID,
		SchemaVersion: SchemaVersion,
		ServiceHost: SelfRequirement{
			Root: releasemanifest.RootInstallation,
			Path: ServiceHostRelativePath,
			Role: releasemanifest.RoleServiceHost,
		},
	}
	normalized, err := normalizeDocument(value)
	if err != nil {
		return nil, err
	}
	return marshalNormalized(normalized)
}
