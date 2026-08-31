//go:build windows

package winprocess

import (
	"crypto/rand"
	"errors"
	"fmt"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const standardIOConnectTimeout = 5 * time.Second

type preparedStandardIOPipeSecurity struct {
	descriptor *windows.SECURITY_DESCRIPTOR
	acl        *windows.ACL
	policy     daclPolicy
}

type windowsStdioConnectOperation struct {
	server              windows.Handle
	child               windows.Handle
	event               windows.Handle
	overlapped          windows.Overlapped
	pinner              runtime.Pinner
	pinned              bool
	submitted           bool
	completed           bool
	completionAttempted bool
	quarantined         bool
	cancelIO            standardIOCancelFunc
	closeHandle         standardIOCloseHandleFunc
	getResult           standardIOGetResultFunc
	waitForEvent        standardIOWaitFunc
	quarantine          *processLifetimeQuarantine
	serverTombstoned    bool
	childTombstoned     bool
	eventTombstoned     bool
}

func createStdioPipe(
	parentReads bool,
	name string,
	ownServiceSID string,
	closeTimeout time.Duration,
) (_ *windowsStandardIOStream, _ windows.Handle, resultErr error) {
	pipeName, err := generateStandardIOPipeName(rand.Reader)
	if err != nil {
		return nil, 0, err
	}
	security, err := prepareStandardIOPipeSecurity(ownServiceSID, parentReads)
	if err != nil {
		return nil, 0, err
	}
	encodedName, err := windows.UTF16PtrFromString(pipeName)
	if err != nil {
		return nil, 0, fmt.Errorf("encode standard-I/O pipe name: %w", err)
	}
	securityAttributes := &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: security.descriptor,
		InheritHandle:      0,
	}
	server, createServerErr := windows.CreateNamedPipe(
		encodedName,
		standardIOServerOpenMode(parentReads),
		standardIOServerPipeMode,
		standardIOMaximumInstances,
		standardIOPipeBufferBytes,
		standardIOPipeBufferBytes,
		0,
		securityAttributes,
	)
	runtime.KeepAlive(security)
	server, err = adoptWindowsHandleOutput(
		"standard-I/O named-pipe server",
		server,
		createServerErr,
		windowsProcessLifetimeQuarantine,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("create random standard-I/O named pipe: %w", err)
	}
	operation := &windowsStdioConnectOperation{
		server:     server,
		completed:  true,
		quarantine: windowsProcessLifetimeQuarantine,
	}
	keepHandles := false
	defer func() {
		if keepHandles {
			return
		}
		if operation.submitted && !operation.completed && !operation.completionAttempted {
			completed, completionErr := cancelAndCompleteStdioConnect(operation, standardIOConnectTimeout)
			operation.completed = completed
			resultErr = errors.Join(resultErr, completionErr)
		}
		if !operation.completed {
			operation.quarantined = true
			resultErr = errors.Join(resultErr, operation.quarantineOwner(operation, resultErr))
			return
		}
		resultErr = errors.Join(resultErr, cleanupStdioPipeCreation(operation))
		operation.unpin()
	}()

	if err := windows.SetHandleInformation(server, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			operation.serverTombstoned = true
			operation.completed = false
			operation.completionAttempted = true
		}
		return nil, 0, fmt.Errorf("make standard-I/O parent handle non-inheritable: %w", err)
	}
	if err := verifyKernelObjectDACL(server, security.policy); err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			operation.serverTombstoned = true
			operation.completed = false
			operation.completionAttempted = true
		}
		return nil, 0, fmt.Errorf("verify protected standard-I/O pipe DACL: %w", err)
	}

	event, createEventErr := windows.CreateEvent(nil, 1, 0, nil)
	event, err = adoptWindowsHandleOutput(
		"standard-I/O connect event",
		event,
		createEventErr,
		operation.quarantineValue(),
	)
	if err != nil {
		return nil, 0, fmt.Errorf("create standard-I/O connect event: %w", err)
	}
	operation.event = event
	operation.overlapped.HEvent = event
	operation.pinner.Pin(&operation.overlapped)
	operation.pinned = true
	operation.submitted = true
	operation.completed = false
	connectErr := windows.ConnectNamedPipe(server, &operation.overlapped)
	runtime.KeepAlive(operation)
	switch {
	case connectErr == nil:
		operation.completed = true
	case errors.Is(connectErr, windows.ERROR_IO_PENDING):
	case errors.Is(connectErr, windows.ERROR_PIPE_CONNECTED):
		operation.completed = true
	default:
		if errors.Is(connectErr, windows.ERROR_INVALID_HANDLE) {
			operation.serverTombstoned = true
			operation.completed = false
			operation.completionAttempted = true
			return nil, 0, fmt.Errorf("start standard-I/O named-pipe connection: %w", connectErr)
		}
		operation.completed = true
		return nil, 0, fmt.Errorf("start standard-I/O named-pipe connection: %w", connectErr)
	}

	childSecurity := &windows.SecurityAttributes{
		Length:        uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		InheritHandle: 1,
	}
	child, err := windows.CreateFile(
		encodedName,
		standardIOChildDesiredAccess(parentReads),
		0,
		childSecurity,
		windows.OPEN_EXISTING,
		standardIOChildOpenFlags,
		0,
	)
	if err := operation.acceptChildHandle(child, err); err != nil {
		return nil, 0, err
	}
	child = operation.child
	if err := windows.SetHandleInformation(
		child,
		windows.HANDLE_FLAG_INHERIT,
		windows.HANDLE_FLAG_INHERIT,
	); err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			invalidChild := operation.child
			operation.child = 0
			operation.childTombstoned = true
			return nil, 0, operation.quarantineOwner(
				&windowsRawHandleOwner{kind: "standard-I/O child handle", value: invalidChild},
				err,
			)
		}
		return nil, 0, fmt.Errorf("make standard-I/O child handle inheritable: %w", err)
	}

	if !operation.completed {
		waitForEvent := operation.waitForEvent
		if waitForEvent == nil {
			waitForEvent = windows.WaitForSingleObject
		}
		status, waitErr := waitForEvent(
			event,
			standardIODurationMilliseconds(standardIOConnectTimeout),
		)
		runtime.KeepAlive(operation)
		if waitErr != nil {
			operation.completionAttempted = true
			if errors.Is(waitErr, windows.ERROR_INVALID_HANDLE) {
				operation.eventTombstoned = true
			}
			return nil, 0, fmt.Errorf("wait for standard-I/O child connection: %w", waitErr)
		}
		if status != windows.WAIT_OBJECT_0 {
			if status != uint32(windows.WAIT_TIMEOUT) {
				operation.completionAttempted = true
				return nil, 0, fmt.Errorf("standard-I/O child connection wait returned 0x%x", status)
			}
			completed, completionErr := cancelAndCompleteStdioConnect(operation, standardIOConnectTimeout)
			operation.completed = completed
			return nil, 0, errors.Join(
				errors.New("standard-I/O child connection timed out"),
				completionErr,
			)
		}
		completed, completionErr := completeStdioConnect(operation)
		operation.completed = completed
		if completionErr != nil {
			return nil, 0, fmt.Errorf("complete standard-I/O child connection: %w", completionErr)
		}
	}

	closeHandle := operation.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	eventCloseErr := consumeWindowsHandle(
		"close standard-I/O connect event",
		operation.event,
		closeHandle,
		operation.quarantineValue(),
	)
	operation.event = 0
	if eventCloseErr != nil {
		return nil, 0, eventCloseErr
	}
	operation.unpin()
	parent := newWindowsStandardIOStream(server, name, parentReads, !parentReads, closeTimeout)
	operation.server = 0
	operation.child = 0
	keepHandles = true
	return parent, child, nil
}

