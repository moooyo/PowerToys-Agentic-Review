import { types } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  getModelInvocationOpeningIssues,
  getModelInvocationScopeIssues,
  type ModelInvocationOpening,
  type ModelInvocationScope,
} from "@agentic-review/contracts";
import { modelInvocationScopeDigest } from "@agentic-review/domain";
import type { CodexProviderProfile } from "./codex-provider-profile.js";
import type { ModelInvocationSession } from "./model-invocation-coordinator.js";

export interface ModelRelayLaunchProfileInput {
  readonly session: Pick<ModelInvocationSession, "opening" | "relay">;
  readonly expectedScope: ModelInvocationScope;
  readonly promptSha256: string;
  readonly outputSchemaSha256: string;
}

export class ModelRelayLaunchError extends Error {
  readonly code = "MODEL_RELAY_LAUNCH_INVALID";
  constructor() {
    super("The model relay launch profile does not match its parent-owned invocation.");
    this.name = "ModelRelayLaunchError";
  }
}

const providerId = "agentic_review_parent_relay";
const providerHeader = "CODEX_PROVIDER_HEADER_0";
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/u;
const bearerPattern = /^[A-Za-z0-9_-]{43}(?![\s\S])/u;
const relayUrlPattern = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/v1(?![\s\S])/u;

function ownValue(input: unknown, key: string): unknown {
  if (
    input === null ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function jsonSnapshot(input: unknown, ancestors = new Set<object>()): unknown {
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (!input.isWellFormed()) throw new Error();
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error();
    return input;
  }
  if (
    typeof input !== "object" ||
    types.isProxy(input) ||
    ancestors.has(input) ||
    ancestors.size > 64 ||
    Object.getOwnPropertySymbols(input).length > 0 ||
    (Array.isArray(input)
      ? Object.getPrototypeOf(input) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
  )
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const entries = Object.entries(descriptors).filter(
    ([name]) => !Array.isArray(input) || name !== "length",
  );
  if (
    Array.isArray(input) &&
    (entries.length !== descriptors.length?.value ||
      entries.some(([name], index) => name !== String(index)))
  )
    throw new Error();
  ancestors.add(input);
  const values = entries.map(([name, descriptor]) => {
    if (!name.isWellFormed() || !descriptor.enumerable || !("value" in descriptor))
      throw new Error();
    return [name, jsonSnapshot(descriptor.value, ancestors)] as const;
  });
  ancestors.delete(input);
  return Array.isArray(input) ? values.map(([, value]) => value) : Object.fromEntries(values);
}

/** Replaces all provider launch inputs; upstream authorization stays in the parent relay. */
export function createModelRelayLaunchProfile(
  input: ModelRelayLaunchProfileInput,
): CodexProviderProfile {
  try {
    const session = ownValue(input, "session");
    const opening = jsonSnapshot(ownValue(session, "opening")) as ModelInvocationOpening;
    const expectedScope = jsonSnapshot(ownValue(input, "expectedScope")) as ModelInvocationScope;
    const promptSha256 = ownValue(input, "promptSha256");
    const outputSchemaSha256 = ownValue(input, "outputSchemaSha256");
    const relay = ownValue(session, "relay");
    const url = ownValue(relay, "url");
    const bearerToken = ownValue(relay, "bearerToken");
    if (
      getModelInvocationOpeningIssues(opening).length > 0 ||
      getModelInvocationScopeIssues(expectedScope).length > 0 ||
      typeof promptSha256 !== "string" ||
      !digestPattern.test(promptSha256) ||
      typeof outputSchemaSha256 !== "string" ||
      !digestPattern.test(outputSchemaSha256) ||
      (expectedScope.schemaVersion === "ModelInvocationScopeV2"
        ? expectedScope.inputRef.actualPromptSha256
        : expectedScope.promptSha256) !== promptSha256 ||
      expectedScope.outputSchemaSha256 !== outputSchemaSha256 ||
      opening.scopeSha256 !== modelInvocationScopeDigest(opening.scope) ||
      createCanonicalResult(opening.scope).json !== createCanonicalResult(expectedScope).json ||
      typeof url !== "string" ||
      !relayUrlPattern.test(url) ||
      new URL(url).href !== url ||
      Number(new URL(url).port) > 65_535 ||
      typeof bearerToken !== "string" ||
      !bearerPattern.test(bearerToken) ||
      Buffer.from(bearerToken, "base64url").byteLength !== 32 ||
      Buffer.from(bearerToken, "base64url").toString("base64url") !== bearerToken
    )
      throw new Error();
    const bearer = `Bearer ${bearerToken}`;
    const configurationOverrides = [
      `model=${JSON.stringify(expectedScope.requestedModel)}`,
      `model_provider=${JSON.stringify(providerId)}`,
      `model_providers={${providerId}={name="Agentic Review parent relay",base_url=${JSON.stringify(url)},wire_api="responses",supports_websockets=false,requires_openai_auth=false,env_http_headers={Authorization=${JSON.stringify(providerHeader)}}}}`,
    ];
    if (configurationOverrides.some((override) => override.includes(bearerToken)))
      throw new Error();
    // Do not merge legacy model providers, auth helpers, retries or provider environment here.
    // This describes requested CLI configuration only, not an observed effective launch policy.
    return Object.freeze({
      configurationOverrides: Object.freeze(configurationOverrides),
      providerEnvironment: Object.freeze({ [providerHeader]: bearer }),
      protectedValues: Object.freeze([bearerToken, bearer]),
    });
  } catch {
    throw new ModelRelayLaunchError();
  }
}
