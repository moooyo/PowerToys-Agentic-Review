// Command servicehostrelease is the only supported production build path for
// AgenticReview.ServiceHost.exe.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"debug/pe"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile/generator"
)

const (
	serviceHostModulePath     = "native/service-host"
	serviceHostOutputName     = "AgenticReview.ServiceHost.exe"
	expectedDigestBytes       = int64(sha256.Size * 2)
	maximumToolBytes          = int64(512 * 1024 * 1024)
	totalBuildTimeout         = 20 * time.Minute
	gitStageTimeout           = 2 * time.Minute
	moduleVerifyTimeout       = 3 * time.Minute
	compileStageTimeout       = 12 * time.Minute
	childWaitDelay            = 5 * time.Second
	maximumCommandOutputBytes = 4 * 1024 * 1024
)

type buildOptions struct {
	templatePath       string
	expectedDigestPath string
	outputPath         string
	architecture       string
	goToolPath         string
	goToolDigestPath   string
	gitToolPath        string
	gitToolDigestPath  string
	moduleCachePath    string
	buildRootPath      string
}

type verifiedTool struct {
	path           string
	digestPath     string
	expectedDigest string
}

type verifiedToolchain struct {
	goTool          verifiedTool
	gitTool         verifiedTool
	moduleCache     string
	gitHooksPath    string
	gitGlobalConfig string
	gitHome         string
}

type commandRequest struct {
	name               string
	arguments          []string
	directory          string
	environment        []string
	timeout            time.Duration
	maximumOutputBytes int64
}

var errCommandOutputLimit = errors.New("command output exceeded its configured limit")

type boundedCommandOutput struct {
	mu        sync.Mutex
	buffer    bytes.Buffer
	remaining int64
	exceeded  bool
}

func (output *boundedCommandOutput) Write(value []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.remaining <= 0 {
		output.exceeded = true
		return 0, errCommandOutputLimit
	}
	accepted := len(value)
	if int64(accepted) > output.remaining {
		accepted = int(output.remaining)
		output.exceeded = true
	}
	_, _ = output.buffer.Write(value[:accepted])
	output.remaining -= int64(accepted)
	if accepted != len(value) {
		return accepted, errCommandOutputLimit
	}
	return accepted, nil
}

func (output *boundedCommandOutput) Result() ([]byte, bool) {
	output.mu.Lock()
	defer output.mu.Unlock()
	return append([]byte(nil), output.buffer.Bytes()...), output.exceeded
}

type buildDependencies struct {
	getwd       func() (string, error)
	runCommand  func(context.Context, commandRequest) ([]byte, error)
	makeTempDir func(string, string) (string, error)
	removeAll   func(string) error
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx, os.Args[1:], productionDependencies()); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "servicehostrelease: %v\n", err)
		os.Exit(1)
	}
}

func productionDependencies() buildDependencies {
	return buildDependencies{
		getwd: os.Getwd,
		runCommand: func(ctx context.Context, request commandRequest) ([]byte, error) {
			if request.timeout <= 0 || request.maximumOutputBytes <= 0 {
				return nil, errors.New("command stage timeout and output limit are required")
			}
			stageContext, cancel := context.WithTimeout(ctx, request.timeout)
			defer cancel()
			command := exec.CommandContext(stageContext, request.name, request.arguments...)
			command.Dir = request.directory
			command.Env = request.environment
			command.WaitDelay = childWaitDelay
			output := &boundedCommandOutput{remaining: request.maximumOutputBytes}
			command.Stdout = output
			command.Stderr = output
			runErr := command.Run()
			value, exceeded := output.Result()
			if exceeded {
				return value, errCommandOutputLimit
			}
			return value, runErr
		},
		makeTempDir: os.MkdirTemp,
		removeAll:   os.RemoveAll,
	}
}

