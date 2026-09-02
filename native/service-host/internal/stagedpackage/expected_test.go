package stagedpackage

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
)

func TestBuildExpectedTreesIncludesEveryPayloadAndDetachedEnvelope(t *testing.T) {
	index := validTestIndex(t)
	indexDocument, err := outerpackage.MarshalIndexCanonical(index)
	if err != nil {
		t.Fatal(err)
	}
	trees, err := buildExpectedTrees(index, indexDocument, []byte(`{"signature":"fixture"}`))
	if err != nil {
		t.Fatal(err)
	}
	metadata := trees[outerpackage.RootMetadata]
	if expectedChild(metadata, outerpackage.PackageIndexPath).file.purpose != purposeIndex ||
		expectedChild(metadata, outerpackage.SignatureEnvelopePath).file.purpose != purposeSignature ||
		expectedChild(metadata, outerpackage.PackageDescriptorPath).file.payload.Role !=
			outerpackage.RolePackageDescriptor {
		t.Fatal("metadata tree omitted a fixed transport or payload document")
	}
	for _, payload := range index.Payloads {
		node := trees[payload.Root]
		for _, component := range splitTestPath(payload.Path) {
			node = expectedChild(node, component)
			if node == nil {
				t.Fatalf("payload %s/%s is absent", payload.Root, payload.Path)
			}
		}
		if node.file == nil || node.file.payload == nil || node.file.payload.SHA256 != payload.SHA256 {
			t.Fatalf("payload %s/%s has incomplete expected metadata", payload.Root, payload.Path)
		}
	}
}

func TestExpectedTreeRejectsCaseAliasesAndFileDirectoryCollisions(t *testing.T) {
	root := newExpectedRoot()
	file := expectedFile{purpose: purposeIndex, digest: "digest", size: 1}
	if err := root.addFile(`Folder\item.json`, file); err != nil {
		t.Fatal(err)
	}
	if err := root.addFile(`folder\ITEM.json`, file); !errors.Is(err, ErrTree) {
		t.Fatalf("case alias returned %v, want ErrTree", err)
	}
	if err := root.addFile(`Folder`, file); !errors.Is(err, ErrTree) {
		t.Fatalf("file-directory collision returned %v, want ErrTree", err)
	}
	if err := root.addFile(`Folder\item.json\child`, file); !errors.Is(err, ErrTree) {
		t.Fatalf("descendant below file returned %v, want ErrTree", err)
	}
}

func TestStagedPathValidationRejectsAliasesStreamsAndReservedComponents(t *testing.T) {
	for _, invalid := range []string{
		`c:\Stage`, `C:\Stage\`, `C:\Stage:stream`, `C:\Stage\.`,
		`C:\Stage\CON`, `C:\Stage\name.`, `C:\STAGE~1`, `C:/Stage`,
	} {
		if _, err := parseStagedRootPath(invalid); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("parseStagedRootPath(%q) returned %v", invalid, err)
		}
	}
	parsed, err := parseStagedRootPath(`C:\Staging\Worker Package`)
	if err != nil || parsed.drive != `C:\` || len(parsed.components) != 2 {
		t.Fatalf("valid staging root returned %#v, %v", parsed, err)
	}
}

func splitTestPath(value string) []string {
	var result []string
	start := 0
	for index := 0; index <= len(value); index++ {
		if index == len(value) || value[index] == '\\' {
			result = append(result, value[start:index])
			start = index + 1
		}
	}
	return result
}
