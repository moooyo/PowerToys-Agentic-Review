import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ExecutionPolicySchema } from "@agentic-review/contracts";
import { type Static, type TSchema, Type, TypeGuard } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "./canonical-json.js";

const maximumPromptFileBytes = 262_144;
const maximumCapabilityRequirementDepth = 16;
const maximumCapabilityRequirementNodes = 4_096;
const maximumExecutionTimeoutMs = 8_000_000_000_000_000;

const CapabilityRequirementObjectSchema = Type.Recursive((This) =>
  Type.Record(
    Type.String({ pattern: "^[^\\u0000-\\u001F\\u007F]{1,128}$" }),
    Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String({ maxLength: 2_048 }),
      This,
    ]),
    { maxProperties: 256 },
  ),
);

const CapabilityRequirementSchema = Type.Union([
  Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    maxItems: 256,
    uniqueItems: true,
  }),
  CapabilityRequirementObjectSchema,
]);

export const TrustedJobPolicySchema = Type.Object(
  {
    priority: Type.Integer({
      minimum: -1_000_000,
      maximum: 1_000_000,
    }),
    intentVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    maxAttempts: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    requiredCapabilities: CapabilityRequirementSchema,
    executionPolicy: ExecutionPolicySchema,
  },
  { additionalProperties: false },
);
export type TrustedJobPolicy = Static<typeof TrustedJobPolicySchema>;

export const TrustedSchedulingPolicySchema = Type.Object(
  {
    issueTriage: TrustedJobPolicySchema,
    pullRequestReview: TrustedJobPolicySchema,
  },
  { additionalProperties: false },
);
export type TrustedSchedulingPolicy = Static<typeof TrustedSchedulingPolicySchema>;

export interface TrustedSchedulingOutputSchemas {
  readonly issueTriage: TSchema;
  readonly pullRequestReview: TSchema;
}

export interface LoadTrustedSchedulingConfigOptions {
  readonly promptDirectory: string;
  readonly policy: TrustedSchedulingPolicy;
  readonly outputSchemas: TrustedSchedulingOutputSchemas;
}

interface LoadedPromptConfig {
  readonly name: string;
  readonly version: string;
  readonly text: string;
  readonly outputSchema: unknown;
  readonly policy: TrustedJobPolicy;
}

export interface TrustedSchedulingConfig {
  readonly issueTriage: LoadedPromptConfig;
  readonly pullRequestReview: LoadedPromptConfig;
}

interface PromptSpecification {
  readonly key: keyof TrustedSchedulingConfig;
  readonly fileName: string;
  readonly name: string;
  readonly version: string;
  readonly outputSchemaId: string;
  readonly outputSchemaSha256: string;
}

interface TrustedPromptDirectory {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

const promptSpecifications = [
  {
    key: "issueTriage",
    fileName: "issue-triage-v1.md",
    name: "issue-triage",
    version: "1",
    outputSchemaId: "IssueTriageV1",
    outputSchemaSha256: "60c37a09ddf4361bc063b1ca8479fa714ec6b12efe86418a2d6bb9896c29a554",
  },
  {
    key: "pullRequestReview",
    fileName: "pull-request-review-v1.md",
    name: "pull-request-review",
    version: "1",
    outputSchemaId: "PrReviewPlanV1",
    outputSchemaSha256: "fd201092072879b125cdd8aa202b1309c8852f3d19b9f46dc279e318e78715be",
  },
] as const satisfies readonly PromptSpecification[];

const loadedConfigurations = new WeakSet<object>();

export class TrustedSchedulingConfigError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TrustedSchedulingConfigError";
  }
}

export async function loadTrustedSchedulingConfig(
  options: LoadTrustedSchedulingConfigOptions,
): Promise<TrustedSchedulingConfig> {
  const policy = snapshotTrustedPolicy(options.policy);
  const outputSchemas = Object.fromEntries(
    promptSpecifications.map((specification) => [
      specification.key,
      snapshotOutputSchema(
        options.outputSchemas[specification.key],
        specification.outputSchemaId,
        specification.outputSchemaSha256,
        specification.key,
      ),
    ]),
  ) as Record<keyof TrustedSchedulingConfig, unknown>;
  const trustedDirectory = await resolveTrustedPromptDirectory(options.promptDirectory);

  const promptEntries = await Promise.all(
    promptSpecifications.map(async (specification) => {
      const text = await readTrustedPromptFile(trustedDirectory, specification.fileName);
      return [
        specification.key,
        deepFreeze({
          name: specification.name,
          version: specification.version,
          text,
          outputSchema: outputSchemas[specification.key],
          policy: policy[specification.key],
        }),
      ] as const;
    }),
  );

  const byKey = Object.fromEntries(promptEntries) as unknown as TrustedSchedulingConfig;
  const config = deepFreeze({
    issueTriage: byKey.issueTriage,
    pullRequestReview: byKey.pullRequestReview,
  });
  loadedConfigurations.add(config);
  return config;
}

