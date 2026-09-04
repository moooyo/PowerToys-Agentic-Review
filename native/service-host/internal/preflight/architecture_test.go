package preflight

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	pathpkg "path"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

const peerverifyImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"

const localRPCImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"

const launchguardImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/launchguard"

const preflightImportPath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"

const cryptoRandImportPath = "crypto/rand"

const expectedRuntimeBootstrapAuthorityCapture = `func captureAuthorityOnce(
	evidence preflight.Evidence,
	plan preflight.RuntimePlan,
) (authoritySnapshot, error) {
	if err := evidence.Validate(); err != nil {
		return authoritySnapshot{}, authorityError("preflight evidence is invalid", err)
	}
	digest, err := evidence.Digest()
	if err != nil || digest == ([sha256.Size]byte{}) {
		return authoritySnapshot{}, authorityError("preflight evidence digest is unavailable", err)
	}
	if err := plan.Validate(); err != nil {
		return authoritySnapshot{}, authorityError("runtime plan is invalid", err)
	}
	if plan.PreflightDigest() != digest || plan.Role() != evidence.Role() {
		return authoritySnapshot{}, authorityError("runtime plan does not derive from the supplied preflight evidence", nil)
	}
	configuration := evidence.Configuration()
	if !reflect.DeepEqual(configuration, plan.Configuration()) || configuration.Role != evidence.Role() {
		return authoritySnapshot{}, authorityError("runtime plan configuration differs from preflight evidence", nil)
	}
	evidenceBootstrapAuthority, err := evidence.RuntimeBootstrapAuthority()
	if err != nil {
		return authoritySnapshot{}, authorityError("derive preflight bootstrap authority", err)
	}
	planBootstrapAuthority := plan.RuntimeBootstrapAuthority()
	if !evidenceBootstrapAuthority.Matches(planBootstrapAuthority) {
		return authoritySnapshot{}, authorityError("runtime plan bootstrap authority differs from preflight evidence", nil)
	}
	bootstrapOptions, err := planBootstrapAuthority.FoundationOptionsForLaunch()
	if err != nil {
		return authoritySnapshot{}, authorityError("copy runtime bootstrap launch facts", err)
	}

	root, err := selectInstallationRoot(evidence.Roots())
	if err != nil {
		return authoritySnapshot{}, err
	}
	targets, err := selectLaunchTargets(configuration.Role, plan, evidence.Files())
	if err != nil {
		return authoritySnapshot{}, err
	}
	signerPin := evidence.ApprovedSignerCertificateDERSHA256()
	if !validSHA256(signerPin) {
		return authoritySnapshot{}, authorityError("compiled Authenticode signer pin is invalid", nil)
	}
	return authoritySnapshot{
		role: configuration.Role, configuration: cloneConfig(configuration),
		preflightDigest: digest, releaseDigest: plan.ReleaseTemplateDigest(),
		bootstrapOptions: bootstrapOptions,
		root:             cloneRoot(root), targets: targets, signerPin: signerPin,
	}, nil
}`

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
	authorityAccessorDeclarations := 0
	planBootstrapFactoryDeclarations := 0
	authorityCaptureDeclarations := 0
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
		for _, declaration := range parsed.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok {
				continue
			}
			switch function.Name.Name {
			case "FoundationOptionsForLaunch":
				authorityAccessorDeclarations++
				if relative != allowedFile || !isExactFoundationOptionsAccessor(function) {
					t.Errorf("%s:%d defines an invalid foundation options accessor", relative, fileSet.Position(function.Pos()).Line)
				}
			case "NewRuntimeBootstrapV1":
				planBootstrapFactoryDeclarations++
				if relative != allowedFile || !isExactPlanBootstrapFactory(function) {
					t.Errorf("%s:%d defines an invalid plan-bound bootstrap factory", relative, fileSet.Position(function.Pos()).Line)
				}
			case "captureAuthorityOnce":
				authorityCaptureDeclarations++
				if relative != "internal/launchguard/authority.go" ||
					!isExactRuntimeBootstrapAuthorityCapture(function) {
					t.Errorf("%s:%d defines an invalid runtime bootstrap authority capture", relative, fileSet.Position(function.Pos()).Line)
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
					enclosingRuntimeBootstrapFunction(selector, parents) != "NewRuntimeBootstrapV1" ||
					!isExactPlanBootstrapFactoryCall(call, parents) {
					t.Errorf("%s:%d calls or aliases the foundation bootstrap factory outside the plan-bound builder", relative, fileSet.Position(selector.Pos()).Line)
				}
			case "FoundationRuntimeBootstrapOptions":
				literal, direct := parents[selector].(*ast.CompositeLit)
				enclosing := enclosingRuntimeBootstrapFunction(selector, parents)
				switch {
				case relative == allowedFile && direct && literal.Type == selector &&
					enclosing == "newRuntimeBootstrapAuthority" &&
					isExactFoundationOptionsLiteral(literal, parents):
					optionLiterals++
				case !direct && foundationOptionsTypeReferenceAllowed(relative, selector, parents):
				default:
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
	if factoryCalls != 1 || optionLiterals != 1 || authorityAccessorDeclarations != 1 ||
		planBootstrapFactoryDeclarations != 1 || authorityCaptureDeclarations != 1 {
		t.Fatalf(
			"production foundation bootstrap references = factory:%d options:%d accessors:%d plan-factories:%d captures:%d, want all 1",
			factoryCalls,
			optionLiterals,
			authorityAccessorDeclarations,
			planBootstrapFactoryDeclarations,
			authorityCaptureDeclarations,
		)
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

func isExactPlanBootstrapFactoryCall(call *ast.CallExpr, parents map[ast.Node]ast.Node) bool {
	result, ok := parents[call].(*ast.ReturnStmt)
	return ok && len(result.Results) == 1 && result.Results[0] == call && len(call.Args) == 1 &&
		runtimeBootstrapNodeMatches(
			call.Args[0],
			"cloneRuntimeBootstrapAuthority(plan.bootstrapAuthority).options",
		)
}

func isExactPlanBootstrapFactory(function *ast.FuncDecl) bool {
	return runtimeBootstrapFunctionMatches(function, `func (plan RuntimePlan) NewRuntimeBootstrapV1() (localrpc.RuntimeBootstrapV1, error) {
		if err := plan.Validate(); err != nil {
			return localrpc.RuntimeBootstrapV1{}, fmt.Errorf("build RuntimeBootstrapV1 from finalized plan: %w", err)
		}
		return localrpc.NewFoundationRuntimeBootstrap(
			cloneRuntimeBootstrapAuthority(plan.bootstrapAuthority).options,
		)
	}`)
}

func isExactFoundationOptionsLiteral(literal *ast.CompositeLit, parents map[ast.Node]ast.Node) bool {
	assignment, ok := parents[literal].(*ast.AssignStmt)
	if !ok || assignment.Tok != token.DEFINE || len(assignment.Lhs) != 1 ||
		len(assignment.Rhs) != 1 || assignment.Rhs[0] != literal ||
		!runtimeBootstrapNodeMatches(assignment.Lhs[0], "options") {
		return false
	}
	return runtimeBootstrapNodeMatches(literal, `localrpc.FoundationRuntimeBootstrapOptions{
		Role: role,
		WorkerNodeID: configuration.WorkerNodeID,
		MaximumQueuedBytesPerDirection: int(configuration.Limits.MaximumQueuedBytesPerDirection),
		TotalShutdownTimeoutMS: int(configuration.Limits.ShutdownTimeoutMilliseconds),
		ForceTerminationReserveMS: int(configuration.Limits.ForceTerminationReserveMilliseconds),
	}`)
}

func isExactFoundationOptionsAccessor(function *ast.FuncDecl) bool {
	if function.Recv == nil || len(function.Recv.List) != 1 || len(function.Recv.List[0].Names) != 1 ||
		function.Recv.List[0].Names[0].Name != "authority" ||
		!runtimeBootstrapNodeMatches(function.Recv.List[0].Type, "RuntimeBootstrapAuthority") {
		return false
	}
	return runtimeBootstrapNodeMatches(function.Body, `{
		if err := authority.Validate(); err != nil {
			var empty localrpc.FoundationRuntimeBootstrapOptions
			return empty, err
		}
		return cloneRuntimeBootstrapAuthority(authority).options, nil
	}`)
}

func foundationOptionsTypeReferenceAllowed(
	relative string,
	selector *ast.SelectorExpr,
	parents map[ast.Node]ast.Node,
) bool {
	owner := enclosingRuntimeBootstrapFunction(selector, parents)
	switch relative {
	case "internal/preflight/types.go":
		field, ok := parents[selector].(*ast.Field)
		return ok && field.Type == selector && runtimeBootstrapFieldName(field) == "options" &&
			runtimeBootstrapEnclosingTypeName(field, parents) == "RuntimeBootstrapAuthority"
	case "internal/preflight/runtime_bootstrap.go":
		if field, ok := parents[selector].(*ast.Field); ok && field.Type == selector {
			return owner == "FoundationOptionsForLaunch" ||
				owner == "reflectRuntimeBootstrapOptionsEqual" &&
					(runtimeBootstrapFieldName(field) == "left" || runtimeBootstrapFieldName(field) == "right")
		}
		value, ok := parents[selector].(*ast.ValueSpec)
		return ok && value.Type == selector && owner == "FoundationOptionsForLaunch" &&
			len(value.Names) == 1 && value.Names[0].Name == "empty"
	case "internal/launchguard/types.go":
		field, ok := parents[selector].(*ast.Field)
		return ok && field.Type == selector && runtimeBootstrapFieldName(field) == "bootstrapOptions" &&
			runtimeBootstrapEnclosingTypeName(field, parents) == "authoritySnapshot"
	default:
		return false
	}
}

func runtimeBootstrapFieldName(field *ast.Field) string {
	if field == nil || len(field.Names) != 1 {
		return ""
	}
	return field.Names[0].Name
}

func runtimeBootstrapEnclosingTypeName(node ast.Node, parents map[ast.Node]ast.Node) string {
	for current := parents[node]; current != nil; current = parents[current] {
		if specification, ok := current.(*ast.TypeSpec); ok {
			return specification.Name.Name
		}
	}
	return ""
}

func runtimeBootstrapNodeMatches(node ast.Node, expected string) bool {
	expectedExpression, err := parser.ParseExpr(expected)
	if err != nil {
		parsed, parseErr := parser.ParseFile(
			token.NewFileSet(),
			"expected.go",
			"package expected\nfunc expected() "+expected,
			0,
		)
		if parseErr != nil || len(parsed.Decls) != 1 {
			panic("invalid expected runtime-bootstrap node")
		}
		function := parsed.Decls[0].(*ast.FuncDecl)
		return runtimeBootstrapRenderedNode(node) == runtimeBootstrapRenderedNode(function.Body)
	}
	return runtimeBootstrapRenderedNode(node) == runtimeBootstrapRenderedNode(expectedExpression)
}

func runtimeBootstrapFunctionMatches(function *ast.FuncDecl, expected string) bool {
	expectedFunction := parseExpectedRuntimeBootstrapFunction(expected)
	return runtimeBootstrapRenderedNode(function) == runtimeBootstrapRenderedNode(expectedFunction)
}

func parseExpectedRuntimeBootstrapFunction(expected string) *ast.FuncDecl {
	parsed, err := parser.ParseFile(
		token.NewFileSet(),
		"expected.go",
		"package expected\n"+expected,
		0,
	)
	if err != nil || len(parsed.Decls) != 1 {
		panic("invalid expected runtime-bootstrap function")
	}
	function, ok := parsed.Decls[0].(*ast.FuncDecl)
	if !ok {
		panic("invalid expected runtime-bootstrap declaration")
	}
	return function
}

func runtimeBootstrapRenderedNode(node ast.Node) string {
	var output bytes.Buffer
	if node == nil || printer.Fprint(&output, token.NewFileSet(), node) != nil {
		return ""
	}
	return output.String()
}

func TestRuntimeBootstrapLaunchBindingHasOneProductionChain(t *testing.T) {
	type expectedCall struct {
		importPath      string
		definingPackage string
		file            string
		function        string
	}
	expected := map[string]expectedCall{
		"BindRuntimeBootstrapToLaunch": {
			importPath: localRPCImportPath, definingPackage: "localrpc",
			file: "internal/launchguard/lifecycle.go", function: "*Guard.LaunchNode",
		},
		"ClaimHostControlLaunch": {
			importPath: launchguardImportPath, definingPackage: "launchguard",
			file: "internal/hostcontrol/endpoint_windows.go", function: "*Listener.Accept",
		},
		"BeginRuntimeBootstrapExchange": {
			importPath: localRPCImportPath, definingPackage: "localrpc",
			file: "internal/hostcontrol/contract.go", function: "completeRuntimeBootstrap",
		},
	}
	counts := make(map[string]int, len(expected))
	combinedCommitCalls := 0
	rawActivationCalls := 0
	foundationOptionsCalls := 0
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test source path")
	}
	serviceHostRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
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
		parsed, err := parser.ParseFile(fileSet, path, contents, parser.ParseComments)
		if err != nil {
			return err
		}
		aliases := make(map[string]string)
		for _, imported := range parsed.Imports {
			importPath, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if importPath != localRPCImportPath && importPath != launchguardImportPath &&
				importPath != preflightImportPath {
				continue
			}
			alias := pathpkg.Base(importPath)
			if imported.Name != nil {
				alias = imported.Name.Name
			}
			if alias == "." {
				t.Errorf("%s uses a forbidden authority dot import", relative)
				continue
			}
			if alias != "_" {
				aliases[alias] = importPath
			}
		}
		parents := astParentMap(parsed)
		ast.Inspect(parsed, func(node ast.Node) bool {
			identifier, isIdentifier := node.(*ast.Ident)
			if isIdentifier {
				if importPath, imported := aliases[identifier.Name]; imported && identifier.Obj != nil {
					t.Errorf("%s:%d shadows authority import %s", relative, fileSet.Position(identifier.Pos()).Line, importPath)
				}
				callSpec, tracked := expected[identifier.Name]
				if tracked && parsed.Name.Name == callSpec.definingPackage {
					if declaration, ok := parents[identifier].(*ast.FuncDecl); ok && declaration.Name == identifier {
						return true
					}
					if selector, ok := parents[identifier].(*ast.SelectorExpr); !ok || selector.Sel != identifier {
						t.Errorf("%s:%d references private-package authority %s outside its declaration", relative, fileSet.Position(identifier.Pos()).Line, identifier.Name)
					}
				}
			}
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch selector.Sel.Name {
			case "FoundationOptionsForLaunch":
				if !isReviewedRuntimeBootstrapBindingCall(
					selector,
					parents,
					relative,
					"internal/launchguard/authority.go",
					"captureAuthorityOnce",
				) || !isExactFoundationOptionsCall(selector, parents) {
					t.Errorf("%s:%d consumes foundation options outside launchguard capture", relative, fileSet.Position(selector.Pos()).Line)
				}
				foundationOptionsCalls++
			case "ActivateAndCommitRuntimeBootstrap":
				if !isReviewedRuntimeBootstrapBindingCall(
					selector,
					parents,
					relative,
					"internal/hostcontrol/contract.go",
					"completeRuntimeBootstrap",
				) {
					t.Errorf("%s:%d calls combined bootstrap activation outside HostControl", relative, fileSet.Position(selector.Pos()).Line)
				}
				combinedCommitCalls++
			case "ActivateAfterHostControl":
				if !isReviewedPermittedRawActivation(selector, parents, relative) {
					t.Errorf("%s:%d calls raw Node activation outside the claimed combined commit", relative, fileSet.Position(selector.Pos()).Line)
				}
				rawActivationCalls++
			}
			callSpec, tracked := expected[selector.Sel.Name]
			if !tracked {
				return true
			}
			alias, ok := selector.X.(*ast.Ident)
			if !ok || alias.Obj != nil || aliases[alias.Name] != callSpec.importPath {
				return true
			}
			if !isReviewedRuntimeBootstrapBindingCall(
				selector,
				parents,
				relative,
				callSpec.file,
				callSpec.function,
			) {
				t.Errorf("%s:%d references %s outside its reviewed production caller", relative, fileSet.Position(selector.Pos()).Line, selector.Sel.Name)
			}
			if selector.Sel.Name == "BindRuntimeBootstrapToLaunch" &&
				!isExactLaunchBootstrapBindCall(selector, parents) {
				t.Errorf("%s:%d binds a runtime bootstrap with unreviewed dataflow", relative, fileSet.Position(selector.Pos()).Line)
			}
			counts[selector.Sel.Name]++
			return true
		})
		for _, group := range parsed.Comments {
			for _, comment := range group.List {
				if strings.Contains(comment.Text, "go:linkname") {
					t.Errorf("%s uses forbidden go:linkname", relative)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for name := range expected {
		if counts[name] != 1 {
			t.Errorf("production %s call count = %d, want 1", name, counts[name])
		}
	}
	if combinedCommitCalls != 1 || rawActivationCalls != 1 || foundationOptionsCalls != 1 {
		t.Errorf(
			"production authority calls = combined:%d raw:%d foundation-options:%d, want 1, 1, and 1",
			combinedCommitCalls,
			rawActivationCalls,
			foundationOptionsCalls,
		)
	}
}

func isExactFoundationOptionsCall(
	selector *ast.SelectorExpr,
	parents map[ast.Node]ast.Node,
) bool {
	call, ok := parents[selector].(*ast.CallExpr)
	if !ok || call.Fun != selector || len(call.Args) != 0 ||
		!runtimeBootstrapNodeMatches(selector.X, "planBootstrapAuthority") {
		return false
	}
	assignment, ok := parents[call].(*ast.AssignStmt)
	return ok && assignment.Tok == token.DEFINE && len(assignment.Lhs) == 2 &&
		len(assignment.Rhs) == 1 && assignment.Rhs[0] == call &&
		runtimeBootstrapNodeMatches(assignment.Lhs[0], "bootstrapOptions") &&
		runtimeBootstrapNodeMatches(assignment.Lhs[1], "err")
}

func isExactRuntimeBootstrapAuthorityCapture(function *ast.FuncDecl) bool {
	return runtimeBootstrapFunctionMatches(function, expectedRuntimeBootstrapAuthorityCapture)
}

func isExactLaunchBootstrapBindCall(
	selector *ast.SelectorExpr,
	parents map[ast.Node]ast.Node,
) bool {
	call, ok := parents[selector].(*ast.CallExpr)
	if !ok || call.Fun != selector || len(call.Args) != 2 ||
		!runtimeBootstrapNodeMatches(call.Args[0], "bootstrap") ||
		!runtimeBootstrapNodeMatches(call.Args[1], "cloneAuthority(state.authority).bootstrapOptions") {
		return false
	}
	assignment, ok := parents[call].(*ast.AssignStmt)
	return ok && assignment.Tok == token.DEFINE && len(assignment.Lhs) == 2 &&
		len(assignment.Rhs) == 1 && assignment.Rhs[0] == call &&
		runtimeBootstrapNodeMatches(assignment.Lhs[0], "boundBootstrap") &&
		runtimeBootstrapNodeMatches(assignment.Lhs[1], "err")
}

func isReviewedPermittedRawActivation(
	selector *ast.SelectorExpr,
	parents map[ast.Node]ast.Node,
	actualFile string,
) bool {
	call, direct := parents[selector].(*ast.CallExpr)
	owner, insideFunctionLiteral := runtimeBootstrapBindingOwner(selector, parents)
	if actualFile != "internal/launchguard/lifecycle.go" || !direct || call.Fun != selector ||
		owner != "*claimedGuardedNodeProcess.ActivateAndCommitRuntimeBootstrap" || !insideFunctionLiteral {
		return false
	}
	var callback *ast.FuncLit
	for current := parents[selector]; current != nil; current = parents[current] {
		if function, ok := current.(*ast.FuncLit); ok {
			callback = function
			break
		}
	}
	if callback == nil {
		return false
	}
	permitCall, ok := parents[callback].(*ast.CallExpr)
	if !ok || len(permitCall.Args) != 1 || permitCall.Args[0] != callback {
		return false
	}
	permitSelector, ok := permitCall.Fun.(*ast.SelectorExpr)
	if !ok || permitSelector.Sel.Name != "commit" {
		return false
	}
	permitOwner, ok := permitSelector.X.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	state, stateOK := permitOwner.X.(*ast.Ident)
	return stateOK && state.Name == "state" && permitOwner.Sel.Name == "permit"
}

func isReviewedRuntimeBootstrapBindingCall(
	selector *ast.SelectorExpr,
	parents map[ast.Node]ast.Node,
	actualFile string,
	expectedFile string,
	expectedOwner string,
) bool {
	call, direct := parents[selector].(*ast.CallExpr)
	owner, insideFunctionLiteral := runtimeBootstrapBindingOwner(selector, parents)
	return actualFile == expectedFile && direct && call.Fun == selector &&
		owner == expectedOwner && !insideFunctionLiteral
}

func runtimeBootstrapBindingOwner(
	node ast.Node,
	parents map[ast.Node]ast.Node,
) (string, bool) {
	insideFunctionLiteral := false
	for current := parents[node]; current != nil; current = parents[current] {
		switch typed := current.(type) {
		case *ast.FuncLit:
			insideFunctionLiteral = true
		case *ast.FuncDecl:
			if typed.Recv == nil || len(typed.Recv.List) != 1 {
				return typed.Name.Name, insideFunctionLiteral
			}
			return runtimeBootstrapReceiverName(typed.Recv.List[0].Type) + "." + typed.Name.Name,
				insideFunctionLiteral
		}
	}
	return "", insideFunctionLiteral
}

func runtimeBootstrapReceiverName(expression ast.Expr) string {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.StarExpr:
		return "*" + runtimeBootstrapReceiverName(typed.X)
	case *ast.IndexExpr:
		return runtimeBootstrapReceiverName(typed.X)
	case *ast.IndexListExpr:
		return runtimeBootstrapReceiverName(typed.X)
	default:
		return ""
	}
}

func TestRuntimeBootstrapBindingCallGateRejectsEscapedClosuresAndWrongReceivers(t *testing.T) {
	tests := []struct {
		name        string
		source      string
		expected    bool
		expectedOwn string
	}{
		{
			name:        "exact",
			source:      `package sample; func (guard *Guard) LaunchNode() { localrpc.BindRuntimeBootstrapToLaunch() }`,
			expected:    true,
			expectedOwn: "*Guard.LaunchNode",
		},
		{
			name:        "closure",
			source:      `package sample; func (guard *Guard) LaunchNode() { f := func() { localrpc.BindRuntimeBootstrapToLaunch() }; f() }`,
			expectedOwn: "*Guard.LaunchNode",
		},
		{
			name:        "wrong receiver",
			source:      `package sample; func (other *Other) LaunchNode() { localrpc.BindRuntimeBootstrapToLaunch() }`,
			expectedOwn: "*Guard.LaunchNode",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fileSet := token.NewFileSet()
			parsed, err := parser.ParseFile(fileSet, "sample.go", test.source, 0)
			if err != nil {
				t.Fatal(err)
			}
			parents := astParentMap(parsed)
			var selector *ast.SelectorExpr
			ast.Inspect(parsed, func(node ast.Node) bool {
				candidate, ok := node.(*ast.SelectorExpr)
				if ok && candidate.Sel.Name == "BindRuntimeBootstrapToLaunch" {
					selector = candidate
				}
				return true
			})
			if selector == nil {
				t.Fatal("test source omitted binding selector")
			}
			actual := isReviewedRuntimeBootstrapBindingCall(
				selector,
				parents,
				"reviewed.go",
				"reviewed.go",
				test.expectedOwn,
			)
			if actual != test.expected {
				t.Fatalf("reviewed call = %t, want %t", actual, test.expected)
			}
		})
	}
}

func TestRuntimeBootstrapAuthorityDataflowRejectsMutations(t *testing.T) {
	t.Run("foundation options accessor", func(t *testing.T) {
		exact := parseArchitectureFixture(t, `package sample
func (authority RuntimeBootstrapAuthority) FoundationOptionsForLaunch() (localrpc.FoundationRuntimeBootstrapOptions, error) {
  if err := authority.Validate(); err != nil { var empty localrpc.FoundationRuntimeBootstrapOptions; return empty, err }
  return cloneRuntimeBootstrapAuthority(authority).options, nil
}`)
		if !isExactFoundationOptionsAccessor(findArchitectureFunction(t, exact.file, "FoundationOptionsForLaunch")) {
			t.Fatal("exact foundation options accessor was rejected")
		}
		mutated := parseArchitectureFixture(t, `package sample
func (authority RuntimeBootstrapAuthority) FoundationOptionsForLaunch() (localrpc.FoundationRuntimeBootstrapOptions, error) {
  if err := authority.Validate(); err != nil { var empty localrpc.FoundationRuntimeBootstrapOptions; return empty, err }
  return authority.options, nil
}`)
		if isExactFoundationOptionsAccessor(findArchitectureFunction(t, mutated.file, "FoundationOptionsForLaunch")) {
			t.Fatal("aliasing foundation options accessor was accepted")
		}
	})

	t.Run("plan bootstrap factory", func(t *testing.T) {
		exactSource := `package sample
func (plan RuntimePlan) NewRuntimeBootstrapV1() (localrpc.RuntimeBootstrapV1, error) {
  if err := plan.Validate(); err != nil {
    return localrpc.RuntimeBootstrapV1{}, fmt.Errorf("build RuntimeBootstrapV1 from finalized plan: %w", err)
  }
  return localrpc.NewFoundationRuntimeBootstrap(
    cloneRuntimeBootstrapAuthority(plan.bootstrapAuthority).options,
  )
}`
		exact := parseArchitectureFixture(t, exactSource)
		if !isExactPlanBootstrapFactory(findArchitectureFunction(t, exact.file, "NewRuntimeBootstrapV1")) {
			t.Fatal("exact plan bootstrap factory was rejected")
		}
		mutatedSource := strings.Replace(
			exactSource,
			"  return localrpc.NewFoundationRuntimeBootstrap(",
			"  plan.bootstrapAuthority = rewrite(plan.bootstrapAuthority)\n  return localrpc.NewFoundationRuntimeBootstrap(",
			1,
		)
		mutated := parseArchitectureFixture(t, mutatedSource)
		if isExactPlanBootstrapFactory(findArchitectureFunction(t, mutated.file, "NewRuntimeBootstrapV1")) {
			t.Fatal("plan bootstrap authority rewrite was accepted")
		}
	})

	t.Run("launch authority capture", func(t *testing.T) {
		exactSource := "package sample\n" + expectedRuntimeBootstrapAuthorityCapture
		exact := parseArchitectureFixture(t, exactSource)
		if !isExactRuntimeBootstrapAuthorityCapture(findArchitectureFunction(t, exact.file, "captureAuthorityOnce")) {
			t.Fatal("exact runtime bootstrap authority capture was rejected")
		}
		fixtures := []struct {
			name        string
			old         string
			replacement string
		}{
			{
				name:        "plan authority field rewrite",
				old:         "planBootstrapAuthority := plan.RuntimeBootstrapAuthority()",
				replacement: "plan.bootstrapAuthority = forged\n\tplanBootstrapAuthority := plan.RuntimeBootstrapAuthority()",
			},
			{
				name:        "plan authority variable rewrite",
				old:         "if !evidenceBootstrapAuthority.Matches(planBootstrapAuthority) {",
				replacement: "planBootstrapAuthority = rewrite(planBootstrapAuthority)\n\tif !evidenceBootstrapAuthority.Matches(planBootstrapAuthority) {",
			},
			{
				name:        "bootstrap options rewrite",
				old:         "root, err := selectInstallationRoot(evidence.Roots())",
				replacement: "bootstrapOptions = rewrite(bootstrapOptions)\n\troot, err := selectInstallationRoot(evidence.Roots())",
			},
			{
				name:        "bootstrap options address escape",
				old:         "root, err := selectInstallationRoot(evidence.Roots())",
				replacement: "_ = &bootstrapOptions\n\troot, err := selectInstallationRoot(evidence.Roots())",
			},
			{
				name:        "range rewrites evidence input",
				old:         "if err := evidence.Validate(); err != nil {",
				replacement: "for _, evidence = range []preflight.Evidence{replacementEvidence} {}\n\tif err := evidence.Validate(); err != nil {",
			},
			{
				name:        "semantic nil early success",
				old:         "if err := evidence.Validate(); err != nil {",
				replacement: "if useAlternate { return alternateAuthority, error(nil) }\n\tif err := evidence.Validate(); err != nil {",
			},
		}
		for _, fixture := range fixtures {
			t.Run(fixture.name, func(t *testing.T) {
				mutatedSource := strings.Replace(exactSource, fixture.old, fixture.replacement, 1)
				if mutatedSource == exactSource {
					t.Fatal("authority capture fixture did not mutate its source")
				}
				mutated := parseArchitectureFixture(t, mutatedSource)
				if isExactRuntimeBootstrapAuthorityCapture(
					findArchitectureFunction(t, mutated.file, "captureAuthorityOnce"),
				) {
					t.Fatal("mutated runtime bootstrap authority capture was accepted")
				}
			})
		}
	})

	t.Run("plan factory and launch binding arguments", func(t *testing.T) {
		exactFactory := parseArchitectureFixture(t, `package sample
func build() { return localrpc.NewFoundationRuntimeBootstrap(cloneRuntimeBootstrapAuthority(plan.bootstrapAuthority).options) }`)
		factoryCall := findArchitectureCall(t, exactFactory.file, "NewFoundationRuntimeBootstrap")
		if !isExactPlanBootstrapFactoryCall(factoryCall, exactFactory.parents) {
			t.Fatal("exact plan bootstrap factory call was rejected")
		}
		wrongFactory := parseArchitectureFixture(t, `package sample
func build() { return localrpc.NewFoundationRuntimeBootstrap(callerOptions) }`)
		if isExactPlanBootstrapFactoryCall(
			findArchitectureCall(t, wrongFactory.file, "NewFoundationRuntimeBootstrap"),
			wrongFactory.parents,
		) {
			t.Fatal("caller-supplied plan bootstrap options were accepted")
		}

		exactBind := parseArchitectureFixture(t, `package sample
func bind() { boundBootstrap, err := localrpc.BindRuntimeBootstrapToLaunch(bootstrap, cloneAuthority(state.authority).bootstrapOptions); _, _ = boundBootstrap, err }`)
		bindSelector := findArchitectureSelector(t, exactBind.file, "BindRuntimeBootstrapToLaunch")
		if !isExactLaunchBootstrapBindCall(bindSelector, exactBind.parents) {
			t.Fatal("exact launch bootstrap binding was rejected")
		}
		wrongBind := parseArchitectureFixture(t, `package sample
func bind() { result, err := localrpc.BindRuntimeBootstrapToLaunch(bootstrap, callerOptions); _, _ = result, err }`)
		if isExactLaunchBootstrapBindCall(
			findArchitectureSelector(t, wrongBind.file, "BindRuntimeBootstrapToLaunch"),
			wrongBind.parents,
		) {
			t.Fatal("caller-supplied launch bootstrap binding was accepted")
		}
	})

	t.Run("authority consumption target", func(t *testing.T) {
		exact := parseArchitectureFixture(t, `package sample
func capture() { bootstrapOptions, err := planBootstrapAuthority.FoundationOptionsForLaunch(); _, _ = bootstrapOptions, err }`)
		selector := findArchitectureSelector(t, exact.file, "FoundationOptionsForLaunch")
		if !isExactFoundationOptionsCall(selector, exact.parents) {
			t.Fatal("exact authority consumption was rejected")
		}
		wrong := parseArchitectureFixture(t, `package sample
func capture() { options, err := other.FoundationOptionsForLaunch(); _, _ = options, err }`)
		if isExactFoundationOptionsCall(
			findArchitectureSelector(t, wrong.file, "FoundationOptionsForLaunch"),
			wrong.parents,
		) {
			t.Fatal("wrong authority receiver or assignment target was accepted")
		}
	})
}

type architectureFixture struct {
	file    *ast.File
	parents map[ast.Node]ast.Node
}

func parseArchitectureFixture(t *testing.T, source string) architectureFixture {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "sample.go", source, 0)
	if err != nil {
		t.Fatal(err)
	}
	return architectureFixture{file: file, parents: astParentMap(file)}
}

func findArchitectureFunction(t *testing.T, file *ast.File, name string) *ast.FuncDecl {
	t.Helper()
	for _, declaration := range file.Decls {
		if function, ok := declaration.(*ast.FuncDecl); ok && function.Name.Name == name {
			return function
		}
	}
	t.Fatalf("fixture function %s is missing", name)
	return nil
}

func findArchitectureCall(t *testing.T, file *ast.File, name string) *ast.CallExpr {
	t.Helper()
	var result *ast.CallExpr
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if ok {
			selector, selectorOK := call.Fun.(*ast.SelectorExpr)
			if selectorOK && selector.Sel.Name == name {
				result = call
			}
		}
		return true
	})
	if result == nil {
		t.Fatalf("fixture call %s is missing", name)
	}
	return result
}

func findArchitectureSelector(t *testing.T, file *ast.File, name string) *ast.SelectorExpr {
	t.Helper()
	var result *ast.SelectorExpr
	ast.Inspect(file, func(node ast.Node) bool {
		selector, ok := node.(*ast.SelectorExpr)
		if ok && selector.Sel.Name == name {
			result = selector
		}
		return true
	})
	if result == nil {
		t.Fatalf("fixture selector %s is missing", name)
	}
	return result
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
	for _, removed := range []string{"Bootstrap", "CurrentImage"} {
		if _, exists := inputType.FieldByName(removed); exists {
			t.Fatalf("Input still exposes removed %s evidence", removed)
		}
	}
	for _, value := range []any{Evidence{}, PeerVerificationPlan{}} {
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
	"internal/peerverify/doc.go":                {},
	"internal/peerverify/platform_other.go":     {},
	"internal/peerverify/process_windows.go":    {},
	"internal/peerverify/production.go":         {},
	"internal/peerverify/production_windows.go": {},
	"internal/peerverify/token.go":              {},
	"internal/peerverify/token_windows.go":      {},
	"internal/peerverify/types.go":              {claimPreflightWindowsVerifier: 1},
	"internal/peerverify/validation.go":         {},
	"internal/peerverify/verify.go":             {},
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
