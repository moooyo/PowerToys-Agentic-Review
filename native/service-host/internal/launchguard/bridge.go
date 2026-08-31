package launchguard

import "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"

// launchVerifiedNode is the repository's sole production bridge to the raw
// path-based winprocess launcher. An architecture test enforces this boundary.
func launchVerifiedNode(spec winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
	return winprocess.LaunchNode(spec)
}
