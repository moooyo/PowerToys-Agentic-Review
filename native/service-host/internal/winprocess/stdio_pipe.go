package winprocess

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	standardIOPipeNamePrefix     = `\\.\pipe\AgenticReview.ServiceHost.StandardIO.v1.`
	standardIOPipeNonceBytes     = 32
	standardIOPipeNonceHexLength = standardIOPipeNonceBytes * 2
	standardIOPipeBufferBytes    = 64 * 1024

	standardIOPipeAccessInbound    uint32 = 0x00000001
	standardIOPipeAccessOutbound   uint32 = 0x00000002
	standardIOFileFlagOverlapped   uint32 = 0x40000000
	standardIOFirstPipeInstance    uint32 = 0x00080000
	standardIORejectRemoteClients  uint32 = 0x00000008
	standardIOPipeTypeByte         uint32 = 0x00000000
	standardIOPipeReadModeByte     uint32 = 0x00000000
	standardIOPipeWait             uint32 = 0x00000000
	standardIOReadControl          uint32 = 0x00020000
	standardIOSynchronize          uint32 = 0x00100000
	standardIOStandardRightsNeeded uint32 = 0x000F0000
	standardIOGenericRead          uint32 = 0x80000000
	standardIOGenericWrite         uint32 = 0x40000000
	standardIOChildOpenFlags       uint32 = 0x00000080
	standardIOMaximumInstances     uint32 = 1

	standardIOFileReadData       uint32 = 0x00000001
	standardIOFileWriteData      uint32 = 0x00000002
	standardIOFileAppendData     uint32 = 0x00000004
	standardIOFileReadEA         uint32 = 0x00000008
	standardIOFileWriteEA        uint32 = 0x00000010
	standardIOFileReadAttributes uint32 = 0x00000080
	standardIOFileWriteAttrs     uint32 = 0x00000100
)

const (
	standardIOFileGenericRead = standardIOReadControl |
		standardIOFileReadData |
		standardIOFileReadAttributes |
		standardIOFileReadEA |
		standardIOSynchronize
	standardIOFileGenericWrite = standardIOReadControl |
		standardIOFileWriteData |
		standardIOFileWriteAttrs |
		standardIOFileWriteEA |
		standardIOFileAppendData |
		standardIOSynchronize
	standardIOFileAllAccess = standardIOStandardRightsNeeded |
		standardIOSynchronize |
		0x000001FF
	standardIOOwnPipeAccess  = standardIOFileGenericRead | standardIOFileGenericWrite
	standardIOServerPipeMode = standardIOPipeTypeByte |
		standardIOPipeReadModeByte |
		standardIOPipeWait |
		standardIORejectRemoteClients
)

func generateStandardIOPipeName(random io.Reader) (string, error) {
	if random == nil {
		return "", errors.New("standard-I/O pipe randomness is required")
	}
	nonce := make([]byte, standardIOPipeNonceBytes)
	if _, err := io.ReadFull(random, nonce); err != nil {
		return "", fmt.Errorf("generate standard-I/O pipe name: %w", err)
	}
	return standardIOPipeNamePrefix + hex.EncodeToString(nonce), nil
}

func validStandardIOPipeName(name string) bool {
	if !strings.HasPrefix(name, standardIOPipeNamePrefix) {
		return false
	}
	nonce := strings.TrimPrefix(name, standardIOPipeNamePrefix)
	if len(nonce) != standardIOPipeNonceHexLength {
		return false
	}
	for _, character := range nonce {
		if character >= '0' && character <= '9' || character >= 'a' && character <= 'f' {
			continue
		}
		return false
	}
	return true
}

func standardIOServerOpenMode(parentReads bool) uint32 {
	direction := standardIOPipeAccessOutbound
	if parentReads {
		direction = standardIOPipeAccessInbound
	}
	return direction |
		standardIOFirstPipeInstance |
		standardIOFileFlagOverlapped |
		standardIOReadControl
}

func standardIOChildDesiredAccess(parentReads bool) uint32 {
	if parentReads {
		return standardIOGenericWrite
	}
	return standardIOGenericRead
}

func standardIOPipeDACLPolicy(ownServiceSID string, _ bool) (daclPolicy, error) {
	if err := validateCanonicalServiceSID(ownServiceSID); err != nil {
		return daclPolicy{}, fmt.Errorf("standard-I/O pipe service SID: %w", err)
	}
	return daclPolicy{entries: []daclEntry{
		{SID: localSystemSID, Mask: standardIOFileAllAccess, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: builtinAdministratorsSID, Mask: standardIOFileAllAccess, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: ownServiceSID, Mask: standardIOOwnPipeAccess, ACEType: accessAllowedACEType, Flags: noACEFlags},
	}}, nil
}
