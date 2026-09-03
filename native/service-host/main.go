package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"

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
	command, code, runCommand := prepareCommand(arguments, standardOutput, standardError)
	if !runCommand {
		return code
	}
	return runPreparedCommand(command, standardError, platform.NewHost(), newServiceRunner())
}

type serviceRunner interface {
	RunIfService(commandLine, platform.Host) (bool, error)
}

func runWithDependencies(
	arguments []string,
	standardOutput io.Writer,
	standardError io.Writer,
	host platform.Host,
	services serviceRunner,
) int {
	command, code, runCommand := prepareCommand(arguments, standardOutput, standardError)
	if !runCommand {
		return code
	}
	return runPreparedCommand(command, standardError, host, services)
}

func prepareCommand(
	arguments []string,
	standardOutput io.Writer,
	standardError io.Writer,
) (commandLine, int, bool) {
	command, err := parseCommandLine(arguments)
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "AgenticReview.ServiceHost: %v\n", err)
		return commandLine{}, exitInvalidConfig, false
	}
	if command.showVersion {
		_, _ = fmt.Fprintf(standardOutput, "AgenticReview.ServiceHost %s\n", version)
		return commandLine{}, exitSuccess, false
	}
	return command, exitSuccess, true
}

func runPreparedCommand(
	command commandLine,
	standardError io.Writer,
	host platform.Host,
	services serviceRunner,
) int {
	handled, err := services.RunIfService(command, host)
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "AgenticReview.ServiceHost: Windows service failed: %v\n", err)
		return exitPreflight
	}
	if handled {
		return exitSuccess
	}

	// The non-SCM path exists only for an explicit local developer invocation.
	// Service detection failures above never fall back to interactive execution.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := host.Run(ctx, platform.BootstrapOptions{
		ActualBootstrapPath: command.configPath,
	}); err != nil {
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