func run(ctx context.Context, arguments []string, dependencies buildDependencies) error {
	if ctx == nil {
		return errors.New("build context is required")
	}
	if dependencies.getwd == nil || dependencies.runCommand == nil ||
		dependencies.makeTempDir == nil || dependencies.removeAll == nil {
		return errors.New("build dependencies are incomplete")
	}
	buildContext, cancel := context.WithTimeout(ctx, totalBuildTimeout)
	defer cancel()
	flags := flag.NewFlagSet("servicehostrelease", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var options buildOptions
	flags.StringVar(&options.templatePath, "template", "", "absolute canonical release-template input")
	flags.StringVar(&options.expectedDigestPath, "expected-sha256-file", "", "absolute file containing the approved template SHA-256")
	flags.StringVar(&options.outputPath, "output", "", "absolute output path outside the repository")
	flags.StringVar(&options.architecture, "arch", "", "Windows architecture: amd64 or arm64")
	flags.StringVar(&options.goToolPath, "go-tool", "", "absolute read-only Go executable")
	flags.StringVar(&options.goToolDigestPath, "go-tool-sha256-file", "", "absolute file containing the approved Go executable SHA-256")
	flags.StringVar(&options.gitToolPath, "git-tool", "", "absolute read-only Git executable")
	flags.StringVar(&options.gitToolDigestPath, "git-tool-sha256-file", "", "absolute file containing the approved Git executable SHA-256")
	flags.StringVar(&options.moduleCachePath, "module-cache", "", "absolute verified read-only Go module cache")
	flags.StringVar(&options.buildRootPath, "build-root", "", "absolute pre-provisioned private build root")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || options.templatePath == "" || options.expectedDigestPath == "" ||
		options.outputPath == "" || options.architecture == "" || options.goToolPath == "" ||
		options.goToolDigestPath == "" || options.gitToolPath == "" ||
		options.gitToolDigestPath == "" || options.moduleCachePath == "" || options.buildRootPath == "" {
		return errors.New("all release template, toolchain, module-cache, output, and architecture flags are required; positional arguments are not accepted")
	}
	if options.architecture != "amd64" && options.architecture != "arm64" {
		return errors.New("-arch must be amd64 or arm64")
	}
	return buildRelease(buildContext, options, dependencies)
}

func buildRelease(ctx context.Context, options buildOptions, dependencies buildDependencies) (resultErr error) {
	toolchain, err := resolveToolchainInputs(options)
	if err != nil {
		return err
	}
	workingDirectory, err := dependencies.getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}
	if !filepath.IsAbs(options.buildRootPath) {
		return errors.New("controlled build root must be an absolute path")
	}
	buildRoot, err := resolveExistingDirectory(options.buildRootPath, "controlled build root")
	if err != nil {
		return err
	}
	if err := validatePublishDirectory(buildRoot); err != nil {
		return fmt.Errorf("validate controlled build root: %w", err)
	}
	buildRootAnchor, err := openDirectoryAnchor(buildRoot, "controlled build root")
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, buildRootAnchor.Close())
	}()
	temporaryDirectory, err := dependencies.makeTempDir(buildRoot, "agentic-review-servicehost-release-")
	if err != nil {
		return fmt.Errorf("create secure build directory: %w", err)
	}
	createdTemporaryDirectory := temporaryDirectory
	defer func() {
		if cleanupErr := dependencies.removeAll(createdTemporaryDirectory); cleanupErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("clean secure build directory: %w", cleanupErr))
		}
	}()
	resolvedTemporaryDirectory, err := resolveExistingDirectory(temporaryDirectory, "secure build directory")
	if err != nil {
		return err
	}
	temporaryDirectory = resolvedTemporaryDirectory
	if err := secureTemporaryDirectory(temporaryDirectory); err != nil {
		return err
	}
	temporaryAnchor, err := openDirectoryAnchor(temporaryDirectory, "secure build directory")
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, temporaryAnchor.Close())
	}()
	if err := buildRootAnchor.Verify(); err != nil {
		return err
	}
	entries, err := os.ReadDir(temporaryDirectory)
	if err != nil {
		return fmt.Errorf("secure build directory is not empty after protection: %w", err)
	}
	if len(entries) != 0 {
		return errors.New("secure build directory is not empty after protection")
	}
	privateGoCache := filepath.Join(temporaryDirectory, "go-build-cache")
	privateGoPath := filepath.Join(temporaryDirectory, "go-path")
	privateGoTemp := filepath.Join(temporaryDirectory, "go-temp")
	privateHome := filepath.Join(temporaryDirectory, "home")
	privateGitHooks := filepath.Join(temporaryDirectory, "git-hooks")
	for _, directory := range []string{privateGoCache, privateGoPath, privateGoTemp, privateHome, privateGitHooks} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			return fmt.Errorf("create private release-build directory: %w", err)
		}
	}
	if err := os.Chmod(privateGitHooks, 0o500); err != nil {
		return fmt.Errorf("make private Git hooks directory read-only: %w", err)
	}
	gitHooksAnchor, err := openDirectoryAnchor(privateGitHooks, "private Git hooks directory")
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, gitHooksAnchor.Close())
	}()
	privateGitConfig := filepath.Join(temporaryDirectory, "gitconfig")
	if err := generator.WriteExclusiveRegular(privateGitConfig, nil, 0o600); err != nil {
		return fmt.Errorf("create empty private Git configuration: %w", err)
	}
	if err := os.Chmod(privateGitConfig, 0o400); err != nil {
		return fmt.Errorf("make private Git configuration read-only: %w", err)
	}
	if err := checkReadOnlyInput(privateGitConfig, nil, 1); err != nil {
		return fmt.Errorf("verify empty private Git configuration: %w", err)
	}
	toolchain.gitHooksPath = privateGitHooks
	toolchain.gitGlobalConfig = privateGitConfig
	toolchain.gitHome = privateHome
	repositoryOutput, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.gitTool.path, arguments: gitArguments(toolchain, "rev-parse", "--show-toplevel"),
		directory: workingDirectory, environment: gitEnvironment(toolchain), timeout: gitStageTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("locate Git repository: %w: %s", err, boundedDiagnostic(repositoryOutput))
	}
	repositoryPath, err := parseRepositoryPath(repositoryOutput)
	if err != nil {
		return err
	}
	repositoryPath, err = resolveExistingDirectory(repositoryPath, "Git repository")
	if err != nil {
		return err
	}
	modulePath, err := resolveExistingDirectory(
		filepath.Join(repositoryPath, filepath.FromSlash(serviceHostModulePath)),
		"ServiceHost module",
	)
	if err != nil {
		return err
	}
	if !pathWithin(repositoryPath, modulePath) {
		return errors.New("ServiceHost module resolves outside the Git repository")
	}
	if pathWithin(repositoryPath, buildRoot) || pathWithin(buildRoot, repositoryPath) {
		return errors.New("controlled build root and Git repository must not overlap")
	}
	if pathWithin(repositoryPath, temporaryDirectory) {
		return errors.New("secure build directory must resolve outside the Git repository")
	}
	moduleCache, err := resolveExistingDirectory(toolchain.moduleCache, "read-only Go module cache")
	if err != nil {
		return err
	}
	toolchain.moduleCache = moduleCache
	for _, path := range []string{
		toolchain.goTool.path,
		toolchain.goTool.digestPath,
		toolchain.gitTool.path,
		toolchain.gitTool.digestPath,
		toolchain.moduleCache,
	} {
		if pathWithin(repositoryPath, path) {
			return errors.New("release toolchain and module cache must resolve outside the Git repository")
		}
	}
	if err := validateReadOnlyModuleCache(toolchain.moduleCache); err != nil {
		return err
	}
	checkoutGeneratedTarget := filepath.Join(
		modulePath,
		"internal",
		"releaseprofile",
		generator.GeneratedFileName,
	)
	if err := requireAbsent(checkoutGeneratedTarget, "physical generated release source"); err != nil {
		return err
	}
	if err := auditRepositoryGitPolicy(ctx, dependencies, repositoryPath, toolchain); err != nil {
		return err
	}
	if err := requireCleanCheckout(ctx, dependencies, repositoryPath, toolchain); err != nil {
		return err
	}
	sourceIdentity, err := captureGitSourceIdentity(ctx, dependencies, repositoryPath, toolchain)
	if err != nil {
		return err
	}
	sourceTree, err := captureSourceTree(ctx, dependencies, repositoryPath, toolchain, sourceIdentity)
	if err != nil {
		return err
	}
	sourceArchive, err := captureSourceArchive(ctx, dependencies, repositoryPath, toolchain, sourceIdentity)
	if err != nil {
		return err
	}

	inputPaths, err := resolveInputs(options)
	if err != nil {
		return err
	}
	outputPath, outputParent, err := resolveOutput(options.outputPath, repositoryPath)
	if err != nil {
		return err
	}
	outputAnchor, err := openDirectoryAnchor(outputParent, "release output directory")
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, outputAnchor.Close())
	}()
	templateDocument, err := readReadOnlyInput(
		inputPaths.template,
		int64(releaseprofile.MaximumDocumentBytes),
	)
	if err != nil {
		return fmt.Errorf("read release template: %w", err)
	}
	expectedDigestBytesValue, err := readReadOnlyInput(
		inputPaths.expectedDigest,
		expectedDigestBytes,
	)
	if err != nil {
		return fmt.Errorf("read expected template digest: %w", err)
	}
	if int64(len(expectedDigestBytesValue)) != expectedDigestBytes {
		return fmt.Errorf("expected template digest file must contain exactly %d bytes without a newline", expectedDigestBytes)
	}
	expectedDigest := string(expectedDigestBytesValue)
	generatedSource, err := generator.Render(templateDocument, expectedDigest)
	if err != nil {
		return err
	}
	generatedDigest := sha256.Sum256(generatedSource)

	snapshotModulePath, err := extractSourceSnapshot(ctx, sourceArchive, sourceTree, temporaryDirectory)
	if err != nil {
		return err
	}
	snapshotAnchor, err := openDirectoryAnchor(snapshotModulePath, "read-only source snapshot")
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, snapshotAnchor.Close())
	}()
	generatedTarget := filepath.Join(
		snapshotModulePath,
		"internal",
		"releaseprofile",
		generator.GeneratedFileName,
	)
	if err := requireAbsent(generatedTarget, "snapshot generated release source"); err != nil {
		return err
	}
	generatedBacking := filepath.Join(temporaryDirectory, generator.GeneratedFileName)
	overlayPath := filepath.Join(temporaryDirectory, "overlay.json")
	temporaryOutput := filepath.Join(temporaryDirectory, serviceHostOutputName)
	if err := generator.WriteExclusiveRegular(generatedBacking, generatedSource, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(generatedBacking, 0o400); err != nil {
		return fmt.Errorf("make generated release source read-only: %w", err)
	}
	if err := verifyGeneratedSource(generatedBacking, generatedSource, generatedDigest, templateDocument, expectedDigest); err != nil {
		return err
	}
	overlayDocument, err := json.Marshal(struct {
		Replace map[string]string `json:"Replace"`
	}{Replace: map[string]string{generatedTarget: generatedBacking}})
	if err != nil {
		return fmt.Errorf("serialize Go overlay: %w", err)
	}
	if err := generator.WriteExclusiveRegular(overlayPath, overlayDocument, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(overlayPath, 0o400); err != nil {
		return fmt.Errorf("make Go overlay read-only: %w", err)
	}

	buildArguments := []string{
		"build",
		"-mod=readonly",
		"-trimpath",
		"-buildvcs=false",
		"-tags", generator.ReleaseBuildTag,
		"-overlay", overlayPath,
		"-o", temporaryOutput,
		".",
	}
	buildEnvironment := releaseBuildEnvironment(
		options.architecture,
		toolchain,
		privateGoCache,
		privateGoPath,
		privateGoTemp,
		privateHome,
	)
	if err := verifyCompilerSourceClosure(
		ctx,
		dependencies,
		toolchain.goTool.path,
		snapshotModulePath,
		sourceTree,
		buildEnvironment,
	); err != nil {
		return err
	}
	if err := verifyModuleCache(ctx, dependencies, toolchain.goTool.path, snapshotModulePath, buildEnvironment); err != nil {
		return err
	}
	buildOutput, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.goTool.path, arguments: buildArguments, directory: snapshotModulePath,
		environment: buildEnvironment, timeout: compileStageTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("build ServiceHost release: %w: %s", err, boundedDiagnostic(buildOutput))
	}
	if err := os.Chmod(temporaryOutput, 0o400); err != nil {
		return fmt.Errorf("make built ServiceHost read-only: %w", err)
	}
	if err := verifyGeneratedSource(generatedBacking, generatedSource, generatedDigest, templateDocument, expectedDigest); err != nil {
		return err
	}
	if err := generator.CheckExactRegular(
		overlayPath,
		overlayDocument,
		int64(generator.MaximumGeneratedSourceBytes),
	); err != nil {
		return fmt.Errorf("verify Go overlay after build: %w", err)
	}
	if err := verifyModuleCache(ctx, dependencies, toolchain.goTool.path, snapshotModulePath, buildEnvironment); err != nil {
		return err
	}
	if err := verifyTool(toolchain.goTool); err != nil {
		return fmt.Errorf("reverify Go tool: %w", err)
	}
	if err := verifyTool(toolchain.gitTool); err != nil {
		return fmt.Errorf("reverify Git tool: %w", err)
	}
	if err := checkReadOnlyInput(inputPaths.template, templateDocument, int64(releaseprofile.MaximumDocumentBytes)); err != nil {
		return fmt.Errorf("verify release template after build: %w", err)
	}
	if err := checkReadOnlyInput(inputPaths.expectedDigest, expectedDigestBytesValue, expectedDigestBytes); err != nil {
		return fmt.Errorf("verify expected template digest after build: %w", err)
	}
	if err := checkReadOnlyInput(privateGitConfig, nil, 1); err != nil {
		return fmt.Errorf("verify private Git configuration after build: %w", err)
	}
	if err := gitHooksAnchor.Verify(); err != nil {
		return err
	}
	if entries, err := os.ReadDir(privateGitHooks); err != nil || len(entries) != 0 {
		return fmt.Errorf("private Git hooks directory is no longer empty: %w", err)
	}
	if err := auditRepositoryGitPolicy(ctx, dependencies, repositoryPath, toolchain); err != nil {
		return fmt.Errorf("Git repository policy changed during release build: %w", err)
	}
	if err := requireCleanCheckout(ctx, dependencies, repositoryPath, toolchain); err != nil {
		return fmt.Errorf("checkout changed during release build: %w", err)
	}
	finalSourceIdentity, err := captureGitSourceIdentity(ctx, dependencies, repositoryPath, toolchain)
	if err != nil {
		return err
	}
	if finalSourceIdentity != sourceIdentity {
		return errors.New("Git HEAD commit or tree changed during release build")
	}
	if err := snapshotAnchor.Verify(); err != nil {
		return err
	}
	if err := verifySourceSnapshot(ctx, snapshotModulePath, sourceTree); err != nil {
		return err
	}
	if err := temporaryAnchor.Verify(); err != nil {
		return err
	}
	if err := buildRootAnchor.Verify(); err != nil {
		return err
	}
	if err := outputAnchor.Verify(); err != nil {
		return err
	}
	if err := publishBinary(ctx, temporaryOutput, outputPath, options.architecture); err != nil {
		return err
	}
	if err := syncDirectory(outputParent); err != nil {
		return fmt.Errorf("flush release output directory: %w", err)
	}
	if err := outputAnchor.Verify(); err != nil {
		return err
	}
	return nil
}

