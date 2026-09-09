import { getValidationJobResultIssues, type ValidationJobResult } from "@agentic-review/codex";
import { maximumRunCompletionResultUtf8Bytes } from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";

export class StoredValidationResultError extends Error {
  readonly code = "STORED_VALIDATION_RESULT_INVALID";
  constructor() {
    super("The stored validation result is invalid or does not match its immutable digest.");
    this.name = "StoredValidationResultError";
  }
}

/** Returns the original versioned body. No enrichment, V1 conversion or digest replacement occurs. */
export function decodeStoredValidationResult(
  schemaId: string,
  json: string | null,
  digest: string,
): ValidationJobResult {
  try {
    if (
      (schemaId !== "ValidationJobResultV1" && schemaId !== "ValidationJobResultV2") ||
      json === null ||
      Buffer.byteLength(json, "utf8") > maximumRunCompletionResultUtf8Bytes ||
      !/^[a-f0-9]{64}(?![\s\S])/u.test(digest) ||
      sha256(json) !== digest
    )
      throw new StoredValidationResultError();
    const result: unknown = JSON.parse(json);
    if (
      getValidationJobResultIssues(result).length ||
      (result as ValidationJobResult).schemaVersion !== schemaId ||
      canonicalJson(result) !== json
    )
      throw new StoredValidationResultError();
    return result as ValidationJobResult;
  } catch {
    throw new StoredValidationResultError();
  }
}
