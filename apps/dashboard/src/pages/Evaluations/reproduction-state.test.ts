import * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { observationRefKey } from "@/components/CreateReviewRun/reproduction";
import { batchPromptOptionsFixture } from "@/services/evaluation-batches/fixtures.testing";
import type { EvaluationReproductionAdapter } from "@/services/evaluation-reproduction";
import {
  reproductionCaseFixture,
  reproductionCellFixture,
  reproductionPlanFixture,
  reproductionPreviewFixture,
  reproductionProfileFixture,
  reproductionSourceFixture,
} from "@/services/evaluation-reproduction/fixtures.testing";
import { suiteVersionFixture } from "@/services/evaluations/fixtures.testing";
import { createBatchRequest, criterionKey } from "./batch-state";
import {
  assertFrozenReproductionCell,
  assertReproductionPreview,
  buildReproductionSelections,
  clearReproductionArm,
  loadReproductionSources,
  type ReproductionDrafts,
  reproductionDraft,
  reproductionPreviewKey,
  reproductionPreviewRequest,
  reproductionRequirements,
  requireReproductionPreviews,
} from "./reproduction-state";

function fixture() {
  const entry = reproductionCaseFixture(),
    read = reproductionSourceFixture();
  if (!read.sourceDefinitionSha256 || !read.sourceDefinition)
    throw new Error("Original definition required.");
  const originalKey = reproductionRequirements(read.sourceDefinition.binding.cases).observations[0]
    ?.key;
  if (!originalKey) throw new Error("Observation required.");
  const drafts: ReproductionDrafts = {
    [entry.caseId]: {
      sourceDefinitionSha256: read.sourceDefinitionSha256,
      selectedCaseIds: ["original-case"],
      baseline: {
        observations: {
          [originalKey]: observationRefKey({
            kind: "probe_value",
            testStepId: "measure",
            observationId: "count",
          }),
        },
        checks: { "original-profile:build": "profile-baseline:build" },
      },
      candidate: {
        observations: { [originalKey]: null },
        checks: { "original-profile:build": null },
      },
    },
  };
  return {
    cases: [entry],
    sources: { [entry.source.id]: read },
    drafts,
    profiles: {
      baseline: reproductionProfileFixture(),
      candidate: reproductionProfileFixture("candidate"),
    },
    originalKey,
  };
}

function uiProfile(target: "web" | "windows_desktop"): C.ValidationProfileVersion {
  const profile = reproductionProfileFixture();
  const step: C.ValidationCommandStep = {
    id: "launch",
    name: "Launch public fixture",
    command: { executable: "fixture", args: [], workingDirectory: ".", environment: [] },
    timeoutMs: 1000,
    required: true,
  };
  const shared = { id: "screen", name: "Save screen", required: true, timeoutMs: 2000 };
  const ui: C.WebUiConfiguration | C.WindowsUiConfiguration =
    target === "web"
      ? {
          schemaVersion: "UiScenariosV1",
          target,
          service: {
            origin: "managed_loopback",
            portEnvironmentVariable: "PORT",
            navigation: "same_origin",
          },
          browser: { engine: "chromium", headless: true, viewport: { width: 1280, height: 720 } },
          launch: {
            stepId: "launch",
            mode: "persistent",
            readiness: { kind: "http", path: "/", expectedStatus: 200, timeoutMs: 1000 },
          },
          reset: { strategy: "restart_process" },
          evidence: {
            screenshots: "every_assertion",
            screenshotScope: "viewport",
            required: true,
            trace: "off",
          },
          scenarios: [
            {
              ...shared,
              path: "/",
              steps: [
                {
                  id: "status",
                  name: "Status text",
                  action: "assertText",
                  expected: "Saved",
                  match: "exact",
                  timeoutMs: 1000,
                  locator: { by: "testId", testId: "status" },
                },
              ],
            },
          ],
        }
      : {
          schemaVersion: "UiScenariosV1",
          target,
          desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
          launch: {
            stepId: "launch",
            mode: "persistent",
            readiness: { kind: "window", window: { title: "Public fixture" }, timeoutMs: 1000 },
          },
          reset: { strategy: "restart_process" },
          evidence: {
            screenshots: "every_assertion",
            screenshotScope: "owned_window",
            required: true,
          },
          scenarios: [
            {
              ...shared,
              steps: [
                {
                  id: "status",
                  name: "Status text",
                  action: "assertText",
                  expected: "Saved",
                  match: "exact",
                  timeoutMs: 1000,
                  locator: { by: "automationId", automationId: "status" },
                },
              ],
            },
          ],
        };
  return {
    ...profile,
    workflowKind: "issue_validation",
    target,
    outputSchemaVersion: "ValidationReportV1",
    config: { ...profile.config, launch: [step], ui },
  };
}

