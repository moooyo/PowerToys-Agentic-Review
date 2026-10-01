import {
  createInvestigationPreview,
  type InvestigationNativePromptContent,
  type InvestigationNativePromptKind,
  type InvestigationTaskV1,
  nativePromptBuiltInContent,
  nativePromptRuntimeConstraints,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { describe, expect, it } from "vitest";
import { renderNativePromptInstructions } from "./native-prompt.js";

const kinds = ["pr-review", "issue-investigate"] as const;
const modes = ["localCheckout", "snapshot"] as const;
const cases = kinds.flatMap((kind) => modes.map((mode) => ({ kind, mode })));
const runtimeOptions = {
  autonomousSnapshot: true,
  recipeGuidance: ["Retain the selected fixture recipe guidance."],
  baselineGuidance: ["Recheck every retained fixture baseline finding."],
} as const;

function legacyTask(kind: InvestigationNativePromptKind): InvestigationTaskV1 {
  return createInvestigationPreview(kind === "pr-review" ? "pr" : "bug", {
    findingCount: 0,
  }).task;
}

function frozenTask(
  kind: InvestigationNativePromptKind,
  content: InvestigationNativePromptContent = {
    localCheckout:
      "Apply the frozen local review checklist.\nPreserve its exact trailing spaces.  ",
    snapshot: "Apply the frozen snapshot review checklist.\nPreserve its exact trailing spaces.  ",
  },
): InvestigationTaskV1 {
  const ref = {
    id: `native-${kind}-fixture`,
    version: 3,
    digest: investigationContentDigest(content),
  };
  return {
    ...legacyTask(kind),
    promptRef: ref,
    promptSnapshot: { kind, ref: { ...ref }, content: { ...content } },
  };
}

describe("frozen native Worker prompt instructions", () => {
  it.each(cases)("uses the frozen $kind content for $mode", ({ kind, mode }) => {
    const task = frozenTask(kind);
    const content = task.promptSnapshot!.content;
    const instructions = renderNativePromptInstructions(task, mode, runtimeOptions);

    expect(instructions.startsWith(`${content[mode]}\n\n`)).toBe(true);
    expect(instructions).not.toContain(content[mode === "snapshot" ? "localCheckout" : "snapshot"]);
    expect(instructions).not.toContain(nativePromptBuiltInContent(kind)[mode]);
    expect(instructions).toContain(runtimeOptions.recipeGuidance[0]);
    expect(instructions).toContain(runtimeOptions.baselineGuidance[0]);
  });

  it.each(cases)("retains the $kind runtime constraints after editing $mode", ({ kind, mode }) => {
    const task = frozenTask(kind, {
      localCheckout: "Use the edited local review checklist only.",
      snapshot: "Use the edited snapshot review checklist only.",
    });
    const instructions = renderNativePromptInstructions(task, mode, runtimeOptions);
    const constraints = nativePromptRuntimeConstraints({
      ...runtimeOptions,
      kind,
      analysisTask: true,
      snapshotOnly: task.executionPolicy.mode === "snapshot_only",
    })[mode];

    expect(instructions.endsWith(constraints)).toBe(true);
    expect(instructions).toContain("InvestigationModelTurnDeltaV1");
    expect(instructions).toContain("Return only the required JSON object.");
    expect(instructions).toContain("Copy taskId, attemptId");
    if (mode === "localCheckout") {
      expect(instructions).toContain(
        "STATIC REVIEW ONLY: Do not restore dependencies, build, run tests",
      );
      expect(instructions).toContain(
        "Do not edit, comment on, or otherwise mutate any external PR or issue.",
      );
    } else {
      expect(instructions).toContain(
        "Only analyze the supplied snapshots and complete source files.",
      );
      expect(instructions).toContain("Do not edit files or external PRs/issues.");
    }
  });

  it.each(modes)("rejects altered frozen content before rendering %s", (mode) => {
    const task = frozenTask("pr-review");
    task.promptSnapshot!.content.snapshot += " Altered after freezing.";

    expect(() => renderNativePromptInstructions(task, mode, runtimeOptions)).toThrow(
      "The frozen native prompt content does not match the task prompt reference.",
    );
  });

  it.each(["id", "version", "digest", "kind"] as const)(
    "rejects a frozen snapshot with a mismatched %s",
    (field) => {
      const task = frozenTask("pr-review");
      const snapshot = task.promptSnapshot!;
      if (field === "id") snapshot.ref.id = "another-native-prompt";
      else if (field === "version") snapshot.ref.version += 1;
      else if (field === "digest") snapshot.ref.digest = "0".repeat(64);
      else snapshot.kind = "issue-investigate";

      expect(() => renderNativePromptInstructions(task, "localCheckout", runtimeOptions)).toThrow(
        "The frozen native prompt content does not match the task prompt reference.",
      );
    },
  );

  it.each(cases)("uses built-in $kind content for an old $mode task", ({ kind, mode }) => {
    const task = legacyTask(kind);
    const builtIn = nativePromptBuiltInContent(kind)[mode];
    const historicalRef = { ...task.promptRef };
    const instructions = renderNativePromptInstructions(task, mode, runtimeOptions);

    expect(task.promptSnapshot).toBeUndefined();
    expect(historicalRef.digest).not.toBe(
      investigationContentDigest(nativePromptBuiltInContent(kind)),
    );
    expect(instructions.startsWith(`${builtIn}\n\n`)).toBe(true);
    expect(instructions).toContain("InvestigationModelTurnDeltaV1");
    expect(task.promptRef).toEqual(historicalRef);
  });
});
