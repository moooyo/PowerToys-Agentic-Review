package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outertrust"
	outertrustgenerator "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outertrust/generator"
	releasegenerator "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile/generator"
)

const generatedFileName = outertrustgenerator.GeneratedFileName

type options struct {
	spkiPath           string
	approvedDigestPath string
	outputPath         string
	check              bool
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "outertrustgen: %v\n", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	flags := flag.NewFlagSet("outertrustgen", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var value options
	flags.StringVar(&value.spkiPath, "spki", "", "canonical P-256 signer SPKI DER path")
	flags.StringVar(&value.approvedDigestPath, "approved-sha256-file", "", "independently approved exact SHA-256 file")
	flags.StringVar(&value.outputPath, "output", "", "generated Go source path")
	flags.BoolVar(&value.check, "check", false, "verify that output is current without writing")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || value.spkiPath == "" || value.approvedDigestPath == "" || value.outputPath == "" {
		return fmt.Errorf("-spki, -approved-sha256-file, and -output are required; positional arguments are not accepted")
	}
	if filepath.Base(value.outputPath) != generatedFileName {
		return fmt.Errorf("-output must end with %s", generatedFileName)
	}
	spkiPath, err := filepath.Abs(value.spkiPath)
	if err != nil {
		return fmt.Errorf("resolve SPKI path: %w", err)
	}
	digestPath, err := filepath.Abs(value.approvedDigestPath)
	if err != nil {
		return fmt.Errorf("resolve approved digest path: %w", err)
	}
	outputPath, err := filepath.Abs(value.outputPath)
	if err != nil {
		return fmt.Errorf("resolve output path: %w", err)
	}
	if pathsEqual(spkiPath, digestPath) || pathsEqual(spkiPath, outputPath) || pathsEqual(digestPath, outputPath) {
		return fmt.Errorf("SPKI, approved digest, and output must be distinct files")
	}
	spki, err := releasegenerator.ReadRegularBounded(spkiPath, int64(outertrust.MaximumSPKIBytes))
	if err != nil {
		return err
	}
	digestDocument, err := releasegenerator.ReadRegularBounded(digestPath, 64)
	if err != nil {
		return err
	}
	if len(digestDocument) != 64 {
		return fmt.Errorf("approved SHA-256 file must contain exactly 64 bytes without a newline")
	}
	generated, err := outertrustgenerator.Render(spki, string(digestDocument))
	if err != nil {
		return err
	}
	if value.check {
		return releasegenerator.CheckExactRegular(
			outputPath,
			generated,
			int64(outertrustgenerator.MaximumGeneratedSourceBytes),
		)
	}
	if err := releasegenerator.WriteExclusiveRegular(outputPath, generated, 0o644); err != nil {
		return err
	}
	return releasegenerator.CheckExactRegular(
		outputPath,
		generated,
		int64(outertrustgenerator.MaximumGeneratedSourceBytes),
	)
}

func pathsEqual(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}
