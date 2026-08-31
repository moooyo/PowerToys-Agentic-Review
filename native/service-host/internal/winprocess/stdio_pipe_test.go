package winprocess

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestStandardIOPipeNameUsesRandom256BitLeaf(t *testing.T) {
	name, err := generateStandardIOPipeName(bytes.NewReader(bytes.Repeat([]byte{0xab}, standardIOPipeNonceBytes)))
	if err != nil {
		t.Fatal(err)
	}
	want := standardIOPipeNamePrefix + strings.Repeat("ab", standardIOPipeNonceBytes)
	if name != want || !validStandardIOPipeName(name) {
		t.Fatalf("pipe name = %q, want %q", name, want)
	}
	if _, err := generateStandardIOPipeName(bytes.NewReader(make([]byte, standardIOPipeNonceBytes-1))); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short randomness error = %v", err)
	}
	if validStandardIOPipeName(standardIOPipeNamePrefix + strings.Repeat("g", standardIOPipeNonceHexLength)) {
		t.Fatal("pipe name accepted a non-hexadecimal leaf")
	}
}

func TestStandardIOPipeDirectionAndDACLContracts(t *testing.T) {
	readPolicy, err := standardIOPipeDACLPolicy(testOwnServiceSID, true)
	if err != nil {
		t.Fatal(err)
	}
	writePolicy, err := standardIOPipeDACLPolicy(testOwnServiceSID, false)
	if err != nil {
		t.Fatal(err)
	}
	wantReadPolicy := daclPolicy{entries: []daclEntry{
		{SID: localSystemSID, Mask: standardIOFileAllAccess, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: builtinAdministratorsSID, Mask: standardIOFileAllAccess, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: testOwnServiceSID, Mask: standardIOOwnPipeAccess, ACEType: accessAllowedACEType, Flags: noACEFlags},
	}}
	wantWritePolicy := wantReadPolicy
	wantWritePolicy.entries = append([]daclEntry(nil), wantReadPolicy.entries...)
	if !reflect.DeepEqual(readPolicy, wantReadPolicy) || !reflect.DeepEqual(writePolicy, wantWritePolicy) {
		t.Fatalf("pipe policies = (%#v, %#v)", readPolicy, writePolicy)
	}
	if standardIOChildDesiredAccess(true) != standardIOGenericWrite ||
		standardIOChildDesiredAccess(false) != standardIOGenericRead {
		t.Fatal("child access does not match the parent pipe direction")
	}
	for _, parentReads := range []bool{false, true} {
		mode := standardIOServerOpenMode(parentReads)
		if mode&standardIOFileFlagOverlapped == 0 || mode&standardIOFirstPipeInstance == 0 {
			t.Fatalf("server mode 0x%x lacks overlapped or first-instance protection", mode)
		}
	}
	if standardIOServerPipeMode != standardIORejectRemoteClients {
		t.Fatalf("server pipe mode = 0x%x", standardIOServerPipeMode)
	}
	if standardIOOwnPipeAccess != standardIOFileGenericRead|standardIOFileGenericWrite {
		t.Fatalf("own-service pipe access = 0x%x", standardIOOwnPipeAccess)
	}
	if standardIOOwnPipeAccess&standardIOFileAppendData == 0 {
		t.Fatal("test no longer documents the FILE_APPEND_DATA/FILE_CREATE_PIPE_INSTANCE alias")
	}
}
