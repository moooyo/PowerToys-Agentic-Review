package installtransactionv2lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const labImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransactionv2lab"

func TestInstallTransactionV2LabHasNoProductionConsumer(t *testing.T) {
	root := serviceHostRoot(t)
	labDirectory := filepath.Join(root, "internal", "installtransactionv2lab")
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") ||
			filepath.Clean(filepath.Dir(path)) == labDirectory {
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
			if value == labImportPath || strings.HasPrefix(value, labImportPath+"/") {
				t.Errorf("production source %s imports dormant installtransactionv2lab", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestLabProductionFileSetAndHashesRemainExact(t *testing.T) {
	root := serviceHostRoot(t)
	want := map[string]string{
		"actions.go":      "09f06dc556ccfb4b566edd541fce562f22b170c79f2795902cf99cf42a1d3025",
		"canonical.go":    "2b674d4b434e633ab8b3ee92f7ca30b20f0bd1b8cbd752e159af1224d375ebc8",
		"doc.go":          "546489ca5517d6d2cfe492ccf94066417ad6b61f9738244295ecb969342afb9a",
		"observations.go": "de9dd9398c86d6517b1f89e9380ab8968578c05255cb0da85ef646870c77063f",
		"reducer.go":      "805675a2ba34efa5b0a38b58a1084b865d6e0e33d311186887f2292eaf4112cd",
		"types.go":        "92561e01028b82f232057237f038e499f351bf99c6f080081a1b7587b2d03417",
		"validation.go":   "466a7e373bd4108605e2b1565db515f15464fe58e0cee349ffcc6dd1a1974fce",
	}
	directory := filepath.Join(root, "internal", "installtransactionv2lab")
	actual := make([]string, 0)
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == directory {
			return nil
		}
		if entry.IsDir() {
			t.Errorf("unexpected lab subdirectory %s", path)
			return fs.SkipDir
		}
		name := entry.Name()
		if strings.HasSuffix(name, "_test.go") {
			return nil
		}
		actual = append(actual, name)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(actual)
	expected := make([]string, 0, len(want))
	for name := range want {
		expected = append(expected, name)
	}
	sort.Strings(expected)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("lab production inputs = %v, want %v", actual, expected)
	}
	for name, expectedDigest := range want {
		document, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		normalized, ok := normalizeSource(document)
		if !ok {
			t.Fatalf("%s has noncanonical source encoding", name)
		}
		digest := sha256.Sum256(normalized)
		if actualDigest := hex.EncodeToString(digest[:]); actualDigest != expectedDigest {
			t.Errorf("%s SHA-256 = %s, want %s", name, actualDigest, expectedDigest)
		}
	}
}

func TestV1ProductionSourcesRemainExact(t *testing.T) {
	root := serviceHostRoot(t)
	want := map[string]string{
		"actions.go":      "eb5d22de7b94ad56d3c1bca383af22fb90a85a66ded961d55bcb0eb518e0b7f0",
		"canonical.go":    "bda037b99d1a27db8317137a65822fb67bbecf9b5e733cb646c1e0c8a4f39ff4",
		"doc.go":          "db5ad500cbe973afc1525fb16ab8daa9fbdefcf3636504ae17127f71fc0f46da",
		"observations.go": "9b383baf3d60a443f257525f5137c802bfe0d63cbb64b3bb649394f80955bfd1",
		"paths.go":        "94fa6a1ffb76d5fbdeb43050dec4a2eae03f0b74c8acfb69b88b0ea3ed7318d7",
		"reducer.go":      "40963251b057cc05b598a9ec2ad5ac3ff62722533ae643467bf1f0fbf8051a06",
		"types.go":        "b609ed9acc63c47a74edfdb278941c9306ac793d02a1fd45ece9fcfc9b995d93",
		"validation.go":   "cd081be330a587dc6bbbbbfe3535a23cf1c1b5536d52d6a6a5737894acfef05e",
	}
	directory := filepath.Join(root, "internal", "installtransaction")
	actual := make([]string, 0)
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == directory {
			return nil
		}
		if entry.IsDir() {
			t.Errorf("unexpected v1 subdirectory %s", path)
			return fs.SkipDir
		}
		if !strings.HasSuffix(entry.Name(), "_test.go") {
			actual = append(actual, entry.Name())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(actual)
	expected := make([]string, 0, len(want))
	for name := range want {
		expected = append(expected, name)
	}
	sort.Strings(expected)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("v1 production source set = %v, want %v", actual, expected)
	}
	for name, expectedDigest := range want {
		document, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(document)
		if actualDigest := hex.EncodeToString(digest[:]); actualDigest != expectedDigest {
			t.Errorf("v1 %s raw SHA-256 = %s, want %s", name, actualDigest, expectedDigest)
		}
	}
}

func TestLabProductionImportsOnlyPureDependencies(t *testing.T) {
	allowed := map[string]struct{}{
		"bytes": {}, "crypto/sha256": {}, "encoding/hex": {}, "encoding/json": {},
		"errors": {}, "fmt": {}, "io": {}, "regexp": {}, "strconv": {},
		"strings": {}, "unicode/utf8": {},
	}
	directory := filepath.Join(serviceHostRoot(t), "internal", "installtransactionv2lab")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), filepath.Join(directory, entry.Name()), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imported := range parsed.Imports {
			value, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := allowed[value]; !ok {
				t.Fatalf("%s imports unreviewed dependency %q", entry.Name(), value)
			}
		}
	}
}

func TestLabExposesOnlyExactReviewedAPI(t *testing.T) {
	directory := filepath.Join(serviceHostRoot(t), "internal", "installtransactionv2lab")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	actual := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), filepath.Join(directory, entry.Name()), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		collectExportedSurface(t, parsed, &actual)
	}
	sort.Strings(actual)
	expected := strings.Fields(`
function:MarshalRecord
function:ParseRecord
function:ValidateRecord
method:CreateCandidateAction.ActionOrdinal
method:CreateCandidateAction.Kind
method:PopulateCandidateAction.ActionOrdinal
method:PopulateCandidateAction.Kind
method:RenameAction.ActionOrdinal
method:RenameAction.Kind
method:SCMAction.ActionOrdinal
method:SCMAction.Kind
method:SCMGenerationAction.ActionOrdinal
method:SCMGenerationAction.Kind
type:ActionKind
type:ActionOrdinal
type:ActionPlan
type:ActivationPolicyState
type:BlockedCheckpoint
type:BlockedReason
type:CandidateGeneration
type:CandidateRootSet
type:CandidateRootSlot
type:CreateCandidateAction
type:DecimalUint64
type:Direction
type:EntityID
type:FailureCode
type:FileID
type:Mode
type:PackageComponentID
type:PackageGeneration
type:PendingAction
type:Phase
type:PopulateCandidateAction
type:ReleaseID
type:RenameAction
type:RollbackCheckpoint
type:RootIdentity
type:RootSet
type:RootSlot
type:SCMAction
type:SCMGenerationAction
type:SCMPolicyContractID
type:SHA256
type:ServiceRole
type:TargetArchitecture
type:TargetGeneration
type:TransactionID
type:TransactionRecord
value:ActionCandidateFinalPolicyUnavailable
value:ActionClearControlDelayedAutoStart
value:ActionClearControlFailureActions
value:ActionClearControlFailureActionsOnNonCrash
value:ActionClearExecutorDelayedAutoStart
value:ActionClearExecutorFailureActions
value:ActionClearExecutorFailureActionsOnNonCrash
value:ActionCreateCandidateRoot
value:ActionCreateDisabledControlService
value:ActionCreateDisabledExecutorService
value:ActionPopulateCandidateRoot
value:ActionPreviousFinalPolicyUnavailable
value:ActionRenameDirectory
value:ActionSetControlDemandStart
value:ActionSetControlDescription
value:ActionSetControlPreshutdownPolicy
value:ActionSetControlRequiredPrivileges
value:ActionSetControlServiceSIDType
value:ActionSetControlServiceSecurity
value:ActionSetExecutorDemandStart
value:ActionSetExecutorDescription
value:ActionSetExecutorPreshutdownPolicy
value:ActionSetExecutorRequiredPrivileges
value:ActionSetExecutorServiceSIDType
value:ActionSetExecutorServiceSecurity
value:ActionStartControl
value:ActionStartExecutor
value:ActionStopControl
value:ActionStopExecutor
value:ActivationBlocked
value:ActivationNotApplicable
value:ArchitectureAMD64
value:ArchitectureARM64
value:BlockedCandidateFinalPolicy
value:BlockedCreateIntermediateEvidence
value:BlockedDurableStore
value:BlockedFailureActionsClearABI
value:BlockedNativeAdapter
value:BlockedPreviousFinalPolicy
value:BlockedPreferredNodeReadback
value:BlockedPreshutdownContract
value:BlockedStartReadinessEvidence
value:BlockedStopProcessTreeEvidence
value:DirectionForward
value:DirectionRollback
value:ErrCanonical
value:ErrInvalid
value:ErrLimit
value:FailureDurabilityUnproved
value:FailureJournalCorrupt
value:FailureNamespaceAmbiguous
value:FailureReadinessUnproved
value:FailureRevalidationFailed
value:FailureRootIdentityAmbiguous
value:FailureSCMUnproved
value:GenerationCandidate
value:GenerationPrevious
value:MaximumTransactionRecordBytes
value:ModeInitial
value:ModeUpgrade
value:PhaseAuthenticatedDisabledReady
value:PhaseControlStarted
value:PhaseDestinationVerified
value:PhaseExecutorStarted
value:PhaseFailedClosed
value:PhaseInactivePackageVerified
value:PhaseQuiesced
value:PhaseRollbackInProgress
value:PhaseRootSwapInProgress
value:PhaseSCMMaintenanceFenced
value:PhaseServiceConfigurationProgress
value:PhaseServicesConfigured
value:PhaseServicesStopped
value:PhaseStagingVerified
value:PlanCandidateFinalPolicyBlocked
value:PlanInitialForward
value:PlanInitialServiceCreation
value:PlanMaterializeInactive
value:PlanNone
value:PlanPreviousFinalPolicyBlocked
value:PlanSCMMaintenance
value:PlanStartCandidateServices
value:PlanStartPreviousServices
value:PlanStopServices
value:PlanUpgradeForward
value:PlanUpgradeRollback
value:RoleControl
value:RoleExecutor
value:RollbackAuthenticatedDisabledReady
value:RollbackControlStarted
value:RollbackExecutorStarted
value:RollbackNotApplicable
value:RollbackRootsRestored
value:RootSlotInstallationCandidate
value:RootSlotInstallationFinal
value:RootSlotInstallationInactive
value:RootSlotInstallationRollback
value:RootSlotMetadataCandidate
value:RootSlotMetadataFinal
value:RootSlotTrustedConfigurationCandidate
value:RootSlotTrustedConfigurationFinal
value:RootSlotTrustedConfigurationInactive
value:RootSlotTrustedConfigurationRollback
value:SCMPolicyContractIdentifier
value:SchemaVersion
value:SlotInstallationCandidate
value:SlotMetadataCandidate
value:SlotTrustedConfigurationCandidate
`)
	sort.Strings(expected)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("exported API differs:\n got: %v\nwant: %v", actual, expected)
	}
}

