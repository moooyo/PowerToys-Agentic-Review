package installstorev2lab

import (
	"errors"
	"strings"
	"testing"
)

func TestSequenceAndFixedPathsAreDerivedWithoutCallerNames(t *testing.T) {
	tests := []struct {
		sequence DecimalUint64
		want     string
	}{
		{"1", "00000000000000000001"},
		{"42", "00000000000000000042"},
		{"4096", "00000000000000004096"},
	}
	for _, test := range tests {
		got, err := formatSequence20(test.sequence)
		if err != nil || got != test.want {
			t.Errorf("formatSequence20(%q) = (%q, %v), want %q", test.sequence, got, err, test.want)
		}
	}
	for _, invalid := range []DecimalUint64{"", "0", "01", "+1", "-1", "4097", "18446744073709551615", "18446744073709551616"} {
		if _, err := formatSequence20(invalid); err == nil {
			t.Errorf("formatSequence20 accepted %q", invalid)
		}
	}
	entry, err := walEntryPath(testTransactionID, "42", false)
	if err != nil || entry != TransactionsRootPath+`\123e4567-e89b-42d3-a456-426614174000\wal-v2\00000000000000000042.json` {
		t.Fatalf("walEntryPath = (%q, %v)", entry, err)
	}
	temporary, err := walEntryPath(testTransactionID, "42", true)
	if err != nil || temporary != entry+".tmp" {
		t.Fatalf("temporary walEntryPath = (%q, %v)", temporary, err)
	}
	staging, err := migrationGenesisEntryPath(testTransactionID, true)
	if err != nil || staging != TransactionsRootPath+`\migration-v2-123e4567-e89b-42d3-a456-426614174000.tmp\wal-v2\00000000000000000001.json.tmp` {
		t.Fatalf("migrationGenesisEntryPath = (%q, %v)", staging, err)
	}
	if _, err := walEntryPath("../escape", "1", false); err == nil {
		t.Fatal("path derivation accepted a caller-authored path component")
	}
}

func TestNamespaceBoundsAcceptExactCeilingsAndRejectTheNextValue(t *testing.T) {
	maximum := namespaceBounds{
		legacyTransactionDirectories:    MaximumLegacyTransactionDirectories,
		currentV2TransactionDirectories: MaximumCurrentV2TransactionDirectories,
		migrationStagingDirectories:     MaximumMigrationStagingDirectories,
		v2Entries:                       MaximumV2Entries,
		aggregateDocumentBytes:          MaximumAggregateDocumentBytes,
		retainedHandles:                 MaximumRetainedHandles,
		documentBuffers:                 MaximumDocumentBuffers,
		liveWorkingSetBytes:             MaximumLiveWorkingSetBytes,
		recoverySeconds:                 MaximumRecoverySeconds,
	}
	if err := validateNamespaceBounds(maximum); err != nil {
		t.Fatalf("exact maximum bounds rejected: %v", err)
	}
	mutations := []func(*namespaceBounds){
		func(value *namespaceBounds) { value.legacyTransactionDirectories++ },
		func(value *namespaceBounds) { value.currentV2TransactionDirectories++ },
		func(value *namespaceBounds) { value.migrationStagingDirectories++ },
		func(value *namespaceBounds) { value.v2Entries++ },
		func(value *namespaceBounds) { value.aggregateDocumentBytes++ },
		func(value *namespaceBounds) { value.retainedHandles++ },
		func(value *namespaceBounds) { value.documentBuffers++ },
		func(value *namespaceBounds) { value.liveWorkingSetBytes++ },
		func(value *namespaceBounds) { value.recoverySeconds++ },
	}
	for index, mutate := range mutations {
		value := maximum
		mutate(&value)
		if err := validateNamespaceBounds(value); !errors.Is(err, ErrLimit) {
			t.Errorf("overflow mutation %d error = %v, want ErrLimit", index, err)
		}
	}
	if MaximumAggregateDocumentBytes != 769*1024*1024 {
		t.Fatalf("aggregate byte limit = %d, want exact 769 MiB", MaximumAggregateDocumentBytes)
	}
}

