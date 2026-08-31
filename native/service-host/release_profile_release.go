//go:build agenticreview_release

package main

import "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"

func init() {
	mustValidateCompiledReleaseProfile()
}

// Platform startup independently loads and consumes the same compiled
// constants. This bridge only makes their absence or corruption fatal before
// main starts and does not expose a second authority channel.
func mustValidateCompiledReleaseProfile() {
	evidence, err := releaseprofile.Production()
	if err != nil {
		panic("load compiled ServiceHost release profile: " + err.Error())
	}
	if err := evidence.Validate(); err != nil {
		panic("validate compiled ServiceHost release profile: " + err.Error())
	}
}