type directoryAnchor struct {
	path  string
	label string
	file  *os.File
	info  os.FileInfo
}

func openDirectoryAnchor(path, label string) (*directoryAnchor, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open retained %s: %w", label, err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("inspect retained %s: %w", label, err)
	}
	pathInfo, err := os.Lstat(path)
	if err != nil || !info.IsDir() || !pathInfo.IsDir() || !os.SameFile(info, pathInfo) {
		_ = file.Close()
		return nil, fmt.Errorf("retained %s does not match its physical path", label)
	}
	if err := validateAnchoredDirectoryInfo(info, "retained "+label); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := validateAnchoredDirectoryInfo(pathInfo, label+" path"); err != nil {
		_ = file.Close()
		return nil, err
	}
	return &directoryAnchor{path: path, label: label, file: file, info: info}, nil
}

func (anchor *directoryAnchor) Verify() error {
	if anchor == nil || anchor.file == nil || anchor.info == nil {
		return errors.New("directory identity anchor is closed")
	}
	retained, err := anchor.file.Stat()
	if err != nil {
		return fmt.Errorf("reinspect retained %s: %w", anchor.label, err)
	}
	pathInfo, err := os.Lstat(anchor.path)
	if err != nil {
		return fmt.Errorf("reinspect %s path: %w", anchor.label, err)
	}
	if !retained.IsDir() || !pathInfo.IsDir() || !os.SameFile(anchor.info, retained) ||
		!os.SameFile(retained, pathInfo) {
		return fmt.Errorf("%s path no longer identifies the retained directory", anchor.label)
	}
	if err := validateAnchoredDirectoryInfo(retained, "retained "+anchor.label); err != nil {
		return err
	}
	if err := validateAnchoredDirectoryInfo(pathInfo, anchor.label+" path"); err != nil {
		return err
	}
	return nil
}

