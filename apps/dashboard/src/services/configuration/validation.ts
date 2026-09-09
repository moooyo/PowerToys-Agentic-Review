import {
  DateTimeSchema,
  EntityIdSchema,
  getValidationProfileConfigIssues,
  maximumPromptContentUtf8Bytes,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PromptBindingSchema,
  PromptVersionSchema,
  QualifiedValidationCheckIdSchema,
  RepositoryValidationProfileBindingSchema,
  type ValidationProfileConfig,
  type ValidationTarget,
  type WorkflowKind,
  WorkflowKindSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import type { ConfigurationPage, ConfigurationPageQuery, PromptListQuery } from "./adapter";

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
);
FormatRegistry.Set("uri", (value) => URL.canParse(value));

const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const historyProperties = {
  id: EntityIdSchema,
  previousVersionId: Type.Union([EntityIdSchema, Type.Null()]),
  createdAt: DateTimeSchema,
  createdBy: PromptVersionSchema.properties.createdBy,
};

export const PromptBindingHistorySchema = Type.Object(
  { ...PromptBindingSchema.properties, ...historyProperties },
  { additionalProperties: false },
);
export const ValidationProfileBindingHistorySchema = Type.Object(
  { ...RepositoryValidationProfileBindingSchema.properties, ...historyProperties },
  { additionalProperties: false },
);

const pageQueryProperties = {
  page: Type.Optional(PositiveIntegerSchema),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const PageQuerySchema = Type.Object(pageQueryProperties, { additionalProperties: false });
const PromptQuerySchema = Type.Object(
  { ...pageQueryProperties, workflowKind: Type.Optional(WorkflowKindSchema) },
  { additionalProperties: false },
);

function validWireValue(value: unknown, key = ""): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") {
    if (decoder.decode(encoder.encode(value)) !== value) return false;
    if (key === "checkId")
      return Value.Check(QualifiedValidationCheckIdSchema, value) && !/[\r\n]/u.test(value);
    if ((key === "id" || key.endsWith("Id") || key === "secretRef") && !entityIdPattern.test(value))
      return false;
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).every(([entryKey, entry]) => validWireValue(entry, entryKey));
  }
  return true;
}

export function validateRequest<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value)) {
    throw new ReviewControlRequestError(
      operation,
      "request",
      `The ${operation} request is invalid.`,
    );
  }
  return value;
}

export function validateEntityId(value: string, operation: string, path = "id"): void {
  if (typeof value !== "string" || !entityIdPattern.test(value)) {
    throw new ReviewControlRequestError(
      operation,
      path,
      "A valid configuration entity ID is required.",
    );
  }
}

export function validateWorkflowKind(value: WorkflowKind, operation: string): void {
  validateRequest(WorkflowKindSchema, value, operation);
}

export function normalizePageQuery(
  query: ConfigurationPageQuery | PromptListQuery = {},
  workflowAllowed = false,
): { page: number; pageSize: number; workflowKind?: WorkflowKind } {
  validateRequest(
    workflowAllowed ? PromptQuerySchema : PageQuerySchema,
    query,
    "list configuration",
  );
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    throw new ReviewControlRequestError(
      "list configuration",
      "page",
      "The requested page is too large.",
    );
  }
  return {
    page,
    pageSize,
    ...("workflowKind" in query && query.workflowKind !== undefined
      ? { workflowKind: query.workflowKind }
      : {}),
  };
}

export function pageQueryString(query: ReturnType<typeof normalizePageQuery>): string {
  const parameters = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.workflowKind !== undefined) parameters.set("workflowKind", query.workflowKind);
  return parameters.toString();
}

const validPromptContent = (content: string): boolean => {
  const encoded = encoder.encode(content);
  return encoded.byteLength <= maximumPromptContentUtf8Bytes && decoder.decode(encoded) === content;
};

export function validatePromptContent(content: string, operation: string): void {
  if (!validPromptContent(content)) {
    throw new ReviewControlRequestError(
      operation,
      "content",
      "Prompt content must contain valid Unicode within the 256 KiB UTF-8 limit.",
    );
  }
}

export function validateProfileConfig(
  config: ValidationProfileConfig,
  workflowKind: WorkflowKind,
  target: ValidationTarget,
  operation: string,
): void {
  const issues = getValidationProfileConfigIssues(config, workflowKind, target);
  if (issues.length > 0) {
    throw new ReviewControlRequestError(operation, "config", issues.join(" "));
  }
}

export type ResponseScope = Readonly<Record<string, string | number | boolean | null>>;

export function validateResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  scope: ResponseScope = {},
): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value)) {
    throw new ReviewControlProtocolError(operation, `The ${operation} response is invalid.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.entries(scope).some(([key, expected]) => record[key] !== expected)) {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response belongs to another configuration or scope.`,
    );
  }
  for (const key of ["content", "draftContent"] as const) {
    if (typeof record[key] === "string" && !validPromptContent(record[key])) {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response contains invalid prompt content.`,
      );
    }
  }
  if (
    "config" in record &&
    "workflowKind" in record &&
    getValidationProfileConfigIssues(
      record.config as ValidationProfileConfig,
      record.workflowKind as WorkflowKind,
      record.target as ValidationTarget,
    ).length > 0
  ) {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response contains an invalid validation profile.`,
    );
  }
  return value;
}

export function validatePage<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  query: ReturnType<typeof normalizePageQuery>,
  scope: ResponseScope = {},
  uniqueKeys: readonly string[] = ["id"],
): ConfigurationPage<Static<T>> {
  const pageSchema = Type.Object(
    {
      items: Type.Array(schema, { maxItems: query.pageSize }),
      total: NonNegativeIntegerSchema,
      page: Type.Literal(query.page),
      pageSize: Type.Literal(query.pageSize),
    },
    { additionalProperties: false },
  );
  const result = validateResponse(pageSchema, value, operation);
  for (const item of result.items) validateResponse(schema, item, operation, scope);
  if (
    result.items.length > result.total ||
    (result.items.length > 0 &&
      (query.page - 1) * query.pageSize + result.items.length > result.total) ||
    uniqueKeys.some(
      (key) =>
        new Set(result.items.map((item) => (item as Record<string, unknown>)[key])).size !==
        result.items.length,
    )
  ) {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response contains inconsistent pagination or duplicate items.`,
    );
  }
  return result;
}