func collectExportedSurface(t *testing.T, file *ast.File, result *[]string) {
	t.Helper()
	for _, declaration := range file.Decls {
		switch value := declaration.(type) {
		case *ast.GenDecl:
			for _, specification := range value.Specs {
				switch item := specification.(type) {
				case *ast.ValueSpec:
					for _, name := range item.Names {
						if name.IsExported() {
							*result = append(*result, "value:"+name.Name)
						}
					}
				case *ast.TypeSpec:
					if item.Name.IsExported() {
						*result = append(*result, "type:"+item.Name.Name)
					}
				}
			}
		case *ast.FuncDecl:
			if value.Name == nil || !value.Name.IsExported() {
				continue
			}
			if value.Recv == nil {
				*result = append(*result, "function:"+value.Name.Name)
				continue
			}
			if len(value.Recv.List) != 1 {
				t.Fatalf("exported method %s has unsupported receiver list", value.Name.Name)
			}
			receiver := apiReceiverName(value.Recv.List[0].Type)
			if receiver == "" {
				t.Fatalf("exported method %s has unsupported receiver", value.Name.Name)
			}
			*result = append(*result, "method:"+receiver+"."+value.Name.Name)
		}
	}
}

func apiReceiverName(expression ast.Expr) string {
	if pointer, ok := expression.(*ast.StarExpr); ok {
		expression = pointer.X
	}
	identifier, ok := expression.(*ast.Ident)
	if !ok {
		return ""
	}
	return identifier.Name
}

