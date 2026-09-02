package installtransaction_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransaction"
)

var (
	_ installtransaction.PendingAction = installtransaction.CreateCandidateAction{}
	_ installtransaction.PendingAction = installtransaction.PopulateCandidateAction{}
	_ installtransaction.PendingAction = installtransaction.RenameAction{}
	_ installtransaction.PendingAction = installtransaction.PolicyAction{}
)

func TestPublicFunctionSurfaceIsPureAndNarrow(t *testing.T) {
	assertFunctionType(t, "MarshalActiveHead", installtransaction.MarshalActiveHead,
		func(installtransaction.ActiveHead) ([]byte, error) { return nil, nil })
	assertFunctionType(t, "ParseActiveHead", installtransaction.ParseActiveHead,
		func([]byte) (installtransaction.ActiveHead, error) { return installtransaction.ActiveHead{}, nil })
	assertFunctionType(t, "MarshalRecord", installtransaction.MarshalRecord,
		func(installtransaction.TransactionRecord) ([]byte, error) { return nil, nil })
	assertFunctionType(t, "ParseRecord", installtransaction.ParseRecord,
		func([]byte) (installtransaction.TransactionRecord, error) {
			return installtransaction.TransactionRecord{}, nil
		})
	assertFunctionType(t, "ValidateRecord", installtransaction.ValidateRecord,
		func(installtransaction.TransactionRecord) error { return nil })
	assertFunctionType(t, "ExpectedNextIntent", installtransaction.ExpectedNextIntent,
		func(installtransaction.TransactionRecord) (installtransaction.NextIntent, error) {
			return installtransaction.NextIntent{}, nil
		})
	assertFunctionType(t, "TransactionDirectoryPath", installtransaction.TransactionDirectoryPath,
		func(installtransaction.TransactionID) (string, error) { return "", nil })
	assertFunctionType(t, "TransactionRecordPath", installtransaction.TransactionRecordPath,
		func(installtransaction.TransactionID) (string, error) { return "", nil })
	assertFunctionType(t, "TransactionRecordTemporaryPath", installtransaction.TransactionRecordTemporaryPath,
		func(installtransaction.TransactionID) (string, error) { return "", nil })
	assertFunctionType(t, "CandidateRootSlotPath", installtransaction.CandidateRootSlotPath,
		func(installtransaction.CandidateRootSlot, installtransaction.TransactionID, installtransaction.PackageComponentID) (string, error) {
			return "", nil
		})
	assertFunctionType(t, "RootSlotPath", installtransaction.RootSlotPath,
		func(installtransaction.RootSlot, installtransaction.TransactionID, installtransaction.PackageComponentID) (string, error) {
			return "", nil
		})
}

func TestPendingActionVariantsHaveExactCanonicalFields(t *testing.T) {
	tests := []struct {
		value any
		want  []string
	}{
		{installtransaction.CreateCandidateAction{}, []string{"actionKind", "direction", "ordinal", "toSlot"}},
		{installtransaction.PopulateCandidateAction{}, []string{"actionKind", "direction", "expectedRoot", "ordinal", "slot"}},
		{installtransaction.RenameAction{}, []string{"actionKind", "direction", "expectedRoot", "fromSlot", "ordinal", "toSlot"}},
		{installtransaction.PolicyAction{}, []string{"actionKind", "ordinal"}},
	}
	for _, test := range tests {
		typeOf := reflect.TypeOf(test.value)
		if typeOf.NumField() != len(test.want) {
			t.Fatalf("%s fields=%d, want %d", typeOf.Name(), typeOf.NumField(), len(test.want))
		}
		for index, want := range test.want {
			field := typeOf.Field(index)
			if field.Tag.Get("json") != want {
				t.Errorf("%s field %d JSON tag=%q, want %q", typeOf.Name(), index, field.Tag.Get("json"), want)
			}
		}
	}
}

