import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidatePromptPublication, promptQueryKeys } from "./queries";

const queryClients: QueryClient[] = [];
const cachedVersions = { items: [{ id: "published-1", version: 1 }], total: 1 };
const publishedVersions = {
  items: [
    { id: "published-2", version: 2 },
    { id: "published-1", version: 1 },
  ],
  total: 2,
};

const createQueryClient = (): QueryClient => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, gcTime: Infinity, retry: false },
    },
  });
  queryClients.push(queryClient);
  return queryClient;
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-07T00:00:00.000Z"));
});

afterEach(() => {
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.length = 0;
  vi.restoreAllMocks();
});

describe("prompt publication cache refresh", () => {
  it("fetches the newly published version immediately even while the picker cache is fresh", async () => {
    const queryClient = createQueryClient();
    const queryKey = promptQueryKeys.versionList("template-1", 1, 25);
    const fetchVersions = vi
      .fn<() => Promise<typeof cachedVersions>>()
      .mockResolvedValueOnce(cachedVersions)
      .mockResolvedValueOnce(publishedVersions);
    const query = { queryKey, queryFn: fetchVersions };

    await expect(queryClient.fetchQuery(query)).resolves.toEqual(cachedVersions);
    await expect(queryClient.fetchQuery(query)).resolves.toEqual(cachedVersions);
    expect(fetchVersions).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(queryKey)?.dataUpdatedAt).toBe(Date.now());

    await invalidatePromptPublication(queryClient, "template-1");

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    await expect(queryClient.fetchQuery(query)).resolves.toEqual(publishedVersions);
    expect(fetchVersions).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
  });

  it("updates active editor and binding pickers through their shared version list cache", async () => {
    const queryClient = createQueryClient();
    const fetchVersions = vi
      .fn<() => Promise<typeof cachedVersions>>()
      .mockResolvedValueOnce(cachedVersions)
      .mockResolvedValueOnce(publishedVersions);
    const editorQuery = {
      queryKey: promptQueryKeys.versionList("template-1", 1, 25),
      queryFn: fetchVersions,
    };
    const bindingPickerQuery = {
      queryKey: promptQueryKeys.versionList("template-1", 1, 25),
      queryFn: fetchVersions,
    };
    await queryClient.fetchQuery(editorQuery);

    const editorObserver = new QueryObserver(queryClient, editorQuery);
    const pickerObserver = new QueryObserver(queryClient, bindingPickerQuery);
    const onEditorUpdate = vi.fn();
    const onPickerUpdate = vi.fn();
    const unsubscribeEditor = editorObserver.subscribe(onEditorUpdate);
    const unsubscribePicker = pickerObserver.subscribe(onPickerUpdate);

    try {
      expect(editorObserver.getCurrentResult()).toMatchObject({
        data: cachedVersions,
        isStale: false,
      });
      expect(pickerObserver.getCurrentResult()).toMatchObject({
        data: cachedVersions,
        isStale: false,
      });
      expect(fetchVersions).toHaveBeenCalledTimes(1);

      await invalidatePromptPublication(queryClient, "template-1");

      expect(fetchVersions).toHaveBeenCalledTimes(2);
      expect(editorObserver.getCurrentResult().data).toEqual(publishedVersions);
      expect(pickerObserver.getCurrentResult().data).toEqual(publishedVersions);
      expect(onEditorUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: publishedVersions, isFetching: false, isStale: false }),
      );
      expect(onPickerUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: publishedVersions, isFetching: false, isStale: false }),
      );
    } finally {
      unsubscribeEditor();
      unsubscribePicker();
    }
  });

  it("invalidates every cached page and page size of the published template's versions", async () => {
    const queryClient = createQueryClient();
    const queries = [
      promptQueryKeys.versionList("template-1", 1, 25),
      promptQueryKeys.versionList("template-1", 2, 25),
      promptQueryKeys.versionList("template-1", 1, 50),
    ];
    for (const queryKey of queries) {
      queryClient.setQueryData(queryKey, cachedVersions);
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
    }

    await invalidatePromptPublication(queryClient, "template-1");

    for (const queryKey of queries) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryData(queryKey)).toEqual(cachedVersions);
    }
  });

  it("invalidates template lists and binding template pickers across workflows and pages", async () => {
    const queryClient = createQueryClient();
    const queries = [
      promptQueryKeys.templateList(1, 25, undefined),
      promptQueryKeys.templateList(2, 25, undefined),
      promptQueryKeys.templateList(1, 50, "pr_static_build"),
      promptQueryKeys.templateList(1, 25, "issue_triage"),
      promptQueryKeys.templatePicker("pr_static_build", 1, 25),
      promptQueryKeys.templatePicker("pr_ui", 2, 25),
      promptQueryKeys.templatePicker("issue_triage", 1, 50),
      promptQueryKeys.templatePicker("issue_validation", 1, 25),
    ];
    for (const queryKey of queries) {
      queryClient.setQueryData(queryKey, { latestPublishedVersionId: "published-1" });
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
    }

    await invalidatePromptPublication(queryClient, "template-1");

    for (const queryKey of queries) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
  });

  it("keeps other templates, immutable versions, and binding queries fresh", async () => {
    const queryClient = createQueryClient();
    const queries = [
      {
        label: "another template's first page",
        queryKey: promptQueryKeys.versionList("template-2", 1, 25),
      },
      {
        label: "another template's second page",
        queryKey: promptQueryKeys.versionList("template-2", 2, 25),
      },
      {
        label: "a template with a similar ID",
        queryKey: promptQueryKeys.versionList("template-10", 1, 25),
      },
      { label: "no selected template", queryKey: promptQueryKeys.versionList(null, 1, 25) },
      {
        label: "the published version detail",
        queryKey: promptQueryKeys.version("template-1", "published-1"),
      },
      {
        label: "another template's immutable version",
        queryKey: promptQueryKeys.version("template-2", "published-3"),
      },
      { label: "the template detail", queryKey: promptQueryKeys.template("template-1") },
      { label: "global bindings", queryKey: promptQueryKeys.bindingScope(null) },
      { label: "repository bindings", queryKey: promptQueryKeys.bindingScope("repository-1") },
      {
        label: "global binding history",
        queryKey: promptQueryKeys.bindingHistory(null, "pr_static_build", 1, 25),
      },
      {
        label: "repository binding history",
        queryKey: promptQueryKeys.bindingHistory("repository-1", "pr_static_build", 1, 25),
      },
    ];
    for (const { label, queryKey } of queries) queryClient.setQueryData(queryKey, label);

    await invalidatePromptPublication(queryClient, "template-1");

    for (const { label, queryKey } of queries) {
      const refetch = vi.fn(async () => "Unexpected refresh");

      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
      await expect(queryClient.fetchQuery({ queryKey, queryFn: refetch })).resolves.toBe(label);
      expect(refetch).not.toHaveBeenCalled();
    }
  });
});
