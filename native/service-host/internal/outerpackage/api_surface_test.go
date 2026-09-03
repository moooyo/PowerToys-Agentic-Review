package outerpackage_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
)

func TestProductionAPISurfaceRemainsDataOnly(t *testing.T) {
	expectedBuildIndex := reflect.TypeOf(func(releasepackage.FinalizedRelease, outerpackage.BuildOptions) ([]byte, error) {
		return nil, nil
	})
	expectedBuildBearerTokenIndex := reflect.TypeOf(func(
		releasepackage.FinalizedRelease,
		outerpackage.BearerTokenBuildOptions,
	) ([]byte, error) {
		return nil, nil
	})
	expectedValidate := reflect.TypeOf(func([]byte, releasepackage.FinalizedRelease) error { return nil })
	expectedVerify := reflect.TypeOf(func([]byte, []byte, []byte) error { return nil })
	if reflect.TypeOf(outerpackage.BuildIndex) != expectedBuildIndex ||
		reflect.TypeOf(outerpackage.BuildBearerTokenIndex) != expectedBuildBearerTokenIndex ||
		reflect.TypeOf(outerpackage.ValidateAgainstRelease) != expectedValidate ||
		reflect.TypeOf(outerpackage.VerifyDetachedSignature) != expectedVerify {
		t.Fatal("outerpackage production entry point signature changed")
	}
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate API surface test source")
	}
	packages, err := parser.ParseDir(
		token.NewFileSet(),
		filepath.Dir(currentFile),
		nil,
		parser.SkipObjectResolution,
	)
	if err != nil {
		t.Fatal(err)
	}
	production, ok := packages["outerpackage"]
	if !ok {
		t.Fatal("cannot locate outerpackage production syntax tree")
	}
	allowedFunctions := map[string]bool{
		"BuildIndex":                        false,
		"BuildBearerTokenIndex":             false,
		"MarshalIndexCanonical":             false,
		"MarshalSignatureEnvelopeCanonical": false,
		"ParseIndex":                        false,
		"ParseSignatureEnvelope":            false,
		"SigningDigest":                     false,
		"ValidateAgainstRelease":            false,
		"VerifyDetachedSignature":           false,
	}
	for fileName, file := range production.Files {
		if strings.HasSuffix(fileName, "_test.go") {
			continue
		}
		for _, declaration := range file.Decls {
			switch value := declaration.(type) {
			case *ast.FuncDecl:
				if !ast.IsExported(value.Name.Name) {
					continue
				}
				if value.Recv != nil {
					t.Fatalf("outerpackage exposes method %s", value.Name.Name)
				}
				if _, allowed := allowedFunctions[value.Name.Name]; !allowed {
					t.Fatalf("outerpackage exposes unexpected function %s", value.Name.Name)
				}
				if fieldListContainsAuthorityType(value.Type.Results) {
					t.Fatalf("outerpackage function %s returns an authority-like type", value.Name.Name)
				}
				allowedFunctions[value.Name.Name] = true
			case *ast.GenDecl:
				for _, specification := range value.Specs {
					typeSpec, ok := specification.(*ast.TypeSpec)
					if ok && ast.IsExported(typeSpec.Name.Name) &&
						strings.Contains(typeSpec.Name.Name, "Evidence") {
						t.Fatalf("outerpackage exposes authority-like type %s", typeSpec.Name.Name)
					}
				}
			}
		}
	}
	for name, seen := range allowedFunctions {
		if !seen {
			t.Fatalf("expected data-only API %s is absent", name)
		}
	}
}

func fieldListContainsAuthorityType(fields *ast.FieldList) bool {
	if fields == nil {
		return false
	}
	for _, field := range fields.List {
		found := false
		ast.Inspect(field.Type, func(node ast.Node) bool {
			identifier, ok := node.(*ast.Ident)
			if ok && strings.Contains(identifier.Name, "Evidence") {
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