export function isLoadedTrustedSchedulingConfig(value: TrustedSchedulingConfig): boolean {
  return loadedConfigurations.has(value);
}

async function resolveTrustedPromptDirectory(directory: string): Promise<TrustedPromptDirectory> {
  if (directory.length === 0 || directory.includes("\0") || !isAbsolute(directory)) {
    throw new TrustedSchedulingConfigError(
      "promptDirectory must be an explicitly configured absolute path.",
    );
  }

  const resolvedDirectory = resolve(directory);
  const directoryStats = await lstatOrConfigError(resolvedDirectory, "prompt directory");
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new TrustedSchedulingConfigError(
      "promptDirectory must identify a real directory and must not be a symbolic link or reparse-point link.",
    );
  }

  const canonicalDirectory = await realpathOrConfigError(resolvedDirectory, "prompt directory");
  if (!pathsEqual(resolvedDirectory, canonicalDirectory)) {
    throw new TrustedSchedulingConfigError(
      "promptDirectory or one of its ancestors resolves through a symbolic link or reparse point.",
    );
  }
  return {
    path: canonicalDirectory,
    device: directoryStats.dev,
    inode: directoryStats.ino,
  };
}

async function readTrustedPromptFile(
  directory: TrustedPromptDirectory,
  fileName: string,
): Promise<string> {
  await assertTrustedDirectoryUnchanged(directory);
  const filePath = resolve(join(directory.path, fileName));
  assertContainedPath(directory.path, filePath);

  const pathStatsBefore = await lstatOrConfigError(filePath, `prompt file ${fileName}`);
  assertTrustedRegularFile(pathStatsBefore, fileName);
  assertPromptFileSize(pathStatsBefore, fileName);

  const canonicalFilePath = await realpathOrConfigError(filePath, `prompt file ${fileName}`);
  if (!pathsEqual(filePath, canonicalFilePath)) {
    throw new TrustedSchedulingConfigError(
      `Prompt file ${fileName} must not be a symbolic link or reparse-point link.`,
    );
  }
  assertContainedPath(directory.path, canonicalFilePath);

  const noFollowFlag = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(filePath, constants.O_RDONLY | noFollowFlag).catch((error: unknown) => {
    throw new TrustedSchedulingConfigError(`Unable to open trusted prompt file ${fileName}.`, {
      cause: error,
    });
  });

  try {
    const handleStatsBefore = await handle.stat();
    assertTrustedRegularFile(handleStatsBefore, fileName);
    assertSameFile(pathStatsBefore, handleStatsBefore, fileName);
    assertPromptFileSize(handleStatsBefore, fileName);

    const bytes = await readBoundedPromptBytes(handle, fileName);
    const handleStatsAfter = await handle.stat();
    assertUnchangedFile(handleStatsBefore, handleStatsAfter, fileName);

    const pathStatsAfter = await lstatOrConfigError(filePath, `prompt file ${fileName}`);
    assertTrustedRegularFile(pathStatsAfter, fileName);
    assertSameFile(handleStatsAfter, pathStatsAfter, fileName);

    const canonicalFilePathAfter = await realpathOrConfigError(filePath, `prompt file ${fileName}`);
    if (!pathsEqual(filePath, canonicalFilePathAfter)) {
      throw new TrustedSchedulingConfigError(
        `Prompt file ${fileName} changed into a symbolic link or reparse-point link while loading.`,
      );
    }
    await assertTrustedDirectoryUnchanged(directory);

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new TrustedSchedulingConfigError(
        `Prompt file ${fileName} must contain valid UTF-8 text.`,
        { cause: error },
      );
    }
    if (text.trim().length === 0 || text.includes("\0")) {
      throw new TrustedSchedulingConfigError(
        `Prompt file ${fileName} must contain non-empty text without NUL characters.`,
      );
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function assertTrustedDirectoryUnchanged(directory: TrustedPromptDirectory): Promise<void> {
  const stats = await lstatOrConfigError(directory.path, "prompt directory");
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.dev !== directory.device ||
    stats.ino !== directory.inode
  ) {
    throw new TrustedSchedulingConfigError(
      "The trusted prompt directory changed while prompts were being loaded.",
    );
  }
  const canonicalDirectory = await realpathOrConfigError(directory.path, "prompt directory");
  if (!pathsEqual(directory.path, canonicalDirectory)) {
    throw new TrustedSchedulingConfigError(
      "The trusted prompt directory changed into a symbolic link or reparse-point path.",
    );
  }
}

async function readBoundedPromptBytes(handle: FileHandle, fileName: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let position = 0;
  while (totalBytes <= maximumPromptFileBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(65_536, maximumPromptFileBytes + 1 - totalBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
    position += bytesRead;
    if (totalBytes > maximumPromptFileBytes) {
      throw new TrustedSchedulingConfigError(
        `Prompt file ${fileName} exceeds ${maximumPromptFileBytes} bytes.`,
      );
    }
  }
  return Buffer.concat(chunks, totalBytes);
}

function assertContainedPath(directory: string, candidate: string): void {
  const relativePath = relative(directory, candidate);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new TrustedSchedulingConfigError("A prompt path escaped the trusted prompt directory.");
  }
}

function pathsEqual(first: string, second: string): boolean {
  const normalizedFirst = resolve(first);
  const normalizedSecond = resolve(second);
  return process.platform === "win32"
    ? normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase()
    : normalizedFirst === normalizedSecond;
}

function assertTrustedRegularFile(stats: Stats, fileName: string): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new TrustedSchedulingConfigError(
      `Prompt file ${fileName} must be a regular file and must not be a symbolic link or reparse-point link.`,
    );
  }
}

