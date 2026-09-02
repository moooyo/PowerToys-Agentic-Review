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

func TestReleaseEvidenceHasOnlyVerifiedExportedMintingSurfaces(t *testing.T) {
	for _, evidenceType := range []reflect.Type{
		reflect.TypeOf(releasepackage.ReviewedClosureEvidence{}),
		reflect.TypeOf(releasepackage.ServiceHostBuildEvidence{}),
		reflect.TypeOf(releasepackage.VerifiedServiceHostEvidence{}),
	} {
		for index := 0; index < evidenceType.NumField(); index++ {
			if evidenceType.Field(index).IsExported() {
				t.Fatalf("%s field %q is exported", evidenceType.Name(), evidenceType.Field(index).Name)
			}
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
	allowed := map[string]string{
		"ReviewedClosureEvidence":     "LoadReviewedClosure",
		"ServiceHostBuildEvidence":    "LoadServiceHostBuildReceipt",
		"VerifiedServiceHostEvidence": "VerifyServiceHost",
	}
	seen := make(map[string]bool, len(allowed))
	for fileName, file := range production.Files {
		if strings.HasSuffix(fileName, "_test.go") {
			continue
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || !ast.IsExported(function.Name.Name) {
				continue
			}
			for evidence, approvedFunction := range allowed {
				if !fieldListNamesType(function.Type.Results, evidence) {
					continue
				}
				if function.Recv != nil || function.Name.Name != approvedFunction {
					t.Fatalf("production API %s can mint %s", function.Name.Name, evidence)
				}
				seen[evidence] = true
			}
			if function.Name.Name == "VerifyServiceHost" &&
				(fieldListNamesType(function.Type.Params, "UntrustedServiceHostMetadata") ||
					fieldListNamesType(function.Type.Params, "serviceHostMetadata") ||
					fieldListNamesType(function.Type.Params, "Evidence") ||
					fieldListNamesType(function.Type.Params, "Verifier")) {
				t.Fatalf("VerifyServiceHost accepts a detached metadata or verifier bypass")
			}
			switch function.Name.Name {
			case "LoadReviewedClosure", "LoadServiceHostBuildReceipt":
				if function.Recv != nil || !fieldListHasExactIdentifierTypes(
					function.Type.Params,
					[]string{"string", "string"},
				) {
					t.Fatalf("%s accepts an authority input other than two paths", function.Name.Name)
				}
			case "VerifyServiceHost":
				if function.Recv != nil || !fieldListHasExactIdentifierTypes(
					function.Type.Params,
					[]string{"PreparedRelease", "ServiceHostBuildEvidence", "string"},
				) {
					t.Fatal("VerifyServiceHost accepts a non-opaque verification input")
				}
			}
		}
	}
	for evidence := range allowed {
		if !seen[evidence] {
			t.Fatalf("verified production minter for %s is absent", evidence)
		}
	}
}

func fieldListHasExactIdentifierTypes(fields *ast.FieldList, expected []string) bool {
	if fields == nil {
		return len(expected) == 0
	}
	actual := make([]string, 0, len(expected))
	for _, field := range fields.List {
		identifier, ok := field.Type.(*ast.Ident)
		if !ok {
			return false
		}
		count := len(field.Names)
		if count == 0 {
			count = 1
		}
		for index := 0; index < count; index++ {
			actual = append(actual, identifier.Name)
		}
	}
	return reflect.DeepEqual(actual, expected)
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
