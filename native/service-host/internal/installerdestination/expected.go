package installerdestination

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
)

type expectedFile struct {
	role   outerpackage.Role
	digest string
	size   uint64
	exact  []byte
}

type expectedNode struct {
	component string
	children  map[string]*expectedNode
	file      *expectedFile
}

func newExpectedRoot() *expectedNode { return &expectedNode{children: make(map[string]*expectedNode)} }

func (root *expectedNode) addFile(path string, file expectedFile) error {
	if path == "" || strings.HasPrefix(path, `\`) || strings.Contains(path, "/") || strings.Contains(path, ":") {
		return ErrTree
	}
	components := strings.Split(path, `\`)
	node := root
	for index, component := range components {
		if component == "" || component == "." || component == ".." || node.file != nil {
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
			copy.exact = append([]byte(nil), file.exact...)
			node.file = &copy
		}
	}
	return nil
}

func expectedTrees(plan sourcePlan) (map[outerpackage.Root]*expectedNode, error) {
	result := map[outerpackage.Root]*expectedNode{
		outerpackage.RootMetadata:             newExpectedRoot(),
		outerpackage.RootInstallation:         newExpectedRoot(),
		outerpackage.RootTrustedConfiguration: newExpectedRoot(),
	}
	indexDigest := sha256.Sum256(plan.indexDocument)
	if err := result[outerpackage.RootMetadata].addFile(outerpackage.PackageIndexPath, expectedFile{
		digest: hex.EncodeToString(indexDigest[:]), size: uint64(len(plan.indexDocument)), exact: plan.indexDocument,
	}); err != nil {
		return nil, err
	}
	envelopeDigest := sha256.Sum256(plan.envelopeDocument)
	if err := result[outerpackage.RootMetadata].addFile(outerpackage.SignatureEnvelopePath, expectedFile{
		digest: hex.EncodeToString(envelopeDigest[:]), size: uint64(len(plan.envelopeDocument)), exact: plan.envelopeDocument,
	}); err != nil {
		return nil, err
	}
	for _, payload := range plan.index.Payloads {
		size, err := strconv.ParseUint(payload.Size, 10, 64)
		if err != nil || size == 0 {
			return nil, ErrTree
		}
		file := expectedFile{role: payload.Role, digest: payload.SHA256, size: size}
		switch payload.Role {
		case outerpackage.RoleControlBootstrap:
			file.exact = plan.controlDocument
		case outerpackage.RoleExecutorBootstrap:
			file.exact = plan.executorDocument
		}
		if result[payload.Root] == nil || result[payload.Root].addFile(payload.Path, file) != nil {
			return nil, ErrTree
		}
	}
	return result, nil
}

func expectedChild(parent *expectedNode, name string) *expectedNode {
	if parent == nil {
		return nil
	}
	child := parent.children[strings.ToLower(name)]
	if child == nil || child.component != name {
		return nil
	}
	return child
}
