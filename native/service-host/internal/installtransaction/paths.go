package installtransaction

import "fmt"

const (
	installationParent         = `C:\Program Files\AgenticReview`
	installationFinalName      = `Worker`
	trustedConfigurationParent = `C:\ProgramData\AgenticReview`
	trustedConfigurationName   = `TrustedConfig`
	packageMetadataParent      = `C:\ProgramData\AgenticReview\Packages`
)

// TransactionDirectoryPath derives the only v1 directory for a transaction.
func TransactionDirectoryPath(transactionID TransactionID) (string, error) {
	if !validTransactionID(transactionID) {
		return "", fmt.Errorf("%w: invalid transaction ID", ErrInvalid)
	}
	return TransactionsRoot + `\` + string(transactionID), nil
}

// TransactionRecordPath derives the only authoritative record path for a transaction.
func TransactionRecordPath(transactionID TransactionID) (string, error) {
	directory, err := TransactionDirectoryPath(transactionID)
	if err != nil {
		return "", err
	}
	return directory + `\` + TransactionRecordFileName, nil
}

// TransactionRecordTemporaryPath derives the only temporary record path for a transaction.
func TransactionRecordTemporaryPath(transactionID TransactionID) (string, error) {
	directory, err := TransactionDirectoryPath(transactionID)
	if err != nil {
		return "", err
	}
	return directory + `\` + TransactionTemporaryName, nil
}

// CandidateRootSlotPath derives one of the three inactive candidate paths.
func CandidateRootSlotPath(
	slot CandidateRootSlot,
	transactionID TransactionID,
	packageID PackageComponentID,
) (string, error) {
	switch slot {
	case SlotMetadataCandidate:
		return RootSlotPath(RootSlotMetadataCandidate, transactionID, packageID)
	case SlotInstallationCandidate:
		return RootSlotPath(RootSlotInstallationCandidate, transactionID, packageID)
	case SlotTrustedConfigurationCandidate:
		return RootSlotPath(RootSlotTrustedConfigurationCandidate, transactionID, packageID)
	default:
		return "", fmt.Errorf("%w: invalid candidate root slot", ErrInvalid)
	}
}

// RootSlotPath derives a fixed physical path without accepting a caller-authored path.
func RootSlotPath(
	slot RootSlot,
	transactionID TransactionID,
	packageID PackageComponentID,
) (string, error) {
	if !validTransactionID(transactionID) || !validPackageComponentID(string(packageID)) {
		return "", fmt.Errorf("%w: invalid root path binding", ErrInvalid)
	}
	suffix := string(transactionID)
	switch slot {
	case RootSlotMetadataFinal:
		return packageMetadataParent + `\` + string(packageID), nil
	case RootSlotMetadataCandidate:
		return packageMetadataParent + `\` + string(packageID) + `.candidate-` + suffix, nil
	case RootSlotInstallationFinal:
		return installationParent + `\` + installationFinalName, nil
	case RootSlotInstallationCandidate:
		return installationParent + `\` + installationFinalName + `.candidate-` + suffix, nil
	case RootSlotInstallationRollback:
		return installationParent + `\` + installationFinalName + `.rollback-` + suffix, nil
	case RootSlotInstallationInactive:
		return installationParent + `\` + installationFinalName + `.inactive-` + suffix, nil
	case RootSlotTrustedConfigurationFinal:
		return trustedConfigurationParent + `\` + trustedConfigurationName, nil
	case RootSlotTrustedConfigurationCandidate:
		return trustedConfigurationParent + `\` + trustedConfigurationName + `.candidate-` + suffix, nil
	case RootSlotTrustedConfigurationRollback:
		return trustedConfigurationParent + `\` + trustedConfigurationName + `.rollback-` + suffix, nil
	case RootSlotTrustedConfigurationInactive:
		return trustedConfigurationParent + `\` + trustedConfigurationName + `.inactive-` + suffix, nil
	default:
		return "", fmt.Errorf("%w: invalid root slot", ErrInvalid)
	}
}
