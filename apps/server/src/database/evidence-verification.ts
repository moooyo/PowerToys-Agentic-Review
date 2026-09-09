import type { DatabaseSync } from "node:sqlite";
import type { ValidationJobResult } from "@agentic-review/codex";
import {
  type DashboardReviewRunReadQuery,
  type DashboardReviewRunResultQuery,
  type EvaluationCellResultReadQuery,
  type EvidenceAssetManifest,
  type FinalizeEvidenceUploadRequest,
  type JobExecutionTemplateV2,
  JobExecutionTemplateV2Schema,
  maximumAttemptEvidenceAssets,
  type ReproductionObservationFact,
  type ReviewRunPlannedJob,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { ReviewResultInvalidError } from "./errors.js";
import {
  type EvaluationBatchEvidenceQuery,
  readEvaluationBatchEvidenceSelectionInTransaction,
} from "./evaluation-batch-selection.js";
import {
  readEvaluationResultIdentityInTransaction,
  readEvaluationResultSelectionInTransaction,
} from "./evaluation-result-selection.js";
import {
  commitVerifiedEvidenceFinalization,
  EvidenceStorageError,
  type EvidenceStorageOptions,
  type EvidenceVerificationCandidate,
  finalizedEvidenceReferences,
  prepareEvidenceFinalizationCandidate,
  readEvidenceStorageKey,
  readEvidenceVerificationCandidate,
} from "./evidence-assets.js";
import { inspectEvidenceFile, inspectEvidenceRoot } from "./evidence-files.js";
import {
  EvidenceVerificationClient,
  type EvidenceVerificationRequestOptions,
} from "./evidence-verification-client.js";
import {
  type AssetAttestation,
  AssetAttestationSchema,
  type AssetVerificationSnapshot,
  checkAssetSnapshot,
  checkScenarioObservationAttestation,
  checkVerificationSchema,
  type EvidenceFileIdentity,
  type EvidenceRootIdentity,
  EvidenceVerificationError,
  type EvidenceVerificationFailureCode,
  type EvidenceVerificationRoot,
  evidenceSnapshotDigest,
  type IdentityAttestation,
  IdentityAttestationSchema,
  type IdentityProbeSnapshot,
  maximumIdentityProbeAssets,
  type ScenarioAttestation,
  ScenarioAttestationSchema,
  type ScenarioVerificationSnapshot,
  sameEvidenceIdentity,
  verificationFailure,
} from "./evidence-verification-protocol.js";
import type { ReviewCompletionJobContext } from "./review-results.js";
import { handleReviewRunRequest, type ReviewRunDetail } from "./review-runs.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import { readValidationModelResultBindingInTransaction } from "./validation-model-result-binding.js";
import {
  collectValidationCompletionEvidence,
  type ValidationCompletionEvidenceCollection,
  type ValidationEvidenceReferenceScope,
} from "./validation-results.js";
import type { ValidationSummaryInputEvidenceCollection } from "./validation-summary-inputs.js";

export interface EvidenceVerifier {
  verifyAsset(
    snapshot: AssetVerificationSnapshot,
    signal: AbortSignal,
    options?: EvidenceVerificationRequestOptions,
  ): Promise<AssetAttestation>;
  verifyScenario(
    snapshot: ScenarioVerificationSnapshot,
    signal: AbortSignal,
    options?: EvidenceVerificationRequestOptions,
  ): Promise<ScenarioAttestation>;
  probeIdentities(
    snapshot: IdentityProbeSnapshot,
    signal: AbortSignal,
  ): Promise<IdentityAttestation>;
  peekAssetAttestation(snapshot: AssetVerificationSnapshot): AssetAttestation | null;
  peekScenarioAttestation(snapshot: ScenarioVerificationSnapshot): ScenarioAttestation | null;
  close(): Promise<void>;
}

export interface EvidenceVerificationCoordinatorOptions {
  readonly storage: EvidenceStorageOptions;
  readonly verifier?: EvidenceVerifier;
  readonly createVerifier?: (root: EvidenceVerificationRoot) => EvidenceVerifier;
  readonly now?: () => string;
  readonly foregroundTimeoutMs?: number;
  readonly maximumForeground?: number;
  readonly maximumBackground?: number;
  readonly closeTimeoutMs?: number;
}

// Only this coordinator's WeakMaps give these objects authority. They are not wire contracts.
// Consume the returned token in the immediate synchronous commit/projection after preflight;
// another event-loop turn expires it and requires a new preflight.
export interface PreparedEvidence {
  readonly kind: "prepared_evidence";
}
export interface PreparedFinalization {
  readonly kind: "prepared_finalization";
}
export type RunEvidenceReadQuery = DashboardReviewRunReadQuery | DashboardReviewRunResultQuery;
export interface PreparedRunEvidence {
  readonly prepared: PreparedEvidence;
  readonly profiles: {
    readonly requestId: string;
    readonly jobId: string;
    readonly status: "verified" | "pending" | "unavailable";
    readonly code?: EvidenceVerificationFailureCode;
  }[];
}

interface EvaluationBatchCellEvidence {
  readonly cellId: string;
  readonly requestId: string;
  readonly jobId: string | null;
  readonly resultId: string | null;
  verification: {
    readonly status: "verified" | "pending" | "unavailable";
    readonly code?: EvidenceVerificationFailureCode;
  } | null;
}
export interface PreparedEvaluationBatchEvidence {
  readonly prepared: PreparedEvidence;
  readonly selectionDigest: string;
  readonly cells: readonly EvaluationBatchCellEvidence[];
}

interface LeaseIdentityStamp {
  readonly kind: "completion";
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly fingerprint: string;
}
interface ReadIdentityStamp {
  readonly kind: "read";
  readonly repositoryId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly jobId: string;
  readonly resultId: string;
  readonly resultDigest: string;
  readonly latestActivation: number;
}
interface EvaluationReadIdentityStamp {
  readonly kind: "evaluation_read";
  readonly query: EvaluationCellResultReadQuery;
  readonly identityDigest: string;
  readonly requestId: string;
  readonly jobId: string;
}
type ProfileIdentity = LeaseIdentityStamp | ReadIdentityStamp | EvaluationReadIdentityStamp;
interface ProfileInput {
  readonly key: string;
  readonly identity: ProfileIdentity;
  readonly template: JobExecutionTemplateV2;
  readonly request: ReviewRunPlannedJob;
  readonly result: Pick<ValidationJobResult, "report">;
  readonly resultDigest: string;
  readonly scopes: readonly ValidationEvidenceReferenceScope[];
  readonly expectedStepsJsonSha256?: Readonly<Record<string, string>>;
}
interface AssetFact {
  readonly assetId: string;
  readonly scope: ValidationEvidenceReferenceScope;
  readonly metadataFingerprint: string;
  readonly snapshotDigest: string;
  readonly storage: EvidenceRootIdentity;
  readonly expectedFile: EvidenceFileIdentity;
}
interface ProfileProof {
  readonly identity: ProfileIdentity;
  reusable: boolean;
  readonly assets: AssetFact[];
  readonly referenceScopes: Set<string>;
  readonly scenarioScopes: Set<string>;
  readonly scenarioObservations: Map<string, ReproductionObservationFact[]>;
}
interface PreparedRecord {
  readonly profiles: ProfileProof[];
  readonly summaryInputFingerprint?: string;
  readonly read?: { readonly query: RunEvidenceReadQuery; readonly selectionDigest: string };
  readonly evaluationRead?: {
    readonly query: EvaluationCellResultReadQuery;
    readonly identityDigest: string | null;
  };
  readonly evaluationBatchRead?: {
    readonly query: EvaluationBatchEvidenceQuery;
    readonly selectionDigest: string;
  };
}
interface FinalizationRecord {
  readonly input: FinalizeEvidenceUploadRequest;
  readonly metadataFingerprint: string;
  readonly snapshot: AssetVerificationSnapshot;
  readonly attestation: AssetAttestation;
}
interface ReadSelection {
  request_id: string;
  job_id: string;
  activation_number: number;
  latest_activation: number;
  job_status: string;
  result_id: string | null;
  result_digest: string | null;
}

const maximumProfileMarkers = 10_000;
const scopeKey = (scope: ValidationEvidenceReferenceScope): string =>
  evidenceSnapshotDigest({ ...scope, evidenceIds: [...scope.evidenceIds].sort() });
const rootKey = (root: EvidenceRootIdentity): string =>
  evidenceSnapshotDigest({ storageKey: root.storageKey, device: root.device, inode: root.inode });

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum)
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  return actual;
}

