package peimage

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"testing"
)

func TestSigningInvariantLinksUnsignedAndSignedImage(t *testing.T) {
	unsigned := minimalPE64(t, "amd64")
	unsignedDigest, signed, err := SigningInvariantSHA256(
		bytes.NewReader(unsigned),
		int64(len(unsigned)),
		"amd64",
	)
	if err != nil || signed {
		t.Fatalf("unsigned invariant = (%x, %t, %v)", unsignedDigest, signed, err)
	}
	signedImage := addSingleCertificateTable(unsigned)
	signedDigest, signed, err := SigningInvariantSHA256(
		bytes.NewReader(signedImage),
		int64(len(signedImage)),
		"amd64",
	)
	if err != nil || !signed || signedDigest != unsignedDigest {
		t.Fatalf("signed invariant = (%x, %t, %v), want %x", signedDigest, signed, err, unsignedDigest)
	}
	signedImage[0x200] ^= 0xff
	changed, _, err := SigningInvariantSHA256(bytes.NewReader(signedImage), int64(len(signedImage)), "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if changed == unsignedDigest {
		t.Fatal("signing invariant ignored a non-signature content change")
	}
}

func TestSigningInvariantRejectsOverlayAndAmbiguousCertificateTable(t *testing.T) {
	unsignedOverlay := append(minimalPE64(t, "amd64"), 0)
	if _, _, err := SigningInvariantSHA256(
		bytes.NewReader(unsignedOverlay),
		int64(len(unsignedOverlay)),
		"amd64",
	); err == nil {
		t.Fatal("signing invariant accepted an unsigned overlay")
	}
	valid := addSingleCertificateTable(minimalPE64(t, "amd64"))
	overlay := append(append([]byte(nil), valid...), 0)
	if _, _, err := SigningInvariantSHA256(bytes.NewReader(overlay), int64(len(overlay)), "amd64"); err == nil {
		t.Fatal("signing invariant accepted bytes after the certificate table")
	}
	ambiguous := append(append([]byte(nil), valid...), make([]byte, 16)...)
	securityDirectoryOffset := 0x80 + 4 + 20 + 112 + 4*8
	binary.LittleEndian.PutUint32(ambiguous[securityDirectoryOffset+4:], 32)
	if _, _, err := SigningInvariantSHA256(bytes.NewReader(ambiguous), int64(len(ambiguous)), "amd64"); err == nil {
		t.Fatal("signing invariant accepted more than one WIN_CERTIFICATE record")
	}
}

func TestSigningInvariantRequiresZeroCertificateAlignmentPadding(t *testing.T) {
	unsigned := minimalPE64(t, "amd64")
	want, _, err := SigningInvariantSHA256(bytes.NewReader(unsigned), int64(len(unsigned)), "amd64")
	if err != nil {
		t.Fatal(err)
	}
	for paddingBytes := 1; paddingBytes <= 7; paddingBytes++ {
		t.Run(fmt.Sprintf("%d bytes", paddingBytes), func(t *testing.T) {
			image := addSingleCertificateTable(unsigned)
			certificate := image[len(unsigned):]
			for index := 8; index < len(certificate); index++ {
				certificate[index] = 0
			}
			length := len(certificate) - paddingBytes
			binary.LittleEndian.PutUint32(certificate[0:], uint32(length))
			certificate[8] = 1
			certificate[length] = 1
			if _, _, err := SigningInvariantSHA256(
				bytes.NewReader(image),
				int64(len(image)),
				"amd64",
			); err == nil {
				t.Fatal("nonzero WIN_CERTIFICATE padding was accepted")
			}
			certificate[length] = 0
			got, signed, err := SigningInvariantSHA256(
				bytes.NewReader(image),
				int64(len(image)),
				"amd64",
			)
			if err != nil || !signed || got != want {
				t.Fatalf("zero-padded WIN_CERTIFICATE was rejected: digest=%x signed=%t err=%v", got, signed, err)
			}
		})
	}
}

