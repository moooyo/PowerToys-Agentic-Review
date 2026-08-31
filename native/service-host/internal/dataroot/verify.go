package dataroot

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	maximumRetainedObjects             = 16_384
	maximumRuntimeEntriesPerDirectory  = 4_096
	maximumRuntimeNameUTF16UnitsPerDir = 1024 * 1024
)

type openedDirectory struct {
	handle directoryHandle
	object ObjectSnapshot
}

type verifier struct {
	ctx          context.Context
	current      config.Config
	peer         config.Config
	installation installationSnapshot
	plan         runtimePathPlan
	deps         dependencies
	policy       filesystemSecurityPolicy
	resources    retainedResources
	seen         map[winfile.FileIdentity]string
	directories  map[string]*openedDirectory
	root         RootSnapshot
	paths        []RuntimePathSnapshot
}

func verifyWithDependencies(
	ctx context.Context,
	current config.Config,
	peer config.Config,
	installation installationSnapshot,
	deps dependencies,
) (result Evidence, err error) {
	if ctx == nil || deps.openTraversalRoot == nil {
		return Evidence{}, verificationError(ErrorInput, "verification context or Windows backend is missing", ErrInvalidInput)
	}
	if cause := context.Cause(ctx); cause != nil {
		return Evidence{}, cause
	}
	if err := validateInput(current, peer, installation); err != nil {
		return Evidence{}, err
	}
	plan, err := buildRuntimePathPlan(current)
	if err != nil {
		return Evidence{}, verificationError(ErrorPath, "build fixed runtime path plan", errors.Join(ErrPathPlan, err))
	}
	policy, err := newFilesystemSecurityPolicy(current)
	if err != nil {
		return Evidence{}, verificationError(ErrorACL, "construct closed role data ACL policy", errors.Join(ErrACL, err))
	}
	v := &verifier{
		ctx: ctx, current: cloneConfig(current), peer: cloneConfig(peer), installation: installation,
		plan: plan, deps: deps, policy: policy, seen: make(map[winfile.FileIdentity]string),
		directories: make(map[string]*openedDirectory),
	}
	transferred := false
	defer func() {
		if transferred {
			return
		}
		if cleanupErr := v.resources.close(rejectedCloseAttempts); cleanupErr != nil {
			result = Evidence{}
			err = errors.Join(err, verificationError(ErrorCleanup, "close rejected data-root handles", errors.Join(ErrCleanup, cleanupErr)))
		}
	}()

	if err = v.openDataRoot(); err != nil {
		return Evidence{}, err
	}
	if err = v.openRuntimePaths(); err != nil {
		return Evidence{}, err
	}
	if err = v.sealClosedDirectories(); err != nil {
		return Evidence{}, err
	}
	if err = v.openRuntimeContentTrees(); err != nil {
		return Evidence{}, err
	}
	if err = v.bindInstallationRoots(); err != nil {
		return Evidence{}, err
	}
	if err = v.resources.recheck(); err != nil {
		return Evidence{}, verificationError(ErrorChanged, "initial retained-handle reinspection failed", errors.Join(ErrChanged, err))
	}

	state := &evidenceState{
		valid: true, role: current.Role, current: cloneConfig(current), peer: cloneConfig(peer),
		root: cloneRootSnapshot(v.root), paths: cloneRuntimePaths(v.paths),
		objects:      v.resources.snapshots(),
		installation: cloneInstallationBindings(installation.roots),
		peerPath:     peer.Node.DataRoot, peerObservation: PeerLiveRootNotObservedByDesign,
		resources: v.resources,
	}
	state.digest, err = digestEvidenceState(state)
	if err != nil {
		return Evidence{}, verificationError(ErrorInput, "digest data-root evidence", errors.Join(ErrInvalidInput, err))
	}
	result = Evidence{state: state}
	if validateErr := result.Validate(); validateErr != nil {
		return Evidence{}, verificationError(ErrorInput, "constructed data-root evidence is incomplete", validateErr)
	}
	v.resources = retainedResources{}
	transferred = true
	return result, nil
}