func (anchor *directoryAnchor) Close() error {
	if anchor == nil || anchor.file == nil {
		return nil
	}
	err := anchor.file.Close()
	anchor.file = nil
	if err != nil {
		return fmt.Errorf("close retained %s: %w", anchor.label, err)
	}
	return nil
}

type resolvedInputPaths struct {
	template       string
	expectedDigest string
}

func resolveToolchainInputs(options buildOptions) (verifiedToolchain, error) {
	goName := "go"
	gitName := "git"
	if runtime.GOOS == "windows" {
		goName = "go.exe"
		gitName = "git.exe"
	}
	goTool, err := resolveVerifiedTool(options.goToolPath, options.goToolDigestPath, goName)
	if err != nil {
		return verifiedToolchain{}, fmt.Errorf("verify Go tool: %w", err)
	}
	gitTool, err := resolveVerifiedTool(options.gitToolPath, options.gitToolDigestPath, gitName)
	if err != nil {
		return verifiedToolchain{}, fmt.Errorf("verify Git tool: %w", err)
	}
	if !filepath.IsAbs(options.moduleCachePath) {
		return verifiedToolchain{}, errors.New("module cache must be an absolute path")
	}
	moduleCache, err := filepath.Abs(options.moduleCachePath)
	if err != nil {
		return verifiedToolchain{}, fmt.Errorf("resolve module cache: %w", err)
	}
	return verifiedToolchain{goTool: goTool, gitTool: gitTool, moduleCache: moduleCache}, nil
}

func resolveVerifiedTool(path, digestPath, expectedName string) (verifiedTool, error) {
	if !filepath.IsAbs(path) || !filepath.IsAbs(digestPath) {
		return verifiedTool{}, errors.New("tool and tool digest paths must be absolute")
	}
	toolPath, err := resolveReadOnlyRegularPath(path, "release tool")
	if err != nil {
		return verifiedTool{}, err
	}
	if !strings.EqualFold(filepath.Base(toolPath), expectedName) {
		return verifiedTool{}, fmt.Errorf("release tool file name must be %s", expectedName)
	}
	resolvedDigestPath, err := resolveReadOnlyRegularPath(digestPath, "release tool digest")
	if err != nil {
		return verifiedTool{}, err
	}
	expectedBytes, err := readReadOnlyInput(resolvedDigestPath, expectedDigestBytes)
	if err != nil {
		return verifiedTool{}, err
	}
	if int64(len(expectedBytes)) != expectedDigestBytes || !isLowerSHA256(string(expectedBytes)) {
		return verifiedTool{}, errors.New("release tool digest must be exactly 64 lowercase hexadecimal bytes")
	}
	tool := verifiedTool{path: toolPath, digestPath: resolvedDigestPath, expectedDigest: string(expectedBytes)}
	if err := verifyTool(tool); err != nil {
		return verifiedTool{}, err
	}
	return tool, nil
}

func verifyTool(tool verifiedTool) error {
	data, err := readReadOnlyInput(tool.path, maximumToolBytes)
	if err != nil {
		return err
	}
	actual := sha256.Sum256(data)
	if fmt.Sprintf("%x", actual) != tool.expectedDigest {
		return errors.New("release tool SHA-256 differs from its approved digest")
	}
	digestBytes, err := readReadOnlyInput(tool.digestPath, expectedDigestBytes)
	if err != nil {
		return err
	}
	if string(digestBytes) != tool.expectedDigest {
		return errors.New("release tool digest input changed")
	}
	return nil
}

func resolveReadOnlyRegularPath(path, label string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", label, err)
	}
	before, err := os.Lstat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect %s: %w", label, err)
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%s must be a non-symlink regular file", label)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("resolve physical %s: %w", label, err)
	}
	after, err := os.Lstat(resolved)
	if err != nil {
		return "", fmt.Errorf("reinspect %s: %w", label, err)
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return "", fmt.Errorf("%s identity changed during resolution", label)
	}
	if after.Mode().Perm()&0o222 != 0 {
		return "", fmt.Errorf("%s must be read-only", label)
	}
	return filepath.Clean(resolved), nil
}

func resolveInputs(options buildOptions) (resolvedInputPaths, error) {
	if !filepath.IsAbs(options.templatePath) || !filepath.IsAbs(options.expectedDigestPath) {
		return resolvedInputPaths{}, errors.New("template and expected digest inputs must be absolute paths")
	}
	templatePath, err := filepath.Abs(options.templatePath)
	if err != nil {
		return resolvedInputPaths{}, fmt.Errorf("resolve template input: %w", err)
	}
	expectedPath, err := filepath.Abs(options.expectedDigestPath)
	if err != nil {
		return resolvedInputPaths{}, fmt.Errorf("resolve expected digest input: %w", err)
	}
	if samePath(templatePath, expectedPath) {
		return resolvedInputPaths{}, errors.New("template and expected digest must be separate inputs")
	}
	return resolvedInputPaths{template: templatePath, expectedDigest: expectedPath}, nil
}

func resolveOutput(path string, repositoryPath string) (string, string, error) {
	if !filepath.IsAbs(path) {
		return "", "", errors.New("release output must be an absolute path")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", "", fmt.Errorf("resolve release output: %w", err)
	}
	if filepath.Base(absolute) != serviceHostOutputName {
		return "", "", fmt.Errorf("release output file name must be %s", serviceHostOutputName)
	}
	parent, err := resolveExistingDirectory(filepath.Dir(absolute), "release output directory")
	if err != nil {
		return "", "", err
	}
	if err := validatePublishDirectory(parent); err != nil {
		return "", "", err
	}
	resolved := filepath.Join(parent, filepath.Base(absolute))
	if pathWithin(repositoryPath, resolved) {
		return "", "", errors.New("release output must resolve outside the Git repository")
	}
	if err := requireAbsent(resolved, "release output"); err != nil {
		return "", "", err
	}
	return resolved, parent, nil
}

