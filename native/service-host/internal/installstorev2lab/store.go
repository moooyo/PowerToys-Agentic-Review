package installstorev2lab

type exclusiveStore struct {
	state *exclusiveStoreState
}

type exclusiveStoreState struct {
	generation uint64
}

// OpenExclusive remains unavailable until the Windows fixed-path store,
// migration inventory, and native durability evidence are implemented.
func OpenExclusive() (*exclusiveStore, error) {
	return nil, ErrUnavailable
}

// Recover performs no I/O and returns no recovered authority in this lab.
func (*exclusiveStore) Recover() error {
	return ErrUnavailable
}

// PublishSuccessor accepts only a sealed prepared value and never publishes or
// mints a permit in this lab.
func (*exclusiveStore) PublishSuccessor(PreparedSuccessor) (DurableIntentPermit, error) {
	return DurableIntentPermit{}, ErrUnavailable
}

// Close performs no I/O because OpenExclusive cannot return a store.
func (*exclusiveStore) Close() error {
	return ErrUnavailable
}
