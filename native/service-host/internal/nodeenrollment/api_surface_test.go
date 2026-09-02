package nodeenrollment_test

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

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/nodeenrollment"
)

const nodeEnrollmentImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/nodeenrollment"

func TestRecordEvidenceSurfaceHasOnlyTheFutureFixedPathReader(t *testing.T) {
	evidenceType := reflect.TypeOf(nodeenrollment.RecordEvidence{})
	if evidenceType.NumField() != 1 || evidenceType.Field(0).IsExported() {
		t.Fatal("RecordEvidence does not have one private state field")
	}
	for _, methodType := range []reflect.Type{evidenceType, reflect.PointerTo(evidenceType)} {
		methods := map[string]bool{"MarshalJSON": false, "Validate": false}
		for index := 0; index < methodType.NumMethod(); index++ {
			name := methodType.Method(index).Name
			if _, allowed := methods[name]; !allowed {
				t.Fatalf("%s exposes unexpected method %s", methodType, name)
			}
			methods[name] = true
		}
		for name, present := range methods {
			if !present {
				t.Fatalf("%s method %s is absent", methodType, name)
			}
		}
	}
	expectedRead := reflect.TypeOf(func() (nodeenrollment.RecordEvidence, error) {
		return nodeenrollment.RecordEvidence{}, nil
	})
	if reflect.TypeOf(nodeenrollment.Read) != expectedRead {
		t.Fatal("Read accepts caller authority or changed its result contract")
	}
}

