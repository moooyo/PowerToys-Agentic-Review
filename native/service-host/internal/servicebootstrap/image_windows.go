//go:build windows

package servicebootstrap

import (
	"errors"
	"fmt"
	"io"
	"sync"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"golang.org/x/sys/windows"
)

const (
	imageAttributeDirectory    = uint32(0x00000010)
	imageAttributeReparsePoint = uint32(0x00000400)
	initialFinalPathUnits      = uint32(512)
	maximumFinalPathUnits      = uint32(32_768)

	imageAttributeTagInfoSize = 8
	imageFileIDInfoSize       = 24
	imageStandardInfoSize     = 24
	imageBasicInfoSize        = 40
)

type imageAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

type imageFileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

type imageStandardInfo struct {
	AllocationSize int64
	EndOfFile      int64
	NumberOfLinks  uint32
	DeletePending  byte
	Directory      byte
}

type imageBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
}

type imageFileSnapshot struct {
	attribute imageAttributeTagInfo
	identity  imageFileIDInfo
	standard  imageStandardInfo
	basic     imageBasicInfo
}

var (
	_ [imageAttributeTagInfoSize - unsafe.Sizeof(imageAttributeTagInfo{})]byte
	_ [unsafe.Sizeof(imageAttributeTagInfo{}) - imageAttributeTagInfoSize]byte
	_ [imageFileIDInfoSize - unsafe.Sizeof(imageFileIDInfo{})]byte
	_ [unsafe.Sizeof(imageFileIDInfo{}) - imageFileIDInfoSize]byte
	_ [imageStandardInfoSize - unsafe.Sizeof(imageStandardInfo{})]byte
	_ [unsafe.Sizeof(imageStandardInfo{}) - imageStandardInfoSize]byte
	_ [imageBasicInfoSize - unsafe.Sizeof(imageBasicInfo{})]byte
	_ [unsafe.Sizeof(imageBasicInfo{}) - imageBasicInfoSize]byte
)

type windowsImageSubject struct {
	mu           sync.Mutex
	handle       windows.Handle
	closeHandle  func(windows.Handle) error
	baseline     imageFileSnapshot
	processPath  string
	finalPath    string
	finalPathErr error
}

func openWindowsImage(processPath string) (image peerverify.ImageSubject, err error) {
	path, err := windows.UTF16PtrFromString(processPath)
	if err != nil {
		return nil, fmt.Errorf("encode process image path: %w", err)
	}
	handle, err := windows.CreateFile(
		path,
		windows.GENERIC_READ|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_SEQUENTIAL_SCAN,
		0,
	)
	if err != nil {
		return nil, fmt.Errorf("CreateFileW process image: %w", err)
	}
	keep := false
	defer func() {
		if !keep {
			err = errors.Join(err, closeRejectedImageHandle(handle))
		}
	}()

	fileType, err := windows.GetFileType(handle)
	if err != nil {
		return nil, fmt.Errorf("GetFileType process image: %w", err)
	}
	if fileType != windows.FILE_TYPE_DISK {
		return nil, fmt.Errorf("%w: process image is file type %d", peerverify.ErrImageMismatch, fileType)
	}
	baseline, err := queryWindowsImageSnapshot(handle)
	if err != nil {
		return nil, err
	}
	finalPath, finalPathErr := queryWindowsFinalPath(handle)

	keep = true
	return &windowsImageSubject{
		handle:       handle,
		baseline:     baseline,
		processPath:  processPath,
		finalPath:    finalPath,
		finalPathErr: finalPathErr,
	}, nil
}

func queryWindowsImageSnapshot(handle windows.Handle) (imageFileSnapshot, error) {
	snapshot := imageFileSnapshot{}
	queries := []struct {
		class uint32
		data  unsafe.Pointer
		size  uintptr
		name  string
	}{
		{windows.FileAttributeTagInfo, unsafe.Pointer(&snapshot.attribute), unsafe.Sizeof(snapshot.attribute), "FileAttributeTagInfo"},
		{windows.FileIdInfo, unsafe.Pointer(&snapshot.identity), unsafe.Sizeof(snapshot.identity), "FileIdInfo"},
		{windows.FileStandardInfo, unsafe.Pointer(&snapshot.standard), unsafe.Sizeof(snapshot.standard), "FileStandardInfo"},
		{windows.FileBasicInfo, unsafe.Pointer(&snapshot.basic), unsafe.Sizeof(snapshot.basic), "FileBasicInfo"},
	}
	for _, query := range queries {
		if err := windows.GetFileInformationByHandleEx(
			handle,
			query.class,
			(*byte)(query.data),
			uint32(query.size),
		); err != nil {
			return imageFileSnapshot{}, fmt.Errorf("%s for process image: %w", query.name, err)
		}
	}
	if err := validateWindowsImageSnapshot(snapshot); err != nil {
		return imageFileSnapshot{}, err
	}
	return snapshot, nil
}