function assertPromptFileSize(stats: Stats, fileName: string): void {
  if (stats.size <= 0 || stats.size > maximumPromptFileBytes) {
    throw new TrustedSchedulingConfigError(
      `Prompt file ${fileName} must be between 1 and ${maximumPromptFileBytes} bytes.`,
    );
  }
}

function assertSameFile(first: Stats, second: Stats, fileName: string): void {
  if (first.dev !== second.dev || first.ino !== second.ino) {
    throw new TrustedSchedulingConfigError(
      `Prompt file ${fileName} changed identity while it was being loaded.`,
    );
  }
}

function assertUnchangedFile(first: Stats, second: Stats, fileName: string): void {
  assertSameFile(first, second, fileName);
  if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) {
    throw new TrustedSchedulingConfigError(
      `Prompt file ${fileName} changed while it was being loaded.`,
    );
  }
}

function snapshotOutputSchema(
  schema: TSchema,
  expectedId: string,
  expectedSha256: string,
  name: string,
): unknown {
  assertBoundedAcyclicData(schema, `outputSchemas.${name}`, 64, maximumCapabilityRequirementNodes);
  if (!TypeGuard.IsSchema(schema)) {
    throw new TrustedSchedulingConfigError(
      `outputSchemas.${name} must be the authoritative ${expectedId} TypeBox schema.`,
    );
  }
  const schemaJson = canonicalJson(schema);
  const snapshot = JSON.parse(schemaJson) as unknown;
  if (sha256(schemaJson) !== expectedSha256) {
    throw new TrustedSchedulingConfigError(
      `outputSchemas.${name} must be the authoritative ${expectedId} TypeBox schema.`,
    );
  }
  return deepFreeze(snapshot);
}

function snapshotTrustedPolicy(value: unknown): TrustedSchedulingPolicy {
  assertBoundedAcyclicData(value, "policy", 32, maximumCapabilityRequirementNodes);
  const policy = cloneJson(value) as TrustedSchedulingPolicy;
  assertSchema(policy, TrustedSchedulingPolicySchema, "policy");
  assertNoSecretMaterial(policy, "policy");
  assertCapabilityRequirementComplexity(policy.issueTriage.requiredCapabilities);
  assertCapabilityRequirementComplexity(policy.pullRequestReview.requiredCapabilities);
  assertJobPolicyNumbers(policy.issueTriage, "policy.issueTriage");
  assertJobPolicyNumbers(policy.pullRequestReview, "policy.pullRequestReview");
  assertRequiredCapabilityLabels(policy.issueTriage, "policy.issueTriage");
  assertRequiredCapabilityLabels(policy.pullRequestReview, "policy.pullRequestReview");
  return deepFreeze(policy);
}

function assertJobPolicyNumbers(policy: TrustedJobPolicy, path: string): void {
  const numericPolicy = {
    priority: policy.priority,
    intentVersion: policy.intentVersion,
    maxAttempts: policy.maxAttempts,
    hardTimeoutMs: policy.executionPolicy.hardTimeoutMs,
    noProgressTimeoutMs: policy.executionPolicy.noProgressTimeoutMs,
    maxCodexTurns: policy.executionPolicy.maxCodexTurns,
  };
  for (const [name, value] of Object.entries(numericPolicy)) {
    if (!Number.isSafeInteger(value)) {
      throw new TrustedSchedulingConfigError(`${path}.${name} must be a safe integer.`);
    }
  }
  if (
    policy.executionPolicy.hardTimeoutMs > maximumExecutionTimeoutMs ||
    policy.executionPolicy.noProgressTimeoutMs > maximumExecutionTimeoutMs
  ) {
    throw new TrustedSchedulingConfigError(
      `${path} execution timeouts exceed the supported date range.`,
    );
  }
  if (policy.executionPolicy.noProgressTimeoutMs > policy.executionPolicy.hardTimeoutMs) {
    throw new TrustedSchedulingConfigError(
      `${path}.noProgressTimeoutMs must not exceed hardTimeoutMs.`,
    );
  }
}