func (operation *windowsStdioConnectOperation) unpin() {
	if operation != nil && operation.pinned {
		operation.pinner.Unpin()
		operation.pinned = false
	}
}

func (operation *windowsStdioConnectOperation) quarantineValue() *processLifetimeQuarantine {
	if operation != nil && operation.quarantine != nil {
		return operation.quarantine
	}
	return windowsProcessLifetimeQuarantine
}

func (operation *windowsStdioConnectOperation) quarantineOwner(owner any, cause error) error {
	return operation.quarantineValue().retain(owner, cause)
}

func (operation *windowsStdioConnectOperation) acceptChildHandle(handle windows.Handle, openErr error) error {
	if openErr != nil {
		if handle != 0 && handle != windows.InvalidHandle {
			outputErr := operation.quarantineOwner(
				&windowsRawHandleOwner{kind: "untrusted standard-I/O child handle", value: handle},
				errors.New("CreateFile failed after writing an untrusted child handle"),
			)
			return errors.Join(fmt.Errorf("open standard-I/O child pipe handle: %w", openErr), outputErr)
		}
		return fmt.Errorf("open standard-I/O child pipe handle: %w", openErr)
	}
	if handle == 0 || handle == windows.InvalidHandle {
		return errors.New("open standard-I/O child pipe returned an invalid handle without an error")
	}
	operation.child = handle
	return nil
}

