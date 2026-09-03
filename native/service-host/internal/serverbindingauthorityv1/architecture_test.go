package serverbindingauthorityv1

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

const authorityImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/serverbindingauthorityv1"

func TestDormantAuthorityHasNoNonTestConsumer(t *testing.T) {
	root := serviceHostRoot(t)
	authorityDirectory := filepath.Join(root, "internal", "serverbindingauthorityv1")
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") ||
			filepath.Clean(filepath.Dir(path)) == filepath.Clean(authorityDirectory) {
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
			if sensitiveImportAlias(value, authorityImportPath) {
				t.Errorf("non-test source %s imports dormant serverbindingauthorityv1", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestProductionFileSetAndStdlibDependenciesRemainExact(t *testing.T) {
	directory := filepath.Join(serviceHostRoot(t), "internal", "serverbindingauthorityv1")
	wantFiles := map[string]string{
		"canonical.go": "33f08884aa843588fdcb7bc57f6cf159ebd6d012c3f8c329b94cadc94a0130c6",
		"doc.go":       "17d3f5c0fea79635d1bbb5b1f2b3670fbf72959518b46c2b46c97c1dac84512d",
		"evidence.go":  "258c067c82790f93718acf655051a455bf093ee8a80d7c2cbf3f4a7d08f65c46",
		"signature.go": "0d35fc2d7bcdb7fcaab85143d165c78c4e4a27d01bfd5b60f9f11b79f8431a07",
		"types.go":     "2c144729cc671c2c67b80fd83467578fdaddfaebb89b29486bd5c1c1690f3182",
		"verifier.go":  "891dfb9c15c71bf827be5ff1576fe5c4fac787d1aa3e4e593bca8dbde4ccd245",
	}
	allowedImports := map[string]struct{}{
		"bytes": {}, "context": {}, "crypto/ecdsa": {}, "crypto/elliptic": {}, "crypto/rand": {},
		"crypto/sha256": {}, "crypto/subtle": {}, "crypto/x509": {}, "encoding/base64": {},
		"encoding/hex": {}, "encoding/json": {}, "errors": {}, "fmt": {}, "io": {}, "math/big": {},
		"regexp": {}, "strings": {}, "sync/atomic": {}, "time": {}, "unicode/utf8": {},
	}
	actualFiles := make([]string, 0, len(wantFiles))
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		actualFiles = append(actualFiles, entry.Name())
		path := filepath.Join(directory, entry.Name())
		document, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		normalized := bytes.ReplaceAll(document, []byte{'\r', '\n'}, []byte{'\n'})
		if bytes.HasPrefix(normalized, []byte{0xef, 0xbb, 0xbf}) || bytes.ContainsRune(normalized, '\r') {
			t.Errorf("production source %s has noncanonical encoding", entry.Name())
		}
		digest := sha256.Sum256(normalized)
		if expectedDigest, ok := wantFiles[entry.Name()]; !ok || hex.EncodeToString(digest[:]) != expectedDigest {
			t.Errorf("production source %s SHA-256 = %s, want %s", entry.Name(), hex.EncodeToString(digest[:]), expectedDigest)
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imported := range parsed.Imports {
			value, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := allowedImports[value]; !ok {
				t.Errorf("production source %s imports non-reviewed dependency %q", entry.Name(), value)
			}
		}
	}
	sort.Strings(actualFiles)
	expectedFiles := make([]string, 0, len(wantFiles))
	for name := range wantFiles {
		expectedFiles = append(expectedFiles, name)
	}
	sort.Strings(expectedFiles)
	if strings.Join(actualFiles, "\n") != strings.Join(expectedFiles, "\n") {
		t.Fatalf("production file set = %v, want %v", actualFiles, expectedFiles)
	}
}

func TestProductionExportedAPIRemainsExact(t *testing.T) {
	directory := filepath.Join(serviceHostRoot(t), "internal", "serverbindingauthorityv1")
	actual := make([]string, 0)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(
			token.NewFileSet(), filepath.Join(directory, entry.Name()), nil, parser.SkipObjectResolution,
		)
		if err != nil {
			t.Fatal(err)
		}
		collectExportedSurface(t, parsed, &actual)
	}
	sort.Strings(actual)
	expected := strings.Fields(`
function:ActiveStatusSigningDigest
function:ActiveStatusSigningPreimage
function:DeriveIssuerKeyID
function:MarshalActiveStatusCanonical
function:MarshalReceiptCanonical
function:ParseActiveStatus
function:ParseReceipt
function:ProductionVerifier
function:ReceiptSigningDigest
function:ReceiptSigningPreimage
function:ValidateIssuerSPKI
function:VerifyActiveStatusWithSPKI
function:VerifyReceiptWithSPKI
method:ActiveStatusEvidence.Close
method:ActiveStatusEvidence.Consume
method:ActiveStatusEvidence.MarshalJSON
method:ActiveStatusEvidence.Validate
method:ChallengeState.Close
method:ChallengeState.MarshalJSON
method:ChallengeState.NonceBase64URL
method:Verifier.NewChallenge
method:Verifier.Validate
method:Verifier.VerifyActiveStatus
method:Verifier.VerifyReceipt
type:ActiveStatusEvidence
type:ActiveStatusExpectation
type:ChallengeState
type:ServerBindingActiveStatusStatementV1
type:ServerBindingActiveStatusV1
type:ServerBindingReceiptStatementV1
type:ServerBindingReceiptV1
type:Verifier
value:ActiveStatusProfileID
value:ActiveStatusStatementType
value:BindingRevision
value:EnrollmentGeneration
value:ErrCanceled
value:ErrCanonical
value:ErrChallengeConsumed
value:ErrEvidenceConsumed
value:ErrExpired
value:ErrInvalid
value:ErrInvalidChallenge
value:ErrInvalidEvidence
value:ErrInvalidVerifier
value:ErrNotSerializable
value:ErrSignature
value:ErrUnavailable
value:Issuer
value:MaximumActiveStatusLifetime
value:MaximumClockSkew
value:MaximumDocumentBytes
value:ReceiptProfileID
value:ReceiptStatementType
value:SchemaVersion
value:SignatureAlgorithm
`)
	sort.Strings(expected)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("exported API differs:\n got: %v\nwant: %v", actual, expected)
	}
}

func TestProductionContainsNoPrivateKeySignerOrEmbeddedTrustKey(t *testing.T) {
	directory := filepath.Join(serviceHostRoot(t), "internal", "serverbindingauthorityv1")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		document, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(document)
		for _, forbidden := range []string{
			"ecdsa.PrivateKey", "ecdsa.Sign(", "ecdsa.SignASN1(", "crypto.Signer",
			"BEGIN PRIVATE KEY", "BEGIN EC PRIVATE KEY", "//go:build", "// +build",
		} {
			if strings.Contains(text, forbidden) {
				t.Errorf("production source %s contains forbidden signing/trust surface %q", entry.Name(), forbidden)
			}
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, document, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			value, err := strconv.Unquote(literal.Value)
			if err == nil && len(value) >= 110 && strings.HasPrefix(value, "MFkw") {
				t.Errorf("production source %s embeds a probable P-256 trust key", entry.Name())
			}
			return true
		})
	}
}

