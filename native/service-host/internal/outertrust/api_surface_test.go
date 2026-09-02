package outertrust_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outertrust"
)

func TestOuterTrustEvidenceAndMintingSurfaceRemainOpaque(t *testing.T) {
	typeOfEvidence := reflect.TypeOf(outertrust.Evidence{})
	allowedMethods := map[string]bool{"SignerKeyID": false, "Validate": false, "Verify": false}
	for index := 0; index < typeOfEvidence.NumField(); index++ {
		if typeOfEvidence.Field(index).IsExported() {
			t.Fatalf("Evidence field %q is exported", typeOfEvidence.Field(index).Name)
		}
	}
	for index := 0; index < typeOfEvidence.NumMethod(); index++ {
		name := typeOfEvidence.Method(index).Name
		if _, allowed := allowedMethods[name]; !allowed {
			t.Fatalf("Evidence exposes unexpected method %s", name)
		}
		allowedMethods[name] = true
	}
	for name, seen := range allowedMethods {
		if !seen {
			t.Fatalf("expected Evidence method %s is absent", name)
		}
	}
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate outertrust source")
	}
	packages, err := parser.ParseDir(
		token.NewFileSet(), filepath.Dir(currentFile), nil, parser.SkipObjectResolution,
	)
	if err != nil {
		t.Fatal(err)
	}
	production, ok := packages["outertrust"]
	if !ok {
		t.Fatal("cannot locate outertrust production package")
	}
	productionMinters := 0
	allowedFunctions := map[string]bool{"Production": false, "ValidateSignerSPKI": false}
	for fileName, file := range production.Files {
		if strings.HasSuffix(fileName, "_test.go") {
			continue
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || !ast.IsExported(function.Name.Name) {
				continue
			}
			if function.Recv == nil {
				if _, allowed := allowedFunctions[function.Name.Name]; !allowed {
					t.Fatalf("outertrust exposes unexpected function %s", function.Name.Name)
				}
				allowedFunctions[function.Name.Name] = true
			}
			if fieldListNamesType(function.Type.Results, "Evidence") {
				if function.Recv != nil || function.Name.Name != "Production" {
					t.Fatalf("outertrust API %s can mint Evidence", function.Name.Name)
				}
				productionMinters++
			}
		}
	}
	if productionMinters != 1 {
		t.Fatalf("outertrust production minter count = %d, want 1", productionMinters)
	}
	for name, seen := range allowedFunctions {
		if !seen {
			t.Fatalf("expected outertrust function %s is absent", name)
		}
	}
}

func fieldListNamesType(fields *ast.FieldList, target string) bool {
	if fields == nil {
		return false
	}
	for _, field := range fields.List {
		found := false
		ast.Inspect(field.Type, func(node ast.Node) bool {
			identifier, ok := node.(*ast.Ident)
			if ok && identifier.Name == target {
				found = true
				return false
			}
			return !found
		})
		if found {
			return true
		}
	}
	return false
}
