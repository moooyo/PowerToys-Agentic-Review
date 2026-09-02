package stagedpackage

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
)

const outerMaximumFileBytes = outerpackage.MaximumPayloadBytes

type filePurpose uint8

const (
	purposePayload filePurpose = iota + 1
	purposeIndex
	purposeSignature
)

type expectedFile struct {
	purpose filePurpose
	payload *outerpackage.Payload
	digest  string
	size    uint64
}

type expectedNode struct {
	component string
	children  map[string]*expectedNode
	file      *expectedFile
}

func newExpectedRoot() *expectedNode {
	return &expectedNode{children: make(map[string]*expectedNode)}
}

func (root *expectedNode) addFile(path string, file expectedFile) error {
	if err := validateRelativePath(path); err != nil {
		return err
	}
	components := strings.Split(path, `\`)
	node := root
	for index, component := range components {
		if node.file != nil {
			return ErrTree
		}
		key := strings.ToLower(component)
		child := node.children[key]
		if child == nil {
			child = &expectedNode{component: component, children: make(map[string]*expectedNode)}
			node.children[key] = child
		} else if child.component != component {
			return ErrTree
		}
		node = child
		if index == len(components)-1 {
			if node.file != nil || len(node.children) != 0 {
				return ErrTree
			}
			copy := file
			if file.payload != nil {
				payload := *file.payload
				if file.payload.TargetArchitecture != nil {
					architecture := *file.payload.TargetArchitecture
					payload.TargetArchitecture = &architecture
				}
				copy.payload = &payload
			}
			node.file = &copy
		}
	}
	return nil
}

func buildExpectedTrees(
	packageIndex outerpackage.Index,
	indexDocument []byte,
	signatureDocument []byte,
) (map[outerpackage.Root]*expectedNode, error) {
	trees := map[outerpackage.Root]*expectedNode{
		outerpackage.RootMetadata:             newExpectedRoot(),
		outerpackage.RootInstallation:         newExpectedRoot(),
		outerpackage.RootTrustedConfiguration: newExpectedRoot(),
	}
	indexDigest := sha256.Sum256(indexDocument)
	if err := trees[outerpackage.RootMetadata].addFile(outerpackage.PackageIndexPath, expectedFile{
		purpose: purposeIndex,
		digest:  hex.EncodeToString(indexDigest[:]),
		size:    uint64(len(indexDocument)),
	}); err != nil {
		return nil, err
	}
	signatureDigest := sha256.Sum256(signatureDocument)
	if err := trees[outerpackage.RootMetadata].addFile(outerpackage.SignatureEnvelopePath, expectedFile{
		purpose: purposeSignature,
		digest:  hex.EncodeToString(signatureDigest[:]),
		size:    uint64(len(signatureDocument)),
	}); err != nil {
		return nil, err
	}
	for index := range packageIndex.Payloads {
		payload := &packageIndex.Payloads[index]
		tree := trees[payload.Root]
		if tree == nil {
			return nil, ErrTree
		}
		size, err := parseCanonicalSize(payload.Size)
		if err != nil {
			return nil, err
		}
		if err := tree.addFile(payload.Path, expectedFile{
			purpose: purposePayload,
			payload: payload,
			digest:  payload.SHA256,
			size:    size,
		}); err != nil {
			return nil, err
		}
	}
	return trees, nil
}

func expectedChild(parent *expectedNode, name string) *expectedNode {
	if parent == nil {
		return nil
	}
	child := parent.children[strings.ToLower(name)]
	if child != nil && strings.EqualFold(child.component, name) {
		return child
	}
	for _, candidate := range parent.children {
		if strings.EqualFold(candidate.component, name) {
			return candidate
		}
	}
	return nil
}
