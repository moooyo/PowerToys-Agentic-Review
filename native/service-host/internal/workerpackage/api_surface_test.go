package workerpackage_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExportedSurfaceDoesNotExposeLegacyEvidencePlanLeaseOrReceiptTerms(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate current file")
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

	production, ok := packages["workerpackage"]
	if !ok {
		t.Fatal("cannot locate workerpackage package")
	}

	bannedTerms := []string{"Evidence", "Plan", "Lease", "Receipt"}
	for fileName, file := range production.Files {
		if strings.HasSuffix(fileName, "_test.go") {
			continue
		}
		for _, declaration := range file.Decls {
			switch typed := declaration.(type) {
			case *ast.GenDecl:
				for _, spec := range typed.Specs {
					typeSpec, ok := spec.(*ast.TypeSpec)
					if !ok || !ast.IsExported(typeSpec.Name.Name) {
						continue
					}
					assertNoBannedTerm(t, typeSpec.Name.Name, bannedTerms)
				}
			case *ast.FuncDecl:
				if ast.IsExported(typed.Name.Name) {
					assertNoBannedTerm(t, typed.Name.Name, bannedTerms)
				}
			}
		}
	}
}

func assertNoBannedTerm(t *testing.T, value string, bannedTerms []string) {
	t.Helper()
	for _, banned := range bannedTerms {
		if strings.Contains(value, banned) {
			t.Fatalf("exported symbol %q contains banned term %q", value, banned)
		}
	}
}
