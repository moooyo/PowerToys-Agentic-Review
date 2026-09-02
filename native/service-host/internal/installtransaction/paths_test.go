package installtransaction

import (
	"errors"
	"testing"
)

func TestFixedJournalAndTransactionPaths(t *testing.T) {
	if InstallerRoot != `C:\ProgramData\AgenticReview\Installer` ||
		TransactionsRoot != `C:\ProgramData\AgenticReview\Installer\Transactions` ||
		WriterLockPath != `C:\ProgramData\AgenticReview\Installer\Transactions\writer-v1.lock` ||
		ActiveHeadPath != `C:\ProgramData\AgenticReview\Installer\Transactions\active-head-v1.json` ||
		ActiveHeadTemporaryPath != `C:\ProgramData\AgenticReview\Installer\Transactions\active-head-v1.json.tmp` {
		t.Fatal("fixed journal namespace changed")
	}
	directory, err := TransactionDirectoryPath(testTransactionID)
	if err != nil || directory != `C:\ProgramData\AgenticReview\Installer\Transactions\123e4567-e89b-42d3-a456-426614174000` {
		t.Fatalf("TransactionDirectoryPath = (%q, %v)", directory, err)
	}
	record, err := TransactionRecordPath(testTransactionID)
	if err != nil || record != directory+`\record-v1.json` {
		t.Fatalf("TransactionRecordPath = (%q, %v)", record, err)
	}
	temporary, err := TransactionRecordTemporaryPath(testTransactionID)
	if err != nil || temporary != directory+`\record-v1.json.tmp` {
		t.Fatalf("TransactionRecordTemporaryPath = (%q, %v)", temporary, err)
	}
}

func TestRootSlotPathDerivesAllTenClosedSlots(t *testing.T) {
	packageID := PackageComponentID("worker-package-next")
	tests := []struct {
		slot RootSlot
		want string
	}{
		{RootSlotMetadataFinal, `C:\ProgramData\AgenticReview\Packages\worker-package-next`},
		{RootSlotMetadataCandidate, `C:\ProgramData\AgenticReview\Packages\worker-package-next.candidate-123e4567-e89b-42d3-a456-426614174000`},
		{RootSlotInstallationFinal, `C:\Program Files\AgenticReview\Worker`},
		{RootSlotInstallationCandidate, `C:\Program Files\AgenticReview\Worker.candidate-123e4567-e89b-42d3-a456-426614174000`},
		{RootSlotInstallationRollback, `C:\Program Files\AgenticReview\Worker.rollback-123e4567-e89b-42d3-a456-426614174000`},
		{RootSlotInstallationInactive, `C:\Program Files\AgenticReview\Worker.inactive-123e4567-e89b-42d3-a456-426614174000`},
		{RootSlotTrustedConfigurationFinal, `C:\ProgramData\AgenticReview\TrustedConfig`},
		{RootSlotTrustedConfigurationCandidate, `C:\ProgramData\AgenticReview\TrustedConfig.candidate-123e4567-e89b-42d3-a456-426614174000`},
		{RootSlotTrustedConfigurationRollback, `C:\ProgramData\AgenticReview\TrustedConfig.rollback-123e4567-e89b-42d3-a456-426614174000`},
		{RootSlotTrustedConfigurationInactive, `C:\ProgramData\AgenticReview\TrustedConfig.inactive-123e4567-e89b-42d3-a456-426614174000`},
	}
	for _, test := range tests {
		got, err := RootSlotPath(test.slot, testTransactionID, packageID)
		if err != nil || got != test.want {
			t.Errorf("RootSlotPath(%q) = (%q, %v), want %q", test.slot, got, err, test.want)
		}
	}
}

func TestCandidateRootSlotPathDerivesOnlyThreeCandidateSlots(t *testing.T) {
	packageID := PackageComponentID("worker-package-next")
	tests := []struct {
		slot CandidateRootSlot
		root RootSlot
	}{
		{SlotMetadataCandidate, RootSlotMetadataCandidate},
		{SlotInstallationCandidate, RootSlotInstallationCandidate},
		{SlotTrustedConfigurationCandidate, RootSlotTrustedConfigurationCandidate},
	}
	for _, test := range tests {
		got, err := CandidateRootSlotPath(test.slot, testTransactionID, packageID)
		want, wantErr := RootSlotPath(test.root, testTransactionID, packageID)
		if err != nil || wantErr != nil || got != want {
			t.Errorf("CandidateRootSlotPath(%q) = (%q, %v), want (%q, %v)", test.slot, got, err, want, wantErr)
		}
	}
}

func TestPathDerivationRejectsCallerSelectedValues(t *testing.T) {
	for _, transactionID := range []TransactionID{
		"", "123e4567-e89b-12d3-a456-426614174000", "123E4567-E89B-42D3-A456-426614174000",
	} {
		if _, err := TransactionDirectoryPath(transactionID); !errors.Is(err, ErrInvalid) {
			t.Errorf("TransactionDirectoryPath(%q) returned %v", transactionID, err)
		}
	}
	if _, err := RootSlotPath("other", testTransactionID, "worker-package-next"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("RootSlotPath accepted an unknown slot: %v", err)
	}
	if _, err := CandidateRootSlotPath("installation-final", testTransactionID, "worker-package-next"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("CandidateRootSlotPath accepted a final slot: %v", err)
	}
	if _, err := RootSlotPath(RootSlotInstallationFinal, testTransactionID, "CON"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("RootSlotPath accepted an unsafe package ID: %v", err)
	}
}
