package localrpc

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

const (
	expectedControlFoundationRoleConfig  = `{"executionEnabled":false,"foundationVersion":1,"role":"control"}`
	expectedExecutorFoundationRoleConfig = `{"executionEnabled":false,"foundationVersion":1,"role":"executor"}`
)

type claimAuthorityScan struct {
	problems                     []string
	controlFoundationConfigs     []string
	executorFoundationConfigs    []string
	policyFields                 int
	roleExecutionFields          int
	policyInitializers           int
	derivationCalls              int
	foundationSelectors          int
	foundationSelectorCalls      int
	exactRoleConfigGuards        int
	exactRoleConfigSelections    int
	deriveConfigDeclarations     int
	exactRoleConfigDecodes       int
	orderedCommitAuthorityChains int
	claimGates                   int
	exactClaimDenialBodies       int
	orderedServeAuthorityChains  int
	dispatchDefenseGates         int
	orderedDispatchDefenses      int
	dispatcherClaimCalls         int
	dispatchSafelyCalls          int
	dispatchCalls                int
	operationPolicyBindings      int
	derivedPolicyAssignments     int
}

func TestClaimAuthorityHasNoProductionSwitch(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test source path")
	}
	serviceHostRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	combined := claimAuthorityScan{}
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
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		scan, err := analyzeClaimAuthoritySource(filepath.ToSlash(relative), contents)
		if err != nil {
			return err
		}
		combined.merge(scan)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, problem := range combined.problems {
		t.Error(problem)
	}
	if len(combined.controlFoundationConfigs) != 1 ||
		combined.controlFoundationConfigs[0] != expectedControlFoundationRoleConfig {
		t.Errorf("Control foundation roleConfig definitions = %q, want one exact zero-execution value",
			combined.controlFoundationConfigs)
	}
	if len(combined.executorFoundationConfigs) != 1 ||
		combined.executorFoundationConfigs[0] != expectedExecutorFoundationRoleConfig {
		t.Errorf("Executor foundation roleConfig definitions = %q, want one exact zero-execution value",
			combined.executorFoundationConfigs)
	}
	if combined.policyFields != 1 || combined.roleExecutionFields != 1 ||
		combined.policyInitializers != 1 || combined.derivationCalls != 1 ||
		combined.foundationSelectors != 1 || combined.foundationSelectorCalls != 3 ||
		combined.exactRoleConfigGuards != 1 ||
		combined.exactRoleConfigSelections != 1 ||
		combined.deriveConfigDeclarations != 1 || combined.exactRoleConfigDecodes != 1 ||
		combined.orderedCommitAuthorityChains != 1 ||
		combined.claimGates != 1 || combined.exactClaimDenialBodies != 1 ||
		combined.orderedServeAuthorityChains != 1 || combined.dispatchDefenseGates != 1 ||
		combined.orderedDispatchDefenses != 1 || combined.dispatcherClaimCalls != 1 ||
		combined.dispatchSafelyCalls != 1 || combined.dispatchCalls != 1 ||
		combined.operationPolicyBindings != 3 || combined.derivedPolicyAssignments != 1 {
		t.Fatalf(
			"Claim authority counts = policy-fields:%d role-fields:%d initializers:%d derivations:%d selectors:%d selector-calls:%d exact-guards:%d exact-selections:%d config-declarations:%d exact-decodes:%d commit-ordered:%d gates:%d denial-bodies:%d serve-ordered:%d defense-gates:%d defense-ordered:%d dispatcher-claim:%d dispatch-safely:%d dispatch:%d policy-bindings:%d derived-assignments:%d",
			combined.policyFields,
			combined.roleExecutionFields,
			combined.policyInitializers,
			combined.derivationCalls,
			combined.foundationSelectors,
			combined.foundationSelectorCalls,
			combined.exactRoleConfigGuards,
			combined.exactRoleConfigSelections,
			combined.deriveConfigDeclarations,
			combined.exactRoleConfigDecodes,
			combined.orderedCommitAuthorityChains,
			combined.claimGates,
			combined.exactClaimDenialBodies,
			combined.orderedServeAuthorityChains,
			combined.dispatchDefenseGates,
			combined.orderedDispatchDefenses,
			combined.dispatcherClaimCalls,
			combined.dispatchSafelyCalls,
			combined.dispatchCalls,
			combined.operationPolicyBindings,
			combined.derivedPolicyAssignments,
		)
	}
}

func TestClaimAuthorityAnalyzerRejectsBypassFixtures(t *testing.T) {
	tests := []struct {
		name        string
		filename    string
		source      string
		wantProblem string
	}{
		{
			name: "exported execution toggle",
			source: `package sample
type ServerOptions struct { ExecutionEnabled bool }
`,
			wantProblem: "bare authority field",
		},
		{
			name:     "role config enables execution",
			filename: "internal/localrpc/runtime_bootstrap.go",
			source: "package sample\nconst controlFoundationRoleConfigJSON = `" +
				`{"executionEnabled":true,"foundationVersion":1,"role":"control"}` + "`\n",
			wantProblem: "roleConfig literal enables execution",
		},
		{
			name:     "role config is mutable",
			filename: "internal/localrpc/runtime_bootstrap.go",
			source: "package sample\nvar controlFoundationRoleConfigJSON = `" +
				`{"executionEnabled":false,"foundationVersion":1,"role":"control"}` + "`\n",
			wantProblem: "foundation roleConfig must be declared const",
		},
		{
			name: "policy literal true",
			source: `package sample
type runtimeOperationPolicy struct { claimAllowed bool }
var policy = runtimeOperationPolicy{claimAllowed: true}
`,
			wantProblem: "sets Claim permission to literal true",
		},
		{
			name: "policy mutation",
			source: `package sample
type runtimeOperationPolicy struct { claimAllowed bool }
func mutate(policy *runtimeOperationPolicy, enabled bool) { policy.claimAllowed = enabled }
`,
			wantProblem: "mutates execution authority",
		},
		{
			name: "whole policy mutation",
			source: `package sample
func mutate(server *Server) { server.operationPolicy = runtimeOperationPolicy{} }
`,
			wantProblem: "mutates execution authority",
		},
		{
			name: "general toggle appended to Claim gate",
			source: `package sample
func (s *Server) Serve() {
  if call, ok := message.(CallRequest); ok && call.Operation == OperationClaim && !s.operationPolicy.claimAllowed && !s.options.Enabled {}
}
`,
			wantProblem: "Claim gate condition differs from sealed policy",
		},
		{
			name: "forged Claim gate initializer",
			source: `package sample
func (s *Server) Serve() {
  if call, ok := forgedCall(message); ok && call.Operation == OperationClaim && !s.operationPolicy.claimAllowed {}
}
`,
			wantProblem: "Claim gate initializer differs from exact type assertion",
		},
		{
			name: "environment wrapper inside Claim gate",
			source: `package sample
func (s *Server) Serve() {
  if call, ok := message.(CallRequest); ok && call.Operation == OperationClaim && !s.operationPolicy.claimAllowed {
    if os.Getenv("ALLOW") == "1" { break }
  }
}
`,
			wantProblem: "Claim gate denial body differs from terminal response contract",
		},
		{
			name:     "dynamic derivation config",
			filename: "internal/localrpc/runtime_bootstrap_exchange.go",
			source: `package sample
func deriveRuntimeOperationPolicy(bootstrap RuntimeBootstrapV1) runtimeOperationPolicy {
  config := foundationRoleConfig{ExecutionEnabled: os.Getenv("ENABLE") == "1"}
  return runtimeOperationPolicy{claimAllowed: bootstrap.Role == RoleControl && config.ExecutionEnabled}
}
`,
			wantProblem: "derivation config is assigned or redeclared",
		},
		{
			name:     "alternate role config source",
			filename: "internal/localrpc/runtime_bootstrap_exchange.go",
			source: `package sample
func deriveRuntimeOperationPolicy(bootstrap RuntimeBootstrapV1) {
  expected, err := loadRoleConfig(bootstrap.Role)
  _, _ = expected, err
}
`,
			wantProblem: "roleConfig selection is not exact foundation source",
		},
		{
			name:     "commit publishes before derivation",
			filename: "internal/localrpc/runtime_bootstrap_exchange.go",
			source: `package sample
func (pending *Pending) Commit() {
  EncodeRuntimeBootstrapCommit()
  WriteFrame()
  deriveRuntimeOperationPolicy()
}
`,
			wantProblem: "Commit derives execution authority after commit publication",
		},
		{
			name: "dispatcher Claim before defense",
			source: `package sample
func (s *Server) dispatch(ctx context.Context, request CallRequest) {
  body := bytes.Clone(request.Body)
  switch request.Operation { case OperationClaim: s.dispatcher.Claim(ctx, body) }
  if request.Operation == OperationClaim && !s.operationPolicy.claimAllowed { return }
}
`,
			wantProblem: "dispatch Claim defense is incomplete or out of order",
		},
		{
			name: "dispatch method-value alias",
			source: `package sample
func (s *Server) Serve() { handler := s.dispatchSafely; _ = handler }
`,
			wantProblem: "sensitive dispatch selector is not its unique direct call",
		},
		{
			name: "policy pointer alias",
			source: `package sample
func alias(s *Server) { policy := &s.operationPolicy; _ = policy }
`,
			wantProblem: "takes an address of execution authority",
		},
		{
			name: "policy type alias",
			source: `package sample
type Policy = runtimeOperationPolicy
var server = Server{operationPolicy: Policy{claimAllowed: true}}
`,
			wantProblem: "aliases or redefines runtimeOperationPolicy",
		},
		{
			name: "anonymous policy conversion",
			source: `package sample
var policy = runtimeOperationPolicy(struct{ claimAllowed bool }{claimAllowed: true})
`,
			wantProblem: "converts into runtimeOperationPolicy outside sealed derivation",
		},
		{
			name: "parenthesized policy conversion",
			source: `package sample
var policy = (runtimeOperationPolicy)(struct{ claimAllowed bool }{true})
`,
			wantProblem: "converts into runtimeOperationPolicy outside sealed derivation",
		},
		{
			name: "pointer policy alias",
			source: `package sample
type Policy = *runtimeOperationPolicy
`,
			wantProblem: "aliases or redefines runtimeOperationPolicy",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			filename := test.filename
			if filename == "" {
				filename = "internal/localrpc/server.go"
			}
			scan, err := analyzeClaimAuthoritySource(filename, []byte(test.source))
			if err != nil {
				t.Fatal(err)
			}
			if !claimAuthorityProblemContains(scan.problems, test.wantProblem) {
				t.Fatalf("analyzer problems = %q, want one containing %q", scan.problems, test.wantProblem)
			}
		})
	}
}

