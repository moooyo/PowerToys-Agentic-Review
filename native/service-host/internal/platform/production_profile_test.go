package platform

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

const (
	workerTransportImport = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
	winCertImport         = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/wincert"
	cngImport             = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
)

type productionSourceFile struct {
	path    string
	file    *ast.File
	imports map[string]string
}

type productionReference struct {
	path     string
	function string
}

func TestProductionProfileAcceptsOnlySchemaVersion4BearerTokenConfiguration(t *testing.T) {
	configuration := config.Config{
		SchemaVersion: config.SchemaVersion,
		Control: &config.ControlConfiguration{
			WorkerAuthenticationProfile: config.WorkerAuthenticationProfileBearerTokenV1,
		},
	}
	if err := requireProductionBearerProfile(configuration); err != nil {
		t.Fatalf("schemaVersion 4 Bearer Token profile was rejected: %v", err)
	}

	configuration.SchemaVersion = 3
	if err := requireProductionBearerProfile(configuration); err == nil {
		t.Fatal("historical schemaVersion 3 remained a positive production authentication path")
	}
	configuration.SchemaVersion = config.SchemaVersion
	configuration.Control.WorkerAuthenticationProfile = ""
	if err := requireProductionBearerProfile(configuration); err == nil {
		t.Fatal("schemaVersion 4 without the exact Bearer Token profile was accepted")
	}
}

func TestProductionSourceHasOneBearerPathAndNoLegacyWorkerClientReference(t *testing.T) {
	_, files := parseProductionSource(t)
	references := map[string][]productionReference{}
	for _, source := range files {
		workerAliases := importAliases(source.imports, workerTransportImport)
		if _, exists := workerAliases["."]; exists {
			t.Fatalf("production file %s uses a dot import for workertransport", source.path)
		}
		if _, exists := workerAliases["_"]; exists {
			t.Fatalf("production file %s uses a blank import for workertransport", source.path)
		}
		if strings.HasPrefix(source.path, "internal/platform/") {
			for _, imported := range source.imports {
				if imported == winCertImport || imported == cngImport {
					t.Fatalf("production platform file %s imports a retired credential package", source.path)
				}
			}
		}
		ast.Inspect(source.file, func(node ast.Node) bool {
			if strings.HasPrefix(source.path, "internal/platform/") {
				if keyed, ok := node.(*ast.KeyValueExpr); ok {
					if name, nameOK := keyed.Key.(*ast.Ident); nameOK && name.Name == "MTLSCredential" {
						t.Fatalf("production platform file %s supplies historical mTLS preflight evidence", source.path)
					}
				}
			}
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			owner, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			if _, tracked := workerAliases[owner.Name]; !tracked {
				return true
			}
			reference := productionReference{
				path: source.path, function: enclosingFunction(source.file, selector.Pos()),
			}
			references[selector.Sel.Name] = append(references[selector.Sel.Name], reference)
			return true
		})
	}

	expected := productionReference{
		path: "internal/platform/production_windows.go", function: "buildRoleRuntime",
	}
	for _, name := range []string{"LoadWorkerAuth", "NewClient"} {
		observed := references[name]
		if len(observed) != 1 || observed[0] != expected {
			t.Fatalf("production %s references = %v, want exactly %v", name, observed, expected)
		}
	}
}

