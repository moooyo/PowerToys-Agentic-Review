package hostcontrol

import (
	"bytes"
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/launchguard"
)

const testOwnServiceSID = "S-1-5-80-1-2-3-4-5"

func TestAcceptRequiresExactGuardedNodeWithoutBootstrapArgument(t *testing.T) {
	method := reflect.TypeOf((*Listener).Accept)
	wantContext := reflect.TypeOf((*context.Context)(nil)).Elem()
	wantNode := reflect.TypeOf((*launchguard.GuardedNodeProcess)(nil))
	if method.NumIn() != 3 || method.In(1) != wantContext || method.In(2) != wantNode {
		t.Fatalf("Listener.Accept signature = %v", method)
	}
}

func TestAcceptClaimsBeforeConnectionWorkAndRejectsClaimByNodeTermination(t *testing.T) {
	_, testFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve HostControl test source")
	}
	source, err := os.ReadFile(filepath.Join(filepath.Dir(testFile), "endpoint_windows.go"))
	if err != nil {
		t.Fatal(err)
	}
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "endpoint_windows.go", source, 0)
	if err != nil {
		t.Fatal(err)
	}
	var accept *ast.FuncDecl
	for _, declaration := range parsed.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Name.Name == "Accept" {
			accept = function
			break
		}
	}
	if accept == nil || accept.Body == nil {
		t.Fatal("Windows Listener.Accept declaration is unavailable")
	}
	positions := make(map[string][]token.Pos)
	claimRejectPositions := []token.Pos{}
	connectionRejectPositions := []token.Pos{}
	ast.Inspect(accept.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		name := ""
		switch function := call.Fun.(type) {
		case *ast.Ident:
			name = function.Name
		case *ast.SelectorExpr:
			name = function.Sel.Name
		}
		switch name {
		case "beginAccept", "ClaimHostControlLaunch", "finish", "rejectAcceptFailure", "acceptConnected", "completeRuntimeBootstrap", "rejectPostTransferAcceptFailure":
			positions[name] = append(positions[name], call.Pos())
		}
		if name == "rejectAcceptFailure" && len(call.Args) == 5 {
			first, firstOK := call.Args[0].(*ast.Ident)
			third, thirdOK := call.Args[2].(*ast.Ident)
			closer, closerOK := call.Args[4].(*ast.SelectorExpr)
			closerReceiver, receiverOK := closer.X.(*ast.Ident)
			if firstOK && first.Name == "nil" && thirdOK && closerOK && receiverOK &&
				closerReceiver.Name == "l" && closer.Sel.Name == "Close" {
				switch third.Name {
				case "node":
					claimRejectPositions = append(claimRejectPositions, call.Pos())
				case "claimedNode":
					connectionRejectPositions = append(connectionRejectPositions, call.Pos())
				}
			}
		}
		return true
	})
	for _, name := range []string{"beginAccept", "ClaimHostControlLaunch", "acceptConnected", "completeRuntimeBootstrap"} {
		if len(positions[name]) != 1 {
			t.Fatalf("Listener.Accept %s call count = %d, want 1", name, len(positions[name]))
		}
	}
	if len(positions["rejectAcceptFailure"]) != 7 || len(claimRejectPositions) != 6 ||
		len(connectionRejectPositions) != 1 {
		t.Fatalf(
			"Listener.Accept rejection calls = all:%d claim:%d connection:%d, want 7/6/1",
			len(positions["rejectAcceptFailure"]),
			len(claimRejectPositions),
			len(connectionRejectPositions),
		)
	}
	begin := positions["beginAccept"][0]
	claim := positions["ClaimHostControlLaunch"][0]
	acceptConnected := positions["acceptConnected"][0]
	connectionReject := connectionRejectPositions[0]
	bootstrap := positions["completeRuntimeBootstrap"][0]
	if len(positions["rejectPostTransferAcceptFailure"]) != 1 ||
		positions["rejectPostTransferAcceptFailure"][0] < bootstrap {
		t.Fatal("Listener.Accept no longer rejects post-transfer bootstrap failure through the Connection owner")
	}
	preClaimRejects := 0
	claimFailureRejects := []token.Pos{}
	for _, position := range claimRejectPositions {
		if position < claim {
			preClaimRejects++
		}
		if claim < position && position < acceptConnected {
			claimFailureRejects = append(claimFailureRejects, position)
		}
	}
	if preClaimRejects != 5 || len(claimFailureRejects) != 1 {
		t.Fatalf("Listener.Accept pre-claim/claim-failure rejections = %d/%d, want 5/1", preClaimRejects, len(claimFailureRejects))
	}
	claimReject := claimFailureRejects[0]
	finishBeforeReject := false
	finishBeforeConnectionReject := false
	for _, position := range positions["finish"] {
		finishBeforeReject = finishBeforeReject || claim < position && position < claimReject
		finishBeforeConnectionReject = finishBeforeConnectionReject ||
			acceptConnected < position && position < connectionReject
	}
	if !(begin < claim && claim < claimReject && claimReject < acceptConnected &&
		acceptConnected < connectionReject && connectionReject < bootstrap) || !finishBeforeReject ||
		!finishBeforeConnectionReject || len(positions["finish"]) != 2 {
		t.Fatal("Listener.Accept no longer claims before connection work or rejects claims through the exact Node owner")
	}
}

