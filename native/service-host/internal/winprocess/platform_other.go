//go:build !windows

package winprocess

// LaunchNode fails closed outside Windows.
func LaunchNode(NodeLaunchSpec) (NodeProcess, error) {
	return nil, ErrUnsupportedPlatform
}