func TestProductionPackageIsPureAndHasNoEvidenceConsumer(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate nodeenrollment package")
	}
	packageDirectory := filepath.Dir(currentFile)
	serviceHostRoot := filepath.Clean(filepath.Join(packageDirectory, "..", ".."))
	allowedImports := map[string]struct{}{
		"bytes": {}, "crypto/ecdsa": {}, "crypto/elliptic": {}, "crypto/sha256": {},
		"crypto/x509": {}, "encoding/base64": {}, "encoding/hex": {}, "encoding/json": {},
		"errors": {}, "fmt": {}, "io": {}, "strings": {}, "unicode/utf8": {},
	}
	forbiddenIdentifiers := map[string]struct{}{
		"Claim": {}, "CreateService": {}, "StartService": {}, "OpenSCManager": {},
		"NCryptCreatePersistedKey": {}, "NCryptFinalizeKey": {},
	}
	allowedExportedFunctions := map[string]struct{}{
		"MarshalCanonical": {}, "Parse": {}, "Read": {},
	}
	allowedExportedTypes := map[string]struct{}{
		"LocalAuthorityCNGRecord": {}, "MTLSClientCredentialRecord": {}, "Record": {},
		"RecordEvidence": {}, "TargetArchitecture": {},
	}
	allowedExportedValues := map[string]struct{}{
		"ArchitectureAMD64": {}, "ArchitectureARM64": {}, "CommittedState": {},
		"ControlDataRoot": {}, "ControlServiceName": {}, "ControlServiceSID": {},
		"ControlWrapperLogRoot": {}, "EnrollmentGeneration": {}, "ErrCanonical": {},
		"ErrEvidenceNotSerializable": {}, "ErrInvalid": {}, "ErrInvalidEvidence": {},
		"ErrUnavailable": {}, "ErrUnsupported": {}, "ExecutorDataRoot": {},
		"ExecutorServiceName": {}, "ExecutorServiceSID": {}, "ExecutorWrapperLogRoot": {},
		"InstallationRoot": {}, "InstallerRoot": {}, "MaximumPublicKeySPKIBytes": {},
		"MaximumRecordBytes": {}, "PackageMetadataParent": {}, "PhysicalRootProfileID": {},
		"ProfileID": {}, "RecordPath": {}, "SchemaVersion": {}, "ServerBindingReceiptPath": {},
		"ServiceIdentityProfileID": {}, "StagingParent": {}, "TrustedConfigurationRoot": {},
	}
	allowedExportedMethods := map[string]struct{}{
		"Record.Validate": {}, "RecordEvidence.MarshalJSON": {}, "RecordEvidence.Validate": {},
	}
	sensitiveNames := map[string]struct{}{
		"Read": {}, "RecordEvidence": {}, "readRecordEvidenceState": {},
		"recordEvidenceState": {}, "readerIssuerSeal": {}, "recordSourceProof": {},
		"serverBindingProof": {},
	}
	sensitiveFiles := make(map[string]map[string]struct{}, len(sensitiveNames))
	evidenceMinters := 0
	populatedEvidenceLiterals := 0
	err := filepath.WalkDir(packageDirectory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		base := filepath.Base(path)
		parents := astParentMap(parsed)
		for _, imported := range parsed.Imports {
			value, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if _, allowed := allowedImports[value]; !allowed {
				t.Errorf("production nodeenrollment imports non-contract package %s", value)
			}
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			if literal, ok := node.(*ast.CompositeLit); ok &&
				fieldListNodeNamesType(literal.Type, "RecordEvidence") && len(literal.Elts) != 0 {
				populatedEvidenceLiterals++
				if base != "reader.go" || enclosingFunction(node, parents) != "Read" {
					t.Errorf("production source populates RecordEvidence outside reader.go: %s", path)
				}
			}
			if literal, ok := node.(*ast.CompositeLit); ok {
				for _, proofType := range []string{
					"recordEvidenceState", "readerIssuerSeal", "recordSourceProof", "serverBindingProof",
				} {
					if fieldListNodeNamesType(literal.Type, proofType) &&
						(base != "reader_windows.go" || enclosingFunction(node, parents) != "readRecordEvidenceState") {
						t.Errorf("production source creates %s outside the fixed Windows reader", proofType)
					}
				}
			}
			if specification, ok := node.(*ast.TypeSpec); ok && specification.Name.Name != "RecordEvidence" &&
				fieldListNodeNamesType(specification.Type, "RecordEvidence") {
				t.Errorf("production source aliases RecordEvidence as %s", specification.Name.Name)
			}
			identifier, ok := node.(*ast.Ident)
			if ok {
				if _, sensitive := sensitiveNames[identifier.Name]; sensitive {
					files := sensitiveFiles[identifier.Name]
					if files == nil {
						files = make(map[string]struct{})
						sensitiveFiles[identifier.Name] = files
					}
					files[base] = struct{}{}
					if !sensitiveReferenceAllowed(base, identifier.Name, enclosingFunction(identifier, parents)) {
						t.Errorf("%s references %s outside its fixed boundary", path, identifier.Name)
					}
				}
				if _, forbidden := forbiddenIdentifiers[identifier.Name]; forbidden {
					t.Errorf("production nodeenrollment references forbidden operation %s", identifier.Name)
				}
			}
			return true
		})
		for _, declaration := range parsed.Decls {
			switch typed := declaration.(type) {
			case *ast.GenDecl:
				for _, specification := range typed.Specs {
					switch value := specification.(type) {
					case *ast.TypeSpec:
						if ast.IsExported(value.Name.Name) {
							if _, allowed := allowedExportedTypes[value.Name.Name]; !allowed {
								t.Errorf("production package exports unexpected type %s", value.Name.Name)
							}
						}
					case *ast.ValueSpec:
						for _, name := range value.Names {
							if ast.IsExported(name.Name) {
								if _, allowed := allowedExportedValues[name.Name]; !allowed {
									t.Errorf("production package exports unexpected value %s", name.Name)
								}
							}
						}
						if typed.Tok == token.VAR && fieldListNodeContainsAny(value, sensitiveNames) {
							t.Errorf("production variable declaration captures enrollment evidence in %s", path)
						}
					}
				}
			case *ast.FuncDecl:
				if ast.IsExported(typed.Name.Name) {
					if typed.Recv == nil {
						if _, allowed := allowedExportedFunctions[typed.Name.Name]; !allowed {
							t.Errorf("production package exports unexpected function %s", typed.Name.Name)
						}
					} else {
						method := receiverTypeName(typed.Recv) + "." + typed.Name.Name
						if _, allowed := allowedExportedMethods[method]; !allowed {
							t.Errorf("production package exports unexpected method %s", method)
						}
					}
				}
			}
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || !fieldListNamesType(function.Type.Results, "RecordEvidence") {
				continue
			}
			evidenceMinters++
			if function.Recv != nil || function.Name.Name != "Read" {
				t.Errorf("production function %s can mint RecordEvidence", function.Name.Name)
			}
			if base != "reader.go" {
				t.Errorf("RecordEvidence Read is declared in %s", base)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if evidenceMinters != 1 || populatedEvidenceLiterals != 1 {
		t.Fatalf(
			"RecordEvidence minters=%d populated literals=%d, want the sole fixed-path Read and one commit",
			evidenceMinters,
			populatedEvidenceLiterals,
		)
	}
	assertSensitiveFiles(t, sensitiveFiles, map[string][]string{
		"Read":                    {"reader.go"},
		"RecordEvidence":          {"reader.go", "types.go"},
		"readRecordEvidenceState": {"reader.go", "reader_other.go", "reader_windows.go"},
		"recordEvidenceState":     {"reader_other.go", "reader_windows.go", "types.go"},
		"readerIssuerSeal":        {"types.go"},
		"recordSourceProof":       {"types.go"},
		"serverBindingProof":      {"types.go"},
	})

	consumers := 0
	err = filepath.WalkDir(serviceHostRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") ||
			filepath.Clean(filepath.Dir(path)) == filepath.Clean(packageDirectory) {
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
			if value == nodeEnrollmentImportPath {
				consumers++
				t.Errorf("production source consumes unavailable enrollment evidence: %s", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if consumers != 0 {
		t.Fatalf("nodeenrollment production consumers=%d, want 0", consumers)
	}
}

func fieldListNodeNamesType(node ast.Node, target string) bool {
	found := false
	ast.Inspect(node, func(candidate ast.Node) bool {
		identifier, ok := candidate.(*ast.Ident)
		if ok && identifier.Name == target {
			found = true
			return false
		}
		return !found
	})
	return found
}

func fieldListNodeContainsAny(node ast.Node, targets map[string]struct{}) bool {
	found := false
	ast.Inspect(node, func(candidate ast.Node) bool {
		identifier, ok := candidate.(*ast.Ident)
		if ok {
			if _, exists := targets[identifier.Name]; exists {
				found = true
				return false
			}
		}
		return !found
	})
	return found
}

func sensitiveReferenceAllowed(fileName string, name string, function string) bool {
	switch name {
	case "Read":
		return fileName == "reader.go" && function == "Read"
	case "RecordEvidence":
		return fileName == "types.go" || fileName == "reader.go" && function == "Read"
	case "readRecordEvidenceState":
		return fileName == "reader.go" && function == "Read" ||
			(fileName == "reader_other.go" || fileName == "reader_windows.go") &&
				function == "readRecordEvidenceState"
	case "recordEvidenceState":
		return fileName == "types.go" ||
			(fileName == "reader_other.go" || fileName == "reader_windows.go") &&
				function == "readRecordEvidenceState"
	case "readerIssuerSeal", "recordSourceProof", "serverBindingProof":
		return fileName == "types.go"
	default:
		return false
	}
}

func enclosingFunction(node ast.Node, parents map[ast.Node]ast.Node) string {
	for current := node; current != nil; current = parents[current] {
		if function, ok := current.(*ast.FuncDecl); ok {
			return function.Name.Name
		}
	}
	return ""
}

func receiverTypeName(receivers *ast.FieldList) string {
	if receivers == nil || len(receivers.List) != 1 {
		return ""
	}
	typeNode := receivers.List[0].Type
	if pointer, ok := typeNode.(*ast.StarExpr); ok {
		typeNode = pointer.X
	}
	identifier, _ := typeNode.(*ast.Ident)
	if identifier == nil {
		return ""
	}
	return identifier.Name
}

func astParentMap(root ast.Node) map[ast.Node]ast.Node {
	parents := make(map[ast.Node]ast.Node)
	var stack []ast.Node
	ast.Inspect(root, func(node ast.Node) bool {
		if node == nil {
			stack = stack[:len(stack)-1]
			return false
		}
		if len(stack) != 0 {
			parents[node] = stack[len(stack)-1]
		}
		stack = append(stack, node)
		return true
	})
	return parents
}

func assertSensitiveFiles(t *testing.T, actual map[string]map[string]struct{}, expected map[string][]string) {
	t.Helper()
	for name, expectedFiles := range expected {
		files := actual[name]
		if len(files) != len(expectedFiles) {
			t.Fatalf("%s reference files=%v, want %v", name, files, expectedFiles)
		}
		for _, expectedFile := range expectedFiles {
			if _, present := files[expectedFile]; !present {
				t.Fatalf("%s is not referenced from expected file %s", name, expectedFile)
			}
		}
	}
	if len(actual) != len(expected) {
		t.Fatalf("sensitive reference names=%d, want %d", len(actual), len(expected))
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
