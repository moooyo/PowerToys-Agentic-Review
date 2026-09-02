package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peimage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile/generator"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicehostreceipt"
)

func TestControlledReleaseBuildUsesFixedOverlayCommand(t *testing.T) {
	fixture := newBuildFixture(t)
	if err := fixture.run(); err != nil {
		t.Fatal(err)
	}
	if fixture.runner.goRequest == nil {
		t.Fatal("release driver did not invoke go")
	}
	if fixture.runner.moduleVerifyCalls != 2 {
		t.Fatalf("go mod verify calls = %d, want 2", fixture.runner.moduleVerifyCalls)
	}
	request := fixture.runner.goRequest
	wantPrefix := []string{
		"build", "-mod=readonly", "-trimpath", "-buildvcs=false",
		"-tags", generator.ReleaseBuildTag, "-overlay",
	}
	if len(request.arguments) != 11 || !reflect.DeepEqual(request.arguments[:7], wantPrefix) ||
		request.arguments[8] != "-o" || request.arguments[10] != "." {
		t.Fatalf("go arguments are not fixed: %q", request.arguments)
	}
	if request.directory == fixture.module || filepath.Base(request.directory) != "source-snapshot" {
		t.Fatalf("go did not build the private source snapshot: %q", request.directory)
	}
	if request.timeout != compileStageTimeout || request.maximumOutputBytes != maximumCommandOutputBytes {
		t.Fatalf("go build command limits are not fixed: timeout=%s output=%d", request.timeout, request.maximumOutputBytes)
	}
	validateGoEnvironment(t, request.environment, fixture)
	output, err := os.ReadFile(fixture.output)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output, minimalPE64(t, "amd64")) {
		t.Fatal("published output differs from the expected PE32+ image")
	}
	receiptDocument, err := os.ReadFile(fixture.receipt)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := servicehostreceipt.Parse(receiptDocument)
	if err != nil {
		t.Fatal(err)
	}
	expectedTemplateDigest, err := os.ReadFile(fixture.expectedDigest)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ReleaseID != "worker-test-1" || receipt.TargetArchitecture != "amd64" ||
		receipt.Source.Commit != strings.Repeat("a", 40) || receipt.Source.Tree != strings.Repeat("b", 40) ||
		receipt.CompiledReleaseTemplateSHA256 != string(expectedTemplateDigest) {
		t.Fatalf("unexpected controlled build receipt: %#v", receipt)
	}
	outputDigest := sha256.Sum256(output)
	invariant, signed, err := peimage.SigningInvariantSHA256(
		bytes.NewReader(output),
		int64(len(output)),
		fixture.architecture,
	)
	if err != nil || signed || receipt.UnsignedSHA256 != fmt.Sprintf("%x", outputDigest) ||
		receipt.UnsignedSize != fmt.Sprintf("%d", len(output)) ||
		receipt.SigningInvariantSHA256 != fmt.Sprintf("%x", invariant) {
		t.Fatalf("build receipt does not bind unsigned output: receipt=%#v signed=%t err=%v", receipt, signed, err)
	}
	if _, err := os.Lstat(fixture.runner.temporaryDirectory); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("secure build directory was not removed: %v", err)
	}
}

func TestControlledReleaseBuildProducesLinkedRootPE(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.runner.executeRealGoBuild = true
	if err := fixture.run(); err != nil {
		t.Fatal(err)
	}
	image, err := os.ReadFile(fixture.output)
	if err != nil {
		t.Fatal(err)
	}
	if err := validatePEImage(bytes.NewReader(image), int64(len(image)), fixture.architecture); err != nil {
		t.Fatalf("controlled driver did not produce a valid root PE: %v", err)
	}
	for _, marker := range [][]byte{
		[]byte("load compiled ServiceHost release profile"),
		[]byte(`"releaseId":"worker-test-1"`),
	} {
		if !bytes.Contains(image, marker) {
			t.Fatalf("controlled root PE omits compiled release-profile marker %q", marker)
		}
	}
}

func TestControlledReleaseBuildDoesNotForwardAmbientInjectionEnvironment(t *testing.T) {
	for _, name := range []string{
		"LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "GODEBUG", "GOFLAGS", "GOENV", "GOTOOLCHAIN",
		"GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
		"GIT_CONFIG_VALUE_0", "XDG_CONFIG_HOME",
	} {
		t.Setenv(name, "attacker-controlled")
	}
	fixture := newBuildFixture(t)
	if err := fixture.run(); err != nil {
		t.Fatal(err)
	}
	for _, request := range fixture.runner.requests {
		for _, name := range []string{
			"LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "GODEBUG", "GIT_DIR", "GIT_WORK_TREE",
			"GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
		} {
			if environmentContains(request.environment, name) {
				t.Fatalf("%s was forwarded to %s", name, request.name)
			}
		}
	}
}

func TestControlledReleaseBuildHonorsParentCancellation(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.dependencies.runCommand = func(ctx context.Context, _ commandRequest) ([]byte, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := run(ctx, []string{
		"-template", fixture.template,
		"-expected-sha256-file", fixture.expectedDigest,
		"-output", fixture.output,
		"-receipt-output", fixture.receipt,
		"-arch", fixture.architecture,
		"-go-tool", fixture.goTool,
		"-go-tool-sha256-file", fixture.goToolDigest,
		"-git-tool", fixture.gitTool,
		"-git-tool-sha256-file", fixture.gitToolDigest,
		"-module-cache", fixture.moduleCache,
		"-build-root", fixture.buildRoot,
	}, fixture.dependencies)
	if err == nil {
		t.Fatal("release build ignored parent cancellation")
	}
	if _, err := os.Lstat(fixture.runner.temporaryDirectory); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled release build did not clean its private directory: %v", err)
	}
}

