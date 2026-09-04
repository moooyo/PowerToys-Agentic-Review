package workertransport

import (
	"errors"
	"strings"
	"testing"
)

func TestMarshalWorkerAuthReturnsTheOnlyCanonicalProfileEncoding(t *testing.T) {
	document, err := MarshalWorkerAuth("powertoys-node:01", testWorkerToken)
	if err != nil {
		t.Fatalf("MarshalWorkerAuth returned an error: %v", err)
	}
	want := `{"profileId":"agentic-review-worker-auth-v1","token":"` + testWorkerToken +
		`","workerNodeId":"powertoys-node:01"}`
	if string(document) != want {
		t.Fatalf("MarshalWorkerAuth produced %q, want %q", string(document), want)
	}
	if _, err := parseWorkerAuth(document); err != nil {
		t.Fatalf("MarshalWorkerAuth output failed strict parse: %v", err)
	}
}

func TestMarshalWorkerAuthRejectsInvalidInputsWithoutTokenDisclosure(t *testing.T) {
	if _, err := MarshalWorkerAuth("bad node", testWorkerToken); !errors.Is(err, ErrInvalidWorkerAuth) {
		t.Fatalf("MarshalWorkerAuth invalid node returned %v", err)
	}
	if _, err := MarshalWorkerAuth("powertoys-node:01", "arw1_secret"); !errors.Is(err, ErrInvalidWorkerAuth) {
		t.Fatalf("MarshalWorkerAuth invalid token returned %v", err)
	} else if strings.Contains(err.Error(), "arw1_secret") {
		t.Fatalf("MarshalWorkerAuth disclosed the Token: %v", err)
	}
}