function assertRequiredCapabilityLabels(policy: TrustedJobPolicy, path: string): void {
  const requiredLabels = policy.executionPolicy.requiredCapabilityLabels;
  for (const key of Object.keys(requiredLabels)) {
    assertCapabilityKey(key, 64, `${path}.executionPolicy.requiredCapabilityLabels`);
  }
  if (Object.keys(requiredLabels).length === 0) {
    return;
  }
  if (
    policy.requiredCapabilities === null ||
    typeof policy.requiredCapabilities !== "object" ||
    Array.isArray(policy.requiredCapabilities)
  ) {
    throw new TrustedSchedulingConfigError(
      `${path}.requiredCapabilities must require every requiredCapabilityLabels entry.`,
    );
  }

  const capabilityLabels = (policy.requiredCapabilities as Record<string, unknown>).labels;
  if (
    capabilityLabels === null ||
    typeof capabilityLabels !== "object" ||
    Array.isArray(capabilityLabels)
  ) {
    throw new TrustedSchedulingConfigError(
      `${path}.requiredCapabilities.labels must require every requiredCapabilityLabels entry.`,
    );
  }
  const labelsRecord = capabilityLabels as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(requiredLabels)) {
    if (labelsRecord[key] !== expectedValue) {
      throw new TrustedSchedulingConfigError(
        `${path}.requiredCapabilities.labels.${key} must equal requiredCapabilityLabels.${key}.`,
      );
    }
  }
}

function assertSchema<TSchemaType extends TSchema>(
  value: unknown,
  schema: TSchemaType,
  name: string,
): asserts value is Static<TSchemaType> {
  if (!Value.Check(schema, value)) {
    const firstError = Value.Errors(schema, value).First();
    const detail = firstError === undefined ? "unknown validation error" : firstError.message;
    throw new TrustedSchedulingConfigError(`${name} is invalid: ${detail}`);
  }
}

function assertCapabilityRequirementComplexity(value: unknown): void {
  assertBoundedAcyclicData(
    value,
    "requiredCapabilities",
    maximumCapabilityRequirementDepth,
    maximumCapabilityRequirementNodes,
  );
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current !== null && typeof current === "object") {
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        assertCapabilityKey(key, 128, "requiredCapabilities");
        pending.push(item);
      }
    }
  }
}

function assertBoundedAcyclicData(
  value: unknown,
  path: string,
  maximumDepth: number,
  maximumNodes: number,
): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    nodes += 1;
    if (current.depth > maximumDepth || nodes > maximumNodes) {
      throw new TrustedSchedulingConfigError(`${path} is too deeply nested or large.`);
    }
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (visited.has(current.value)) {
      throw new TrustedSchedulingConfigError(`${path} must not contain cycles or shared objects.`);
    }
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        if (!(index in current.value)) {
          throw new TrustedSchedulingConfigError(`${path} must not contain sparse arrays.`);
        }
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
    } else {
      for (const item of Object.values(current.value as Record<string, unknown>)) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function assertCapabilityKey(key: string, maximumLength: number, path: string): void {
  const hasControlCharacter = Array.from(key).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (key.length === 0 || key.length > maximumLength || hasControlCharacter) {
    throw new TrustedSchedulingConfigError(`${path} contains an invalid capability key.`);
  }
}

function assertNoSecretMaterial(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u.test(value)) {
      throw new TrustedSchedulingConfigError(`${path} must not contain private key material.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSecretMaterial(item, `${path}[${index}]`);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretBearingKey(key)) {
      throw new TrustedSchedulingConfigError(`${path}.${key} is not permitted in job policy.`);
    }
    assertNoSecretMaterial(item, `${path}.${key}`);
  }
}

function isSecretBearingKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((segment) => segment.length > 0);
  const sensitiveSegments = new Set([
    "secret",
    "password",
    "credential",
    "credentials",
    "token",
    "cookie",
    "authorization",
  ]);
  const compact = segments.join("");
  return (
    segments.some((segment) => sensitiveSegments.has(segment)) ||
    compact.includes("apikey") ||
    compact.includes("privatekey")
  );
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

async function lstatOrConfigError(path: string, description: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    throw new TrustedSchedulingConfigError(`Unable to inspect ${description}.`, { cause: error });
  }
}

async function realpathOrConfigError(path: string, description: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new TrustedSchedulingConfigError(`Unable to resolve ${description}.`, { cause: error });
  }
}
