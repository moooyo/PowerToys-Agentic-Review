package launchguard

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const winprocessImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"

var expectedProcessCreationReferences = map[string]int{
	"cmd/servicehostrelease/main.go|os/exec.CommandContext|productionDependencies|true": 1,
	"internal/winprocess/launcher_windows.go|CreateProcess|LaunchNode|false":            1,
}

var expectedProcessCreationImports = map[string]int{
	"cmd/servicehostrelease/main.go|os/exec": 1,
}

var expectedProcessCreationLiterals = map[string]int{
	"internal/winprocess/launcher_windows.go|CreateProcess failed after writing an untrusted output handle": 1,
	"internal/winprocess/launcher_windows.go|CreateProcess returned invalid process ownership handles":      1,
	"internal/winprocess/launcher_windows.go|CreateProcessW for fixed Node payload: %w":                     1,
}

var expectedWinprocessLaunchNodeIdentifiers = map[string]int{
	"internal/winprocess/cleanup.go":            0,
	"internal/winprocess/contract.go":           0,
	"internal/winprocess/dacl_windows.go":       0,
	"internal/winprocess/doc.go":                0,
	"internal/winprocess/launcher_windows.go":   1,
	"internal/winprocess/logic.go":              0,
	"internal/winprocess/platform_other.go":     1,
	"internal/winprocess/quarantine_windows.go": 0,
	"internal/winprocess/stdio.go":              0,
	"internal/winprocess/stdio_pipe.go":         0,
	"internal/winprocess/stdio_pipe_windows.go": 0,
	"internal/winprocess/stdio_windows.go":      0,
	"internal/winprocess/winprocess.go":         0,
	"internal/winprocess/wrapper_windows.go":    0,
}

var expectedWinprocessExportedAPI = map[string][]string{
	"internal/winprocess/cleanup.go":            {"var:ErrLaunchCleanupFatal"},
	"internal/winprocess/contract.go":           {},
	"internal/winprocess/dacl_windows.go":       {},
	"internal/winprocess/doc.go":                {},
	"internal/winprocess/launcher_windows.go":   {"func:LaunchNode"},
	"internal/winprocess/logic.go":              {},
	"internal/winprocess/platform_other.go":     {"func:LaunchNode", "func:OpenWrapperWatcher"},
	"internal/winprocess/quarantine_windows.go": {},
	"internal/winprocess/stdio.go": {
		"method:NodeStandardIO.Close", "method:NodeStandardIO.StandardError",
		"method:NodeStandardIO.StandardInput", "method:NodeStandardIO.StandardOutput",
		"type:NodeStandardIO", "type:NodeStandardInput", "type:NodeStandardOutput",
		"var:ErrStandardIOCloseTimeout", "var:ErrStandardIOUnavailable",
	},
	"internal/winprocess/stdio_pipe.go":         {},
	"internal/winprocess/stdio_pipe_windows.go": {},
	"internal/winprocess/stdio_windows.go":      {},
	"internal/winprocess/winprocess.go": {
		"const:RoleControl", "const:RoleExecutor", "func:WatchWrapper", "type:NodeIdentity",
		"type:NodeLaunchSpec", "type:NodeProcess", "type:Role", "type:RootTerminator",
		"type:WrapperWatcher", "var:ErrJobDrainTimeout", "var:ErrUnsupportedPlatform",
		"var:ErrWrapperUnstable",
	},
	"internal/winprocess/wrapper_windows.go": {"func:OpenWrapperWatcher"},
}

