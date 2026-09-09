import type {
  EvaluationModelRequirementsV1,
  ModelRuntimeRegistrationV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  assertEvaluationModelRuntimeRegistrationIntegrity,
  modelRuntimeIdentityDigest,
  modelRuntimeRegistrationDigest,
} from "./model-runtime-verification.js";

function fixture() {
  const identity: ModelRuntimeRegistrationV1["identity"] = {
    schemaVersion: "ModelRuntimeIdentityV1",
    providerId: "fixture-provider",
    endpointSha256: "a".repeat(64),
    modelId: "observed-model-version",
    client: {
      kind: "codex_cli",
      version: "fixture-cli",
      executableSha256: "b".repeat(64),
      launchPolicySha256: "c".repeat(64),
    },
    relay: { implementationSha256: "d".repeat(64), policySha256: "e".repeat(64) },
  };
  const registration: ModelRuntimeRegistrationV1 = {
    schemaVersion: "ModelRuntimeRegistrationV1",
    id: "runtime-1",
    name: "Frozen expected runtime",
    requestedModel: "requested-alias",
    identity,
    identitySha256: modelRuntimeIdentityDigest(identity),
    createdAt: "2026-09-08T00:00:00.000Z",
    createdBy: { issuer: "https://fixture.invalid", subject: "admin" },
  };
  const requirements: EvaluationModelRequirementsV1 = {
    required: true,
    expectedModelIdentityDigest: registration.identitySha256,
    runtimeRegistration: {
      registrationId: registration.id,
      registrationSha256: modelRuntimeRegistrationDigest(registration),
    },
  };
  return { registration, requirements };
}

describe("Frozen model runtime registration integrity", () => {
  it("checks the complete registration while retaining distinct requested and expected model names", () => {
    const f = fixture();
    expect(f.registration.requestedModel).not.toBe(f.registration.identity.modelId);
    expect(() =>
      assertEvaluationModelRuntimeRegistrationIntegrity(f.requirements, f.registration),
    ).not.toThrow();
    const reordered = Object.fromEntries(
      Object.entries(f.registration).reverse(),
    ) as ModelRuntimeRegistrationV1;
    expect(modelRuntimeRegistrationDigest(reordered)).toBe(
      f.requirements.runtimeRegistration?.registrationSha256,
    );
  });
  it.each(["name", "requestedModel"] as const)("does not accept a changed frozen %s", (field) => {
    const f = fixture();
    f.registration[field] = "Changed registration field";
    expect(() =>
      assertEvaluationModelRuntimeRegistrationIntegrity(f.requirements, f.registration),
    ).toThrow();
  });
  it("rejects a forged identity digest even when a caller would reseal the surrounding registration", () => {
    const f = fixture();
    f.registration.identity.client.launchPolicySha256 = "f".repeat(64);
    expect(() => modelRuntimeRegistrationDigest(f.registration)).toThrow();
    expect(() =>
      assertEvaluationModelRuntimeRegistrationIntegrity(f.requirements, f.registration),
    ).toThrow();
  });
  it("rejects a different runtime even if its new identity digest is internally consistent", () => {
    const f = fixture();
    f.registration.identity.modelId = "different-observed-version";
    f.registration.identitySha256 = modelRuntimeIdentityDigest(f.registration.identity);
    expect(() =>
      assertEvaluationModelRuntimeRegistrationIntegrity(f.requirements, f.registration),
    ).toThrow();
  });
  it("requires the exact registration identity and both sides of the frozen binding", () => {
    const f = fixture();
    expect(() => assertEvaluationModelRuntimeRegistrationIntegrity(f.requirements)).toThrow();
    expect(() =>
      assertEvaluationModelRuntimeRegistrationIntegrity(
        { required: true, expectedModelIdentityDigest: f.registration.identitySha256 },
        f.registration,
      ),
    ).toThrow();
    f.registration.id = "other-registration";
    expect(() =>
      assertEvaluationModelRuntimeRegistrationIntegrity(f.requirements, f.registration),
    ).toThrow();
  });
  it("does not rewrite historical unknown configuration or attach execution verification", () => {
    const historical: EvaluationModelRequirementsV1 = {
      required: true,
      expectedModelIdentityDigest: null,
    };
    const before = JSON.stringify(historical);
    expect(assertEvaluationModelRuntimeRegistrationIntegrity(historical)).toBeUndefined();
    expect(JSON.stringify(historical)).toBe(before);
    expect(historical).not.toHaveProperty("runtimeRegistration");
  });
});
