package roleconfigv3lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func TestRoleConfigV3LabHasNoProductionConsumer(t *testing.T) {
	serviceHostRoot := serviceHostRoot(t)
	fileSet := token.NewFileSet()
	err := filepath.WalkDir(serviceHostRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		relative, err := filepath.Rel(serviceHostRoot, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if strings.HasPrefix(relative, "internal/roleconfigv3lab/") {
			return nil
		}
		parsed, err := parser.ParseFile(fileSet, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imported := range parsed.Imports {
			if strings.Contains(imported.Path.Value, "/internal/roleconfigv3lab") {
				t.Errorf("%s imports dormant roleconfigv3lab", relative)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestProductionBootstrapAndClaimAuthoritySourcesRemainExact(t *testing.T) {
	root := serviceHostRoot(t)
	want := map[string]string{
		"internal/localrpc/protocol.go":                   "c7b347037aa8d58b6f6294ac4de2c876ef6cfe8fd0d9d603101578fb28c33e9c",
		"internal/localrpc/runtime_bootstrap.go":          "4cc3abc73f06b9cd705d6771964d30319a547c12334a3c134a8d15ab82adcfb4",
		"internal/localrpc/runtime_bootstrap_exchange.go": "ef0d45fbedd15093d351c1206f6fff9680e8c0e21ac0d26b35e033fd090c5c2d",
		"internal/localrpc/server.go":                     "6e71b8daf0b9fc36f885eb065f9ac224b604a02893ed3a56f1ced0c5c5d04819",
		"internal/platform/production_windows.go":         "53257a54a58859481f7b02f8f3be7781b8397d8d2c0e6b7b7dda96ad0b4b211f",
		"internal/preflight/compose.go":                   "9006f189b32034a200e0cf385fd8a396a215391649054cc01a977197fc73c0c1",
		"internal/releasemanifest/manifest.go":            "15930884496392fdd8f1fbbbb55f43b87cab1a6254c65c30babcf587b09dc007",
		"internal/releaseprofile/profile.go":              "e1049d6425c3d8c148cef79583849b9f6b8cef9e7cc61d471ebe6d0544397491",
	}
	for relative, expected := range want {
		document, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		normalized, ok := normalizeSource(document)
		if !ok {
			t.Errorf("%s has a noncanonical source encoding", relative)
			continue
		}
		digest := sha256.Sum256(normalized)
		if actual := hex.EncodeToString(digest[:]); actual != expected {
			t.Errorf("%s SHA-256 = %s, want %s", relative, actual, expected)
		}
	}
}

func TestLabImplementationSourcesRemainExact(t *testing.T) {
	root := serviceHostRoot(t)
	want := map[string]string{
		"internal/roleconfigv3lab/contract.go":          "9c08fdcd2b7e10f23645be7dc82493d8ca94329ead030986c4877174b052304d",
		"internal/roleconfigv3lab/role_config.go":       "0890cf2d2e48c1b15aca208da2e3bdc18fdfc1eee160cdb6f2151d3a198d33d2",
		"internal/roleconfigv3lab/runtime_bootstrap.go": "98b8e2fb8a618e024b8d13bb43695aaf58a02db9c07c8be45eb4b9f0c83d3b62",
	}
	directory := filepath.Join(root, "internal", "roleconfigv3lab")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	actualSources := make([]string, 0)
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".go" &&
			!strings.HasSuffix(entry.Name(), "_test.go") {
			actualSources = append(actualSources, "internal/roleconfigv3lab/"+entry.Name())
		}
	}
	sort.Strings(actualSources)
	expectedSources := make([]string, 0, len(want))
	for relative := range want {
		expectedSources = append(expectedSources, relative)
	}
	sort.Strings(expectedSources)
	if strings.Join(actualSources, "\n") != strings.Join(expectedSources, "\n") {
		t.Fatalf("lab implementation source set = %v, want %v", actualSources, expectedSources)
	}
	for relative, expected := range want {
		document, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		normalized, ok := normalizeSource(document)
		if !ok {
			t.Errorf("%s has a noncanonical source encoding", relative)
			continue
		}
		digest := sha256.Sum256(normalized)
		if actual := hex.EncodeToString(digest[:]); actual != expected {
			t.Errorf("%s SHA-256 = %s, want %s", relative, actual, expected)
		}
		mutated := append(append([]byte(nil), normalized...), '\n')
		mutatedDigest := sha256.Sum256(mutated)
		if hex.EncodeToString(mutatedDigest[:]) == expected {
			t.Errorf("%s source pin did not reject a mutation", relative)
		}
		longMutation := append(append([]byte(nil), normalized...), []byte("\nfunc init(){/*")...)
		longMutation = append(longMutation, bytes.Repeat([]byte{'x'}, 70*1024)...)
		longMutation = append(longMutation, []byte("*/}\n")...)
		normalizedLongMutation, valid := normalizeSource(longMutation)
		if !valid || len(normalizedLongMutation) != len(longMutation) {
			t.Errorf("%s long-line mutation was truncated during normalization", relative)
		} else if digest := sha256.Sum256(normalizedLongMutation); hex.EncodeToString(digest[:]) == expected {
			t.Errorf("%s long-line mutation bypassed the source pin", relative)
		}
	}
}

func TestLabPackageExposesOnlyExactReviewedAPI(t *testing.T) {
	root := serviceHostRoot(t)
	directory := filepath.Join(root, "internal", "roleconfigv3lab")
	fileSet := token.NewFileSet()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	actual := make([]string, 0)
	actualFields := make(map[string][]string)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fileSet, filepath.Join(directory, entry.Name()), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		collectExportedAPI(parsed, &actual, actualFields)
	}
	sort.Strings(actual)
	expected := []string{
		"method:RoleConfig.CanonicalJSON", "method:RoleConfig.Role", "method:RoleConfig.SHA256",
		"method:RuntimeBootstrap.CanonicalJSON", "method:RuntimeBootstrap.DisabledReadiness",
		"method:RuntimeBootstrap.ExecutionAuthority", "method:RuntimeBootstrap.Role",
		"method:RuntimeBootstrap.RoleConfig", "method:RuntimeBootstrap.SHA256",
		"type:DisabledReadinessProjection", "type:Role", "type:RoleConfig",
		"type:RuntimeBootstrap", "type:RuntimeBootstrapFacts",
		"value:ARWXProtocolMajor", "value:ARWXProtocolMinor", "value:CompletionMode",
		"value:DisabledReasonCode", "value:ErrInvalidRoleConfig",
		"value:ErrInvalidRuntimeBootstrap", "value:ErrRoleMismatch", "value:FoundationVersion",
		"value:HostControlProtocolVersion", "value:JobExecutionEnvelopeVersion",
		"value:NewControlRoleConfig", "value:NewExecutorRoleConfig", "value:NewRuntimeBootstrap",
		"value:ParseRoleConfig", "value:ParseRuntimeBootstrap",
		"value:RequiredRuntimeBootstrapVersion", "value:RequiredWorkerAPIVersion",
		"value:RoleConfigMaximumBytes", "value:RoleConfigProfile", "value:RoleControl",
		"value:RoleExecutor", "value:RuntimeBootstrapARWXMaximumFrameBytes",
		"value:RuntimeBootstrapARWXMaximumQueuedBytes", "value:RuntimeBootstrapARWXMinimumQueuedBytes",
		"value:RuntimeBootstrapHostControlRPCVersion", "value:RuntimeBootstrapMaximumBytes",
		"value:RuntimeBootstrapMaximumGracefulTimeoutMS", "value:RuntimeBootstrapMinimumGracefulTimeoutMS",
		"value:RuntimeBootstrapMinimumTerminationReserve", "value:RuntimeBootstrapVersion",
	}
	sort.Strings(expected)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("exported API differs:\n got: %v\nwant: %v", actual, expected)
	}
	expectedFields := map[string][]string{
		"DisabledReadinessProjection": {"AvailableSlots", "ExecutionAuthority", "Ready", "ReasonCode"},
		"RuntimeBootstrapFacts": {
			"BootstrapID", "ForceTerminationReserveMS", "GracefulTimeoutMS",
			"InstallationManifestSHA256", "MaximumQueuedBytesPerDirection", "NodeBundleSHA256",
			"PreflightSHA256", "ReleaseID", "ReleaseTemplateSHA256", "Role", "RoleConfig",
			"WorkerNodeID",
		},
	}
	for name, fields := range actualFields {
		sort.Strings(fields)
		want, ok := expectedFields[name]
		if !ok {
			t.Fatalf("unexpected exported fields on %s: %v", name, fields)
		}
		sort.Strings(want)
		if strings.Join(fields, "\n") != strings.Join(want, "\n") {
			t.Fatalf("%s fields = %v, want %v", name, fields, want)
		}
		delete(expectedFields, name)
	}
	if len(expectedFields) != 0 {
		t.Fatalf("missing exported field sets: %v", expectedFields)
	}
}

func collectExportedAPI(file *ast.File, names *[]string, fields map[string][]string) {
	for _, declaration := range file.Decls {
		switch typed := declaration.(type) {
		case *ast.GenDecl:
			for _, specification := range typed.Specs {
				switch item := specification.(type) {
				case *ast.ValueSpec:
					for _, name := range item.Names {
						if name.IsExported() {
							*names = append(*names, "value:"+name.Name)
						}
					}
				case *ast.TypeSpec:
					if !item.Name.IsExported() {
						continue
					}
					*names = append(*names, "type:"+item.Name.Name)
					switch shape := item.Type.(type) {
					case *ast.StructType:
						for _, field := range shape.Fields.List {
							if len(field.Names) == 0 {
								fields[item.Name.Name] = append(fields[item.Name.Name], "<embedded>")
								continue
							}
							for _, name := range field.Names {
								if name.IsExported() {
									fields[item.Name.Name] = append(fields[item.Name.Name], name.Name)
								}
							}
						}
					case *ast.InterfaceType:
						for _, method := range shape.Methods.List {
							if len(method.Names) == 0 {
								fields[item.Name.Name] = append(fields[item.Name.Name], "<embedded-interface>")
								continue
							}
							for _, name := range method.Names {
								if name.IsExported() {
									fields[item.Name.Name] = append(fields[item.Name.Name], "method:"+name.Name)
								}
							}
						}
					}
				}
			}
		case *ast.FuncDecl:
			if typed.Name == nil || !typed.Name.IsExported() {
				continue
			}
			if typed.Recv == nil {
				*names = append(*names, "value:"+typed.Name.Name)
				continue
			}
			receiver := receiverName(typed.Recv.List[0].Type)
			*names = append(*names, "method:"+receiver+"."+typed.Name.Name)
		}
	}
}

func receiverName(expression ast.Expr) string {
	if pointer, ok := expression.(*ast.StarExpr); ok {
		expression = pointer.X
	}
	if identifier, ok := expression.(*ast.Ident); ok {
		return identifier.Name
	}
	return "<unsupported>"
}

func serviceHostRoot(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve roleconfigv3lab architecture test source")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
}

func normalizeSource(document []byte) ([]byte, bool) {
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) {
		return nil, false
	}
	normalized := bytes.ReplaceAll(document, []byte{'\r', '\n'}, []byte{'\n'})
	if bytes.ContainsRune(normalized, '\r') {
		return nil, false
	}
	return normalized, true
}
