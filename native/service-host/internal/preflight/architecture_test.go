package preflight

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

const peerverifyImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"

type peerverifyIdentifierCounts struct {
	verifyWindows int
	options       int
}

type peerverifyReference struct {
	symbol string
	direct bool
	line   int
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
	"internal/peerverify/platform_other.go":       {verifyWindows: 1, options: 1},
	"internal/peerverify/process_windows.go":      {},
	"internal/peerverify/production.go":           {options: 1},
	"internal/peerverify/production_windows.go":   {verifyWindows: 1, options: 1},
	"internal/peerverify/token.go":                {},
	"internal/peerverify/token_windows.go":        {},
	"internal/peerverify/types.go":                {options: 1},
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
			internalTotals.verifyWindows += analysis.identifiers.verifyWindows
			internalTotals.options += analysis.identifiers.options
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
			case "VerifyWindows":
				externalCounts.verifyWindows++
			case "Options":
				externalCounts.options++
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
	if externalCounts != (peerverifyIdentifierCounts{verifyWindows: 1, options: 1}) {
		t.Errorf("external raw peerverify references = %+v, want exactly one direct call and literal", externalCounts)
	}
	if internalTotals != (peerverifyIdentifierCounts{verifyWindows: 2, options: 4}) {
		t.Errorf("peerverify internal identifier total = %+v, want fixed baseline {2 4}", internalTotals)
	}
}

func TestAnalyzePeerverifySourceRejectsArchitectureEscapes(t *testing.T) {
	direct, err := analyzePeerverifySource("direct.go", []byte(`package sample
import pv "`+peerverifyImportPath+`"
func run() { _, _ = pv.VerifyWindows(pv.Options{}) }
`))
	if err != nil || len(direct.references) != 2 ||
		direct.references[0] != (peerverifyReference{symbol: "VerifyWindows", direct: true, line: 3}) ||
		direct.references[1] != (peerverifyReference{symbol: "Options", direct: true, line: 3}) ||
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
var bridge = pv.VerifyWindows
var _ = pv.Options{}
`,
			wantSymbol: "VerifyWindows", wantReference: true,
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
func run() { pv := struct{ VerifyWindows func(); Options int }{}; pv.VerifyWindows(); _ = pv.Options }
`,
			wantShadow: true,
		},
		{
			name: "dot import",
			source: `package sample
import . "` + peerverifyImportPath + `"
func run() { _, _ = VerifyWindows(Options{}) }
`,
			wantDot: true,
		},
		{
			name: "linkname",
			source: `package sample
//go:linkname rawVerify ` + peerverifyImportPath + `.VerifyWindows
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
func VerifyWindows(Options) {}
func bridge(value Options) { VerifyWindows(value) }
`))
	if err != nil || internal.identifiers != (peerverifyIdentifierCounts{verifyWindows: 2, options: 2}) {
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
		if identifier.Name == "VerifyWindows" || identifier.Name == "Options" {
			if selector, ok := parents[identifier].(*ast.SelectorExpr); !ok || selector.Sel != identifier {
				switch identifier.Name {
				case "VerifyWindows":
					analysis.identifiers.verifyWindows++
				case "Options":
					analysis.identifiers.options++
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
		if !ok || selector.Sel.Name != "VerifyWindows" && selector.Sel.Name != "Options" {
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
		case "VerifyWindows":
			call, ok := parents[selector].(*ast.CallExpr)
			direct = ok && call.Fun == selector
		case "Options":
			literal, ok := parents[selector].(*ast.CompositeLit)
			direct = ok && literal.Type == selector
		}
		analysis.references = append(analysis.references, peerverifyReference{
			symbol: selector.Sel.Name,
			direct: direct,
			line:   fileSet.Position(selector.Pos()).Line,
		})
		return true
	})
	return analysis, nil
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
