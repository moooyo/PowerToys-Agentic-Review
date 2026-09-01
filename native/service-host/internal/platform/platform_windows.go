//go:build windows

package platform

func NewHost() Host {
	return compositionHost{newBuilder: func() compositionBuilder {
		return &windowsComposition{}
	}}
}