describe("explicit evaluation reproduction configuration", () => {
  it("preserves original predicates and maps the execution references independently of criterion labels", () => {
    const value = fixture(),
      original = structuredClone(value.sources);
    const selections = buildReproductionSelections(value);
    expect(selections[0]?.baseline.observationMappings[0]?.to).toEqual({
      kind: "probe_value",
      testStepId: "measure",
      observationId: "count",
    });
    expect(selections[0]?.candidate.observationMappings[0]?.to).toBeNull();
    value.cases[0]!.expectation.criteria = [];
    value.cases[0]!.expectation.findings = { annotation: "complete", expected: [] };
    expect(buildReproductionSelections(value)).toEqual(selections);
    expect(value.sources).toEqual(original);
    expect(
      original["source-a"]?.sourceDefinition?.binding.cases[0]?.presentWhen.allOf[0]?.equals,
    ).toEqual({ type: "number", value: 0 });
  });
  it("requires explicit case and mapping choices but accepts explicit null targets", () => {
    const value = fixture();
    expect(() => buildReproductionSelections({ ...value, drafts: {} })).toThrow(
      /Select reproduction cases/u,
    );
    value.drafts["case-1"]!.selectedCaseIds.length = 0;
    expect(() => buildReproductionSelections(value)).toThrow(/Explicitly select/u);
    value.drafts["case-1"]!.selectedCaseIds.push("original-case");
    delete value.drafts["case-1"]!.candidate.observations[value.originalKey];
    expect(() => buildReproductionSelections(value)).toThrow(/explicit Unmapped/u);
    value.drafts["case-1"]!.candidate.observations[value.originalKey] = null;
    expect(buildReproductionSelections(value)[0]?.candidate.checkMappings[0]?.toCheckId).toBeNull();
  });
  it("rejects wrong observation types and checks outside the exact profile", () => {
    const value = fixture();
    value.drafts["case-1"]!.baseline.observations[value.originalKey] = observationRefKey({
      kind: "probe_value",
      testStepId: "measure",
      observationId: "visible",
    });
    expect(() => buildReproductionSelections(value)).toThrow(/different type/u);
    value.drafts["case-1"]!.baseline.observations[value.originalKey] = null;
    value.drafts["case-1"]!.baseline.checks["original-profile:build"] = "other-profile:build";
    expect(() => buildReproductionSelections(value)).toThrow(/precondition check is unavailable/u);
  });
  it.each(["web", "windows_desktop"] as const)(
    "maps string observations to declared %s assertions",
    (target) => {
      const value = fixture();
      value.profiles.baseline = uiProfile(target);
      const original = value.sources["source-a"]!.sourceDefinition!.binding.cases[0]!;
      original.presentWhen.allOf[0]!.equals = { type: "string", value: "" };
      original.absentWhen!.allOf[0]!.equals = { type: "string", value: "Saved" };
      value.drafts["case-1"]!.baseline.observations[value.originalKey] = observationRefKey({
        kind: "ui_assertion",
        scenarioId: "screen",
        stepId: "status",
      });
      expect(buildReproductionSelections(value)[0]?.baseline.observationMappings[0]?.to).toEqual({
        kind: "ui_assertion",
        scenarioId: "screen",
        stepId: "status",
      });
      value.profiles.baseline.config.launch[0]!.command.environment.push({
        name: "FIXTURE_TOKEN",
        secretRef: "fixture-reference",
      });
      expect(() => buildReproductionSelections(value)).toThrow(/unavailable/u);
    },
  );
  it("requires Web tracing to remain explicitly off for mapped observations", () => {
    const value = fixture();
    value.profiles.baseline = uiProfile("web");
    const ui = value.profiles.baseline.config.ui;
    if (!ui || ui.target !== "web") throw new Error("Web fixture required.");
    ui.evidence.trace = "always";
    expect(() => buildReproductionSelections(value)).toThrow(/unavailable/u);
  });
  it("clears only the changed profile arm and invalidates its original preview", () => {
    const value = fixture(),
      draft = value.drafts["case-1"]!;
    value.drafts["case-1"] = {
      ...draft,
      preview: { key: "previous-preview", value: reproductionPreviewFixture() },
    };
    const updated = clearReproductionArm(value.drafts, "baseline");
    expect(updated["case-1"]?.baseline).toEqual({ observations: {}, checks: {} });
    expect(updated["case-1"]?.candidate).toEqual(draft.candidate);
    expect(updated["case-1"]?.selectedCaseIds).toEqual(["original-case"]);
    expect(updated["case-1"]?.preview).toBeUndefined();
    expect(reproductionDraft(draft, "f".repeat(64)).selectedCaseIds).toEqual([]);
  });
  it("allows a blocked authoritative preview and rejects stale source or profile previews", () => {
    const value = fixture(),
      selections = buildReproductionSelections(value),
      selection = selections[0]!;
    const source = value.sources["source-a"]!,
      request = reproductionPreviewRequest("source-a", selection, value.profiles),
      preview = reproductionPreviewFixture();
    const key = reproductionPreviewKey(request, source.sourceDefinitionSha256!, value.profiles);
    value.drafts["case-1"] = { ...value.drafts["case-1"]!, preview: { key, value: preview } };
    expect(() =>
      requireReproductionPreviews(
        selections,
        value.cases,
        value.sources,
        value.drafts,
        value.profiles,
      ),
    ).not.toThrow();
    expect(() =>
      assertReproductionPreview(preview, request, "f".repeat(64), value.profiles),
    ).toThrow(/exact source/u);
    value.profiles.candidate.configSha256 = "f".repeat(64);
    expect(() =>
      requireReproductionPreviews(
        selections,
        value.cases,
        value.sources,
        value.drafts,
        value.profiles,
      ),
    ).toThrow(/changed/u);
  });
  it("keeps absent historical reproduction on the original batch request path", () => {
    const value = fixture();
    value.sources["source-a"]!.sourceDefinition = null;
    value.sources["source-a"]!.sourceDefinitionSha256 = null;
    expect(buildReproductionSelections({ ...value, drafts: {} })).toEqual([]);
    expect(() =>
      requireReproductionPreviews([], value.cases, value.sources, {}, value.profiles),
    ).not.toThrow();
  });
  it("retains reproduction mappings in profile-only mode", () => {
    const value = fixture(),
      prompt = {
        ...batchPromptOptionsFixture().items[0]!,
        outputSchemaVersion: C.WorkflowOutputSchemaVersions.issue_validation,
      };
    const mappings = buildReproductionSelections(value);
    const request = createBatchRequest({
      changeId: "profile-only-reproduction",
      version: { ...suiteVersionFixture(), workflowKind: "issue_validation" },
      cases: value.cases,
      profiles: value.profiles,
      prompts: { baseline: prompt, candidate: prompt },
      mode: "profile_only",
      choices: { [criterionKey("case-1", "criterion-1")]: { baseline: null, candidate: null } },
      reproductionMappings: mappings,
    });
    expect(request.reproductionMappings).toEqual(mappings);
    expect(request.mode).toBe("profile_only");
    mappings[0]!.selectedCaseIds[0] = "changed-after-submit";
    expect(request.reproductionMappings?.[0]?.selectedCaseIds).toEqual(["original-case"]);
  });
  it("matches frozen records to the manifest digest and source instead of inferring activation IDs", () => {
    const detail = reproductionCellFixture(),
      manifest = reproductionPlanFixture().manifest!,
      source = reproductionSourceFixture(),
      profile = reproductionProfileFixture();
    const cell = {
      cellId: detail.cellId,
      caseId: detail.record.caseId,
      arm: detail.record.arm,
      sourceId: detail.record.sourceId,
      sourceDigest: source.sourceDefinition!.sourceDigest,
    } as C.EvaluationCellSummaryV1;
    expect(() =>
      assertFrozenReproductionCell({ detail, manifest, cell, profile, source }),
    ).not.toThrow();
    manifest.cells[0]!.cellRecordSha256 = "f".repeat(64);
    expect(() => assertFrozenReproductionCell({ detail, manifest, cell, profile, source })).toThrow(
      /frozen manifest/u,
    );
  });
});

describe("original reproduction source reads", () => {
  it("deduplicates exact sources while checking every frozen case source identity", async () => {
    const value = fixture();
    const api = {
      getSource: vi.fn(async () => reproductionSourceFixture()),
    } as unknown as EvaluationReproductionAdapter;
    await expect(loadReproductionSources(api, [value.cases[0]!, value.cases[0]!])).resolves.toEqual(
      value.sources,
    );
    expect(api.getSource).toHaveBeenCalledOnce();
    const other = structuredClone(value.cases[0]!);
    other.source.sourceDigest = "f".repeat(64);
    await expect(loadReproductionSources(api, [value.cases[0]!, other])).rejects.toThrow(
      /frozen evaluation source/u,
    );
  });
  it("stops source reads when the repository request is aborted", async () => {
    const controller = new AbortController(),
      api = { getSource: vi.fn() } as unknown as EvaluationReproductionAdapter;
    controller.abort();
    await expect(
      loadReproductionSources(api, fixture().cases, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(api.getSource).not.toHaveBeenCalled();
  });
});