func TestGeneratePipeNameUsesExactly256RandomBits(t *testing.T) {
	random := bytes.Repeat([]byte{0xab}, pipeNonceBytes)
	name, err := generatePipeName(bytes.NewReader(random))
	if err != nil {
		t.Fatal(err)
	}
	want := pipeNamePrefix + strings.Repeat("ab", pipeNonceBytes)
	if name != want {
		t.Fatalf("pipe name = %q, want %q", name, want)
	}
	if _, err := generatePipeName(bytes.NewReader(random[:pipeNonceBytes-1])); err == nil {
		t.Fatal("generatePipeName accepted fewer than 256 random bits")
	}
	if _, err := generatePipeName(nil); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("nil random source error = %v, want ErrInvalidOptions", err)
	}
}

func TestHostControlDACLIsExactAndDocumentsPureNodeTradeoff(t *testing.T) {
	entries := expectedDACL(testOwnServiceSID)
	if len(entries) != 3 {
		t.Fatalf("DACL contains %d entries, want 3", len(entries))
	}
	if entries[0].SID != localSystemSID || entries[0].Mask != fileAllAccessMask ||
		entries[1].SID != builtinAdministratorsSID || entries[1].Mask != fileAllAccessMask ||
		entries[2].SID != testOwnServiceSID || entries[2].Mask != nodeDuplexAccessMask {
		t.Fatalf("unexpected HostControl DACL entries: %#v", entries)
	}
	if nodeDuplexAccessMask != fileGenericRead|fileGenericWrite {
		t.Fatalf("Node duplex mask = 0x%x, want FILE_GENERIC_READ | FILE_GENERIC_WRITE", nodeDuplexAccessMask)
	}
	// Pure Node net.connect opens a duplex Windows pipe with GENERIC_READ |
	// GENERIC_WRITE. FILE_GENERIC_WRITE unavoidably maps FILE_APPEND_DATA to
	// the FILE_CREATE_PIPE_INSTANCE bit; the per-launch single-instance design
	// prevents that right from becoming an alternate accepted server.
	if nodeDuplexAccessMask&fileAppendData == 0 {
		t.Fatal("pure Node compatible duplex mask unexpectedly omits FILE_APPEND_DATA")
	}
	if got := securityDescriptorString(testOwnServiceSID); !strings.Contains(got, "D:P") ||
		!strings.Contains(got, testOwnServiceSID) {
		t.Fatalf("security descriptor = %q, want protected exact service SID DACL", got)
	}
}

func TestValidateDACLRejectsAnyUnexpectedAccess(t *testing.T) {
	valid := daclEvidence{
		Control:   securityDescriptorDACLPresent | securityDescriptorDACLProtected,
		Present:   true,
		Protected: true,
		Entries:   expectedDACL(testOwnServiceSID),
	}
	if err := validateDACL(valid, testOwnServiceSID); err != nil {
		t.Fatalf("exact protected DACL rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*daclEvidence)
	}{
		{name: "unprotected", mutate: func(value *daclEvidence) { value.Protected = false }},
		{name: "missing", mutate: func(value *daclEvidence) { value.Present = false }},
		{name: "null", mutate: func(value *daclEvidence) { value.Null = true }},
		{name: "defaulted", mutate: func(value *daclEvidence) { value.Defaulted = true }},
		{name: "extra", mutate: func(value *daclEvidence) {
			value.Entries = append(value.Entries, accessEntry{SID: "S-1-1-0", Mask: fileAllAccessMask})
		}},
		{name: "duplicate", mutate: func(value *daclEvidence) { value.Entries[2].SID = localSystemSID }},
		{name: "write dac", mutate: func(value *daclEvidence) { value.Entries[2].Mask = fileAllAccessMask }},
		{name: "deny", mutate: func(value *daclEvidence) { value.Entries[2].ACEType = 1 }},
		{name: "inherited", mutate: func(value *daclEvidence) { value.Entries[2].Flags = 0x10 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := valid
			evidence.Entries = append([]accessEntry(nil), valid.Entries...)
			test.mutate(&evidence)
			if err := validateDACL(evidence, testOwnServiceSID); err == nil {
				t.Fatal("validateDACL unexpectedly succeeded")
			}
		})
	}
}

func TestOptionsRequireCanonicalServiceSIDAndBoundedTimeouts(t *testing.T) {
	valid := Options{
		OwnServiceSID:  testOwnServiceSID,
		ConnectTimeout: 30 * time.Second,
		IOTimeout:      time.Minute,
		CloseTimeout:   2 * time.Minute,
	}
	if err := validateOptions(valid); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
	tests := []Options{
		{OwnServiceSID: "S-1-5-18", ConnectTimeout: valid.ConnectTimeout, IOTimeout: valid.IOTimeout, CloseTimeout: valid.CloseTimeout},
		{OwnServiceSID: valid.OwnServiceSID, IOTimeout: valid.IOTimeout, CloseTimeout: valid.CloseTimeout},
		{OwnServiceSID: valid.OwnServiceSID, ConnectTimeout: valid.ConnectTimeout, CloseTimeout: valid.CloseTimeout},
		{OwnServiceSID: valid.OwnServiceSID, ConnectTimeout: valid.ConnectTimeout, IOTimeout: valid.IOTimeout},
		{OwnServiceSID: valid.OwnServiceSID, ConnectTimeout: maximumTimeout + time.Nanosecond, IOTimeout: valid.IOTimeout, CloseTimeout: valid.CloseTimeout},
	}
	for _, options := range tests {
		if err := validateOptions(options); !errors.Is(err, ErrInvalidOptions) {
			t.Fatalf("invalid options error = %v, want ErrInvalidOptions", err)
		}
	}
}