func (v *verifier) openDataRoot() error {
	rootComponentCount := len(v.plan.root.components)
	volume, err := v.deps.openTraversalRoot(v.plan.root.drive, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseWritable, SecurityMode: winfile.SecurityModeAmbientAncestor,
	})
	if err != nil {
		return verificationError(ErrorFilesystem, "open data-root volume", errors.Join(ErrFilesystem, err))
	}
	current, err := v.retainDirectory(v.plan.root.drive, volume, directorySecurityAmbient)
	if err != nil {
		return err
	}
	ancestors := []ObjectSnapshot{cloneObjectSnapshot(current.object)}
	for index, component := range v.plan.root.components {
		if cause := context.Cause(v.ctx); cause != nil {
			return cause
		}
		class := directorySecurityAmbient
		if index == rootComponentCount-2 {
			class = directorySecurityProductAnchor
		} else if index == rootComponentCount-1 {
			class = directorySecurityRoleDataBoundary
		}
		mode := winfile.SecurityModeAmbientAncestor
		if class != directorySecurityAmbient {
			mode = winfile.SecurityModeManaged
		}
		path := joinPath(current.object.path, component)
		child, openErr := current.handle.OpenDirectoryComponent(component, winfile.OpenOptions{
			VolumeUse:            winfile.VolumeUseWritable,
			DirectoryEnumeration: path == v.plan.rootPath,
			SecurityMode:         mode,
		})
		if openErr != nil {
			return verificationError(ErrorFilesystem, "open retained data-root component", errors.Join(ErrFilesystem, openErr))
		}
		next, retainErr := v.retainDirectory(path, child, class)
		if retainErr != nil {
			return retainErr
		}
		if next.object.evidence.Identity.VolumeSerialNumber != current.object.evidence.Identity.VolumeSerialNumber {
			return verificationError(ErrorFilesystem, "data-root traversal changed volume", ErrFilesystem)
		}
		current = next
		if index != rootComponentCount-1 {
			ancestors = append(ancestors, cloneObjectSnapshot(current.object))
		}
	}
	v.root = RootSnapshot{
		path: v.plan.rootPath, ancestors: ancestors, object: cloneObjectSnapshot(current.object),
	}
	v.directories[v.plan.rootPath] = current
	return nil
}

func (v *verifier) openRuntimePaths() error {
	for _, planned := range v.plan.directories {
		if cause := context.Cause(v.ctx); cause != nil {
			return cause
		}
		target, err := v.openDirectoryBelowRoot(planned)
		if err != nil {
			return err
		}
		v.paths = append(v.paths, RuntimePathSnapshot{
			purpose: planned.purpose, class: planned.class, path: planned.path,
			relative: planned.relative, kind: planned.kind, object: cloneObjectSnapshot(target.object),
		})
	}
	for _, planned := range v.plan.files {
		if cause := context.Cause(v.ctx); cause != nil {
			return cause
		}
		file, err := v.openFileBelowRoot(planned)
		if err != nil {
			return err
		}
		v.paths = append(v.paths, RuntimePathSnapshot{
			purpose: planned.purpose, class: planned.class, path: planned.path,
			relative: planned.relative, kind: planned.kind, object: cloneObjectSnapshot(file),
		})
	}
	return nil
}

func (v *verifier) openDirectoryBelowRoot(planned plannedPath) (*openedDirectory, error) {
	current := v.directories[v.plan.rootPath]
	path := v.plan.rootPath
	for _, component := range planned.components {
		path = joinPath(path, component)
		if existing := v.directories[path]; existing != nil {
			current = existing
			continue
		}
		child, err := current.handle.OpenDirectoryComponent(component, winfile.OpenOptions{
			VolumeUse:            winfile.VolumeUseWritable,
			DirectoryEnumeration: true,
			SecurityMode:         winfile.SecurityModeManaged,
		})
		if err != nil {
			return nil, verificationError(ErrorFilesystem, "open fixed runtime directory", errors.Join(ErrFilesystem, err))
		}
		opened, err := v.retainDirectory(path, child, directorySecurityRoleDataBoundary)
		if err != nil {
			return nil, err
		}
		v.directories[path] = opened
		current = opened
	}
	return current, nil
}

func (v *verifier) sealClosedDirectories() error {
	for _, closed := range v.plan.closed {
		expected := make([]winfile.DirectoryEntry, 0, len(closed.children))
		for _, child := range closed.children {
			object, exists := v.objectAtPath(child.path, child.kind)
			if !exists {
				return verificationError(ErrorFilesystem, "closed structure child was not retained", ErrFilesystem)
			}
			expected = append(expected, winfile.DirectoryEntry{
				Name: child.name, Kind: child.kind, Identity: object.evidence.Identity,
			})
		}
		if err := v.resources.sealDirectory(closed.path, expected); err != nil {
			return verificationError(
				ErrorFilesystem,
				"closed data-root structure does not match the runtime contract",
				errors.Join(ErrFilesystem, err),
			)
		}
	}
	return nil
}

