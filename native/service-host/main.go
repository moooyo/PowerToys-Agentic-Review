package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/platform"
)

const version = "0.1.0-dev"

const (
	exitSuccess       = 0
	exitInvalidConfig = 2
	exitPreflight     = 10
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, standardOutput io.Writer, standardError io.Writer) int {
	command, err := parseCommandLine(arguments)
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "AgenticReview.ServiceHost: %v\n", err)
		return exitInvalidConfig
	}
	if command.showVersion {
		_, _ = fmt.Fprintf(standardOutput, "AgenticReview.ServiceHost %s\n", version)
		return exitSuccess
	}

	configuration, err := config.Load(command.configPath)
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "AgenticReview.ServiceHost: configuration rejected: %v\n", err)
		return exitInvalidConfig
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := platform.NewHost().Run(ctx, configuration); err != nil {
		_, _ = fmt.Fprintf(standardError, "AgenticReview.ServiceHost: preflight failed: %v\n", err)
		return exitPreflight
	}
	return exitSuccess
}

type commandLine struct {
	configPath  string
	showVersion bool
}

func parseCommandLine(arguments []string) (commandLine, error) {
	if len(arguments) == 1 && arguments[0] == "--version" {
		return commandLine{showVersion: true}, nil
	}
	if len(arguments) == 2 && arguments[0] == "--config" {
		if strings.TrimSpace(arguments[1]) == "" {
			return commandLine{}, errors.New("--config requires a non-empty path")
		}
		return commandLine{configPath: arguments[1]}, nil
	}
	if len(arguments) == 1 && strings.HasPrefix(arguments[0], "--config=") {
		path := strings.TrimPrefix(arguments[0], "--config=")
		if strings.TrimSpace(path) == "" {
			return commandLine{}, errors.New("--config requires a non-empty path")
		}
		return commandLine{configPath: path}, nil
	}
	return commandLine{}, errors.New("expected exactly --config <path> or --version")
}
