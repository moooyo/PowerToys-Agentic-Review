package installtransaction

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func TestReducerSurfaceIsPackagePrivateAndDataOnly(t *testing.T) {
	assertFrozenFields(t, reflect.TypeOf(createCandidateObservation{}), []frozenField{
		{"state", reflect.TypeOf(candidateCreationState(0)), ""},
		{"root", reflect.TypeOf(RootIdentity{}), ""},
	})
	assertFrozenFields(t, reflect.TypeOf(populateCandidateObservation{}), []frozenField{
		{"state", reflect.TypeOf(candidatePopulationState(0)), ""},
		{"root", reflect.TypeOf(RootIdentity{}), ""},
	})
	assertFrozenFields(t, reflect.TypeOf(rootSlotObservation{}), []frozenField{
		{"state", reflect.TypeOf(rootSlotObservationState(0)), ""},
		{"root", reflect.TypeOf(RootIdentity{}), ""},
	})
	assertFrozenFields(t, reflect.TypeOf(renameObservation{}), []frozenField{
		{"from", reflect.TypeOf(rootSlotObservation{}), ""},
		{"to", reflect.TypeOf(rootSlotObservation{}), ""},
		{"durability", reflect.TypeOf(renameDurabilityState(0)), ""},
	})
	assertFrozenFields(t, reflect.TypeOf(reduction{}), []frozenField{
		{"disposition", reflect.TypeOf(reductionDisposition(0)), ""},
		{"next", reflect.TypeOf(TransactionRecord{}), ""},
		{"retry", reflect.TypeOf((*PendingAction)(nil)).Elem(), ""},
		{"requirement", reflect.TypeOf(evidenceRequirement(0)), ""},
		{"failure", reflect.TypeOf(FailureCode("")), ""},
	})

	for _, value := range []any{
		createCandidateObservation{}, populateCandidateObservation{}, rootSlotObservation{},
		renameObservation{}, reduction{},
	} {
		typeOf := reflect.TypeOf(value)
		if ast.IsExported(typeOf.Name()) {
			t.Fatalf("reducer type %s is exported", typeOf.Name())
		}
		for index := 0; index < typeOf.NumField(); index++ {
			field := typeOf.Field(index)
			if ast.IsExported(field.Name) || field.Type == reflect.TypeOf(false) ||
				field.Type == reflect.TypeOf("") || field.Type.Kind() == reflect.Func ||
				field.Type.Kind() == reflect.Map || field.Type.Kind() == reflect.Slice {
				t.Fatalf("%s field %s exposes a forbidden authority shape %v", typeOf.Name(), field.Name, field.Type)
			}
		}
	}

	if reflect.TypeOf(nextReduction) != reflect.TypeOf(func(TransactionRecord) (reduction, error) {
		return reduction{}, nil
	}) {
		t.Fatal("nextReduction changed its package-private pure function contract")
	}
	if reflect.TypeOf(reduceObservation) != reflect.TypeOf(func(TransactionRecord, actionObservation) (reduction, error) {
		return reduction{}, nil
	}) {
		t.Fatal("reduceObservation changed its package-private pure function contract")
	}
}

func TestActionObservationUnionHasOnlyThreePackagePrivateVariants(t *testing.T) {
	typeOf := reflect.TypeOf((*actionObservation)(nil)).Elem()
	if typeOf.NumMethod() != 1 || typeOf.Method(0).Name != "isActionObservation" {
		t.Fatalf("actionObservation methods = %v, want one sealed marker", typeOf.NumMethod())
	}
	want := map[string]bool{
		"createCandidateObservation":   false,
		"populateCandidateObservation": false,
		"renameObservation":            false,
	}

	packageDirectory := reducerPackageDirectory(t)
	parsed, err := parser.ParseDir(token.NewFileSet(), packageDirectory, func(info fs.FileInfo) bool {
		return filepath.Ext(info.Name()) == ".go" && !strings.HasSuffix(info.Name(), "_test.go")
	}, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	production := parsed["installtransaction"]
	if production == nil {
		t.Fatal("installtransaction syntax tree is absent")
	}
	for _, file := range production.Files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv == nil || function.Name.Name != "isActionObservation" {
				continue
			}
			receiver := reducerReceiverName(function.Recv.List[0].Type)
			if _, exists := want[receiver]; !exists {
				t.Fatalf("unexpected actionObservation implementer %s", receiver)
			}
			want[receiver] = true
		}
	}
	missing := make([]string, 0)
	for name, found := range want {
		if !found {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) != 0 {
		t.Fatalf("missing actionObservation variants: %v", missing)
	}
}