func requireCleanCheckout(
	ctx context.Context,
	dependencies buildDependencies,
	repositoryPath string,
	toolchain verifiedToolchain,
) error {
	status, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.gitTool.path,
		arguments: gitArguments(
			toolchain,
			"-C", repositoryPath, "status", "--porcelain=v1", "-z",
			"--untracked-files=all", "--ignore-submodules=all",
		),
		directory:          repositoryPath,
		environment:        gitEnvironment(toolchain),
		timeout:            gitStageTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("inspect Git checkout: %w: %s", err, boundedDiagnostic(status))
	}
	if len(status) != 0 {
		return errors.New("Git checkout contains modified or untracked files")
	}
	ignored, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.gitTool.path,
		arguments: gitArguments(
			toolchain,
			"-C", repositoryPath, "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", serviceHostModulePath,
		),
		directory:          repositoryPath,
		environment:        gitEnvironment(toolchain),
		timeout:            gitStageTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("inspect ignored ServiceHost sources: %w: %s", err, boundedDiagnostic(ignored))
	}
	if len(ignored) != 0 {
		return errors.New("ServiceHost module contains ignored files that could affect the build")
	}
	tracked, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.gitTool.path,
		arguments: gitArguments(
			toolchain,
			"-C", repositoryPath, "ls-files", "-v", "-z", "--", serviceHostModulePath,
		),
		directory:          repositoryPath,
		environment:        gitEnvironment(toolchain),
		timeout:            gitStageTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("inspect tracked ServiceHost source flags: %w: %s", err, boundedDiagnostic(tracked))
	}
	if err := validateTrackedFiles(tracked); err != nil {
		return err
	}
	return nil
}

func validateTrackedFiles(output []byte) error {
	if len(output) == 0 {
		return errors.New("Git reported no tracked ServiceHost source")
	}
	for len(output) > 0 {
		terminator := bytes.IndexByte(output, 0)
		if terminator < 0 {
			return errors.New("Git tracked-source output is not NUL terminated")
		}
		record := output[:terminator]
		output = output[terminator+1:]
		if len(record) < 3 || record[0] != 'H' || record[1] != ' ' {
			return errors.New("ServiceHost source uses assume-unchanged, skip-worktree, or another noncanonical index state")
		}
	}
	return nil
}

func gitAuditArguments(toolchain verifiedToolchain, arguments ...string) []string {
	prefix := []string{
		"--no-replace-objects",
		"-c", "core.fsmonitor=false",
		"-c", "core.hooksPath=" + toolchain.gitHooksPath,
		"-c", "core.attributesFile=" + os.DevNull,
		"-c", "core.excludesFile=" + os.DevNull,
		"-c", "maintenance.auto=false",
		"-c", "gc.auto=0",
	}
	return append(prefix, arguments...)
}

func gitArguments(toolchain verifiedToolchain, arguments ...string) []string {
	prefix := gitAuditArguments(toolchain)
	prefix = append(prefix,
		"-c", "diff.external=",
		"-c", "filter.lfs.process=",
		"-c", "filter.lfs.smudge=",
		"-c", "filter.lfs.clean=",
		"-c", "filter.lfs.required=false",
	)
	return append(prefix, arguments...)
}

func auditRepositoryGitPolicy(
	ctx context.Context,
	dependencies buildDependencies,
	repositoryPath string,
	toolchain verifiedToolchain,
) error {
	output, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.gitTool.path,
		arguments: gitAuditArguments(
			toolchain,
			"-C", repositoryPath, "config", "--name-only", "-z", "--list", "--no-includes",
		),
		directory:          repositoryPath,
		environment:        gitEnvironment(toolchain),
		timeout:            gitStageTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("audit repository-local Git configuration: %w: %s", err, boundedDiagnostic(output))
	}
	keys, err := parseNULTokens(output, "Git configuration key")
	if err != nil {
		return err
	}
	expectedOverrides := map[string]int{
		"core.fsmonitor": 0, "core.hookspath": 0,
		"core.attributesfile": 0, "core.excludesfile": 0,
		"maintenance.auto": 0, "gc.auto": 0,
	}
	for _, key := range keys {
		if key != strings.ToLower(key) || strings.ContainsAny(key, "\r\n") {
			return errors.New("Git configuration contains a noncanonical key")
		}
		if _, expected := expectedOverrides[key]; expected {
			expectedOverrides[key]++
			continue
		}
		if !allowedRepositoryGitConfigurationKey(key) {
			return fmt.Errorf("repository-local Git configuration key %q is not permitted", key)
		}
	}
	for key, count := range expectedOverrides {
		if count != 1 {
			return fmt.Errorf("Git configuration override %q appears %d times", key, count)
		}
	}
	attributesOutput, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.gitTool.path,
		arguments: gitArguments(
			toolchain,
			"-C", repositoryPath, "rev-parse", "--path-format=absolute", "--git-path", "info/attributes",
		),
		directory:          repositoryPath,
		environment:        gitEnvironment(toolchain),
		timeout:            gitStageTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("locate repository-local Git attributes: %w: %s", err, boundedDiagnostic(attributesOutput))
	}
	attributesPath, err := parseRepositoryPath(attributesOutput)
	if err != nil {
		return fmt.Errorf("parse repository-local Git attributes path: %w", err)
	}
	if err := requireAbsent(filepath.Clean(attributesPath), "repository-local Git attributes"); err != nil {
		return err
	}
	return nil
}

func allowedRepositoryGitConfigurationKey(key string) bool {
	for _, exact := range []string{
		"core.abbrev", "core.autocrlf", "core.bare", "core.checkstat", "core.eol",
		"core.filemode", "core.ignorecase", "core.logallrefupdates", "core.longpaths",
		"core.precomposeunicode", "core.protecthfs", "core.protectntfs",
		"core.repositoryformatversion", "core.safecrlf", "core.symlinks", "core.trustctime",
		"extensions.objectformat", "extensions.worktreeconfig", "init.defaultbranch",
		"user.email", "user.name",
	} {
		if key == exact {
			return true
		}
	}
	return allowedSubsectionKey(key, "remote.", ".url") ||
		allowedSubsectionKey(key, "remote.", ".fetch") ||
		allowedSubsectionKey(key, "branch.", ".remote") ||
		allowedSubsectionKey(key, "branch.", ".merge") ||
		allowedSubsectionKey(key, "submodule.", ".active") ||
		allowedSubsectionKey(key, "submodule.", ".url")
}

func allowedSubsectionKey(key, prefix, suffix string) bool {
	if !strings.HasPrefix(key, prefix) || !strings.HasSuffix(key, suffix) {
		return false
	}
	middle := strings.TrimSuffix(strings.TrimPrefix(key, prefix), suffix)
	return middle != "" && !strings.HasPrefix(middle, ".") && !strings.HasSuffix(middle, ".")
}

