package main

import (
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/host"
)

func TestValidMaximumConcurrentRequests(t *testing.T) {
	for _, value := range []int{minimumConcurrentRequests, 4, maximumConcurrentRequests} {
		if !validMaximumConcurrentRequests(value) {
			t.Fatalf("value %d should be valid", value)
		}
	}
	for _, value := range []int{minimumConcurrentRequests - 1, maximumConcurrentRequests + 1} {
		if validMaximumConcurrentRequests(value) {
			t.Fatalf("value %d should be invalid", value)
		}
	}
}

func TestValidInstanceKey(t *testing.T) {
	valid := strings.Repeat("a", 64)
	if !host.ValidInstanceKey(valid) {
		t.Fatalf("instance key %q should be valid", valid)
	}

	for _, invalid := range []string{"", strings.Repeat("a", 63), strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		if host.ValidInstanceKey(invalid) {
			t.Fatalf("instance key %q should be invalid", invalid)
		}
	}
}