type claimTestAuthorityScan struct {
	problems             []string
	harnessDeclarations  int
	permitDeclarations   int
	harnessCalls         map[string]int
	permitCalls          int
	permissionMutations  int
	truePolicyComposites int
}

func TestClaimTestAuthorityIsLimitedAcrossPackage(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	combined := newClaimTestAuthorityScan()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		contents, err := os.ReadFile(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		scan, err := analyzeClaimTestAuthoritySource(entry.Name(), contents)
		if err != nil {
			t.Fatal(err)
		}
		combined.merge(scan)
	}
	for _, problem := range combined.problems {
		t.Error(problem)
	}
	wantCalls := expectedClaimEnabledHarnessCalls()
	for owner, expected := range wantCalls {
		if combined.harnessCalls[owner] != expected {
			t.Errorf("Claim-enabled harness calls from %s = %d, want %d",
				owner, combined.harnessCalls[owner], expected)
		}
	}
	if combined.harnessDeclarations != 1 || combined.permitDeclarations != 1 ||
		combined.permitCalls != 1 || combined.permissionMutations != 1 ||
		combined.truePolicyComposites != 0 || len(combined.harnessCalls) != len(wantCalls) {
		t.Fatalf(
			"Claim test authority counts = harness-declarations:%d permit-declarations:%d harness-callers:%d permit-calls:%d mutations:%d true-composites:%d",
			combined.harnessDeclarations,
			combined.permitDeclarations,
			len(combined.harnessCalls),
			combined.permitCalls,
			combined.permissionMutations,
			combined.truePolicyComposites,
		)
	}
}

func TestClaimTestAuthorityAnalyzerRejectsCrossFileAndAliases(t *testing.T) {
	tests := []struct {
		name        string
		filename    string
		source      string
		wantProblem string
	}{
		{
			name:     "cross-file harness call",
			filename: "other_test.go",
			source: `package localrpc
func TestServerCancelsOneConcurrentRequestWithoutStoppingAnother() {
  newClaimEnabledServerHarness(nil, nil, ServerOptions{})
}
`,
			wantProblem: "Claim-enabled harness caller is not a top-level Go test",
		},
		{
			name:     "harness function alias",
			filename: "other_test.go",
			source: `package localrpc
var start = newClaimEnabledServerHarness
`,
			wantProblem: "non-direct reference to newClaimEnabledServerHarness",
		},
		{
			name:     "indirect permit call",
			filename: "other_test.go",
			source: `package localrpc
func enable() { (permitClaimForServerTest)(nil, CommittedRuntimeBootstrap{}) }
`,
			wantProblem: "non-direct reference to permitClaimForServerTest",
		},
		{
			name:     "cross-file permission mutation",
			filename: "other_test.go",
			source: `package localrpc
func enable() { committed.state.operationPolicy.claimAllowed = true }
`,
			wantProblem: "mutates Claim permission outside its unique fixture",
		},
		{
			name:     "parenthesized permission mutation",
			filename: "other_test.go",
			source: `package localrpc
func enable() { (committed.state.operationPolicy.claimAllowed) = true }
`,
			wantProblem: "mutates Claim permission outside its unique fixture",
		},
		{
			name:     "pointer alias permission mutation",
			filename: "other_test.go",
			source: `package localrpc
func enable() {
  pointer := &committed.state.operationPolicy.claimAllowed
  *pointer = true
}
`,
			wantProblem: "takes an address of test Claim authority",
		},
		{
			name:     "whole policy pointer alias",
			filename: "other_test.go",
			source: `package localrpc
func enable() {
  pointer := &committed.state.operationPolicy
  *pointer = runtimeOperationPolicy{claimAllowed: true}
}
`,
			wantProblem: "takes an address of test Claim authority",
		},
		{
			name:     "computed true policy composite",
			filename: "other_test.go",
			source: `package localrpc
var server = &Server{operationPolicy: runtimeOperationPolicy{claimAllowed: !false}}
`,
			wantProblem: "constructs a true Claim operation policy",
		},
		{
			name:     "same-name method caller",
			filename: "server_test.go",
			source: `package localrpc
type collision struct{}
func (collision) TestServerKeepsClaimResponseOnDedicated16MiBPath() {
  newClaimEnabledServerHarness(nil, nil, ServerOptions{})
}
`,
			wantProblem: "Claim-enabled harness caller is not a top-level Go test",
		},
		{
			name:     "test policy type alias",
			filename: "other_test.go",
			source: `package localrpc
type Policy runtimeOperationPolicy
var server = &Server{operationPolicy: runtimeOperationPolicy(Policy{})}
`,
			wantProblem: "aliases or redefines runtimeOperationPolicy",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			scan, err := analyzeClaimTestAuthoritySource(test.filename, []byte(test.source))
			if err != nil {
				t.Fatal(err)
			}
			if !claimAuthorityProblemContains(scan.problems, test.wantProblem) {
				t.Fatalf("analyzer problems = %q, want one containing %q", scan.problems, test.wantProblem)
			}
		})
	}
}

func newClaimTestAuthorityScan() claimTestAuthorityScan {
	return claimTestAuthorityScan{harnessCalls: make(map[string]int)}
}

func expectedClaimEnabledHarnessCalls() map[string]int {
	return map[string]int{
		"TestServerCancelsOneConcurrentRequestWithoutStoppingAnother": 1,
		"TestServerKeepsClaimResponseOnDedicated16MiBPath":            1,
		"TestServerSerializesClaimDispatchThroughResponseWrite":       1,
	}
}