func TestProductionCommandRunnerKillsAndWaitsForDirectChild(t *testing.T) {
	if os.Getenv("SERVICEHOSTRELEASE_TIMEOUT_HELPER") == "1" {
		time.Sleep(30 * time.Second)
		return
	}
	dependencies := productionDependencies()
	start := time.Now()
	_, err := dependencies.runCommand(context.Background(), commandRequest{
		name:               os.Args[0],
		arguments:          []string{"-test.run=TestProductionCommandRunnerKillsAndWaitsForDirectChild"},
		environment:        append(essentialOSEnvironment(), "SERVICEHOSTRELEASE_TIMEOUT_HELPER=1"),
		timeout:            50 * time.Millisecond,
		maximumOutputBytes: 1024,
	})
	if err == nil {
		t.Fatal("timed-out direct child unexpectedly succeeded")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timed-out direct child was not killed and waited promptly: %s", elapsed)
	}
}

func TestControlledReleaseBuildRejectsDirtyAndIgnoredSources(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  []byte
		ignored []byte
	}{
		{name: "modified or untracked", status: []byte("?? native/service-host/extra.go\x00")},
		{name: "ignored ServiceHost source", ignored: []byte("native/service-host/ignored.go\x00")},
		{name: "assume unchanged source", ignored: nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newBuildFixture(t)
			fixture.runner.status = test.status
			fixture.runner.ignored = test.ignored
			if test.name == "assume unchanged source" {
				fixture.runner.tracked = []byte("h native/service-host/main.go\x00")
			}
			if err := fixture.run(); err == nil {
				t.Fatal("release driver unexpectedly accepted a dirty checkout")
			}
			if fixture.runner.goRequest != nil {
				t.Fatal("release driver invoked go for a dirty checkout")
			}
		})
	}
}

func TestControlledReleaseBuildRejectsUnsafeRepositoryGitPolicy(t *testing.T) {
	t.Run("command capable local configuration", func(t *testing.T) {
		fixture := newBuildFixture(t)
		fixture.runner.gitConfigKeys = append(fixture.runner.gitConfigKeys, "filter.evil.process")
		if err := fixture.run(); err == nil {
			t.Fatal("release driver accepted command-capable repository Git configuration")
		}
		if fixture.runner.goRequest != nil {
			t.Fatal("release driver invoked Go with unsafe repository Git configuration")
		}
	})
	t.Run("repository local attributes", func(t *testing.T) {
		fixture := newBuildFixture(t)
		path := filepath.Join(fixture.repository, ".git", "info", "attributes")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("*.go filter=evil\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := fixture.run(); err == nil {
			t.Fatal("release driver accepted repository-local attributes")
		}
		if fixture.runner.goRequest != nil {
			t.Fatal("release driver invoked Go with repository-local attributes")
		}
	})
}

func TestAuditRepositoryGitPolicyWithRealGit(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("Git is unavailable")
	}
	root := t.TempDir()
	repository := filepath.Join(root, "repository")
	command := exec.Command(gitPath, "init", "-q", repository)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("initialize Git policy fixture: %v\n%s", err, output)
	}
	hooks := filepath.Join(root, "hooks")
	home := filepath.Join(root, "home")
	if err := os.Mkdir(hooks, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	globalConfig := filepath.Join(root, "global.gitconfig")
	if err := os.WriteFile(globalConfig, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	toolchain := verifiedToolchain{
		gitTool:      verifiedTool{path: gitPath},
		gitHooksPath: hooks, gitGlobalConfig: globalConfig, gitHome: home,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := auditRepositoryGitPolicy(ctx, productionDependencies(), repository, toolchain); err != nil {
		t.Fatalf("safe repository policy was rejected: %v", err)
	}
	command = exec.Command(gitPath, "-C", repository, "config", "filter.evil.process", "arbitrary-command")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("write malicious Git policy fixture: %v\n%s", err, output)
	}
	if err := auditRepositoryGitPolicy(ctx, productionDependencies(), repository, toolchain); err == nil {
		t.Fatal("command-capable repository configuration was accepted")
	}
}

func TestControlledReleaseBuildRejectsPhysicalGeneratedSource(t *testing.T) {
	fixture := newBuildFixture(t)
	target := filepath.Join(fixture.module, "internal", "releaseprofile", generator.GeneratedFileName)
	if err := os.WriteFile(target, []byte("package releaseprofile"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted a physical generated source")
	}
	if fixture.runner.goRequest != nil {
		t.Fatal("release driver invoked go with a physical generated source")
	}
}

func TestControlledReleaseBuildRejectsUnsafeOutput(t *testing.T) {
	t.Run("inside repository", func(t *testing.T) {
		fixture := newBuildFixture(t)
		fixture.output = filepath.Join(fixture.repository, serviceHostOutputName)
		if err := fixture.run(); err == nil {
			t.Fatal("release driver accepted output inside repository")
		}
	})
	t.Run("pre-existing", func(t *testing.T) {
		fixture := newBuildFixture(t)
		if err := os.WriteFile(fixture.output, []byte("existing"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := fixture.run(); err == nil {
			t.Fatal("release driver accepted a pre-existing output")
		}
	})
}

func TestControlledReleaseBuildRejectsWrongIndependentDigest(t *testing.T) {
	fixture := newBuildFixture(t)
	if err := os.Chmod(fixture.expectedDigest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.expectedDigest, []byte(strings.Repeat("f", 64)), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(fixture.expectedDigest, 0o400); err != nil {
		t.Fatal(err)
	}
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted the wrong independent digest")
	}
	if fixture.runner.goRequest != nil {
		t.Fatal("release driver invoked go with the wrong independent digest")
	}
}

func TestControlledReleaseBuildRequiresReadOnlyInputs(t *testing.T) {
	fixture := newBuildFixture(t)
	if err := os.Chmod(fixture.template, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted a writable template input")
	}
	if fixture.runner.goRequest != nil {
		t.Fatal("release driver invoked go with a writable input")
	}
}

func TestControlledReleaseBuildRejectsLocalGoModuleReplacement(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.runner.goModEditOutput = []byte(`{
  "Replace": [
    {"Old": {"Path": "example.test/dependency"}, "New": {"Path": "../outside"}}
  ]
}`)
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted a local Go module replacement")
	}
	if fixture.runner.goRequest != nil {
		t.Fatal("release driver invoked go build with a local replacement")
	}
}

func TestControlledReleaseBuildRejectsModifiedTool(t *testing.T) {
	fixture := newBuildFixture(t)
	if err := os.Chmod(fixture.goTool, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.goTool, []byte("modified go tool"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(fixture.goTool, 0o400); err != nil {
		t.Fatal(err)
	}
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted a tool that differed from its approved digest")
	}
}

func TestControlledReleaseBuildRejectsCheckoutMutationDuringBuild(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.runner.statusAfterBuild = []byte(" M native/service-host/main.go\x00")
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted checkout mutation during build")
	}
	if _, err := os.Lstat(fixture.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("release driver published a dirty build: %v", err)
	}
}

func TestControlledReleaseBuildRejectsHEADOrTreeMutationDuringBuild(t *testing.T) {
	for _, test := range []struct {
		name   string
		commit string
		tree   string
	}{
		{name: "commit", commit: strings.Repeat("c", 40)},
		{name: "tree", tree: strings.Repeat("d", 40)},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newBuildFixture(t)
			fixture.runner.commitAfterBuild = test.commit
			fixture.runner.treeAfterBuild = test.tree
			if err := fixture.run(); err == nil {
				t.Fatal("release driver accepted a Git identity change during build")
			}
			if _, err := os.Lstat(fixture.output); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("release driver published after Git identity changed: %v", err)
			}
		})
	}
}

