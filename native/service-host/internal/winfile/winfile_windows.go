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
	mu       sync.Mutex
	handle   windows.Handle
	baseline objectSnapshot
	evidence Evidence
	closed   bool
}

// Directory owns a Windows directory handle opened without delete sharing.
type Directory struct {
	mu       sync.Mutex
	handle   windows.Handle
	baseline objectSnapshot
	evidence Evidence
	closed   bool
}

type openedObject struct {
	handle   windows.Handle
	baseline objectSnapshot
	evidence Evidence
}

// OpenFile opens and validates a regular, single-link file. The returned handle
// remains open so later reads stay bound to the validated object identity.
func OpenFile(path string, options OpenOptions) (*File, error) {
	opened, err := openObject(path, ObjectKindFile, options)
	if err != nil {
		return nil, err
	}
	return &File{
		handle:   opened.handle,
		baseline: opened.baseline,
		evidence: opened.evidence,
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
		handle:   opened.handle,
		baseline: opened.baseline,
		evidence: opened.evidence,
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
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return ReadResult{}, errors.Join(readErr, wrapCloseError(closeErr))
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
	if err := directory.Close(); err != nil {
		return Evidence{}, fmt.Errorf("close inspected directory: %w", err)
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
	if readErr != nil || inspectErr != nil {
		return nil, errors.Join(wrapReadError(readErr), inspectErr)
	}
	if err := compareSnapshots(before, after); err != nil {
		return nil, fmt.Errorf("verify stable file read: %w", err)
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
	return compareSnapshots(file.baseline, current)
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
	return compareSnapshots(directory.baseline, current)
}

// Close releases the file handle.
func (file *File) Close() error {
	if file == nil {
		return nil
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.closed || file.handle == 0 {
		file.closed = true
		return nil
	}
	file.closed = true
	handle := file.handle
	file.handle = 0
	return windows.CloseHandle(handle)
}

// Close releases the directory handle.
func (directory *Directory) Close() error {
	if directory == nil {
		return nil
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.closed || directory.handle == 0 {
		directory.closed = true
		return nil
	}
	directory.closed = true
	handle := directory.handle
	directory.handle = 0
	return windows.CloseHandle(handle)
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

func wrapCloseError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("close validated file handle: %w", err)
}