func analyzeClaimTestAuthoritySource(
	filename string,
	contents []byte,
) (claimTestAuthorityScan, error) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, filename, contents, 0)
	if err != nil {
		return claimTestAuthorityScan{}, err
	}
	scan := newClaimTestAuthorityScan()
	parents := claimAuthorityParents(parsed)
	ast.Inspect(parsed, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.Ident:
			if typed.Name == "newClaimEnabledServerHarness" || typed.Name == "permitClaimForServerTest" {
				scan.inspectAuthorityIdentifier(filename, fileSet, typed, parents)
			}
		case *ast.AssignStmt:
			for index, target := range typed.Lhs {
				if isIndirectTrueAuthorityWrite(target, typed.Rhs, index) {
					scan.addProblem(filename, fileSet, target,
						"writes test Claim authority through an indirect pointer")
				}
				if !isClaimTestPermissionMutationTarget(target) {
					continue
				}
				scan.permissionMutations++
				owner := claimAuthorityEnclosingFunction(typed, parents)
				if filename != "server_test.go" || owner != "permitClaimForServerTest" ||
					!claimAuthorityNodeMatches(target, "committed.state.operationPolicy.claimAllowed") ||
					index >= len(typed.Rhs) || !isTrueIdentifier(typed.Rhs[index]) {
					scan.addProblem(filename, fileSet, target,
						"mutates Claim permission outside its unique fixture")
				}
			}
		case *ast.CompositeLit:
			if isTrueOperationPolicyComposite(typed) {
				scan.truePolicyComposites++
				scan.addProblem(filename, fileSet, typed,
					"constructs a true Claim operation policy outside its unique fixture")
			}
		case *ast.TypeSpec:
			if typed.Name.Name != "runtimeOperationPolicy" &&
				typeSpecAliasesRuntimeOperationPolicy(typed.Type) {
				scan.addProblem(filename, fileSet, typed,
					"aliases or redefines runtimeOperationPolicy in tests")
			}
		case *ast.KeyValueExpr:
			if isOperationPolicyKey(typed.Key) || isClaimAllowedKey(typed.Key) {
				scan.addProblem(filename, fileSet, typed,
					"constructs test Claim authority through a composite key")
			}
		case *ast.CallExpr:
			if isRuntimeOperationPolicyConversion(typed.Fun) {
				scan.addProblem(filename, fileSet, typed,
					"converts into runtimeOperationPolicy in tests")
			}
		case *ast.UnaryExpr:
			if typed.Op == token.AND && isExecutionAuthorityExpression(typed.X) {
				scan.addProblem(filename, fileSet, typed,
					"takes an address of test Claim authority")
			}
		}
		return true
	})
	return scan, nil
}

func (scan *claimTestAuthorityScan) inspectAuthorityIdentifier(
	filename string,
	fileSet *token.FileSet,
	identifier *ast.Ident,
	parents map[ast.Node]ast.Node,
) {
	parent := parents[identifier]
	if declaration, ok := parent.(*ast.FuncDecl); ok && declaration.Name == identifier {
		if identifier.Name == "newClaimEnabledServerHarness" {
			scan.harnessDeclarations++
		} else {
			scan.permitDeclarations++
		}
		validDeclaration := filename == "server_test.go"
		if identifier.Name == "newClaimEnabledServerHarness" {
			validDeclaration = validDeclaration && isExactClaimEnabledHarnessDeclaration(declaration)
		} else {
			validDeclaration = validDeclaration && isExactPermitClaimFixtureDeclaration(declaration)
		}
		if !validDeclaration {
			scan.addProblem(filename, fileSet, identifier,
				"test Claim authority helper declaration differs from its exact contract")
		}
		return
	}
	call, direct := parent.(*ast.CallExpr)
	if !direct || call.Fun != identifier {
		scan.addProblem(filename, fileSet, identifier,
			"non-direct reference to "+identifier.Name)
		return
	}
	ownerDeclaration := claimAuthorityEnclosingFunctionDeclaration(call, parents)
	owner := ""
	if ownerDeclaration != nil {
		owner = ownerDeclaration.Name.Name
	}
	if identifier.Name == "newClaimEnabledServerHarness" {
		scan.harnessCalls[owner]++
		_, allowedOwner := expectedClaimEnabledHarnessCalls()[owner]
		if filename != "server_test.go" || !allowedOwner ||
			!isStandardClaimTestFunction(ownerDeclaration) {
			scan.addProblem(filename, fileSet, identifier,
				"Claim-enabled harness caller is not a top-level Go test in the server_test.go allowlist")
		}
		return
	}
	scan.permitCalls++
	if filename != "server_test.go" || owner != "newClaimEnabledServerHarness" ||
		!isExactClaimEnabledHarnessDeclaration(ownerDeclaration) {
		scan.addProblem(filename, fileSet, identifier,
			"permitClaimForServerTest call is outside dedicated harness")
	}
}

func isTrueOperationPolicyComposite(literal *ast.CompositeLit) bool {
	typeName, ok := literal.Type.(*ast.Ident)
	return ok && typeName.Name == "runtimeOperationPolicy" && len(literal.Elts) != 0
}

func isIndirectTrueAuthorityWrite(target ast.Expr, values []ast.Expr, index int) bool {
	if index >= len(values) {
		return false
	}
	for {
		switch typed := target.(type) {
		case *ast.ParenExpr:
			target = typed.X
		case *ast.StarExpr:
			return isTrueIdentifier(values[index]) || isTrueOperationPolicyExpression(values[index])
		default:
			return false
		}
	}
}

func isTrueOperationPolicyExpression(expression ast.Expr) bool {
	literal, ok := expression.(*ast.CompositeLit)
	return ok && isTrueOperationPolicyComposite(literal)
}

func isStandardClaimTestFunction(function *ast.FuncDecl) bool {
	return function != nil && function.Recv == nil && function.Type.TypeParams == nil &&
		strings.HasPrefix(function.Name.Name, "Test") && function.Type.Params != nil &&
		len(function.Type.Params.List) == 1 && exactNamedField(
		function.Type.Params.List[0],
		"t",
		"*testing.T",
	) && emptyFieldList(function.Type.Results)
}

func isExactClaimEnabledHarnessDeclaration(function *ast.FuncDecl) bool {
	return function != nil && function.Name.Name == "newClaimEnabledServerHarness" &&
		function.Recv == nil && function.Type.TypeParams == nil && function.Type.Params != nil &&
		len(function.Type.Params.List) == 3 &&
		exactNamedField(function.Type.Params.List[0], "t", "*testing.T") &&
		exactNamedField(function.Type.Params.List[1], "dispatcher", "ControlDispatcher") &&
		exactNamedField(function.Type.Params.List[2], "options", "ServerOptions") &&
		exactSingleUnnamedResult(function.Type.Results, "*serverHarness")
}

func isExactPermitClaimFixtureDeclaration(function *ast.FuncDecl) bool {
	return function != nil && function.Name.Name == "permitClaimForServerTest" &&
		function.Recv == nil && function.Type.TypeParams == nil && function.Type.Params != nil &&
		len(function.Type.Params.List) == 2 &&
		exactNamedField(function.Type.Params.List[0], "t", "*testing.T") &&
		exactNamedField(function.Type.Params.List[1], "committed", "CommittedRuntimeBootstrap") &&
		exactSingleUnnamedResult(function.Type.Results, "CommittedRuntimeBootstrap")
}

func exactNamedField(field *ast.Field, name, typeExpression string) bool {
	return field != nil && len(field.Names) == 1 && field.Names[0].Name == name &&
		claimAuthorityNodeMatches(field.Type, typeExpression)
}

func exactSingleUnnamedResult(results *ast.FieldList, typeExpression string) bool {
	return results != nil && len(results.List) == 1 && len(results.List[0].Names) == 0 &&
		claimAuthorityNodeMatches(results.List[0].Type, typeExpression)
}

func emptyFieldList(fields *ast.FieldList) bool {
	return fields == nil || len(fields.List) == 0
}

func isClaimAllowedKey(expression ast.Expr) bool {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name == "claimAllowed"
	case *ast.BasicLit:
		if typed.Kind != token.STRING {
			return false
		}
		value, err := strconv.Unquote(typed.Value)
		return err == nil && value == "claimAllowed"
	default:
		return false
	}
}

func isOperationPolicyKey(expression ast.Expr) bool {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name == "operationPolicy"
	case *ast.BasicLit:
		if typed.Kind != token.STRING {
			return false
		}
		value, err := strconv.Unquote(typed.Value)
		return err == nil && value == "operationPolicy"
	default:
		return false
	}
}

func typeSpecAliasesRuntimeOperationPolicy(expression ast.Expr) bool {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name == "runtimeOperationPolicy"
	case *ast.ParenExpr:
		return typeSpecAliasesRuntimeOperationPolicy(typed.X)
	case *ast.StarExpr:
		return typeSpecAliasesRuntimeOperationPolicy(typed.X)
	case *ast.IndexExpr:
		return typeSpecAliasesRuntimeOperationPolicy(typed.X)
	case *ast.IndexListExpr:
		return typeSpecAliasesRuntimeOperationPolicy(typed.X)
	default:
		return false
	}
}

