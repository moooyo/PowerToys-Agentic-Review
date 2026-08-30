//go:build !windows

package winprocess

// LaunchNode fails closed outside Windows.
func LaunchNode(NodeLaunchSpec) (NodeProcess, error) {
	return nil, ErrUnsupportedPlatform
}

// OpenWrapperWatcher fails closed outside Windows.
func OpenWrapperWatcher(string) (WrapperWatcher, error) {
	return nil, ErrUnsupportedPlatform
}
