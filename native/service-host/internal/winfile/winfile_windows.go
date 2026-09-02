//go:build windows

package winfile

import (
	"errors"
	"fmt"
	"io"
	"sync"

	"golang.org/x/sys/windows"
)

// File owns a Windows file handle opened without write or delete sharing.
type File struct {
	mu          sync.Mutex
	handle      windows.Handle
	closeHandle func(windows.Handle) error
	baseline    objectSnapshot
	auxiliary   objectAuxiliarySnapshot
	evidence    Evidence
	closed      bool
}

// Directory owns a Windows directory handle opened without delete sharing.
type Directory struct {
	mu                 sync.Mutex
	handle             windows.Handle
	closeHandle        func(windows.Handle) error
	baseline           objectSnapshot
	auxiliary          objectAuxiliarySnapshot
	evidence           Evidence
	enumerationAllowed bool
	closed             bool
}

type openedObject struct {
	handle             windows.Handle
	baseline           objectSnapshot
	auxiliary          objectAuxiliarySnapshot
	evidence           Evidence
	enumerationAllowed bool
}

// OpenFile opens and validates a regular, single-link file. The returned handle
// remains open so later reads stay bound to the validated object identity.
func OpenFile(path string, options OpenOptions) (*File, error) {
	opened, err := openObject(path, ObjectKindFile, options)
	if err != nil {
		return nil, err
	}
	return &File{
		handle:    opened.handle,
		baseline:  opened.baseline,
		auxiliary: opened.auxiliary,
		evidence:  opened.evidence,
	}, nil
}

// OpenDirectory opens and validates a directory. Only its terminal path
// component is proven reparse-free; inspect Evidence.Path.Ancestors before use.
func OpenDirectory(path string, options OpenOptions) (*Directory, error) {
	opened, err := openObject(path, ObjectKindDirectory, options)
	if err != nil {
		return nil, err
	}
	return &Directory{
		handle:             opened.handle,
		baseline:           opened.baseline,
		auxiliary:          opened.auxiliary,
		evidence:           opened.evidence,
		enumerationAllowed: opened.enumerationAllowed,
	}, nil
}

// ReadFile performs a complete bounded read and closes the validated handle.
func ReadFile(path string, options ReadOptions) (ReadResult, error) {
	if err := validateReadOptions(options); err != nil {
		return ReadResult{}, err
	}
	file, err := OpenFile(path, OpenOptions{VolumeUse: options.VolumeUse})
	if err != nil {
		return ReadResult{}, err
	}
	data, readErr := file.ReadAll(options.MaximumBytes)
	evidence := file.Evidence()
	closeErr := closeDiscardedObject("close validated file handle", file)
	if readErr != nil || closeErr != nil {
		return ReadResult{}, errors.Join(readErr, closeErr)
	}
	return ReadResult{Data: data, Evidence: evidence}, nil
}

// InspectDirectory captures handle-bound evidence and then closes the handle.
func InspectDirectory(path string, options OpenOptions) (Evidence, error) {
	directory, err := OpenDirectory(path, options)
	if err != nil {
		return Evidence{}, err
	}
	evidence := directory.Evidence()
	if err := closeDiscardedObject("close inspected directory", directory); err != nil {
		return Evidence{}, err
	}
	return evidence, nil
}