func TestPackageExportsNoTransitionOrIOEntryPoint(t *testing.T) {
	packageDirectory := currentPackageDirectory(t)
	packages, err := parser.ParseDir(token.NewFileSet(), packageDirectory, func(info fs.FileInfo) bool {
		return !strings.HasSuffix(info.Name(), "_test.go")
	}, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	production := packages["installtransaction"]
	if production == nil {
		t.Fatal("installtransaction production package is absent")
	}
	want := map[string]bool{
		"MarshalActiveHead":              false,
		"ParseActiveHead":                false,
		"MarshalRecord":                  false,
		"ParseRecord":                    false,
		"ValidateRecord":                 false,
		"ExpectedNextIntent":             false,
		"TransactionDirectoryPath":       false,
		"TransactionRecordPath":          false,
		"TransactionRecordTemporaryPath": false,
		"CandidateRootSlotPath":          false,
		"RootSlotPath":                   false,
	}
	for _, file := range production.Files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv != nil || !ast.IsExported(function.Name.Name) {
				continue
			}
			if _, allowed := want[function.Name.Name]; !allowed {
				t.Fatalf("unexpected exported function %s", function.Name.Name)
			}
			want[function.Name.Name] = true
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
		t.Fatalf("missing exported functions: %v", missing)
	}
}

