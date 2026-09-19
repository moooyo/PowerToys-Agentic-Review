import { describe, expect, it } from "vitest";
import { activeGuardEntries, blocksNavigation } from "./navigation-guard-state";

describe("navigation protection boundaries", () => {
  const report = { pathname: "/reports", search: "?reportId=report-one&section=findings" };

  it("retains a report draft while reading another finding but protects a different report", () => {
    const draft = [{ dirty: true, allowPresentationNavigation: true }];
    expect(
      blocksNavigation(draft, report, {
        ...report,
        search: "?section=evidence&reportId=report-one&findingId=finding-two",
      }),
    ).toBe(false);
    expect(
      blocksNavigation(draft, report, {
        ...report,
        search: "?reportId=report-two&section=findings",
      }),
    ).toBe(true);
    expect(
      blocksNavigation(draft, report, { pathname: "/tasks", search: "?taskId=task-one" }),
    ).toBe(true);
  });

  it("keeps settings tabs protected unless their form explicitly retains presentation state", () => {
    const settings = { pathname: "/repositories", search: "?repositoryId=repo-one&tab=intake" };
    expect(
      blocksNavigation([{ dirty: true }], settings, {
        ...settings,
        search: "?repositoryId=repo-one&tab=replies",
      }),
    ).toBe(true);
    expect(
      blocksNavigation([{ dirty: false }], settings, {
        ...settings,
        search: "?repositoryId=repo-one&tab=replies",
      }),
    ).toBe(false);
  });

  it("protects a busy submission even when it normally retains presentation changes", () => {
    expect(
      blocksNavigation([{ dirty: false, busy: true, allowPresentationNavigation: true }], report, {
        ...report,
        search: "?reportId=report-one&section=details",
      }),
    ).toBe(true);
    expect(blocksNavigation([{ dirty: true, busy: true }], report, report)).toBe(false);
  });

  it("local dialog closure never selects the underlying draft for discard", () => {
    const entries = [
      { dirty: true, scope: "feedback", identity: "private-feedback" },
      { dirty: true, scope: "report-action:one", identity: "private-action" },
      { dirty: false, busy: true, scope: "another-operation", identity: "pending-request" },
    ];
    expect(activeGuardEntries(entries, "report-action:one").map((entry) => entry.identity)).toEqual(
      ["private-action"],
    );
    expect(activeGuardEntries(entries).map((entry) => entry.identity)).toEqual([
      "private-feedback",
      "private-action",
      "pending-request",
    ]);
    expect(entries[0]?.dirty).toBe(true);
  });
});
