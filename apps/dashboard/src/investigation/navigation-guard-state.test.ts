import { describe, expect, it } from "vitest";
import {
  activeGuardEntries,
  blocksNavigation,
  type NavigationProtection,
} from "./navigation-guard-state";

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

  describe("a retained reply-template editor", () => {
    const replies = {
      pathname: "/repositories",
      search: "?repositoryId=repo-one&tab=replies&replyTemplate=pullRequest&q=PowerToys",
    };
    const protection: NavigationProtection = {
      dirty: true,
      allowPresentationNavigation: true,
      presentationParameters: ["replyTemplate"],
    };

    it("allows only the selected template to change, including default selection and reordered parameters", () => {
      const next = {
        ...replies,
        search: "?q=PowerToys&replyTemplate=issue&tab=replies&repositoryId=repo-one",
      };
      expect(blocksNavigation([protection], replies, next)).toBe(false);
      const defaultTemplate = {
        ...replies,
        search: "?repositoryId=repo-one&tab=replies&q=PowerToys",
      };
      expect(blocksNavigation([protection], replies, defaultTemplate)).toBe(false);
      expect(blocksNavigation([protection], defaultTemplate, next)).toBe(false);
      expect(protection.dirty).toBe(true);
      expect(protection.presentationParameters).toEqual(["replyTemplate"]);
    });

    it.each([
      [
        "repository",
        "/repositories",
        "?repositoryId=repo-two&tab=replies&replyTemplate=issue&q=PowerToys",
      ],
      [
        "settings tab",
        "/repositories",
        "?repositoryId=repo-one&tab=intake&replyTemplate=issue&q=PowerToys",
      ],
      [
        "record binding",
        "/repositories",
        "?repositoryId=repo-one&tab=replies&replyTemplate=issue&q=PowerToys&workItemId=another-source",
      ],
      [
        "another presentation parameter",
        "/repositories",
        "?repositoryId=repo-one&tab=replies&replyTemplate=issue&q=PowerToys&findingId=another-finding",
      ],
      [
        "directory filter",
        "/repositories",
        "?repositoryId=repo-one&tab=replies&replyTemplate=issue&q=another-query",
      ],
      ["page", "/reports", "?repositoryId=repo-one&reportId=report-one&replyTemplate=issue"],
    ])(
      "still protects a changed %s while a template selection also changes",
      (_label, pathname, search) => {
        expect(blocksNavigation([protection], replies, { pathname, search })).toBe(true);
      },
    );

    it("requires the presentation-navigation opt-in even when a parameter list is supplied", () => {
      expect(
        blocksNavigation([{ ...protection, allowPresentationNavigation: false }], replies, {
          ...replies,
          search: replies.search.replace("pullRequest", "issue"),
        }),
      ).toBe(true);
      expect(
        blocksNavigation([{ ...protection, presentationParameters: [] }], replies, {
          ...replies,
          search: replies.search.replace("pullRequest", "issue"),
        }),
      ).toBe(true);
    });

    it.each([false, true])("blocks a template switch while submitting (dirty=%s)", (dirty) => {
      expect(
        blocksNavigation([{ ...protection, dirty, busy: true }], replies, {
          ...replies,
          search: replies.search.replace("pullRequest", "issue"),
        }),
      ).toBe(true);
      expect(blocksNavigation([{ ...protection, dirty, busy: true }], replies, replies)).toBe(
        false,
      );
    });

    it("does not let one editor's exception bypass another active draft or busy operation", () => {
      const next = { ...replies, search: replies.search.replace("pullRequest", "issue") };
      expect(
        blocksNavigation([protection, { dirty: true, scope: "another-form" }], replies, next),
      ).toBe(true);
      expect(
        blocksNavigation(
          [protection, { dirty: false, busy: true, scope: "operation" }],
          replies,
          next,
        ),
      ).toBe(true);
      expect(blocksNavigation([protection, { dirty: false, busy: false }], replies, next)).toBe(
        false,
      );
    });
  });
});
