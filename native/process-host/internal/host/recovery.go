package host

import "errors"

// EnableNamedJobRecovery must be called after acquiring the instance mutex and before Run.
// The recovery job contains the Host itself as well as every managed process tree.
func (s *Server) EnableNamedJobRecovery(instanceKey string) error {
	if s.namedJobRecovery != nil {
		return errors.New("named Job recovery has already been configured")
	}
	launcher, capability, err := newRecoveryLauncher(instanceKey)
	if err != nil {
		return err
	}
	s.launcher = launcher
	s.namedJobRecovery = capability
	return nil
}
