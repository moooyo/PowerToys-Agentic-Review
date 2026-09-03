//go:build !windows

package main

import "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/platform"

type interactiveOnlyServiceRunner struct{}

func newServiceRunner() serviceRunner {
	return interactiveOnlyServiceRunner{}
}

func (interactiveOnlyServiceRunner) RunIfService(commandLine, platform.Host) (bool, error) {
	return false, nil
}
