package installstorev2lab

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

const (
	storeImportPath    = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installstorev2lab"
	recordV2ImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransactionv2lab"
)

func TestStoreLabHasNoNonTestConsumer(t *testing.T) {
	root := serviceHostRoot(t)
	storeDirectory := filepath.Join(root, "internal", "installstorev2lab")
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") ||
			filepath.Clean(filepath.Dir(path)) == filepath.Clean(storeDirectory) {
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
			if sensitiveImportAlias(value, storeImportPath) {
				t.Errorf("non-test source %s imports dormant installstorev2lab", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRecordV2LabHasExactlyOneReviewedNonTestImporter(t *testing.T) {
	root := serviceHostRoot(t)
	want := filepath.Join(root, "internal", "installstorev2lab", "canonical.go")
	actual := make([]string, 0)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
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
			value, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if sensitiveImportAlias(value, recordV2ImportPath) {
				if value != recordV2ImportPath {
					t.Errorf("noncanonical ADR 0020 import %q in %s", value, path)
				} else {
					actual = append(actual, filepath.Clean(path))
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(actual) != 1 || !strings.EqualFold(actual[0], filepath.Clean(want)) {
		t.Fatalf("non-test ADR 0020 importers = %v, want [%s]", actual, want)
	}
}

func TestImportGuardRecognizesCanonicalPathsAndCaseAliases(t *testing.T) {
	for _, canonical := range []string{storeImportPath, recordV2ImportPath} {
		if !sensitiveImportAlias(canonical, canonical) ||
			!sensitiveImportAlias(strings.ToUpper(canonical), canonical) ||
			!sensitiveImportAlias(canonical+"/subpath", canonical) ||
			sensitiveImportAlias(canonical+"-other", canonical) {
			t.Fatalf("sensitive import matcher is incomplete for %q", canonical)
		}
	}
}

func sensitiveImportAlias(value, canonical string) bool {
	if strings.EqualFold(value, canonical) {
		return true
	}
	return len(value) > len(canonical) && value[len(canonical)] == '/' &&
		strings.EqualFold(value[:len(canonical)], canonical)
}

func TestStoreProductionFileSetAndHashesRemainExact(t *testing.T) {
	want := map[string]string{
		"capability.go": "54f9deeb08acbf81598fd9fbdb5278be6d28212b61c906dd8bf2f695de221f3c",
		"canonical.go":  "fee15706af9d8c36e7c279bf69349dd603c7e334fdd2839cc8d281a5e6a8085d",
		"doc.go":        "975acc63f9fcd5deb19bc5e148526c356b9c4ff15924374ab98362c0793a91ea",
		"namespace.go":  "ff19f923f25c513ffbc01d0535a6a5af1504fd22f2114ee3ef4129152bfc0f87",
		"recovery.go":   "d174a5ce20f83c4f408d220ec555c438317954e469dabbf87cdff853f5dd13fe",
		"store.go":      "7d1b3c3d5376a595862e3b76ea63a5efffc2ab9cec6dacf1bffaeb4efbaf4e2f",
		"types.go":      "f4f201e68b3b4c4311005113ee5b237a39793131e1e0d2c9ad96b007b0ca2c46",
		"validation.go": "40933ff999cfa25f11b3495b184e162219dd21b4a0fdacbdfc4b39b625ed97fa",
	}
	verifyExactProductionFileSetAndHashes(t, filepath.Join(serviceHostRoot(t), "internal", "installstorev2lab"), want, true)
}

func TestFrozenV1AndRecordV2ProductionSourcesRemainExact(t *testing.T) {
	root := serviceHostRoot(t)
	v1 := map[string]string{
		"actions.go":      "eb5d22de7b94ad56d3c1bca383af22fb90a85a66ded961d55bcb0eb518e0b7f0",
		"canonical.go":    "bda037b99d1a27db8317137a65822fb67bbecf9b5e733cb646c1e0c8a4f39ff4",
		"doc.go":          "db5ad500cbe973afc1525fb16ab8daa9fbdefcf3636504ae17127f71fc0f46da",
		"observations.go": "9b383baf3d60a443f257525f5137c802bfe0d63cbb64b3bb649394f80955bfd1",
		"paths.go":        "94fa6a1ffb76d5fbdeb43050dec4a2eae03f0b74c8acfb69b88b0ea3ed7318d7",
		"reducer.go":      "40963251b057cc05b598a9ec2ad5ac3ff62722533ae643467bf1f0fbf8051a06",
		"types.go":        "b609ed9acc63c47a74edfdb278941c9306ac793d02a1fd45ece9fcfc9b995d93",
		"validation.go":   "cd081be330a587dc6bbbbbfe3535a23cf1c1b5536d52d6a6a5737894acfef05e",
	}
	v2 := map[string]string{
		"actions.go":      "09f06dc556ccfb4b566edd541fce562f22b170c79f2795902cf99cf42a1d3025",
		"canonical.go":    "2b674d4b434e633ab8b3ee92f7ca30b20f0bd1b8cbd752e159af1224d375ebc8",
		"doc.go":          "546489ca5517d6d2cfe492ccf94066417ad6b61f9738244295ecb969342afb9a",
		"observations.go": "de9dd9398c86d6517b1f89e9380ab8968578c05255cb0da85ef646870c77063f",
		"reducer.go":      "805675a2ba34efa5b0a38b58a1084b865d6e0e33d311186887f2292eaf4112cd",
		"types.go":        "92561e01028b82f232057237f038e499f351bf99c6f080081a1b7587b2d03417",
		"validation.go":   "466a7e373bd4108605e2b1565db515f15464fe58e0cee349ffcc6dd1a1974fce",
	}
	verifyExactProductionFileSetAndHashes(t, filepath.Join(root, "internal", "installtransaction"), v1, false)
	verifyExactProductionFileSetAndHashes(t, filepath.Join(root, "internal", "installtransactionv2lab"), v2, true)
}

func TestStoreProductionImportsOnlyReviewedPureDependencies(t *testing.T) {
	allowed := map[string]struct{}{
		"bytes": {}, "crypto/sha256": {}, "encoding/json": {}, "errors": {}, "fmt": {},
		"io": {}, "regexp": {}, "sort": {}, "strconv": {}, "strings": {}, "unicode/utf8": {},
		recordV2ImportPath: {},
	}
	directory := filepath.Join(serviceHostRoot(t), "internal", "installstorev2lab")
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
			for _, forbidden := range []string{"os", "io/fs", "syscall", "unsafe", "os/exec", "net", "golang.org/x/sys"} {
				if value == forbidden || strings.HasPrefix(value, forbidden+"/") {
					t.Fatalf("%s imports platform or effect dependency %q", entry.Name(), value)
				}
			}
		}
	}
}

func TestStoreExposesOnlyExactReviewedAPI(t *testing.T) {
	directory := filepath.Join(serviceHostRoot(t), "internal", "installstorev2lab")
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
function:MarshalEntryDocument
function:MarshalHeadDocument
function:MarshalPredecessorDocument
function:MarshalV1Inventory
function:OpenExclusive
function:ParseEntryDocument
function:ParseHeadDocument
function:ParsePredecessorDocument
function:ParseV1Inventory
method:DurableIntentPermit.MarshalJSON
method:DurableIntentPermit.Validate
method:ExactBeforeToken.MarshalJSON
method:ExactBeforeToken.Validate
method:PreparedSuccessor.MarshalJSON
method:PreparedSuccessor.Validate
method:exclusiveStore.Close
method:exclusiveStore.PublishSuccessor
method:exclusiveStore.Recover
type:DecimalUint64
type:DurableIntentPermit
type:Entry
type:ExactBeforeToken
type:Head
type:Predecessor
type:PreparedSuccessor
type:SHA256
type:TerminalDisposition
type:TransactionID
type:V1InventoryEntry
value:ActiveHeadPath
value:ActiveHeadTemporaryPath
value:ErrCanonical
value:ErrCapabilityInvalid
value:ErrCapabilityNotSerializable
value:ErrInvalid
value:ErrLimit
value:ErrUnavailable
value:MaximumAggregateDocumentBytes
value:MaximumCanonicalTransactionDirectories
value:MaximumCurrentV2TransactionDirectories
value:MaximumDocumentBuffers
value:MaximumEntryDocumentBytes
value:MaximumHeadDocumentBytes
value:MaximumLegacyRecordBytes
value:MaximumLegacyTransactionDirectories
value:MaximumLiveWorkingSetBytes
value:MaximumMigrationStagingDirectories
value:MaximumNestedRecordBytes
value:MaximumPendingActionBytes
value:MaximumPredecessorDocumentBytes
value:MaximumRecoverySeconds
value:MaximumRetainedHandles
value:MaximumV1InventoryDocumentBytes
value:MaximumV2Entries
value:SchemaVersion
value:TerminalCommittedApplied
value:TerminalRolledBackApplied
value:TransactionsRootPath
value:WriterLockPath
`)
	sort.Strings(expected)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("exported API differs:\n got: %v\nwant: %v", actual, expected)
	}
}

func TestLifecycleStubContainsNoSuccessOrMintPath(t *testing.T) {
	document, err := os.ReadFile(filepath.Join(serviceHostRoot(t), "internal", "installstorev2lab", "store.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range [][]byte{
		[]byte("return nil, ErrUnavailable"),
		[]byte("return ErrUnavailable"),
		[]byte("return DurableIntentPermit{}, ErrUnavailable"),
	} {
		if !bytes.Contains(document, required) {
			t.Fatalf("store stub lacks exact fail-closed return %q", required)
		}
	}
	for _, forbidden := range [][]byte{
		[]byte("return nil, nil"),
		[]byte("return DurableIntentPermit{}, nil"),
		[]byte("&exclusiveStore{"),
		[]byte("&durableIntentPermitState{"),
	} {
		if bytes.Contains(document, forbidden) {
			t.Fatalf("store stub contains a successful or minting path %q", forbidden)
		}
	}
}

func verifyExactProductionFileSetAndHashes(t *testing.T, directory string, want map[string]string, normalize bool) {
	t.Helper()
	actual := make([]string, 0)
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == directory {
			return nil
		}
		if entry.IsDir() {
			t.Errorf("unexpected production subdirectory %s", path)
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
		t.Fatalf("production inputs in %s = %v, want %v", directory, actual, expected)
	}
	for name, expectedDigest := range want {
		document, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		if normalize {
			var ok bool
			document, ok = normalizeSource(document)
			if !ok {
				t.Fatalf("%s has noncanonical source encoding", name)
			}
		}
		digest := sha256.Sum256(document)
		if actualDigest := hex.EncodeToString(digest[:]); actualDigest != expectedDigest {
			t.Errorf("%s SHA-256 = %s, want %s", name, actualDigest, expectedDigest)
		}
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

func serviceHostRoot(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve installstorev2lab architecture source")
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