func isRuntimeOperationPolicyConversion(expression ast.Expr) bool {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name == "runtimeOperationPolicy"
	case *ast.ParenExpr:
		return isRuntimeOperationPolicyConversion(typed.X)
	case *ast.IndexExpr:
		return isRuntimeOperationPolicyConversion(typed.X)
	case *ast.IndexListExpr:
		return isRuntimeOperationPolicyConversion(typed.X)
	default:
		return false
	}
}

func isExactDerivedPolicyAssignment(
	filename string,
	assignment *ast.AssignStmt,
	parents map[ast.Node]ast.Node,
) bool {
	if filename != "internal/localrpc/runtime_bootstrap_exchange.go" ||
		claimAuthorityEnclosingFunction(assignment, parents) != "Commit" ||
		assignment.Tok != token.DEFINE || len(assignment.Lhs) != 2 || len(assignment.Rhs) != 1 {
		return false
	}
	policy, policyOK := assignment.Lhs[0].(*ast.Ident)
	errName, errOK := assignment.Lhs[1].(*ast.Ident)
	return policyOK && errOK && policy.Name == "operationPolicy" && errName.Name == "err" &&
		claimAuthorityNodeMatches(
			assignment.Rhs[0],
			"deriveRuntimeOperationPolicy(bootstrap)",
		)
}

func (scan *claimTestAuthorityScan) addProblem(
	filename string,
	fileSet *token.FileSet,
	node ast.Node,
	message string,
) {
	scan.problems = append(scan.problems, fmt.Sprintf(
		"%s:%d: %s",
		filename,
		fileSet.Position(node.Pos()).Line,
		message,
	))
}

func (scan *claimTestAuthorityScan) merge(other claimTestAuthorityScan) {
	scan.problems = append(scan.problems, other.problems...)
	scan.harnessDeclarations += other.harnessDeclarations
	scan.permitDeclarations += other.permitDeclarations
	for owner, count := range other.harnessCalls {
		scan.harnessCalls[owner] += count
	}
	scan.permitCalls += other.permitCalls
	scan.permissionMutations += other.permissionMutations
	scan.truePolicyComposites += other.truePolicyComposites
}

func analyzeClaimAuthoritySource(filename string, contents []byte) (claimAuthorityScan, error) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, filename, contents, 0)
	if err != nil {
		return claimAuthorityScan{}, err
	}
	scan := claimAuthorityScan{}
	parents := claimAuthorityParents(parsed)
	for _, declaration := range parsed.Decls {
		switch typed := declaration.(type) {
		case *ast.FuncDecl:
			scan.inspectFunction(filename, fileSet, typed, parents)
		case *ast.GenDecl:
			for _, specification := range typed.Specs {
				switch spec := specification.(type) {
				case *ast.ValueSpec:
					scan.inspectValueSpec(filename, fileSet, typed.Tok, spec)
				case *ast.TypeSpec:
					scan.inspectTypeSpec(filename, fileSet, spec)
				}
			}
		}
	}
	ast.Inspect(parsed, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.Ident:
			if isLocalRPCProductionFile(filename) &&
				(typed.Name == "deriveRuntimeOperationPolicy" || typed.Name == "foundationRoleConfigJSON") {
				scan.inspectProductionAuthorityIdentifier(filename, fileSet, typed, parents)
			}
		case *ast.AssignStmt:
			for _, target := range typed.Lhs {
				if isExecutionAuthorityExpression(target) {
					if isExactDerivedPolicyAssignment(filename, typed, parents) {
						scan.derivedPolicyAssignments++
					} else {
						scan.addProblem(filename, fileSet, target, "mutates execution authority after construction")
					}
				}
			}
		case *ast.IncDecStmt:
			if isExecutionAuthorityExpression(typed.X) {
				scan.addProblem(filename, fileSet, typed.X, "mutates execution authority after construction")
			}
		case *ast.UnaryExpr:
			if isLocalRPCProductionFile(filename) && typed.Op == token.AND &&
				isExecutionAuthorityExpression(typed.X) {
				scan.addProblem(filename, fileSet, typed,
					"takes an address of execution authority")
			}
		case *ast.BasicLit:
			if typed.Kind == token.STRING {
				value, unquoteErr := strconv.Unquote(typed.Value)
				if unquoteErr == nil && roleConfigEnablesExecution(value) {
					scan.addProblem(filename, fileSet, typed, "roleConfig literal enables execution")
				}
			}
		case *ast.KeyValueExpr:
			if isExecutionEnabledKey(typed.Key) && isTrueIdentifier(typed.Value) {
				scan.addProblem(filename, fileSet, typed, "roleConfig value enables execution")
			}
			if isOperationPolicyKey(typed.Key) {
				scan.inspectOperationPolicyBinding(filename, fileSet, typed, parents)
			}
			if isClaimAllowedKey(typed.Key) {
				scan.inspectClaimAllowedInitializer(filename, fileSet, typed, parents)
			}
		case *ast.CompositeLit:
			scan.inspectPolicyLiteral(filename, fileSet, typed, parents)
		case *ast.SelectorExpr:
			if isLocalRPCProductionFile(filename) &&
				(typed.Sel.Name == "Claim" || typed.Sel.Name == "dispatchSafely" ||
					typed.Sel.Name == "dispatch") {
				scan.inspectSensitiveDispatchSelector(filename, fileSet, typed, parents)
			}
		case *ast.CallExpr:
			if isRuntimeOperationPolicyConversion(typed.Fun) {
				scan.addProblem(filename, fileSet, typed,
					"converts into runtimeOperationPolicy outside sealed derivation")
			}
			function, ok := typed.Fun.(*ast.Ident)
			if !ok || function.Name != "deriveRuntimeOperationPolicy" {
				break
			}
			scan.derivationCalls++
			if filename != "internal/localrpc/runtime_bootstrap_exchange.go" ||
				claimAuthorityEnclosingFunction(typed, parents) != "Commit" {
				scan.addProblem(filename, fileSet, typed, "derives execution authority outside bootstrap Commit")
			}
		case *ast.IfStmt:
			if !containsClaimOperationComparison(typed.Cond) {
				break
			}
			scan.claimGates++
			if !isExactServeClaimGateInitializer(typed.Init) {
				scan.addProblem(filename, fileSet, typed,
					"Claim gate initializer differs from exact type assertion")
			} else if !claimAuthorityExpressionMatches(
				typed.Cond,
				"ok && call.Operation == OperationClaim && !s.operationPolicy.claimAllowed",
			) {
				scan.addProblem(filename, fileSet, typed.Cond, "Claim gate condition differs from sealed policy")
			} else if isExactServeClaimDenialBody(typed.Body) {
				scan.exactClaimDenialBodies++
			} else {
				scan.addProblem(filename, fileSet, typed.Body,
					"Claim gate denial body differs from terminal response contract")
			}
		}
		return true
	})
	return scan, nil
}

func (scan *claimAuthorityScan) inspectFunction(
	filename string,
	fileSet *token.FileSet,
	function *ast.FuncDecl,
	parents map[ast.Node]ast.Node,
) {
	if isAuthorityToggleName(function.Name.Name) {
		scan.addProblem(filename, fileSet, function.Name, "declares a bare authority function")
	}
	for _, fields := range []*ast.FieldList{function.Type.Params, function.Type.Results} {
		if fields == nil {
			continue
		}
		for _, field := range fields.List {
			for _, name := range field.Names {
				if isAuthorityToggleName(name.Name) {
					scan.addProblem(filename, fileSet, name, "declares a bare authority parameter")
				}
			}
		}
	}
	if function.Name.Name == "foundationRoleConfigJSON" {
		if filename == "internal/localrpc/runtime_bootstrap.go" &&
			isExactFoundationRoleSelector(function) {
			scan.foundationSelectors++
		} else {
			scan.addProblem(filename, fileSet, function, "foundation roleConfig selector is not exact")
		}
	}
	if function.Name.Name == "deriveRuntimeOperationPolicy" {
		scan.inspectDerivationConfig(filename, fileSet, function)
		ast.Inspect(function.Body, func(node ast.Node) bool {
			condition, ok := node.(*ast.IfStmt)
			if ok && claimAuthorityExpressionMatches(
				condition.Cond,
				"err != nil || !bytes.Equal(bootstrap.roleConfigJSON, []byte(expected))",
			) {
				scan.exactRoleConfigGuards++
			}
			return true
		})
	}
	if filename == "internal/localrpc/server.go" && function.Name.Name == "Serve" {
		scan.inspectServeOrder(filename, fileSet, function, parents)
	}
	if filename == "internal/localrpc/runtime_bootstrap_exchange.go" && function.Name.Name == "Commit" {
		scan.inspectCommitOrder(filename, fileSet, function)
	}
	if filename == "internal/localrpc/server.go" && function.Name.Name == "dispatch" {
		scan.inspectDispatchDefense(filename, fileSet, function)
	}
}