func validateWindowsImageSnapshot(snapshot imageFileSnapshot) error {
	if snapshot.attribute.FileAttributes&imageAttributeReparsePoint != 0 || snapshot.attribute.ReparseTag != 0 {
		return fmt.Errorf("%w: process image is a reparse point", peerverify.ErrImageMismatch)
	}
	if snapshot.attribute.FileAttributes != snapshot.basic.FileAttributes {
		return fmt.Errorf("%w: process image attribute queries disagree", peerverify.ErrImageMismatch)
	}
	if snapshot.attribute.FileAttributes&imageAttributeDirectory != 0 || snapshot.standard.Directory != 0 {
		return fmt.Errorf("%w: process image is a directory", peerverify.ErrImageMismatch)
	}
	if snapshot.standard.DeletePending != 0 {
		return fmt.Errorf("%w: process image is pending deletion", peerverify.ErrImageMismatch)
	}
	if snapshot.standard.NumberOfLinks != 1 {
		return fmt.Errorf(
			"%w: process image has %d hard links",
			peerverify.ErrImageMismatch,
			snapshot.standard.NumberOfLinks,
		)
	}
	if snapshot.standard.EndOfFile <= 0 || snapshot.standard.AllocationSize < 0 {
		return fmt.Errorf("%w: process image has invalid size metadata", peerverify.ErrImageMismatch)
	}
	return nil
}

func compareWindowsImageSnapshots(before, after imageFileSnapshot) error {
	if before.identity != after.identity {
		return fmt.Errorf("%w: process image file identity changed", peerverify.ErrImageMismatch)
	}
	if before.attribute != after.attribute ||
		before.standard != after.standard ||
		before.basic.CreationTime != after.basic.CreationTime ||
		before.basic.LastWriteTime != after.basic.LastWriteTime ||
		before.basic.ChangeTime != after.basic.ChangeTime ||
		before.basic.FileAttributes != after.basic.FileAttributes {
		return fmt.Errorf("%w: process image metadata changed", peerverify.ErrImageMismatch)
	}
	return nil
}

func (image *windowsImageSubject) ReadAt(buffer []byte, offset int64) (int, error) {
	if image == nil {
		return 0, ErrClosed
	}
	if offset < 0 {
		return 0, fmt.Errorf("negative image read offset %d", offset)
	}
	if len(buffer) == 0 {
		return 0, nil
	}
	image.mu.Lock()
	defer image.mu.Unlock()
	if image.handle == 0 {
		return 0, ErrClosed
	}
	if offset >= image.baseline.standard.EndOfFile {
		return 0, io.EOF
	}
	if _, err := windows.Seek(image.handle, offset, io.SeekStart); err != nil {
		return 0, err
	}
	var read uint32
	err := windows.ReadFile(image.handle, buffer, &read, nil)
	if errors.Is(err, windows.ERROR_HANDLE_EOF) {
		return int(read), io.EOF
	}
	if err != nil {
		return int(read), err
	}
	if int(read) < len(buffer) {
		return int(read), io.EOF
	}
	return int(read), nil
}

func (image *windowsImageSubject) Size() int64 {
	if image == nil {
		return 0
	}
	image.mu.Lock()
	defer image.mu.Unlock()
	return image.baseline.standard.EndOfFile
}

func (image *windowsImageSubject) Identity() peerverify.FileIdentity {
	if image == nil {
		return peerverify.FileIdentity{}
	}
	image.mu.Lock()
	defer image.mu.Unlock()
	return peerverify.FileIdentity{
		VolumeSerialNumber: image.baseline.identity.VolumeSerialNumber,
		FileID:             image.baseline.identity.FileID,
	}
}

func (image *windowsImageSubject) ProcessPathDiagnostic() string {
	if image == nil {
		return ""
	}
	image.mu.Lock()
	defer image.mu.Unlock()
	return image.processPath
}

func (image *windowsImageSubject) FinalPathDiagnostic() (string, error) {
	if image == nil {
		return "", ErrClosed
	}
	image.mu.Lock()
	defer image.mu.Unlock()
	return image.finalPath, image.finalPathErr
}

func (image *windowsImageSubject) VerifyUnchanged() error {
	if image == nil {
		return ErrClosed
	}
	image.mu.Lock()
	defer image.mu.Unlock()
	if image.handle == 0 {
		return ErrClosed
	}
	current, err := queryWindowsImageSnapshot(image.handle)
	if err != nil {
		return err
	}
	return compareWindowsImageSnapshots(image.baseline, current)
}

func (image *windowsImageSubject) Close() error {
	if image == nil {
		return nil
	}
	image.mu.Lock()
	defer image.mu.Unlock()
	if image.handle == 0 {
		return nil
	}
	closeHandle := image.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	if err := closeHandle(image.handle); err != nil {
		return fmt.Errorf("CloseHandle process image: %w", err)
	}
	image.handle = 0
	return nil
}

func queryWindowsFinalPath(handle windows.Handle) (string, error) {
	for units := initialFinalPathUnits; units <= maximumFinalPathUnits; {
		buffer := make([]uint16, units)
		length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], units, 0)
		if err != nil {
			return "", err
		}
		if length == 0 {
			return "", errors.New("GetFinalPathNameByHandleW returned an empty path")
		}
		if length < units {
			return windows.UTF16ToString(buffer[:length]), nil
		}
		if length >= maximumFinalPathUnits {
			break
		}
		units = length + 1
	}
	return "", fmt.Errorf("GetFinalPathNameByHandleW exceeded %d UTF-16 units", maximumFinalPathUnits)
}

func closeRejectedImageHandle(handle windows.Handle) error {
	if handle == 0 {
		return nil
	}
	var failures []error
	for attempt := 1; attempt <= rejectedResourceCloseAttempts; attempt++ {
		if err := windows.CloseHandle(handle); err != nil {
			failures = append(failures, fmt.Errorf("close rejected image handle attempt %d: %w", attempt, err))
			continue
		}
		return errors.Join(failures...)
	}
	return errors.Join(failures...)
}

var _ peerverify.ImageSubject = (*windowsImageSubject)(nil)
