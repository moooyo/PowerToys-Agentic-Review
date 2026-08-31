package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile/generator"
)

const generatedFileName = generator.GeneratedFileName

type options struct {
	input          string
	output         string
	expectedSHA256 string
	check          bool
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "releaseprofilegen: %v\n", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	flags := flag.NewFlagSet("releaseprofilegen", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var value options
	flags.StringVar(&value.input, "input", "", "canonical compiled release-template path")
	flags.StringVar(&value.output, "output", "", "generated Go source path")
	flags.StringVar(&value.expectedSHA256, "expected-sha256", "", "expected canonical template SHA-256")
	flags.BoolVar(&value.check, "check", false, "verify that output is current without writing")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || value.input == "" || value.output == "" || value.expectedSHA256 == "" {
		return fmt.Errorf("-input, -output, and -expected-sha256 are required; positional arguments are not accepted")
	}
	if filepath.Base(value.output) != generatedFileName {
		return fmt.Errorf("-output must end with %s", generatedFileName)
	}
	inputPath, err := filepath.Abs(value.input)
	if err != nil {
		return fmt.Errorf("resolve input: %w", err)
	}
	outputPath, err := filepath.Abs(value.output)
	if err != nil {
		return fmt.Errorf("resolve output: %w", err)
	}
	if strings.EqualFold(filepath.Clean(inputPath), filepath.Clean(outputPath)) {
		return fmt.Errorf("input and output must be different files")
	}
	document, err := generator.ReadRegularBounded(inputPath, int64(releaseprofile.MaximumDocumentBytes))
	if err != nil {
		return err
	}
	generated, err := renderGeneratedSource(document, value.expectedSHA256)
	if err != nil {
		return err
	}
	if value.check {
		return generator.CheckExactRegular(
			outputPath,
			generated,
			int64(generator.MaximumGeneratedSourceBytes),
		)
	}
	if err := generator.WriteExclusiveRegular(outputPath, generated, 0o644); err != nil {
		return err
	}
	return generator.CheckExactRegular(
		outputPath,
		generated,
		int64(generator.MaximumGeneratedSourceBytes),
	)
}

func renderGeneratedSource(document []byte, expectedSHA256 string) ([]byte, error) {
	return generator.Render(document, expectedSHA256)
}
