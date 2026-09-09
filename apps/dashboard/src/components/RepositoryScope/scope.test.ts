import { describe, expect, it } from "vitest";
import { parseRepositoryScope, pathWithRepositoryScope, searchWithRepositoryScope } from "./scope";

describe("parseRepositoryScope", () => {
  it.each(["", "?", "?status=running&page=2"])(
    "selects all repositories when the scope is absent from %j",
    (search) => {
      expect(parseRepositoryScope(search)).toEqual({ kind: "all", key: "all" });
    },
  );

  it.each(["repository-1", "A", "repo:unknown._-42", "r".repeat(128)])(
    "accepts one syntactically valid repository id %j without an inventory lookup",
    (repositoryId) => {
      const search = `?${new URLSearchParams({ repositoryId }).toString()}`;

      expect(parseRepositoryScope(search)).toEqual({
        kind: "repository",
        key: JSON.stringify([repositoryId]),
        repositoryId,
      });
    },
  );

  it.each([
    { label: "different repository ids", values: ["repo-1", "repo-2"] },
    { label: "the same repository id twice", values: ["repo-1", "repo-1"] },
    { label: "an empty repository id", values: [""] },
    { label: "a valid id and an empty id", values: ["repo-1", ""] },
    { label: "whitespace", values: [" "] },
    { label: "a trailing newline", values: ["repo-1\n"] },
    { label: "a slash", values: ["owner/repo"] },
    { label: "a leading separator", values: ["-repo"] },
    { label: "a non-ASCII id", values: ["r\u00e9po"] },
    { label: "an overlong id", values: ["r".repeat(129)] },
  ])("rejects $label without selecting all repositories", ({ values }) => {
    const parameters = new URLSearchParams();
    for (const value of values) parameters.append("repositoryId", value);

    expect(parseRepositoryScope(`?${parameters.toString()}`)).toMatchObject({
      kind: "invalid",
      key: JSON.stringify(values),
      message: expect.any(String),
    });
  });

  it("treats a bare repositoryId parameter as an invalid empty selection", () => {
    expect(parseRepositoryScope("?repositoryId")).toMatchObject({
      kind: "invalid",
      key: '[""]',
    });
  });
});

describe("pathWithRepositoryScope", () => {
  it("replaces the destination scope while preserving its other parameters and hash", () => {
    expect(
      pathWithRepositoryScope(
        "/jobs?status=running&repositoryId=old-1&tag=one&repositoryId=old-2&tag=two#details?tab=log",
        "?repositoryId=repo:new-1&page=9",
      ),
    ).toBe("/jobs?status=running&tag=one&tag=two&repositoryId=repo%3Anew-1#details?tab=log");
  });

  it("preserves an unknown valid repository across repeated navigation until explicitly cleared", () => {
    const repositoryId = "repo:missing-404";
    let search = `?repositoryId=${encodeURIComponent(repositoryId)}`;

    for (const path of ["/work-items", "/jobs?status=failed#latest", "/workers"]) {
      const destination = new URL(
        pathWithRepositoryScope(path, search),
        "https://dashboard.example",
      );
      search = destination.search;

      expect(parseRepositoryScope(search)).toMatchObject({ kind: "repository", repositoryId });
    }

    const clearedSearch = searchWithRepositoryScope(search, undefined);
    expect(parseRepositoryScope(clearedSearch)).toEqual({ kind: "all", key: "all" });
    expect(pathWithRepositoryScope("/jobs#latest", clearedSearch)).toBe("/jobs#latest");
  });

  it.each([
    { label: "duplicate ids", search: "?repositoryId=repo-1&repositoryId=repo-2" },
    { label: "identical duplicate ids", search: "?repositoryId=repo-1&repositoryId=repo-1" },
    { label: "an empty id", search: "?repositoryId=" },
    { label: "an illegal id", search: "?repositoryId=owner%2Frepo+name" },
  ])("preserves $label and the invalid selection across navigation", ({ search }) => {
    const originalValues = new URLSearchParams(search).getAll("repositoryId");
    const originalSelection = parseRepositoryScope(search);
    expect(originalSelection.kind).toBe("invalid");

    const first = new URL(
      pathWithRepositoryScope("/jobs?repositoryId=old&status=failed#latest", search),
      "https://dashboard.example",
    );
    const second = new URL(
      pathWithRepositoryScope("/work-items?sort=updated#queue", first.search),
      "https://dashboard.example",
    );

    for (const destination of [first, second]) {
      expect(destination.searchParams.getAll("repositoryId")).toEqual(originalValues);
      expect(parseRepositoryScope(destination.search)).toEqual(originalSelection);
    }
    expect(first.searchParams.get("status")).toBe("failed");
    expect(first.hash).toBe("#latest");
    expect(second.searchParams.get("sort")).toBe("updated");
    expect(second.hash).toBe("#queue");
  });

  it("keeps an existing all-repositories selection when the destination contains an old scope", () => {
    expect(pathWithRepositoryScope("/jobs?repositoryId=old&status=running#latest", "?page=3")).toBe(
      "/jobs?status=running#latest",
    );
    expect(pathWithRepositoryScope("/jobs?repositoryId=old#latest", "")).toBe("/jobs#latest");
  });
});

describe("searchWithRepositoryScope", () => {
  it("drops the old exact target when the operator changes repository", () => {
    expect(
      searchWithRepositoryScope(
        "?repositoryId=repo-a&workItemId=item-a&reviewRunId=run-a&requestId=req-a&jobId=job-a&publicationId=pub-a&status=failed",
        "repo-b",
      ),
    ).toBe("?status=failed&repositoryId=repo-b");
  });
  it("switches to one repository while preserving all unrelated query parameters", () => {
    const search = searchWithRepositoryScope(
      "?status=running&repositoryId=old-1&tag=one&repositoryId=old-2&tag=two&page=3",
      "repo:new-1",
    );

    expect(search).toBe("?status=running&tag=one&tag=two&page=3&repositoryId=repo%3Anew-1");
    expect(parseRepositoryScope(search)).toMatchObject({
      kind: "repository",
      repositoryId: "repo:new-1",
    });
  });

  it("clears every scope value only when explicitly selecting undefined", () => {
    const search = searchWithRepositoryScope(
      "?status=running&repositoryId=old-1&tag=one&repositoryId=old-2&tag=two",
      undefined,
    );

    expect(search).toBe("?status=running&tag=one&tag=two");
    expect(parseRepositoryScope(search)).toEqual({ kind: "all", key: "all" });
    expect(searchWithRepositoryScope("?repositoryId=old", undefined)).toBe("");
  });

  it.each(["", " ", "owner/repo"])(
    "retains an invalid replacement %j instead of clearing the scope",
    (repositoryId) => {
      const search = searchWithRepositoryScope("?repositoryId=old&status=running", repositoryId);

      expect(new URLSearchParams(search).getAll("repositoryId")).toEqual([repositoryId]);
      expect(new URLSearchParams(search).get("status")).toBe("running");
      expect(parseRepositoryScope(search)).toMatchObject({
        kind: "invalid",
        key: JSON.stringify([repositoryId]),
      });
    },
  );

  it("adds a repository selection to an empty search", () => {
    expect(searchWithRepositoryScope("", "repo-1")).toBe("?repositoryId=repo-1");
  });
});