func TestOpaqueMintingSurfaceRemainsClosed(t *testing.T) {
	directory := filepath.Join(serviceHostRoot(t), "internal", "serverbindingauthorityv1")
	allowedResultMinters := map[string]string{
		"Verifier":             "ProductionVerifier",
		"ChallengeState":       "NewChallenge",
		"ActiveStatusEvidence": "VerifyActiveStatus",
	}
	stateLiteralCount := map[string]int{
		"verifierState":             0,
		"challengeState":            0,
		"activeStatusEvidenceState": 0,
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, declaration := range parsed.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok {
				continue
			}
			for resultType, allowedName := range allowedResultMinters {
				if fieldListNamesType(function.Type.Results, resultType) && function.Name.Name != allowedName {
					t.Errorf("production function %s can return %s", function.Name.Name, resultType)
				}
			}
			ast.Inspect(function.Body, func(node ast.Node) bool {
				literal, ok := node.(*ast.CompositeLit)
				if !ok {
					return true
				}
				identifier, ok := literal.Type.(*ast.Ident)
				if !ok {
					return true
				}
				if _, tracked := stateLiteralCount[identifier.Name]; !tracked {
					return true
				}
				stateLiteralCount[identifier.Name]++
				allowedFunction := map[string]string{
					"challengeState":            "NewChallenge",
					"activeStatusEvidenceState": "VerifyActiveStatus",
				}[identifier.Name]
				if allowedFunction == "" || function.Name.Name != allowedFunction {
					t.Errorf("%s constructs %s in unreviewed function %s", entry.Name(), identifier.Name, function.Name.Name)
				}
				return true
			})
		}
	}
	if stateLiteralCount["verifierState"] != 0 || stateLiteralCount["challengeState"] != 1 ||
		stateLiteralCount["activeStatusEvidenceState"] != 1 {
		t.Fatalf("opaque state literal counts = %v", stateLiteralCount)
	}
}

func sensitiveImportAlias(value, canonical string) bool {
	return strings.EqualFold(value, canonical) ||
		(len(value) > len(canonical) && value[len(canonical)] == '/' &&
			strings.EqualFold(value[:len(canonical)], canonical))
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
			*result = append(*result, "method:"+receiverName(t, value.Recv)+"."+value.Name.Name)
		}
	}
}

func receiverName(t *testing.T, fields *ast.FieldList) string {
	t.Helper()
	if fields == nil || len(fields.List) != 1 {
		t.Fatal("exported method has an invalid receiver list")
	}
	expression := fields.List[0].Type
	if pointer, ok := expression.(*ast.StarExpr); ok {
		expression = pointer.X
	}
	identifier, ok := expression.(*ast.Ident)
	if !ok {
		t.Fatal("exported method has an unsupported receiver")
	}
	return identifier.Name
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

func serviceHostRoot(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve serverbindingauthorityv1 source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
}
