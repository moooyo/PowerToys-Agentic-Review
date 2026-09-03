package workertransport

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testWorkerToken = "arw1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func TestParseWorkerAuthAcceptsExactProfileWithoutRetainingSource(t *testing.T) {
	document := []byte(`{"profileId":"agentic-review-worker-auth-v1","token":"` + testWorkerToken +
		`","workerNodeId":"powertoys-node:01"}`)
	auth, err := parseWorkerAuth(document)
	if err != nil {
		t.Fatalf("ParseWorkerAuth returned an error: %v", err)
	}
	if auth.WorkerNodeID() != "powertoys-node:01" || string(auth.tokenBytes()) != testWorkerToken {
		t.Fatal("ParseWorkerAuth returned the wrong opaque profile")
	}

	for index := range document {
		document[index] = 'x'
	}
	if auth.WorkerNodeID() != "powertoys-node:01" || string(auth.tokenBytes()) != testWorkerToken {
		t.Fatal("WorkerAuth retained mutable source bytes")
	}
	for _, formatted := range []string{
		fmt.Sprintf("%v", auth),
		fmt.Sprintf("%+v", auth),
		fmt.Sprintf("%#v", auth),
		fmt.Sprintf("%s", auth),
		fmt.Sprintf("%q", auth),
		fmt.Sprintf("%x", auth),
		fmt.Sprintf("%d", auth),
		fmt.Sprintf("%#v", Config{WorkerAuth: auth}),
	} {
		if strings.Contains(formatted, testWorkerToken) || !strings.Contains(formatted, "redacted") {
			t.Fatalf("WorkerAuth formatting was not redacted: %s", formatted)
		}
	}
}

func TestParseWorkerAuthRejectsEveryProfileShapeAndTokenDeviationWithoutDisclosure(t *testing.T) {
	valid := `{"profileId":"agentic-review-worker-auth-v1","token":"` + testWorkerToken + `","workerNodeId":"powertoys-node:01"}`
	tests := []struct {
		name     string
		document string
	}{
		{name: "empty", document: ""},
		{name: "array", document: `[]`},
		{name: "missing member", document: `{"profileId":"agentic-review-worker-auth-v1","token":"` + testWorkerToken + `"}`},
		{name: "extra member", document: strings.TrimSuffix(valid, "}") + `,"extra":"value"}`},
		{name: "duplicate member", document: strings.TrimSuffix(valid, "}") + `,"token":"` + testWorkerToken + `"}`},
		{name: "wrong type", document: strings.Replace(valid, `"workerNodeId":"powertoys-node:01"`, `"workerNodeId":1`, 1)},
		{name: "wrong profile", document: strings.Replace(valid, WorkerAuthProfileID, "other", 1)},
		{name: "invalid node", document: strings.Replace(valid, "powertoys-node:01", "bad node", 1)},
		{name: "wrong prefix", document: strings.Replace(valid, "arw1_", "arw2_", 1)},
		{name: "short token", document: strings.Replace(valid, testWorkerToken, testWorkerToken[:len(testWorkerToken)-1], 1)},
		{name: "padded token", document: strings.Replace(valid, testWorkerToken, testWorkerToken+"=", 1)},
		{name: "invalid alphabet", document: strings.Replace(valid, testWorkerToken, "arw1_"+strings.Repeat("A", 42)+"+", 1)},
		{name: "alternate member order", document: `{"token":"` + testWorkerToken + `","profileId":"agentic-review-worker-auth-v1","workerNodeId":"powertoys-node:01"}`},
		{name: "insignificant whitespace", document: strings.Replace(valid, `{"profileId"`, `{ "profileId"`, 1)},
		{name: "escaped member", document: strings.Replace(valid, `"profileId"`, `"\u0070rofileId"`, 1)},
		{name: "escaped value", document: strings.Replace(valid, "powertoys-node:01", `powertoys-node\u003a01`, 1)},
		{name: "trailing whitespace", document: valid + " "},
		{name: "trailing JSON", document: valid + `{}`},
		{name: "BOM", document: "\ufeff" + valid},
		{name: "oversized", document: valid + strings.Repeat(" ", MaximumWorkerAuthDocumentBytes)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			auth, err := parseWorkerAuth([]byte(test.document))
			if !errors.Is(err, ErrInvalidWorkerAuth) || auth.WorkerNodeID() != "" {
				t.Fatalf("ParseWorkerAuth returned (%v, %v), want an invalid zero profile", auth, err)
			}
			if strings.Contains(err.Error(), testWorkerToken) || strings.Contains(err.Error(), "arw1_") {
				t.Fatalf("profile error disclosed credential material: %v", err)
			}
		})
	}
}

func TestLoadWorkerAuthFileUsesBoundedRegularFileAndRedactsFailures(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "worker-auth-v1.json")
	document := `{"profileId":"agentic-review-worker-auth-v1","token":"` + testWorkerToken + `","workerNodeId":"powertoys-node:01"}`
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	auth, err := loadWorkerAuthFile(path)
	if err != nil || auth.WorkerNodeID() != "powertoys-node:01" {
		t.Fatalf("loadWorkerAuthFile returned (%v, %v)", auth, err)
	}

	if _, err := loadWorkerAuthFile(directory); !errors.Is(err, ErrInvalidWorkerAuth) {
		t.Fatalf("directory profile returned %v", err)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(document, testWorkerToken, "arw1_secret", 1)), 0o600); err != nil {
		t.Fatalf("replace fixture: %v", err)
	}
	_, err = loadWorkerAuthFile(path)
	if !errors.Is(err, ErrInvalidWorkerAuth) {
		t.Fatalf("invalid profile returned %v", err)
	}
	if strings.Contains(err.Error(), "arw1_secret") {
		t.Fatalf("load error disclosed the Token: %v", err)
	}
}

func TestWorkerAuthProductionPathIsFixed(t *testing.T) {
	if WorkerAuthProfilePath != `C:\ProgramData\AgenticReview\Control\worker-auth-v1.json` {
		t.Fatalf("WorkerAuthProfilePath = %q", WorkerAuthProfilePath)
	}
}
