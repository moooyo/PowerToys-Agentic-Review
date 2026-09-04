//go:build windows

package platform

import (
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestWindowsCompositionOnlyExecutorReportsReadyBeforePeer(t *testing.T) {
	if !(&windowsComposition{role: config.RoleExecutor}).reportsReadyBeforePeer() {
		t.Fatal("Executor must report ready before peer connection so SCM can start Control")
	}
	if (&windowsComposition{role: config.RoleControl}).reportsReadyBeforePeer() {
		t.Fatal("Control must not report ready before its peer and runtime are constructed")
	}
}