func (scan *claimAuthorityScan) inspectProductionAuthorityIdentifier(
	filename string,
	fileSet *token.FileSet,
	identifier *ast.Ident,
	parents map[ast.Node]ast.Node,
) {
	parent := parents[identifier]
	if declaration, ok := parent.(*ast.FuncDecl); ok && declaration.Name == identifier {
		validDeclaration := identifier.Name == "deriveRuntimeOperationPolicy" &&
			filename == "internal/localrpc/runtime_bootstrap_exchange.go" ||
			identifier.Name == "foundationRoleConfigJSON" &&
				filename == "internal/localrpc/runtime_bootstrap.go"
		if !validDeclaration {
			scan.addProblem(filename, fileSet, identifier,
				"sensitive authority function is declared outside its fixed source")
		}
		return
	}
	call, direct := parent.(*ast.CallExpr)
	if !direct || call.Fun != identifier {
		scan.addProblem(filename, fileSet, identifier,
			"sensitive authority function has a non-direct reference")
		return
	}
	owner := claimAuthorityEnclosingFunction(call, parents)
	if identifier.Name == "deriveRuntimeOperationPolicy" {
		if filename != "internal/localrpc/runtime_bootstrap_exchange.go" || owner != "Commit" {
			scan.addProblem(filename, fileSet, identifier,
				"deriveRuntimeOperationPolicy is called outside bootstrap Commit")
		}
		return
	}
	allowed := filename == "internal/localrpc/runtime_bootstrap.go" &&
		(owner == "newFoundationRuntimeBootstrap" || owner == "BindRuntimeBootstrapToLaunch") ||
		filename == "internal/localrpc/runtime_bootstrap_exchange.go" &&
			owner == "deriveRuntimeOperationPolicy"
	if !allowed {
		scan.addProblem(filename, fileSet, identifier,
			"foundationRoleConfigJSON is called outside its fixed authority chain")
		return
	}
	scan.foundationSelectorCalls++
}

func (scan *claimAuthorityScan) inspectSensitiveDispatchSelector(
	filename string,
	fileSet *token.FileSet,
	selector *ast.SelectorExpr,
	parents map[ast.Node]ast.Node,
) {
	call, direct := parents[selector].(*ast.CallExpr)
	if !direct || call.Fun != selector {
		scan.addProblem(filename, fileSet, selector,
			"sensitive dispatch selector is not its unique direct call")
		return
	}
	owner := claimAuthorityEnclosingFunction(call, parents)
	valid := false
	switch selector.Sel.Name {
	case "Claim":
		valid = filename == "internal/localrpc/server.go" && owner == "dispatch" &&
			claimAuthorityNodeMatches(call, "s.dispatcher.Claim(ctx, body)")
		if valid {
			scan.dispatcherClaimCalls++
		}
	case "dispatchSafely":
		valid = filename == "internal/localrpc/server.go" && owner == "Serve" &&
			claimAuthorityNodeMatches(call, "s.dispatchSafely(requestContext, request)")
		if valid {
			scan.dispatchSafelyCalls++
		}
	case "dispatch":
		valid = filename == "internal/localrpc/server.go" && owner == "dispatchSafely" &&
			claimAuthorityNodeMatches(call, "s.dispatch(ctx, request)")
		if valid {
			scan.dispatchCalls++
		}
	}
	if !valid {
		scan.addProblem(filename, fileSet, selector,
			"sensitive dispatch selector is not its unique direct call")
	}
}

func (scan *claimAuthorityScan) inspectDispatchDefense(
	filename string,
	fileSet *token.FileSet,
	function *ast.FuncDecl,
) {
	positions := map[string]token.Pos{}
	ast.Inspect(function.Body, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.IfStmt:
			if claimAuthorityExpressionMatches(
				typed.Cond,
				"request.Operation == OperationClaim && !s.operationPolicy.claimAllowed",
			) {
				positions["defense"] = typed.Pos()
				if isExactDispatchDefenseBody(typed.Body) {
					scan.dispatchDefenseGates++
				} else {
					scan.addProblem(filename, fileSet, typed.Body,
						"dispatch Claim defense body differs from fail-closed contract")
				}
			}
		case *ast.CallExpr:
			switch calledFunctionName(typed.Fun) {
			case "Clone":
				if positions["clone"] == token.NoPos {
					positions["clone"] = typed.Pos()
				}
			case "Claim":
				if positions["claim"] == token.NoPos {
					positions["claim"] = typed.Pos()
				}
			}
		case *ast.SwitchStmt:
			if claimAuthorityNodeMatches(typed.Tag, "request.Operation") &&
				positions["switch"] == token.NoPos {
				positions["switch"] = typed.Pos()
			}
		}
		return true
	})
	order := []string{"defense", "clone", "switch", "claim"}
	previous := token.NoPos
	for _, name := range order {
		position := positions[name]
		if position == token.NoPos || previous != token.NoPos && position <= previous {
			scan.addProblem(filename, fileSet, function,
				"dispatch Claim defense is incomplete or out of order")
			return
		}
		previous = position
	}
	scan.orderedDispatchDefenses++
}

func (scan *claimAuthorityScan) inspectDerivationConfig(
	filename string,
	fileSet *token.FileSet,
	function *ast.FuncDecl,
) {
	for _, field := range function.Type.Params.List {
		for _, name := range field.Names {
			if name.Name == "config" || name.Name == "expected" {
				scan.addProblem(filename, fileSet, name, "derivation authority input is supplied by a caller")
			}
		}
	}
	ast.Inspect(function.Body, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.DeclStmt:
			if isExactDerivationConfigDeclaration(typed) {
				scan.deriveConfigDeclarations++
				break
			}
			if declarationContainsName(typed.Decl, "config") {
				scan.addProblem(filename, fileSet, typed, "derivation config is assigned or redeclared")
			}
			if declarationContainsName(typed.Decl, "expected") {
				scan.addProblem(filename, fileSet, typed, "roleConfig selection is not exact foundation source")
			}
		case *ast.AssignStmt:
			if assignmentContainsName(typed, "expected") {
				if isExactRoleConfigSelection(typed) {
					scan.exactRoleConfigSelections++
				} else {
					scan.addProblem(filename, fileSet, typed, "roleConfig selection is not exact foundation source")
				}
			}
			for _, target := range typed.Lhs {
				identifier, ok := target.(*ast.Ident)
				if ok && identifier.Name == "config" {
					scan.addProblem(filename, fileSet, target, "derivation config is assigned or redeclared")
				}
			}
		case *ast.CallExpr:
			if calledFunctionName(typed.Fun) != "decodeExact" {
				break
			}
			if claimAuthorityExpressionMatches(
				typed,
				"decodeExact(bootstrap.roleConfigJSON, &config)",
			) {
				scan.exactRoleConfigDecodes++
			} else {
				scan.addProblem(filename, fileSet, typed, "derivation does not decode exact committed roleConfig bytes")
			}
		}
		return true
	})
}

func (scan *claimAuthorityScan) inspectValueSpec(
	filename string,
	fileSet *token.FileSet,
	declarationToken token.Token,
	specification *ast.ValueSpec,
) {
	for index, name := range specification.Names {
		if isAuthorityToggleName(name.Name) {
			scan.addProblem(filename, fileSet, name, "declares a bare authority value")
		}
		if name.Name != "controlFoundationRoleConfigJSON" &&
			name.Name != "executorFoundationRoleConfigJSON" {
			continue
		}
		if declarationToken != token.CONST {
			scan.addProblem(filename, fileSet, name, "foundation roleConfig must be declared const")
		}
		value, ok := stringValueAt(specification.Values, index)
		if !ok {
			scan.addProblem(filename, fileSet, name, "foundation roleConfig is not one fixed string literal")
		}
		if name.Name == "controlFoundationRoleConfigJSON" {
			scan.controlFoundationConfigs = append(scan.controlFoundationConfigs, value)
		} else {
			scan.executorFoundationConfigs = append(scan.executorFoundationConfigs, value)
		}
	}
}

