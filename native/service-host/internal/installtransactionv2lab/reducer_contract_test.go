package installtransactionv2lab

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestReducerSurfaceIsPackagePrivateAndBound(t *testing.T) {
	assertFrozenFields(t, reflect.TypeOf(scmActionObservation{}), []frozenField{
		{"actionKind", reflect.TypeOf(ActionKind("")), ""},
		{"ordinal", reflect.TypeOf(ActionOrdinal(0)), ""},
		{"plan", reflect.TypeOf(ActionPlan("")), ""},
		{"recordSHA256", reflect.TypeOf(SHA256("")), ""},
		{"recordSequence", reflect.TypeOf(DecimalUint64("")), ""},
		{"state", reflect.TypeOf(scmObservationState(0)), ""},
		{"transactionID", reflect.TypeOf(TransactionID("")), ""},
	})
	assertFrozenFields(t, reflect.TypeOf(reduction{}), []frozenField{
		{"disposition", reflect.TypeOf(reductionDisposition(0)), ""},
		{"next", reflect.TypeOf(TransactionRecord{}), ""},
		{"retry", reflect.TypeOf((*PendingAction)(nil)).Elem(), ""},
		{"requirement", reflect.TypeOf(evidenceRequirement(0)), ""},
		{"blocked", reflect.TypeOf((*BlockedCheckpoint)(nil)), ""},
		{"failure", reflect.TypeOf(FailureCode("")), ""},
	})
	if reflect.TypeOf(nextReduction) != reflect.TypeOf(func(TransactionRecord) (reduction, error) {
		return reduction{}, nil
	}) {
		t.Fatal("nextReduction changed its pure package-private signature")
	}
	if reflect.TypeOf(reduceObservation) != reflect.TypeOf(func(TransactionRecord, actionObservation) (reduction, error) {
		return reduction{}, nil
	}) {
		t.Fatal("reduceObservation changed its pure package-private signature")
	}
	if reflect.TypeOf(classifySCMObservation) != reflect.TypeOf(func(
		TransactionRecord, PendingAction, scmActionObservation,
	) scmObservationClassification {
		return scmClassificationUnknown
	}) {
		t.Fatal("SCM classifier changed its pure package-private signature")
	}
	if reflect.TypeOf(validateSuccessorBindings) != reflect.TypeOf(func(
		TransactionRecord, TransactionRecord, CandidateRootSlot, RootIdentity,
	) error {
		return nil
	}) {
		t.Fatal("successor validation changed its package-private signature")
	}
}

func TestActionObservationUnionHasOnlyReviewedPrivateVariants(t *testing.T) {
	want := map[string]bool{
		"createCandidateObservation":   false,
		"populateCandidateObservation": false,
		"renameObservation":            false,
		"scmActionObservation":         false,
	}
	directory := filepath.Join(serviceHostRoot(t), "internal", "installtransactionv2lab")
	packages, err := parser.ParseDir(token.NewFileSet(), directory, func(info fs.FileInfo) bool {
		return filepath.Ext(info.Name()) == ".go" && !strings.HasSuffix(info.Name(), "_test.go")
	}, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	production := packages["installtransactionv2lab"]
	if production == nil {
		t.Fatal("lab syntax tree is absent")
	}
	for _, file := range production.Files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv == nil || function.Name.Name != "isActionObservation" {
				continue
			}
			receiver := apiReceiverName(function.Recv.List[0].Type)
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