/** Owns SQLite snapshots and admission; the verifier never receives a database or lease token. */
export class EvidenceVerificationCoordinator {
  readonly #database: DatabaseSync;
  readonly #storage: EvidenceStorageOptions;
  readonly #now: () => string;
  readonly #foregroundTimeout: number;
  readonly #foregroundLimit: number;
  readonly #backgroundLimit: number;
  readonly #closeTimeout: number;
  readonly #createVerifier: (root: EvidenceVerificationRoot) => EvidenceVerifier;
  readonly #controllers = new Set<AbortController>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #background = new Map<string, Promise<void>>();
  readonly #ready = new Map<string, "cacheable" | "fresh_only">();
  readonly #failures = new Map<string, EvidenceVerificationFailureCode>();
  readonly #prepared = new WeakMap<PreparedEvidence, PreparedRecord>();
  readonly #finalizations = new WeakMap<PreparedFinalization, FinalizationRecord>();
  #verifier: EvidenceVerifier | undefined;
  #verifierRoot: string | undefined;
  #foreground = 0;
  #draining = false;
  #closePromise: Promise<void> | undefined;

  constructor(database: DatabaseSync, options: EvidenceVerificationCoordinatorOptions) {
    this.#database = database;
    this.#storage = Object.freeze({ ...options.storage });
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#foregroundTimeout = boundedInteger(options.foregroundTimeoutMs, 15_000, 120_000);
    this.#foregroundLimit = boundedInteger(options.maximumForeground, 8, 8);
    this.#backgroundLimit = boundedInteger(options.maximumBackground, 16, 16);
    // The default client allows five seconds for graceful exit and five for termination.
    this.#closeTimeout = boundedInteger(options.closeTimeoutMs, 11_000, 30_000);
    this.#verifier = options.verifier;
    this.#createVerifier =
      options.createVerifier ?? ((storageRoot) => new EvidenceVerificationClient({ storageRoot }));
  }