func TestControlledReleaseBuildRejectsOutputDirectoryReplacement(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.runner.replaceOutputDirectory = true
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted output-directory replacement")
	}
	if _, err := os.Lstat(fixture.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("release driver published through a replacement directory: %v", err)
	}
}

func TestControlledReleaseBuildDetectsGeneratedSourceMutation(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.runner.mutateGenerated = true
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted generated source mutation")
	}
	if _, err := os.Lstat(fixture.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("release driver published output after source mutation: %v", err)
	}
}

func TestControlledReleaseBuildDetectsSnapshotContentMutation(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.runner.mutateSnapshot = true
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted source snapshot mutation")
	}
	if _, err := os.Lstat(fixture.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("release driver published output after snapshot mutation: %v", err)
	}
}

func TestControlledReleaseBuildRejectsOversizedServiceHost(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.runner.oversizedBinary = true
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted an oversized ServiceHost")
	}
	if _, err := os.Lstat(fixture.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("release driver published an oversized ServiceHost: %v", err)
	}
}

func TestControlledReleaseBuildRejectsWrongPEMachine(t *testing.T) {
	fixture := newBuildFixture(t)
	fixture.architecture = "arm64"
	if err := fixture.run(); err == nil {
		t.Fatal("release driver accepted an AMD64 image for an ARM64 build")
	}
	if _, err := os.Lstat(fixture.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("release driver published a wrong-machine image: %v", err)
	}
}

func TestValidatePEImage(t *testing.T) {
	for _, architecture := range []string{"amd64", "arm64"} {
		t.Run(architecture, func(t *testing.T) {
			image := minimalPE64(t, architecture)
			if err := validatePEImage(bytes.NewReader(image), int64(len(image)), architecture); err != nil {
				t.Fatalf("valid %s PE32+ image was rejected: %v", architecture, err)
			}
		})
	}
	base := minimalPE64(t, "amd64")
	for _, test := range []struct {
		name   string
		mutate func([]byte)
	}{
		{name: "PE32 optional header", mutate: func(value []byte) { binary.LittleEndian.PutUint16(value[0x98:], 0x10b) }},
		{name: "not executable", mutate: func(value []byte) { binary.LittleEndian.PutUint16(value[0x96:], 0x20) }},
		{name: "signature out of range", mutate: func(value []byte) { binary.LittleEndian.PutUint32(value[0x3c:], 0xfffffff0) }},
		{name: "headers omit section table", mutate: func(value []byte) { binary.LittleEndian.PutUint32(value[0xd4:], 0x100) }},
		{name: "section overlaps headers", mutate: func(value []byte) { binary.LittleEndian.PutUint32(value[0x19c:], 0x100) }},
		{name: "section extends past EOF", mutate: func(value []byte) {
			binary.LittleEndian.PutUint32(value[0x198:], 0x200)
			binary.LittleEndian.PutUint32(value[0x19c:], 0x300)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			image := append([]byte(nil), base...)
			test.mutate(image)
			if err := validatePEImage(bytes.NewReader(image), int64(len(image)), "amd64"); err == nil {
				t.Fatal("invalid PE image was accepted")
			}
		})
	}
	if err := validatePEImage(bytes.NewReader(base), int64(len(base)), "arm64"); err == nil {
		t.Fatal("AMD64 PE image was accepted for ARM64")
	}
}

