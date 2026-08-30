package host

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

type recordingEmitter struct {
	events []any
}

func (e *recordingEmitter) Emit(event any) error {
	e.events = append(e.events, event)
	return nil
}

func TestOutputCollectorSharesSequenceAndAppliesCombinedLimit(t *testing.T) {
	emitter := &recordingEmitter{}
	collector := newOutputCollector("review-42", 5, emitter)
	collector.Drain("stdout", bytes.NewBufferString("abc"))
	collector.Drain("stderr", bytes.NewBufferString("defg"))
	truncated, err := collector.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Fatal("expected truncated output")
	}
	if len(emitter.events) != 3 {
		t.Fatalf("event count = %d, want 3", len(emitter.events))
	}

	stdout := emitter.events[0].(protocol.OutputEvent)
	stderr := emitter.events[1].(protocol.OutputEvent)
	truncation := emitter.events[2].(protocol.OutputTruncatedEvent)
	if stdout.Sequence != 0 || stderr.Sequence != 1 || truncation.Sequence != 2 {
		t.Fatalf("unexpected sequences: %d, %d, %d", stdout.Sequence, stderr.Sequence, truncation.Sequence)
	}
	if decoded, _ := base64.StdEncoding.DecodeString(stdout.DataBase64); string(decoded) != "abc" {
		t.Fatalf("stdout = %q", decoded)
	}
	if decoded, _ := base64.StdEncoding.DecodeString(stderr.DataBase64); string(decoded) != "de" {
		t.Fatalf("stderr = %q", decoded)
	}
	if truncation.Stream != "stderr" || truncation.DiscardedBytes != 2 {
		t.Fatalf("unexpected truncation: %+v", truncation)
	}
}