func (scan *claimAuthorityScan) inspectCommitOrder(
	filename string,
	fileSet *token.FileSet,
	function *ast.FuncDecl,
) {
	positions := map[string]token.Pos{}
	ast.Inspect(function.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		name := calledFunctionName(call.Fun)
		switch name {
		case "deriveRuntimeOperationPolicy", "EncodeRuntimeBootstrapCommit", "WriteFrame":
			if positions[name] == token.NoPos {
				positions[name] = call.Pos()
			}
		}
		return true
	})
	derive := positions["deriveRuntimeOperationPolicy"]
	encode := positions["EncodeRuntimeBootstrapCommit"]
	publish := positions["WriteFrame"]
	if derive == token.NoPos || encode == token.NoPos || publish == token.NoPos ||
		derive >= encode || encode >= publish {
		scan.addProblem(filename, fileSet, function, "Commit derives execution authority after commit publication")
		return
	}
	scan.orderedCommitAuthorityChains++
}

func (scan *claimAuthorityScan) inspectTypeSpec(
	filename string,
	fileSet *token.FileSet,
	specification *ast.TypeSpec,
) {
	if specification.Name.Name == "runtimeOperationPolicy" &&
		!isExactRuntimeOperationPolicyType(specification) {
		scan.addProblem(filename, fileSet, specification,
			"runtimeOperationPolicy type differs from its exact private shape")
	}
	if specification.Name.Name != "runtimeOperationPolicy" &&
		typeSpecAliasesRuntimeOperationPolicy(specification.Type) {
		scan.addProblem(filename, fileSet, specification,
			"aliases or redefines runtimeOperationPolicy")
	}
	structure, ok := specification.Type.(*ast.StructType)
	if !ok {
		return
	}
	for _, field := range structure.Fields.List {
		fieldType, isBool := field.Type.(*ast.Ident)
		for _, name := range field.Names {
			if filename == "internal/localrpc/server.go" &&
				specification.Name.Name == "ServerOptions" && isBool && fieldType.Name == "bool" {
				scan.addProblem(filename, fileSet, name, "ServerOptions exposes a general boolean authority switch")
			}
			if !isAuthorityToggleName(name.Name) {
				continue
			}
			switch {
			case specification.Name.Name == "runtimeOperationPolicy" &&
				name.Name == "claimAllowed" && isBool && fieldType.Name == "bool":
				scan.policyFields++
			case specification.Name.Name == "foundationRoleConfig" &&
				name.Name == "ExecutionEnabled" && isBool && fieldType.Name == "bool":
				scan.roleExecutionFields++
			default:
				scan.addProblem(filename, fileSet, name, "declares a bare authority field")
			}
		}
	}
}

func (scan *claimAuthorityScan) inspectOperationPolicyBinding(
	filename string,
	fileSet *token.FileSet,
	entry *ast.KeyValueExpr,
	parents map[ast.Node]ast.Node,
) {
	literal, ok := parents[entry].(*ast.CompositeLit)
	if !ok {
		scan.addProblem(filename, fileSet, entry,
			"operationPolicy key is outside a fixed authority binding")
		return
	}
	typeName, ok := literal.Type.(*ast.Ident)
	if !ok {
		scan.addProblem(filename, fileSet, entry,
			"operationPolicy key uses a non-fixed composite type")
		return
	}
	owner := claimAuthorityEnclosingFunction(entry, parents)
	valid := filename == "internal/localrpc/runtime_bootstrap_exchange.go" &&
		owner == "Commit" && typeName.Name == "committedRuntimeBootstrapState" &&
		claimAuthorityNodeMatches(entry.Value, "operationPolicy") ||
		filename == "internal/localrpc/runtime_bootstrap_exchange.go" &&
			owner == "consumeCommittedRuntimeBootstrap" &&
			typeName.Name == "committedRuntimeBootstrapBinding" &&
			claimAuthorityNodeMatches(entry.Value, "state.operationPolicy") ||
		filename == "internal/localrpc/server.go" && owner == "NewServer" &&
			typeName.Name == "Server" &&
			claimAuthorityNodeMatches(entry.Value, "shutdown.binding.operationPolicy")
	if !valid {
		scan.addProblem(filename, fileSet, entry,
			"operationPolicy key is outside its fixed authority binding allowlist")
		return
	}
	scan.operationPolicyBindings++
}

func (scan *claimAuthorityScan) inspectClaimAllowedInitializer(
	filename string,
	fileSet *token.FileSet,
	entry *ast.KeyValueExpr,
	parents map[ast.Node]ast.Node,
) {
	literal, ok := parents[entry].(*ast.CompositeLit)
	if !ok {
		scan.addProblem(filename, fileSet, entry,
			"claimAllowed entry is outside a composite literal")
		return
	}
	typeName, typeOK := literal.Type.(*ast.Ident)
	if !typeOK || typeName.Name != "runtimeOperationPolicy" ||
		filename != "internal/localrpc/runtime_bootstrap_exchange.go" ||
		claimAuthorityEnclosingFunction(entry, parents) != "deriveRuntimeOperationPolicy" ||
		!claimAuthorityNodeMatches(
			entry.Value,
			"bootstrap.Role == RoleControl && config.ExecutionEnabled",
		) {
		scan.addProblem(filename, fileSet, entry,
			"claimAllowed composite entry is outside sealed derivation")
	}
}

func (scan *claimAuthorityScan) inspectPolicyLiteral(
	filename string,
	fileSet *token.FileSet,
	literal *ast.CompositeLit,
	parents map[ast.Node]ast.Node,
) {
	typeName, ok := literal.Type.(*ast.Ident)
	if !ok || typeName.Name != "runtimeOperationPolicy" {
		return
	}
	for _, element := range literal.Elts {
		keyed, ok := element.(*ast.KeyValueExpr)
		if !ok {
			scan.addProblem(filename, fileSet, literal, "constructs operation policy positionally")
			continue
		}
		key, ok := keyed.Key.(*ast.Ident)
		if !ok || key.Name != "claimAllowed" {
			scan.addProblem(filename, fileSet, keyed, "constructs operation policy with an unknown field")
			continue
		}
		scan.policyInitializers++
		if isTrueIdentifier(keyed.Value) {
			scan.addProblem(filename, fileSet, keyed.Value, "sets Claim permission to literal true")
		}
		if filename != "internal/localrpc/runtime_bootstrap_exchange.go" ||
			claimAuthorityEnclosingFunction(keyed, parents) != "deriveRuntimeOperationPolicy" ||
			!claimAuthorityExpressionMatches(
				keyed.Value,
				"bootstrap.Role == RoleControl && config.ExecutionEnabled",
			) {
			scan.addProblem(filename, fileSet, keyed, "initializes Claim permission outside sealed derivation")
		}
	}
}

func (scan *claimAuthorityScan) inspectServeOrder(
	filename string,
	fileSet *token.FileSet,
	function *ast.FuncDecl,
	_ map[ast.Node]ast.Node,
) {
	positions := map[string]token.Pos{}
	ast.Inspect(function.Body, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.CallExpr:
			name := calledFunctionName(typed.Fun)
			switch name {
			case "DecodeMessage", "shutdownStarted", "reserveID", "start", "dispatchSafely":
				if positions[name] == token.NoPos {
					positions[name] = typed.Pos()
				}
			}
		case *ast.IfStmt:
			if containsClaimOperationComparison(typed.Cond) && positions["claimGate"] == token.NoPos {
				positions["claimGate"] = typed.Pos()
			}
		}
		return true
	})
	order := []string{"DecodeMessage", "shutdownStarted", "claimGate", "reserveID", "start", "dispatchSafely"}
	previous := token.NoPos
	for _, name := range order {
		position := positions[name]
		if position == token.NoPos || previous != token.NoPos && position <= previous {
			scan.addProblem(filename, fileSet, function, "Serve execution authority sequence is incomplete or out of order")
			return
		}
		previous = position
	}
	scan.orderedServeAuthorityChains++
}