var expectedWinprocessExportedTypeMembers = map[string][]string{
	"internal/winprocess/stdio.go": {
		"embed:NodeStandardInput.io.WriteCloser",
		"embed:NodeStandardOutput.io.ReadCloser",
		"interface:NodeStandardInput.CloseWrite",
		"interface:NodeStandardInput.WriteContext",
		"interface:NodeStandardOutput.ReadContext",
	},
	"internal/winprocess/winprocess.go": {
		"field:NodeIdentity.CreationTime",
		"field:NodeIdentity.ProcessID",
		"field:NodeIdentity.StartKeyAvailable",
		"field:NodeIdentity.StartKeySequenceNumber",
		"field:NodeLaunchSpec.BundlePath",
		"field:NodeLaunchSpec.Environment",
		"field:NodeLaunchSpec.ExecutablePath",
		"field:NodeLaunchSpec.HostControlPipeName",
		"field:NodeLaunchSpec.MaximumMemoryBytes",
		"field:NodeLaunchSpec.MaximumProcesses",
		"field:NodeLaunchSpec.OwnServiceSID",
		"field:NodeLaunchSpec.PeerServiceSID",
		"field:NodeLaunchSpec.Role",
		"field:NodeLaunchSpec.ShutdownTimeout",
		"field:NodeLaunchSpec.WorkingDirectory",
		"interface:NodeProcess.ActivateAfterHostControl",
		"interface:NodeProcess.Close",
		"interface:NodeProcess.ObserveIdentity",
		"interface:NodeProcess.ProcessID",
		"interface:NodeProcess.RootJobActiveProcessCount",
		"interface:NodeProcess.StableIdentity",
		"interface:NodeProcess.TakeStandardIO",
		"interface:NodeProcess.Terminate",
		"interface:NodeProcess.Wait",
		"interface:RootTerminator.Terminate",
		"interface:WrapperWatcher.Close",
		"interface:WrapperWatcher.CreationTime",
		"interface:WrapperWatcher.ProcessID",
		"interface:WrapperWatcher.Wait",
	},
}

var expectedWinprocessExportedMethods = map[string][]string{
	"internal/winprocess/launcher_windows.go": {
		"method:windowsJobCounter.ActiveProcessCount",
		"method:windowsNodeProcess.ActivateAfterHostControl",
		"method:windowsNodeProcess.Close",
		"method:windowsNodeProcess.ObserveIdentity",
		"method:windowsNodeProcess.ProcessID",
		"method:windowsNodeProcess.RootJobActiveProcessCount",
		"method:windowsNodeProcess.StableIdentity",
		"method:windowsNodeProcess.TakeStandardIO",
		"method:windowsNodeProcess.Terminate",
		"method:windowsNodeProcess.Wait",
	},
	"internal/winprocess/logic.go": {
		"method:stableWrapper.Close",
		"method:stableWrapper.CreationTime",
		"method:stableWrapper.ProcessID",
		"method:stableWrapper.Wait",
		"method:wallDrainClock.Now",
		"method:wallDrainClock.Sleep",
	},
	"internal/winprocess/stdio.go": {
		"method:NodeStandardIO.Close",
		"method:NodeStandardIO.StandardError",
		"method:NodeStandardIO.StandardInput",
		"method:NodeStandardIO.StandardOutput",
	},
	"internal/winprocess/stdio_windows.go": {
		"method:windowsStandardIOStream.Close",
		"method:windowsStandardIOStream.CloseWrite",
		"method:windowsStandardIOStream.Read",
		"method:windowsStandardIOStream.ReadContext",
		"method:windowsStandardIOStream.Write",
		"method:windowsStandardIOStream.WriteContext",
	},
	"internal/winprocess/wrapper_windows.go": {
		"method:scmServiceStatusSource.Status",
		"method:windowsWrapperProcess.Close",
		"method:windowsWrapperProcess.QueryCreationTime",
		"method:windowsWrapperProcess.QueryProcessID",
		"method:windowsWrapperProcess.StillActive",
		"method:windowsWrapperProcess.Wait",
		"method:windowsWrapperProcessOpener.Open",
	},
}