type buildFixture struct {
	t              *testing.T
	root           string
	repository     string
	module         string
	template       string
	expectedDigest string
	goTool         string
	goToolDigest   string
	gitTool        string
	gitToolDigest  string
	moduleCache    string
	buildRoot      string
	output         string
	receipt        string
	architecture   string
	runner         *fakeCommandRunner
	dependencies   buildDependencies
}

func newBuildFixture(t *testing.T) *buildFixture {
	t.Helper()
	root := t.TempDir()
	repository := filepath.Join(root, "repository")
	module := filepath.Join(repository, filepath.FromSlash(serviceHostModulePath))
	if err := os.MkdirAll(filepath.Join(module, "internal", "releaseprofile"), 0o700); err != nil {
		t.Fatal(err)
	}
	inputDirectory := filepath.Join(root, "inputs")
	outputDirectory := filepath.Join(root, "output")
	if err := os.MkdirAll(inputDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outputDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	template := filepath.Join(inputDirectory, "release-template.json")
	expectedDigest := filepath.Join(inputDirectory, "release-template.sha256")
	document := releaseTemplateDocument(t)
	digest := fmt.Sprintf("%x", sha256.Sum256(document))
	if err := os.WriteFile(template, document, 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(expectedDigest, []byte(digest), 0o400); err != nil {
		t.Fatal(err)
	}
	toolDirectory := filepath.Join(root, "tools")
	if err := os.Mkdir(toolDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	goName := "go"
	gitName := "git"
	if runtime.GOOS == "windows" {
		goName = "go.exe"
		gitName = "git.exe"
	}
	goTool, goToolDigest := writeTestTool(t, toolDirectory, goName, []byte("approved go tool"))
	gitTool, gitToolDigest := writeTestTool(t, toolDirectory, gitName, []byte("approved git tool"))
	moduleCache := filepath.Join(root, "module-cache")
	if err := os.Mkdir(moduleCache, 0o500); err != nil {
		t.Fatal(err)
	}
	buildRoot := filepath.Join(root, "controlled-build-root")
	if err := os.Mkdir(buildRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	source := testSourceInputs(t)
	runner := &fakeCommandRunner{
		t: t, repository: repository, module: module, goTool: goTool, gitTool: gitTool,
		tracked: []byte("H native/service-host/main.go\x00"), outputDirectory: outputDirectory,
		sourceArchive: source.archive, sourceTree: source.tree,
		binary:          minimalPE64(t, "amd64"),
		goModEditOutput: []byte(`{"Replace":null}`),
		gitConfigKeys: []string{
			"core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates",
			"remote.origin.url", "remote.origin.fetch", "core.fsmonitor", "core.hookspath",
			"core.attributesfile", "core.excludesfile", "maintenance.auto", "gc.auto",
		},
	}
	fixture := &buildFixture{
		t: t, root: root, repository: repository, module: module,
		template: template, expectedDigest: expectedDigest,
		goTool: goTool, goToolDigest: goToolDigest,
		gitTool: gitTool, gitToolDigest: gitToolDigest, moduleCache: moduleCache,
		buildRoot:    buildRoot,
		output:       filepath.Join(outputDirectory, serviceHostOutputName),
		receipt:      filepath.Join(outputDirectory, serviceHostReceiptName),
		architecture: "amd64", runner: runner,
	}
	fixture.dependencies = buildDependencies{
		getwd:      func() (string, error) { return module, nil },
		runCommand: runner.run,
		makeTempDir: func(base string, pattern string) (string, error) {
			if base != buildRoot {
				t.Fatalf("temporary base = %q, want %q", base, buildRoot)
			}
			directory, err := os.MkdirTemp(base, pattern)
			if err == nil {
				runner.temporaryDirectory = directory
			}
			return directory, err
		},
		removeAll: os.RemoveAll,
	}
	return fixture
}

func (fixture *buildFixture) run() error {
	return run(context.Background(), []string{
		"-template", fixture.template,
		"-expected-sha256-file", fixture.expectedDigest,
		"-output", fixture.output,
		"-receipt-output", fixture.receipt,
		"-arch", fixture.architecture,
		"-go-tool", fixture.goTool,
		"-go-tool-sha256-file", fixture.goToolDigest,
		"-git-tool", fixture.gitTool,
		"-git-tool-sha256-file", fixture.gitToolDigest,
		"-module-cache", fixture.moduleCache,
		"-build-root", fixture.buildRoot,
	}, fixture.dependencies)
}

type fakeCommandRunner struct {
	t                      *testing.T
	repository             string
	module                 string
	goTool                 string
	gitTool                string
	status                 []byte
	statusAfterBuild       []byte
	statusCalls            int
	ignored                []byte
	tracked                []byte
	goRequest              *commandRequest
	temporaryDirectory     string
	mutateGenerated        bool
	mutateSnapshot         bool
	oversizedBinary        bool
	moduleVerifyCalls      int
	outputDirectory        string
	replaceOutputDirectory bool
	sourceArchive          []byte
	sourceTree             []byte
	binary                 []byte
	commitAfterBuild       string
	treeAfterBuild         string
	requests               []commandRequest
	executeRealGoBuild     bool
	gitConfigKeys          []string
	goModEditOutput        []byte
}

func (runner *fakeCommandRunner) run(ctx context.Context, request commandRequest) ([]byte, error) {
	runner.t.Helper()
	copyRequest := request
	copyRequest.arguments = append([]string(nil), request.arguments...)
	copyRequest.environment = append([]string(nil), request.environment...)
	runner.requests = append(runner.requests, copyRequest)
	if request.timeout <= 0 || request.maximumOutputBytes <= 0 {
		runner.t.Fatalf("command lacks a stage timeout or output limit: %+v", request)
	}
	if request.name == runner.gitTool {
		if request.timeout != gitStageTimeout {
			runner.t.Fatalf("Git timeout = %s, want %s", request.timeout, gitStageTimeout)
		}
		validateGitEnvironment(runner.t, request.environment, runner)
		arguments := stripGitArguments(runner.t, request.arguments)
		if reflect.DeepEqual(arguments, []string{
			"-C", runner.repository, "config", "--name-only", "-z", "--list", "--no-includes",
		}) {
			var output bytes.Buffer
			for _, key := range runner.gitConfigKeys {
				output.WriteString(key)
				output.WriteByte(0)
			}
			return output.Bytes(), nil
		}
		if reflect.DeepEqual(arguments, []string{
			"-C", runner.repository, "rev-parse", "--path-format=absolute", "--git-path", "info/attributes",
		}) {
			return []byte(filepath.Join(runner.repository, ".git", "info", "attributes") + "\n"), nil
		}
		if reflect.DeepEqual(arguments, []string{"rev-parse", "--show-toplevel"}) {
			return []byte(runner.repository + "\n"), nil
		}
		if reflect.DeepEqual(arguments, []string{"-C", runner.repository, "rev-parse", "--verify", "HEAD^{commit}"}) {
			value := strings.Repeat("a", 40)
			if runner.goRequest != nil && runner.commitAfterBuild != "" {
				value = runner.commitAfterBuild
			}
			return []byte(value + "\n"), nil
		}
		commit := strings.Repeat("a", 40)
		if runner.goRequest != nil && runner.commitAfterBuild != "" {
			commit = runner.commitAfterBuild
		}
		if reflect.DeepEqual(arguments, []string{"-C", runner.repository, "rev-parse", "--verify", commit + "^{tree}"}) {
			value := strings.Repeat("b", 40)
			if runner.goRequest != nil && runner.treeAfterBuild != "" {
				value = runner.treeAfterBuild
			}
			return []byte(value + "\n"), nil
		}
		if reflect.DeepEqual(arguments, []string{
			"-C", runner.repository, "ls-tree", "-r", "-z", "-l", "--full-tree",
			strings.Repeat("b", 40), "--", serviceHostArchivePrefix,
		}) {
			return append([]byte(nil), runner.sourceTree...), nil
		}
		if reflect.DeepEqual(arguments, []string{
			"-C", runner.repository, "archive", "--format=tar", strings.Repeat("a", 40),
			"--", serviceHostModulePath,
		}) {
			return append([]byte(nil), runner.sourceArchive...), nil
		}
		if len(arguments) >= 4 && arguments[2] == "status" {
			runner.statusCalls++
			if runner.statusCalls > 1 {
				return append([]byte(nil), runner.statusAfterBuild...), nil
			}
			return append([]byte(nil), runner.status...), nil
		}
		if len(arguments) >= 4 && arguments[2] == "ls-files" {
			for _, argument := range arguments {
				if argument == "--ignored" {
					return append([]byte(nil), runner.ignored...), nil
				}
			}
			return append([]byte(nil), runner.tracked...), nil
		}
		runner.t.Fatalf("unexpected git command: %q", request.arguments)
	}
	if request.name != runner.goTool {
		runner.t.Fatalf("unexpected command %q", request.name)
	}
	if reflect.DeepEqual(request.arguments, []string{"mod", "verify"}) {
		if request.timeout != moduleVerifyTimeout {
			runner.t.Fatalf("go mod verify timeout = %s, want %s", request.timeout, moduleVerifyTimeout)
		}
		runner.moduleVerifyCalls++
		return []byte("all modules verified\n"), nil
	}
	if reflect.DeepEqual(request.arguments, []string{"mod", "edit", "-json"}) {
		if request.timeout != moduleVerifyTimeout {
			runner.t.Fatalf("go mod edit timeout = %s, want %s", request.timeout, moduleVerifyTimeout)
		}
		return append([]byte(nil), runner.goModEditOutput...), nil
	}
	copy := request
	copy.arguments = append([]string(nil), request.arguments...)
	copy.environment = append([]string(nil), request.environment...)
	runner.goRequest = &copy
	if request.directory == runner.module || filepath.Base(request.directory) != "source-snapshot" {
		runner.t.Fatalf("go did not use source snapshot: %q", request.directory)
	}
	overlayPath := argumentAfter(runner.t, request.arguments, "-overlay")
	outputPath := argumentAfter(runner.t, request.arguments, "-o")
	overlayBytes, err := os.ReadFile(overlayPath)
	if err != nil {
		return nil, err
	}
	var overlay struct {
		Replace map[string]string `json:"Replace"`
	}
	if err := json.Unmarshal(overlayBytes, &overlay); err != nil {
		return nil, err
	}
	target := filepath.Join(request.directory, "internal", "releaseprofile", generator.GeneratedFileName)
	backing, exists := overlay.Replace[target]
	if !exists || len(overlay.Replace) != 1 {
		return nil, errors.New("overlay does not map the fixed generated target")
	}
	if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("physical generated target exists during build")
	}
	if runner.mutateGenerated {
		if err := os.Chmod(backing, 0o600); err != nil {
			return nil, err
		}
		if err := os.WriteFile(backing, []byte("package releaseprofile\nfunc init() {}\n"), 0o600); err != nil {
			return nil, err
		}
	}
	if runner.mutateSnapshot {
		path := filepath.Join(request.directory, "main.go")
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return nil, err
		}
		content[len(content)-2] ^= 1
		if err := os.WriteFile(path, content, 0o600); err != nil {
			return nil, err
		}
		if err := os.Chmod(path, 0o400); err != nil {
			return nil, err
		}
	}
	if runner.executeRealGoBuild {
		command := exec.CommandContext(ctx, "go", request.arguments...)
		command.Dir = request.directory
		command.Env = request.environment
		output, err := command.CombinedOutput()
		if err != nil {
			return output, fmt.Errorf("execute real Go build fixture: %w", err)
		}
	} else if runner.oversizedBinary {
		file, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
		if err != nil {
			return nil, err
		}
		if err := file.Truncate(int64(releaseprofile.MaximumServiceHostBytes + 1)); err != nil {
			_ = file.Close()
			return nil, err
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
	} else if err := os.WriteFile(outputPath, runner.binary, 0o700); err != nil {
		return nil, err
	}
	if runner.replaceOutputDirectory {
		replaced := runner.outputDirectory + ".replaced"
		if err := os.Rename(runner.outputDirectory, replaced); err != nil {
			return nil, err
		}
		if err := os.Mkdir(runner.outputDirectory, 0o700); err != nil {
			return nil, err
		}
	}
	return nil, nil
}

func stripGitArguments(t *testing.T, arguments []string) []string {
	t.Helper()
	for _, prefix := range [][]string{
		gitArguments(verifiedToolchain{gitHooksPath: "HOOKS"}),
		gitAuditArguments(verifiedToolchain{gitHooksPath: "HOOKS"}),
	} {
		if len(arguments) < len(prefix) {
			continue
		}
		actual := append([]string(nil), arguments[:len(prefix)]...)
		for index, value := range prefix {
			if value != "core.hooksPath=HOOKS" {
				continue
			}
			hooksValue := strings.TrimPrefix(actual[index], "core.hooksPath=")
			if hooksValue == actual[index] || !filepath.IsAbs(hooksValue) || filepath.Base(hooksValue) != "git-hooks" {
				t.Fatalf("Git hooks path is not a private absolute directory: %q", actual[index])
			}
			actual[index] = value
		}
		if reflect.DeepEqual(actual, prefix) {
			return arguments[len(prefix):]
		}
	}
	t.Fatalf("Git command lacks fixed injection guards: %q", arguments)
	return nil
}

func validateGitEnvironment(t *testing.T, environment []string, runner *fakeCommandRunner) {
	t.Helper()
	home := environmentValue(environment, "HOME")
	if !filepath.IsAbs(home) || filepath.Base(home) != "home" {
		t.Fatalf("Git HOME is not the private empty directory: %q", home)
	}
	want := map[string]string{
		"LANG": "C", "LC_ALL": "C",
		"HOME":              home,
		"USERPROFILE":       home,
		"XDG_CONFIG_HOME":   home,
		"PATH":              filepath.Dir(runner.gitTool),
		"GIT_ATTR_NOSYSTEM": "1", "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
		"GIT_NO_REPLACE_OBJECTS": "1", "GIT_OPTIONAL_LOCKS": "0", "GCM_INTERACTIVE": "never",
		"GIT_ASKPASS": "", "GIT_EDITOR": "", "GIT_PAGER": "", "GIT_SEQUENCE_EDITOR": "",
		"PAGER": "", "SSH_ASKPASS": "",
	}
	if runtime.GOOS == "windows" {
		if value := os.Getenv("SystemRoot"); value != "" {
			want["SYSTEMROOT"] = value
		}
	}
	globalConfig := environmentValue(environment, "GIT_CONFIG_GLOBAL")
	if !filepath.IsAbs(globalConfig) || filepath.Base(globalConfig) != "gitconfig" {
		t.Fatalf("Git global configuration is not the private empty file: %q", globalConfig)
	}
	want["GIT_CONFIG_GLOBAL"] = globalConfig
	assertExactEnvironment(t, environment, want)
}

func validateGoEnvironment(t *testing.T, environment []string, fixture *buildFixture) {
	t.Helper()
	home := environmentValue(environment, "HOME")
	goCache := environmentValue(environment, "GOCACHE")
	goPath := environmentValue(environment, "GOPATH")
	goTemp := environmentValue(environment, "GOTMPDIR")
	globalConfig := environmentValue(environment, "GIT_CONFIG_GLOBAL")
	for path, base := range map[string]string{
		home: "home", goCache: "go-build-cache", goPath: "go-path", goTemp: "go-temp", globalConfig: "gitconfig",
	} {
		if !filepath.IsAbs(path) || filepath.Base(path) != base {
			t.Fatalf("private build path %q does not end in %q", path, base)
		}
	}
	want := map[string]string{
		"LANG": "C", "LC_ALL": "C",
		"APPDATA": home, "CGO_ENABLED": "0", "GOCACHE": goCache, "GOCACHEPROG": "",
		"GOARCH": fixture.architecture, "GOENV": "off", "GOFLAGS": "", "GOMODCACHE": fixture.moduleCache,
		"GOPATH": goPath, "GOPROXY": "off", "GOOS": "windows", "GOTMPDIR": goTemp,
		"GOTOOLCHAIN": "local", "GOWORK": "off", "HOME": home, "LOCALAPPDATA": home,
		"PATH": filepath.Dir(fixture.goTool), "TEMP": goTemp, "TMP": goTemp, "TMPDIR": goTemp,
		"USERPROFILE":       home,
		"GIT_ATTR_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": globalConfig, "GIT_CONFIG_NOSYSTEM": "1",
		"GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_OPTIONAL_LOCKS": "0",
		"GCM_INTERACTIVE": "never",
	}
	if runtime.GOOS == "windows" {
		if value := os.Getenv("SystemRoot"); value != "" {
			want["SYSTEMROOT"] = value
		}
	}
	assertExactEnvironment(t, environment, want)
}

func assertExactEnvironment(t *testing.T, environment []string, want map[string]string) {
	t.Helper()
	actual := make(map[string]string, len(environment))
	for _, item := range environment {
		name, value, found := strings.Cut(item, "=")
		if !found || name == "" {
			t.Fatalf("invalid environment item %q", item)
		}
		key := strings.ToUpper(name)
		if _, duplicate := actual[key]; duplicate {
			t.Fatalf("duplicate environment key %q", name)
		}
		actual[key] = value
	}
	normalizedWant := make(map[string]string, len(want))
	for name, value := range want {
		normalizedWant[strings.ToUpper(name)] = value
	}
	if !reflect.DeepEqual(actual, normalizedWant) {
		t.Fatalf("environment differs from exact allowlist:\n got: %#v\nwant: %#v", actual, normalizedWant)
	}
}

func environmentContains(environment []string, name string) bool {
	for _, item := range environment {
		key, _, found := strings.Cut(item, "=")
		if found && strings.EqualFold(key, name) {
			return true
		}
	}
	return false
}

type testSourceFixture struct {
	archive []byte
	tree    []byte
}

func testSourceInputs(t *testing.T) testSourceFixture {
	t.Helper()
	var buffer bytes.Buffer
	var tree bytes.Buffer
	writer := tar.NewWriter(&buffer)
	directories := []string{
		"native/",
		"native/service-host/",
		"native/service-host/internal/",
		"native/service-host/internal/releaseprofile/",
	}
	for _, name := range directories {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Typeflag: tar.TypeDir}); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"native/service-host/go.mod":                                          "module github.com/moooyo/PowerToys-Agentic-Review/native/service-host\n\ngo 1.24.0\n",
		"native/service-host/go.sum":                                          "",
		"native/service-host/main.go":                                         "package main\nfunc main() {}\n",
		"native/service-host/release_profile_release.go":                      "//go:build agenticreview_release\n\npackage main\n\nimport \"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile\"\n\nfunc init() {\n\tevidence, err := releaseprofile.Production()\n\tif err != nil { panic(\"load compiled ServiceHost release profile: \" + err.Error()) }\n\tif err := evidence.Validate(); err != nil { panic(\"validate compiled ServiceHost release profile: \" + err.Error()) }\n}\n",
		"native/service-host/internal/releaseprofile/profile.go":              "package releaseprofile\n\nimport (\n\t\"crypto/sha256\"\n\t\"encoding/hex\"\n\t\"errors\"\n)\n\ntype Evidence struct { valid bool }\n\nfunc Production() (Evidence, error) {\n\tdigest, err := hex.DecodeString(compiledReleaseTemplateSHA256)\n\tif err != nil { return Evidence{}, err }\n\tactual := sha256.Sum256([]byte(compiledReleaseTemplateDocument))\n\tif string(actual[:]) != string(digest) { return Evidence{}, errors.New(\"compiled digest mismatch\") }\n\treturn Evidence{valid: true}, nil\n}\n\nfunc (e Evidence) Validate() error {\n\tif !e.valid { return errors.New(\"invalid evidence\") }\n\treturn nil\n}\n",
		"native/service-host/internal/releaseprofile/compiled_unavailable.go": "//go:build !agenticreview_release\n\npackage releaseprofile\n",
	}
	order := []string{
		"native/service-host/go.mod",
		"native/service-host/go.sum",
		"native/service-host/main.go",
		"native/service-host/release_profile_release.go",
		"native/service-host/internal/releaseprofile/profile.go",
		"native/service-host/internal/releaseprofile/compiled_unavailable.go",
	}
	for _, name := range order {
		content := []byte(files[name])
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(content); err != nil {
			t.Fatal(err)
		}
		objectDigest := sha1.New()
		_, _ = fmt.Fprintf(objectDigest, "blob %d\x00", len(content))
		_, _ = objectDigest.Write(content)
		_, _ = fmt.Fprintf(
			&tree,
			"100644 blob %x %d\t%s\x00",
			objectDigest.Sum(nil),
			len(content),
			name,
		)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return testSourceFixture{archive: buffer.Bytes(), tree: tree.Bytes()}
}

func minimalPE64(t *testing.T, architecture string) []byte {
	t.Helper()
	machine, err := expectedPEMachine(architecture)
	if err != nil {
		t.Fatal(err)
	}
	const (
		peOffset         = 0x80
		optionalHeader   = peOffset + 4 + 20
		sectionTable     = optionalHeader + 0xf0
		rawSectionOffset = 0x200
		rawSectionSize   = 0x200
		imageSize        = rawSectionOffset + rawSectionSize
	)
	image := make([]byte, imageSize)
	image[0], image[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(image[0x3c:], peOffset)
	copy(image[peOffset:], []byte{'P', 'E', 0, 0})
	coff := image[peOffset+4 : optionalHeader]
	binary.LittleEndian.PutUint16(coff[0:], machine)
	binary.LittleEndian.PutUint16(coff[2:], 1)
	binary.LittleEndian.PutUint16(coff[16:], 0xf0)
	binary.LittleEndian.PutUint16(coff[18:], 0x22)
	optional := image[optionalHeader:sectionTable]
	binary.LittleEndian.PutUint16(optional[0:], 0x20b)
	binary.LittleEndian.PutUint32(optional[4:], rawSectionSize)
	binary.LittleEndian.PutUint32(optional[16:], 0x1000)
	binary.LittleEndian.PutUint32(optional[20:], 0x1000)
	binary.LittleEndian.PutUint64(optional[24:], 0x140000000)
	binary.LittleEndian.PutUint32(optional[32:], 0x1000)
	binary.LittleEndian.PutUint32(optional[36:], 0x200)
	binary.LittleEndian.PutUint16(optional[40:], 6)
	binary.LittleEndian.PutUint16(optional[48:], 6)
	binary.LittleEndian.PutUint32(optional[56:], 0x2000)
	binary.LittleEndian.PutUint32(optional[60:], rawSectionOffset)
	binary.LittleEndian.PutUint16(optional[68:], 3)
	binary.LittleEndian.PutUint64(optional[72:], 0x100000)
	binary.LittleEndian.PutUint64(optional[80:], 0x1000)
	binary.LittleEndian.PutUint64(optional[88:], 0x100000)
	binary.LittleEndian.PutUint64(optional[96:], 0x1000)
	binary.LittleEndian.PutUint32(optional[108:], 16)
	section := image[sectionTable : sectionTable+40]
	copy(section[:8], []byte(".text"))
	binary.LittleEndian.PutUint32(section[8:], 1)
	binary.LittleEndian.PutUint32(section[12:], 0x1000)
	binary.LittleEndian.PutUint32(section[16:], rawSectionSize)
	binary.LittleEndian.PutUint32(section[20:], rawSectionOffset)
	binary.LittleEndian.PutUint32(section[36:], 0x60000020)
	image[rawSectionOffset] = 0xc3
	return image
}

func writeTestTool(t *testing.T, directory, name string, content []byte) (string, string) {
	t.Helper()
	path := filepath.Join(directory, name)
	digestPath := path + ".sha256"
	if err := os.WriteFile(path, content, 0o400); err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(content))
	if err := os.WriteFile(digestPath, []byte(digest), 0o400); err != nil {
		t.Fatal(err)
	}
	return path, digestPath
}

func argumentAfter(t *testing.T, arguments []string, name string) string {
	t.Helper()
	for index := 0; index+1 < len(arguments); index++ {
		if arguments[index] == name {
			return arguments[index+1]
		}
	}
	t.Fatalf("argument %s is missing from %q", name, arguments)
	return ""
}

func environmentValue(environment []string, name string) string {
	for index := len(environment) - 1; index >= 0; index-- {
		key, value, exists := strings.Cut(environment[index], "=")
		if exists && strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

type releaseTemplateJSON struct {
	AuthenticodeLeafSignerCertificateDERSHA256 string                         `json:"authenticodeLeafSignerCertificateDerSha256"`
	Compatibility                              releasemanifest.Compatibility  `json:"compatibility"`
	Dependencies                               []releaseprofile.Dependency    `json:"dependencies"`
	ProfileID                                  string                         `json:"profileId"`
	ReleaseID                                  string                         `json:"releaseId"`
	SchemaVersion                              uint32                         `json:"schemaVersion"`
	ServiceHost                                releaseprofile.SelfRequirement `json:"serviceHost"`
}

func releaseTemplateDocument(t *testing.T) []byte {
	t.Helper()
	file := func(path string, role releasemanifest.FileRole, digit string) releaseprofile.Dependency {
		return releaseprofile.Dependency{
			Root: releasemanifest.RootInstallation, Path: path, Role: role,
			SHA256: strings.Repeat(digit, 64), Size: "1",
		}
	}
	document, err := json.Marshal(releaseTemplateJSON{
		AuthenticodeLeafSignerCertificateDERSHA256: strings.Repeat("c", 64),
		Compatibility: releasemanifest.RequiredCompatibility(),
		Dependencies: []releaseprofile.Dependency{
			file(`AgenticReview.Worker.Control.exe`, releasemanifest.RoleServiceWrapper, "1"),
			file(`AgenticReview.Worker.Executor.exe`, releasemanifest.RoleServiceWrapper, "2"),
			file(`app\control.mjs`, releasemanifest.RoleControlBundle, "3"),
			file(`app\executor.mjs`, releasemanifest.RoleExecutorBundle, "4"),
			file(`codex\codex.exe`, releasemanifest.RoleCodexCLI, "5"),
			file(`git\cmd\git.exe`, releasemanifest.RoleGitCLI, "6"),
			file(`native\AgenticReview.ProcessHost.exe`, releasemanifest.RoleProcessHost, "7"),
			file(`runtime\node.exe`, releasemanifest.RoleNodeRuntime, "8"),
			file(`service\control.xml`, releasemanifest.RoleServiceConfig, "9"),
			file(`service\executor.xml`, releasemanifest.RoleServiceConfig, "a"),
		},
		ProfileID:     releaseprofile.ProductionProfileID,
		ReleaseID:     "worker-test-1",
		SchemaVersion: releaseprofile.SchemaVersion,
		ServiceHost: releaseprofile.SelfRequirement{
			Root: releasemanifest.RootInstallation,
			Path: releaseprofile.ServiceHostRelativePath,
			Role: releasemanifest.RoleServiceHost,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := releaseprofile.ValidateDocument(document); err != nil {
		t.Fatalf("test template is invalid: %v", err)
	}
	return document
}
