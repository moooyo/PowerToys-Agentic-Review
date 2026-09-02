package stagedpackage_test

import (
	"context"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/stagedpackage"
)

func TestProductionSurfaceHasOnePathOnlyMinterAndOpaqueEvidence(t *testing.T) {
	expectedVerify := reflect.TypeOf(func(context.Context, string) (stagedpackage.StagedPackageEvidence, error) {
		return stagedpackage.StagedPackageEvidence{}, nil
	})
	if reflect.TypeOf(stagedpackage.Verify) != expectedVerify {
		t.Fatal("Verify accepts inventory, trust, verifier, or policy input")
	}
	evidenceType := reflect.TypeOf(stagedpackage.StagedPackageEvidence{})
	for index := 0; index < evidenceType.NumField(); index++ {
		if evidenceType.Field(index).IsExported() {
			t.Fatalf("StagedPackageEvidence field %s is exported", evidenceType.Field(index).Name)
		}
	}
	allowedMethods := map[string]bool{
		"Close":                 false,
		"ControlConfiguration":  false,
		"ExecutorConfiguration": false,
		"Files":                 false,
		"Index":                 false,
		"MarshalJSON":           false,
		"Roots":                 false,
		"SignerKeyID":           false,
		"Validate":              false,
	}
	for index := 0; index < evidenceType.NumMethod(); index++ {
		name := evidenceType.Method(index).Name
		if _, allowed := allowedMethods[name]; !allowed {
			t.Fatalf("StagedPackageEvidence exposes unexpected method %s", name)
		}
		allowedMethods[name] = true
	}
	for name, seen := range allowedMethods {
		if !seen {
			t.Fatalf("StagedPackageEvidence method %s is absent", name)
		}
	}
	if _, err := json.Marshal(stagedpackage.StagedPackageEvidence{}); !errors.Is(err, stagedpackage.ErrSerialization) {
		t.Fatalf("JSON serialization returned %v, want ErrSerialization", err)
	}
	zero := stagedpackage.StagedPackageEvidence{}
	if !errors.Is(zero.Validate(), stagedpackage.ErrInvalidEvidence) ||
		!errors.Is(zero.Close(), stagedpackage.ErrInvalidEvidence) ||
		zero.SignerKeyID() != "" || zero.Index().SchemaVersion != 0 || zero.Roots() != nil || zero.Files() != nil {
		t.Fatal("zero StagedPackageEvidence exposed data or behaved as valid evidence")
	}
}

func TestStagedPackageHasNoProductionConsumer(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate stagedpackage source")
	}
	packageDirectory := filepath.Clean(filepath.Dir(currentFile))
	serviceHostRoot := filepath.Clean(filepath.Join(packageDirectory, "..", ".."))
	const stagedImport = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/stagedpackage"
	err := filepath.WalkDir(serviceHostRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") ||
			filepath.Clean(filepath.Dir(path)) == packageDirectory {
			return nil
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imported := range parsed.Imports {
			value, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if value == stagedImport {
				t.Fatalf("production source %s consumes observation-only staged evidence", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestOnlyVerifyCanMintStagedEvidence(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate stagedpackage source")
	}
	packages, err := parser.ParseDir(
		token.NewFileSet(), filepath.Dir(currentFile), nil, parser.SkipObjectResolution,
	)
	if err != nil {
		t.Fatal(err)
	}
	production := packages["stagedpackage"]
	if production == nil {
		t.Fatal("stagedpackage production syntax tree is absent")
	}
	minters := 0
	exportedFunctions := 0
	for fileName, file := range production.Files {
		if strings.HasSuffix(fileName, "_test.go") {
			continue
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv != nil || !ast.IsExported(function.Name.Name) {
				continue
			}
			exportedFunctions++
			if function.Name.Name != "Verify" {
				t.Fatalf("stagedpackage exposes unexpected production function %s", function.Name.Name)
			}
			if resultNamesType(function.Type.Results, "StagedPackageEvidence") {
				minters++
			}
		}
	}
	// Verify has one mutually exclusive platform implementation in every build.
	if exportedFunctions != 2 || minters != 2 {
		t.Fatalf("syntax-tree Verify declarations=%d minters=%d, want 2 platform variants", exportedFunctions, minters)
	}
}

func resultNamesType(fields *ast.FieldList, name string) bool {
	if fields == nil {
		return false
	}
	found := false
	ast.Inspect(fields, func(node ast.Node) bool {
		identifier, ok := node.(*ast.Ident)
		if ok && identifier.Name == name {
			found = true
			return false
		}
		return !found
	})
	return found
}