var expectedWinprocessExportedSurfaceDigests = map[string]string{
	"internal/winprocess/cleanup.go":            "bda078169899942ae610727315c70604fdd4db4d7a66a7e838371b1d86f02d7e",
	"internal/winprocess/contract.go":           "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"internal/winprocess/dacl_windows.go":       "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"internal/winprocess/doc.go":                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"internal/winprocess/launcher_windows.go":   "d3d3064f7aa6e6e9550d1dbef2fa5b7c9f63b96e62bc46a8708cfa707638362e",
	"internal/winprocess/logic.go":              "dcd96c0a8dff976be674d0cdbaaceb80d5fe7d99dfb68eb5e31192b6c0f9384d",
	"internal/winprocess/platform_other.go":     "47c834f8acc5396050ebf481b07930f6053b3e2b4e9c15f7ad01bc22ab07f33b",
	"internal/winprocess/quarantine_windows.go": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"internal/winprocess/stdio.go":              "c211ea27a23740b1963034e437ee1db66275f9637f40367186bb8b7a254e3bb1",
	"internal/winprocess/stdio_pipe.go":         "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"internal/winprocess/stdio_pipe_windows.go": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"internal/winprocess/stdio_windows.go":      "7237adfa7268973a9cb23e808c993f0d4ad8acb40440130965173c7b5012db78",
	"internal/winprocess/winprocess.go":         "4812dbb7f5e409a0aa25de6d7caad97c9bdc84548531329f537bb06497aa432c",
	"internal/winprocess/wrapper_windows.go":    "20ceda2e0f03d709e6fdd8b7fac8ed974b4c313ea97475f9c9f8bffaa2bc4fc7",
}

