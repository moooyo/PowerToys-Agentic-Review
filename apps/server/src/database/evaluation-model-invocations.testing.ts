import type * as C from "@agentic-review/contracts";
import { evaluationActor } from "./evaluation-management.testing.js";
import { handleModelInvocationRequest } from "./model-invocations.js";
import {
  type ModelInvocationFixture,
  modelInvocationBeginRequest,
  modelInvocationReceiptSet,
  modelInvocationSealRequest,
  modelInvocationFixtureTime as time,
} from "./model-invocations.testing.js";

export function invocationHistoryInput(
  f: ModelInvocationFixture,
  arm: "baseline" | "candidate" = "baseline",
) {
  const cell = f.cells.find((value) => value.arm === arm);
  if (!cell) throw new Error("The synthetic evaluation cell is missing.");
  return {
    actor: evaluationActor,
    repositoryId: f.repositoryId,
    evaluationId: f.batch.id,
    cellId: cell.id,
    query: {} as C.EvaluationCellInvocationListQuery,
  };
}
/** Persists synthetic metadata with the actual owner; it does not execute a model. */
export function recordInvocationHistory(
  f: ModelInvocationFixture,
  options: {
    lease?: C.LeaseIdentity;
    invocationId?: string;
    now?: string;
    openingOnly?: boolean;
    sealOnly?: boolean;
    changeLedger?: (set: C.ModelInvocationReceiptSet) => void;
  } = {},
) {
  const request = modelInvocationBeginRequest(f, "baseline", {
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (options.invocationId) request.invocationId = options.invocationId;
  const now = options.now ?? time.opened;
  const opened = handleModelInvocationRequest(
    f.database,
    {
      operation: "beginModelInvocation",
      input: { workerTokenSha256: f.workerTokenSha256, request },
    },
    now,
  ) as C.ModelInvocationOpening;
  if (options.openingOnly) return { opening: opened, seal: null, submission: null };
  const ledger = modelInvocationReceiptSet(opened, f.identity.modelId);
  options.changeLedger?.(ledger);
  const sealed = handleModelInvocationRequest(
    f.database,
    {
      operation: "sealModelInvocation",
      input: {
        workerTokenSha256: f.workerTokenSha256,
        request: modelInvocationSealRequest(request.lease, ledger),
      },
    },
    now,
  ) as C.ModelInvocationSealV1;
  if (options.sealOnly) return { opening: opened, seal: sealed, submission: null };
  const submitted = handleModelInvocationRequest(
    f.database,
    {
      operation: "submitModelInvocationReceipts",
      input: {
        workerTokenSha256: f.workerTokenSha256,
        request: { lease: request.lease, invocationId: request.invocationId, receiptSet: ledger },
      },
    },
    now,
  ) as C.ModelInvocationSubmissionV1;
  return { opening: opened, seal: sealed, submission: submitted };
}