func exactResidueObservation(schema expectedHeadSchema) residueObservation {
	return residueObservation{
		expectedSchema:              schema,
		authoritativeHeadValid:      true,
		selectedDocumentValid:       true,
		namespacePhysicalFactsExact: true,
	}
}

func TestRecoveryResidueShapesAreMutuallyExclusive(t *testing.T) {
	tests := []struct {
		name        string
		observation residueObservation
		want        recoveryResidueShape
	}{
		{"clean v1", exactResidueObservation(expectedHeadSchemaV1), recoveryResidueCleanV1},
		{"shape A empty", withResidue(exactResidueObservation(expectedHeadSchemaV1), entryResidueMigrationStagingEmpty, true), recoveryResidueA},
		{"shape A partial temporary", withResidue(exactResidueObservation(expectedHeadSchemaV1), entryResidueMigrationStagingEntryTemporary, true), recoveryResidueA},
		{"shape B partial temporary", withEntryTemporary(exactResidueObservation(expectedHeadSchemaV2)), recoveryResidueB},
		{"shape C existing successor", withFinalSuccessor(exactResidueObservation(expectedHeadSchemaV2), false), recoveryResidueC},
		{"shape C existing successor and head tmp", withFinalSuccessor(exactResidueObservation(expectedHeadSchemaV2), true), recoveryResidueC},
		{"shape C migration genesis", withMigrationGenesis(exactResidueObservation(expectedHeadSchemaV1), true), recoveryResidueC},
		{"shape D", exactResidueObservation(expectedHeadSchemaV2), recoveryResidueD},
		{"shape E v1", withHeadTemporary(exactResidueObservation(expectedHeadSchemaV1)), recoveryResidueE},
		{"shape E v2", withHeadTemporary(exactResidueObservation(expectedHeadSchemaV2)), recoveryResidueE},
		{"shape V", withV1RecordTemporary(exactResidueObservation(expectedHeadSchemaV1)), recoveryResidueV},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := classifyRecoveryResidue(test.observation); got != test.want {
				t.Fatalf("shape = %d, want %d", got, test.want)
			}
		})
	}

	invalid := []residueObservation{
		{},
		func() residueObservation {
			value := exactResidueObservation(expectedHeadSchemaV1)
			value.authoritativeHeadValid = false
			return value
		}(),
		func() residueObservation {
			value := withResidue(exactResidueObservation(expectedHeadSchemaV1), entryResidueMigrationStagingEntryTemporary, true)
			value.entryResidueCount = 2
			return value
		}(),
		func() residueObservation {
			value := withResidue(exactResidueObservation(expectedHeadSchemaV1), entryResidueMigrationStagingEntryTemporary, true)
			value.entryResidueCount = 256
			return value
		}(),
		func() residueObservation {
			value := withResidue(exactResidueObservation(expectedHeadSchemaV1), entryResidueMigrationStagingEntryTemporary, true)
			value.headTemporaryCount = 1
			return value
		}(),
		func() residueObservation {
			value := withEntryTemporary(exactResidueObservation(expectedHeadSchemaV2))
			value.entryTemporaryPhysicalExact = false
			return value
		}(),
		func() residueObservation {
			value := withEntryTemporary(exactResidueObservation(expectedHeadSchemaV1))
			return value
		}(),
		func() residueObservation {
			value := withFinalSuccessor(exactResidueObservation(expectedHeadSchemaV2), false)
			value.currentTailFinalSuccessorExact = false
			return value
		}(),
		func() residueObservation {
			value := withMigrationGenesis(exactResidueObservation(expectedHeadSchemaV2), false)
			return value
		}(),
		func() residueObservation {
			value := withV1RecordTemporary(exactResidueObservation(expectedHeadSchemaV1))
			value.headTemporaryCount = 1
			return value
		}(),
		func() residueObservation {
			value := withHeadTemporary(exactResidueObservation(expectedHeadSchemaV2))
			value.headTemporaryCount = 256
			return value
		}(),
		func() residueObservation {
			value := exactResidueObservation(expectedHeadSchemaV2)
			value.currentTailFinalSuccessorExact = true
			return value
		}(),
		func() residueObservation {
			value := withResidue(exactResidueObservation(expectedHeadSchemaV1), entryResidueMigrationStagingEntryTemporary, true)
			value.entryTemporaryPhysicalExact = true
			return value
		}(),
		func() residueObservation {
			value := withFinalSuccessor(exactResidueObservation(expectedHeadSchemaV2), false)
			value.migrationGenesisExact = true
			return value
		}(),
		func() residueObservation {
			value := withMigrationGenesis(exactResidueObservation(expectedHeadSchemaV1), false)
			value.currentTailFinalSuccessorExact = true
			return value
		}(),
	}
	for index, observation := range invalid {
		if got := classifyRecoveryResidue(observation); got != recoveryResidueUntrusted {
			t.Errorf("invalid observation %d classified as %d", index, got)
		}
	}
}

