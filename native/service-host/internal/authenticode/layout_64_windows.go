//go:build windows && (amd64 || arm64)

package authenticode

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	winTrustFileInfo64Size          = 32
	winTrustSignatureSettings64Size = 32
	winTrustData64Size              = 88
	certStrongSignPara64Size        = 16
	cryptProviderDataPrefix64Size   = 168
	providerDataSIP64Size           = 64
	cryptProviderSigner64Size       = 64
	cryptProviderCertPrefix64Size   = 48
	cryptAttributeTypeValue64Size   = 24
	spcIndirectDataContent64Size    = 64
	cryptMessageSignerInfo64Size    = 136
)

var (
	_ [winTrustFileInfo64Size - unsafe.Sizeof(winTrustFileInfo{})]byte
	_ [unsafe.Sizeof(winTrustFileInfo{}) - winTrustFileInfo64Size]byte
	_ [winTrustSignatureSettings64Size - unsafe.Sizeof(winTrustSignatureSettings{})]byte
	_ [unsafe.Sizeof(winTrustSignatureSettings{}) - winTrustSignatureSettings64Size]byte
	_ [winTrustData64Size - unsafe.Sizeof(winTrustData{})]byte
	_ [unsafe.Sizeof(winTrustData{}) - winTrustData64Size]byte
	_ [certStrongSignPara64Size - unsafe.Sizeof(windows.CertStrongSignPara{})]byte
	_ [unsafe.Sizeof(windows.CertStrongSignPara{}) - certStrongSignPara64Size]byte
	_ [cryptProviderDataPrefix64Size - unsafe.Sizeof(cryptProviderData{})]byte
	_ [unsafe.Sizeof(cryptProviderData{}) - cryptProviderDataPrefix64Size]byte
	_ [providerDataSIP64Size - unsafe.Sizeof(providerDataSIP{})]byte
	_ [unsafe.Sizeof(providerDataSIP{}) - providerDataSIP64Size]byte
	_ [cryptProviderSigner64Size - unsafe.Sizeof(cryptProviderSigner{})]byte
	_ [unsafe.Sizeof(cryptProviderSigner{}) - cryptProviderSigner64Size]byte
	_ [cryptProviderCertPrefix64Size - unsafe.Sizeof(cryptProviderCert{})]byte
	_ [unsafe.Sizeof(cryptProviderCert{}) - cryptProviderCertPrefix64Size]byte
	_ [cryptAttributeTypeValue64Size - unsafe.Sizeof(cryptAttributeTypeValue{})]byte
	_ [unsafe.Sizeof(cryptAttributeTypeValue{}) - cryptAttributeTypeValue64Size]byte
	_ [spcIndirectDataContent64Size - unsafe.Sizeof(spcIndirectDataContent{})]byte
	_ [unsafe.Sizeof(spcIndirectDataContent{}) - spcIndirectDataContent64Size]byte
	_ [cryptMessageSignerInfo64Size - unsafe.Sizeof(cryptMessageSignerInfo{})]byte
	_ [unsafe.Sizeof(cryptMessageSignerInfo{}) - cryptMessageSignerInfo64Size]byte
)
