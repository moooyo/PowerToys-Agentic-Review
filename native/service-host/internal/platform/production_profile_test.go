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

	expected := map[string]productionReference{
		"LoadWorkerAuth": {
			path: "internal/platform/production_windows.go", function: "openRoleCredentials",
		},
		"NewClient": {
			path: "internal/platform/production_windows.go", function: "buildRoleRuntime",
		},
	}
	for _, name := range []string{"LoadWorkerAuth", "NewClient"} {
		observed := references[name]
		if len(observed) != 1 || observed[0] != expected[name] {
			t.Fatalf("production %s references = %v, want exactly %v", name, observed, expected[name])
		}
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
