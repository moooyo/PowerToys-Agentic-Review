import { describe, expect, it } from "vitest";
import {
  savedDuplicateTarget,
  savedPlanSubject,
  savedSubjectDescription,
} from "./action-composer-source";
import { createSampleInvestigationApi } from "./sample-adapter";

describe("publication source bindings", () => {
  it("uses the exact saved plan subject instead of substituting the current work item head", async () => {
    const api = createSampleInvestigationApi();
    const result = await api.exportReport("sample-pr-p1-report");
    const plan = result.plans[0];
    if (!plan) throw new Error("A saved plan is required for this test.");
    const subject = savedPlanSubject(result, plan);
    expect(subject?.id).toBe(plan.subjectRef);
    expect(savedSubjectDescription(subject)).not.toContain("unavailable");
    expect(savedPlanSubject(result, { ...plan, subjectRef: "unretained-subject" })).toBeUndefined();
  });

  it("only accepts another Issue identified by the saved same-repository assessment", async () => {
    const api = createSampleInvestigationApi();
    const source = await api.exportReport("sample-bug-report");
    const workItem = await api.workItem(source.context.workItem.id);
    if (source.assessment.kind !== "bug") throw new Error("Expected a bug report.");
    const number = workItem.number + 1,
      name = source.context.repository.fullName;
    const withIdentifier = (identifier: string) => ({
      ...source,
      assessment:
        source.assessment.kind === "bug"
          ? {
              ...source.assessment,
              bugAssessment: {
                ...source.assessment.bugAssessment,
                duplicateOf: {
                  identifier,
                  explanation: "Saved duplicate assessment",
                  evidenceRefs: [source.assessment.evidenceRefs[0] ?? "saved-evidence"],
                },
              },
            }
          : source.assessment,
    });
    for (const identifier of [
      String(number),
      `#${number}`,
      `${name}#${number}`,
      `https://github.com/${name}/issues/${number}`,
    ]) {
      expect(savedDuplicateTarget(withIdentifier(identifier), workItem)?.number).toBe(number);
    }
    for (const identifier of [
      `#${workItem.number}`,
      `other/repository#${number}`,
      `https://github.com/${name}/pull/${number}`,
      `https://github.com/${name}/issues/${number}?extra=1`,
      `https://user@github.com/${name}/issues/${number}`,
      "#9007199254740992",
    ]) {
      expect(savedDuplicateTarget(withIdentifier(identifier), workItem)).toBeNull();
    }
    expect(savedDuplicateTarget(undefined, workItem)).toBeNull();
    expect(
      savedDuplicateTarget(withIdentifier(`#${number}`), {
        ...workItem,
        repositoryId: "another-repository",
      }),
    ).toBeNull();
  });
});
