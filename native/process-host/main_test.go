package main

import (
	"flag"
	"io"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/host"
)

func TestProcessHostFlagsInteractiveStdin(t *testing.T) {
	instanceKey := strings.Repeat("a", 64)
	tests := []struct {
		name     string
		argument string
		enabled  bool
		wantErr  bool
	}{
		{name: "legacy default"},
		{name: "enabled", argument: "--interactive-stdin", enabled: true},
		{name: "explicit true", argument: "--interactive-stdin=true", enabled: true},
		{name: "explicit false", argument: "--interactive-stdin=false"},
		{name: "invalid boolean", argument: "--interactive-stdin=invalid", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			flags := flag.NewFlagSet(test.name, flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			options := registerProcessHostFlags(flags)
			arguments := []string{"--stdio", "--instance-key=" + instanceKey}
			if test.argument != "" {
				arguments = append(arguments, test.argument)
			}
			err := flags.Parse(arguments)
			if (err != nil) != test.wantErr {
				t.Fatalf("Parse() error = %v, want error %t", err, test.wantErr)
			}
			if test.wantErr {
				return
			}
			if options.interactiveStdin != test.enabled {
				t.Fatalf("interactiveStdin = %t, want %t", options.interactiveStdin, test.enabled)
			}
			if !options.stdio || options.maximumConcurrentRequests != 4 || options.instanceKey != instanceKey || flags.NArg() != 0 {
				t.Fatalf("legacy options changed: %+v, positional arguments = %v", options, flags.Args())
			}
		})
	}
}

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
