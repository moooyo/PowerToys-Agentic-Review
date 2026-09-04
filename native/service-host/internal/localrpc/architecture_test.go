package localrpc

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaimAuthorityHasOneDerivationAndTwoEnforcementGates(t *testing.T) {
	files := parseLocalRPCProductionFiles(t)
	initializers := 0
	selectors := 0
	for path, file := range files {
		ast.Inspect(file, func(node ast.Node) bool {
			switch value := node.(type) {
			case *ast.KeyValueExpr:
				key, ok := value.Key.(*ast.Ident)
				if ok && key.Name == "claimAllowed" {
					initializers++
					if path != "runtime_bootstrap_exchange.go" ||
						!claimAuthorityInitializer(value.Value) {
						t.Fatalf("unexpected claimAllowed initializer in %s", path)
					}
				}
			case *ast.SelectorExpr:
				if value.Sel.Name == "claimAllowed" {
					selectors++
					if path != "server.go" {
						t.Fatalf("claimAllowed is consumed outside server.go in %s", path)
					}
				}
			}
			return true
		})
	}
	if initializers != 1 || selectors != 2 {
		t.Fatalf("claimAllowed initializer/consumer counts = %d/%d, want 1/2", initializers, selectors)
	}

	server := readLocalRPCSource(t, "server.go")
	for _, gate := range []string{
		"call.Operation == OperationClaim && !s.operationPolicy.claimAllowed",
		"request.Operation == OperationClaim && !s.operationPolicy.claimAllowed",
	} {
		if strings.Count(server, gate) != 1 {
			t.Fatalf("server Claim gate %q count is not one", gate)
		}
	}
}

func TestLocalRPCProductionHasNoLocalSigningSurface(t *testing.T) {
	for path := range parseLocalRPCProductionFiles(t) {
		source := readLocalRPCSource(t, path)
		for _, retired := range []string{
			"SignLocalDigest",
			"LocalAuthority",
			"localAuthority",
			"foundationPublicKey",
			"signatureP1363",
		} {
			if strings.Contains(source, retired) {
				t.Fatalf("production file %s retains retired local-signing symbol %q", path, retired)
			}
		}
	}
}

func claimAuthorityInitializer(expression ast.Expr) bool {
	outer, ok := expression.(*ast.BinaryExpr)
	if !ok || outer.Op != token.LAND {
		return false
	}
	roleComparison, ok := outer.X.(*ast.BinaryExpr)
	if !ok || roleComparison.Op != token.EQL {
		return false
	}
	left, leftOK := roleComparison.X.(*ast.SelectorExpr)
	right, rightOK := roleComparison.Y.(*ast.Ident)
	policy, policyOK := outer.Y.(*ast.SelectorExpr)
	return leftOK && rightOK && policyOK &&
		selectorNames(left, "bootstrap", "Role") && right.Name == "RoleControl" &&
		selectorNames(policy, "config", "ExecutionEnabled")
}

func selectorNames(selector *ast.SelectorExpr, owner, field string) bool {
	identifier, ok := selector.X.(*ast.Ident)
	return ok && identifier.Name == owner && selector.Sel.Name == field
}

func parseLocalRPCProductionFiles(t *testing.T) map[string]*ast.File {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	result := make(map[string]*ast.File)
	fileSet := token.NewFileSet()
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fileSet, name, nil, parser.AllErrors)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		result[name] = parsed
	}
	return result
}

func readLocalRPCSource(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Clean(name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