func TestValidateServiceHostRequiresArchitectureAndSecurityDirectory(t *testing.T) {
	image := minimalPE64(t, "amd64")
	if err := ValidateServiceHost(bytes.NewReader(image), int64(len(image)), "amd64"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateServiceHost(bytes.NewReader(image), int64(len(image)), "arm64"); err == nil {
		t.Fatal("AMD64 image was accepted for ARM64")
	}
	missingDirectory := append([]byte(nil), image...)
	optionalHeaderOffset := 0x80 + 4 + 20
	binary.LittleEndian.PutUint32(missingDirectory[optionalHeaderOffset+108:], 4)
	if err := ValidateServiceHost(
		bytes.NewReader(missingDirectory),
		int64(len(missingDirectory)),
		"amd64",
	); err == nil {
		t.Fatal("PE image without a certificate-table directory was accepted")
	}
}

func addSingleCertificateTable(unsigned []byte) []byte {
	result := append([]byte(nil), unsigned...)
	const certificateSize = 16
	certificateOffset := len(result)
	certificate := make([]byte, certificateSize)
	binary.LittleEndian.PutUint32(certificate[0:], certificateSize)
	binary.LittleEndian.PutUint16(certificate[4:], winCertificateRevision20)
	binary.LittleEndian.PutUint16(certificate[6:], winCertificateTypePKCSSignedData)
	copy(certificate[8:], []byte("fixture!"))
	result = append(result, certificate...)
	optionalHeaderOffset := 0x80 + 4 + 20
	binary.LittleEndian.PutUint32(result[optionalHeaderOffset+64:], 0x12345678)
	securityDirectoryOffset := optionalHeaderOffset + 112 + 4*8
	binary.LittleEndian.PutUint32(result[securityDirectoryOffset:], uint32(certificateOffset))
	binary.LittleEndian.PutUint32(result[securityDirectoryOffset+4:], certificateSize)
	return result
}

func minimalPE64(t *testing.T, architecture string) []byte {
	t.Helper()
	machine, err := ExpectedMachine(architecture)
	if err != nil {
		t.Fatal(err)
	}
	const (
		peOffset         = 0x80
		optionalHeader   = peOffset + 4 + 20
		sectionTable     = optionalHeader + 0xf0
		rawSectionOffset = 0x200
		rawSectionSize   = 0x200
		imageSize        = rawSectionOffset + rawSectionSize
	)
	image := make([]byte, imageSize)
	image[0], image[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(image[0x3c:], peOffset)
	copy(image[peOffset:], []byte{'P', 'E', 0, 0})
	coff := image[peOffset+4 : optionalHeader]
	binary.LittleEndian.PutUint16(coff[0:], machine)
	binary.LittleEndian.PutUint16(coff[2:], 1)
	binary.LittleEndian.PutUint16(coff[16:], 0xf0)
	binary.LittleEndian.PutUint16(coff[18:], 0x22)
	optional := image[optionalHeader:sectionTable]
	binary.LittleEndian.PutUint16(optional[0:], 0x20b)
	binary.LittleEndian.PutUint32(optional[4:], rawSectionSize)
	binary.LittleEndian.PutUint32(optional[16:], 0x1000)
	binary.LittleEndian.PutUint32(optional[20:], 0x1000)
	binary.LittleEndian.PutUint64(optional[24:], 0x140000000)
	binary.LittleEndian.PutUint32(optional[32:], 0x1000)
	binary.LittleEndian.PutUint32(optional[36:], 0x200)
	binary.LittleEndian.PutUint16(optional[40:], 6)
	binary.LittleEndian.PutUint16(optional[48:], 6)
	binary.LittleEndian.PutUint32(optional[56:], 0x2000)
	binary.LittleEndian.PutUint32(optional[60:], rawSectionOffset)
	binary.LittleEndian.PutUint16(optional[68:], 3)
	binary.LittleEndian.PutUint64(optional[72:], 0x100000)
	binary.LittleEndian.PutUint64(optional[80:], 0x1000)
	binary.LittleEndian.PutUint64(optional[88:], 0x100000)
	binary.LittleEndian.PutUint64(optional[96:], 0x1000)
	binary.LittleEndian.PutUint32(optional[108:], 16)
	section := image[sectionTable : sectionTable+40]
	copy(section[:8], []byte(".text"))
	binary.LittleEndian.PutUint32(section[8:], 1)
	binary.LittleEndian.PutUint32(section[12:], 0x1000)
	binary.LittleEndian.PutUint32(section[16:], rawSectionSize)
	binary.LittleEndian.PutUint32(section[20:], rawSectionOffset)
	binary.LittleEndian.PutUint32(section[36:], 0x60000020)
	image[rawSectionOffset] = 0xc3
	return image
}
