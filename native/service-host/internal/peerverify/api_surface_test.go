package peerverify

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

func TestPublicProductionAPISurface(t *testing.T) {
	var verifyWindows func(config.Role, *winpipe.Endpoint) (*Session, error) = VerifyWindows
	if verifyWindows == nil {
		t.Fatal("VerifyWindows must remain part of the peerverify production API")
	}
}

func TestSourceRemovesPreflightAuthorityGate(t *testing.T) {
	_, sourcePath, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	packageDirectory := filepath.Dir(sourcePath)
	fileSet := token.NewFileSet()
	packages, err := parser.ParseDir(fileSet, packageDirectory, func(info fs.FileInfo) bool {
		name := info.Name()
		return filepath.Ext(name) == ".go" && filepath.Base(name) != "api_surface_test.go"
	}, 0)
	if err != nil {
		t.Fatalf("parse peerverify package: %v", err)
	}
	packageAST, ok := packages["peerverify"]
	if !ok {
		t.Fatal("peerverify package source is missing")
	}

	for name, parsed := range packageAST.Files {
		for _, declaration := range parsed.Decls {
			switch typed := declaration.(type) {
			case *ast.FuncDecl:
				if typed.Name.Name == "ClaimPreflightWindowsVerifier" {
					t.Fatalf("legacy authority gate function must not exist: %s", filepath.Base(name))
				}
			case *ast.GenDecl:
				for _, specification := range typed.Specs {
					typeSpec, ok := specification.(*ast.TypeSpec)
					if ok && typeSpec.Name.Name == "PreflightWindowsVerifier" {
						t.Fatalf("legacy authority gate type must not exist: %s", filepath.Base(name))
					}
				}
			}
		}
	}
}
