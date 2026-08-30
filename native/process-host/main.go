package main

import (
	"context"
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
)

func main() {
	var stdio bool
	var maximumConcurrentRequests int
	flag.BoolVar(&stdio, "stdio", false, "serve the ProcessHost NDJSON protocol on standard input and output")
	flag.IntVar(&maximumConcurrentRequests, "max-concurrent-requests", 4, "maximum number of concurrently managed process trees")
	flag.Parse()

	logger := log.New(os.Stderr, "AgenticReview.ProcessHost: ", log.Ldate|log.Ltime|log.LUTC)
	if !stdio {
		logger.Print("the --stdio flag is required")
		os.Exit(2)
	}
	if flag.NArg() != 0 {
		logger.Print("positional arguments are not supported")
		os.Exit(2)
	}
	if !validMaximumConcurrentRequests(maximumConcurrentRequests) {
		logger.Printf("--max-concurrent-requests must be between %d and %d", minimumConcurrentRequests, maximumConcurrentRequests)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	server := host.NewServer(os.Stdin, os.Stdout, logger, maximumConcurrentRequests)
	if err := server.Run(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func validMaximumConcurrentRequests(value int) bool {
	return value >= minimumConcurrentRequests && value <= maximumConcurrentRequests
}