func isExactFoundationRoleSelector(function *ast.FuncDecl) bool {
	if function.Body == nil || len(function.Body.List) != 1 {
		return false
	}
	selection, ok := function.Body.List[0].(*ast.SwitchStmt)
	if !ok || selection.Init != nil {
		return false
	}
	role, ok := selection.Tag.(*ast.Ident)
	if !ok || role.Name != "role" || len(selection.Body.List) != 3 {
		return false
	}
	return exactFoundationRoleCase(selection.Body.List[0], "RoleControl", "controlFoundationRoleConfigJSON") &&
		exactFoundationRoleCase(selection.Body.List[1], "RoleExecutor", "executorFoundationRoleConfigJSON") &&
		exactFoundationDefaultCase(selection.Body.List[2])
}

func exactFoundationRoleCase(statement ast.Stmt, roleName, configName string) bool {
	clause, ok := statement.(*ast.CaseClause)
	if !ok || len(clause.List) != 1 || len(clause.Body) != 1 {
		return false
	}
	role, ok := clause.List[0].(*ast.Ident)
	result, resultOK := clause.Body[0].(*ast.ReturnStmt)
	if !ok || !resultOK || role.Name != roleName || len(result.Results) != 2 {
		return false
	}
	config, configOK := result.Results[0].(*ast.Ident)
	nilValue, nilOK := result.Results[1].(*ast.Ident)
	return configOK && nilOK && config.Name == configName && nilValue.Name == "nil"
}

func exactFoundationDefaultCase(statement ast.Stmt) bool {
	clause, ok := statement.(*ast.CaseClause)
	if !ok || len(clause.List) != 0 || len(clause.Body) != 1 {
		return false
	}
	result, ok := clause.Body[0].(*ast.ReturnStmt)
	if !ok || len(result.Results) != 2 {
		return false
	}
	empty, ok := result.Results[0].(*ast.BasicLit)
	failure, failureOK := result.Results[1].(*ast.CallExpr)
	if !ok || empty.Kind != token.STRING || empty.Value != `""` || !failureOK ||
		len(failure.Args) != 2 {
		return false
	}
	function, functionOK := failure.Fun.(*ast.SelectorExpr)
	if !functionOK {
		return false
	}
	packageName, packageOK := function.X.(*ast.Ident)
	message, messageOK := failure.Args[0].(*ast.BasicLit)
	cause, causeOK := failure.Args[1].(*ast.Ident)
	return packageOK && messageOK && causeOK &&
		packageName.Name == "fmt" && function.Sel.Name == "Errorf" &&
		message.Kind == token.STRING && message.Value == `"%w: foundation role"` &&
		cause.Name == "ErrInvalidRuntimeBootstrap"
}

func isExactServeClaimDenialBody(body *ast.BlockStmt) bool {
	if body == nil || len(body.List) != 5 ||
		!claimAuthorityStatementMatches(
			body.List[0],
			`denied := protocolError("OPERATION_NOT_ALLOWED", "Local RPC Claim is not enabled by the committed role configuration.", call.ID, ErrOperationNotAllowed)`,
		) ||
		!claimAuthorityStatementMatches(
			body.List[1],
			`writeErr := writer.writeError(call.ID, errorBody{Code: denied.Code, Message: denied.Message, Retryable: false})`,
		) ||
		!claimAuthorityStatementMatches(body.List[2], `terminalError = denied`) {
		return false
	}
	writeFailure, ok := body.List[3].(*ast.IfStmt)
	if !ok || writeFailure.Else != nil ||
		!claimAuthorityExpressionMatches(writeFailure.Cond, "writeErr != nil") ||
		writeFailure.Body == nil || len(writeFailure.Body.List) != 1 ||
		!claimAuthorityStatementMatches(
			writeFailure.Body.List[0],
			`terminalError = errors.Join(denied, writeErr)`,
		) {
		return false
	}
	terminalBreak, ok := body.List[4].(*ast.BranchStmt)
	return ok && terminalBreak.Tok == token.BREAK && terminalBreak.Label == nil
}

func isExactServeClaimGateInitializer(statement ast.Stmt) bool {
	assignment, ok := statement.(*ast.AssignStmt)
	if !ok || assignment.Tok != token.DEFINE || len(assignment.Lhs) != 2 ||
		len(assignment.Rhs) != 1 {
		return false
	}
	call, callOK := assignment.Lhs[0].(*ast.Ident)
	okValue, okOK := assignment.Lhs[1].(*ast.Ident)
	assertion, assertionOK := assignment.Rhs[0].(*ast.TypeAssertExpr)
	if !callOK || !okOK || !assertionOK || call.Name != "call" || okValue.Name != "ok" {
		return false
	}
	message, messageOK := assertion.X.(*ast.Ident)
	requestType, requestTypeOK := assertion.Type.(*ast.Ident)
	return messageOK && requestTypeOK && message.Name == "message" && requestType.Name == "CallRequest"
}

func isExactDispatchDefenseBody(body *ast.BlockStmt) bool {
	if body == nil || len(body.List) != 1 {
		return false
	}
	result, ok := body.List[0].(*ast.ReturnStmt)
	if !ok || len(result.Results) != 2 {
		return false
	}
	nilValue, nilOK := result.Results[0].(*ast.Ident)
	cause, causeOK := result.Results[1].(*ast.Ident)
	return nilOK && causeOK && nilValue.Name == "nil" && cause.Name == "ErrOperationNotAllowed"
}

func containsClaimOperationComparison(expression ast.Expr) bool {
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		binary, ok := node.(*ast.BinaryExpr)
		if !ok || binary.Op != token.EQL {
			return true
		}
		left, leftOK := binary.X.(*ast.SelectorExpr)
		right, rightOK := binary.Y.(*ast.Ident)
		if !leftOK || !rightOK {
			return true
		}
		root, rootOK := left.X.(*ast.Ident)
		if rootOK && root.Name == "call" &&
			left.Sel.Name == "Operation" && right.Name == "OperationClaim" {
			found = true
			return false
		}
		return true
	})
	return found
}

func isExactDerivationConfigDeclaration(statement *ast.DeclStmt) bool {
	declaration, ok := statement.Decl.(*ast.GenDecl)
	if !ok || declaration.Tok != token.VAR || len(declaration.Specs) != 1 {
		return false
	}
	specification, ok := declaration.Specs[0].(*ast.ValueSpec)
	if !ok || len(specification.Names) != 1 || specification.Names[0].Name != "config" ||
		len(specification.Values) != 0 {
		return false
	}
	typeName, ok := specification.Type.(*ast.Ident)
	return ok && typeName.Name == "foundationRoleConfig"
}

func declarationContainsName(declaration ast.Decl, expected string) bool {
	general, ok := declaration.(*ast.GenDecl)
	if !ok {
		return false
	}
	for _, specification := range general.Specs {
		value, ok := specification.(*ast.ValueSpec)
		if !ok {
			continue
		}
		for _, name := range value.Names {
			if name.Name == expected {
				return true
			}
		}
	}
	return false
}

func claimAuthorityExpressionMatches(expression ast.Expr, expected string) bool {
	expectedExpression, err := parser.ParseExpr(expected)
	if err != nil {
		panic(err)
	}
	actualDocument, err := renderClaimAuthorityNode(expression)
	if err != nil {
		return false
	}
	expectedDocument, err := renderClaimAuthorityNode(expectedExpression)
	return err == nil && actualDocument == expectedDocument
}

func claimAuthorityNodeMatches(node ast.Node, expected string) bool {
	expectedExpression, err := parser.ParseExpr(expected)
	if err != nil {
		panic(err)
	}
	actualDocument, err := renderClaimAuthorityNode(node)
	if err != nil {
		return false
	}
	expectedDocument, err := renderClaimAuthorityNode(expectedExpression)
	return err == nil && actualDocument == expectedDocument
}

func claimAuthorityStatementMatches(statement ast.Stmt, expected string) bool {
	parsed, err := parser.ParseFile(
		token.NewFileSet(),
		"expected.go",
		"package expected\nfunc check() {\n"+expected+"\n}\n",
		0,
	)
	if err != nil || len(parsed.Decls) != 1 {
		panic("invalid expected Claim authority statement")
	}
	function, ok := parsed.Decls[0].(*ast.FuncDecl)
	if !ok || function.Body == nil || len(function.Body.List) != 1 {
		panic("invalid expected Claim authority statement shape")
	}
	actualDocument, err := renderClaimAuthorityNode(statement)
	if err != nil {
		return false
	}
	expectedDocument, err := renderClaimAuthorityNode(function.Body.List[0])
	return err == nil && actualDocument == expectedDocument
}