func TestShapeDAndEUseOnlyPersistedSchemaAndResidueFacts(t *testing.T) {
	v2 := exactResidueObservation(expectedHeadSchemaV2)
	if got := classifyRecoveryResidue(v2); got != recoveryResidueD {
		t.Fatalf("clean v2 shape = %d, want D", got)
	}
	v2.headTemporaryCount = 1
	if got := classifyRecoveryResidue(v2); got != recoveryResidueE {
		t.Fatalf("v2 head temporary shape = %d, want E", got)
	}
	v1 := exactResidueObservation(expectedHeadSchemaV1)
	if got := classifyRecoveryResidue(v1); got != recoveryResidueCleanV1 {
		t.Fatalf("clean v1 shape = %d, want clean", got)
	}
	v1.headTemporaryCount = 1
	if got := classifyRecoveryResidue(v1); got != recoveryResidueE {
		t.Fatalf("v1 head temporary shape = %d, want E", got)
	}
}

func TestMigrationCanonicalOrphanRenamesBackBeforeLeafCleanup(t *testing.T) {
	state := recoveryStateMigrationCanonicalGenesisWithHeadTemporary
	want := []recoveryOperation{
		recoveryOperationDeleteHeadTemporary,
		recoveryOperationFlushTransactionsAndReclassify,
		recoveryOperationFlushAndReopenMigrationCanonical,
		recoveryOperationRenameMigrationCanonicalBackToStaging,
		recoveryOperationFlushAndReopenRenamedStaging,
		recoveryOperationDeleteStagingFinalEntry,
		recoveryOperationFlushAndReopenStagingWAL,
		recoveryOperationDeleteStagingWALDirectory,
		recoveryOperationFlushAndReopenStagingDirectory,
		recoveryOperationDeleteStagingDirectory,
		recoveryOperationFlushTransactionsToCleanV1,
	}
	got := make([]recoveryOperation, 0, len(want))
	for steps := 0; steps < 32; steps++ {
		transition := nextRecoveryTransition(state)
		if transition.terminal {
			break
		}
		got = append(got, transition.operation)
		state = transition.next
	}
	if len(got) != len(want) {
		t.Fatalf("migration operation count = %d, want %d: %v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("migration operation %d = %d, want %d", index, got[index], want[index])
		}
	}
	for index, operation := range got {
		if operation == recoveryOperationDeleteStagingFinalEntry && index < 5 {
			t.Fatal("migration genesis was leaf-deleted before whole-directory rename-back")
		}
	}
}