func (v *verifier) objectAtPath(path string, kind winfile.ObjectKind) (ObjectSnapshot, bool) {
	if kind == winfile.ObjectKindDirectory {
		if directory := v.directories[path]; directory != nil {
			return directory.object, true
		}
		return ObjectSnapshot{}, false
	}
	for _, snapshot := range v.paths {
		if snapshot.path == path && snapshot.kind == kind {
			return snapshot.object, true
		}
	}
	return ObjectSnapshot{}, false
}

func (v *verifier) openRuntimeContentTrees() error {
	visited := make(map[string]struct{})
	for _, planned := range v.plan.directories {
		if planned.class != PathClassRuntimeContent {
			continue
		}
		if _, duplicate := visited[planned.path]; duplicate {
			continue
		}
		visited[planned.path] = struct{}{}
		root := v.directories[planned.path]
		if root == nil {
			return verificationError(ErrorFilesystem, "runtime content root was not retained", ErrFilesystem)
		}
		depth := len(v.plan.root.components) + len(planned.components)
		if err := v.openRuntimeContentDirectory(root, planned.path, depth); err != nil {
			return err
		}
	}
	return nil
}

func (v *verifier) openRuntimeContentDirectory(
	directory *openedDirectory,
	path string,
	depth int,
) error {
	if depth > maximumPathDepth {
		return verificationError(ErrorFilesystem, "runtime content path exceeds the depth limit", ErrFilesystem)
	}
	remaining := maximumRetainedObjects - len(v.resources.values)
	if remaining < 1 {
		return verificationError(ErrorFilesystem, "runtime content exceeds the retained object budget", ErrFilesystem)
	}
	directoryLimit := remaining
	if directoryLimit > maximumRuntimeEntriesPerDirectory {
		directoryLimit = maximumRuntimeEntriesPerDirectory
	}
	listing, err := directory.handle.Enumerate(winfile.DirectoryEnumerationOptions{
		MaximumEntries:             uint32(directoryLimit),
		MaximumNameUTF16Units:      winfile.MaximumDirectoryEntryNameUTF16Units,
		MaximumTotalNameUTF16Units: maximumRuntimeNameUTF16UnitsPerDir,
	})
	if err != nil {
		return verificationError(ErrorFilesystem, "enumerate runtime content directory", errors.Join(ErrFilesystem, err))
	}
	entries := append([]winfile.DirectoryEntry(nil), listing.Entries...)
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name < entries[right].Name })
	expected := make([]winfile.DirectoryEntry, 0, len(entries))
	for _, entry := range entries {
		if cause := context.Cause(v.ctx); cause != nil {
			return cause
		}
		childPath := joinPath(path, entry.Name)
		_, pathErr := parseWindowsPath(childPath, entry.Kind == winfile.ObjectKindFile)
		if pathErr != nil {
			return verificationError(ErrorPath, "runtime content has a noncanonical name", errors.Join(ErrPathPlan, pathErr))
		}
		if entry.Identity.VolumeSerialNumber != directory.object.evidence.Identity.VolumeSerialNumber {
			return verificationError(ErrorIdentity, "runtime content enumeration changed volume", ErrIdentityAlias)
		}
		switch entry.Kind {
		case winfile.ObjectKindDirectory:
			child, openErr := directory.handle.OpenDirectoryComponent(entry.Name, winfile.OpenOptions{
				VolumeUse:            winfile.VolumeUseWritable,
				DirectoryEnumeration: true,
				SecurityMode:         winfile.SecurityModeRoleDataInherited,
			})
			if openErr != nil {
				return verificationError(ErrorFilesystem, "open runtime content directory", errors.Join(ErrFilesystem, openErr))
			}
			opened, retainErr := v.retainDirectory(childPath, child, directorySecurityRoleDataInherited)
			if retainErr != nil {
				return retainErr
			}
			if opened.object.evidence.Identity != entry.Identity {
				return verificationError(ErrorIdentity, "runtime directory identity differs from enumeration", ErrIdentityAlias)
			}
			expected = append(expected, winfile.DirectoryEntry{Name: entry.Name, Kind: entry.Kind, Identity: entry.Identity})
			if err := v.openRuntimeContentDirectory(opened, childPath, depth+1); err != nil {
				return err
			}
		case winfile.ObjectKindFile:
			child, openErr := directory.handle.OpenFileComponent(entry.Name, winfile.OpenOptions{
				VolumeUse: winfile.VolumeUseWritable, SecurityMode: winfile.SecurityModeRoleDataInherited,
			})
			if openErr != nil {
				return verificationError(ErrorFilesystem, "open runtime content file", errors.Join(ErrFilesystem, openErr))
			}
			object, retainErr := v.retainFile(childPath, child)
			if retainErr != nil {
				return retainErr
			}
			if object.evidence.Identity != entry.Identity {
				return verificationError(ErrorIdentity, "runtime file identity differs from enumeration", ErrIdentityAlias)
			}
			expected = append(expected, winfile.DirectoryEntry{Name: entry.Name, Kind: entry.Kind, Identity: entry.Identity})
		default:
			return verificationError(ErrorFilesystem, "runtime content has an unknown object kind", ErrFilesystem)
		}
	}
	if err := v.resources.sealDirectory(path, expected); err != nil {
		return verificationError(ErrorChanged, "runtime content changed during verification", errors.Join(ErrChanged, err))
	}
	return nil
}