func TestReducerAndObservationSurfaceRemainsPackagePrivate(t *testing.T) {
	directory := filepath.Join(serviceHostRoot(t), "internal", "installtransactionv2lab")
	for _, name := range []string{"observations.go", "reducer.go"} {
		parsed, err := parser.ParseFile(token.NewFileSet(), filepath.Join(directory, name), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, declaration := range parsed.Decls {
			switch value := declaration.(type) {
			case *ast.FuncDecl:
				if value.Name.IsExported() {
					t.Fatalf("%s exports function %s", name, value.Name.Name)
				}
			case *ast.GenDecl:
				for _, specification := range value.Specs {
					switch item := specification.(type) {
					case *ast.TypeSpec:
						if item.Name.IsExported() {
							t.Fatalf("%s exports type %s", name, item.Name.Name)
						}
					case *ast.ValueSpec:
						for _, identifier := range item.Names {
							if identifier.IsExported() {
								t.Fatalf("%s exports value %s", name, identifier.Name)
							}
						}
					}
				}
			}
		}
	}
}

func TestLabSourceContainsNoSuccessfulTerminalVocabulary(t *testing.T) {
	directory := filepath.Join(serviceHostRoot(t), "internal", "installtransactionv2lab")
	for _, name := range []string{"types.go", "actions.go", "canonical.go", "validation.go", "observations.go", "reducer.go"} {
		document, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{`"COMMITTED"`, `"ROLLED_BACK"`, `"applied"`} {
			if bytes.Contains(document, []byte(forbidden)) {
				t.Errorf("%s contains forbidden successful terminal vocabulary %s", name, forbidden)
			}
		}
	}
}

func serviceHostRoot(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve installtransactionv2lab architecture source")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
}

func normalizeSource(document []byte) ([]byte, bool) {
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) {
		return nil, false
	}
	normalized := bytes.ReplaceAll(document, []byte{'\r', '\n'}, []byte{'\n'})
	if bytes.ContainsRune(normalized, '\r') {
		return nil, false
	}
	return normalized, true
}