func parseNULTokens(output []byte, label string) ([]string, error) {
	if len(output) == 0 || output[len(output)-1] != 0 {
		return nil, fmt.Errorf("%s output is empty or not NUL terminated", label)
	}
	output = output[:len(output)-1]
	parts := bytes.Split(output, []byte{0})
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if len(part) == 0 {
			return nil, fmt.Errorf("%s output contains an empty token", label)
		}
		result = append(result, string(part))
	}
	return result, nil
}

func releaseBuildEnvironment(
	architecture string,
	toolchain verifiedToolchain,
	goCache string,
	goPath string,
	goTemp string,
	home string,
) []string {
	replacements := map[string]string{
		"CGO_ENABLED":  "0",
		"GOCACHE":      goCache,
		"GOCACHEPROG":  "",
		"GOARCH":       architecture,
		"GOENV":        "off",
		"GOFLAGS":      "",
		"GOMODCACHE":   toolchain.moduleCache,
		"GOPATH":       goPath,
		"GOPROXY":      "off",
		"GOOS":         "windows",
		"GOTMPDIR":     goTemp,
		"GOTOOLCHAIN":  "local",
		"GOWORK":       "off",
		"HOME":         home,
		"USERPROFILE":  home,
		"APPDATA":      home,
		"LOCALAPPDATA": home,
		"TEMP":         goTemp,
		"TMP":          goTemp,
		"TMPDIR":       goTemp,
		"PATH":         filepath.Dir(toolchain.goTool.path),
	}
	environment := essentialOSEnvironment()
	for _, name := range []string{
		"APPDATA", "CGO_ENABLED", "GOCACHE", "GOCACHEPROG", "GOARCH", "GOENV", "GOFLAGS",
		"GOMODCACHE", "GOPATH", "GOPROXY", "GOOS", "GOTMPDIR", "GOTOOLCHAIN", "GOWORK",
		"HOME", "LOCALAPPDATA", "PATH", "TEMP", "TMP", "TMPDIR", "USERPROFILE",
	} {
		environment = append(environment, name+"="+replacements[name])
	}
	environment = append(environment,
		"GIT_ATTR_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL="+toolchain.gitGlobalConfig,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_NO_REPLACE_OBJECTS=1",
		"GIT_OPTIONAL_LOCKS=0",
		"GCM_INTERACTIVE=never",
	)
	return environment
}

