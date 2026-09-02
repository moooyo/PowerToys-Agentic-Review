package outeradmission_test

import (
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

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outeradmission"
)

func TestAdmissionSurfaceCannotAcceptCallerTrustOrMintInstallationEvidence(t *testing.T) {
	planType := reflect.TypeOf(outeradmission.SignedPackagePlan{})
	allowedMethods := map[string]bool{
		"ControlBootstrapDocument":  false,
		"ControlConfiguration":      false,
		"ExecutorBootstrapDocument": false,
		"ExecutorConfiguration":     false,
		"Index":                     false,
		"IndexDocument":             false,
		"MarshalJSON":               false,
		"SignerKeyID":               false,
		"Validate":                  false,
	}
	for index := 0; index < planType.NumField(); index++ {
		if planType.Field(index).IsExported() {
			t.Fatalf("SignedPackagePlan field %q is exported", planType.Field(index).Name)
		}
	}
	for index := 0; index < planType.NumMethod(); index++ {
		name := planType.Method(index).Name
		if _, allowed := allowedMethods[name]; !allowed {
			t.Fatalf("SignedPackagePlan exposes unexpected method %s", name)
		}
		allowedMethods[name] = true
	}
	for name, seen := range allowedMethods {
		if !seen {
			t.Fatalf("expected SignedPackagePlan method %s is absent", name)
		}
	}
	expectedAdmit := reflect.TypeOf(func([]byte, []byte, []byte, []byte) (outeradmission.SignedPackagePlan, error) {
		return outeradmission.SignedPackagePlan{}, nil
	})
	if reflect.TypeOf(outeradmission.Admit) != expectedAdmit {
		t.Fatal("Admit accepts an authority input or changed its exact byte contract")
	}
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate outeradmission source")
	}
	packages, err := parser.ParseDir(
		token.NewFileSet(), filepath.Dir(currentFile), nil, parser.SkipObjectResolution,
	)
	if err != nil {
		t.Fatal(err)
	}
	production, ok := packages["outeradmission"]
	if !ok {
		t.Fatal("cannot locate outeradmission production package")
	}
	planMinters := 0
	productionTrustLoads := 0
	exportedFunctions := 0
	for fileName, file := range production.Files {
		if strings.HasSuffix(fileName, "_test.go") {
			continue
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok {
				continue
			}
			if ast.IsExported(function.Name.Name) && function.Recv == nil {
				exportedFunctions++
				if function.Name.Name != "Admit" {
					t.Fatalf("outeradmission exposes unexpected function %s", function.Name.Name)
				}
			}
			if ast.IsExported(function.Name.Name) && fieldListNamesType(function.Type.Results, "SignedPackagePlan") {
				if function.Recv != nil || function.Name.Name != "Admit" {
					t.Fatalf("outeradmission API %s can mint SignedPackagePlan", function.Name.Name)
				}
				planMinters++
			}
			if function.Name.Name == "Admit" {
				ast.Inspect(function.Body, func(node ast.Node) bool {
					selector, ok := node.(*ast.SelectorExpr)
					if !ok {
						return true
					}
					identifier, identifierOK := selector.X.(*ast.Ident)
					if identifierOK && identifier.Name == "outertrust" && selector.Sel.Name == "Production" {
						productionTrustLoads++
					}
					return true
				})
			}
		}
	}
	if exportedFunctions != 1 || planMinters != 1 || productionTrustLoads != 1 {
		t.Fatalf("exported functions=%d plan minters=%d trust loads=%d, want 1 each", exportedFunctions, planMinters, productionTrustLoads)
	}
}

func TestSignedPackagePlanHasOnlyHandleBoundStagedPackageConsumer(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate outeradmission source")
	}
	serviceHostRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	expectedConsumer := filepath.Clean(filepath.Join(
		serviceHostRoot,
		"internal",
		"stagedpackage",
		"platform_windows.go",
	))
	const admissionImport = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outeradmission"
	consumers := 0
	err := filepath.WalkDir(serviceHostRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") ||
			filepath.Clean(filepath.Dir(path)) == filepath.Clean(filepath.Dir(currentFile)) {
			return nil
		}
		parsed, err := parser.ParseFile(
			token.NewFileSet(), path, nil, parser.ImportsOnly,
		)
		if err != nil {
			return err
		}
		for _, imported := range parsed.Imports {
			value, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if value == admissionImport {
				if filepath.Clean(path) != expectedConsumer {
					t.Fatalf("production source %s consumes SignedPackagePlan outside stagedpackage", path)
				}
				consumers++
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if consumers != 1 {
		t.Fatalf("outeradmission production consumers = %d, want stagedpackage only", consumers)
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
