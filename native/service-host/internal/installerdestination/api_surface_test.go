package installerdestination_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"runtime"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installerdestination"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/stagedpackage"
)

func TestProductionEntryPointRequiresConcreteTypedGate(t *testing.T) {
	expected := reflect.TypeOf(func(context.Context, stagedpackage.InstallerPackage) (installerdestination.Evidence, error) {
		return installerdestination.Evidence{}, nil
	})
	if reflect.TypeOf(installerdestination.Verify) != expected {
		t.Fatal("Verify accepts paths, detached data, or injected policy instead of the concrete staged gate")
	}
	evidenceType := reflect.TypeOf(installerdestination.Evidence{})
	for index := 0; index < evidenceType.NumField(); index++ {
		if evidenceType.Field(index).IsExported() {
			t.Fatalf("Evidence field %s is exported", evidenceType.Field(index).Name)
		}
	}
	methods := map[string]bool{"Close": false, "Files": false, "MarshalJSON": false, "PackageID": false, "Roots": false, "Validate": false}
	for index := 0; index < evidenceType.NumMethod(); index++ {
		name := evidenceType.Method(index).Name
		if _, allowed := methods[name]; !allowed {
			t.Fatalf("Evidence exposes unexpected method %s", name)
		}
		methods[name] = true
	}
	for name, present := range methods {
		if !present {
			t.Fatalf("Evidence method %s is absent", name)
		}
	}
	zero := installerdestination.Evidence{}
	if !errors.Is(zero.Validate(), installerdestination.ErrInvalidEvidence) ||
		!errors.Is(zero.Close(), installerdestination.ErrInvalidEvidence) || zero.PackageID() != "" ||
		zero.Roots() != nil || zero.Files() != nil {
		t.Fatal("zero Evidence behaved as a successful destination verification")
	}
	if _, err := json.Marshal(zero); !errors.Is(err, installerdestination.ErrSerialization) {
		t.Fatalf("MarshalJSON returned %v, want ErrSerialization", err)
	}
}

func TestPublicVerifyFailsClosedOutsideWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("non-Windows fail-closed contract")
	}
	evidence, err := installerdestination.Verify(context.Background(), stagedpackage.InstallerPackage{})
	if !errors.Is(err, installerdestination.ErrUnsupportedPlatform) || evidence.Validate() == nil {
		t.Fatalf("Verify returned evidence=%#v err=%v", evidence, err)
	}
}