func TestCrashTransitionModelsEveryAdmittedCleanupWithoutAuthority(t *testing.T) {
	tests := []struct {
		state recoveryCrashState
		first recoveryOperation
	}{
		{recoveryStateAuthoritativeV2, recoveryOperationReflushReopenAndDescribeV2Tail},
		{recoveryStateHeadTemporaryOnly, recoveryOperationDeleteHeadTemporary},
		{recoveryStateEntryTemporary, recoveryOperationDeleteEntryTemporary},
		{recoveryStateExistingFinalSuccessor, recoveryOperationDeleteExistingFinalSuccessor},
		{recoveryStateV1RecordTemporary, recoveryOperationDeleteV1RecordTemporary},
		{recoveryStateMigrationStagingEmpty, recoveryOperationDeleteStagingDirectory},
		{recoveryStateMigrationStagingWALEmpty, recoveryOperationDeleteStagingWALDirectory},
		{recoveryStateMigrationStagingEntryTemporary, recoveryOperationDeleteStagingEntryTemporary},
		{recoveryStateMigrationStagingEntryFinal, recoveryOperationDeleteStagingFinalEntry},
		{recoveryStateMigrationCanonicalGenesis, recoveryOperationFlushAndReopenMigrationCanonical},
	}
	for _, test := range tests {
		transition := nextRecoveryTransition(test.state)
		if transition.terminal || transition.operation != test.first {
			t.Errorf("state %d first transition = %+v, want operation %d", test.state, transition, test.first)
		}
	}
	invalid := nextRecoveryTransition(recoveryStateInvalid)
	if !invalid.terminal || invalid.operation != recoveryOperationNone {
		t.Fatalf("invalid state transition = %+v", invalid)
	}
}

func TestExistingFinalOrphanFlushesHeadCleanupBeforeLeafDelete(t *testing.T) {
	state := recoveryStateExistingFinalSuccessorWithHeadTemporary
	want := []recoveryOperation{
		recoveryOperationDeleteHeadTemporary,
		recoveryOperationFlushTransactionsAndReclassify,
		recoveryOperationDeleteExistingFinalSuccessor,
		recoveryOperationFlushWALAndReclassify,
	}
	for index, operation := range want {
		transition := nextRecoveryTransition(state)
		if transition.terminal || transition.operation != operation {
			t.Fatalf("step %d transition = %+v, want operation %d", index, transition, operation)
		}
		state = transition.next
	}
}

func withResidue(value residueObservation, kind entryResidueKind, exact bool) residueObservation {
	value.entryResidue = kind
	value.entryResidueCount = 1
	value.stagingPhysicalShapeExact = exact
	return value
}

func withEntryTemporary(value residueObservation) residueObservation {
	value.entryResidue = entryResidueCurrentTailEntryTemporary
	value.entryResidueCount = 1
	value.entryTemporaryPhysicalExact = true
	return value
}

func withFinalSuccessor(value residueObservation, headTemporary bool) residueObservation {
	value.entryResidue = entryResidueCurrentTailFinalSuccessor
	value.entryResidueCount = 1
	value.currentTailFinalSuccessorExact = true
	if headTemporary {
		value.headTemporaryCount = 1
	}
	return value
}

func withMigrationGenesis(value residueObservation, headTemporary bool) residueObservation {
	value.entryResidue = entryResidueMigrationCanonicalGenesis
	value.entryResidueCount = 1
	value.migrationGenesisExact = true
	if headTemporary {
		value.headTemporaryCount = 1
	}
	return value
}

func withHeadTemporary(value residueObservation) residueObservation {
	value.headTemporaryCount = 1
	return value
}

func withV1RecordTemporary(value residueObservation) residueObservation {
	value.entryResidue = entryResidueSelectedV1RecordTemporary
	value.entryResidueCount = 1
	value.selectedV1TemporaryPhysicalExact = true
	return value
}

func TestFixedPathsContainNoSecondHeadOrWriter(t *testing.T) {
	for _, value := range []string{TransactionsRootPath, WriterLockPath, ActiveHeadPath, ActiveHeadTemporaryPath} {
		if strings.Contains(value, "writer-v2") || strings.Contains(value, "active-head-v2") {
			t.Fatalf("fixed path creates a v2 ownership primitive: %s", value)
		}
	}
}