func (v *verifier) openFileBelowRoot(planned plannedPath) (ObjectSnapshot, error) {
	if len(planned.components) == 0 {
		return ObjectSnapshot{}, verificationError(ErrorPath, "fixed runtime file has no relative components", ErrPathPlan)
	}
	parentComponents := planned.components[:len(planned.components)-1]
	parentPlan := plannedPath{components: parentComponents}
	parent, err := v.openDirectoryBelowRoot(parentPlan)
	if err != nil {
		return ObjectSnapshot{}, err
	}
	leaf := planned.components[len(planned.components)-1]
	file, err := parent.handle.OpenFileComponent(leaf, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseWritable, SecurityMode: winfile.SecurityModeRoleDataInherited,
	})
	if err != nil {
		return ObjectSnapshot{}, verificationError(ErrorFilesystem, "open fixed runtime file", errors.Join(ErrFilesystem, err))
	}
	path := planned.path
	return v.retainFile(path, file)
}

func (v *verifier) retainFile(path string, file fileHandle) (ObjectSnapshot, error) {
	if len(v.resources.values) >= maximumRetainedObjects {
		return ObjectSnapshot{}, errors.Join(
			verificationError(ErrorFilesystem, "retained object budget exceeded", ErrFilesystem),
			closeRejectedFile(file),
		)
	}
	evidence := file.Evidence()
	if err := validateOpenedEvidence(path, winfile.ObjectKindFile, winfile.SecurityModeRoleDataInherited, evidence); err != nil {
		return ObjectSnapshot{}, errors.Join(
			verificationError(ErrorFilesystem, "fixed runtime file evidence is invalid", errors.Join(ErrFilesystem, err)),
			closeRejectedFile(file),
		)
	}
	object, err := newObjectSnapshot(path, winfile.SecurityModeRoleDataInherited, evidence)
	if err != nil {
		return ObjectSnapshot{}, errors.Join(
			verificationError(ErrorFilesystem, "role data file evidence is invalid", errors.Join(ErrFilesystem, err)),
			closeRejectedFile(file),
		)
	}
	v.resources.addFile(path, file, object)
	if err := v.registerIdentity(path, object.evidence.Identity); err != nil {
		return ObjectSnapshot{}, err
	}
	if err := v.policy.auditFile(object.evidence); err != nil {
		return ObjectSnapshot{}, verificationError(ErrorACL, "role data file ACL is invalid", err)
	}
	return object, nil
}