func prepareStandardIOPipeSecurity(
	ownServiceSID string,
	parentReads bool,
) (preparedStandardIOPipeSecurity, error) {
	policy, err := standardIOPipeDACLPolicy(ownServiceSID, parentReads)
	if err != nil {
		return preparedStandardIOPipeSecurity{}, err
	}
	acl, err := buildACL(policy)
	if err != nil {
		return preparedStandardIOPipeSecurity{}, fmt.Errorf("build standard-I/O pipe DACL: %w", err)
	}
	descriptor, err := windows.NewSecurityDescriptor()
	if err != nil {
		return preparedStandardIOPipeSecurity{}, fmt.Errorf("create standard-I/O security descriptor: %w", err)
	}
	if err := descriptor.SetDACL(acl, true, false); err != nil {
		return preparedStandardIOPipeSecurity{}, fmt.Errorf("set standard-I/O security descriptor DACL: %w", err)
	}
	if err := descriptor.SetControl(windows.SE_DACL_PROTECTED, windows.SE_DACL_PROTECTED); err != nil {
		return preparedStandardIOPipeSecurity{}, fmt.Errorf("protect standard-I/O security descriptor DACL: %w", err)
	}
	return preparedStandardIOPipeSecurity{descriptor: descriptor, acl: acl, policy: policy}, nil
}

func cancelAndCompleteStdioConnect(
	operation *windowsStdioConnectOperation,
	timeout time.Duration,
) (bool, error) {
	cancelIO := operation.cancelIO
	if cancelIO == nil {
		cancelIO = windows.CancelIoEx
	}
	cancelErr := cancelIO(operation.server, &operation.overlapped)
	runtime.KeepAlive(operation)
	if errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE) {
		operation.completionAttempted = true
		operation.serverTombstoned = true
		return false, cancelErr
	}
	if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
		cancelErr = nil
	}
	waitForEvent := operation.waitForEvent
	if waitForEvent == nil {
		waitForEvent = windows.WaitForSingleObject
	}
	status, waitErr := waitForEvent(operation.event, standardIODurationMilliseconds(timeout))
	runtime.KeepAlive(operation)
	if waitErr != nil {
		operation.completionAttempted = true
		if errors.Is(waitErr, windows.ERROR_INVALID_HANDLE) {
			operation.eventTombstoned = true
		}
		return false, errors.Join(cancelErr, waitErr)
	}
	if status != windows.WAIT_OBJECT_0 {
		operation.completionAttempted = true
		if status == uint32(windows.WAIT_TIMEOUT) {
			return false, errors.Join(cancelErr, ErrStandardIOCloseTimeout)
		}
		return false, errors.Join(
			cancelErr,
			fmt.Errorf("wait for canceled standard-I/O connection returned 0x%x", status),
		)
	}
	completed, completionErr := completeStdioConnect(operation)
	if completed && errors.Is(completionErr, windows.ERROR_OPERATION_ABORTED) {
		completionErr = nil
	}
	return completed, errors.Join(cancelErr, completionErr)
}

func completeStdioConnect(operation *windowsStdioConnectOperation) (bool, error) {
	operation.completionAttempted = true
	var transferred uint32
	getResult := operation.getResult
	if getResult == nil {
		getResult = windows.GetOverlappedResult
	}
	err := getResult(
		operation.server,
		&operation.overlapped,
		&transferred,
		false,
	)
	runtime.KeepAlive(operation)
	completed, classifiedErr := classifyOverlappedCompletion(err)
	if errors.Is(classifiedErr, windows.ERROR_INVALID_HANDLE) {
		operation.serverTombstoned = true
	}
	return completed, classifiedErr
}

func cleanupStdioPipeCreation(operation *windowsStdioConnectOperation) error {
	if operation == nil {
		return nil
	}
	var result error
	closeHandle := operation.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	for _, resource := range []struct {
		label      string
		handle     *windows.Handle
		tombstoned bool
	}{
		{label: "close failed standard-I/O child handle", handle: &operation.child, tombstoned: operation.childTombstoned},
		{label: "close failed standard-I/O server handle", handle: &operation.server, tombstoned: operation.serverTombstoned},
		{label: "close failed standard-I/O connect event", handle: &operation.event, tombstoned: operation.eventTombstoned},
	} {
		if resource.tombstoned || *resource.handle == 0 || *resource.handle == windows.InvalidHandle {
			*resource.handle = 0
			continue
		}
		handle := *resource.handle
		closeErr := consumeWindowsHandle(
			resource.label,
			handle,
			closeHandle,
			operation.quarantineValue(),
		)
		*resource.handle = 0
		result = errors.Join(result, closeErr)
	}
	return result
}