  prepareCompletionEvidence(
    context: ReviewCompletionJobContext,
    submittedDigest: string,
    result: unknown,
    signal: AbortSignal,
  ): Promise<PreparedEvidence> {
    return this.#foregroundWork(signal, async (owned) => {
      const collection = collectValidationCompletionEvidence(
        this.#database,
        context,
        submittedDigest,
        result,
      );
      const identity: LeaseIdentityStamp = {
        kind: "completion",
        jobId: context.jobId,
        runAttemptId: context.runAttemptId,
        fingerprint: this.#leaseFingerprint(context.jobId, context.runAttemptId),
      };
      const profile = this.#completionProfile(collection, identity);
      this.#validateDeclaredReferences(profile.scopes);
      const proof = await this.#verifyProfile(profile, owned, "foreground", false);
      if (proof === null) verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
      this.#mark(this.#ready, profile.key, proof.reusable ? "cacheable" : "fresh_only");
      return this.#token({ profiles: [proof] });
    });
  }

  prepareValidationSummaryInputEvidence(
    collection: ValidationSummaryInputEvidenceCollection,
    signal: AbortSignal,
  ): Promise<PreparedEvidence> {
    const captured = structuredClone(collection);
    return this.#foregroundWork(signal, async (owned) => {
      const { runner } = captured;
      const identity: LeaseIdentityStamp = {
        kind: "completion",
        jobId: runner.jobId,
        runAttemptId: runner.runAttemptId,
        fingerprint: this.#leaseFingerprint(runner.jobId, runner.runAttemptId),
      };
      const profile: ProfileInput = {
        key: evidenceSnapshotDigest({
          purpose: "summary_input",
          fingerprint: captured.fingerprint,
        }),
        identity,
        template: runner.template,
        request: runner.request,
        result: runner.result,
        resultDigest: captured.fingerprint,
        scopes: captured.scopes,
        expectedStepsJsonSha256: captured.expectedStepsJsonSha256,
      };
      this.#validateDeclaredReferences(profile.scopes);
      const proof = await this.#verifyProfile(profile, owned, "foreground", false);
      if (proof === null) verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
      return this.#token({ profiles: [proof], summaryInputFingerprint: captured.fingerprint });
    });
  }

  assertPreparedSummaryInput(prepared: PreparedEvidence, fingerprint: string): void {
    if (this.#prepared.get(prepared)?.summaryInputFingerprint !== fingerprint)
      verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    this.assertPreparedEvidence(prepared);
  }

  prepareFinalizeEvidence(
    input: FinalizeEvidenceUploadRequest,
    signal: AbortSignal,
  ): Promise<PreparedFinalization> {
    return this.#foregroundWork(signal, async (owned) => {
      const captured = structuredClone(input);
      const candidate = prepareEvidenceFinalizationCandidate(this.#database, captured, this.#now());
      const current = () => {
        const next = prepareEvidenceFinalizationCandidate(this.#database, captured, this.#now());
        if (next.metadataToken.fingerprint !== candidate.metadataToken.fingerprint)
          verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
      };
      const root = await this.#wait(
        () => inspectEvidenceRoot(this.#storage.evidenceDirectory, candidate.storageKey),
        owned,
        current,
      );
      const snapshot = await this.#snapshot(candidate, root, owned, current);
      const attestation = await this.#wait(
        () => this.#client(root).verifyAsset(snapshot, owned),
        owned,
        current,
      );
      this.#checkAsset(snapshot, attestation);
      const token = Object.freeze({ kind: "prepared_finalization" as const });
      this.#finalizations.set(token, {
        input: captured,
        metadataFingerprint: candidate.metadataToken.fingerprint,
        snapshot,
        attestation,
      });
      setImmediate(() => this.#finalizations.delete(token));
      return token;
    });
  }

  /** This is synchronous and owns only the existing short rename/SQLite commit transaction. */
  commitPreparedFinalization(prepared: PreparedFinalization): EvidenceAssetManifest {
    this.#outside();
    const record = this.#finalizations.get(prepared);
    if (!record) verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    const current = prepareEvidenceFinalizationCandidate(this.#database, record.input, this.#now());
    if (current.metadataToken.fingerprint !== record.metadataFingerprint)
      verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
    const result = commitVerifiedEvidenceFinalization(
      this.#database,
      record.input,
      record.snapshot,
      record.attestation,
      this.#now(),
      this.#storage,
    );
    this.#finalizations.delete(prepared);
    return result;
  }

  prepareRunReadEvidence(
    query: RunEvidenceReadQuery,
    signal: AbortSignal,
    options: { readonly background?: boolean } = {},
  ): Promise<PreparedRunEvidence> {
    return this.#foregroundWork(signal, async (owned) => {
      const captured = structuredClone(query);
      const run = this.#readRun(captured);
      const selection = this.#readSelection(captured);
      const prepared: PreparedRecord = {
        profiles: [],
        read: { query: captured, selectionDigest: evidenceSnapshotDigest(selection) },
      };
      const profiles: PreparedRunEvidence["profiles"] = [];
      if (run === null) return { prepared: this.#token(prepared), profiles };
      for (const selected of selection) {
        if (
          selected.result_id === null ||
          selected.result_digest === null ||
          selected.job_status !== "succeeded"
        )
          continue;
        const profile = this.#evaluationReadTransaction(() => this.#readProfile(run, selected));
        let code = this.#failures.get(profile.key);
        let status: "verified" | "pending" | "unavailable" = this.#readFailureStatus(code);
        if (this.#ready.has(profile.key)) {
          try {
            const proof = await this.#verifyProfile(
              profile,
              owned,
              "foreground",
              this.#ready.get(profile.key) === "cacheable",
            );
            if (proof !== null) {
              this.#mark(this.#ready, profile.key, proof.reusable ? "cacheable" : "fresh_only");
              prepared.profiles.push(proof);
              status = "verified";
              code = undefined;
            } else this.#ready.delete(profile.key);
          } catch (error) {
            this.#assertAvailable(owned);
            code = this.#failureCode(error);
            status = this.#readFailureStatus(code);
            this.#ready.delete(profile.key);
          }
        }
        if (status !== "verified" && options.background !== false) {
          if (!this.#startBackground(profile)) code = "EVIDENCE_VERIFIER_BUSY";
        }
        profiles.push({
          requestId: selected.request_id,
          jobId: selected.job_id,
          status,
          ...(code === undefined ? {} : { code }),
        });
      }
      if (
        evidenceSnapshotDigest(this.#readSelection(captured)) !== prepared.read?.selectionDigest
      ) {
        prepared.profiles.splice(0);
        for (const profile of profiles)
          Object.assign(profile, { status: "pending", code: "EVIDENCE_VERIFIER_UNAVAILABLE" });
        // Rebind an empty projection to the current selection; the caller can return pending once.
        return {
          prepared: this.#token({
            profiles: [],
            read: {
              query: captured,
              selectionDigest: evidenceSnapshotDigest(this.#readSelection(captured)),
            },
          }),
          profiles,
        };
      }
      return { prepared: this.#token(prepared), profiles };
    });
  }

  prepareEvaluationCellReadEvidence(
    query: EvaluationCellResultReadQuery,
    signal: AbortSignal,
  ): Promise<PreparedRunEvidence> {
    const captured = structuredClone(query);
    return this.#foregroundWork(signal, async (owned) => {
      const selected = this.#evaluationReadTransaction(() =>
        readEvaluationResultSelectionInTransaction(this.#database, captured),
      );
      const record: PreparedRecord = {
        profiles: [],
        evaluationRead: { query: captured, identityDigest: selected?.identityDigest ?? null },
      };
      if (selected === null) return { prepared: this.#token(record), profiles: [] };
      if (
        selected.template.validation.schemaVersion !== "ValidationJobContextV2" ||
        selected.cell.repositoryId !== captured.repositoryId ||
        selected.cell.evaluationId !== captured.evaluationId ||
        selected.cell.cellId !== captured.cellId ||
        selected.row.id !== captured.resultId ||
        selected.row.requestId !== selected.cell.requestId
      )
        verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
      const identity: EvaluationReadIdentityStamp = {
        kind: "evaluation_read",
        query: captured,
        identityDigest: selected.identityDigest,
        requestId: selected.row.requestId,
        jobId: selected.row.jobId,
      };
      const profile: ProfileInput = {
        key: evidenceSnapshotDigest({
          purpose: "evaluation_read",
          query: captured,
          validation: selected.template.validation,
          resultDigest: selected.row.resultDigest,
        }),
        identity,
        template: selected.template,
        request: selected.cell.request,
        result: selected.result,
        resultDigest: selected.row.resultDigest,
        scopes: selected.scopes,
      };
      let status: "verified" | "pending" | "unavailable" = "pending";
      let code: EvidenceVerificationFailureCode | undefined;
      try {
        this.#validateDeclaredReferences(profile.scopes);
        // A cold evaluation result read performs foreground verification immediately.
        // Cached attestations still require the existing fresh identity probes.
        const proof = await this.#verifyProfile(profile, owned, "foreground", false);
        this.#assertIdentity(identity);
        this.#assertAvailable(owned);
        if (proof === null) verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
        record.profiles.push(proof);
        status = "verified";
      } catch (error) {
        // A changed result selection cannot be converted into a stale pending projection.
        this.#assertIdentity(identity);
        this.#assertAvailable(signal);
        code = this.#failureCode(error);
        status = this.#readFailureStatus(code);
      }
      return {
        prepared: this.#token(record),
        profiles: [
          {
            requestId: selected.row.requestId,
            jobId: selected.row.jobId,
            status,
            ...(code === undefined ? {} : { code }),
          },
        ],
      };
    });
  }

  /** One foreground operation and one expiring proof cover the complete sealed cell selection. */
  prepareEvaluationBatchReadEvidence(
    query: EvaluationBatchEvidenceQuery,
    signal: AbortSignal,
  ): Promise<PreparedEvaluationBatchEvidence> {
    const captured = structuredClone(query);
    return this.#foregroundWork(signal, async (owned) => {
      const selection = this.#evaluationReadTransaction(() =>
        readEvaluationBatchEvidenceSelectionInTransaction(this.#database, captured),
      );
      const record: PreparedRecord = {
        profiles: [],
        evaluationBatchRead: { query: captured, selectionDigest: selection.selectionDigest },
      };
      const cells: EvaluationBatchCellEvidence[] = selection.cells.map((cell) => ({
        ...cell,
        verification: null,
      }));
      const proofs = new Map<ProfileProof, EvaluationBatchCellEvidence>();
      const assertSelection = () =>
        this.#assertEvaluationBatchSelection(captured, selection.selectionDigest);
      for (const cell of cells) {
        this.#assertAvailable(owned);
        assertSelection();
        if (cell.resultId === null) continue;
        const resultQuery: EvaluationCellResultReadQuery = {
          ...captured,
          cellId: cell.cellId,
          resultId: cell.resultId,
        };
        const selected = this.#evaluationReadTransaction(() =>
          readEvaluationResultSelectionInTransaction(this.#database, resultQuery),
        );
        if (
          selected === null ||
          selected.template.validation.schemaVersion !== "ValidationJobContextV2" ||
          selected.cell.repositoryId !== captured.repositoryId ||
          selected.cell.evaluationId !== captured.evaluationId ||
          selected.cell.cellId !== cell.cellId ||
          selected.row.id !== cell.resultId ||
          selected.row.jobId !== cell.jobId ||
          selected.row.requestId !== cell.requestId ||
          selected.row.requestId !== selected.cell.requestId
        )
          verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
        const identity: EvaluationReadIdentityStamp = {
          kind: "evaluation_read",
          query: resultQuery,
          identityDigest: selected.identityDigest,
          requestId: selected.row.requestId,
          jobId: selected.row.jobId,
        };
        const profile: ProfileInput = {
          key: evidenceSnapshotDigest({
            purpose: "evaluation_read",
            query: resultQuery,
            validation: selected.template.validation,
            resultDigest: selected.row.resultDigest,
          }),
          identity,
          template: selected.template,
          request: selected.cell.request,
          result: selected.result,
          resultDigest: selected.row.resultDigest,
          scopes: selected.scopes,
        };
        try {
          this.#validateDeclaredReferences(profile.scopes);
          const proof = await this.#verifyProfile(profile, owned, "foreground", false);
          this.#assertAvailable(owned);
          assertSelection();
          this.#assertIdentity(identity);
          if (proof === null) verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
          if (
            profile.result.report.checks.some((check) => {
              if (check.kind !== "ui") return false;
              const scope = profile.scopes.find((entry) => entry.checkId === check.id);
              return scope === undefined || !proof.scenarioScopes.has(scopeKey(scope));
            })
          )
            verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
          proofs.set(proof, cell);
          cell.verification = { status: "verified" };
        } catch (error) {
          this.#assertAvailable(owned);
          assertSelection();
          this.#assertIdentity(identity);
          cell.verification = {
            status: "unavailable",
            code: this.#evaluationBatchFailure(error),
          };
        }
      }
      // Earlier cells can change while later cells are verified. Re-probe the whole retained set.
      await this.#probeEvaluationBatchProofs(proofs, owned, assertSelection);
      this.#assertAvailable(owned);
      assertSelection();
      for (const [proof, cell] of proofs) {
        this.#assertIdentity(proof.identity);
        try {
          for (const asset of proof.assets) this.#assertFact(asset);
        } catch (error) {
          cell.verification = { status: "unavailable", code: this.#evaluationBatchFailure(error) };
          proofs.delete(proof);
        }
      }
      record.profiles.push(...proofs.keys());
      return { prepared: this.#token(record), selectionDigest: selection.selectionDigest, cells };
    });
  }

  /** Call before the final synchronous validator/projection, outside its error-to-bad-ref adapter. */
  assertPreparedEvidence(prepared: PreparedEvidence): void {
    this.#assertAvailable();
    const record = this.#prepared.get(prepared);
    if (!record) verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    if (
      record.read &&
      evidenceSnapshotDigest(this.#readSelection(record.read.query)) !== record.read.selectionDigest
    )
      verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
    if (
      record.evaluationRead &&
      (this.#readEvaluationIdentity(record.evaluationRead.query)?.identityDigest ?? null) !==
        record.evaluationRead.identityDigest
    )
      verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
    if (record.evaluationBatchRead)
      this.#assertEvaluationBatchSelection(
        record.evaluationBatchRead.query,
        record.evaluationBatchRead.selectionDigest,
      );
    for (const profile of record.profiles) {
      this.#assertIdentity(profile.identity);
      for (const asset of profile.assets) this.#assertFact(asset);
    }
  }

  admittedEvidenceReferences(
    prepared: PreparedEvidence,
    scope: ValidationEvidenceReferenceScope,
  ): boolean {
    this.#assertAvailable();
    const record = this.#prepared.get(prepared);
    if (!record) return false;
    const key = scopeKey(scope);
    const profile = record.profiles.find((candidate) => candidate.referenceScopes.has(key));
    if (!profile) return false;
    this.#assertIdentity(profile.identity);
    for (const id of scope.evidenceIds) {
      const asset = profile.assets.find(
        (candidate) => candidate.assetId === id && scopeKey(candidate.scope) === key,
      );
      if (!asset) return false;
      this.#assertFact(asset);
    }
    return true;
  }

  admittedScenarioEvidence(
    prepared: PreparedEvidence,
    scope: ValidationEvidenceReferenceScope,
  ): boolean {
    return (
      this.admittedEvidenceReferences(prepared, scope) &&
      this.#prepared
        .get(prepared)
        ?.profiles.some((profile) => profile.scenarioScopes.has(scopeKey(scope))) === true
    );
  }

  /** Returns only selected typed facts from this operation's current, opaque verification proof. */
  admittedScenarioObservations(
    prepared: PreparedEvidence,
    scope: ValidationEvidenceReferenceScope,
  ): ReproductionObservationFact[] | null {
    if (!this.#prepared.has(prepared)) return null;
    this.assertPreparedEvidence(prepared);
    if (!this.admittedScenarioEvidence(prepared, scope)) return null;
    const key = scopeKey(scope);
    const facts = this.#prepared
      .get(prepared)
      ?.profiles.find((profile) => profile.scenarioScopes.has(key))
      ?.scenarioObservations.get(key);
    return facts === undefined ? null : structuredClone(facts);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#draining = true;
    for (const controller of this.#controllers)
      controller.abort(new EvidenceVerificationError("EVIDENCE_VERIFIER_SHUTDOWN"));
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#pending]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#verifier?.close() ?? Promise.resolve(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new EvidenceVerificationError("EVIDENCE_VERIFIER_TIMEOUT")),
              this.#closeTimeout,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        this.#ready.clear();
        this.#failures.clear();
      }
    })();
    return this.#closePromise;
  }

  #token(record: PreparedRecord): PreparedEvidence {
    this.#assertAvailable();
    const token = Object.freeze({ kind: "prepared_evidence" as const });
    this.#prepared.set(token, record);
    // Only the immediate synchronous projection/commit may consume this operation proof.
    setImmediate(() => this.#prepared.delete(token));
    return token;
  }

  #assertAvailable(signal?: AbortSignal): void {
    if (this.#draining) verificationFailure("EVIDENCE_VERIFIER_SHUTDOWN");
    if (signal?.aborted) {
      if (signal.reason instanceof EvidenceVerificationError) throw signal.reason;
      verificationFailure("EVIDENCE_VERIFIER_CANCELLED");
    }
  }

  #outside(): void {
    this.#assertAvailable();
    if (this.#database.isTransaction) verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  }

  async #wait<T>(start: () => Promise<T>, signal: AbortSignal, revalidate: () => void): Promise<T> {
    this.#outside();
    this.#assertAvailable(signal);
    let onAbort: (() => void) | undefined;
    try {
      const value = await Promise.race([
        start(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () =>
            reject(
              signal.reason instanceof EvidenceVerificationError
                ? signal.reason
                : new EvidenceVerificationError("EVIDENCE_VERIFIER_CANCELLED"),
            );
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
      this.#outside();
      this.#assertAvailable(signal);
      revalidate();
      return value;
    } catch (error) {
      this.#outside();
      this.#assertAvailable(signal);
      revalidate();
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  #foregroundWork<T>(signal: AbortSignal, action: (owned: AbortSignal) => Promise<T>): Promise<T> {
    this.#outside();
    this.#assertAvailable(signal);
    if (this.#foreground >= this.#foregroundLimit)
      return Promise.reject(new EvidenceVerificationError("EVIDENCE_VERIFIER_BUSY"));
    this.#foreground += 1;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    this.#controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(new EvidenceVerificationError("EVIDENCE_VERIFIER_TIMEOUT")),
      this.#foregroundTimeout,
    );
    const pending = Promise.resolve().then(() => {
      this.#assertAvailable(controller.signal);
      return action(controller.signal);
    });
    this.#pending.add(pending);
    void pending
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.#controllers.delete(controller);
        this.#pending.delete(pending);
        this.#foreground -= 1;
      })
      .catch(() => {});
    return pending;
  }

  #startBackground(profile: ProfileInput): boolean {
    this.#assertAvailable();
    if (this.#background.has(profile.key)) return true;
    if (this.#background.size >= this.#backgroundLimit) return false;
    const controller = new AbortController();
    this.#controllers.add(controller);
    const task = Promise.resolve()
      .then(async () => {
        try {
          const proof = await this.#verifyProfile(profile, controller.signal, "background", false);
          this.#assertAvailable(controller.signal);
          if (proof) {
            this.#mark(this.#ready, profile.key, proof.reusable ? "cacheable" : "fresh_only");
            this.#failures.delete(profile.key);
          }
        } catch (error) {
          if (!this.#draining) this.#mark(this.#failures, profile.key, this.#failureCode(error));
        }
      })
      .finally(() => {
        this.#background.delete(profile.key);
        this.#pending.delete(task);
        this.#controllers.delete(controller);
      });
    this.#background.set(profile.key, task);
    this.#pending.add(task);
    return true;
  }

  #mark<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > maximumProfileMarkers) map.delete(map.keys().next().value as string);
  }

  #readFailureStatus(code: EvidenceVerificationFailureCode | undefined): "pending" | "unavailable" {
    return code === undefined ||
      code === "EVIDENCE_VERIFIER_BUSY" ||
      code === "EVIDENCE_VERIFIER_TIMEOUT" ||
      code === "EVIDENCE_VERIFIER_CANCELLED" ||
      code === "EVIDENCE_VERIFIER_UNAVAILABLE"
      ? "pending"
      : "unavailable";
  }
  #failureCode(error: unknown): EvidenceVerificationFailureCode {
    return error instanceof EvidenceVerificationError ? error.code : "EVIDENCE_FILE_UNAVAILABLE";
  }

  #evaluationBatchFailure(error: unknown): EvidenceVerificationFailureCode {
    if (
      error instanceof EvidenceVerificationError &&
      [
        "EVIDENCE_FILE_UNAVAILABLE",
        "EVIDENCE_FILE_CHANGED",
        "EVIDENCE_INTEGRITY_FAILED",
        "EVIDENCE_SCENARIO_MISMATCH",
        "EVIDENCE_VERIFIER_UNAVAILABLE",
      ].includes(error.code)
    )
      return error.code;
    if (
      error instanceof ReviewResultInvalidError ||
      (error instanceof EvidenceStorageError &&
        ["EVIDENCE_NOT_FOUND", "EVIDENCE_UNAVAILABLE"].includes(error.code))
    )
      return "EVIDENCE_FILE_UNAVAILABLE";
    // Busy, timeout, cancellation, protocol and structural errors invalidate the entire operation.
    throw error;
  }

  async #probeEvaluationBatchProofs(
    proofs: Map<ProfileProof, EvaluationBatchCellEvidence>,
    signal: AbortSignal,
    assertSelection: () => void,
  ): Promise<void> {
    interface Entry {
      readonly fact: AssetFact;
      readonly profiles: Set<ProfileProof>;
    }
    const roots = new Map<string, { storage: EvidenceRootIdentity; assets: Map<string, Entry> }>();
    for (const proof of proofs.keys()) {
      for (const fact of proof.assets) {
        const key = rootKey(fact.storage);
        let group = roots.get(key);
        if (group === undefined) {
          group = { storage: fact.storage, assets: new Map() };
          roots.set(key, group);
        }
        const entry = group.assets.get(fact.assetId);
        if (entry === undefined)
          group.assets.set(fact.assetId, { fact, profiles: new Set([proof]) });
        else {
          if (
            entry.fact.metadataFingerprint !== fact.metadataFingerprint ||
            !sameEvidenceIdentity(entry.fact.expectedFile, fact.expectedFile)
          )
            verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
          entry.profiles.add(proof);
        }
      }
    }
    for (const group of roots.values()) {
      const entries = [...group.assets.values()];
      for (let offset = 0; offset < entries.length; offset += maximumIdentityProbeAssets) {
        this.#assertAvailable(signal);
        assertSelection();
        const current = entries
          .slice(offset, offset + maximumIdentityProbeAssets)
          .filter((entry) => [...entry.profiles].some((proof) => proofs.has(proof)));
        if (current.length === 0) continue;
        const affected = new Set(current.flatMap((entry) => [...entry.profiles]));
        const snapshot: IdentityProbeSnapshot = {
          storage: group.storage,
          assets: current.map(({ fact }) => ({
            assetId: fact.assetId,
            state: "finalized",
            expectedFile: fact.expectedFile,
          })),
        };
        const revalidate = () => {
          assertSelection();
          for (const proof of affected) if (proofs.has(proof)) this.#assertProof(proof);
        };
        try {
          const root: EvidenceVerificationRoot = {
            ...group.storage,
            directory: this.#storage.evidenceDirectory,
          };
          const attestation = await this.#wait(
            () => this.#client(root).probeIdentities(snapshot, signal),
            signal,
            revalidate,
          );
          checkVerificationSchema(IdentityAttestationSchema, attestation);
          if (
            attestation.snapshotDigest !== evidenceSnapshotDigest(snapshot) ||
            rootKey(attestation.storage) !== rootKey(snapshot.storage) ||
            attestation.assets.length !== current.length ||
            attestation.assets.some((asset, index) => {
              const expected = snapshot.assets[index];
              return (
                !expected || asset.assetId !== expected.assetId || asset.state !== expected.state
              );
            })
          )
            verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
          const changed = current.filter(({ fact }, index) => {
            const asset = attestation.assets[index];
            return (
              asset === undefined ||
              !sameEvidenceIdentity(asset.before, fact.expectedFile) ||
              !sameEvidenceIdentity(asset.after, fact.expectedFile)
            );
          });
          if (attestation.matches !== (changed.length === 0))
            verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
          for (const entry of changed) {
            for (const proof of entry.profiles) {
              const cell = proofs.get(proof);
              if (cell !== undefined)
                cell.verification = { status: "unavailable", code: "EVIDENCE_FILE_CHANGED" };
              proofs.delete(proof);
            }
          }
        } catch (error) {
          this.#assertAvailable(signal);
          assertSelection();
          for (const proof of affected) if (proofs.has(proof)) this.#assertIdentity(proof.identity);
          const code = this.#evaluationBatchFailure(error);
          for (const proof of affected) {
            const cell = proofs.get(proof);
            if (cell !== undefined) cell.verification = { status: "unavailable", code };
            proofs.delete(proof);
          }
        }
      }
    }
  }

  #client(root: EvidenceVerificationRoot): EvidenceVerifier {
    const key = rootKey(root);
    if (this.#verifierRoot !== undefined && this.#verifierRoot !== key)
      verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
    this.#verifierRoot = key;
    this.#verifier ??= this.#createVerifier(root);
    return this.#verifier;
  }

  #completionProfile(
    collection: ValidationCompletionEvidenceCollection,
    identity: ProfileIdentity,
  ): ProfileInput {
    const validation = collection.template.validation;
    return {
      key: evidenceSnapshotDigest({ validation, resultDigest: collection.canonical.resultDigest }),
      identity,
      template: collection.template,
      request: collection.request,
      result: collection.result,
      resultDigest: collection.canonical.resultDigest,
      scopes: collection.scopes,
    };
  }

  #validateDeclaredReferences(scopes: readonly ValidationEvidenceReferenceScope[]): void {
    const ids = new Set(scopes.flatMap((scope) => [...scope.evidenceIds]));
    if (
      ids.size > maximumAttemptEvidenceAssets ||
      scopes.some((scope) => !finalizedEvidenceReferences(this.#database, scope))
    )
      throw new ReviewResultInvalidError(
        "The validation report references unknown or cross-scope evidence assets.",
      );
  }

  #candidate(
    scope: ValidationEvidenceReferenceScope,
    assetId: string,
  ): EvidenceVerificationCandidate {
    const candidate = readEvidenceVerificationCandidate(this.#database, { ...scope, assetId });
    if (candidate === null) verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
    return candidate;
  }

  async #snapshot(
    candidate: EvidenceVerificationCandidate,
    root: EvidenceVerificationRoot,
    signal: AbortSignal,
    revalidate: () => void,
  ): Promise<AssetVerificationSnapshot> {
    const expectedFile = await this.#wait(
      () =>
        inspectEvidenceFile(root, {
          assetId: candidate.asset.id,
          state: candidate.asset.state,
          ...candidate.fileBinding,
        }),
      signal,
      revalidate,
    );
    const snapshot: AssetVerificationSnapshot = {
      storage: { storageKey: root.storageKey, device: root.device, inode: root.inode },
      asset: candidate.asset,
      manifestDigest: candidate.manifestDigest,
      expectedFile,
      chunks: candidate.chunks,
    };
    checkAssetSnapshot(snapshot);
    return snapshot;
  }

  async #verifyProfile(
    profile: ProfileInput,
    signal: AbortSignal,
    priority: "foreground" | "background",
    cacheOnly: boolean,
  ): Promise<ProfileProof | null> {
    this.#outside();
    this.#assertAvailable(signal);
    this.#assertIdentity(profile.identity);
    const proof: ProfileProof = {
      identity: profile.identity,
      reusable: true,
      assets: [],
      referenceScopes: new Set(),
      scenarioScopes: new Set(),
      scenarioObservations: new Map(),
    };
    if (profile.scopes.length === 0) return proof;
    const storageKey = readEvidenceStorageKey(this.#database);
    const root = await this.#wait(
      () => inspectEvidenceRoot(this.#storage.evidenceDirectory, storageKey),
      signal,
      () => this.#assertIdentity(profile.identity),
    );
    const client = this.#client(root);
    for (const scope of profile.scopes) {
      const snapshots: AssetVerificationSnapshot[] = [];
      for (const assetId of scope.evidenceIds) {
        const candidate = this.#candidate(scope, assetId);
        if (
          candidate.storageKey !== root.storageKey ||
          candidate.asset.scope.planDigest !== profile.template.validation.planDigest ||
          candidate.asset.scope.revisionKey !== profile.template.validation.revisionKey
        )
          verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
        const current = () => {
          this.#assertProof(proof);
          if (
            this.#candidate(scope, assetId).metadataToken.fingerprint !==
            candidate.metadataToken.fingerprint
          )
            verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
        };
        const snapshot = await this.#snapshot(candidate, root, signal, current);
        const expectedJsonSha256 = profile.expectedStepsJsonSha256?.[assetId];
        if (expectedJsonSha256 !== undefined) snapshot.expectedJsonSha256 = expectedJsonSha256;
        const attestation = cacheOnly
          ? client.peekAssetAttestation(snapshot)
          : await this.#wait(
              () => client.verifyAsset(snapshot, signal, { priority }),
              signal,
              current,
            );
        if (attestation === null || (cacheOnly && !attestation.verification.reusable)) return null;
        this.#checkAsset(snapshot, attestation);
        proof.reusable &&= attestation.verification.reusable;
        snapshots.push(snapshot);
        proof.assets.push({
          assetId,
          scope,
          metadataFingerprint: candidate.metadataToken.fingerprint,
          snapshotDigest: attestation.snapshotDigest,
          storage: snapshot.storage,
          expectedFile: snapshot.expectedFile,
        });
      }
      proof.referenceScopes.add(scopeKey(scope));
      const scenario = this.#scenarioSnapshot(profile, scope, snapshots);
      if (scenario !== null) {
        try {
          const attestation = cacheOnly
            ? client.peekScenarioAttestation(scenario)
            : await this.#wait(
                () => client.verifyScenario(scenario, signal, { priority }),
                signal,
                () => this.#assertProof(proof),
              );
          if (attestation === null || (cacheOnly && !attestation.verification.reusable))
            return null;
          this.#checkScenario(scenario, attestation);
          proof.reusable &&= attestation.verification.reusable;
          proof.scenarioScopes.add(scopeKey(scope));
          if (attestation.observations !== undefined)
            proof.scenarioObservations.set(
              scopeKey(scope),
              structuredClone(attestation.observations),
            );
        } catch (error) {
          if (
            !(error instanceof EvidenceVerificationError) ||
            error.code !== "EVIDENCE_SCENARIO_MISMATCH"
          )
            throw error;
          // A semantic mismatch keeps the report displayable but grants no scenario completeness.
          // Negative outcomes are current-operation facts, never reusable cache authority.
          proof.reusable = false;
        }
      }
    }
    for (let offset = 0; offset < proof.assets.length; offset += maximumIdentityProbeAssets) {
      const assets = proof.assets.slice(offset, offset + maximumIdentityProbeAssets);
      const probe: IdentityProbeSnapshot = {
        storage: { storageKey: root.storageKey, device: root.device, inode: root.inode },
        assets: assets.map((asset) => ({
          assetId: asset.assetId,
          state: "finalized",
          expectedFile: asset.expectedFile,
        })),
      };
      const attestation = await this.#wait(
        () => client.probeIdentities(probe, signal),
        signal,
        () => this.#assertProof(proof),
      );
      this.#checkProbe(probe, attestation);
    }
    this.#assertProof(proof);
    return proof;
  }

  #scenarioSnapshot(
    profile: ProfileInput,
    scope: ValidationEvidenceReferenceScope,
    assets: AssetVerificationSnapshot[],
  ): ScenarioVerificationSnapshot | null {
    const check = profile.result.report.checks.find((entry) => entry.id === scope.checkId);
    const ui = profile.request.profileVersion?.config.ui;
    if (check?.kind !== "ui" || ui === undefined) return null;
    const scenario = ui.scenarios.find(
      (entry) => `${profile.template.validation.profileVersion.id}:${entry.id}` === scope.checkId,
    );
    const steps = assets.filter((asset) => asset.asset.metadata.kind === "steps");
    // Partial diagnostics remain displayable; absent steps are not an unknown reference.
    if (!scenario || steps.length !== 1) return null;
    const first = steps[0] as AssetVerificationSnapshot;
    const selectedStepIds = new Set<string>();
    for (const item of profile.template.validation.reproduction?.binding.cases ?? []) {
      if (
        item.requestId !== profile.request.requestId ||
        item.profileVersionId !== profile.template.validation.profileVersion.id ||
        item.target !== ui.target
      )
        continue;
      const predicates = [
        ...item.presentWhen.allOf,
        ...(item.absentWhen?.allOf ?? []),
        ...item.preconditions.flatMap((precondition) =>
          precondition.kind === "observation_equals" ? [precondition.predicate] : [],
        ),
      ];
      for (const { observation } of predicates)
        if (observation.kind === "ui_assertion" && observation.scenarioId === scenario.id)
          selectedStepIds.add(observation.stepId);
    }
    const common = {
      storage: first.storage,
      resultDigest: profile.resultDigest,
      steps: first,
      checkOutcome: check.outcome,
      ...(selectedStepIds.size === 0
        ? {}
        : {
            observationSelection: {
              schemaVersion: "UiObservationSelectionV1" as const,
              stepIds: [...selectedStepIds].sort(),
            },
          }),
      dependencies: assets
        .filter((asset) => asset !== first)
        .map(({ asset, manifestDigest, expectedFile }) => ({
          asset,
          manifestDigest,
          expectedFile,
        })),
    };
    return ui.target === "web"
      ? {
          ...common,
          target: "web",
          scenario: scenario as (typeof ui.scenarios)[number],
          policy: ui.evidence,
        }
      : {
          ...common,
          target: "windows_desktop",
          scenario: scenario as (typeof ui.scenarios)[number],
          policy: ui.evidence,
        };
  }

  #checkAsset(snapshot: AssetVerificationSnapshot, attestation: AssetAttestation): void {
    checkVerificationSchema(AssetAttestationSchema, attestation);
    if (
      attestation.snapshotDigest !== evidenceSnapshotDigest(snapshot) ||
      attestation.manifestDigest !== snapshot.manifestDigest ||
      attestation.assetId !== snapshot.asset.id ||
      attestation.sha256 !== snapshot.asset.metadata.sha256 ||
      attestation.sizeBytes !== snapshot.asset.metadata.sizeBytes ||
      rootKey(attestation.storage) !== rootKey(snapshot.storage) ||
      !sameEvidenceIdentity(attestation.before, snapshot.expectedFile) ||
      !sameEvidenceIdentity(attestation.after, snapshot.expectedFile)
    )
      verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
  }

  #checkProbe(snapshot: IdentityProbeSnapshot, attestation: IdentityAttestation): void {
    checkVerificationSchema(IdentityAttestationSchema, attestation);
    if (
      !attestation.matches ||
      attestation.snapshotDigest !== evidenceSnapshotDigest(snapshot) ||
      rootKey(attestation.storage) !== rootKey(snapshot.storage) ||
      attestation.assets.length !== snapshot.assets.length ||
      attestation.assets.some((asset, index) => {
        const expected = snapshot.assets[index];
        return (
          !expected ||
          asset.assetId !== expected.assetId ||
          asset.state !== expected.state ||
          !sameEvidenceIdentity(asset.before, expected.expectedFile) ||
          !sameEvidenceIdentity(asset.after, expected.expectedFile)
        );
      })
    )
      verificationFailure("EVIDENCE_FILE_CHANGED");
  }

  #checkScenario(snapshot: ScenarioVerificationSnapshot, attestation: ScenarioAttestation): void {
    checkVerificationSchema(ScenarioAttestationSchema, attestation);
    checkScenarioObservationAttestation(snapshot, attestation);
    const expected = [snapshot.steps, ...snapshot.dependencies];
    if (
      attestation.snapshotDigest !== evidenceSnapshotDigest(snapshot) ||
      attestation.resultDigest !== snapshot.resultDigest ||
      rootKey(attestation.storage) !== rootKey(snapshot.storage) ||
      attestation.scenarioId !== snapshot.scenario.id ||
      evidenceSnapshotDigest(attestation.scope) !==
        evidenceSnapshotDigest(snapshot.steps.asset.scope) ||
      attestation.stepsManifestDigest !== snapshot.steps.manifestDigest ||
      evidenceSnapshotDigest(attestation.dependencyManifestDigests) !==
        evidenceSnapshotDigest(
          snapshot.dependencies.map((dependency) => dependency.manifestDigest),
        ) ||
      attestation.observed.length !== expected.length ||
      attestation.observed.some((asset, index) => {
        const item = expected[index];
        return (
          !item ||
          asset.assetId !== item.asset.id ||
          asset.state !== item.asset.state ||
          !sameEvidenceIdentity(asset.before, item.expectedFile) ||
          !sameEvidenceIdentity(asset.after, item.expectedFile)
        );
      })
    )
      verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
  }

  #assertFact(asset: AssetFact): void {
    this.#assertAvailable();
    const current = this.#candidate(asset.scope, asset.assetId);
    if (
      current.storageKey !== asset.storage.storageKey ||
      current.metadataToken.fingerprint !== asset.metadataFingerprint
    )
      verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
  }

  #assertProof(proof: ProfileProof): void {
    this.#assertAvailable();
    this.#assertIdentity(proof.identity);
    for (const asset of proof.assets) this.#assertFact(asset);
  }

  #leaseFingerprint(jobId: string, runAttemptId: string): string {
    this.#assertAvailable();
    const row = this.#database
      .prepare(`SELECT attempt.worker_id, attempt.worker_node_id, attempt.worker_instance_id,
      attempt.lease_generation, attempt.lease_token_hash, attempt.status, attempt.lease_expires_at,
      attempt.execution_deadline_at, attempt.no_progress_deadline_at, job.status AS job_status,
      job.current_run_attempt_id, job.cancellation_requested_at, job.lease_generation AS current_generation,
      job.execution_digest, worker.superseded_at, worker.status AS worker_status,
      worker.node_id, worker.instance_id FROM run_attempts AS attempt
      JOIN jobs AS job ON job.id = attempt.job_id JOIN workers AS worker ON worker.id = attempt.worker_id
      WHERE attempt.id = ? AND job.id = ?`)
      .get(runAttemptId, jobId) as Record<string, string | number | null> | undefined;
    const now = this.#now();
    if (
      !row ||
      !["leased", "running"].includes(String(row.status)) ||
      !["leased", "running"].includes(String(row.job_status)) ||
      !["online", "draining"].includes(String(row.worker_status)) ||
      row.current_run_attempt_id !== runAttemptId ||
      row.cancellation_requested_at !== null ||
      row.superseded_at !== null ||
      row.lease_generation !== row.current_generation ||
      row.node_id !== row.worker_node_id ||
      row.instance_id !== row.worker_instance_id ||
      String(row.lease_expires_at) <= now ||
      String(row.execution_deadline_at) <= now ||
      String(row.no_progress_deadline_at) <= now
    )
      throw new EvidenceStorageError(
        "EVIDENCE_LEASE_REJECTED",
        "The active lease changed during evidence verification.",
      );
    return evidenceSnapshotDigest({
      jobId,
      runAttemptId,
      workerId: row.worker_id,
      nodeId: row.node_id,
      instanceId: row.instance_id,
      generation: row.lease_generation,
      tokenHash: row.lease_token_hash,
      executionDigest: row.execution_digest,
    });
  }

  #assertIdentity(identity: ProfileIdentity): void {
    this.#assertAvailable();
    if (identity.kind === "completion") {
      if (this.#leaseFingerprint(identity.jobId, identity.runAttemptId) !== identity.fingerprint)
        throw new EvidenceStorageError(
          "EVIDENCE_LEASE_REJECTED",
          "The completion lease identity changed.",
        );
      return;
    }
    if (identity.kind === "evaluation_read") {
      const current = this.#readEvaluationIdentity(identity.query);
      if (
        current?.identityDigest !== identity.identityDigest ||
        current.requestId !== identity.requestId ||
        current.jobId !== identity.jobId
      )
        verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
      return;
    }
    const selected = this.#readSelection({
      repositoryId: identity.repositoryId,
      reviewRunId: identity.runId,
      requestId: identity.requestId,
      jobId: identity.jobId,
    })[0];
    if (
      selected?.job_status !== "succeeded" ||
      selected.result_id !== identity.resultId ||
      selected.result_digest !== identity.resultDigest ||
      selected.latest_activation !== identity.latestActivation
    )
      verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
  }

  #evaluationReadTransaction<T>(read: () => T): T {
    this.#assertAvailable();
    if (this.#database.isTransaction) return read();
    this.#database.exec("BEGIN");
    try {
      const result = read();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #readEvaluationIdentity(query: EvaluationCellResultReadQuery) {
    return this.#evaluationReadTransaction(() =>
      readEvaluationResultIdentityInTransaction(this.#database, query),
    );
  }

  #assertEvaluationBatchSelection(
    query: EvaluationBatchEvidenceQuery,
    selectionDigest: string,
  ): void {
    const current = this.#evaluationReadTransaction(() =>
      readEvaluationBatchEvidenceSelectionInTransaction(this.#database, query),
    );
    if (current.selectionDigest !== selectionDigest)
      verificationFailure("EVIDENCE_VERIFIER_UNAVAILABLE");
  }

  #readRun(query: RunEvidenceReadQuery): ReviewRunDetail | null {
    const run = handleReviewRunRequest(
      this.#database,
      {
        operation: "getReviewRun",
        input: { repositoryId: query.repositoryId, reviewRunId: query.reviewRunId },
      },
      this.#now(),
    ) as ReviewRunDetail | null;
    if (
      run &&
      "workItemId" in query &&
      query.workItemId !== undefined &&
      query.workItemId !== run.workItemId
    )
      return null;
    return run;
  }

  #readSelection(query: RunEvidenceReadQuery): ReadSelection[] {
    const explicit = "jobId" in query;
    return this.#database
      .prepare(`SELECT link.request_id, link.job_id, link.activation_number,
      (SELECT MAX(latest.activation_number) FROM review_run_job_links AS latest
        WHERE latest.review_run_id = run.id AND latest.request_id = link.request_id) AS latest_activation,
      job.status AS job_status, result.id AS result_id, result.result_digest
      FROM review_runs AS run JOIN review_run_job_links AS link ON link.review_run_id = run.id
      JOIN jobs AS job ON job.id = link.job_id
      LEFT JOIN validation_job_results AS result ON result.job_id = job.id
      WHERE run.repository_id = ? AND run.id = ? ${explicit ? "AND link.request_id = ? AND job.id = ?" : "AND link.activation_number = (SELECT MAX(last.activation_number) FROM review_run_job_links AS last WHERE last.review_run_id = run.id AND last.request_id = link.request_id)"}
      ORDER BY link.request_id LIMIT 33`)
      .all(
        ...(explicit
          ? [query.repositoryId, query.reviewRunId, query.requestId, query.jobId]
          : [query.repositoryId, query.reviewRunId]),
      ) as unknown as ReadSelection[];
  }

  #readProfile(run: ReviewRunDetail, selected: ReadSelection): ProfileInput {
    const row = this.#database
      .prepare(`SELECT result.result_json, result.result_digest, result.schema_id,
      result.run_attempt_id, result.execution_template_sha256, job.execution_json,
      attempt.status AS attempt_status, attempt.result_digest AS attempt_digest
      FROM validation_job_results AS result JOIN jobs AS job ON job.id = result.job_id
      JOIN run_attempts AS attempt ON attempt.id = result.run_attempt_id AND attempt.job_id = job.id
      WHERE result.id = ? AND result.repository_id = ? AND result.review_run_id = ? AND result.request_id = ?
        AND result.job_id = ? AND result.job_activation = ? AND result.plan_digest = ?
        AND result.resource_revision = ? AND result.execution_template_sha256 = job.execution_digest`)
      .get(
        selected.result_id,
        run.repositoryId,
        run.id,
        selected.request_id,
        selected.job_id,
        selected.activation_number,
        run.planDigest,
        run.revisionKey,
      ) as
      | {
          result_json: string;
          result_digest: string;
          schema_id: string;
          run_attempt_id: string;
          execution_template_sha256: string;
          execution_json: string;
          attempt_status: string;
          attempt_digest: string;
        }
      | undefined;
    if (
      row?.attempt_status !== "succeeded" ||
      row.attempt_digest !== row.result_digest ||
      row.result_digest !== selected.result_digest ||
      sha256(row.result_json) !== row.result_digest ||
      sha256(row.execution_json) !== row.execution_template_sha256
    )
      verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    let result: ValidationJobResult;
    try {
      result = decodeStoredValidationResult(row.schema_id, row.result_json, row.result_digest);
      readValidationModelResultBindingInTransaction(
        this.#database,
        {
          repositoryId: run.repositoryId,
          runId: run.id,
          requestId: selected.request_id,
          jobId: selected.job_id,
          runAttemptId: row.run_attempt_id,
          resultDigest: row.result_digest,
          executionDigest: row.execution_template_sha256,
        },
        result,
      );
    } catch {
      verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    }
    const template: unknown = JSON.parse(row.execution_json);
    if (!Value.Check(JobExecutionTemplateV2Schema, template))
      verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    const request = run.plan.jobs.find((job) => job.requestId === selected.request_id);
    const reproduction = run.plan.reproduction?.binding.cases.some(
      (item) => item.requestId === selected.request_id,
    )
      ? run.plan.reproduction
      : undefined;
    if (
      !request ||
      template.validation.runId !== run.id ||
      template.validation.requestId !== request.requestId ||
      template.validation.planDigest !== run.planDigest ||
      template.validation.revisionKey !== run.revisionKey ||
      template.validation.profileVersion.id !== request.profileVersion?.id ||
      canonicalJson(template.validation.profileVersion) !== canonicalJson(request.profileVersion) ||
      canonicalJson(template.validation.reproduction ?? null) !==
        canonicalJson(reproduction ?? null)
    )
      verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    const scopes = result.report.checks
      .filter((check) => check.evidenceIds.length > 0)
      .map((check) => ({
        repositoryId: run.repositoryId,
        runId: run.id,
        requestId: request.requestId,
        jobId: selected.job_id,
        runAttemptId: row.run_attempt_id,
        profileVersionId: template.validation.profileVersion.id,
        checkId: check.id,
        evidenceIds: check.evidenceIds,
      }));
    return {
      key: evidenceSnapshotDigest({
        validation: template.validation,
        resultDigest: row.result_digest,
      }),
      identity: {
        kind: "read",
        repositoryId: run.repositoryId,
        runId: run.id,
        requestId: request.requestId,
        jobId: selected.job_id,
        resultId: selected.result_id as string,
        resultDigest: row.result_digest,
        latestActivation: selected.latest_activation,
      },
      template,
      request,
      result,
      resultDigest: row.result_digest,
      scopes,
    };
  }
}