func isClaimTestPermissionMutationTarget(expression ast.Expr) bool {
	switch typed := expression.(type) {
	case *ast.SelectorExpr:
		return typed.Sel.Name == "claimAllowed" || typed.Sel.Name == "operationPolicy" ||
			isClaimTestPermissionMutationTarget(typed.X)
	case *ast.ParenExpr:
		return isClaimTestPermissionMutationTarget(typed.X)
	case *ast.StarExpr:
		return isClaimTestPermissionMutationTarget(typed.X)
	case *ast.IndexExpr:
		return isClaimTestPermissionMutationTarget(typed.X)
	case *ast.IndexListExpr:
		return isClaimTestPermissionMutationTarget(typed.X)
	case *ast.UnaryExpr:
		return typed.Op == token.AND && isClaimTestPermissionMutationTarget(typed.X)
	default:
		return false
	}
}

func isExactRuntimeOperationPolicyType(specification *ast.TypeSpec) bool {
	if specification == nil || specification.Assign.IsValid() {
		return false
	}
	structure, ok := specification.Type.(*ast.StructType)
	if !ok || len(structure.Fields.List) != 1 {
		return false
	}
	field := structure.Fields.List[0]
	fieldType, typeOK := field.Type.(*ast.Ident)
	return len(field.Names) == 1 && field.Names[0].Name == "claimAllowed" &&
		typeOK && fieldType.Name == "bool" && field.Tag == nil
}

func isExactRoleConfigSelection(assignment *ast.AssignStmt) bool {
	if assignment.Tok != token.DEFINE || len(assignment.Lhs) != 2 || len(assignment.Rhs) != 1 {
		return false
	}
	expected, expectedOK := assignment.Lhs[0].(*ast.Ident)
	errName, errOK := assignment.Lhs[1].(*ast.Ident)
	call, callOK := assignment.Rhs[0].(*ast.CallExpr)
	if !expectedOK || !errOK || !callOK || expected.Name != "expected" || errName.Name != "err" ||
		len(call.Args) != 1 {
		return false
	}
	function, functionOK := call.Fun.(*ast.Ident)
	return functionOK && function.Name == "foundationRoleConfigJSON" &&
		claimAuthorityNodeMatches(call.Args[0], "bootstrap.Role")
}

func assignmentContainsName(assignment *ast.AssignStmt, expected string) bool {
	for _, target := range assignment.Lhs {
		identifier, ok := target.(*ast.Ident)
		if ok && identifier.Name == expected {
			return true
		}
	}
	return false
}

func renderClaimAuthorityNode(node ast.Node) (string, error) {
	var output bytes.Buffer
	if err := printer.Fprint(&output, token.NewFileSet(), node); err != nil {
		return "", err
	}
	return output.String(), nil
}

func isAuthorityToggleName(name string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(name, "_", ""))
	claimToggle := strings.Contains(normalized, "claim") &&
		(strings.Contains(normalized, "allow") || strings.Contains(normalized, "enable") ||
			strings.Contains(normalized, "permit"))
	executionToggle := strings.Contains(normalized, "execution") &&
		(strings.Contains(normalized, "allow") || strings.Contains(normalized, "enable") ||
			strings.Contains(normalized, "permit") || strings.Contains(normalized, "active"))
	return claimToggle || executionToggle
}

func isLocalRPCProductionFile(filename string) bool {
	return strings.HasPrefix(filename, "internal/localrpc/") && !strings.HasSuffix(filename, "_test.go")
}

func isExecutionAuthorityExpression(expression ast.Expr) bool {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name == "operationPolicy" || isAuthorityToggleName(typed.Name)
	case *ast.SelectorExpr:
		return typed.Sel.Name == "operationPolicy" || isAuthorityToggleName(typed.Sel.Name) ||
			isExecutionAuthorityExpression(typed.X)
	case *ast.StarExpr:
		return isExecutionAuthorityExpression(typed.X)
	case *ast.ParenExpr:
		return isExecutionAuthorityExpression(typed.X)
	case *ast.IndexExpr:
		return isExecutionAuthorityExpression(typed.X)
	case *ast.IndexListExpr:
		return isExecutionAuthorityExpression(typed.X)
	default:
		return false
	}
}

func isExecutionEnabledKey(expression ast.Expr) bool {
	switch typed := expression.(type) {
	case *ast.Ident:
		return strings.EqualFold(typed.Name, "executionEnabled")
	case *ast.BasicLit:
		if typed.Kind != token.STRING {
			return false
		}
		value, err := strconv.Unquote(typed.Value)
		return err == nil && strings.EqualFold(value, "executionEnabled")
	default:
		return false
	}
}

func isTrueIdentifier(expression ast.Expr) bool {
	identifier, ok := expression.(*ast.Ident)
	return ok && identifier.Name == "true"
}

func roleConfigEnablesExecution(value string) bool {
	compact := strings.Map(func(character rune) rune {
		if unicode.IsSpace(character) {
			return -1
		}
		return character
	}, value)
	return strings.Contains(compact, `"executionEnabled":true`)
}

func stringValueAt(values []ast.Expr, index int) (string, bool) {
	if len(values) != 1 && index >= len(values) || len(values) == 0 {
		return "", false
	}
	valueIndex := index
	if len(values) == 1 {
		valueIndex = 0
	}
	if valueIndex >= len(values) {
		return "", false
	}
	literal, ok := values[valueIndex].(*ast.BasicLit)
	if !ok || literal.Kind != token.STRING {
		return "", false
	}
	value, err := strconv.Unquote(literal.Value)
	return value, err == nil
}

func calledFunctionName(expression ast.Expr) string {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.SelectorExpr:
		return typed.Sel.Name
	default:
		return ""
	}
}

func claimAuthorityEnclosingFunction(node ast.Node, parents map[ast.Node]ast.Node) string {
	function := claimAuthorityEnclosingFunctionDeclaration(node, parents)
	if function == nil {
		return ""
	}
	return function.Name.Name
}

func claimAuthorityEnclosingFunctionDeclaration(
	node ast.Node,
	parents map[ast.Node]ast.Node,
) *ast.FuncDecl {
	for current := parents[node]; current != nil; current = parents[current] {
		if function, ok := current.(*ast.FuncDecl); ok {
			return function
		}
	}
	return nil
}

func claimAuthorityParents(root ast.Node) map[ast.Node]ast.Node {
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

func (scan *claimAuthorityScan) addProblem(
	filename string,
	fileSet *token.FileSet,
	node ast.Node,
	message string,
) {
	scan.problems = append(scan.problems, fmt.Sprintf(
		"%s:%d: %s",
		filename,
		fileSet.Position(node.Pos()).Line,
		message,
	))
}

func (scan *claimAuthorityScan) merge(other claimAuthorityScan) {
	scan.problems = append(scan.problems, other.problems...)
	scan.controlFoundationConfigs = append(scan.controlFoundationConfigs, other.controlFoundationConfigs...)
	scan.executorFoundationConfigs = append(scan.executorFoundationConfigs, other.executorFoundationConfigs...)
	scan.policyFields += other.policyFields
	scan.roleExecutionFields += other.roleExecutionFields
	scan.policyInitializers += other.policyInitializers
	scan.derivationCalls += other.derivationCalls
	scan.foundationSelectors += other.foundationSelectors
	scan.exactRoleConfigGuards += other.exactRoleConfigGuards
	scan.exactRoleConfigSelections += other.exactRoleConfigSelections
	scan.deriveConfigDeclarations += other.deriveConfigDeclarations
	scan.exactRoleConfigDecodes += other.exactRoleConfigDecodes
	scan.orderedCommitAuthorityChains += other.orderedCommitAuthorityChains
	scan.claimGates += other.claimGates
	scan.exactClaimDenialBodies += other.exactClaimDenialBodies
	scan.orderedServeAuthorityChains += other.orderedServeAuthorityChains
	scan.dispatchDefenseGates += other.dispatchDefenseGates
	scan.orderedDispatchDefenses += other.orderedDispatchDefenses
	scan.dispatcherClaimCalls += other.dispatcherClaimCalls
	scan.dispatchSafelyCalls += other.dispatchSafelyCalls
	scan.dispatchCalls += other.dispatchCalls
	scan.foundationSelectorCalls += other.foundationSelectorCalls
	scan.operationPolicyBindings += other.operationPolicyBindings
	scan.derivedPolicyAssignments += other.derivedPolicyAssignments
}

func claimAuthorityProblemContains(problems []string, expected string) bool {
	for _, problem := range problems {
		if strings.Contains(problem, expected) {
			return true
		}
	}
	return false
}