func TestReducerFilesExportNothingAndImportNoAuthority(t *testing.T) {
	packageDirectory := reducerPackageDirectory(t)
	allowedImports := map[string]struct{}{"fmt": {}, "strconv": {}}
	for _, name := range []string{"observations.go", "reducer.go"} {
		path := filepath.Join(packageDirectory, name)
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		for _, imported := range parsed.Imports {
			value := imported.Path.Value[1 : len(imported.Path.Value)-1]
			if _, allowed := allowedImports[value]; !allowed {
				t.Fatalf("%s imports authority-bearing or unreviewed package %q", name, value)
			}
		}
		for _, declaration := range parsed.Decls {
			switch value := declaration.(type) {
			case *ast.FuncDecl:
				if ast.IsExported(value.Name.Name) {
					t.Fatalf("%s exports function %s", name, value.Name.Name)
				}
			case *ast.GenDecl:
				for _, specification := range value.Specs {
					switch typed := specification.(type) {
					case *ast.TypeSpec:
						if ast.IsExported(typed.Name.Name) {
							t.Fatalf("%s exports type %s", name, typed.Name.Name)
						}
					case *ast.ValueSpec:
						for _, identifier := range typed.Names {
							if ast.IsExported(identifier.Name) {
								t.Fatalf("%s exports value %s", name, identifier.Name)
							}
						}
					}
				}
			}
		}
	}
}

func TestReducerHasNoPackageInternalProductionConsumer(t *testing.T) {
	packageDirectory := reducerPackageDirectory(t)
	sensitive := map[string]struct{}{
		"actionObservation":            {},
		"createCandidateObservation":   {},
		"populateCandidateObservation": {},
		"renameObservation":            {},
		"reduction":                    {},
		"nextReduction":                {},
		"reduceObservation":            {},
		"publishIntent":                {},
		"completePendingAction":        {},
	}
	allowedFiles := map[string]struct{}{"observations.go": {}, "reducer.go": {}}
	packages, err := parser.ParseDir(token.NewFileSet(), packageDirectory, func(info fs.FileInfo) bool {
		return filepath.Ext(info.Name()) == ".go" && !strings.HasSuffix(info.Name(), "_test.go")
	}, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	production := packages["installtransaction"]
	if production == nil {
		t.Fatal("installtransaction syntax tree is absent")
	}
	for path, file := range production.Files {
		base := filepath.Base(path)
		if _, allowed := allowedFiles[base]; allowed {
			continue
		}
		ast.Inspect(file, func(node ast.Node) bool {
			identifier, ok := node.(*ast.Ident)
			if !ok {
				return true
			}
			if _, forbidden := sensitive[identifier.Name]; forbidden {
				t.Errorf("production source %s consumes package-private reducer symbol %s", base, identifier.Name)
			}
			return true
		})
	}
}

func reducerPackageDirectory(t *testing.T) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate reducer contract test")
	}
	return filepath.Dir(currentFile)
}

func reducerReceiverName(expression ast.Expr) string {
	switch value := expression.(type) {
	case *ast.Ident:
		return value.Name
	case *ast.StarExpr:
		return reducerReceiverName(value.X)
	default:
		return ""
	}
}
