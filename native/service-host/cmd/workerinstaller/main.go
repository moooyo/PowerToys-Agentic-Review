package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workerinstaller"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workerpackage"
)

const (
	manifestFileName       = "worker-package.json"
	signatureFileName      = "worker-package.sig"
	maximumInstallConfig   = 8 * 1024
	exitSuccess            = 0
	exitInvalidInput       = 2
	exitInstallationFailed = 10
)

// Set at release build time with -ldflags -X main.compiledReleasePublicKeyHex=<64 lowercase hex>.
var compiledReleasePublicKeyHex string

type installConfig struct {
	ServerOrigin string `json:"serverOrigin"`
	WorkerNodeID string `json:"workerNodeId"`
	Token        string `json:"token"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

func run(arguments []string, standardError io.Writer) int {
	flags := flag.NewFlagSet("workerinstaller", flag.ContinueOnError)
	flags.SetOutput(standardError)
	packageRoot := flags.String("package", "", "directory containing the Worker package")
	configPath := flags.String("config", "", "local install input JSON containing Server origin, Worker node ID, and Token")
	if err := flags.Parse(arguments); err != nil {
		return exitInvalidInput
	}
	if flags.NArg() != 0 || *packageRoot == "" || *configPath == "" {
		_, _ = fmt.Fprintln(standardError, "workerinstaller: exactly -package and -config are required")
		return exitInvalidInput
	}

	publicKey, err := releasePublicKey()
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "workerinstaller: release trust is unavailable: %v\n", err)
		return exitInstallationFailed
	}
	localInput, err := readInstallConfig(*configPath)
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "workerinstaller: invalid install config\n")
		return exitInvalidInput
	}
	manifest, err := readBoundedFile(filepath.Join(*packageRoot, manifestFileName), workerpackage.MaximumManifestBytes)
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "workerinstaller: read package manifest: %v\n", err)
		return exitInvalidInput
	}
	signature, err := readBoundedFile(filepath.Join(*packageRoot, signatureFileName), 64)
	if err != nil || len(signature) != 64 {
		_, _ = fmt.Fprintln(standardError, "workerinstaller: package signature must be exactly 64 bytes")
		return exitInvalidInput
	}
	architecture, err := currentArchitecture()
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "workerinstaller: %v\n", err)
		return exitInstallationFailed
	}
	system, err := workerinstaller.NewSystem()
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "workerinstaller: initialize Windows installer: %v\n", err)
		return exitInstallationFailed
	}
	err = workerinstaller.InstallClean(system, workerinstaller.Inputs{
		SourceRoot:          *packageRoot,
		ManifestBytes:       manifest,
		RawSignature:        signature,
		ReleasePublicKey:    publicKey,
		ServerOrigin:        localInput.ServerOrigin,
		WorkerNodeID:        localInput.WorkerNodeID,
		Token:               localInput.Token,
		CurrentArchitecture: architecture,
	})
	if err != nil {
		_, _ = fmt.Fprintf(standardError, "workerinstaller: installation failed: %v\n", err)
		return exitInstallationFailed
	}
	return exitSuccess
}

func releasePublicKey() ([]byte, error) {
	if len(compiledReleasePublicKeyHex) != 64 {
		return nil, errors.New("compiled Ed25519 public key is missing")
	}
	for _, character := range compiledReleasePublicKeyHex {
		if character >= '0' && character <= '9' || character >= 'a' && character <= 'f' {
			continue
		}
		return nil, errors.New("compiled Ed25519 public key is not lowercase hexadecimal")
	}
	publicKey, err := hex.DecodeString(compiledReleasePublicKeyHex)
	if err != nil || len(publicKey) != 32 {
		return nil, errors.New("compiled Ed25519 public key is invalid")
	}
	return publicKey, nil
}

func readInstallConfig(path string) (installConfig, error) {
	document, err := readBoundedFile(path, maximumInstallConfig)
	if err != nil || bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return installConfig{}, errors.New("install config must be bounded UTF-8 JSON without a byte-order mark")
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	var value installConfig
	if err := decoder.Decode(&value); err != nil {
		return installConfig{}, errors.New("install config must be one strict JSON object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return installConfig{}, errors.New("install config contains trailing content")
	}
	if value.ServerOrigin == "" || value.WorkerNodeID == "" || value.Token == "" {
		return installConfig{}, errors.New("install config is incomplete")
	}
	return value, nil
}

func readBoundedFile(path string, maximum int) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > int64(maximum) {
		_ = file.Close()
		return nil, errors.New("input must be a bounded regular file")
	}
	document, readErr := io.ReadAll(io.LimitReader(file, int64(maximum)+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(document) == 0 || len(document) > maximum {
		return nil, errors.Join(readErr, closeErr, errors.New("read bounded input"))
	}
	return document, nil
}

func currentArchitecture() (workerpackage.Architecture, error) {
	switch runtime.GOARCH {
	case "amd64":
		return workerpackage.ArchitectureAMD64, nil
	case "arm64":
		return workerpackage.ArchitectureARM64, nil
	default:
		return "", fmt.Errorf("unsupported Windows architecture %q", runtime.GOARCH)
	}
}