// Evidence returns a detached copy of the facts captured for the file handle.
func (file *File) Evidence() Evidence {
	if file == nil {
		return Evidence{}
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	return cloneEvidence(file.evidence)
}

// Evidence returns a detached copy of the facts captured for the directory handle.
func (directory *Directory) Evidence() Evidence {
	if directory == nil {
		return Evidence{}
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	return cloneEvidence(directory.evidence)
}

// ReadAll reads from offset zero, enforces the supplied limit, and verifies
// identity and stable metadata before and after the read.
func (file *File) ReadAll(maximumBytes uint64) ([]byte, error) {
	if file == nil {
		return nil, ErrClosed
	}
	if maximumBytes == 0 || maximumBytes > maximumReadableBytes() {
		return nil, fmt.Errorf("%w: maximum bytes is outside the supported range", ErrInvalidOptions)
	}

	file.mu.Lock()
	defer file.mu.Unlock()
	if file.closed || file.handle == 0 {
		return nil, ErrClosed
	}

	before, err := querySnapshot(file.handle, ObjectKindFile)
	if err != nil {
		return nil, fmt.Errorf("inspect file before read: %w", err)
	}
	if err := compareSnapshots(file.baseline, before); err != nil {
		return nil, fmt.Errorf("verify file before read: %w", err)
	}
	beforeAuxiliary, err := queryObjectAuxiliarySnapshot(file.handle, ObjectKindFile, uint64(before.standard.EndOfFile))
	if err != nil {
		return nil, fmt.Errorf("inspect file streams before read: %w", err)
	}
	if err := compareObjectAuxiliarySnapshots(file.auxiliary, beforeAuxiliary); err != nil {
		return nil, fmt.Errorf("verify file streams before read: %w", err)
	}
	if uint64(before.standard.EndOfFile) > maximumBytes {
		return nil, fmt.Errorf("%w: observed %d bytes", ErrTooLarge, before.standard.EndOfFile)
	}
	if _, err := windows.SetFilePointer(file.handle, 0, nil, windows.FILE_BEGIN); err != nil {
		return nil, fmt.Errorf("rewind file handle: %w", err)
	}

	data, readErr := readBounded(handleReader{handle: file.handle}, maximumBytes)
	after, inspectErr := querySnapshot(file.handle, ObjectKindFile)
	if inspectErr != nil {
		inspectErr = fmt.Errorf("inspect file after read: %w", inspectErr)
	}
	var afterAuxiliary objectAuxiliarySnapshot
	var auxiliaryErr error
	if inspectErr == nil {
		afterAuxiliary, auxiliaryErr = queryObjectAuxiliarySnapshot(file.handle, ObjectKindFile, uint64(after.standard.EndOfFile))
		if auxiliaryErr != nil {
			auxiliaryErr = fmt.Errorf("inspect file streams after read: %w", auxiliaryErr)
		}
	}
	if readErr != nil || inspectErr != nil || auxiliaryErr != nil {
		return nil, errors.Join(wrapReadError(readErr), inspectErr, auxiliaryErr)
	}
	if err := compareSnapshots(before, after); err != nil {
		return nil, fmt.Errorf("verify stable file read: %w", err)
	}
	if err := compareObjectAuxiliarySnapshots(beforeAuxiliary, afterAuxiliary); err != nil {
		return nil, fmt.Errorf("verify stable file streams during read: %w", err)
	}
	if uint64(len(data)) != uint64(after.standard.EndOfFile) {
		return nil, fmt.Errorf(
			"%w: read %d bytes but stable metadata reports %d",
			ErrObjectChanged,
			len(data),
			after.standard.EndOfFile,
		)
	}
	return data, nil
}

// ReadAt implements a stable retained-handle ReaderAt without exposing the native handle. Every
// call verifies the file identity, metadata, and stream set before and after reading.
func (file *File) ReadAt(buffer []byte, offset int64) (int, error) {
	if file == nil {
		return 0, ErrClosed
	}
	if offset < 0 {
		return 0, fmt.Errorf("%w: negative read offset", ErrInvalidOptions)
	}
	if len(buffer) == 0 {
		return 0, nil
	}
	const maximumOffset = int64(^uint64(0) >> 1)
	if uint64(len(buffer)) > uint64(maximumOffset-offset) {
		return 0, fmt.Errorf("%w: positional read range overflows", ErrInvalidOptions)
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.closed || file.handle == 0 {
		return 0, ErrClosed
	}
	before, err := querySnapshot(file.handle, ObjectKindFile)
	if err != nil {
		return 0, fmt.Errorf("inspect file before positional read: %w", err)
	}
	if err := compareSnapshots(file.baseline, before); err != nil {
		return 0, fmt.Errorf("verify file before positional read: %w", err)
	}
	beforeAuxiliary, err := queryObjectAuxiliarySnapshot(
		file.handle,
		ObjectKindFile,
		uint64(before.standard.EndOfFile),
	)
	if err != nil {
		return 0, fmt.Errorf("inspect file streams before positional read: %w", err)
	}
	if err := compareObjectAuxiliarySnapshots(file.auxiliary, beforeAuxiliary); err != nil {
		return 0, fmt.Errorf("verify file streams before positional read: %w", err)
	}
	highOffset := int32(uint32(uint64(offset) >> 32))
	if _, err := windows.SetFilePointer(
		file.handle,
		int32(uint32(uint64(offset))),
		&highOffset,
		windows.FILE_BEGIN,
	); err != nil {
		return 0, fmt.Errorf("seek retained file handle: %w", err)
	}
	read := 0
	var readErr error
	for read < len(buffer) {
		chunk := buffer[read:]
		if len(chunk) > streamingHashBufferBytes {
			chunk = chunk[:streamingHashBufferBytes]
		}
		var count uint32
		err := windows.ReadFile(file.handle, chunk, &count, nil)
		if count > uint32(len(chunk)) {
			readErr = errors.New("positional read returned an invalid byte count")
			break
		}
		read += int(count)
		if errors.Is(err, windows.ERROR_HANDLE_EOF) || err == nil && count == 0 {
			readErr = io.EOF
			break
		}
		if err != nil {
			readErr = err
			break
		}
	}
	after, inspectErr := querySnapshot(file.handle, ObjectKindFile)
	if inspectErr == nil {
		inspectErr = compareSnapshots(before, after)
	}
	var afterAuxiliary objectAuxiliarySnapshot
	var auxiliaryErr error
	if inspectErr == nil {
		afterAuxiliary, auxiliaryErr = queryObjectAuxiliarySnapshot(
			file.handle,
			ObjectKindFile,
			uint64(after.standard.EndOfFile),
		)
		if auxiliaryErr == nil {
			auxiliaryErr = compareObjectAuxiliarySnapshots(beforeAuxiliary, afterAuxiliary)
		}
	}
	if inspectErr != nil || auxiliaryErr != nil {
		return read, errors.Join(readErr, inspectErr, auxiliaryErr)
	}
	if read < len(buffer) && readErr == nil {
		readErr = io.EOF
	}
	return read, readErr
}

// HashSHA256 streams the exact expected byte count from offset zero and checks
// the retained file's identity, metadata, and stream set before and after.
func (file *File) HashSHA256(options HashOptions) (HashResult, error) {
	if file == nil {
		return HashResult{}, ErrClosed
	}
	if err := validateHashOptions(options); err != nil {
		return HashResult{}, err
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.closed || file.handle == 0 {
		return HashResult{}, ErrClosed
	}

	before, err := querySnapshot(file.handle, ObjectKindFile)
	if err != nil {
		return HashResult{}, fmt.Errorf("inspect file before hashing: %w", err)
	}
	if err := compareSnapshots(file.baseline, before); err != nil {
		return HashResult{}, fmt.Errorf("verify file before hashing: %w", err)
	}
	observedSize := uint64(before.standard.EndOfFile)
	if observedSize > options.MaximumBytes {
		return HashResult{}, fmt.Errorf("%w: observed %d bytes", ErrTooLarge, observedSize)
	}
	if observedSize != options.ExpectedSize {
		return HashResult{}, fmt.Errorf("%w: observed %d bytes, expected %d", ErrSizeMismatch, observedSize, options.ExpectedSize)
	}
	beforeAuxiliary, err := queryObjectAuxiliarySnapshot(file.handle, ObjectKindFile, observedSize)
	if err != nil {
		return HashResult{}, fmt.Errorf("inspect file streams before hashing: %w", err)
	}
	if err := compareObjectAuxiliarySnapshots(file.auxiliary, beforeAuxiliary); err != nil {
		return HashResult{}, fmt.Errorf("verify file streams before hashing: %w", err)
	}
	if _, err := windows.SetFilePointer(file.handle, 0, nil, windows.FILE_BEGIN); err != nil {
		return HashResult{}, fmt.Errorf("rewind file handle before hashing: %w", err)
	}

	result, hashErr := hashExact(handleReader{handle: file.handle}, options)
	after, inspectErr := querySnapshot(file.handle, ObjectKindFile)
	if inspectErr != nil {
		inspectErr = fmt.Errorf("inspect file after hashing: %w", inspectErr)
	}
	var afterAuxiliary objectAuxiliarySnapshot
	var auxiliaryErr error
	if inspectErr == nil {
		afterAuxiliary, auxiliaryErr = queryObjectAuxiliarySnapshot(file.handle, ObjectKindFile, uint64(after.standard.EndOfFile))
		if auxiliaryErr != nil {
			auxiliaryErr = fmt.Errorf("inspect file streams after hashing: %w", auxiliaryErr)
		}
	}
	if hashErr != nil || inspectErr != nil || auxiliaryErr != nil {
		return HashResult{}, errors.Join(hashErr, inspectErr, auxiliaryErr)
	}
	if err := compareSnapshots(before, after); err != nil {
		return HashResult{}, fmt.Errorf("verify stable file hashing: %w", err)
	}
	if err := compareObjectAuxiliarySnapshots(beforeAuxiliary, afterAuxiliary); err != nil {
		return HashResult{}, fmt.Errorf("verify stable file streams during hashing: %w", err)
	}
	return result, nil
}

// VerifyUnchanged checks that the file still has the identity and metadata
// captured by OpenFile. It does not re-evaluate ancestor path components.
func (file *File) VerifyUnchanged() error {
	if file == nil {
		return ErrClosed
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.closed || file.handle == 0 {
		return ErrClosed
	}
	current, err := querySnapshot(file.handle, ObjectKindFile)
	if err != nil {
		return fmt.Errorf("reinspect file: %w", err)
	}
	if err := compareSnapshots(file.baseline, current); err != nil {
		return err
	}
	auxiliary, err := queryObjectAuxiliarySnapshot(file.handle, ObjectKindFile, uint64(current.standard.EndOfFile))
	if err != nil {
		return err
	}
	return compareObjectAuxiliarySnapshots(file.auxiliary, auxiliary)
}

// VerifyUnchanged checks that the directory still has the identity and metadata
// captured by OpenDirectory. It does not re-evaluate ancestor path components.
func (directory *Directory) VerifyUnchanged() error {
	if directory == nil {
		return ErrClosed
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.closed || directory.handle == 0 {
		return ErrClosed
	}
	current, err := querySnapshot(directory.handle, ObjectKindDirectory)
	if err != nil {
		return fmt.Errorf("reinspect directory: %w", err)
	}
	if err := compareSnapshots(directory.baseline, current); err != nil {
		return err
	}
	auxiliary, err := queryObjectAuxiliarySnapshot(directory.handle, ObjectKindDirectory, uint64(current.standard.EndOfFile))
	if err != nil {
		return err
	}
	return compareObjectAuxiliarySnapshots(directory.auxiliary, auxiliary)
}

// ReinspectDataStreams returns a detached stream snapshot after confirming it
// still matches the retained file's opening snapshot.
func (file *File) ReinspectDataStreams() ([]DataStream, error) {
	if file == nil {
		return nil, ErrClosed
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.closed || file.handle == 0 {
		return nil, ErrClosed
	}
	current, err := querySnapshot(file.handle, ObjectKindFile)
	if err != nil {
		return nil, err
	}
	if err := compareSnapshots(file.baseline, current); err != nil {
		return nil, err
	}
	auxiliary, err := queryObjectAuxiliarySnapshot(file.handle, ObjectKindFile, uint64(current.standard.EndOfFile))
	if err != nil {
		return nil, err
	}
	if err := compareObjectAuxiliarySnapshots(file.auxiliary, auxiliary); err != nil {
		return nil, err
	}
	return cloneDataStreams(auxiliary.streams), nil
}

// ReinspectDataStreams returns a detached stream snapshot after confirming it
// still matches the retained directory's opening snapshot.
func (directory *Directory) ReinspectDataStreams() ([]DataStream, error) {
	if directory == nil {
		return nil, ErrClosed
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.closed || directory.handle == 0 {
		return nil, ErrClosed
	}
	current, err := querySnapshot(directory.handle, ObjectKindDirectory)
	if err != nil {
		return nil, err
	}
	if err := compareSnapshots(directory.baseline, current); err != nil {
		return nil, err
	}
	auxiliary, err := queryObjectAuxiliarySnapshot(directory.handle, ObjectKindDirectory, uint64(current.standard.EndOfFile))
	if err != nil {
		return nil, err
	}
	if err := compareObjectAuxiliarySnapshots(directory.auxiliary, auxiliary); err != nil {
		return nil, err
	}
	return cloneDataStreams(auxiliary.streams), nil
}

// ReinspectCaseSensitivity confirms the retained directory remains compatible
// with case-insensitive manifest path matching.
func (directory *Directory) ReinspectCaseSensitivity() (bool, error) {
	if directory == nil {
		return false, ErrClosed
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.closed || directory.handle == 0 {
		return false, ErrClosed
	}
	current, err := querySnapshot(directory.handle, ObjectKindDirectory)
	if err != nil {
		return false, err
	}
	if err := compareSnapshots(directory.baseline, current); err != nil {
		return false, err
	}
	caseSensitive, err := queryCaseSensitiveDirectory(directory.handle)
	if err != nil {
		return false, err
	}
	if caseSensitive != directory.auxiliary.caseSensitiveDirectory {
		return false, ErrObjectChanged
	}
	return caseSensitive, nil
}

// Close permanently prevents new file operations and releases the handle. A
// failed native close retains the handle only so a later Close can retry it.
func (file *File) Close() error {
	if file == nil {
		return nil
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.handle == 0 {
		file.closed = true
		return nil
	}
	file.closed = true
	handle := file.handle
	closeHandle := file.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	if err := closeHandle(handle); err != nil {
		return err
	}
	file.handle = 0
	return nil
}

// Close permanently prevents new directory operations and releases the handle.
// A failed native close retains the handle only so a later Close can retry it.
func (directory *Directory) Close() error {
	if directory == nil {
		return nil
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.handle == 0 {
		directory.closed = true
		return nil
	}
	directory.closed = true
	handle := directory.handle
	closeHandle := directory.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	if err := closeHandle(handle); err != nil {
		return err
	}
	directory.handle = 0
	return nil
}

type handleReader struct {
	handle windows.Handle
}

func (reader handleReader) Read(buffer []byte) (int, error) {
	var read uint32
	err := windows.ReadFile(reader.handle, buffer, &read, nil)
	if errors.Is(err, windows.ERROR_HANDLE_EOF) {
		return int(read), io.EOF
	}
	if err != nil {
		return int(read), err
	}
	if read == 0 {
		return 0, io.EOF
	}
	return int(read), nil
}

func wrapReadError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("read validated file handle: %w", err)
}

type discardedObject interface {
	Close() error
}

func closeDiscardedObject(operation string, object discardedObject) error {
	if object == nil {
		return nil
	}
	var failures []error
	for attempt := 1; attempt <= discardedHandleCloseAttempts; attempt++ {
		if err := object.Close(); err != nil {
			failures = append(failures, fmt.Errorf("%s attempt %d: %w", operation, attempt, err))
			continue
		}
		return errors.Join(failures...)
	}
	return errors.Join(failures...)
}