func verifyModuleCache(
	ctx context.Context,
	dependencies buildDependencies,
	goToolPath string,
	modulePath string,
	environment []string,
) error {
	output, err := dependencies.runCommand(ctx, commandRequest{
		name: goToolPath, arguments: []string{"mod", "verify"}, directory: modulePath,
		environment: environment, timeout: moduleVerifyTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("verify Go module cache: %w: %s", err, boundedDiagnostic(output))
	}
	return nil
}

func verifyCompilerSourceClosure(
	ctx context.Context,
	dependencies buildDependencies,
	goToolPath string,
	modulePath string,
	treeFiles map[string]gitSourceFile,
	environment []string,
) error {
	if err := rejectAssemblySources(ctx, treeFiles); err != nil {
		return err
	}
	output, err := dependencies.runCommand(ctx, commandRequest{
		name:               goToolPath,
		arguments:          []string{"mod", "edit", "-json"},
		directory:          modulePath,
		environment:        environment,
		timeout:            moduleVerifyTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return fmt.Errorf("inspect Go module replacements: %w: %s", err, boundedDiagnostic(output))
	}
	var module struct {
		Replace []struct {
			Old struct {
				Path    string
				Version string
			}
			New struct {
				Path    string
				Version string
			}
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	if err := decoder.Decode(&module); err != nil {
		return fmt.Errorf("parse Go module metadata: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("Go module metadata contains trailing content")
	}
	for _, replacement := range module.Replace {
		if replacement.New.Version == "" {
			return fmt.Errorf(
				"local Go module replacement from %q to %q is not permitted",
				replacement.Old.Path,
				replacement.New.Path,
			)
		}
	}
	return nil
}

func isLowerSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func gitEnvironment(toolchain verifiedToolchain) []string {
	environment := essentialOSEnvironment()
	return append(environment,
		"HOME="+toolchain.gitHome,
		"USERPROFILE="+toolchain.gitHome,
		"XDG_CONFIG_HOME="+toolchain.gitHome,
		"PATH="+filepath.Dir(toolchain.gitTool.path),
		"GIT_ATTR_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL="+toolchain.gitGlobalConfig,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_ASKPASS=",
		"GIT_EDITOR=",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_NO_REPLACE_OBJECTS=1",
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_PAGER=",
		"GIT_SEQUENCE_EDITOR=",
		"GCM_INTERACTIVE=never",
		"PAGER=",
		"SSH_ASKPASS=",
	)
}

func essentialOSEnvironment() []string {
	environment := []string{"LANG=C", "LC_ALL=C"}
	if runtime.GOOS == "windows" {
		if value := os.Getenv("SystemRoot"); value != "" {
			environment = append(environment, "SystemRoot="+value)
		}
	}
	return environment
}

func readReadOnlyInput(path string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o222 != 0 {
		return nil, fmt.Errorf("%s must be an explicit read-only regular input", path)
	}
	return generator.ReadRegularBounded(path, maximum)
}

func checkReadOnlyInput(path string, expected []byte, maximum int64) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o222 != 0 {
		return fmt.Errorf("%s is no longer a read-only regular input", path)
	}
	return generator.CheckExactRegular(path, expected, maximum)
}

func verifyGeneratedSource(
	path string,
	expected []byte,
	expectedDigest [sha256.Size]byte,
	templateDocument []byte,
	templateDigest string,
) error {
	actual, err := generator.ReadRegularBounded(path, int64(generator.MaximumGeneratedSourceBytes))
	if err != nil {
		return fmt.Errorf("read generated release source: %w", err)
	}
	actualDigest := sha256.Sum256(actual)
	if !bytes.Equal(actual, expected) || subtle.ConstantTimeCompare(actualDigest[:], expectedDigest[:]) != 1 {
		return errors.New("generated release source bytes or digest changed")
	}
	if err := generator.Validate(actual, templateDocument, templateDigest); err != nil {
		return fmt.Errorf("validate generated release source: %w", err)
	}
	return nil
}

func publishBinary(ctx context.Context, sourcePath, outputPath, architecture string) (err error) {
	sourceInfo, err := os.Lstat(sourcePath)
	if err != nil {
		return fmt.Errorf("inspect built ServiceHost: %w", err)
	}
	if !sourceInfo.Mode().IsRegular() || sourceInfo.Mode()&os.ModeSymlink != 0 ||
		sourceInfo.Mode().Perm()&0o222 != 0 ||
		sourceInfo.Size() <= 0 || uint64(sourceInfo.Size()) > releaseprofile.MaximumServiceHostBytes {
		return fmt.Errorf("built ServiceHost is not a bounded regular file")
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open built ServiceHost: %w", err)
	}
	sourceClosed := false
	defer func() {
		if !sourceClosed {
			err = errors.Join(err, source.Close())
		}
	}()
	openedInfo, err := source.Stat()
	if err != nil {
		return fmt.Errorf("inspect opened ServiceHost: %w", err)
	}
	if !os.SameFile(sourceInfo, openedInfo) || openedInfo.Size() != sourceInfo.Size() ||
		openedInfo.Mode().Perm()&0o222 != 0 {
		return errors.New("built ServiceHost changed while opening")
	}
	if err := validatePEImage(source, sourceInfo.Size(), architecture); err != nil {
		return fmt.Errorf("validate built ServiceHost PE image: %w", err)
	}
	sourcePreDigest, err := hashRetainedFile(ctx, source, sourceInfo.Size())
	if err != nil {
		return fmt.Errorf("hash built ServiceHost before copying: %w", err)
	}
	output, err := os.OpenFile(outputPath, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return fmt.Errorf("create exclusive release output: %w", err)
	}
	complete := false
	outputClosed := false
	defer func() {
		if !complete {
			if !outputClosed {
				_ = output.Close()
			}
			_ = os.Remove(outputPath)
		}
	}()
	createdOutputInfo, err := output.Stat()
	if err != nil || !createdOutputInfo.Mode().IsRegular() || createdOutputInfo.Size() != 0 {
		return errors.New("exclusive release output is not a new regular file")
	}
	copyDigest := sha256.New()
	written, err := io.CopyN(
		io.MultiWriter(output, copyDigest),
		contextReader{ctx: ctx, reader: io.NewSectionReader(source, 0, sourceInfo.Size())},
		sourceInfo.Size(),
	)
	if err != nil || written != sourceInfo.Size() {
		return fmt.Errorf("copy release output: %w", err)
	}
	if !bytes.Equal(copyDigest.Sum(nil), sourcePreDigest[:]) {
		return errors.New("copied ServiceHost differs from its pre-copy digest")
	}
	if grew, readErr := retainedFileHasByteAt(source, sourceInfo.Size()); readErr != nil {
		return fmt.Errorf("check built ServiceHost length after copying: %w", readErr)
	} else if grew {
		return fmt.Errorf("built ServiceHost grew while copying")
	}
	currentSourceInfo, err := source.Stat()
	if err != nil {
		return fmt.Errorf("reinspect built ServiceHost: %w", err)
	}
	if !os.SameFile(sourceInfo, currentSourceInfo) || currentSourceInfo.Size() != sourceInfo.Size() ||
		currentSourceInfo.Mode().Perm()&0o222 != 0 {
		return errors.New("built ServiceHost identity changed while copying")
	}
	sourcePostDigest, err := hashRetainedFile(ctx, source, sourceInfo.Size())
	if err != nil {
		return fmt.Errorf("rehash built ServiceHost after copying: %w", err)
	}
	if sourcePostDigest != sourcePreDigest {
		return errors.New("built ServiceHost content changed while copying")
	}
	currentSourcePathInfo, err := os.Lstat(sourcePath)
	if err != nil || !currentSourcePathInfo.Mode().IsRegular() ||
		currentSourcePathInfo.Mode().Perm()&0o222 != 0 ||
		!os.SameFile(sourceInfo, currentSourcePathInfo) || currentSourcePathInfo.Size() != sourceInfo.Size() {
		return errors.New("built ServiceHost path identity changed while copying")
	}
	if err := output.Sync(); err != nil {
		return fmt.Errorf("flush release output: %w", err)
	}
	outputInfo, err := output.Stat()
	if err != nil || !os.SameFile(createdOutputInfo, outputInfo) || outputInfo.Size() != sourceInfo.Size() {
		return errors.New("retained release output identity or size changed")
	}
	outputPathInfo, err := os.Lstat(outputPath)
	if err != nil || !outputPathInfo.Mode().IsRegular() || outputPathInfo.Mode()&os.ModeSymlink != 0 ||
		!os.SameFile(outputInfo, outputPathInfo) || outputPathInfo.Size() != sourceInfo.Size() {
		return errors.New("release output path does not identify the retained output")
	}
	if err := validatePEImage(output, outputInfo.Size(), architecture); err != nil {
		return fmt.Errorf("validate retained release output PE image: %w", err)
	}
	outputDigest, err := hashRetainedFile(ctx, output, outputInfo.Size())
	if err != nil {
		return fmt.Errorf("rehash retained release output: %w", err)
	}
	if outputDigest != sourcePreDigest || !bytes.Equal(outputDigest[:], copyDigest.Sum(nil)) {
		return errors.New("release output content differs from source and copied bytes")
	}
	finalRetainedOutputInfo, err := output.Stat()
	if err != nil || !os.SameFile(outputInfo, finalRetainedOutputInfo) ||
		finalRetainedOutputInfo.Size() != sourceInfo.Size() {
		return errors.New("retained release output changed during verification")
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close release output: %w", err)
	}
	outputClosed = true
	finalInfo, err := os.Lstat(outputPath)
	if err != nil {
		return fmt.Errorf("reinspect published release output: %w", err)
	}
	if !finalInfo.Mode().IsRegular() || finalInfo.Mode()&os.ModeSymlink != 0 ||
		finalInfo.Size() != sourceInfo.Size() || !os.SameFile(outputInfo, finalInfo) {
		return errors.New("release output identity or size is invalid")
	}
	if err := source.Close(); err != nil {
		return fmt.Errorf("close retained built ServiceHost: %w", err)
	}
	sourceClosed = true
	complete = true
	return nil
}

func hashRetainedFile(ctx context.Context, file *os.File, size int64) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	if size < 0 {
		return result, errors.New("retained file has a negative size")
	}
	digest := sha256.New()
	read, err := io.CopyN(
		digest,
		contextReader{ctx: ctx, reader: io.NewSectionReader(file, 0, size)},
		size,
	)
	if err != nil || read != size {
		return result, fmt.Errorf("read %d of %d retained bytes: %w", read, size, err)
	}
	if grew, err := retainedFileHasByteAt(file, size); err != nil {
		return result, err
	} else if grew {
		return result, errors.New("retained file is larger than its captured size")
	}
	copy(result[:], digest.Sum(nil))
	return result, nil
}

func retainedFileHasByteAt(file *os.File, offset int64) (bool, error) {
	var trailing [1]byte
	count, err := file.ReadAt(trailing[:], offset)
	if count != 0 {
		return true, nil
	}
	if errors.Is(err, io.EOF) {
		return false, nil
	}
	return false, err
}

type peFileRange struct {
	start uint64
	end   uint64
}

func validatePEImage(reader io.ReaderAt, size int64, architecture string) error {
	if size <= 0 || uint64(size) > releaseprofile.MaximumServiceHostBytes {
		return errors.New("PE image size is outside the supported range")
	}
	total := uint64(size)
	bounded := io.NewSectionReader(reader, 0, size)
	var dosHeader [64]byte
	if _, err := bounded.ReadAt(dosHeader[:], 0); err != nil {
		return fmt.Errorf("read DOS header: %w", err)
	}
	if dosHeader[0] != 'M' || dosHeader[1] != 'Z' {
		return errors.New("PE image omits the DOS signature")
	}
	peOffset := uint64(binary.LittleEndian.Uint32(dosHeader[0x3c:]))
	if peOffset < uint64(len(dosHeader)) || !checkedFileRange(peOffset, 4+20, total) {
		return errors.New("PE signature or COFF header is outside the image")
	}
	var signature [4]byte
	if _, err := bounded.ReadAt(signature[:], int64(peOffset)); err != nil || signature != [4]byte{'P', 'E', 0, 0} {
		return errors.New("PE image has an invalid PE signature")
	}
	var coffHeader [20]byte
	if _, err := bounded.ReadAt(coffHeader[:], int64(peOffset+4)); err != nil {
		return fmt.Errorf("read COFF header: %w", err)
	}
	machine := binary.LittleEndian.Uint16(coffHeader[0:2])
	sectionCount := binary.LittleEndian.Uint16(coffHeader[2:4])
	optionalHeaderSize := binary.LittleEndian.Uint16(coffHeader[16:18])
	characteristics := binary.LittleEndian.Uint16(coffHeader[18:20])
	expectedMachine, err := expectedPEMachine(architecture)
	if err != nil {
		return err
	}
	if machine != expectedMachine {
		return fmt.Errorf("PE machine %#x does not match %s", machine, architecture)
	}
	if characteristics&0x0002 == 0 {
		return errors.New("PE image does not have the executable-image characteristic")
	}
	if sectionCount == 0 || optionalHeaderSize < 112 {
		return errors.New("PE image has no sections or an undersized PE32+ optional header")
	}
	optionalHeaderOffset := peOffset + 4 + 20
	sectionTableOffset := optionalHeaderOffset + uint64(optionalHeaderSize)
	sectionTableBytes := uint64(sectionCount) * 40
	if !checkedFileRange(optionalHeaderOffset, uint64(optionalHeaderSize), total) ||
		!checkedFileRange(sectionTableOffset, sectionTableBytes, total) {
		return errors.New("PE optional header or section table is outside the image")
	}
	image, err := pe.NewFile(bounded)
	if err != nil {
		return fmt.Errorf("parse PE image: %w", err)
	}
	defer image.Close()
	optionalHeader, ok := image.OptionalHeader.(*pe.OptionalHeader64)
	if !ok || optionalHeader == nil || optionalHeader.Magic != 0x20b {
		return errors.New("PE image is not PE32+")
	}
	if image.Machine != expectedMachine || image.NumberOfSections != sectionCount ||
		image.SizeOfOptionalHeader != optionalHeaderSize || image.Characteristics != characteristics {
		return errors.New("parsed PE header differs from the retained header bytes")
	}
	sectionTableEnd := sectionTableOffset + sectionTableBytes
	if uint64(optionalHeader.SizeOfHeaders) < sectionTableEnd || uint64(optionalHeader.SizeOfHeaders) > total {
		return errors.New("PE SizeOfHeaders does not bound the retained headers")
	}
	if len(image.Sections) != int(sectionCount) {
		return errors.New("parsed PE section count is inconsistent")
	}
	rawRanges := make([]peFileRange, 0, len(image.Sections))
	for _, section := range image.Sections {
		if section == nil {
			return errors.New("PE image contains a nil section")
		}
		offset := uint64(section.Offset)
		length := uint64(section.Size)
		if length == 0 {
			if offset > total {
				return fmt.Errorf("PE section %q has an out-of-range empty offset", section.Name)
			}
		} else {
			if offset < uint64(optionalHeader.SizeOfHeaders) || !checkedFileRange(offset, length, total) {
				return fmt.Errorf("PE section %q raw data is outside the image", section.Name)
			}
			rawRanges = append(rawRanges, peFileRange{start: offset, end: offset + length})
		}
		if !checkedFileRange(
			uint64(section.PointerToRelocations),
			uint64(section.NumberOfRelocations)*10,
			total,
		) || !checkedFileRange(
			uint64(section.PointerToLineNumbers),
			uint64(section.NumberOfLineNumbers)*6,
			total,
		) {
			return fmt.Errorf("PE section %q relocation or line table is outside the image", section.Name)
		}
	}
	sort.Slice(rawRanges, func(left, right int) bool {
		return rawRanges[left].start < rawRanges[right].start
	})
	for index := 1; index < len(rawRanges); index++ {
		if rawRanges[index].start < rawRanges[index-1].end {
			return errors.New("PE raw sections overlap")
		}
	}
	return nil
}

func expectedPEMachine(architecture string) (uint16, error) {
	switch architecture {
	case "amd64":
		return pe.IMAGE_FILE_MACHINE_AMD64, nil
	case "arm64":
		return pe.IMAGE_FILE_MACHINE_ARM64, nil
	default:
		return 0, fmt.Errorf("unsupported PE architecture %q", architecture)
	}
}

func checkedFileRange(offset, length, total uint64) bool {
	return offset <= total && length <= total-offset
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	if err := directory.Sync(); err != nil && runtime.GOOS != "windows" {
		_ = directory.Close()
		return err
	}
	return directory.Close()
}

func parseRepositoryPath(output []byte) (string, error) {
	value := strings.TrimSpace(string(output))
	if value == "" || strings.ContainsAny(value, "\x00\r\n") {
		return "", errors.New("git returned an invalid repository path")
	}
	if !filepath.IsAbs(value) {
		return "", errors.New("git returned a non-absolute repository path")
	}
	return value, nil
}

func resolveExistingDirectory(path, label string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", label, err)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("resolve physical %s: %w", label, err)
	}
	info, err := os.Lstat(resolved)
	if err != nil {
		return "", fmt.Errorf("inspect %s: %w", label, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%s must be an existing physical directory", label)
	}
	return filepath.Clean(resolved), nil
}

func requireAbsent(path, label string) error {
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("%s must not exist: %s", label, path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect %s: %w", label, err)
	}
	return nil
}

func pathWithin(parent, candidate string) bool {
	relative, err := filepath.Rel(parent, candidate)
	if err != nil {
		return false
	}
	return relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

func boundedDiagnostic(value []byte) string {
	const maximum = 4 * 1024
	if len(value) > maximum {
		value = value[:maximum]
	}
	return strings.TrimSpace(string(value))
}
