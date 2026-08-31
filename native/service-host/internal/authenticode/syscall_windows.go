//go:build windows

package authenticode

import "golang.org/x/sys/windows"

var _ windows.Handle

//go:generate go run golang.org/x/sys/windows/mkwinsyscall -output zsyscall_windows.go syscall_windows.go

//sys winVerifyTrust(hwnd windows.HWND, action *windows.GUID, data *winTrustData) (status int32) = wintrust.WinVerifyTrust
//sys providerDataFromStateDataRaw(state windows.Handle) (data uintptr) = wintrust.WTHelperProvDataFromStateData
//sys signerFromChainRaw(data *cryptProviderData, signerIndex uint32, counterSigner bool, counterSignerIndex uint32) (signer uintptr) = wintrust.WTHelperGetProvSignerFromChain
//sys certificateFromChainRaw(signer *cryptProviderSigner, certificateIndex uint32) (certificate uintptr) = wintrust.WTHelperGetProvCertFromChain
