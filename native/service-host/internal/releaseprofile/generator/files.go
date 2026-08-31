package generator

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
)

// ReadRegularBounded reads one existing, non-symlink regular file through the
// same object inspected by Lstat and bounds both declared and observed size.
func ReadRegularBounded(path string, maximum int64) (result []byte, err error) {
	if maximum <= 0 {
		return nil, errors.New("maximum file size must be positive")
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect %s: %w", path, err)
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() < 0 || before.Size() > maximum {
		return nil, fmt.Errorf("%s must be a bounded non-symlink regular file", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s read-only: %w", path, err)
	}
	defer func() {
		if closeErr := file.Close(); closeErr != nil {
			result = nil
			err = errors.Join(err, fmt.Errorf("close %s: %w", path, closeErr))
		}
	}()
	opened, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect opened %s: %w", path, err)
	}
	if !opened.Mode().IsRegular() || !os.SameFile(before, opened) || opened.Size() != before.Size() {
		return nil, fmt.Errorf("%s changed identity or type while opening", path)
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if int64(len(data)) > maximum || int64(len(data)) != opened.Size() {
		return nil, fmt.Errorf("%s changed size or exceeds %d bytes", path, maximum)
	}
	after, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("reinspect opened %s: %w", path, err)
	}
	if !os.SameFile(opened, after) || after.Size() != int64(len(data)) {
		return nil, fmt.Errorf("%s changed while reading", path)
	}
	return data, nil
}

// WriteExclusiveRegular creates one new regular file, flushes its bytes, and
// rejects every pre-existing target, including symlinks and directories.
func WriteExclusiveRegular(path string, data []byte, permission os.FileMode) (err error) {
	if _, statErr := os.Lstat(path); statErr == nil {
		return fmt.Errorf("refusing to replace existing output %s", path)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("inspect output %s: %w", path, statErr)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, permission)
	if err != nil {
		return fmt.Errorf("create exclusive output %s: %w", path, err)
	}
	complete := false
	defer func() {
		if !complete {
			_ = file.Close()
			_ = os.Remove(path)
		}
	}()
	written, err := file.Write(data)
	if err != nil {
		return fmt.Errorf("write complete output %s: %w", path, err)
	}
	if written != len(data) {
		return fmt.Errorf("write complete output %s: wrote %d of %d bytes: %w", path, written, len(data), io.ErrShortWrite)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("flush output %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close output %s: %w", path, err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect completed output %s: %w", path, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != int64(len(data)) {
		return fmt.Errorf("completed output %s is not the exact regular file", path)
	}
	complete = true
	return nil
}

// CheckExactRegular bounds and compares one existing regular file.
func CheckExactRegular(path string, expected []byte, maximum int64) error {
	actual, err := ReadRegularBounded(path, maximum)
	if err != nil {
		return err
	}
	if !bytes.Equal(actual, expected) {
		return fmt.Errorf("output %s is stale", path)
	}
	return nil
}