func TestProductionCredentialStageOnlyValidatesTheTokenProfile(t *testing.T) {
	_, files := parseProductionSource(t)
	var source *productionSourceFile
	for index := range files {
		if files[index].path == "internal/platform/production_windows.go" {
			source = &files[index]
			break
		}
	}
	if source == nil {
		t.Fatal("production_windows.go was not parsed")
	}
	var method *ast.FuncDecl
	for _, declaration := range source.file.Decls {
		candidate, ok := declaration.(*ast.FuncDecl)
		if ok && candidate.Recv != nil && candidate.Name.Name == "openRoleCredentials" {
			if method != nil {
				t.Fatal("openRoleCredentials is declared more than once")
			}
			method = candidate
		}
	}
	if method == nil || method.Body == nil {
		t.Fatal("openRoleCredentials production method is unavailable")
	}

	gateIndex := -1
	credentialAliases := map[string]struct{}{}
	for alias, imported := range source.imports {
		if imported == cngImport || imported == winCertImport || imported == workerTransportImport {
			credentialAliases[alias] = struct{}{}
		}
	}
	for index, statement := range method.Body.List {
		if isFailClosedProductionProfileGate(statement) {
			if gateIndex >= 0 {
				t.Fatal("openRoleCredentials contains more than one production profile gate")
			}
			gateIndex = index
		}
		ast.Inspect(statement, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			owner, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			if _, credentialAction := credentialAliases[owner.Name]; !credentialAction {
				return true
			}
			if index <= gateIndex || gateIndex < 0 {
				t.Fatalf("credential action %s.%s appears before the fail-closed profile gate",
					owner.Name, selector.Sel.Name)
			}
			t.Fatalf("credential stage invokes retired credential action %s.%s", owner.Name, selector.Sel.Name)
			return true
		})
	}
	if gateIndex < 0 {
		t.Fatal("openRoleCredentials lacks the exact fail-closed production profile gate")
	}
}

func parseProductionSource(t *testing.T) (*token.FileSet, []productionSourceFile) {
	t.Helper()
	root := filepath.Clean(filepath.Join("..", ".."))
	fileSet := token.NewFileSet()
	files := []productionSourceFile{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		parsed, parseErr := parser.ParseFile(fileSet, path, nil, parser.AllErrors)
		if parseErr != nil {
			return fmt.Errorf("parse %s: %w", path, parseErr)
		}
		relative, relativeErr := filepath.Rel(root, path)
		if relativeErr != nil {
			return relativeErr
		}
		imports := make(map[string]string, len(parsed.Imports))
		for _, imported := range parsed.Imports {
			importPath, unquoteErr := strconv.Unquote(imported.Path.Value)
			if unquoteErr != nil {
				return fmt.Errorf("parse import in %s: %w", path, unquoteErr)
			}
			alias := filepath.Base(importPath)
			if imported.Name != nil {
				alias = imported.Name.Name
			}
			imports[alias] = importPath
		}
		files = append(files, productionSourceFile{
			path: filepath.ToSlash(relative), file: parsed, imports: imports,
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return fileSet, files
}

func importAliases(imports map[string]string, target string) map[string]struct{} {
	aliases := map[string]struct{}{}
	for alias, imported := range imports {
		if imported == target {
			aliases[alias] = struct{}{}
		}
	}
	return aliases
}

func enclosingFunction(file *ast.File, position token.Pos) string {
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Pos() <= position && position <= function.End() {
			return function.Name.Name
		}
	}
	return ""
}

func isFailClosedProductionProfileGate(statement ast.Stmt) bool {
	conditional, ok := statement.(*ast.IfStmt)
	if !ok || conditional.Else != nil || len(conditional.Body.List) != 1 {
		return false
	}
	assignment, ok := conditional.Init.(*ast.AssignStmt)
	if !ok || assignment.Tok != token.DEFINE || len(assignment.Lhs) != 1 || len(assignment.Rhs) != 1 {
		return false
	}
	errName, ok := assignment.Lhs[0].(*ast.Ident)
	if !ok || errName.Name != "err" {
		return false
	}
	call, ok := assignment.Rhs[0].(*ast.CallExpr)
	if !ok || len(call.Args) != 1 {
		return false
	}
	function, ok := call.Fun.(*ast.Ident)
	if !ok || function.Name != "requireProductionBearerProfile" {
		return false
	}
	condition, ok := conditional.Cond.(*ast.BinaryExpr)
	if !ok || condition.Op != token.NEQ || !isIdentifier(condition.X, "err") || !isIdentifier(condition.Y, "nil") {
		return false
	}
	result, ok := conditional.Body.List[0].(*ast.ReturnStmt)
	return ok && len(result.Results) == 1 && isIdentifier(result.Results[0], "err")
}

func isIdentifier(expression ast.Expr, name string) bool {
	identifier, ok := expression.(*ast.Ident)
	return ok && identifier.Name == name
}
