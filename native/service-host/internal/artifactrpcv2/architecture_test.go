package artifactrpcv2

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestArtifactRPCV2RemainsAbsentFromProductionComposition(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test source path")
	}
	serviceHostRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
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
		allowed := strings.HasPrefix(relative, "internal/artifactrpcv2/") ||
			relative == "internal/workertransport/artifact_client_v2.go"
		parsed, err := parser.ParseFile(fileSet, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imported := range parsed.Imports {
			if strings.Contains(imported.Path.Value, "/internal/artifactrpcv2") && !allowed {
				t.Errorf("%s imports dormant artifactrpcv2", relative)
			}
		}
		if allowed {
			return nil
		}
		parsed, err = parser.ParseFile(fileSet, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			identifier, ok := node.(*ast.Ident)
			if ok && (identifier.Name == "ArtifactClientV2" || identifier.Name == "NewArtifactClientV2") {
				t.Errorf("%s references dormant artifact transport capability", relative)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestArtifactRPCV2DispatcherExposesOnlyClosedDispatch(t *testing.T) {
	typeOfDispatcher := reflect.TypeOf((*Dispatcher)(nil))
	if typeOfDispatcher.NumMethod() != 1 || typeOfDispatcher.Method(0).Name != "Dispatch" {
		t.Fatalf("Dispatcher public methods = %v, want only Dispatch", typeOfDispatcher.NumMethod())
	}
	var nilClient *fakeArtifactClient
	if _, err := newDispatcher(nilClient); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("typed nil dependency returned %v", err)
	}
}
