package installstorev2lab

import (
	"fmt"
	"strconv"
	"strings"
)

const (
	walDirectoryName       = "wal-v2"
	migrationPrefix        = "migration-v2-"
	migrationSuffix        = ".tmp"
	entryFinalSuffix       = ".json"
	entryTemporarySuffix   = ".json.tmp"
	sequenceFilenameDigits = 20
)

func formatSequence20(sequence DecimalUint64) (string, error) {
	if !validV2Sequence(sequence) {
		return "", fmt.Errorf("%w: record sequence is invalid", ErrInvalid)
	}
	value, err := strconv.ParseUint(string(sequence), 10, 64)
	if err != nil {
		return "", fmt.Errorf("%w: record sequence is invalid", ErrInvalid)
	}
	digits := strconv.FormatUint(value, 10)
	if len(digits) > sequenceFilenameDigits {
		return "", fmt.Errorf("%w: record sequence exceeds the fixed filename", ErrInvalid)
	}
	return strings.Repeat("0", sequenceFilenameDigits-len(digits)) + digits, nil
}

func transactionDirectoryPath(transactionID TransactionID) (string, error) {
	if !validTransactionID(transactionID) {
		return "", fmt.Errorf("%w: transaction ID is invalid", ErrInvalid)
	}
	return TransactionsRootPath + `\` + string(transactionID), nil
}

func migrationStagingDirectoryPath(transactionID TransactionID) (string, error) {
	if !validTransactionID(transactionID) {
		return "", fmt.Errorf("%w: transaction ID is invalid", ErrInvalid)
	}
	return TransactionsRootPath + `\` + migrationPrefix + string(transactionID) + migrationSuffix, nil
}

func walEntryPath(transactionID TransactionID, sequence DecimalUint64, temporary bool) (string, error) {
	directory, err := transactionDirectoryPath(transactionID)
	if err != nil {
		return "", err
	}
	name, err := formatSequence20(sequence)
	if err != nil {
		return "", err
	}
	suffix := entryFinalSuffix
	if temporary {
		suffix = entryTemporarySuffix
	}
	return directory + `\` + walDirectoryName + `\` + name + suffix, nil
}

func migrationGenesisEntryPath(transactionID TransactionID, temporary bool) (string, error) {
	directory, err := migrationStagingDirectoryPath(transactionID)
	if err != nil {
		return "", err
	}
	suffix := entryFinalSuffix
	if temporary {
		suffix = entryTemporarySuffix
	}
	return directory + `\` + walDirectoryName + `\00000000000000000001` + suffix, nil
}
