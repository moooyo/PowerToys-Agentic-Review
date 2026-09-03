package installerdestination

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"strconv"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installerprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outeradmission"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/stagedpackage"
)

func productionSource(selection stagedpackage.BearerTokenInstallerV2Package) sourceLease {
	var transferred stagedpackage.BearerTokenInstallerV2DestinationLease
	hasTransferred := false
	return sourceLease{
		withBinding: func(use func(sourcePlan) error) error {
			lease, err := selection.WithDestinationBinding(func(binding stagedpackage.BearerTokenInstallerV2DestinationBinding) error {
				if binding.Validate() != nil {
					return ErrInvalidSource
				}
				plan, err := parseSourcePlan(
					binding.IndexDocument(),
					binding.SignatureEnvelopeDocument(),
					binding.ControlDocument(),
					binding.ExecutorDocument(),
					binding.SignerKeyID(),
				)
				if err != nil {
					return err
				}
				return use(plan)
			})
			if err == nil {
				transferred = lease
				hasTransferred = true
				if lease.Validate() != nil {
					return ErrInvalidSource
				}
			}
			return translateStagedError(err)
		},
		validate: func() error {
			if hasTransferred {
				return translateStagedError(transferred.Validate())
			}
			return translateStagedError(selection.Validate())
		},
		close: func() error {
			if hasTransferred {
				return translateStagedError(transferred.Close())
			}
			return translateStagedError(selection.Close())
		},
		commit: func(operation cleanupOperation, commit func()) error {
			if !hasTransferred || commit == nil {
				return ErrInvalidSource
			}
			destinationCommitted := false
			err := transferred.CommitIfValid(func() {
				if operation.commitWithinPlatformFence(commit) == nil {
					destinationCommitted = true
				}
			})
			if err != nil {
				return translateStagedError(err)
			}
			if !destinationCommitted {
				return ErrCleanupFatal
			}
			return nil
		},
	}
}

func productionAdmitDestination(plan sourcePlan) error {
	admitted, err := outeradmission.Admit(
		plan.indexDocument,
		plan.envelopeDocument,
		plan.controlDocument,
		plan.executorDocument,
	)
	if err != nil || admitted.Validate() != nil || admitted.SignerKeyID() != plan.signerKeyID ||
		!reflect.DeepEqual(admitted.Index(), plan.index) ||
		!reflect.DeepEqual(admitted.ControlConfiguration(), plan.control) ||
		!reflect.DeepEqual(admitted.ExecutorConfiguration(), plan.executor) {
		return errors.Join(ErrInvalidSource, err)
	}
	return nil
}

func translateStagedError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, stagedpackage.ErrCleanupFatal) {
		return errors.Join(ErrCleanupFatal, err)
	}
	return err
}

func parseSourcePlan(indexDocument, envelopeDocument, controlDocument, executorDocument []byte, signerKeyID string) (sourcePlan, error) {
	index, err := outerpackage.ParseIndex(indexDocument)
	if err != nil || index.SchemaVersion != outerpackage.BearerTokenIndexSchemaVersion ||
		index.ProfileID != outerpackage.BearerTokenIndexProfileID || index.MTLSClientCredential != nil ||
		installerprofile.ValidatePackageRoots(
			installerprofile.BearerTokenInstallerV2ID,
			index.PackageID,
			index.TargetRoots.Metadata,
			index.TargetRoots.Installation,
			index.TargetRoots.TrustedConfiguration,
		) != nil {
		return sourcePlan{}, ErrInvalidSource
	}
	envelope, err := outerpackage.ParseSignatureEnvelope(envelopeDocument)
	digest := sha256.Sum256(indexDocument)
	if err != nil || signerKeyID == "" || envelope.SignerKeyID != signerKeyID ||
		envelope.IndexSHA256 != hex.EncodeToString(digest[:]) {
		return sourcePlan{}, ErrInvalidSource
	}
	control, err := config.Parse(controlDocument)
	if err != nil {
		return sourcePlan{}, ErrInvalidSource
	}
	executor, err := config.Parse(executorDocument)
	if err != nil || installerprofile.ValidateBearerTokenBootstrapPair(
		installerprofile.BearerTokenInstallerV2ID,
		control,
		executor,
	) != nil {
		return sourcePlan{}, ErrInvalidSource
	}
	if err := bindBootstrap(index, outerpackage.RoleControlBootstrap, controlDocument); err != nil {
		return sourcePlan{}, err
	}
	if err := bindBootstrap(index, outerpackage.RoleExecutorBootstrap, executorDocument); err != nil {
		return sourcePlan{}, err
	}
	return sourcePlan{
		indexDocument: append([]byte(nil), indexDocument...), envelopeDocument: append([]byte(nil), envelopeDocument...),
		controlDocument: append([]byte(nil), controlDocument...), executorDocument: append([]byte(nil), executorDocument...),
		index: index, control: control, executor: executor, signerKeyID: signerKeyID,
	}, nil
}

func bindBootstrap(index outerpackage.Index, role outerpackage.Role, document []byte) error {
	var found *outerpackage.Payload
	for payloadIndex := range index.Payloads {
		payload := &index.Payloads[payloadIndex]
		if payload.Role == role {
			if found != nil {
				return ErrInvalidSource
			}
			found = payload
		}
	}
	if found == nil {
		return ErrInvalidSource
	}
	digest := sha256.Sum256(document)
	size, err := strconv.ParseUint(found.Size, 10, 64)
	if err != nil || size != uint64(len(document)) || !bytes.Equal([]byte(found.SHA256), []byte(hex.EncodeToString(digest[:]))) {
		return errors.Join(ErrInvalidSource, errors.New("bootstrap bytes differ from the signed index"))
	}
	return nil
}