func (v *verifier) retainDirectory(
	path string,
	handle directoryHandle,
	class directorySecurityClass,
) (*openedDirectory, error) {
	if len(v.resources.values) >= maximumRetainedObjects {
		return nil, errors.Join(
			verificationError(ErrorFilesystem, "retained object budget exceeded", ErrFilesystem),
			closeRejectedDirectory(handle),
		)
	}
	mode := winfile.SecurityModeManaged
	if class == directorySecurityAmbient {
		mode = winfile.SecurityModeAmbientAncestor
	} else if class == directorySecurityRoleDataInherited {
		mode = winfile.SecurityModeRoleDataInherited
	}
	evidence := handle.Evidence()
	if err := validateOpenedEvidence(path, winfile.ObjectKindDirectory, mode, evidence); err != nil {
		return nil, errors.Join(
			verificationError(ErrorFilesystem, "retained directory evidence is invalid", errors.Join(ErrFilesystem, err)),
			closeRejectedDirectory(handle),
		)
	}
	object, err := newObjectSnapshot(path, mode, evidence)
	if err != nil {
		return nil, errors.Join(
			verificationError(ErrorFilesystem, "retained directory evidence is invalid", errors.Join(ErrFilesystem, err)),
			closeRejectedDirectory(handle),
		)
	}
	v.resources.addDirectory(path, handle, object)
	if err := v.registerIdentity(path, object.evidence.Identity); err != nil {
		return nil, err
	}
	if err := v.policy.auditDirectory(object.evidence, class); err != nil {
		return nil, verificationError(ErrorACL, "retained directory ACL is invalid", err)
	}
	caseSensitive, err := handle.ReinspectCaseSensitivity()
	if err != nil {
		return nil, verificationError(ErrorFilesystem, "inspect retained directory case mode", errors.Join(ErrFilesystem, err))
	}
	if caseSensitive {
		return nil, verificationError(ErrorFilesystem, "case-sensitive directories are not supported", winfile.ErrCaseSensitiveDirectory)
	}
	return &openedDirectory{handle: handle, object: object}, nil
}

func validateOpenedEvidence(path string, kind winfile.ObjectKind, mode winfile.SecurityMode, evidence winfile.Evidence) error {
	if evidence.Kind != kind || evidence.SecurityMode != mode || evidence.Path.RequestedPath != path ||
		!evidence.Path.TerminalComponentReparseFree || evidence.Path.Ancestors != winfile.AncestorValidationNotPerformed ||
		evidence.Identity.FileID == ([16]byte{}) {
		return errors.New("object kind, mode, path, reparse, or identity evidence is incomplete")
	}
	if evidence.Path.FinalPathDiagnosticError != "" || evidence.Path.FinalPathDiagnostic != `\\?\`+path {
		return fmt.Errorf("final handle path %q does not exactly match %q", evidence.Path.FinalPathDiagnostic, path)
	}
	return nil
}

func (v *verifier) registerIdentity(path string, identity winfile.FileIdentity) error {
	if previous, exists := v.seen[identity]; exists {
		if previous == path {
			return nil
		}
		return verificationError(
			ErrorIdentity,
			"distinct configured paths identify one filesystem object",
			fmt.Errorf("%w: %s aliases %s", ErrIdentityAlias, path, previous),
		)
	}
	v.seen[identity] = path
	return nil
}

func (v *verifier) bindInstallationRoots() error {
	ownChainPaths := make([]string, 0, len(v.root.ancestors)+1)
	ownChainIDs := make([]winfile.FileIdentity, 0, len(v.root.ancestors)+1)
	for _, ancestor := range v.root.ancestors {
		ownChainPaths = append(ownChainPaths, ancestor.path)
		ownChainIDs = append(ownChainIDs, ancestor.evidence.Identity)
	}
	ownChainPaths = append(ownChainPaths, v.root.path)
	ownChainIDs = append(ownChainIDs, v.root.object.evidence.Identity)
	ownTarget := v.root.object.evidence.Identity

	for _, root := range v.installation.roots {
		if root.target == ownTarget || identityContains(ownChainIDs[:len(ownChainIDs)-1], root.target) ||
			identityContains(root.ancestors, ownTarget) {
			return verificationError(ErrorIdentity, "data root physically overlaps an installation root", ErrIdentityAlias)
		}
		rootPaths := append(append([]string(nil), root.ancestorPaths...), root.path)
		rootIDs := append(append([]winfile.FileIdentity(nil), root.ancestors...), root.target)
		for ownIndex, ownPath := range ownChainPaths {
			for rootIndex, rootPath := range rootPaths {
				samePath := ownPath == rootPath
				sameIdentity := ownChainIDs[ownIndex] == rootIDs[rootIndex]
				if samePath != sameIdentity {
					return verificationError(
						ErrorIdentity,
						"data and installation ancestor paths disagree with physical identities",
						fmt.Errorf("%w: %s and %s", ErrIdentityAlias, ownPath, rootPath),
					)
				}
			}
		}
	}
	return nil
}

func identityContains(values []winfile.FileIdentity, candidate winfile.FileIdentity) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
