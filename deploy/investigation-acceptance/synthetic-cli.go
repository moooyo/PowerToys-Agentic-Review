// Synthetic CLI protocol fixture. It never calls a model, Git, or a network API.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

type object = map[string]any

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--synthetic-child" {
		for { time.Sleep(time.Second) }
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Synthetic acceptance CLI failed:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("synthetic-investigation-acceptance-cli 1.0.0 (no model)")
		return nil
	}
	resultPath := ""
	for i := 1; i+1 < len(os.Args); i++ {
		if os.Args[i] == "--output-last-message" { resultPath = os.Args[i+1] }
	}
	if resultPath == "" { return fmt.Errorf("missing Codex-compatible result path") }
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 1024*1024))
	if err != nil { return err }
	start := []byte("<frozen_investigation_context>\n")
	end := []byte("\n</frozen_investigation_context>")
	first, last := bytes.Index(input, start), bytes.LastIndex(input, end)
	if first < 0 || last <= first { return fmt.Errorf("missing frozen context") }
	var envelope object
	if err := json.Unmarshal(input[first+len(start):last], &envelope); err != nil { return err }
	context, ok := envelope["turn"].(map[string]any)
	if !ok { return fmt.Errorf("missing native model-turn projection") }
	task := context["task"].(map[string]any)
	attempt := context["attempt"].(map[string]any)
	taskID, attemptID := task["id"].(string), attempt["id"].(string)
	round := int(context["round"].(float64))
	home := os.Getenv("CODEX_HOME")
	if home == "" { return fmt.Errorf("synthetic CODEX_HOME is required") }
	var template object
	if err := readJSON(filepath.Join(home, "template.json"), &template); err != nil { return err }
	var controls struct { HoldUnknownTasks bool `json:"holdUnknownTasks"`; Tasks map[string]struct { HoldAtRound int `json:"holdAtRound"`; AttemptNumber int `json:"attemptNumber"` } `json:"tasks"` }
	if err := readJSON(filepath.Join(home, "controls.json"), &controls); err != nil { return err }
	marker := filepath.Join(home, "observations", attemptID+"-round-"+strconv.Itoa(round)+".json")
	observation := object{"synthetic": true, "realModel": false, "pid": os.Getpid(), "taskId": taskID, "attemptId": attemptID, "attemptNumber": attempt["number"], "round": round, "phase": context["phase"], "startedAt": time.Now().UTC().Format(time.RFC3339Nano), "state": "started"}
	control, configured := controls.Tasks[taskID]
	if !configured && controls.HoldUnknownTasks { control.HoldAtRound = 2; control.AttemptNumber = 1 }
	if control.HoldAtRound > 0 && round >= control.HoldAtRound && int(attempt["number"].(float64)) == control.AttemptNumber {
		executable, err := os.Executable()
		if err != nil { return err }
		child := exec.Command(executable, "--synthetic-child")
		if err := child.Start(); err != nil { return err }
		observation["childPid"] = child.Process.Pid
		observation["state"] = "held"
		if err := writeJSON(marker, observation); err != nil { return err }
		// The production ProcessHost must terminate both owned processes on cancellation/shutdown.
		for { time.Sleep(time.Second) }
	}
	if err := writeJSON(marker, observation); err != nil { return err }
	analysis := object{"summary": nil, "assessment": nil}
	for _, key := range []string{"coverageUnits", "findings", "candidates", "rechecks", "evidence", "plans", "nextActions", "feedbackDrafts", "diagnostics", "limitations", "removedFindingIds"} { analysis[key] = []any{} }
	projected := context["analysis"].(map[string]any)
	phase := context["phase"].(string)
	if round == 1 {
		for _, key := range []string{"summary", "assessment", "findings", "candidates", "evidence", "plans", "nextActions", "feedbackDrafts", "limitations"} { analysis[key] = template[key] }
	}
	units := projected["coverageUnits"].([]any)
	for _, raw := range units {
		unit := raw.(map[string]any)
		unit["status"] = "completed"
		unit["evidenceRefs"] = []any{template["snapshotEvidenceId"]}
	}
	analysis["coverageUnits"] = units
	if phase == "recheck" {
		checks := []any{}
		findings := []any{}
		candidates := []any{}
		for _, raw := range projected["findings"].([]any) {
			finding := raw.(map[string]any)
			confirmation := finding["confirmation"].(map[string]any)
			if confirmation["recheckRef"] != nil { continue }
			finding["version"] = finding["version"].(float64) + 1
			confirmation["recheckRef"] = "synthetic-recheck-" + finding["id"].(string)
			findings = append(findings, finding)
			for _, rawCandidate := range projected["candidates"].([]any) {
				candidate := rawCandidate.(map[string]any)
				if candidate["findingId"] == finding["id"] { candidate["findingVersion"] = finding["version"]; candidates = append(candidates, candidate) }
			}
			checks = append(checks, object{"id": confirmation["recheckRef"], "findingId": finding["id"], "findingVersion": finding["version"], "subjectRef": finding["subjectRef"], "round": round, "evidenceRefs": finding["evidenceRefs"], "conclusion": "Synthetic protocol recheck retains this reporter hypothesis; no real defect or runtime reproduction is established.", "unresolvedQuestions": []any{"A real investigation must establish the actual behavior."}})
		}
		analysis["rechecks"] = checks
		analysis["findings"] = findings
		analysis["candidates"] = candidates
	}
	final := phase == "finalize"
	if final { analysis["summary"] = "Synthetic lifecycle acceptance retained and rechecked every fixture finding. No model or upstream repository was contacted." }
	delta := object{"schemaVersion": "InvestigationModelTurnDeltaV1", "taskId": taskID, "attemptId": attemptID, "inputCheckpointRef": context["inputCheckpointRef"], "round": round, "phase": phase, "analysis": analysis, "continue": !final, "continuationReason": "Synthetic protocol fixture follows the production projection and complete-ledger guard."}
	if err := writeJSON(resultPath, delta); err != nil { return err }
	fmt.Println(`{"type":"turn.started"}`)
	fmt.Println(`{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":100}}`)
	observation["state"] = "completed"
	observation["finishedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	return writeJSON(marker, observation)
}

func readJSON(path string, value any) error {
	content, err := os.ReadFile(path)
	if err != nil { return err }
	return json.Unmarshal(content, value)
}

func writeJSON(path string, value any) error {
	content, err := json.Marshal(value)
	if err != nil { return err }
	return os.WriteFile(path, content, 0600)
}
