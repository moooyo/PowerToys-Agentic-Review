package nodeenrollment

// Read is the only production entry point that may mint RecordEvidence. It accepts no caller
// selectors and withholds evidence unless the platform reader returns a fully validated state.
func Read() (RecordEvidence, error) {
	state, err := readRecordEvidenceState()
	if err != nil {
		return RecordEvidence{}, err
	}
	evidence := RecordEvidence{state: state}
	if err := evidence.Validate(); err != nil {
		return RecordEvidence{}, err
	}
	return evidence, nil
}
