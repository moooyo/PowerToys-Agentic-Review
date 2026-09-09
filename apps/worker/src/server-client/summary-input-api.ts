import { types } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  type FreezeValidationSummaryInputRequest,
  type FreezeValidationSummaryInputResponse,
  getFreezeValidationSummaryInputRequestIssues,
  getFreezeValidationSummaryInputResponseIssues,
  maximumFreezeValidationSummaryInputRequestUtf8Bytes,
} from "@agentic-review/contracts";
import { ProtocolError } from "./errors.js";

/** Records the exact validation context used by a CLI summary. */
export interface ModelSummaryInputApi {
  freezeValidationSummaryInput(
    request: FreezeValidationSummaryInputRequest,
    signal?: AbortSignal,
  ): Promise<FreezeValidationSummaryInputResponse>;
}

export interface SummaryInputRequestSnapshot {
  readonly value: FreezeValidationSummaryInputRequest;
  readonly serialized: Buffer;
}

function assertPassiveJson(value: unknown, parents = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (types.isProxy(value) || parents.has(value) || parents.size > 64) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== null &&
    prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype)
  )
    throw new Error();
  parents.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new Error();
    assertPassiveJson(descriptor.value, parents);
  }
  parents.delete(value);
}

export function snapshotFreezeValidationSummaryInputRequest(
  request: FreezeValidationSummaryInputRequest,
): SummaryInputRequestSnapshot {
  // Keep serialization and response comparisons independent of later caller mutations.
  try {
    assertPassiveJson(request);
    if (getFreezeValidationSummaryInputRequestIssues(request).length > 0) throw new Error();
    const serialized = Buffer.from(JSON.stringify(request), "utf8");
    if (serialized.byteLength > maximumFreezeValidationSummaryInputRequestUtf8Bytes)
      throw new Error();
    const value: unknown = JSON.parse(serialized.toString("utf8"));
    if (getFreezeValidationSummaryInputRequestIssues(value).length > 0) throw new Error();
    return { value: value as FreezeValidationSummaryInputRequest, serialized };
  } catch {
    throw new ProtocolError("Summary input request is invalid.");
  }
}

export function parseFreezeValidationSummaryInputResponse(
  value: unknown,
  request: FreezeValidationSummaryInputRequest,
): FreezeValidationSummaryInputResponse {
  try {
    assertPassiveJson(value);
    if (getFreezeValidationSummaryInputResponseIssues(value).length > 0) throw new Error();
  } catch {
    throw new ProtocolError("Worker API returned an invalid summary input receipt.");
  }
  const receipt = value as FreezeValidationSummaryInputResponse;
  if (
    receipt.reference.inputId !== request.inputId ||
    receipt.reference.contextSha256 !== createCanonicalResult(request.context).sha256
  )
    throw new ProtocolError("Worker API returned a summary input receipt for different input.");
  // The runner reconstructs the frozen document using Server-owned fields and this timestamp.
  return structuredClone(receipt);
}