func TestRawNodeLaunchHasOneGuardedProductionBridge(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	allowed := "internal/launchguard/bridge.go"
	count := 0
	processCreationCounts := make(map[string]int, len(expectedProcessCreationReferences))
	processCreationImportCounts := make(map[string]int, len(expectedProcessCreationImports))
	processCreationLiteralCounts := make(map[string]int, len(expectedProcessCreationLiterals))
	seenWinprocess := make(map[string]struct{}, len(expectedWinprocessLaunchNodeIdentifiers))
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		document, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		analysis, err := analyzeRawLaunch(relative, document)
		if err != nil {
			return err
		}
		if strings.HasPrefix(relative, "internal/winprocess/") {
			expected, exists := expectedWinprocessLaunchNodeIdentifiers[relative]
			if !exists {
				t.Errorf("%s is a new winprocess production file without a raw-launch identifier baseline", relative)
			} else if analysis.launchNodeIdentifiers != expected {
				t.Errorf("%s LaunchNode identifiers = %d, want %d", relative, analysis.launchNodeIdentifiers, expected)
			}
			wantAPI := append([]string(nil), expectedWinprocessExportedAPI[relative]...)
			sort.Strings(wantAPI)
			if strings.Join(analysis.exportedAPI, "\x00") != strings.Join(wantAPI, "\x00") {
				t.Errorf("%s exported API = %v, want %v", relative, analysis.exportedAPI, wantAPI)
			}
			wantMembers := append([]string(nil), expectedWinprocessExportedTypeMembers[relative]...)
			sort.Strings(wantMembers)
			if strings.Join(analysis.exportedTypeMembers, "\x00") != strings.Join(wantMembers, "\x00") {
				t.Errorf("%s exported type members = %v, want %v", relative, analysis.exportedTypeMembers, wantMembers)
			}
			wantMethods := append([]string(nil), expectedWinprocessExportedMethods[relative]...)
			sort.Strings(wantMethods)
			if strings.Join(analysis.exportedMethods, "\x00") != strings.Join(wantMethods, "\x00") {
				t.Errorf("%s exported receiver methods = %v, want %v", relative, analysis.exportedMethods, wantMethods)
			}
			wantDigest, hasDigest := expectedWinprocessExportedSurfaceDigests[relative]
			if !hasDigest || analysis.exportedSurfaceDigest != wantDigest {
				t.Errorf("%s exported surface digest = %s, want %s", relative, analysis.exportedSurfaceDigest, wantDigest)
			}
			seenWinprocess[relative] = struct{}{}
		}
		for _, problem := range analysis.problems {
			t.Errorf("%s: %s", relative, problem)
		}
		for _, reference := range analysis.references {
			if relative != allowed || !reference.direct {
				t.Errorf("%s:%d references raw winprocess.LaunchNode outside the guarded bridge", relative, reference.line)
			}
			count++
		}
		for _, reference := range analysis.processCreationReferences {
			key := processCreationReferenceKey(relative, reference)
			if expectedProcessCreationReferences[key] == 0 || !reference.direct {
				t.Errorf(
					"%s:%d uses unapproved Windows process creation entry %s in %s (closure=%v)",
					relative, reference.line, reference.name, reference.enclosingFunction,
					reference.insideFunctionLiteral,
				)
			}
			processCreationCounts[key]++
		}
		for _, imported := range analysis.processCreationImports {
			key := relative + "|" + imported
			if expectedProcessCreationImports[key] == 0 {
				t.Errorf("%s imports unapproved process creation package %s", relative, imported)
			}
			processCreationImportCounts[key]++
		}
		for _, literal := range analysis.processCreationLiterals {
			key := relative + "|" + literal
			if expectedProcessCreationLiterals[key] == 0 {
				t.Errorf("%s contains unapproved dynamic process creation literal %q", relative, literal)
			}
			processCreationLiteralCounts[key]++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for filename := range expectedWinprocessLaunchNodeIdentifiers {
		if _, exists := seenWinprocess[filename]; !exists {
			t.Errorf("winprocess production baseline file %s is missing", filename)
		}
	}
	if count != 1 {
		t.Fatalf("raw external LaunchNode reference count = %d, want 1", count)
	}
	for key, expected := range expectedProcessCreationReferences {
		if processCreationCounts[key] != expected {
			t.Errorf("process creation reference %s count = %d, want %d", key, processCreationCounts[key], expected)
		}
	}
	for key, expected := range expectedProcessCreationImports {
		if processCreationImportCounts[key] != expected {
			t.Errorf("process creation import %s count = %d, want %d", key, processCreationImportCounts[key], expected)
		}
	}
	for key, expected := range expectedProcessCreationLiterals {
		if processCreationLiteralCounts[key] != expected {
			t.Errorf("process creation literal %s count = %d, want %d", key, processCreationLiteralCounts[key], expected)
		}
	}
}

func TestLaunchGuardUsesExistingNonInheritedShareLocks(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test path")
	}
	serviceHostRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	winfileSource, err := os.ReadFile(filepath.Join(serviceHostRoot, "internal", "winfile", "access_relative_windows.go"))
	if err != nil {
		t.Fatal(err)
	}
	document := string(winfileSource)
	if !strings.Contains(document, "shareMode := uint32(windows.FILE_SHARE_READ)") ||
		!strings.Contains(document, "shareMode |= windows.FILE_SHARE_WRITE") ||
		strings.Contains(document, "shareMode |= windows.FILE_SHARE_DELETE") {
		t.Fatal("winfile relative-open sharing no longer denies delete and regular-file write sharing")
	}
	launchguardRoot := filepath.Dir(source)
	err = filepath.WalkDir(launchguardRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, forbidden := range []string{
			"NtCreateSection", "NtCreateUserProcess", "FILE_FLAG_DELETE_ON_CLOSE",
			"DuplicateHandle", "PROC_THREAD_ATTRIBUTE_HANDLE_LIST", "FinalPathDiagnostic",
		} {
			if strings.Contains(string(content), forbidden) {
				t.Errorf("%s contains forbidden launch mechanism %s", filepath.Base(path), forbidden)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRawLaunchAnalyzerRejectsAlternateEntrypoints(t *testing.T) {
	replacement, err := analyzeRawLaunch("replacement.go", []byte(`package winprocess
func LaunchNode() { launchNodeUnchecked() }
func LaunchNodeUnchecked() { launchNodeUnchecked() }
func launchNodeUnchecked() {}
`))
	if err != nil {
		t.Fatal(err)
	}
	if replacement.launchNodeIdentifiers != 1 ||
		!containsString(replacement.exportedAPI, "func:LaunchNodeUnchecked") {
		t.Fatalf("replacement entrypoint analysis = %#v", replacement)
	}

	interfaceMethod, err := analyzeRawLaunch("interface.go", []byte(`package winprocess
type NodeProcess interface {
	Close() error
	LaunchUnchecked() error
}
`))
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(interfaceMethod.exportedTypeMembers, "interface:NodeProcess.LaunchUnchecked") {
		t.Fatalf("interface entrypoint analysis = %#v", interfaceMethod)
	}

	promotedMethod, err := analyzeRawLaunch("promoted.go", []byte(`package winprocess
type launchCapability struct{}
func (launchCapability) LaunchUnchecked() error { return nil }
type NodeIdentity struct { launchCapability }
`))
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(promotedMethod.exportedTypeMembers, "embed:NodeIdentity.launchCapability") ||
		!containsString(promotedMethod.exportedMethods, "method:launchCapability.LaunchUnchecked") {
		t.Fatalf("promoted entrypoint analysis = %#v", promotedMethod)
	}

	originalSignature, err := analyzeRawLaunch("signature.go", []byte(`package winprocess
type NodeProcess interface { ActivateAfterHostControl() error }
`))
	if err != nil {
		t.Fatal(err)
	}
	changedSignature, err := analyzeRawLaunch("signature.go", []byte(`package winprocess
type NodeProcess interface { ActivateAfterHostControl(NodeLaunchSpec) (NodeProcess, error) }
`))
	if err != nil {
		t.Fatal(err)
	}
	if originalSignature.exportedSurfaceDigest == changedSignature.exportedSurfaceDigest {
		t.Fatal("exported surface digest did not capture an interface method signature change")
	}

	processCreation, err := analyzeRawLaunch("creation.go", []byte(`package sample
import w "golang.org/x/sys/windows"
func run() { _ = w.CreateProcessWithToken() }
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(processCreation.processCreationReferences) != 1 ||
		processCreation.processCreationReferences[0].name != "CreateProcessWithToken" ||
		!processCreation.processCreationReferences[0].direct {
		t.Fatalf("process creation analysis = %#v", processCreation)
	}

	helperCreation, err := analyzeRawLaunch("helper.go", []byte(`package winprocess
import "golang.org/x/sys/windows"
func LaunchNode() { launchNodeRaw() }
func launchNodeRaw() { _ = windows.CreateProcess(nil, nil, nil, nil, false, 0, nil, nil, nil, nil) }
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(helperCreation.processCreationReferences) != 1 ||
		helperCreation.processCreationReferences[0].enclosingFunction != "launchNodeRaw" {
		t.Fatalf("helper process creation analysis = %#v", helperCreation)
	}

	standardLibrary, err := analyzeRawLaunch("standard.go", []byte(`package sibling
import "os/exec"
func bypass() { _ = exec.Command("node.exe", "bundle.js") }
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(standardLibrary.processCreationImports) != 1 ||
		len(standardLibrary.processCreationReferences) != 1 ||
		standardLibrary.processCreationReferences[0].name != "os/exec.Command" ||
		standardLibrary.processCreationReferences[0].enclosingFunction != "bypass" {
		t.Fatalf("standard-library process creation analysis = %#v", standardLibrary)
	}

	dynamic, err := analyzeRawLaunch("dynamic.go", []byte(`package sample
const proc = "NtCreateUserProcess"
`))
	if err != nil || len(dynamic.processCreationLiterals) != 1 {
		t.Fatalf("dynamic process creation analysis = %#v, %v", dynamic, err)
	}

	shellExecute, err := analyzeRawLaunch("shell.go", []byte(`package sample
func run() { _ = windows.ShellExecuteW(nil, nil, nil, nil, nil, 0) }
const legacy = "WinExec"
`))
	if err != nil || len(shellExecute.processCreationReferences) != 1 ||
		shellExecute.processCreationReferences[0].name != "ShellExecuteW" ||
		len(shellExecute.processCreationLiterals) != 1 {
		t.Fatalf("shell process creation analysis = %#v, %v", shellExecute, err)
	}

	for _, name := range []string{
		"CreateProcessInternalW", "CreateProcessAsUserW", "CreateProcessWithTokenW",
		"CreateProcessWithLogonW", "NtCreateProcess", "NtCreateProcessEx",
		"NtCreateUserProcess", "RtlCreateUserProcess", "SHCreateProcessAsUserW",
		"StartProcessForPayload", "ZwCreateUserProcess",
	} {
		source := fmt.Sprintf("package sample\nfunc run() { _ = api.%s() }\nconst proc = %q\n", name, name)
		family, err := analyzeRawLaunch("family.go", []byte(source))
		if err != nil || len(family.processCreationReferences) != 1 ||
			family.processCreationReferences[0].name != name ||
			len(family.processCreationLiterals) != 1 {
			t.Fatalf("process creation family %s analysis = %#v, %v", name, family, err)
		}
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

type rawLaunchReference struct {
	name                  string
	line                  int
	direct                bool
	enclosingFunction     string
	insideFunctionLiteral bool
}

type rawLaunchAnalysis struct {
	references                []rawLaunchReference
	problems                  []string
	launchNodeIdentifiers     int
	exportedAPI               []string
	exportedTypeMembers       []string
	exportedMethods           []string
	exportedSurface           []string
	exportedSurfaceDigest     string
	processCreationReferences []rawLaunchReference
	processCreationImports    []string
	processCreationLiterals   []string
}

func analyzeRawLaunch(filename string, source []byte) (rawLaunchAnalysis, error) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, filename, source, parser.ParseComments)
	if err != nil {
		return rawLaunchAnalysis{}, err
	}
	parents := astParents(parsed)
	aliases := make(map[string]struct{})
	importPaths := make(map[string]string)
	analysis := rawLaunchAnalysis{}
	for _, declaration := range parsed.Decls {
		switch value := declaration.(type) {
		case *ast.GenDecl:
			if genDeclHasExportedSurface(value) {
				canonical, err := canonicalNode(value)
				if err != nil {
					return rawLaunchAnalysis{}, err
				}
				analysis.exportedSurface = append(analysis.exportedSurface, canonical)
			}
			kind := value.Tok.String()
			for _, specification := range value.Specs {
				switch spec := specification.(type) {
				case *ast.TypeSpec:
					if spec.Name.IsExported() {
						analysis.exportedAPI = append(analysis.exportedAPI, "type:"+spec.Name.Name)
						analysis.exportedTypeMembers = append(
							analysis.exportedTypeMembers,
							exportedTypeMembers(spec.Name.Name, spec.Type)...,
						)
					}
				case *ast.ValueSpec:
					for _, name := range spec.Names {
						if name.IsExported() {
							analysis.exportedAPI = append(analysis.exportedAPI, kind+":"+name.Name)
						}
					}
				}
			}
		case *ast.FuncDecl:
			if !value.Name.IsExported() {
				continue
			}
			canonical, err := canonicalFunctionSignature(value)
			if err != nil {
				return rawLaunchAnalysis{}, err
			}
			analysis.exportedSurface = append(analysis.exportedSurface, canonical)
			if value.Recv == nil {
				analysis.exportedAPI = append(analysis.exportedAPI, "func:"+value.Name.Name)
				continue
			}
			receiver := receiverTypeName(value.Recv.List[0].Type)
			analysis.exportedMethods = append(analysis.exportedMethods, "method:"+receiver+"."+value.Name.Name)
			if ast.IsExported(receiver) {
				analysis.exportedAPI = append(analysis.exportedAPI, "method:"+receiver+"."+value.Name.Name)
			}
		}
	}
	sort.Strings(analysis.exportedAPI)
	sort.Strings(analysis.exportedTypeMembers)
	sort.Strings(analysis.exportedMethods)
	sort.Strings(analysis.exportedSurface)
	digest := sha256.Sum256([]byte(strings.Join(analysis.exportedSurface, "\n")))
	analysis.exportedSurfaceDigest = hex.EncodeToString(digest[:])
	for _, imported := range parsed.Imports {
		path, err := strconv.Unquote(imported.Path.Value)
		if err != nil {
			return rawLaunchAnalysis{}, err
		}
		if imported.Name != nil && imported.Name.Name == "." {
			analysis.problems = append(analysis.problems, "dot imports are forbidden")
		}
		alias := pathpkg.Base(path)
		if imported.Name != nil {
			alias = imported.Name.Name
		}
		if alias != "." && alias != "_" {
			importPaths[alias] = path
		}
		if path == "os/exec" {
			analysis.processCreationImports = append(analysis.processCreationImports, path)
		}
		if path != winprocessImportPath {
			continue
		}
		if alias != "." && alias != "_" {
			aliases[alias] = struct{}{}
		}
	}
	for _, group := range parsed.Comments {
		for _, comment := range group.List {
			if strings.Contains(comment.Text, "go:linkname") {
				analysis.problems = append(analysis.problems, "go:linkname is forbidden")
			}
		}
	}
	ast.Inspect(parsed, func(node ast.Node) bool {
		if literal, ok := node.(*ast.BasicLit); ok && literal.Kind == token.STRING {
			text, err := strconv.Unquote(literal.Value)
			if err == nil {
				for _, name := range processCreationNames() {
					if strings.Contains(text, name) {
						analysis.processCreationLiterals = append(analysis.processCreationLiterals, text)
						break
					}
				}
			}
		}
		identifier, ok := node.(*ast.Ident)
		if ok {
			if identifier.Name == "LaunchNode" {
				if selector, isSelector := parents[identifier].(*ast.SelectorExpr); !isSelector || selector.Sel != identifier {
					analysis.launchNodeIdentifiers++
				}
			}
			if _, alias := aliases[identifier.Name]; alias && identifier.Obj != nil {
				analysis.problems = append(analysis.problems, "winprocess import alias is shadowed")
			}
		}
		selector, ok := node.(*ast.SelectorExpr)
		if ok {
			creationName, isCreation := processCreationReferenceName(selector, importPaths)
			if isCreation {
				call, direct := parents[selector].(*ast.CallExpr)
				function, insideLiteral := enclosingFunction(parents, selector)
				analysis.processCreationReferences = append(analysis.processCreationReferences, rawLaunchReference{
					name: creationName, line: fileSet.Position(selector.Pos()).Line,
					direct: direct && call.Fun == selector, enclosingFunction: function,
					insideFunctionLiteral: insideLiteral,
				})
			}
		}
		if !ok || selector.Sel.Name != "LaunchNode" {
			return true
		}
		identifier, ok = selector.X.(*ast.Ident)
		if !ok || identifier.Obj != nil {
			return true
		}
		if _, imported := aliases[identifier.Name]; !imported {
			return true
		}
		call, direct := parents[selector].(*ast.CallExpr)
		analysis.references = append(analysis.references, rawLaunchReference{
			name:   "LaunchNode",
			line:   fileSet.Position(selector.Pos()).Line,
			direct: direct && call.Fun == selector,
		})
		return true
	})
	return analysis, nil
}

func processCreationReferenceKey(filename string, reference rawLaunchReference) string {
	return strings.Join([]string{
		filename,
		reference.name,
		reference.enclosingFunction,
		strconv.FormatBool(reference.insideFunctionLiteral),
	}, "|")
}

func processCreationReferenceName(
	selector *ast.SelectorExpr,
	importPaths map[string]string,
) (string, bool) {
	if selector == nil {
		return "", false
	}
	if isProcessCreationName(selector.Sel.Name) {
		return selector.Sel.Name, true
	}
	identifier, ok := selector.X.(*ast.Ident)
	if !ok || identifier.Obj != nil {
		return "", false
	}
	importPath := importPaths[identifier.Name]
	switch {
	case importPath == "os/exec" &&
		(selector.Sel.Name == "Command" || selector.Sel.Name == "CommandContext"):
		return importPath + "." + selector.Sel.Name, true
	case (importPath == "os" || importPath == "syscall") && selector.Sel.Name == "StartProcess":
		return importPath + "." + selector.Sel.Name, true
	default:
		return "", false
	}
}

func enclosingFunction(parents map[ast.Node]ast.Node, node ast.Node) (string, bool) {
	insideFunctionLiteral := false
	for current := parents[node]; current != nil; current = parents[current] {
		switch typed := current.(type) {
		case *ast.FuncLit:
			insideFunctionLiteral = true
		case *ast.FuncDecl:
			if typed.Recv == nil {
				return typed.Name.Name, insideFunctionLiteral
			}
			return receiverTypeName(typed.Recv.List[0].Type) + "." + typed.Name.Name, insideFunctionLiteral
		}
	}
	return "", insideFunctionLiteral
}

func genDeclHasExportedSurface(declaration *ast.GenDecl) bool {
	if declaration == nil {
		return false
	}
	for _, specification := range declaration.Specs {
		switch spec := specification.(type) {
		case *ast.TypeSpec:
			if spec.Name.IsExported() {
				return true
			}
		case *ast.ValueSpec:
			for _, name := range spec.Names {
				if name.IsExported() {
					return true
				}
			}
		}
	}
	return false
}

func canonicalFunctionSignature(function *ast.FuncDecl) (string, error) {
	if function == nil {
		return "", errors.New("nil function declaration")
	}
	clone := *function
	clone.Body = nil
	clone.Doc = nil
	return canonicalNode(&clone)
}

func canonicalNode(node ast.Node) (string, error) {
	var buffer bytes.Buffer
	if err := printer.Fprint(&buffer, token.NewFileSet(), node); err != nil {
		return "", err
	}
	return buffer.String(), nil
}

func exportedTypeMembers(typeName string, expression ast.Expr) []string {
	members := []string{}
	switch typed := expression.(type) {
	case *ast.StructType:
		for _, field := range typed.Fields.List {
			if len(field.Names) == 0 {
				members = append(members, "embed:"+typeName+"."+typeExpressionName(field.Type))
				continue
			}
			for _, name := range field.Names {
				if name.IsExported() {
					members = append(members, "field:"+typeName+"."+name.Name)
				}
			}
		}
	case *ast.InterfaceType:
		for _, field := range typed.Methods.List {
			if len(field.Names) == 0 {
				members = append(members, "embed:"+typeName+"."+typeExpressionName(field.Type))
				continue
			}
			for _, name := range field.Names {
				members = append(members, "interface:"+typeName+"."+name.Name)
			}
		}
	}
	return members
}

func typeExpressionName(expression ast.Expr) string {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.SelectorExpr:
		return typeExpressionName(typed.X) + "." + typed.Sel.Name
	case *ast.StarExpr:
		return "*" + typeExpressionName(typed.X)
	case *ast.IndexExpr:
		return typeExpressionName(typed.X) + "[" + typeExpressionName(typed.Index) + "]"
	case *ast.IndexListExpr:
		arguments := make([]string, 0, len(typed.Indices))
		for _, argument := range typed.Indices {
			arguments = append(arguments, typeExpressionName(argument))
		}
		return typeExpressionName(typed.X) + "[" + strings.Join(arguments, ",") + "]"
	case *ast.InterfaceType:
		return "interface"
	default:
		return "<unknown>"
	}
}

func receiverTypeName(value ast.Expr) string {
	switch typed := value.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.StarExpr:
		return receiverTypeName(typed.X)
	case *ast.IndexExpr:
		return receiverTypeName(typed.X)
	case *ast.IndexListExpr:
		return receiverTypeName(typed.X)
	default:
		return ""
	}
}

func processCreationNames() []string {
	return []string{
		"CreateProcess", "NtCreateProcess", "NtCreateUserProcess", "RtlCreateUserProcess",
		"SHCreateProcessAsUser", "ShellExecute", "StartProcess", "WinExec",
		"ZwCreateProcess", "ZwCreateUserProcess",
	}
}

func isProcessCreationName(value string) bool {
	for _, family := range processCreationNames() {
		if strings.HasPrefix(value, family) {
			return true
		}
	}
	return false
}

func astParents(root ast.Node) map[ast.Node]ast.Node {
	parents := make(map[ast.Node]ast.Node)
	stack := make([]ast.Node, 0, 16)
	ast.Inspect(root, func(node ast.Node) bool {
		if node == nil {
			stack = stack[:len(stack)-1]
			return false
		}
		if len(stack) != 0 {
			parents[node] = stack[len(stack)-1]
		}
		stack = append(stack, node)
		return true
	})
	return parents
}
