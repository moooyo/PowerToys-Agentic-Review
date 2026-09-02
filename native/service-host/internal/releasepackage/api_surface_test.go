package releasepackage_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
)

func TestReviewedClosureEvidenceHasNoExportedMintingSurface(t *testing.T) {
	evidenceType := reflect.TypeOf(releasepackage.ReviewedClosureEvidence{})
	for index := 0; index < evidenceType.NumField(); index++ {
		if evidenceType.Field(index).IsExported() {
			t.Fatalf("ReviewedClosureEvidence field %q is exported", evidenceType.Field(index).Name)
		}
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
	production, ok := packages["releasepackage"]
	if !ok {
		t.Fatal("cannot locate releasepackage production syntax tree")
	}
	for fileName, file := range production.Files {
		if strings.HasSuffix(fileName, "_test.go") {
			continue
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || !ast.IsExported(function.Name.Name) {
				continue
			}
			if function.Name.Name == "ParseReviewedClosure" ||
				fieldListNamesType(function.Type.Results, "ReviewedClosureEvidence") {
				t.Fatalf("production API %s can mint ReviewedClosureEvidence", function.Name.Name)
			}
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
