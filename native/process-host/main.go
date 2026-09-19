package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/host"
)

const (
	minimumConcurrentRequests = 1
	maximumConcurrentRequests = 64
	invalidArgumentsExitCode  = 2
	duplicateInstanceExitCode = 3
)

type processHostOptions struct {
	stdio                     bool
	maximumConcurrentRequests int
	instanceKey               string
	interactiveStdin          bool
	namedJobRecovery          bool
}

func main() {
	options := registerProcessHostFlags(flag.CommandLine)
	flag.Parse()

	logger := log.New(os.Stderr, "AgenticReview.ProcessHost: ", log.Ldate|log.Ltime|log.LUTC)
	if !options.stdio {
		logger.Print("the --stdio flag is required")
		os.Exit(invalidArgumentsExitCode)
	}
	if flag.NArg() != 0 {
		logger.Print("positional arguments are not supported")
		os.Exit(invalidArgumentsExitCode)
	}
	if !validMaximumConcurrentRequests(options.maximumConcurrentRequests) {
		logger.Printf("--max-concurrent-requests must be between %d and %d", minimumConcurrentRequests, maximumConcurrentRequests)
		os.Exit(invalidArgumentsExitCode)
	}
	if !host.ValidInstanceKey(options.instanceKey) {
		logger.Print("--instance-key must be exactly 64 lowercase hexadecimal characters")
		os.Exit(invalidArgumentsExitCode)
	}

	releaseInstanceMutex, err := host.AcquireGlobalInstanceMutex(options.instanceKey)
	if err != nil {
		if errors.Is(err, host.ErrInstanceMutexAlreadyHeld) {
			logger.Print("another worker instance already owns this ProcessHost instance key")
			os.Exit(duplicateInstanceExitCode)
		}
		logger.Printf("unable to acquire ProcessHost instance mutex: %v", err)
		os.Exit(1)
	}
	defer func() {
		if releaseErr := releaseInstanceMutex(); releaseErr != nil {
			logger.Printf("unable to release ProcessHost instance mutex: %v", releaseErr)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	server := host.NewServerWithInteractiveInput(os.Stdin, os.Stdout, logger, options.maximumConcurrentRequests, options.interactiveStdin)
	if options.namedJobRecovery {
		if err := server.EnableNamedJobRecovery(options.instanceKey); err != nil {
			logger.Printf("unable to establish ProcessHost recovery ownership: %v", err)
			os.Exit(1)
		}
	}
	if err := server.Run(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func registerProcessHostFlags(flags *flag.FlagSet) *processHostOptions {
	options := &processHostOptions{}
	flags.BoolVar(&options.stdio, "stdio", false, "serve the ProcessHost NDJSON protocol on standard input and output")
	flags.IntVar(&options.maximumConcurrentRequests, "max-concurrent-requests", 4, "maximum number of concurrently managed process trees")
	flags.StringVar(&options.instanceKey, "instance-key", "", "lowercase 64-hex worker instance key for cross-process singleton enforcement")
	flags.BoolVar(&options.interactiveStdin, "interactive-stdin", false, "enable the opt-in interactive standard input protocol extension")
	flags.BoolVar(&options.namedJobRecovery, "named-job-recovery", false, "contain the Host and all managed process trees in a recoverable named Job Object")
	return options
}

func validMaximumConcurrentRequests(value int) bool {
	return value >= minimumConcurrentRequests && value <= maximumConcurrentRequests
}
