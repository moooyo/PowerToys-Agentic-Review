package preflight

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicebootstrap"
)

const peerverifyImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"

const localRPCImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"

const cryptoRandImportPath = "crypto/rand"

func TestProductionRuntimeBootstrapFactoryHasOnePlanBoundCaller(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test source path")
	}
	serviceHostRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	const allowedFile = "internal/preflight/runtime_bootstrap.go"
	factoryCalls := 0
	optionLiterals := 0
	privateFoundationCalls := 0
	rawConstructorCalls := 0
	rawOptionLiterals := 0
	err := filepath.WalkDir(serviceHostRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		relative, err := filepath.Rel(serviceHostRoot, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fileSet := token.NewFileSet()
		parsed, err := parser.ParseFile(fileSet, path, contents, 0)
		if err != nil {
			return err
		}
		if relative == "internal/localrpc/runtime_bootstrap.go" {
			for _, declaration := range parsed.Decls {
				switch typed := declaration.(type) {
				case *ast.FuncDecl:
					if typed.Name.Name == "NewRuntimeBootstrap" {
						t.Error("localrpc exposes the raw RuntimeBootstrapV1 constructor")
					}
				case *ast.GenDecl:
					for _, specification := range typed.Specs {
						if typeSpec, ok := specification.(*ast.TypeSpec); ok && typeSpec.Name.Name == "RuntimeBootstrapOptions" {
							t.Error("localrpc exposes raw RuntimeBootstrapV1 options")
						}
					}
				}
			}
		}
		aliases := make(map[string]struct{})
		cryptoRandAliases := make(map[string]struct{})
		for _, imported := range parsed.Imports {
			importPath, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			switch importPath {
			case localRPCImportPath:
				alias := "localrpc"
				if imported.Name != nil {
					alias = imported.Name.Name
				}
				if alias == "." {
					t.Errorf("%s uses a forbidden localrpc dot import", relative)
					continue
				}
				if alias != "_" {
					aliases[alias] = struct{}{}
				}
			case cryptoRandImportPath:
				alias := "rand"
				if imported.Name != nil {
					alias = imported.Name.Name
				}
				if alias != "." && alias != "_" {
					cryptoRandAliases[alias] = struct{}{}
				}
			}
		}
		parents := astParentMap(parsed)
		ast.Inspect(parsed, func(node ast.Node) bool {
			if identifier, ok := node.(*ast.Ident); ok &&
				(identifier.Name == "newFoundationRuntimeBootstrap" || identifier.Name == "newRuntimeBootstrap") {
				parent := parents[identifier]
				if declaration, isDeclaration := parent.(*ast.FuncDecl); isDeclaration && declaration.Name == identifier {
					return true
				}
				call, isDirectCall := parent.(*ast.CallExpr)
				if !isDirectCall || call.Fun != identifier {
					t.Errorf("%s:%d aliases private bootstrap issuer %s", relative, fileSet.Position(identifier.Pos()).Line, identifier.Name)
					return true
				}
				enclosing := enclosingRuntimeBootstrapFunction(call, parents)
				if identifier.Name == "newFoundationRuntimeBootstrap" {
					privateFoundationCalls++
					if relative != "internal/localrpc/runtime_bootstrap.go" || enclosing != "NewFoundationRuntimeBootstrap" {
						t.Errorf("%s:%d calls the entropy-injecting bootstrap issuer outside the public fixed factory", relative, fileSet.Position(identifier.Pos()).Line)
					} else if len(call.Args) != 2 || !isNamedIdentifier(call.Args[0], "options") ||
						!isCryptoRandReaderExpression(call.Args[1], cryptoRandAliases) {
						t.Errorf("%s:%d fixed bootstrap factory must pass options and crypto/rand.Reader directly", relative, fileSet.Position(identifier.Pos()).Line)
					}
				} else if relative != "internal/localrpc/runtime_bootstrap.go" || enclosing != "newFoundationRuntimeBootstrap" {
					t.Errorf("%s:%d calls the raw bootstrap issuer outside the private fixed factory", relative, fileSet.Position(identifier.Pos()).Line)
				}
			}
			switch typed := node.(type) {
			case *ast.CallExpr:
				if function, ok := typed.Fun.(*ast.Ident); ok {
					switch function.Name {
					case "newRuntimeBootstrap":
						rawConstructorCalls++
						if relative != "internal/localrpc/runtime_bootstrap.go" ||
							enclosingRuntimeBootstrapFunction(typed, parents) != "newFoundationRuntimeBootstrap" {
							t.Errorf("%s:%d calls the raw bootstrap constructor outside the fixed factory", relative, fileSet.Position(function.Pos()).Line)
						}
					case "NewFoundationRuntimeBootstrap":
						t.Errorf("%s:%d calls the foundation bootstrap factory from inside localrpc", relative, fileSet.Position(function.Pos()).Line)
					}
				}
			case *ast.CompositeLit:
				if typeName, ok := typed.Type.(*ast.Ident); ok {
					switch typeName.Name {
					case "runtimeBootstrapOptions":
						rawOptionLiterals++
						if relative != "internal/localrpc/runtime_bootstrap.go" ||
							enclosingRuntimeBootstrapFunction(typed, parents) != "newFoundationRuntimeBootstrap" {
							t.Errorf("%s:%d constructs raw bootstrap options outside the fixed factory", relative, fileSet.Position(typeName.Pos()).Line)
						}
					case "FoundationRuntimeBootstrapOptions":
						t.Errorf("%s:%d constructs foundation bootstrap options from inside localrpc", relative, fileSet.Position(typeName.Pos()).Line)
					}
				}
			}
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			identifier, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			if _, imported := aliases[identifier.Name]; !imported {
				return true
			}
			if identifier.Obj != nil {
				t.Errorf("%s:%d shadows the localrpc import", relative, fileSet.Position(identifier.Pos()).Line)
				return true
			}
			switch selector.Sel.Name {
			case "NewFoundationRuntimeBootstrap":
				factoryCalls++
				call, direct := parents[selector].(*ast.CallExpr)
				if relative != allowedFile || !direct || call.Fun != selector ||
					enclosingRuntimeBootstrapFunction(selector, parents) != "NewRuntimeBootstrapV1" {
					t.Errorf("%s:%d calls or aliases the foundation bootstrap factory outside the plan-bound builder", relative, fileSet.Position(selector.Pos()).Line)
				}
			case "FoundationRuntimeBootstrapOptions":
				optionLiterals++
				literal, direct := parents[selector].(*ast.CompositeLit)
				if relative != allowedFile || !direct || literal.Type != selector ||
					enclosingRuntimeBootstrapFunction(selector, parents) != "NewRuntimeBootstrapV1" {
					t.Errorf("%s:%d constructs or aliases foundation bootstrap options outside the plan-bound builder", relative, fileSet.Position(selector.Pos()).Line)
				}
			case "RuntimeBootstrapV1":
				if literal, direct := parents[selector].(*ast.CompositeLit); direct &&
					literal.Type == selector && len(literal.Elts) != 0 {
					t.Errorf("%s:%d constructs a populated RuntimeBootstrapV1 outside localrpc", relative, fileSet.Position(selector.Pos()).Line)
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if factoryCalls != 1 || optionLiterals != 1 {
		t.Fatalf("production foundation bootstrap references = factory:%d options:%d, want 1 and 1", factoryCalls, optionLiterals)
	}
	if privateFoundationCalls != 1 || rawConstructorCalls != 1 || rawOptionLiterals != 1 {
		t.Fatalf(
			"production private bootstrap references = foundation:%d raw:%d options:%d, want 1, 1, and 1",
			privateFoundationCalls,
			rawConstructorCalls,
			rawOptionLiterals,
		)
	}
}

func isNamedIdentifier(expression ast.Expr, name string) bool {
	identifier, ok := expression.(*ast.Ident)
	return ok && identifier.Name == name
}

func isCryptoRandReaderExpression(expression ast.Expr, aliases map[string]struct{}) bool {
	selector, ok := expression.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != "Reader" {
		return false
	}
	identifier, ok := selector.X.(*ast.Ident)
	if !ok || identifier.Obj != nil {
		return false
	}
	_, imported := aliases[identifier.Name]
	return imported
}

func enclosingRuntimeBootstrapFunction(node ast.Node, parents map[ast.Node]ast.Node) string {
	for current := parents[node]; current != nil; current = parents[current] {
		if function, ok := current.(*ast.FuncDecl); ok {
			return function.Name.Name
		}
	}
	return ""
}

type peerverifyIdentifierCounts struct {
	claimPreflightWindowsVerifier int
	legacyVerifyWindows           int
	legacyOptions                 int
}

func TestPublicPreflightInputUsesOnlyOpaqueAuthorityEvidence(t *testing.T) {
	inputType := reflect.TypeOf(Input{})
	if _, exists := inputType.FieldByName("ReleaseProfile"); exists {
		t.Fatal("Input exposes caller-constructible release authority")
	}
	currentImage, exists := inputType.FieldByName("CurrentImage")
	if !exists || currentImage.Type != reflect.TypeOf(servicebootstrap.CurrentImageEvidence{}) {
		t.Fatal("Input does not require concrete opaque CurrentImageEvidence")
	}
	for _, value := range []any{CurrentImageBinding{}, Evidence{}, PeerVerificationPlan{}} {
		typeOfValue := reflect.TypeOf(value)
		for index := 0; index < typeOfValue.NumField(); index++ {
			if typeOfValue.Field(index).IsExported() {
				t.Fatalf("%s exposes constructible authority field %s", typeOfValue.Name(), typeOfValue.Field(index).Name)
			}
		}
	}

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test source path")
	}
	typesSource, err := os.ReadFile(filepath.Join(filepath.Dir(source), "types.go"))
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parser.ParseFile(token.NewFileSet(), "types.go", typesSource, 0)
	if err != nil {
		t.Fatal(err)
	}
	ast.Inspect(parsed, func(node ast.Node) bool {
		typeSpec, ok := node.(*ast.TypeSpec)
		if ok && typeSpec.Name.Name == "ReleaseProfile" {
			t.Error("preflight still declares caller-constructible ReleaseProfile")
		}
		return true
	})
}

type peerverifyReference struct {
	symbol            string
	enclosingFunction string
	direct            bool
	line              int
}

type peerverifySourceAnalysis struct {
	references         []peerverifyReference
	shadowedAliases    []string
	dotImports         []string
	linknameDirectives []string
	identifiers        peerverifyIdentifierCounts
}

var expectedPeerverifyIdentifiers = map[string]peerverifyIdentifierCounts{
	"internal/peerverify/authenticode_other.go":   {},
	"internal/peerverify/authenticode_windows.go": {},
	"internal/peerverify/doc.go":                  {},
	"internal/peerverify/image_windows.go":        {},
	"internal/peerverify/platform_other.go":       {},
	"internal/peerverify/process_windows.go":      {},
	"internal/peerverify/production.go":           {},
	"internal/peerverify/production_windows.go":   {},
	"internal/peerverify/token.go":                {},
	"internal/peerverify/token_windows.go":        {},
	"internal/peerverify/types.go":                {claimPreflightWindowsVerifier: 1},
	"internal/peerverify/validation.go":           {},
	"internal/peerverify/verify.go":               {},
}

func TestProductionPeerVerificationHasOneAtomicBridge(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test source path")
	}
	serviceHostRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	allowedFile := "internal/preflight/peer_plan.go"
	seenPeerverifyFiles := make(map[string]struct{}, len(expectedPeerverifyIdentifiers))
	externalCounts := peerverifyIdentifierCounts{}
	internalTotals := peerverifyIdentifierCounts{}
	err := filepath.WalkDir(serviceHostRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		relative, err := filepath.Rel(serviceHostRoot, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		analysis, err := analyzePeerverifySource(relative, source)
		if err != nil {
			return err
		}
		for _, imported := range analysis.dotImports {
			t.Errorf("%s uses forbidden dot import %q", relative, imported)
		}
		for _, directive := range analysis.linknameDirectives {
			t.Errorf("%s uses forbidden go:linkname directive %q", relative, directive)
		}
		if strings.HasPrefix(relative, "internal/peerverify/") {
			expected, exists := expectedPeerverifyIdentifiers[relative]
			if !exists {
				t.Errorf("%s is a new peerverify production file without a fixed identifier baseline", relative)
			} else if analysis.identifiers != expected {
				t.Errorf("%s peerverify identifiers = %+v, want %+v", relative, analysis.identifiers, expected)
			}
			seenPeerverifyFiles[relative] = struct{}{}
			internalTotals.claimPreflightWindowsVerifier += analysis.identifiers.claimPreflightWindowsVerifier
			internalTotals.legacyVerifyWindows += analysis.identifiers.legacyVerifyWindows
			internalTotals.legacyOptions += analysis.identifiers.legacyOptions
			return nil
		}
		for _, alias := range analysis.shadowedAliases {
			t.Errorf("%s locally shadows peerverify import alias %q", relative, alias)
		}
		for _, reference := range analysis.references {
			if relative != allowedFile {
				t.Errorf("%s:%d references peerverify.%s outside the atomic bridge", relative, reference.line, reference.symbol)
				continue
			}
			if !reference.direct {
				t.Errorf("%s:%d uses peerverify.%s outside its required direct syntax", relative, reference.line, reference.symbol)
			}
			switch reference.symbol {
			case "ClaimPreflightWindowsVerifier":
				if reference.enclosingFunction != "claimProductionPeerWindowsVerifier" {
					t.Errorf(
						"%s:%d claims peer verification authority from %q, want claimProductionPeerWindowsVerifier",
						relative,
						reference.line,
						reference.enclosingFunction,
					)
				}
				externalCounts.claimPreflightWindowsVerifier++
			case "VerifyWindows":
				externalCounts.legacyVerifyWindows++
			case "Options":
				externalCounts.legacyOptions++
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for file := range expectedPeerverifyIdentifiers {
		if _, exists := seenPeerverifyFiles[file]; !exists {
			t.Errorf("peerverify production baseline file %s is missing", file)
		}
	}
	if externalCounts != (peerverifyIdentifierCounts{claimPreflightWindowsVerifier: 1}) {
		t.Errorf("external peerverify authority references = %+v, want exactly one direct claim", externalCounts)
	}
	if internalTotals != (peerverifyIdentifierCounts{claimPreflightWindowsVerifier: 1}) {
		t.Errorf("peerverify internal authority identifiers = %+v, want one claim and no legacy raw API", internalTotals)
	}
}

func TestAnalyzePeerverifySourceRejectsArchitectureEscapes(t *testing.T) {
	direct, err := analyzePeerverifySource("direct.go", []byte(`package sample
import pv "`+peerverifyImportPath+`"
func run() { _, _ = pv.ClaimPreflightWindowsVerifier() }
`))
	if err != nil || len(direct.references) != 1 ||
		direct.references[0] != (peerverifyReference{
			symbol: "ClaimPreflightWindowsVerifier", enclosingFunction: "run", direct: true, line: 3,
		}) ||
		len(direct.shadowedAliases) != 0 {
		t.Fatalf("direct explicit-alias analysis = %#v, %v", direct, err)
	}

	tests := []struct {
		name          string
		source        string
		wantSymbol    string
		wantShadow    bool
		wantDot       bool
		wantLinkname  bool
		wantReference bool
	}{
		{
			name: "function alias",
			source: `package sample
import pv "` + peerverifyImportPath + `"
var bridge = pv.ClaimPreflightWindowsVerifier
`,
			wantSymbol: "ClaimPreflightWindowsVerifier", wantReference: true,
		},
		{
			name: "type alias",
			source: `package sample
import pv "` + peerverifyImportPath + `"
type RawOptions = pv.Options
func run() { _, _ = pv.VerifyWindows(RawOptions{}) }
`,
			wantSymbol: "Options", wantReference: true,
		},
		{
			name: "local shadow fake count",
			source: `package sample
import pv "` + peerverifyImportPath + `"
func run() { pv := struct{ ClaimPreflightWindowsVerifier func() }{}; pv.ClaimPreflightWindowsVerifier() }
`,
			wantShadow: true,
		},
		{
			name: "dot import",
			source: `package sample
import . "` + peerverifyImportPath + `"
func run() { _, _ = ClaimPreflightWindowsVerifier() }
`,
			wantDot: true,
		},
		{
			name: "linkname",
			source: `package sample
//go:linkname rawClaim ` + peerverifyImportPath + `.ClaimPreflightWindowsVerifier
func rawVerify()
`,
			wantLinkname: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			analysis, err := analyzePeerverifySource(test.name+".go", []byte(test.source))
			if err != nil {
				t.Fatal(err)
			}
			if (len(analysis.shadowedAliases) != 0) != test.wantShadow ||
				(len(analysis.dotImports) != 0) != test.wantDot ||
				(len(analysis.linknameDirectives) != 0) != test.wantLinkname {
				t.Fatalf("analysis = %#v", analysis)
			}
			if test.wantReference {
				found := false
				for _, reference := range analysis.references {
					if reference.symbol == test.wantSymbol && !reference.direct {
						found = true
					}
				}
				if !found {
					t.Fatalf("analysis did not report indirect %s reference: %#v", test.wantSymbol, analysis)
				}
			}
			if test.wantShadow && len(analysis.references) != 0 {
				t.Fatalf("shadow selector supplemented raw reference counts: %#v", analysis.references)
			}
		})
	}

	internal, err := analyzePeerverifySource("wrapper.go", []byte(`package peerverify
func ClaimPreflightWindowsVerifier() {}
func bridge() { ClaimPreflightWindowsVerifier() }
`))
	if err != nil || internal.identifiers != (peerverifyIdentifierCounts{claimPreflightWindowsVerifier: 2}) {
		t.Fatalf("internal wrapper analysis = %#v, %v", internal, err)
	}
}

func analyzePeerverifySource(filename string, source []byte) (peerverifySourceAnalysis, error) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, filename, source, parser.ParseComments)
	if err != nil {
		return peerverifySourceAnalysis{}, err
	}
	parents := astParentMap(parsed)
	analysis := peerverifySourceAnalysis{}
	aliases := make(map[string]struct{})
	for _, imported := range parsed.Imports {
		importPath, err := strconv.Unquote(imported.Path.Value)
		if err != nil {
			return peerverifySourceAnalysis{}, err
		}
		if imported.Name != nil && imported.Name.Name == "." {
			analysis.dotImports = append(analysis.dotImports, importPath)
		}
		if importPath != peerverifyImportPath {
			continue
		}
		alias := "peerverify"
		if imported.Name != nil {
			alias = imported.Name.Name
		}
		if alias != "." && alias != "_" {
			aliases[alias] = struct{}{}
		}
	}
	for _, group := range parsed.Comments {
		for _, comment := range group.List {
			if strings.Contains(comment.Text, "go:linkname") {
				analysis.linknameDirectives = append(analysis.linknameDirectives, comment.Text)
			}
		}
	}
	shadowed := make(map[string]struct{})
	ast.Inspect(parsed, func(node ast.Node) bool {
		identifier, ok := node.(*ast.Ident)
		if !ok {
			return true
		}
		if identifier.Name == "ClaimPreflightWindowsVerifier" ||
			identifier.Name == "VerifyWindows" || identifier.Name == "Options" {
			if selector, ok := parents[identifier].(*ast.SelectorExpr); !ok || selector.Sel != identifier {
				switch identifier.Name {
				case "ClaimPreflightWindowsVerifier":
					analysis.identifiers.claimPreflightWindowsVerifier++
				case "VerifyWindows":
					analysis.identifiers.legacyVerifyWindows++
				case "Options":
					analysis.identifiers.legacyOptions++
				}
			}
		}
		if _, isAlias := aliases[identifier.Name]; isAlias && identifier.Obj != nil {
			shadowed[identifier.Name] = struct{}{}
		}
		return true
	})
	for alias := range shadowed {
		analysis.shadowedAliases = append(analysis.shadowedAliases, alias)
	}
	ast.Inspect(parsed, func(node ast.Node) bool {
		selector, ok := node.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "ClaimPreflightWindowsVerifier" &&
			selector.Sel.Name != "VerifyWindows" && selector.Sel.Name != "Options" {
			return true
		}
		identifier, ok := selector.X.(*ast.Ident)
		if !ok || identifier.Obj != nil {
			return true
		}
		if _, imported := aliases[identifier.Name]; !imported {
			return true
		}
		direct := false
		switch selector.Sel.Name {
		case "ClaimPreflightWindowsVerifier", "VerifyWindows":
			call, ok := parents[selector].(*ast.CallExpr)
			direct = ok && call.Fun == selector
		case "Options":
			literal, ok := parents[selector].(*ast.CompositeLit)
			direct = ok && literal.Type == selector
		}
		analysis.references = append(analysis.references, peerverifyReference{
			symbol:            selector.Sel.Name,
			enclosingFunction: enclosingFunctionName(selector, parents),
			direct:            direct,
			line:              fileSet.Position(selector.Pos()).Line,
		})
		return true
	})
	return analysis, nil
}

func enclosingFunctionName(node ast.Node, parents map[ast.Node]ast.Node) string {
	for parent := parents[node]; parent != nil; parent = parents[parent] {
		if function, ok := parent.(*ast.FuncDecl); ok {
			return function.Name.Name
		}
	}
	return ""
}

func astParentMap(root ast.Node) map[ast.Node]ast.Node {
	parents := make(map[ast.Node]ast.Node)
	stack := make([]ast.Node, 0, 16)
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