func TestExportedTypesValuesAndMethodsAreClosed(t *testing.T) {
	packageDirectory := currentPackageDirectory(t)
	packages, err := parser.ParseDir(token.NewFileSet(), packageDirectory, func(info fs.FileInfo) bool {
		return !strings.HasSuffix(info.Name(), "_test.go")
	}, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	production := packages["installtransaction"]
	if production == nil {
		t.Fatal("installtransaction production package is absent")
	}
	wantTypes := stringSet(
		"TransactionID", "PackageComponentID", "EntityID", "ReleaseID", "SHA256", "FileID",
		"DecimalUint64", "ActionOrdinal", "Mode", "TargetArchitecture", "Phase",
		"ActivationPolicyState", "RollbackCheckpoint", "ActionPlan", "FailureCode", "Direction",
		"ActionKind", "CandidateRootSlot", "RootSlot", "ActiveHead", "RootIdentity",
		"CandidateRootSet", "RootSet", "CandidateGeneration", "PackageGeneration", "PendingAction",
		"CreateCandidateAction", "PopulateCandidateAction", "RenameAction", "PolicyAction",
		"TransactionRecord", "NextIntentDisposition", "NextIntent",
	)
	wantValues := stringSet(
		"SchemaVersion", "MaximumActiveHeadBytes", "MaximumTransactionRecordBytes", "InstallerRoot",
		"TransactionsRoot", "WriterLockPath", "ActiveHeadPath", "ActiveHeadTemporaryPath",
		"TransactionRecordFileName", "TransactionTemporaryName", "ErrInvalid", "ErrCanonical", "ErrLimit",
		"ModeInitial", "ModeUpgrade", "ArchitectureAMD64", "ArchitectureARM64",
		"PhaseStagingVerified", "PhaseInactivePackageVerified", "PhaseQuiesced",
		"PhaseSCMMaintenanceFenced", "PhaseServicesStopped", "PhaseRootSwapInProgress",
		"PhaseDestinationVerified", "PhaseExecutorStarted", "PhaseControlStarted",
		"PhaseAuthenticatedDisabledReady", "PhaseCommitted", "PhaseRollbackInProgress",
		"PhaseRolledBack", "PhaseFailedClosed", "ActivationNotApplicable", "ActivationPending",
		"ActivationApplied", "RollbackNotApplicable", "RollbackRootsRestored",
		"RollbackExecutorStarted", "RollbackControlStarted", "RollbackAuthenticatedDisabledReady",
		"PlanNone", "PlanMaterializeInactive", "PlanInitialForward", "PlanUpgradeForward",
		"PlanUpgradeRollback", "PlanCandidateActivationPolicy", "PlanRollbackActivationPolicy",
		"FailureJournalCorrupt", "FailureNamespaceAmbiguous", "FailureDurabilityUnproved",
		"FailureRootIdentityAmbiguous", "FailureRevalidationFailed", "FailureSCMUnproved",
		"FailureReadinessUnproved", "DirectionForward", "DirectionRollback",
		"ActionCreateCandidateRoot", "ActionPopulateCandidateRoot", "ActionRenameDirectory",
		"ActionApplyCandidateExecutorPolicy", "ActionApplyCandidateControlPolicy",
		"ActionApplyPreviousExecutorPolicy", "ActionApplyPreviousControlPolicy",
		"SlotMetadataCandidate", "SlotInstallationCandidate", "SlotTrustedConfigurationCandidate",
		"RootSlotMetadataFinal", "RootSlotMetadataCandidate", "RootSlotInstallationFinal",
		"RootSlotInstallationCandidate", "RootSlotInstallationRollback", "RootSlotInstallationInactive",
		"RootSlotTrustedConfigurationFinal", "RootSlotTrustedConfigurationCandidate",
		"RootSlotTrustedConfigurationRollback", "RootSlotTrustedConfigurationInactive",
		"NextIntentAction", "NextIntentNone", "NextIntentTerminal",
	)
	wantMethods := stringSet(
		"CreateCandidateAction.Kind", "CreateCandidateAction.ActionOrdinal",
		"PopulateCandidateAction.Kind", "PopulateCandidateAction.ActionOrdinal",
		"RenameAction.Kind", "RenameAction.ActionOrdinal",
		"PolicyAction.Kind", "PolicyAction.ActionOrdinal",
	)
	implementers := map[string]bool{
		"CreateCandidateAction": false, "PopulateCandidateAction": false,
		"RenameAction": false, "PolicyAction": false,
	}
	for _, file := range production.Files {
		for _, declaration := range file.Decls {
			switch value := declaration.(type) {
			case *ast.GenDecl:
				for _, specification := range value.Specs {
					switch spec := specification.(type) {
					case *ast.TypeSpec:
						if ast.IsExported(spec.Name.Name) {
							consumeExpectedName(t, "type", spec.Name.Name, wantTypes)
						}
					case *ast.ValueSpec:
						for _, name := range spec.Names {
							if ast.IsExported(name.Name) {
								consumeExpectedName(t, "value", name.Name, wantValues)
							}
						}
					}
				}
			case *ast.FuncDecl:
				if value.Recv == nil || len(value.Recv.List) != 1 {
					continue
				}
				receiver := receiverName(value.Recv.List[0].Type)
				if value.Name.Name == "isPendingAction" {
					if _, expected := implementers[receiver]; !expected {
						t.Fatalf("unexpected PendingAction implementer %s", receiver)
					}
					implementers[receiver] = true
				}
				if ast.IsExported(value.Name.Name) {
					consumeExpectedName(t, "method", receiver+"."+value.Name.Name, wantMethods)
				}
			}
		}
	}
	assertSetConsumed(t, "types", wantTypes)
	assertSetConsumed(t, "values", wantValues)
	assertSetConsumed(t, "methods", wantMethods)
	for name, found := range implementers {
		if !found {
			t.Errorf("PendingAction implementer %s lacks the sealed marker", name)
		}
	}
}

func TestProductionPackageImportsNoPlatformOrIOAuthority(t *testing.T) {
	packageDirectory := currentPackageDirectory(t)
	allowed := map[string]struct{}{
		"bytes": {}, "crypto/sha256": {}, "encoding/hex": {}, "encoding/json": {}, "errors": {},
		"fmt": {}, "io": {}, "regexp": {}, "strconv": {}, "strings": {}, "unicode/utf8": {},
	}
	err := filepath.WalkDir(packageDirectory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imported := range parsed.Imports {
			name, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if _, approved := allowed[name]; !approved {
				t.Fatalf("production source %s imports unreviewed dependency %s", path, name)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func stringSet(values ...string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = false
	}
	return result
}

func consumeExpectedName(t *testing.T, kind, name string, expected map[string]bool) {
	t.Helper()
	found, exists := expected[name]
	if !exists {
		t.Fatalf("unexpected exported %s %s", kind, name)
	}
	if found {
		t.Fatalf("duplicate exported %s %s", kind, name)
	}
	expected[name] = true
}

func assertSetConsumed(t *testing.T, kind string, expected map[string]bool) {
	t.Helper()
	missing := make([]string, 0)
	for name, found := range expected {
		if !found {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) != 0 {
		t.Fatalf("missing exported %s: %v", kind, missing)
	}
}

func receiverName(expression ast.Expr) string {
	switch value := expression.(type) {
	case *ast.Ident:
		return value.Name
	case *ast.StarExpr:
		return receiverName(value.X)
	default:
		return ""
	}
}

func TestInstallTransactionHasNoProductionConsumer(t *testing.T) {
	packageDirectory := currentPackageDirectory(t)
	serviceHostRoot := filepath.Clean(filepath.Join(packageDirectory, "..", ".."))
	const importPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransaction"
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
			name, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if name == importPath {
				t.Fatalf("production source %s consumes dormant transaction data", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func assertFunctionType(t *testing.T, name string, got, want any) {
	t.Helper()
	if reflect.TypeOf(got) != reflect.TypeOf(want) {
		t.Fatalf("%s type=%v, want %v", name, reflect.TypeOf(got), reflect.TypeOf(want))
	}
}

func currentPackageDirectory(t *testing.T) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate installtransaction package")
	}
	return filepath.Clean(filepath.Dir(currentFile))
}
